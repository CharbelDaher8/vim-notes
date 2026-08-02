import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createApplication } from './composition'
import { loadConfig } from './config'
import { buildHttpServer } from './http-server'
import { logPreflight, preflight } from './preflight'

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

const fastify = await buildHttpServer({
  context: app.context,
  terminals: app.terminals,
  logger: config.NODE_ENV !== 'test',
  webRoot: config.NODE_ENV === 'production' ? resolveWebRoot() : null,
})

await fastify.listen({ host: config.HOST, port: config.PORT })

fastify.log.info({ notesRoot: config.NOTES_ROOT, polling: config.WATCH_POLLING }, 'vim-notes ready')

/** Relative to the built entry point, which lives in `packages/server/dist`. */
function resolveWebRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
}

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
