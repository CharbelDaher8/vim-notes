/**
 * What can go in the dock, and how each one is built.
 *
 * One registry, so adding a panel is an entry here rather than a branch in
 * three files. Every component is behind its own `lazy`, which is what keeps
 * three chunks -- a force simulation, a terminal emulator, a feed -- off the
 * page until somebody opens one (DECISIONS §13).
 *
 * The terminal is the reason this file has a `connect` at all. The other two
 * are self-contained views over data the platform already provides; the
 * terminal needs a socket, and where that socket lives is a question only the
 * composition root can answer (see terminal-route.tsx, which asks it the same
 * way for the full-page route).
 */
import { lazy, useCallback, type ReactNode } from 'react'

import { LazyGraphView } from '../../app/graph-chunk'
import { currentServerOrigin, socketUrl } from '../../platform'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { createWebSocketConnection } from '../terminal/websocket-connection'
import type { DockPanelId } from './dock-model'

const NewsPane = lazy(() =>
  import('../news/news-pane').then((module) => ({ default: module.NewsPane })),
)

const TerminalPane = lazy(() =>
  import('../terminal/terminal-pane').then((module) => ({ default: module.TerminalPane })),
)

export interface DockPanelDefinition {
  id: DockPanelId
  title: string
  /** Where the same thing lives as a whole page, for the "open full" control. */
  href: string
  render: () => ReactNode
}

export function useDockPanelDefinitions(): Record<DockPanelId, DockPanelDefinition> {
  const server = currentServerOrigin()

  const connect = useCallback(() => {
    if (!server.ok) throw new Error('no server configured')
    return createWebSocketConnection(socketUrl(server.origin, TERMINAL_SOCKET_PATH))
  }, [server])

  return {
    graph: {
      id: 'graph',
      title: 'Graph',
      href: '/graph',
      // Clicking a node opens the note in the editor beside it, which is the
      // whole reason for having the graph here rather than on its own page.
      render: () => (
        <LazyGraphView
          className="graph--panel"
          onOpen={(target) => {
            void useWorkspaceStore
              .getState()
              .openNote(target.path, target.line === undefined ? undefined : { line: target.line })
          }}
        />
      ),
    },

    news: {
      id: 'news',
      title: 'News',
      href: '/news',
      render: () => <NewsPane />,
    },

    terminal: {
      id: 'terminal',
      title: 'Terminal',
      href: '/term',
      render: () =>
        server.ok ? (
          <TerminalPane connect={connect} />
        ) : (
          // The desktop build before anyone has said where the server is.
          // Saying so beats a socket failing against an address that cannot
          // exist.
          <p className="dock__notice">No server configured.</p>
        ),
    },
  }
}

/** Also in terminal-route.tsx, the Caddyfile, and the server. See the note there. */
const TERMINAL_SOCKET_PATH = '/term/ws'
