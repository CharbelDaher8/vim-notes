import type { Unsubscribe } from './common'

export interface TerminalSpawnOptions {
  cols: number
  rows: number
  /** Absolute path; the adapter is responsible for confining this. */
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface TerminalExit {
  code: number
  signal?: number
}

export interface TerminalSession {
  readonly id: string
  /** Bytes from the browser's keyboard into the pty. */
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: (chunk: string) => void): Unsubscribe
  onExit(listener: (exit: TerminalExit) => void): Unsubscribe
  kill(signal?: string): void
}

/**
 * Owns pty lifecycles. Sessions outlive individual WebSocket connections on
 * purpose -- a phone that drops off wifi mid-edit should reconnect to the same
 * nvim, not a fresh one with an unsaved buffer lost.
 */
export interface TerminalHost {
  spawn(options: TerminalSpawnOptions): Promise<TerminalSession>
  get(id: string): TerminalSession | null
  killAll(): Promise<void>
}
