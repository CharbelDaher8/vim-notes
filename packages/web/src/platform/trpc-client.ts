/**
 * The transport. One place builds it, and nothing else in the client knows a
 * URL exists.
 *
 * Two links rather than one, split on operation type:
 *
 *   queries + mutations  ->  HTTP, batched
 *   subscriptions        ->  a WebSocket
 *
 * The split is not ceremony. A request/response call over a socket would have
 * to reinvent batching, caching and the browser's own retry behaviour; a
 * subscription over HTTP would hold one of the six connections a browser will
 * open to an origin, for hours, for a stream that is silent most of the time.
 * Each link does the thing it is good at.
 *
 * Everything is built from an origin passed in rather than from
 * `window.location`, because the desktop build's pages load from the bundle
 * over `tauri://` and a relative URL there resolves *into the bundle*. See
 * server-origin.ts, which is the module that owns that question.
 */
import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
  type TRPCClient,
} from '@trpc/client'
import type { AppRouter } from '@vim-notes/server'

import { apiUrl, socketUrl } from './server-origin'

/**
 * The client `WebPlatform` takes. Typed from the server's router, so a
 * procedure that is renamed, or an input whose schema changes, is a compile
 * error in `web-platform.ts` and nowhere else -- which is the entire reason
 * both ends are TypeScript (DECISIONS.md §8).
 */
export type NotesClient = TRPCClient<AppRouter>

/**
 * Where the router is mounted, for both links.
 *
 * The socket is at this path *exactly* while the procedures are underneath it,
 * which is how `useWSS` in packages/server/src/main.ts mounts them. It matters
 * because `/trpc/*` does not match `/trpc`: the reverse proxy in
 * deploy/Caddyfile and the dev proxy in vite.config.ts both have to match the
 * bare path as well, and nothing checks that they do.
 */
const TRPC_PATH = '/trpc'

/**
 * A batch is a GET with the inputs in the query string, and a long enough one
 * gets refused by a proxy rather than by us -- as a 431 with no body, which
 * surfaces as every query in the batch failing at once for no visible reason.
 * Past this the link splits the batch instead.
 */
const MAX_URL_LENGTH = 2048

/**
 * Heartbeat. A connection that dies without a close frame -- exactly what a
 * phone leaving wifi does -- emits nothing until TCP gives up, which can be
 * minutes, and for all that time this client is silently receiving no changes
 * while believing it is connected. The same reasoning as the pty socket's own
 * heartbeat, at the same interval.
 */
const KEEPALIVE_INTERVAL_MS = 30_000
const KEEPALIVE_PONG_TIMEOUT_MS = 5_000

/** Long enough to ride over React's StrictMode remount in development. */
const IDLE_CLOSE_MS = 2_000

export function createNotesClient(origin: string): NotesClient {
  const socket = createWSClient({
    url: socketUrl(origin, TRPC_PATH),

    // Nothing dials until something subscribes. That keeps the desktop build's
    // first-run screen -- which has an origin that cannot resolve, on purpose
    // -- from retrying a connection nobody asked for behind the form telling
    // the user to supply a real one.
    lazy: { enabled: true, closeMs: IDLE_CLOSE_MS },

    keepAlive: {
      enabled: true,
      intervalMs: KEEPALIVE_INTERVAL_MS,
      pongTimeoutMs: KEEPALIVE_PONG_TIMEOUT_MS,
    },

    // Reconnects are automatic and re-send every live subscription, so a drop
    // is not permanent. It is still worth one line in the console: a client
    // that has been reconnecting every thirty seconds for an hour looks
    // exactly like a client that is working, and the difference is a proxy
    // timeout somebody needs to find.
    onClose: (cause) => {
      console.warn('[platform] change socket closed, reconnecting', cause)
    },
  })

  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === 'subscription',
        true: wsLink({ client: socket }),
        false: httpBatchLink({ url: apiUrl(origin, TRPC_PATH), maxURLLength: MAX_URL_LENGTH }),
      }),
    ],
  })
}
