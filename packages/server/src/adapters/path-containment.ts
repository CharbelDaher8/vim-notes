/**
 * Proving that a path stays inside the notes root.
 *
 * This is shared rather than reimplemented per adapter on purpose: two copies of
 * a containment check is how one of them ends up subtly weaker than the other,
 * and the weaker one is the one an attacker uses. The note store and the search
 * adapter both need it, and neither may get it wrong.
 *
 * NotePath has already rejected `..`, absolute paths and backslashes before
 * anything reaches here, so the string check below should be unreachable --
 * which is the point of having it. The two checks fail on different attacks and
 * neither subsumes the other:
 *
 *   - The string check catches a path that resolves outside the root. The
 *     separator in `isInside` is load-bearing: without it `/notes` looks like it
 *     contains `/notes-backup`.
 *   - The realpath check catches a symlink *inside* the notes directory pointing
 *     somewhere else. No amount of string validation can see that one, and the
 *     notes directory is writable by nvim, so it is not hypothetical.
 *
 * The root is realpath'd too, because it very often is a symlink itself:
 * `/var/folders/...` on macOS, a bind-mounted volume in Docker.
 */
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

import { PathEscapeError, type NotePath } from '@vim-notes/core'

/** Absolute path for a note path, proven to be inside `root`. */
export async function resolveContained(root: string, path: NotePath): Promise<string> {
  const absolute = nodePath.resolve(root, path)
  if (!isInside(root, absolute)) throw new PathEscapeError(`${path} escapes the notes root`)

  const [realRoot, realTarget] = await Promise.all([
    realpathOfNearestExisting(root),
    realpathOfNearestExisting(absolute),
  ])
  if (!isInside(realRoot, realTarget)) {
    throw new PathEscapeError(`${path} resolves outside the notes root via a symlink`)
  }

  return absolute
}

export function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep
  return candidate === root || candidate.startsWith(prefix)
}

/**
 * Realpath of `target`, resolving as far down as the filesystem actually goes.
 *
 * Containment has to be decided for paths that do not exist yet -- every create
 * is one -- so this realpaths the deepest existing ancestor and re-attaches the
 * missing segments. Those segments come from an already-validated NotePath, so
 * re-joining them cannot introduce a traversal.
 */
export async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: string[] = []
  let current = target

  for (;;) {
    try {
      const real = await fs.realpath(current)
      return missing.length === 0 ? real : nodePath.join(real, ...missing.reverse())
    } catch (error) {
      if (!isMissing(error)) throw error

      const parent = nodePath.dirname(current)
      // Reached the filesystem root without finding anything. Impossible for a
      // path under an existing root, but it would loop forever if it happened.
      if (parent === current) return target

      missing.push(nodePath.basename(current))
      current = parent
    }
  }
}

/** ENOTDIR counts: a path whose ancestor is a file is as absent as a missing one. */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false

  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
