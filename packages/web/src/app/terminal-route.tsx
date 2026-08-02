import { lazy, Suspense, useCallback } from 'react'

import { createWebSocketConnection } from '../features/terminal/websocket-connection'
import { currentServerOrigin, socketUrl } from '../platform'

/**
 * The lazy boundary that keeps xterm.js off the phone.
 *
 * `TerminalPane` is the only module that imports xterm, and this is the only
 * reference to it. Anything that imports it eagerly -- a stray `import type`
 * written without `type`, a re-export from a barrel -- silently folds it back
 * into the main chunk, which is the sort of regression nobody notices until
 * someone checks the build output on a metered connection.
 *
 * `websocket-connection` is imported eagerly on purpose: it is a few hundred
 * bytes of protocol handling with no dependencies, and having it here means the
 * socket can start connecting while the emulator chunk is still downloading.
 */
const TerminalPane = lazy(() =>
  import('../features/terminal/terminal-pane').then((module) => ({
    default: module.TerminalPane,
  })),
)

export function TerminalRoute() {
  const server = currentServerOrigin()

  const connect = useCallback(() => {
    if (!server.ok) throw new Error('no server configured')
    return createWebSocketConnection(socketUrl(server.origin, TERMINAL_SOCKET_PATH))
  }, [server])

  // The desktop build before anyone has said where the server is. Saying so
  // beats letting the socket fail against an address that cannot exist.
  if (!server.ok) {
    return (
      <p className="route-loading">
        No server configured. Set the server address in settings to use the terminal.
      </p>
    )
  }

  return (
    <Suspense fallback={<p className="route-loading">Loading terminal…</p>}>
      <TerminalPane connect={connect} />
    </Suspense>
  )
}

/**
 * Where the pty WebSocket lives. Three places have to agree on this string and
 * nothing checks them: `DEFAULT_PATH` in packages/server/src/ws/terminal-socket.ts,
 * the exact-match handler in deploy/Caddyfile, and here.
 *
 * They did not agree. The client asked for `/terminal` while the server and the
 * proxy both served `/term/ws`, so the terminal could never have connected --
 * and each side was internally consistent, so no unit test on either could see
 * it. Kept as a named constant so the next person greps one token.
 */
const TERMINAL_SOCKET_PATH = '/term/ws'

/*
 * This used to derive the socket from `window.location`, on the reasoning that
 * the page and the server are always the same origin. True in a browser, and
 * false in the desktop build: its pages load from the bundle over `tauri://`
 * (`http://tauri.localhost` on Windows), so that produced
 * `ws://tauri.localhost/term/ws` -- an address inside the app itself, which
 * nothing serves. See platform/server-origin.ts.
 */
