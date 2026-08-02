import { homedir } from 'node:os'
import path from 'node:path'

import { z } from 'zod'

/**
 * Server configuration, parsed once at startup.
 *
 * Everything is overridable by environment variable so the same image runs in
 * Docker and on a laptop, but the defaults are chosen to be safe rather than
 * convenient -- see the note on HOST below, which is the one that matters.
 */

const DEFAULT_PORT = 4321

/**
 * Loopback, deliberately.
 *
 * This process spawns nvim in a pty and pipes it to a WebSocket, which is a
 * shell on someone's server. DECISIONS.md §11 is explicit that it is reachable
 * only over the tailnet and never exposed publicly, so the default must not be
 * 0.0.0.0 -- a default that binds every interface is one misconfigured firewall
 * away from being a public shell.
 *
 * Under Docker this default is deliberately overridden to 0.0.0.0, and that is
 * not a weakening. A container has its own network namespace, so binding its
 * loopback would make the server unreachable from Caddy in a sibling container
 * rather than merely private. There the boundary is structural instead: the
 * server service publishes no ports at all, so it exists only on the private
 * compose network, and only Caddy has a host mapping -- bound to BIND_ADDR,
 * which defaults to 127.0.0.1 so a missing .env fails closed.
 *
 * Going public is therefore two deliberate changes rather than one: BIND_ADDR
 * in deploy/.env, and a Caddyfile site block adding tls and authentication in
 * front of the terminal WebSocket. Both files say so at the relevant line.
 */
const DEFAULT_HOST = '127.0.0.1'

const schema = z.object({
  /** Absolute path to the notes working copy. Also the git repo root. */
  NOTES_ROOT: z.string().default(path.join(process.cwd(), 'notes-dev')),

  HOST: z.string().default(DEFAULT_HOST),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),

  /** Remote name the auto-committer pushes to; the bare hub from §2. */
  GIT_REMOTE: z.string().default('origin'),

  /**
   * Fallback identity. A fresh VPS often has no global gitconfig, and commits
   * that fail because of that would silently stop all history.
   */
  GIT_AUTHOR_NAME: z.string().default('vim-notes'),
  GIT_AUTHOR_EMAIL: z.string().default('vim-notes@localhost'),

  /** Idle window before a burst of saves is coalesced into one commit. */
  AUTOCOMMIT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(2_000),
  /** Cap, so continuous typing cannot postpone a commit forever. */
  AUTOCOMMIT_MAX_DELAY_MS: z.coerce.number().int().min(1_000).default(30_000),

  /** What the terminal runs. The product is nvim; this exists for tests. */
  TERMINAL_COMMAND: z.string().default('nvim'),
  /** Abandoned ptys are reaped after this long with nothing attached. */
  TERMINAL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60_000),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Config = Omit<z.infer<typeof schema>, 'NOTES_ROOT'> & {
  /** Always absolute and tilde-expanded. */
  NOTES_ROOT: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`invalid server configuration:\n${detail}`)
  }

  return { ...parsed.data, NOTES_ROOT: resolveHome(parsed.data.NOTES_ROOT) }
}

/**
 * `~` is not expanded by the shell when a value arrives through Docker's
 * environment rather than a command line, and an unexpanded tilde would create
 * a literal `./~` directory rather than failing loudly.
 */
function resolveHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2))
  return path.resolve(input)
}
