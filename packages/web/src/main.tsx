/**
 * Composition root for the browser.
 *
 * The one place that decides which `Platform` the app runs against, and the one
 * place that knows a server exists. Nothing under features/ knows a transport
 * is involved, which is what keeps the Tauri build (DECISIONS.md §10) three
 * lines here rather than a fork.
 *
 * This file used to build an `InMemoryPlatform` unconditionally and nothing
 * else, so every feature in the app -- tree, editor, tasks, graph, search --
 * had only ever run against seeded fake data. `WebPlatform` was written and
 * tested and never instantiated. The swap this file's header had been
 * promising since the beginning is below.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/app'
import {
  currentServerOrigin,
  InMemoryPlatform,
  isRunningInTauri,
  PlatformProvider,
  SEED_NOTES,
  TauriPlatform,
  WebPlatform,
  createNotesClient,
  type Platform,
} from './platform'

import './styles/tokens.css'
import './styles/base.css'
import './shared/ui/ui.css'

/**
 * An address that is guaranteed not to resolve, for the one case that has no
 * server yet: the desktop build before anyone has typed one in.
 *
 * `App` renders the setup form rather than the workspace for exactly that case,
 * so nothing here is ever called -- and the socket link is lazy, so nothing is
 * dialled either. The alternative was an origin of `''`, which would quietly
 * become a relative URL resolving *into the app bundle* and fail with a JSON
 * parse error naming nothing. `.invalid` is reserved by RFC 2606 and fails
 * saying what it is.
 */
const UNCONFIGURED_ORIGIN = 'http://server.invalid'

const platform = choosePlatform()

function choosePlatform(): Platform {
  if (useInMemoryNotes()) {
    return new InMemoryPlatform({
      files: SEED_NOTES,
      // Enough delay that loading states are real rather than theoretical.
      latencyMs: 60,
    })
  }

  const server = currentServerOrigin()
  const notes = new WebPlatform(createNotesClient(server.ok ? server.origin : UNCONFIGURED_ORIGIN))

  // The desktop shell is a different *host* -- native window title, links that
  // open in the OS browser, menu commands -- over identical note operations.
  // Hence a wrapper around the same `WebPlatform` rather than a second client.
  return isRunningInTauri() ? new TauriPlatform(notes) : notes
}

/**
 * The fake platform, kept reachable and made opt-in.
 *
 * It is not dead code: it is what makes the UI developable and testable with no
 * server, no notes directory and no git, and it is the substrate for most of
 * this package's tests. What it must never be is something a deployed client
 * can be talked into, because a user looking at seed notes that are not theirs
 * has no way to tell.
 *
 * So the gate is `import.meta.env.DEV`, which Vite replaces with a literal
 * `false` when it builds for production -- the branch above is eliminated
 * before it ships, and no flag, query parameter or storage key can bring it
 * back. A runtime check could be flipped; this cannot.
 *
 * An environment variable rather than a query parameter because the three
 * routes are three page loads (see use-route.ts), and `?demo` would fall off
 * the moment you clicked through to /graph. Set it for the session:
 *
 *   VITE_PLATFORM=memory pnpm --filter @vim-notes/web dev
 */
function useInMemoryNotes(): boolean {
  const requested: unknown = import.meta.env?.VITE_PLATFORM
  return import.meta.env.DEV && requested === 'memory'
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The file watcher is the invalidation mechanism. Refetching on every
      // window focus would just re-fetch the tree every time you alt-tab.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PlatformProvider platform={platform}>
        <App />
      </PlatformProvider>
    </QueryClientProvider>
  </StrictMode>,
)
