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

// The error taxonomy moved to core: what a port can throw is part of its
// contract, and keeping it there lets the API layer map failures to status
// codes without importing an adapter. Re-exported so adapter code can keep
// importing its errors and its sort order from one place.
export {
  NotFoundError,
  NoteStoreError,
  PathEscapeError,
  PathOccupiedError,
} from '@vim-notes/core'

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
