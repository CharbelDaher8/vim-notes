/**
 * The HTTP surface: every route this server answers, assembled in one place.
 *
 * Split out of main.ts so that a test can stand the *real* assembly up rather
 * than a re-creation of it. That distinction has cost this project four bugs
 * now, all of the same shape -- a correct, thoroughly tested component that
 * nothing ever connected -- and every one of them lived in exactly the sort of
 * plumbing that used to be inlined in the entry point where no test could
 * reach it. main.ts keeps the parts that only make sense in a process:
 * configuration, preflight, listening, and signals.
 */
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import websocketPlugin from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import { appRouter } from './api/router'
import type { AppContext } from './api/trpc'
import { terminalSocketPlugin, type PtySessionHost } from './ws/terminal-socket'

export interface HttpServerOptions {
  /** The ports, as tRPC's context. See api/trpc.ts. */
  context: AppContext
  terminals: PtySessionHost
  /** Off under test, where request logs are noise around the assertion. */
  logger?: boolean
  /**
   * Directory holding the built web client, or null to serve only the API.
   *
   * Null in development, where Vite serves the client and proxies to here.
   */
  webRoot?: string | null
}

export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const { context, terminals, logger = true, webRoot = null } = options

  const fastify = Fastify({
    logger,
    // The terminal streams sizeable bursts on reconnect when scrollback is
    // replayed; the default 1MB body limit is unrelated but the ws payload cap
    // below is what actually matters for a wide xterm.
    bodyLimit: 4 * 1024 * 1024,
  })

  /**
   * Registered here, at the root, rather than being left to whichever plugin
   * wants it first.
   *
   * Two things need it -- the pty socket and the tRPC subscription below --
   * and `@fastify/websocket` decorates the *scope* it is registered in. Left
   * to `terminalSocketPlugin`, which registers it inside its own encapsulated
   * scope, the `websocket: true` route option would not exist for the tRPC
   * plugin and `notes.changes` would be served as an ordinary GET that never
   * upgrades. `terminalSocketPlugin` checks `hasPlugin` first, so this makes
   * its own registration a no-op rather than a conflict.
   */
  await fastify.register(websocketPlugin)

  await fastify.register(fastifyTRPCPlugin, {
    prefix: TRPC_PREFIX,
    /**
     * Subscriptions over a WebSocket, at `GET /trpc` exactly.
     *
     * Chosen over SSE because the shape the client already assumed is
     * `notes.changes.subscribe(...)`, because the one long-lived connection
     * this app already runs in production -- the pty socket -- proves that
     * path through Caddy works, and because `@fastify/websocket` was already a
     * dependency for it. HTTP keeps carrying queries and mutations; the client
     * splits on operation type.
     *
     * The endpoint is the prefix itself, *not* under it, which is the trap
     * worth naming: `/trpc/*` does not match `/trpc`. Three files outside this
     * one have to agree and nothing checks them -- the matcher in
     * deploy/Caddyfile, the dev proxy in packages/web/vite.config.ts, and
     * packages/web/src/platform/trpc-client.ts.
     */
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext: () => context,
      onError: ({ error, path: procedure }: { error: { code?: string }; path?: string }) => {
        // A rejected path or a malformed payload is the client being wrong,
        // not the server failing. Logging those at error level with a full
        // stack trace buries the failures that actually need attention -- and
        // these are not rare: every traversal attempt and every reserved-name
        // typo lands here.
        if (error.code === 'BAD_REQUEST') {
          fastify.log.info({ procedure, code: error.code }, 'request rejected')
          return
        }

        fastify.log.error({ err: error, procedure }, 'trpc procedure failed')
      },
    },
  })

  await fastify.register(terminalSocketPlugin({ host: terminals }))

  fastify.get('/healthz', () => ({ ok: true }))

  /**
   * The built web client, served from the same origin as the API.
   *
   * Same-origin is deliberate: it keeps the browser build free of CORS and
   * lets the client use relative URLs for tRPC and both sockets. The Tauri
   * build is the exception -- loaded from `tauri://`, a relative `/trpc`
   * resolves to the bundle rather than to any server -- which is why that
   * target is told an explicit origin instead of inheriting one.
   */
  if (webRoot !== null) {
    const { default: fastifyStatic } = await import('@fastify/static')

    await fastify.register(fastifyStatic, { root: webRoot, wildcard: false })

    // Client-side routing: anything that is not a file and not an API route is
    // the SPA. Scoped to GET so a mistyped mutation still 404s honestly.
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith(TRPC_PREFIX)) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return fastify
}

/** Where the router is mounted. The socket is this path exactly. */
export const TRPC_PREFIX = '/trpc'
