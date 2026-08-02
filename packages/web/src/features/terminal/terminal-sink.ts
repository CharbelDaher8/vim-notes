/**
 * Everything the terminal pane decides, minus the emulator.
 *
 * This exists as its own module for one reason: the interesting behaviour is
 * what the *screen* ends up showing when a reset arrives mid-stream, and that
 * cannot be asserted from inside the React component. This package has no jsdom
 * -- its vitest environment is `node` and deliberately so, since everything else
 * under test here is DOM-free -- so mounting xterm in a test is not available.
 * Pulling the policy out to something that talks to a two-method interface
 * makes the end state checkable against a fake emulator, and leaves the pane
 * with only the parts that genuinely need a browser: mounting, fitting, theming.
 *
 * The ordering it exists to protect: a reset says the bytes after it do not
 * join onto the current grid. Clearing has to happen before they are written,
 * and both arrive through the same connection, so this subscribes to reset and
 * to output and relies on the connection delivering them in the order the
 * server sent them.
 */
import type { Unsubscribe } from '@vim-notes/core'

import type {
  ConnectionStatus,
  TerminalConnection,
  TerminalExit,
  TerminalReset,
} from './terminal-connection'

/**
 * The slice of xterm's `Terminal` this needs.
 *
 * `reset` rather than `clear` is the deliberate choice, and they are not
 * interchangeable. `clear` empties the viewport and scrollback but leaves every
 * mode as it was -- alternate screen, scroll region, current SGR colours,
 * charset, cursor keys mode. Those modes were set by escape sequences in the
 * part of the stream this client *did* see, and what follows a reset starts
 * somewhere it did not, so any of them may be wrong in a way nothing later will
 * correct. `reset` puts the emulator back to a state both ends can name, which
 * is the only honest starting point for a stream resumed from the middle. The
 * cost is the scrollback, which was built from a stream with a hole in it and
 * was not worth keeping.
 */
export interface TerminalLike {
  write(data: Uint8Array): void
  reset(): void
}

export interface TerminalSinkEvents {
  onStatus(status: ConnectionStatus): void
  onExit(exit: TerminalExit): void
  /**
   * A resync happened. Null means the notice has outlived its welcome and
   * should come down; the sink never sends that itself, because how long a
   * message stays up is the pane's business.
   */
  onResync(resync: TerminalReset): void
}

/**
 * Wire a connection to an emulator. Returns the unsubscribe.
 *
 * Only resets that actually cost the user something are reported. Attaching to
 * a fresh session clears too, and telling someone "output was dropped" when
 * they have just opened a terminal would be noise that teaches them to ignore
 * the message that matters.
 */
export function bindTerminal(
  connection: TerminalConnection,
  terminal: TerminalLike,
  events: TerminalSinkEvents,
): Unsubscribe {
  const unsubscribes = [
    connection.onReset((reset) => {
      terminal.reset()
      if (reset.dropped === null || reset.dropped > 0) events.onResync(reset)
    }),
    connection.onBytes((chunk) => terminal.write(chunk)),
    connection.onStatus((status) => events.onStatus(status)),
    connection.onExit((exit) => events.onExit(exit)),
  ]

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}

/** What the status line says about a resync. Kept here so it can be tested. */
export function describeResync(resync: TerminalReset): string {
  if (resync.dropped === null) {
    return 'Some output was dropped while reconnecting. The terminal has been redrawn.'
  }
  return `${resync.dropped.toLocaleString()} bytes of output were dropped. The terminal has been redrawn.`
}
