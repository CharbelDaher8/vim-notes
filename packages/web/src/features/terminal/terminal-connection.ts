/**
 * The browser half of a pty session.
 *
 * This used to say that `TERMINAL_WIRE` was "a guess" to be reconciled with the
 * pty endpoint when someone built it. The endpoint was built and the guess was
 * wrong in almost every particular -- it expected output as JSON text frames and
 * sent input the same way, where the server sends and expects raw binary and
 * keeps JSON for control only. Each side was internally consistent and fully
 * tested, so nothing failed; the terminal simply could not have worked. This
 * file now describes the protocol in
 * `packages/server/src/ws/terminal-socket.ts` and nothing else.
 *
 * The three things that shape it:
 *
 *  - Bytes stay bytes. A WebSocket frame already carries a text/binary bit, so
 *    output arrives binary and untouched, and it is handed to xterm as a
 *    `Uint8Array` so that xterm's own decoder holds a UTF-8 sequence split
 *    across two frames. Decoding here would put a second decoder in the path
 *    and a box-drawing character on the seam between two chunks would break.
 *  - Sessions outlive connections. A reconnect names the session it wants and
 *    the byte offset it got to, so a phone that drops off wifi comes back to
 *    the same nvim and only the output it missed.
 *  - `exit` is not the socket closing. A dropped connection offers a reconnect,
 *    a dead nvim does not, and the UI has to tell them apart.
 */
import type { Unsubscribe } from '@vim-notes/core'

export interface TerminalExit {
  code: number
  signal?: number
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'exited'

/**
 * The server could not continue the stream where this client left off, so the
 * grid has to be thrown away rather than appended to.
 *
 * `dropped` is how much output was lost: a number when the server counted it,
 * null when it could not -- a resume the ring could not serve at all knows that
 * something is missing but not how much. Zero means nothing was lost and the
 * clear is bookkeeping, which is the ordinary case of attaching to a session
 * for the first time.
 */
export interface TerminalReset {
  dropped: number | null
}

export interface TerminalConnection {
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Raw pty output. Handed to the emulator undecoded; see the file header. */
  onBytes(listener: (chunk: Uint8Array) => void): Unsubscribe
  /** Clear the grid before applying anything that arrives after this fires. */
  onReset(listener: (reset: TerminalReset) => void): Unsubscribe
  onExit(listener: (exit: TerminalExit) => void): Unsubscribe
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe
  readonly status: ConnectionStatus
  close(): void
}

/**
 * Client -> server frames.
 *
 * Input is binary and everything else is a JSON text frame, which is the
 * server's discriminator: it reads the frame's own text/binary bit rather than
 * a type prefix it would have to parse off every chunk of a paste.
 */
export const TERMINAL_WIRE = {
  input: (data: string): Uint8Array => new TextEncoder().encode(data),
  resize: (cols: number, rows: number): string => JSON.stringify({ type: 'resize', cols, rows }),
  kill: (): string => JSON.stringify({ type: 'kill' }),
} as const

/** Server -> client control frames. Output is binary and is not one of these. */
export type ServerFrame =
  | {
      type: 'ready'
      sessionId: string
      resumed: boolean
      reset: boolean
      offset: number
      cols: number
      rows: number
    }
  | { type: 'reset'; offset: number; dropped: number }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

/**
 * Tolerant on purpose: a frame this client does not understand is ignored
 * rather than thrown, so adding a server-side message type cannot break an
 * older client still open in a tab somewhere. That tolerance is the reason the
 * `reset` frame could be deployed at all -- a client from before it existed
 * drops it on the floor instead of failing.
 *
 * What it deliberately no longer does is treat a non-JSON text frame as raw
 * output. That was a hedge against a server that piped the pty straight
 * through, and against the real server it would render a malformed control
 * frame into the user's terminal as text.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const frame = parsed as Record<string, unknown>

  switch (frame['type']) {
    case 'ready':
      if (typeof frame['sessionId'] !== 'string' || typeof frame['offset'] !== 'number') return null
      return {
        type: 'ready',
        sessionId: frame['sessionId'],
        resumed: frame['resumed'] === true,
        reset: frame['reset'] === true,
        offset: frame['offset'],
        cols: typeof frame['cols'] === 'number' ? frame['cols'] : 0,
        rows: typeof frame['rows'] === 'number' ? frame['rows'] : 0,
      }

    case 'reset':
      if (typeof frame['offset'] !== 'number' || typeof frame['dropped'] !== 'number') return null
      return { type: 'reset', offset: frame['offset'], dropped: frame['dropped'] }

    case 'exit': {
      if (typeof frame['code'] !== 'number') return null
      const signal = frame['signal']
      return {
        type: 'exit',
        code: frame['code'],
        ...(typeof signal === 'number' ? { signal } : {}),
      }
    }

    case 'error':
      if (typeof frame['message'] !== 'string') return null
      return { type: 'error', message: frame['message'] }

    case 'pong':
      return { type: 'pong' }

    default:
      return null
  }
}

export interface ResumeParams {
  session: string | null
  /** Bytes of the stream already applied. Null asks for everything. */
  after: number | null
  cols: number | null
  rows: number | null
}

/**
 * The URL for the next attempt.
 *
 * Carrying `session` and `after` is what makes a reconnect cheap: the server
 * serves only the bytes this client has not seen, and answers `resumed: false`
 * if the session is gone rather than failing the connection and leaving someone
 * who left a tab open overnight looking at an error instead of an editor.
 */
export function resumeUrl(base: string, params: ResumeParams): string {
  const query = new URLSearchParams()

  if (params.session !== null) query.set('session', params.session)
  if (params.after !== null) query.set('after', String(params.after))
  if (params.cols !== null) query.set('cols', String(params.cols))
  if (params.rows !== null) query.set('rows', String(params.rows))

  const search = query.toString()
  return search === '' ? base : `${base}?${search}`
}

/** Backoff for reconnects: quick at first, then out of the way. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 15_000)
}

/**
 * Where the session id survives a page load.
 *
 * Without this the resume machinery works for a dropped socket and not for a
 * refresh, which is the wrong way round for the case that actually happens:
 * `/term` lives in a work PC's tab for days, and browsers reload tabs on their
 * own for memory pressure, updates and restored windows. The user comes back to
 * a fresh shell while their real nvim is still running server-side, now
 * unreachable, until the idle reaper kills it with their buffer inside.
 *
 * Deliberately *only* the id, never the byte offset. A reload destroys the
 * terminal grid, so the useful request is "send me everything you still have"
 * rather than "continue from byte N" -- the latter would paint the tail of a
 * stream onto an empty screen and leave the user looking at a fragment. Not
 * storing the offset also keeps this off the hot path: one write when a session
 * is opened, rather than one per chunk of a redraw.
 */
export interface SessionMemory {
  read(): string | null
  write(sessionId: string): void
  clear(): void
}

/**
 * `sessionStorage`, keyed by endpoint.
 *
 * Per-tab rather than `localStorage`, which matches what a session is: two tabs
 * are two terminals, and closing the tab is the one moment where forgetting is
 * certainly right. Every access is guarded because storage is not always
 * available -- Safari's private mode throws on write, and enterprise policy can
 * disable it outright. A terminal that refuses to open because it could not
 * remember a session id would be a far worse trade than one that forgets.
 */
export function sessionMemoryFor(url: string, storage?: Storage | null): SessionMemory {
  const key = `vim-notes:terminal-session:${url}`
  const store = storage === undefined ? safeStorage() : storage

  if (store === null) return { read: () => null, write: () => {}, clear: () => {} }

  return {
    read: () => attempt(() => store.getItem(key)) ?? null,
    write: (sessionId) => {
      attempt(() => store.setItem(key, sessionId))
    },
    clear: () => {
      attempt(() => store.removeItem(key))
    },
  }
}

function safeStorage(): Storage | null {
  return attempt(() => globalThis.sessionStorage) ?? null
}

function attempt<T>(run: () => T): T | null {
  try {
    return run()
  } catch {
    return null
  }
}
