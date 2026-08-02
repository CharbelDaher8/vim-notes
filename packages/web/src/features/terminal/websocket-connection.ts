import type { Unsubscribe } from '@vim-notes/core'

import {
  parseServerFrame,
  reconnectDelayMs,
  TERMINAL_WIRE,
  type ConnectionStatus,
  type TerminalConnection,
  type TerminalExit,
} from './terminal-connection'

/**
 * A `TerminalConnection` over a WebSocket, with reconnect.
 *
 * The reconnect is not polish. Core's `TerminalHost` keeps ptys alive across
 * connections precisely so that a phone dropping off wifi mid-edit comes back
 * to the same nvim rather than a fresh one with the buffer lost -- and that
 * guarantee is worth nothing unless the client actually retries.
 *
 * Input is dropped rather than queued while the socket is down. Replaying
 * keystrokes into a modal editor after a gap is how you end up with half a
 * command executing against the wrong buffer; a dropped keystroke is visibly
 * dropped, which is the honest failure.
 */
export function createWebSocketConnection(url: string): TerminalConnection {
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(exit: TerminalExit) => void>()
  const statusListeners = new Set<(status: ConnectionStatus) => void>()

  let socket: WebSocket | null = null
  let status: ConnectionStatus = 'connecting'
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let lastSize: { cols: number; rows: number } | null = null

  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return
    status = next
    for (const listener of [...statusListeners]) listener(next)
  }

  const connect = () => {
    if (disposed) return

    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      attempt = 0
      setStatus('open')
      // The pty has no idea the window was resized while we were away.
      if (lastSize !== null) socket?.send(TERMINAL_WIRE.resize(lastSize.cols, lastSize.rows))
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const frame = parseServerFrame(String(event.data))
      if (frame === null) return

      if (frame.type === 'output') {
        for (const listener of [...dataListeners]) listener(frame.data)
        return
      }

      // nvim exited. That is not a dropped connection, so do not retry.
      setStatus('exited')
      const exit: TerminalExit = {
        code: frame.code,
        ...(frame.signal === undefined ? {} : { signal: frame.signal }),
      }
      for (const listener of [...exitListeners]) listener(exit)
    })

    socket.addEventListener('close', () => {
      if (disposed || status === 'exited') return

      attempt += 1
      setStatus('reconnecting')
      retryTimer = setTimeout(connect, reconnectDelayMs(attempt))
    })

    socket.addEventListener('error', () => {
      // `error` is always followed by `close`, which owns the retry.
      socket?.close()
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
      if (socket?.readyState === WebSocket.OPEN) socket.send(TERMINAL_WIRE.input(data))
    },

    resize: (cols, rows) => {
      lastSize = { cols, rows }
      if (socket?.readyState === WebSocket.OPEN) socket.send(TERMINAL_WIRE.resize(cols, rows))
    },

    onData: (listener) => subscribe(dataListeners, listener),
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
