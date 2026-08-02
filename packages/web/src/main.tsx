/**
 * Composition root for the browser.
 *
 * The one place that decides which `Platform` the app runs against. Swapping
 * `InMemoryPlatform` for `new WebPlatform(trpcClient)` is the whole change --
 * nothing under features/ knows a transport exists, which is what keeps the
 * Tauri build (DECISIONS.md §10) a third line in this file rather than a fork.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/app'
import { InMemoryPlatform, PlatformProvider, SEED_NOTES } from './platform'

import './styles/tokens.css'
import './styles/base.css'
import './shared/ui/ui.css'

const platform = new InMemoryPlatform({
  files: SEED_NOTES,
  // Enough delay that loading states are real rather than theoretical. The
  // server is on a tailnet, not localhost, so this is closer to the truth than
  // an instant resolve would be.
  latencyMs: 60,
})

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
