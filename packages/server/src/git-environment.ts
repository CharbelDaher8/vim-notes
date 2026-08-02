/**
 * The environment every git subprocess runs with.
 *
 * It lives on its own because two callers need exactly the same one and a
 * difference between them would be invisible: the composition root builds it for
 * GitVersionControl, and preflight builds it to test whether the remote answers.
 * If preflight checked reachability without the deploy key it would report the
 * remote as unreachable on a perfectly healthy box, which is worse than not
 * checking at all.
 */

import type { Config } from './config'

export function gitEnvironment(config: Config): NodeJS.ProcessEnv {
  const key = config.GIT_SSH_KEY_PATH
  if (key === undefined) {
    // No key configured: git uses the ambient ssh setup. That is what a
    // developer running this on their own laptop wants, and it is why the key
    // is optional rather than defaulted to a path that does not exist.
    return {}
  }

  const options = [
    'ssh',
    '-i',
    quoteForSsh(key),
    // Without this, ssh offers every key the agent holds before the one we
    // asked for, and GitHub rejects the connection after too many attempts --
    // which surfaces as an auth failure that a correct key does not fix.
    '-o',
    'IdentitiesOnly=yes',
    // Trust on first use. The alternative is pinning GitHub's host keys, which
    // is stronger but breaks silently when they are rotated; see deploy/README.
    '-o',
    'StrictHostKeyChecking=accept-new',
  ]

  if (config.GIT_KNOWN_HOSTS_PATH !== undefined) {
    // The container has no writable home, so ssh has nowhere to record the host
    // key it accepts. Without this it re-accepts on every connection at best,
    // and refuses at worst.
    options.push('-o', `UserKnownHostsFile=${quoteForSsh(config.GIT_KNOWN_HOSTS_PATH)}`)
  }

  return { GIT_SSH_COMMAND: options.join(' ') }
}

/**
 * GIT_SSH_COMMAND is split on whitespace by git before it is executed, so a key
 * path containing a space silently becomes two arguments and the connection
 * fails with a message about a file that does not exist.
 */
function quoteForSsh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
