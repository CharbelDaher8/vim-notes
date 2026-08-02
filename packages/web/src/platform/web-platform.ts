/**
 * `Platform` over the tRPC API.
 *
 * The transport is injected rather than constructed here so that the composition
 * root owns the URL, the headers and the WebSocket link, and so that this file
 * can be typechecked before the server exists.
 *
 * NOTE FOR WHOEVER LANDS THE ROUTER: `NotesApiClient` below is the shape this
 * client assumes, written to be structurally satisfied by
 * `createTRPCClient<AppRouter>()`. Once `@vim-notes/server` exports `AppRouter`,
 * delete the interface and type the parameter as the real proxy client -- if the
 * router disagrees with this shape, the mismatch is meant to surface here and
 * nowhere else in the app.
 */
import {
  FORCE_WRITE,
  type AnnotationFilter,
  type AnnotationRecord,
  type CreateDirectoryInput,
  type ExpectedVersion,
  type FileChangeEvent,
  type ForceWrite,
  type MoveNoteInput,
  type NoteDocument,
  type NoteGraph,
  type NotePath,
  type ReadNoteInput,
  type RemoveNoteInput,
  type ResolvedLink,
  type SearchHit,
  type SearchQuery,
  type SearchQueryInput,
  type TreeEntry,
  type Unsubscribe,
  type WriteNoteInput,
  type WriteOutcome,
} from '@vim-notes/core'

import type { Platform } from './platform'
import { documentHost } from './document-host'

export interface NotesApiClient {
  notes: {
    tree: { query: () => Promise<TreeEntry[]> }
    read: { query: (input: ReadNoteInput) => Promise<NoteDocument | null> }
    write: { mutate: (input: WriteNoteInput) => Promise<WriteOutcome> }
    move: { mutate: (input: MoveNoteInput) => Promise<void> }
    remove: { mutate: (input: RemoveNoteInput) => Promise<void> }
    createDirectory: { mutate: (input: CreateDirectoryInput) => Promise<void> }
    changes: {
      subscribe: (
        input: undefined,
        handlers: { onData: (event: FileChangeEvent) => void; onError?: (error: unknown) => void },
      ) => { unsubscribe: () => void }
    }
  }
  search: { query: (input: SearchQueryInput) => Promise<SearchHit[]> }
  /**
   * The derived index. Written against the router that is being built
   * alongside this -- `annotations`, `backlinks`, `outboundLinks`, `graph`
   * under `notesIndex` -- rather than waiting for it, on the same terms as the
   * note declaring `NotesApiClient` above: if the router lands with a different
   * shape, the mismatch surfaces here and nowhere else.
   *
   * `outboundLinks` is deliberately absent. The route exists, but `Platform`
   * does not expose it and declaring a dependency the client never calls would
   * constrain the router for nothing.
   */
  notesIndex: {
    annotations: { query: (input: AnnotationFilter) => Promise<AnnotationRecord[]> }
    backlinks: { query: (input: { path: NotePath }) => Promise<ResolvedLink[]> }
    graph: { query: () => Promise<NoteGraph> }
  }
}

export class WebPlatform implements Platform {
  readonly id = 'web' as const
  readonly host = documentHost

  readonly #client: NotesApiClient

  constructor(client: NotesApiClient) {
    this.#client = client
  }

  tree(): Promise<TreeEntry[]> {
    return this.#client.notes.tree.query()
  }

  read(path: NotePath): Promise<NoteDocument | null> {
    return this.#client.notes.read.query({ path })
  }

  write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome> {
    // The symbol cannot cross the wire, so it becomes the `force` flag that
    // `writeNoteInput` declares. `expected` still travels on a forced write --
    // the server logs what was clobbered, and a nullable field is a worse way
    // to say "deliberate" than a field literally named `force`.
    const force = expected === FORCE_WRITE
    return this.#client.notes.write.mutate({
      path,
      content,
      expected: force ? null : expected,
      force,
    })
  }

  move(from: NotePath, to: NotePath): Promise<void> {
    return this.#client.notes.move.mutate({ from, to })
  }

  remove(path: NotePath): Promise<void> {
    return this.#client.notes.remove.mutate({ path })
  }

  createDirectory(path: NotePath): Promise<void> {
    return this.#client.notes.createDirectory.mutate({ path })
  }

  search(query: SearchQuery): Promise<SearchHit[]> {
    return this.#client.search.query({
      pattern: query.pattern,
      regex: query.regex ?? false,
      caseSensitive: query.caseSensitive ?? false,
      under: query.under,
      limit: query.limit ?? 100,
    })
  }

  annotations(filter: AnnotationFilter = {}): Promise<AnnotationRecord[]> {
    return this.#client.notesIndex.annotations.query(filter)
  }

  backlinks(path: NotePath): Promise<ResolvedLink[]> {
    return this.#client.notesIndex.backlinks.query({ path })
  }

  graph(): Promise<NoteGraph> {
    return this.#client.notesIndex.graph.query()
  }

  subscribeToChanges(listener: (event: FileChangeEvent) => void): Unsubscribe {
    const subscription = this.#client.notes.changes.subscribe(undefined, {
      onData: listener,
      onError: (error) => {
        // A dropped watcher means the editor stops learning about nvim's
        // writes. Nothing is corrupted -- the version check still refuses a
        // stale save -- so this is logged rather than surfaced as an error.
        console.warn('[platform] change subscription failed', error)
      },
    })

    return () => {
      subscription.unsubscribe()
    }
  }
}
