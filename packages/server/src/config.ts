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
 * This process spawns a login shell in a pty and pipes it to a WebSocket.
 * DECISIONS.md §11 is explicit that it is reachable only over the tailnet and
 * never exposed publicly, so the default must not be 0.0.0.0 -- a default that
 * binds every interface is one misconfigured firewall away from handing a shell
 * to the internet.
 *
 * It was nvim rather than a shell until DECISIONS §3 was revised, which changed
 * nothing about this: nvim in a pty runs `:!sh` for the asking, so the exposure
 * was always a shell. What changed is that it is now honest about it.
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

  /** Remote name that sync pushes to; the private GitHub repo from §2. */
  GIT_REMOTE: z.string().default('origin'),

  /**
   * Where notes are pushed, as configured.
   *
   * The server does not need this to work -- it uses whatever `origin` the
   * working copy already has. It is here so preflight can notice the two
   * disagreeing, which is a trap the setup invites: bootstrap.sh only clones
   * when the directory is absent, so editing this afterwards changes nothing
   * and the notes keep going to the old remote.
   */
  GIT_REMOTE_URL: z.string().optional(),

  /**
   * SSH deploy key for the remote. Mounted, never baked into the image.
   *
   * When set, git runs with a GIT_SSH_COMMAND built from it; when unset, git
   * uses whatever the ambient ssh configuration provides, which is what a
   * developer on a laptop with their own key wants.
   */
  GIT_SSH_KEY_PATH: z.string().optional(),

  /**
   * Where ssh records host keys. Wanted because the container has no writable
   * home directory by default, and ssh needs somewhere to put the host key it
   * accepts on first connect.
   */
  GIT_KNOWN_HOSTS_PATH: z.string().optional(),

  /**
   * How often to pull and push. 0 disables polling entirely.
   *
   * Polling exists because the server is tailnet-only and a GitHub webhook
   * cannot reach it (§2). The floor is not zero-or-anything: sync is a fetch
   * plus a push against someone else's servers, and a value of a few hundred
   * milliseconds would be abuse rather than configuration.
   */
  SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(60_000)
    .refine((value) => value === 0 || value >= 5_000, {
      message: 'must be 0 (disabled) or at least 5000ms',
    }),

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

  /**
   * Poll for file changes instead of relying on native filesystem events.
   *
   * Off by default: on Linux with a normal volume, inotify is accurate and free,
   * while polling a large tree burns CPU continuously.
   *
   * Turn it on when the notes directory is a Docker bind mount from a macOS or
   * Windows host, or any network filesystem. Native recursive watching drops
   * events on all of those, and the failure mode is the bad one -- the watcher
   * reports nothing and looks perfectly healthy, so the web client silently
   * stops noticing what nvim writes.
   */
  WATCH_POLLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  WATCH_POLL_INTERVAL_MS: z.coerce.number().int().min(20).default(100),

  /**
   * What the terminal runs.
   *
   * A login shell, not an editor. `/term` used to launch nvim directly, which
   * made the one thing a terminal is for -- running a command -- impossible
   * without going through `:!`. Now nvim is something you type, like everything
   * else.
   *
   * A *login* shell (see TERMINAL_ARGS) so it behaves like one opened over ssh:
   * /etc/profile and ~/.profile are read, which is where per-box customisation
   * goes. Not for PATH -- the image's default PATH already carries
   * /usr/local/bin, where nvim is, and the pty inherits it.
   */
  TERMINAL_COMMAND: z.string().default('bash'),
  /**
   * Arguments for it, split on whitespace.
   *
   * Whitespace rather than a real parser because every argument a shell needs
   * here is a flag. Anything that would require quoting belongs in the profile,
   * not in an environment variable read by a regex.
   */
  TERMINAL_ARGS: z
    .string()
    .default('-l')
    .transform((value) => value.split(/\s+/).filter((argument) => argument !== '')),
  /** Abandoned ptys are reaped after this long with nothing attached. */
  TERMINAL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60_000),

  /**
   * Where the news aggregator's API answers, if there is one.
   *
   * Empty by default, and empty is a supported configuration rather than a
   * misconfiguration: the aggregator is a separate application in a separate
   * repository, and a deployment that never cloned it must serve notes exactly
   * as it did before. The client is told "not configured" and renders nothing.
   */
  NEWS_API_URL: z.string().default(''),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Config = Omit<
  z.infer<typeof schema>,
  'NOTES_ROOT' | 'GIT_SSH_KEY_PATH' | 'GIT_KNOWN_HOSTS_PATH'
> & {
  /** Always absolute and tilde-expanded. */
  NOTES_ROOT: string
  /** Absolute and tilde-expanded when set. */
  GIT_SSH_KEY_PATH: string | undefined
  GIT_KNOWN_HOSTS_PATH: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`invalid server configuration:\n${detail}`)
  }

  return {
    ...parsed.data,
    NOTES_ROOT: resolveHome(parsed.data.NOTES_ROOT),
    // Both are paths handed to ssh, which does no tilde expansion of its own
    // when they arrive through GIT_SSH_COMMAND rather than a shell.
    GIT_SSH_KEY_PATH: optionalPath(parsed.data.GIT_SSH_KEY_PATH),
    GIT_KNOWN_HOSTS_PATH: optionalPath(parsed.data.GIT_KNOWN_HOSTS_PATH),
  }
}

/**
 * `~` is not expanded by the shell when a value arrives through Docker's
 * environment rather than a command line, and an unexpanded tilde would create
 * a literal `./~` directory rather than failing loudly.
 */
function optionalPath(input: string | undefined): string | undefined {
  return input === undefined || input === '' ? undefined : resolveHome(input)
}

function resolveHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2))
  return path.resolve(input)
}
