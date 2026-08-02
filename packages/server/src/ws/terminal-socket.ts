/**
 * The WebSocket side of the terminal: binds one connection to one pty session.
 *
 * The important thing this file does *not* do is own the session. A socket that
 * closes detaches and nothing else -- the pty keeps running, its output keeps
 * accumulating in the session's ring, and the next connection picks it back up.
 * That is the whole reason the `/term` client is usable from a phone
 * (DECISIONS.md §3): wifi drops are not a reason to lose an unsaved buffer.
 *
 * ## Frame protocol
 *
 * A WebSocket frame already carries a text/binary bit, so that bit is the
 * discriminator. It costs zero bytes on the wire, needs no parsing on the hot
 * path, and maps onto what both ends naturally have -- xterm.js `onData` gives a
 * string, `WebSocket.send` takes an ArrayBuffer, and `ws` hands the server a
 * Buffer either way.
 *
 *   binary frame  ->  pty bytes, verbatim, in both directions
 *   text frame    ->  exactly one JSON control object, `{ "type": ... }`
 *
 * The alternative was a one-byte type prefix on every frame. It was rejected
 * because it puts a slice and a branch on every chunk of terminal output to
 * re-derive a bit the transport was already telling us, and because base64 or
 * JSON-escaping the data path -- the version of that idea people actually reach
 * for -- inflates a full-screen nvim redraw by a third for nothing.
 *
 * Control frames, client to server:
 *
 *   { "type": "resize", "cols": 120, "rows": 40 }
 *   { "type": "ping" }
 *   { "type": "kill" }
 *
 * Control frames, server to client:
 *
 *   { "type": "ready",  "sessionId": "...", "resumed": true, "reset": false,
 *     "offset": 91234, "cols": 120, "rows": 40 }
 *   { "type": "exit",   "code": 0, "signal": 15 }
 *   { "type": "error",  "message": "..." }
 *   { "type": "pong" }
 *
 * `ready` always arrives first, before any output. `offset` is the position in
 * the session's output stream that the very next binary frame starts at, so the
 * client's whole bookkeeping is: take `ready.offset`, add the length of every
 * binary frame it receives, and hand the total back as `?after=` on reconnect.
 * It is the start rather than the end of the replay on purpose -- a client
 * cannot tell a replayed frame from a live one, and an end offset would leave it
 * unable to say whether the next chunk had already been counted.
 *
 * `reset: true` means the bytes that follow are not a continuation of anything
 * the client already has, so it must clear its terminal before applying them.
 *
 * ## Connecting
 *
 *   GET /term/ws?cols=120&rows=40                    -- new session
 *   GET /term/ws?session=<id>&after=<n>&cols=&rows=  -- resume
 *
 * A resume whose session is gone -- reaped, or nvim was quit -- silently becomes
 * a new one, and `ready.resumed` is false so the client can tell. Failing the
 * connection instead would mean a user who left a tab open overnight gets an
 * error page rather than an editor.
 *
 * Session ids are unguessable but are not an authorisation mechanism: anyone who
 * can reach this endpoint can already open their own terminal, so there is
 * nothing for id-guessing to escalate to. Access control is the tailnet
 * (DECISIONS.md §11).
 */
import { spawnTerminalInput } from '@vim-notes/core'
import websocketPlugin from '@fastify/websocket'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { PtySession } from '../adapters/node-pty-terminal-host'

/** Application close codes; 4000-4999 is the range reserved for these. */
export const TERMINAL_CLOSE_EXITED = 4000
export const TERMINAL_CLOSE_UNAVAILABLE = 4001
export const TERMINAL_CLOSE_PROTOCOL = 4002

const DEFAULT_PATH = '/term/ws'

/**
 * Resize debounce, on the same idle-plus-ceiling shape as AutoCommitter and for
 * the same reason: dragging a window emits a resize per animation frame, each of
 * which is a SIGWINCH and a full nvim repaint, and a plain idle debounce would
 * leave the terminal at the wrong size for as long as someone keeps dragging.
 */
const DEFAULT_RESIZE_IDLE_MS = 40
const DEFAULT_RESIZE_MAX_DELAY_MS = 250

/**
 * A paste is the only legitimately large thing a client sends, and a big one is
 * still well under this. Anything larger is a bug or an attempt to make the
 * server allocate on demand.
 */
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024

/**
 * Flow control thresholds. A pty can produce output far faster than a phone on
 * a bad connection can absorb it -- `yes`, or a `:!find /` -- and `ws` will
 * happily queue every unsent byte in memory. Past the high-water mark the pty is
 * paused, which applies real back pressure to the child through the tty buffer,
 * and it resumes once the socket has drained back under the low mark.
 */
const DEFAULT_SEND_HIGH_WATER_MARK = 2 * 1024 * 1024
const DEFAULT_SEND_LOW_WATER_MARK = 256 * 1024
const DEFAULT_DRAIN_POLL_MS = 25

/**
 * Heartbeat interval. A connection that dies without a close frame -- which is
 * precisely what a phone leaving wifi does -- emits no `close` event until TCP
 * gives up, and that can be minutes. In the meantime the corpse still holds an
 * attachment, which keeps the session out of the reaper's reach, and still holds
 * whatever flow-control pause it took, which means the user's *next* connection
 * reattaches to an nvim that has been stopped by a socket nobody is on the other
 * end of. Two missed rounds and the socket is torn down.
 *
 * Browsers answer a protocol-level ping in the WebSocket implementation itself,
 * so this needs nothing from the client.
 */
const DEFAULT_HEARTBEAT_MS = 30_000

/**
 * The slice of `ws`'s WebSocket this module actually uses.
 *
 * Declared structurally rather than imported because `ws` ships no typings of
 * its own and `@types/ws` is not a dependency here -- but mostly because a
 * handful of methods is something a test can implement in a few dozen lines,
 * which is what lets the reconnect, heartbeat and back-pressure behaviour be
 * tested without standing up an HTTP server for each one.
 */
export interface TerminalWebSocket {
  readonly bufferedAmount: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  /** Protocol-level ping, for the heartbeat. Answered by the browser itself. */
  ping(): void
  /** Drop the connection without waiting for a close handshake it will not finish. */
  terminate(): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'pong', listener: () => void): unknown
}

/** What this module needs of a TerminalHost. Narrowed so tests can fake it. */
export interface PtySessionHost {
  spawn(options: { cols: number; rows: number }): Promise<PtySession>
  get(id: string): PtySession | null
}

export type ServerControlFrame =
  | {
      type: 'ready'
      sessionId: string
      resumed: boolean
      reset: boolean
      offset: number
      cols: number
      rows: number
    }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

// Dimension bounds come from core's spawn schema rather than being restated, so
// a resize can never ask for something a spawn would have refused.
const resizeFrame = spawnTerminalInput.extend({ type: z.literal('resize') })

const clientControlFrame = z.discriminatedUnion('type', [
  resizeFrame,
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('kill') }),
])

export const terminalConnectQuery = z.object({
  session: z.string().min(1).max(128).optional(),
  after: z.coerce.number().int().min(0).optional(),
  cols: z.coerce.number().int().min(1).max(1000).optional(),
  rows: z.coerce.number().int().min(1).max(1000).optional(),
})

export type TerminalConnectQuery = z.infer<typeof terminalConnectQuery>

export interface AttachTerminalOptions {
  /** Byte offset the client has already consumed. Null replays everything. */
  after?: number | null
  cols?: number
  rows?: number
  /** Reported in the `ready` frame; false means the client got a new pty. */
  resumed?: boolean
  resizeIdleMs?: number
  resizeMaxDelayMs?: number
  maxMessageBytes?: number
  sendHighWaterMark?: number
  sendLowWaterMark?: number
  drainPollMs?: number
  /** Zero or less disables the heartbeat. */
  heartbeatMs?: number
  /** Transport failures have no request to fail; without a sink they vanish. */
  onError?: (error: unknown) => void
}

/**
 * Wire a live socket to a session. Returns a function that tears the binding
 * down without touching the pty -- the same thing the socket's own close event
 * does, exposed for a server shutting down deliberately.
 */
export function attachTerminalSocket(
  socket: TerminalWebSocket,
  session: PtySession,
  options: AttachTerminalOptions = {},
): () => void {
  const onError = options.onError ?? (() => {})
  const resizeIdleMs = options.resizeIdleMs ?? DEFAULT_RESIZE_IDLE_MS
  const resizeMaxDelayMs = options.resizeMaxDelayMs ?? DEFAULT_RESIZE_MAX_DELAY_MS
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const highWaterMark = options.sendHighWaterMark ?? DEFAULT_SEND_HIGH_WATER_MARK
  const lowWaterMark = options.sendLowWaterMark ?? DEFAULT_SEND_LOW_WATER_MARK
  const drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

  const teardown: Array<() => void> = []
  let closed = false

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let answeredLastPing = true

  let pendingSize: { cols: number; rows: number } | null = null
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let resizeWindowStartedAt = 0

  let drainTimer: ReturnType<typeof setInterval> | null = null
  let paused = false

  function send(data: string | Uint8Array): void {
    if (closed) return
    try {
      socket.send(data)
    } catch (error) {
      // A socket that has already gone away. Nothing to recover here, but this
      // has to go through the full teardown rather than just setting `closed`:
      // the attachment is what the reaper looks at, and a session left holding a
      // phantom one is a pty that never gets collected.
      onError(error)
      detach()
    }
  }

  function sendControl(frame: ServerControlFrame): void {
    send(JSON.stringify(frame))
  }

  function sendBytes(chunk: Buffer): void {
    send(chunk)
    applyBackPressure()
  }

  function applyBackPressure(): void {
    if (paused || closed || socket.bufferedAmount <= highWaterMark) return

    paused = true
    session.pause()

    // `ws` has no drain event, so the socket is polled while congested. The
    // timer only exists during congestion, which on any sane connection is
    // never.
    drainTimer = setInterval(() => {
      if (closed || socket.bufferedAmount <= lowWaterMark) releaseBackPressure()
    }, drainPollMs)
    drainTimer.unref()
  }

  function releaseBackPressure(): void {
    if (drainTimer !== null) {
      clearInterval(drainTimer)
      drainTimer = null
    }
    if (!paused) return
    paused = false
    session.resume()
  }

  function requestResize(cols: number, rows: number): void {
    pendingSize = { cols, rows }

    const now = Date.now()
    if (resizeTimer === null) resizeWindowStartedAt = now
    else clearTimeout(resizeTimer)

    const remainingBudget = resizeMaxDelayMs - (now - resizeWindowStartedAt)
    const delay = Math.max(0, Math.min(resizeIdleMs, remainingBudget))

    resizeTimer = setTimeout(flushResize, delay)
  }

  function flushResize(): void {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    if (pendingSize === null) return

    const { cols, rows } = pendingSize
    pendingSize = null
    session.resize(cols, rows)
  }

  function handleControl(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      sendControl({ type: 'error', message: 'control frame is not JSON' })
      return
    }

    const frame = clientControlFrame.safeParse(parsed)
    if (!frame.success) {
      // Reported but survivable. A malformed control frame is a client bug, and
      // killing someone's nvim over one would be a wildly disproportionate
      // response to a mistyped resize.
      sendControl({ type: 'error', message: 'unrecognised control frame' })
      return
    }

    switch (frame.data.type) {
      case 'resize':
        requestResize(frame.data.cols, frame.data.rows)
        return
      case 'ping':
        // Browsers cannot send a protocol-level ping frame, so clients that want
        // to know the connection is alive through a proxy need this one.
        sendControl({ type: 'pong' })
        return
      case 'kill':
        // The client asking to end the session for real, as opposed to just
        // closing the tab. Equivalent to typing `:q`, which it could do anyway.
        session.kill()
        return
    }
  }

  function handleMessage(data: unknown, isBinary: boolean): void {
    const buffer = toBuffer(data)
    if (buffer === null) return

    if (buffer.length > maxMessageBytes) {
      sendControl({ type: 'error', message: 'message too large' })
      close(TERMINAL_CLOSE_PROTOCOL, 'message too large')
      return
    }

    if (isBinary) {
      // Keystrokes go through untouched. A paste of emoji arriving split across
      // two frames still reaches the pty as the same bytes it left the browser
      // as, which decoding to a string here would not guarantee.
      session.writeBytes(buffer)
      return
    }

    handleControl(buffer.toString('utf8'))
  }

  function close(code: number, reason: string): void {
    detach()
    try {
      socket.close(code, reason)
    } catch (error) {
      onError(error)
    }
  }

  function startHeartbeat(): void {
    if (heartbeatMs <= 0) return

    heartbeatTimer = setInterval(() => {
      if (!answeredLastPing) {
        // Two rounds with no answer. `terminate` rather than `close`, because a
        // close handshake needs a peer that is still there to complete it.
        try {
          socket.terminate()
        } catch (error) {
          onError(error)
        }
        detach()
        return
      }

      answeredLastPing = false
      try {
        socket.ping()
      } catch (error) {
        onError(error)
      }
    }, heartbeatMs)

    heartbeatTimer.unref()
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer === null) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  function detach(): void {
    if (closed) return
    closed = true

    stopHeartbeat()

    // The client's last word on its own dimensions, applied even though it is
    // leaving: it is the size the pty should be in if the same client comes
    // straight back, and dropping it would put the reconnect one repaint behind.
    flushResize()
    releaseBackPressure()

    for (const undo of teardown.reverse()) {
      try {
        undo()
      } catch (error) {
        onError(error)
      }
    }
    teardown.length = 0
  }

  teardown.push(session.attach())

  socket.on('close', detach)
  socket.on('error', (error) => {
    onError(error)
    detach()
  })
  socket.on('message', handleMessage)
  socket.on('pong', () => {
    answeredLastPing = true
  })
  startHeartbeat()

  // Size first, so the `ready` frame describes the pty the client is about to
  // see rather than the one it is replacing.
  const wantsCols = options.cols ?? session.cols
  const wantsRows = options.rows ?? session.rows
  const sizeChanged = wantsCols !== session.cols || wantsRows !== session.rows
  if (sizeChanged) session.resize(wantsCols, wantsRows)

  // Everything from here to the `onBytes` subscription below is synchronous, and
  // pty output can only arrive on a later turn of the event loop -- so there is
  // no window between snapshotting the ring and subscribing to the live stream
  // in which a chunk could be dropped or delivered twice.
  const replay = session.scrollbackSince(options.after ?? null)

  sendControl({
    type: 'ready',
    sessionId: session.id,
    resumed: options.resumed ?? false,
    reset: replay.reset,
    offset: replay.offset,
    cols: session.cols,
    rows: session.rows,
  })

  if (replay.bytes.length > 0) sendBytes(replay.bytes)

  // A socket that failed on the very first write has already been torn down, and
  // subscribing now would register listeners nothing will ever remove.
  if (closed) return detach

  teardown.push(session.onBytes(sendBytes))
  teardown.push(
    session.onExit((exit) => {
      sendControl({ type: 'exit', code: exit.code, signal: exit.signal })
      close(TERMINAL_CLOSE_EXITED, 'terminal exited')
    }),
  )

  // A replay that had to start mid-history leaves the client's grid rebuilt from
  // a stream missing its own beginning -- possibly without the escape that
  // entered the alternate screen, or the one that set the current colours.
  // Bytes get it approximately right; only the application redrawing gets it
  // actually right. A resize already provoked that repaint, so only nudge when
  // one did not happen.
  if (replay.reset && replay.bytes.length > 0 && !sizeChanged) session.nudgeRedraw()

  return detach
}

export interface OpenedTerminal {
  session: PtySession
  resumed: boolean
  after: number | null
}

/**
 * Resume the requested session, or start a new one.
 *
 * The `after` offset is dropped when a resume fails, because the client counted
 * those bytes against a pty that no longer exists and applying them to a fresh
 * one would replay a stranger's screen.
 */
export async function openTerminalSession(
  host: PtySessionHost,
  query: TerminalConnectQuery,
): Promise<OpenedTerminal> {
  const cols = query.cols ?? 80
  const rows = query.rows ?? 24

  if (query.session !== undefined) {
    const existing = host.get(query.session)
    if (existing !== null && existing.exit === null) {
      return { session: existing, resumed: true, after: query.after ?? null }
    }
  }

  return { session: await host.spawn({ cols, rows }), resumed: false, after: null }
}

export interface TerminalSocketPluginOptions extends Omit<
  AttachTerminalOptions,
  'after' | 'cols' | 'rows' | 'resumed'
> {
  host: PtySessionHost
  /** Defaults to `/term/ws`. */
  path?: string
}

/**
 * Mount the terminal endpoint on Fastify.
 *
 * Registers `@fastify/websocket` if the application has not already, so this
 * plugin works on its own; `fastify-plugin` makes the second registration a
 * no-op either way.
 */
export function terminalSocketPlugin(options: TerminalSocketPluginOptions): FastifyPluginAsync {
  const { host, path = DEFAULT_PATH, ...attachOptions } = options
  const onError = attachOptions.onError ?? (() => {})

  return async (fastify: FastifyInstance) => {
    if (!fastify.hasPlugin('@fastify/websocket')) {
      await fastify.register(websocketPlugin)
    }

    fastify.get(path, { websocket: true }, (socket: TerminalWebSocket, request: FastifyRequest) => {
      void connect(socket, request, host, attachOptions, onError)
    })
  }
}

async function connect(
  socket: TerminalWebSocket,
  request: FastifyRequest,
  host: PtySessionHost,
  attachOptions: Omit<AttachTerminalOptions, 'after' | 'cols' | 'rows' | 'resumed'>,
  onError: (error: unknown) => void,
): Promise<void> {
  const query = terminalConnectQuery.safeParse(request.query)
  if (!query.success) {
    refuse(socket, 'invalid terminal connection parameters', onError)
    return
  }

  let opened: OpenedTerminal
  try {
    opened = await openTerminalSession(host, query.data)
  } catch (error) {
    // Out of session slots, or nvim is not installed. Both are worth saying out
    // loud: the client can render the message, and a blank terminal with no
    // explanation is the worst possible version of either.
    onError(error)
    refuse(socket, error instanceof Error ? error.message : 'could not start a terminal', onError)
    return
  }

  attachTerminalSocket(socket, opened.session, {
    ...attachOptions,
    after: opened.after,
    cols: query.data.cols,
    rows: query.data.rows,
    resumed: opened.resumed,
    onError,
  })
}

function refuse(
  socket: TerminalWebSocket,
  message: string,
  onError: (error: unknown) => void,
): void {
  try {
    const frame: ServerControlFrame = { type: 'error', message }
    socket.send(JSON.stringify(frame))
    socket.close(TERMINAL_CLOSE_UNAVAILABLE, 'terminal unavailable')
  } catch (error) {
    onError(error)
  }
}

/**
 * `ws` delivers a message as a Buffer, an ArrayBuffer, or -- when the socket was
 * created without `isBinary` coalescing -- an array of Buffers for a fragmented
 * frame. All three have to be handled or a large paste arrives as `[object
 * Object]`.
 */
function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data.filter((part) => Buffer.isBuffer(part)))
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return null
}
