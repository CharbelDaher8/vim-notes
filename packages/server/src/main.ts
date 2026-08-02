import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify from 'fastify'

import { appRouter } from './api/router'
import { createApplication } from './composition'
import { loadConfig } from './config'
import { logPreflight, preflight } from './preflight'
import { terminalSocketPlugin } from './ws/terminal-socket'

const config = loadConfig()

/**
 * Check the host before building anything on top of it.
 *
 * Deliberately ahead of `createApplication`, which starts watchers and can
 * spawn ptys: there is no point wiring up a server whose notes root is not a
 * repository. `process.exit` rather than a throw, because a stack trace is the
 * wrong output for "git is not installed" -- the message already says what to
 * do, and a trace only buries it.
 */
const startup = await preflight(config)
logPreflight(startup, console)
if (!startup.ok) process.exit(1)

const app = await createApplication(config)

const fastify = Fastify({
  logger: config.NODE_ENV !== 'test',
  // The terminal streams sizeable bursts on reconnect when scrollback is
  // replayed; the default 1MB body limit is unrelated but the ws payload cap
  // below is what actually matters for a wide xterm.
  bodyLimit: 4 * 1024 * 1024,
})

await fastify.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: () => app.context,
    onError: ({ error, path: procedure }: { error: { code?: string }; path?: string }) => {
      // A rejected path or a malformed payload is the client being wrong, not
      // the server failing. Logging those at error level with a full stack
      // trace buries the failures that actually need attention -- and these
      // are not rare: every traversal attempt and every reserved-name typo
      // lands here.
      if (error.code === 'BAD_REQUEST') {
        fastify.log.info({ procedure, code: error.code }, 'request rejected')
        return
      }

      fastify.log.error({ err: error, procedure }, 'trpc procedure failed')
    },
  },
})

await fastify.register(terminalSocketPlugin({ host: app.terminals }))

fastify.get('/healthz', () => ({ ok: true }))

/**
 * The built web client, served from the same origin as the API.
 *
 * Same-origin is deliberate: it keeps the browser build free of CORS and lets
 * the client use relative URLs for both tRPC and the terminal socket. The Tauri
 * build is the exception -- loaded from `tauri://`, a relative `/trpc` resolves
 * to the bundle rather than the server -- which is why that target needs an
 * explicit server origin rather than inheriting one.
 */
if (config.NODE_ENV === 'production') {
  const { default: fastifyStatic } = await import('@fastify/static')
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')

  await fastify.register(fastifyStatic, { root: webDist, wildcard: false })

  // Client-side routing: anything that is not a file and not an API route is
  // the SPA. Scoped to GET so a mistyped mutation still 404s honestly.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/trpc')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}

await fastify.listen({ host: config.HOST, port: config.PORT })

fastify.log.info({ notesRoot: config.NOTES_ROOT, polling: config.WATCH_POLLING }, 'vim-notes ready')

/**
 * Shut down in order: stop accepting connections, then flush.
 *
 * The auto-committer may be holding an uncommitted save when the signal
 * arrives, and losing it would mean losing the last thing the user typed. A
 * second signal is allowed to kill us outright -- if the flush itself is stuck,
 * refusing to die is worse than an unclean exit.
 */
let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      fastify.log.warn(`${signal} again; exiting immediately`)
      process.exit(1)
    }
    shuttingDown = true

    void (async () => {
      fastify.log.info(`${signal} received, flushing`)
      try {
        await fastify.close()
        await app.shutdown()
        process.exit(0)
      } catch (error) {
        fastify.log.error({ err: error }, 'unclean shutdown')
        process.exit(1)
      }
    })()
  })
}
