/**
 * The pieces both NoteStore implementations have to agree on.
 *
 * The in-memory store is not a mock -- it is what the API layer's tests run
 * against, so everything a caller can observe has to match the filesystem store
 * exactly. Two things are observable beyond the return values: which class of
 * error is thrown, and the order `tree()` hands entries back in. Defining both
 * once is the entire reason this module exists.
 */
import type { TreeEntry } from '@vim-notes/core'

/**
 * Base class so the API layer can map every store failure to a status code with
 * one `instanceof`, and so anything that is *not* one of these is recognisable
 * as a genuine surprise (EACCES, ENOSPC) that deserves a 500.
 *
 * Note that write conflicts are deliberately absent: they are returned, not
 * thrown. See the NoteStore port.
 */
export class NoteStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * A resolved path landed outside the notes root. Unreachable through a genuine
 * NotePath, which is why it is worth shouting about if it ever happens: it means
 * either a forged branded string or a symlink pointing out of the notes tree.
 */
export class PathEscapeError extends NoteStoreError {}

/** Nothing exists at the path, for operations that require something to. */
export class NotFoundError extends NoteStoreError {}

/** Something is already at the path, or at an ancestor that needs to be a directory. */
export class PathOccupiedError extends NoteStoreError {}

/**
 * Directories first, then case-insensitively by name -- what a file tree UI
 * expects, and what the port promises. The raw-name tie-break keeps `A.md` and
 * `a.md` in a stable order on a case-sensitive filesystem, where both can exist
 * side by side.
 */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1

  const byLowercase = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  return byLowercase !== 0 ? byLowercase : a.name.localeCompare(b.name)
}
