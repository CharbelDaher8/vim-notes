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
  AnnotationFilter,
  AnnotationRecord,
  ExpectedVersion,
  FileChangeEvent,
  ForceWrite,
  NewsItem,
  NewsQuery,
  NewsStatus,
  NoteGraph,
  ResolvedLink,
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

/**
 * The window itself, as opposed to the data behind it.
 *
 * Separated from the note operations because it is the part with genuinely
 * different implementations rather than a different transport: in a browser tab
 * the title is `document.title`, and in the Tauri build it is the real OS window
 * title. Feature code should not have to know which it is running in.
 */
export interface PlatformHost {
  readonly kind: 'browser' | 'tauri'
  readonly capabilities: HostCapabilities

  setWindowTitle(title: string): void

  /**
   * Opens a link outside the app.
   *
   * Load-bearing rather than cosmetic on the desktop: a plain navigation inside
   * a Tauri webview *replaces the running application* with the target page,
   * and there is no back button because there is no browser chrome. Notes
   * contain links as a matter of course, so this is a real hazard rather than a
   * hypothetical one.
   */
  openExternal(url: string): Promise<void>

  revealInFileManager(path: NotePath): Promise<void>

  onCommand(listener: (command: HostCommand) => void): Unsubscribe
}

/**
 * Commands a native shell can raise that a web page has no way to receive --
 * global hotkeys, tray items, and the menu accelerators that are the stated
 * reason the desktop app exists at all (DECISIONS.md §10: browsers eat `Cmd+W`,
 * `Cmd+T` and `Cmd+N` before any handler sees them).
 */
export type HostCommand = 'new-note' | 'search' | 'save' | 'toggle-vim' | 'close-note'

export interface HostCapabilities {
  /** Can show a path in Finder / Explorer. */
  revealInFileManager: boolean
  /** Can deliver menu, tray and global-hotkey commands. */
  commands: boolean
}

export interface Platform {
  readonly id: PlatformId

  readonly host: PlatformHost

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

  // --- Derived views -------------------------------------------------------
  //
  // Everything below is parsed back out of the markdown rather than stored, so
  // it is always consistent with the files and costs nothing to throw away.
  // The in-memory implementation computes it with the same core parser the
  // server uses, which is what keeps the offline UI honest.

  annotations(filter?: AnnotationFilter): Promise<AnnotationRecord[]>

  /** Links pointing *at* this note, which is the direction worth showing. */
  backlinks(path: NotePath): Promise<ResolvedLink[]>

  graph(): Promise<NoteGraph>

  // --- Somebody else's data -------------------------------------------------
  //
  // The news aggregator, which is a separate application that may not be
  // deployed at all. Unlike everything above, this is not derived from the
  // notes and is not owned by this app -- so it gets a `status()` rather than
  // an assumption, and every implementation must answer it without throwing.

  news: NewsClient
}

export interface NewsClient {
  status(): Promise<NewsStatus>
  list(query?: NewsQuery): Promise<NewsItem[]>
  setRead(id: string, read: boolean): Promise<void>
  /** Returns the new state, because it toggles rather than sets. */
  toggleSaved(id: string): Promise<boolean>
  /**
   * Copy an item into a note, one way.
   *
   * `date` is the client's day rather than the server's: the server is a box in
   * whichever region was cheapest, and the day a person is having is not UTC.
   */
  save(id: string, date: string, path?: NotePath): Promise<{ path: NotePath; created: boolean }>
}
