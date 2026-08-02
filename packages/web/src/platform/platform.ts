/**
 * The one port on the client side of the hexagon.
 *
 * Everything the UI needs from "the outside" goes through here: notes, the
 * tree, search, and the change stream. Feature code imports this interface and
 * never a transport, which is what keeps DECISIONS.md §10 honest -- the Tauri
 * build is a different implementation of `Platform`, not a second codebase.
 *
 * The shape deliberately mirrors `NoteStore` + `Search` + `FileWatcher` from
 * core rather than inventing a client-side vocabulary. A client abstraction
 * that renames the server's concepts only creates a translation layer nobody
 * asked for, and every rename is a place where the two can drift.
 */
import type {
  ExpectedVersion,
  FileChangeEvent,
  ForceWrite,
  NoteDocument,
  NotePath,
  SearchHit,
  SearchQuery,
  TreeEntry,
  Unsubscribe,
  WriteOutcome,
} from '@vim-notes/core'

/** Only used for diagnostics and for gating dev-only affordances. */
export type PlatformId = 'in-memory' | 'web' | 'tauri'

export interface Platform {
  readonly id: PlatformId

  tree(): Promise<TreeEntry[]>

  /** Null when the note does not exist; "does this exist" is a fair question. */
  read(path: NotePath): Promise<NoteDocument | null>

  /**
   * Never rejects on a conflict -- see the contract note on `NoteStore.write`.
   * A refused write comes back as `{ ok: false, conflict }` so that the call
   * site is forced to decide, which in this app means asking the user.
   */
  write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome>

  move(from: NotePath, to: NotePath): Promise<void>

  remove(path: NotePath): Promise<void>

  createDirectory(path: NotePath): Promise<void>

  search(query: SearchQuery): Promise<SearchHit[]>

  /**
   * Changes made by anyone, including this client. Listeners must filter on
   * `origin === 'api'` themselves rather than the platform swallowing the echo:
   * a second browser tab is also `api`, and it is not an echo.
   */
  subscribeToChanges(listener: (event: FileChangeEvent) => void): Unsubscribe
}
