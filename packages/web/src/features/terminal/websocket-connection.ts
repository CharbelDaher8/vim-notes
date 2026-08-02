import type { Unsubscribe } from '@vim-notes/core'

import {
  parseServerFrame,
  reconnectDelayMs,
  resumeUrl,
  sessionMemoryFor,
  TERMINAL_WIRE,
  type ConnectionStatus,
  type SessionMemory,
  type TerminalConnection,
  type TerminalExit,
  type TerminalReset,
} from './terminal-connection'

/**
 * The slice of `WebSocket` this module uses.
 *
 * Declared structurally so a test can supply a socket it drives by hand. What
 * needs driving is not the happy path but the order of things -- a `reset`
 * arriving between two runs of output, a close landing mid-stream -- and a real
 * socket will not order those on request.
 */
export type TerminalSocketEventType = 'open' | 'message' | 'close' | 'error'

/** Only `message` carries a payload; one shape keeps a fake implementable. */
export interface TerminalSocketEvent {
  data?: unknown
}

export interface TerminalSocketLike {
  binaryType: string
  readyState: number
  send(data: string | ArrayBufferView): void
  close(): void
  addEventListener(
    type: TerminalSocketEventType,
    listener: (event: TerminalSocketEvent) => void,
  ): void
}

const OPEN = 1

/**
 * A `TerminalConnection` over a WebSocket, with reconnect.
 *
 * The reconnect is not polish. The server keeps ptys alive across connections
 * precisely so that a phone dropping off wifi mid-edit comes back to the same
 * nvim rather than a fresh one with the buffer lost -- and that guarantee is
 * worth nothing unless the client retries, naming the session and the offset it
 * reached so it is sent only what it missed.
 *
 * Input is dropped rather than queued while the socket is down. Replaying
 * keystrokes into a modal editor after a gap is how you end up with half a
 * command executing against the wrong buffer; a dropped keystroke is visibly
 * dropped, which is the honest failure.
 */
export interface WebSocketConnectionOptions {
  /** Only replaced by tests. See `TerminalSocketLike`. */
  createSocket?: (target: string) => TerminalSocketLike
  /** Where the session id survives a page load. See `sessionMemoryFor`. */
  memory?: SessionMemory
}

export function createWebSocketConnection(
  url: string,
  options: WebSocketConnectionOptions = {},
): TerminalConnection {
  const createSocket =
    options.createSocket ?? ((target) => new WebSocket(target) as unknown as TerminalSocketLike)
  const memory = options.memory ?? sessionMemoryFor(url)
  const byteListeners = new Set<(chunk: Uint8Array) => void>()
  const resetListeners = new Set<(reset: TerminalReset) => void>()
  const exitListeners = new Set<(exit: TerminalExit) => void>()
  const statusListeners = new Set<(status: ConnectionStatus) => void>()

  let socket: TerminalSocketLike | null = null
  let status: ConnectionStatus = 'connecting'
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let lastSize: { cols: number; rows: number } | null = null

  /** What the server needs to hand this client a continuation, not a restart. */
  let sessionId: string | null = memory.read()
  let nextOffset: number | null = null

  /**
   * The `after` this connection attempt actually asked for, captured when the
   * URL was built. Null means "send me everything you have".
   *
   * It is what makes an honest reset notice possible. A reset frame on its own
   * does not say whether output was lost: after a page load the client asks for
   * a full replay on purpose, because its grid is empty, and the reset it gets
   * back costs nothing. Only a reset in answer to a *continuation* means the
   * ring could not reach back far enough and output is genuinely gone.
   */
  let requestedAfter: number | null = null

  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return
    status = next
    for (const listener of [...statusListeners]) listener(next)
  }

  const emitReset = (dropped: number | null) => {
    for (const listener of [...resetListeners]) listener({ dropped })
  }

  const handleFrame = (frame: NonNullable<ReturnType<typeof parseServerFrame>>) => {
    switch (frame.type) {
      case 'ready':
        sessionId = frame.sessionId
        nextOffset = frame.offset
        // Written on every ready, not just the first: a resume that failed
        // comes back with a *different* session, and remembering the dead one
        // would make the next reload chase a pty that no longer exists.
        memory.write(frame.sessionId)

        if (!frame.reset) return

        // Clearing and complaining are separate. The grid always has to be
        // thrown away here; whether anything was lost with it depends on what
        // was asked for. Only a continuation that came back as a reset lost
        // output -- and the ready frame carries no count of how much, so the
        // notice says so rather than inventing a number.
        emitReset(requestedAfter !== null && frame.resumed ? null : 0)
        return

      case 'reset':
        // Mid-stream. The ring evicted what this client needed next, so the
        // bytes after this one do not join onto its grid at all.
        nextOffset = frame.offset
        emitReset(frame.dropped)
        return

      case 'exit': {
        // nvim exited. That is not a dropped connection, so do not retry.
        // Forgotten rather than remembered: a reload should open a new terminal
        // here, not ask the server to resume a session that has ended.
        memory.clear()
        setStatus('exited')
        const exit: TerminalExit = {
          code: frame.code,
          ...(frame.signal === undefined ? {} : { signal: frame.signal }),
        }
        for (const listener of [...exitListeners]) listener(exit)
        return
      }

      case 'error':
        // The server refusing or complaining. It closes the socket itself when
        // the refusal is fatal, and that close is what drives the retry, so
        // there is nothing to do here but not treat it as output.
        return

      case 'pong':
        return
    }
  }

  const connect = () => {
    if (disposed) return

    // Null on the first attempt of a page load even when a session is
    // remembered, which is the whole point: the grid is gone, so ask for the
    // ring rather than for a continuation onto a screen that no longer exists.
    requestedAfter = nextOffset

    const target = resumeUrl(url, {
      session: sessionId,
      after: requestedAfter,
      cols: lastSize?.cols ?? null,
      rows: lastSize?.rows ?? null,
    })

    const active = createSocket(target)
    socket = active
    // Without this a binary frame arrives as a Blob, which is async to read and
    // would reorder output against the control frames interleaved with it.
    active.binaryType = 'arraybuffer'

    active.addEventListener('open', () => {
      attempt = 0
      setStatus('open')
      // The pty has no idea the window was resized while we were away.
      if (lastSize !== null) active.send(TERMINAL_WIRE.resize(lastSize.cols, lastSize.rows))
    })

    active.addEventListener('message', (event) => {
      const data = event.data

      if (typeof data === 'string') {
        const frame = parseServerFrame(data)
        if (frame !== null) handleFrame(frame)
        return
      }

      const bytes = toBytes(data)
      if (bytes === null || bytes.length === 0) return

      if (nextOffset !== null) nextOffset += bytes.length
      for (const listener of [...byteListeners]) listener(bytes)
    })

    active.addEventListener('close', () => {
      if (disposed || status === 'exited') return

      attempt += 1
      setStatus('reconnecting')
      retryTimer = setTimeout(connect, reconnectDelayMs(attempt))
    })

    active.addEventListener('error', () => {
      // `error` is always followed by `close`, which owns the retry.
      active.close()
    })
  }

  connect()

  const subscribe = <T>(set: Set<T>, listener: T): Unsubscribe => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  return {
    get status() {
      return status
    },

    write: (data) => {
      if (socket?.readyState === OPEN) socket.send(TERMINAL_WIRE.input(data))
    },

    resize: (cols, rows) => {
      lastSize = { cols, rows }
      if (socket?.readyState === OPEN) socket.send(TERMINAL_WIRE.resize(cols, rows))
    },

    onBytes: (listener) => subscribe(byteListeners, listener),
    onReset: (listener) => subscribe(resetListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
    onStatus: (listener) => subscribe(statusListeners, listener),

    close: () => {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      setStatus('closed')
      socket?.close()
      socket = null
    },
  }
}

/** `ws` and the browser between them can deliver either of these. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}
