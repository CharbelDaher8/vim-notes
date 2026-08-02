/**
 * The browser half of a pty session.
 *
 * Deliberately mirrors `TerminalSession` in core rather than inventing a client
 * vocabulary -- same reasoning as the `Platform` port: a rename is just a place
 * the two sides can drift.
 *
 * NOTE FOR WHOEVER BUILDS THE PTY ENDPOINT (task #9): `TERMINAL_WIRE` below is
 * the protocol this client assumes, and it is a guess in exactly the way
 * `NotesApiClient` is. It is declared in one place so reconciling it is a
 * single edit. Two things in core's `TerminalHost` shaped it:
 *
 *  - sessions outlive connections and are keyed by `id`, so the client attaches
 *    to a session rather than creating one per socket, and a reconnect must be
 *    able to name the session it wants;
 *  - `onExit` is distinct from the socket closing. A dropped phone connection
 *    is not nvim exiting, and the UI has to tell those apart -- one offers
 *    "reconnect", the other does not.
 */
import type { Unsubscribe } from '@vim-notes/core'

export interface TerminalExit {
  code: number
  signal?: number
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'exited'

export interface TerminalConnection {
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: (chunk: string) => void): Unsubscribe
  onExit(listener: (exit: TerminalExit) => void): Unsubscribe
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe
  readonly status: ConnectionStatus
  close(): void
}

/** Client -> server frames. JSON text frames; output comes back raw. */
export const TERMINAL_WIRE = {
  input: (data: string) => JSON.stringify({ type: 'input', data }),
  resize: (cols: number, rows: number) => JSON.stringify({ type: 'resize', cols, rows }),
} as const

export type ServerFrame =
  { type: 'output'; data: string } | { type: 'exit'; code: number; signal?: number }

/**
 * Tolerant on purpose: a frame this client does not understand is ignored
 * rather than thrown, so adding a server-side message type later cannot break
 * an older client that is still open in a tab somewhere.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON, so treat the frame as raw pty output. Keeps the protocol
    // usable with a server that just pipes the pty straight through.
    return { type: 'output', data: raw }
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const frame = parsed as Record<string, unknown>

  if (frame['type'] === 'output' && typeof frame['data'] === 'string') {
    return { type: 'output', data: frame['data'] }
  }

  if (frame['type'] === 'exit' && typeof frame['code'] === 'number') {
    const signal = frame['signal']
    return {
      type: 'exit',
      code: frame['code'],
      ...(typeof signal === 'number' ? { signal } : {}),
    }
  }

  return null
}

/** Backoff for reconnects: quick at first, then out of the way. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 15_000)
}
