import type { ContentHash, ExpectedVersion, ForceWrite, WriteConflict } from '../domain/conflict'
import type { NotePath } from '../domain/note-path'

export interface NoteMetadata {
  path: NotePath
  hash: ContentHash
  /** Bytes on disk, not characters. */
  size: number
  /** Epoch milliseconds. */
  modifiedAt: number
}

export interface NoteDocument extends NoteMetadata {
  content: string
}

export type TreeEntry =
  | { kind: 'file'; path: NotePath; name: string; size: number; modifiedAt: number }
  | { kind: 'directory'; path: NotePath; name: string; children: TreeEntry[] }

export type WriteOutcome =
  | { ok: true; metadata: NoteMetadata }
  | { ok: false; conflict: WriteConflict; actual: NoteMetadata | null }

/**
 * Reading and writing notes. The only port with a non-trivial contract, so:
 *
 * - `write` never throws on a conflict. Conflicts are an expected outcome of
 *   normal two-writer operation, not an exceptional condition, and returning
 *   them forces call sites to decide what to do. Throwing is reserved for
 *   genuine failures (disk full, permissions).
 * - `read` and `stat` return null for a missing note rather than throwing,
 *   because "does this exist" is a question callers legitimately ask.
 * - Every path is a NotePath, so implementations never see an unvalidated
 *   string. Implementations should still perform their own containment check;
 *   defence in depth is cheap here.
 */
export interface NoteStore {
  /** Full recursive tree of the notes root, directories first, name-sorted. */
  tree(): Promise<TreeEntry[]>

  read(path: NotePath): Promise<NoteDocument | null>

  stat(path: NotePath): Promise<NoteMetadata | null>

  write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome>

  /** Creates missing parent directories of `to`. Fails if `to` exists. */
  move(from: NotePath, to: NotePath): Promise<void>

  /** Removes a file, or a directory and everything under it. */
  remove(path: NotePath): Promise<void>

  createDirectory(path: NotePath): Promise<void>
}
