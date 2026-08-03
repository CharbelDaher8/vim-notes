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
import type {
  ConnectionStatus,
  TerminalConnection,
  TerminalExit,
  TerminalReset,
} from './terminal-connection'
import { bindTerminal, describeResync } from './terminal-sink'

import '@xterm/xterm/css/xterm.css'
import './terminal.css'

export function TerminalPane({ connect }: { connect: () => TerminalConnection }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [exit, setExit] = useState<TerminalExit | null>(null)
  const [resync, setResync] = useState<TerminalReset | null>(null)

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
      fontFamily: terminalFontStack(),
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

    // The screen was thrown away and rebuilt, which from the user's side is
    // indistinguishable from an ordinary redraw -- so it gets said. Timed out
    // rather than sticky: it describes something that already finished, and a
    // permanent banner over a working terminal would be worse than the loss.
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    const unbind = bindTerminal(connection, terminal, {
      onStatus: setStatus,
      onExit: setExit,
      onResync: (next) => {
        setResync(next)
        clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => setResync(null), RESYNC_NOTICE_MS)
      },
    })

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
      clearTimeout(noticeTimer)
      unbind()
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

  const notice = describe(status, exit, resync)

  return (
    <section className="terminal" aria-label="Terminal">
      <div className="terminal__surface" ref={hostRef} />

      {notice === null ? null : (
        <p className="terminal__status" role="status" data-state={notice.state}>
          {notice.text}
        </p>
      )}
    </section>
  )
}

/** How long a resync notice stays up. Long enough to read, short enough to go. */
const RESYNC_NOTICE_MS = 8_000

interface StatusNotice {
  state: 'exited' | 'resynced' | ConnectionStatus
  text: string
}

function describe(
  status: ConnectionStatus,
  exit: TerminalExit | null,
  resync: TerminalReset | null,
): StatusNotice | null {
  if (exit !== null) {
    return {
      state: 'exited',
      text:
        exit.signal === undefined
          ? `Session ended (exit ${exit.code}). Reload to start a new one.`
          : `Session killed by signal ${exit.signal}. Reload to start a new one.`,
    }
  }

  switch (status) {
    case 'connecting':
      return { state: status, text: 'Connecting…' }
    case 'reconnecting':
      return {
        state: status,
        text: 'Connection lost. Reconnecting — your session is still running.',
      }
    case 'closed':
      return { state: status, text: 'Disconnected.' }
  }

  // Connected and healthy, so the only thing left worth saying is that some
  // output went missing. Reported last because a live connection problem is
  // more urgent than one that has already resolved itself.
  if (resync !== null) return { state: 'resynced', text: describeResync(resync) }

  return null
}

function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * The app's mono stack, with the icon font behind it.
 *
 * Order is the whole thing. `--font-mono` stays first, so xterm measures its
 * cell from the font that draws the text -- the grid must not depend on whether
 * an icon font has arrived. 'Nerd Symbols' then catches the private-use
 * codepoints an ordinary mono font has no glyph for, which is every icon a
 * Nerd Font config draws.
 *
 * Appended *inside* the stack rather than after it. `--font-mono` ends in the
 * generic `monospace`, and while per-character fallback does keep walking past
 * a family that lacks the glyph, that is a subtle rule to rest a feature on --
 * the browser resolves the generic to a real font, and what a resolved generic
 * reports for an unmapped codepoint is not something worth being clever about.
 * Putting the icon font ahead of it makes the question not arise.
 */
function terminalFontStack(): string {
  const mono = readVar('--font-mono', 'monospace')
  const icons = "'Nerd Symbols'"

  const generic = mono.lastIndexOf('monospace')
  if (generic === -1) return `${mono}, ${icons}`

  return `${mono.slice(0, generic)}${icons}, ${mono.slice(generic)}`
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
