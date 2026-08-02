/**
 * xterm.js, mounted.
 *
 * This module is the *only* thing that imports xterm, and it is reachable only
 * through a dynamic `import()` in `app/terminal-route.tsx`. That is what keeps
 * a terminal emulator out of the bundle a phone downloads -- DECISIONS.md §3
 * and §4 are explicit that the phone gets CodeMirror and never a terminal, so
 * shipping xterm to it is pure waste. If anything ever imports this statically,
 * the chunk collapses back into the main one; the size check in the report is
 * how you would notice.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { useResolvedTheme } from '../../shared/theme'
import type { ConnectionStatus, TerminalConnection, TerminalExit } from './terminal-connection'

import '@xterm/xterm/css/xterm.css'
import './terminal.css'

export function TerminalPane({ connect }: { connect: () => TerminalConnection }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [exit, setExit] = useState<TerminalExit | null>(null)

  const theme = useResolvedTheme()
  const connectRef = useRef(connect)
  connectRef.current = connect

  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: readVar('--font-mono', 'monospace'),
      fontSize: 14,
      lineHeight: 1.2,
      // nvim redraws the whole screen constantly; a large scrollback is mostly
      // memory spent on frames nobody will scroll back to.
      scrollback: 2_000,
      theme: xtermTheme(),
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()

    terminalRef.current = terminal

    const connection = connectRef.current()
    const unsubscribes = [
      connection.onData((chunk) => terminal.write(chunk)),
      connection.onStatus(setStatus),
      connection.onExit(setExit),
    ]

    const inputSubscription = terminal.onData((data) => connection.write(data))
    connection.resize(terminal.cols, terminal.rows)

    // The virtual keyboard, a rotated phone and a dragged splitter all resize
    // this, and a pty that does not hear about it renders at the wrong width.
    const observer = new ResizeObserver(() => {
      fit.fit()
      connection.resize(terminal.cols, terminal.rows)
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      inputSubscription.dispose()
      for (const unsubscribe of unsubscribes) unsubscribe()
      connection.close()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])

  useEffect(() => {
    // xterm cannot read CSS custom properties, so the theme is pushed in.
    const terminal = terminalRef.current
    if (terminal === null) return
    terminal.options.theme = xtermTheme()
  }, [theme])

  return (
    <section className="terminal" aria-label="Terminal">
      <div className="terminal__surface" ref={hostRef} />

      {status === 'open' && exit === null ? null : (
        <p
          className="terminal__status"
          role="status"
          data-state={exit === null ? status : 'exited'}
        >
          {describe(status, exit)}
        </p>
      )}
    </section>
  )
}

function describe(status: ConnectionStatus, exit: TerminalExit | null): string {
  if (exit !== null) {
    return exit.signal === undefined
      ? `Session ended (exit ${exit.code}). Reload to start a new one.`
      : `Session killed by signal ${exit.signal}. Reload to start a new one.`
  }

  switch (status) {
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
      return 'Connection lost. Reconnecting — your session is still running.'
    case 'closed':
      return 'Disconnected.'
    default:
      return ''
  }
}

function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** Built from the same tokens as the rest of the app, so the two match. */
function xtermTheme() {
  return {
    background: readVar('--surface', '#16171a'),
    foreground: readVar('--text', '#e7e3db'),
    cursor: readVar('--accent', '#5fc0a9'),
    cursorAccent: readVar('--surface', '#16171a'),
    selectionBackground: readVar('--accent-soft', '#17322e'),
  }
}
