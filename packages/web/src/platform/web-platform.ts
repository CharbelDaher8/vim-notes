/**
 * `Platform` over the tRPC API.
 *
 * The transport is injected rather than constructed here so that the
 * composition root owns the origin and the links, and so that this class stays
 * a plain translation between the client port and the router.
 *
 * The parameter is the *real* `createTRPCClient<AppRouter>()` type, imported
 * from the server package. That is the point of this file: a procedure that is
 * renamed, an input whose schema changes, a return type that stops matching --
 * every one of those is a compile error here and nowhere else in the app.
 *
 * This file used to declare a hand-written `NotesApiClient` interface instead,
 * as a placeholder until the router existed. It was wrong: it put the index
 * routes under `notesIndex` where the router mounts them as `index`, and it
 * declared the three void-returning mutations as returning nothing when the
 * router answers `{ moved: true }` and friends. Both were invisible for as long
 * as the placeholder was the only thing checking.
 */
import {
  FORCE_WRITE,
  type AnnotationFilter,
  type AnnotationRecord,
  type ExpectedVersion,
  type FileChangeEvent,
  type ForceWrite,
  type NoteDocument,
  type NoteGraph,
  type NotePath,
  type ResolvedLink,
  type SearchHit,
  type SearchQuery,
  type TreeEntry,
  type Unsubscribe,
  type WriteOutcome,
} from '@vim-notes/core'

import type { Platform } from './platform'
import type { NotesClient } from './trpc-client'
import { documentHost } from './document-host'

export class WebPlatform implements Platform {
  readonly id = 'web' as const
  readonly host = documentHost

  readonly #client: NotesClient

  constructor(client: NotesClient) {
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
    // `FORCE_WRITE` is a symbol and cannot cross the wire, so it becomes the
    // `force` flag `writeNoteInput` declares, and `expected` goes as null --
    // there is no hash to send, because forcing is precisely the case where
    // the client has stopped claiming to know what is on disk. A field named
    // `force` says "deliberate" where a nullable `expected` would only say
    // "missing", which is the distinction the server needs to log a clobber.
    const force = expected === FORCE_WRITE
    return this.#client.notes.write.mutate({
      path,
      content,
      expected: force ? null : expected,
      force,
    })
  }

  // The three below answer `{ moved: true }`, `{ removed: true }` and
  // `{ created: true }`. The port returns void deliberately: those flags say
  // only that the call was not a no-op, which the caller already knows because
  // it is the thing that asked. Awaited and dropped rather than plumbed
  // through as a boolean nothing would branch on.

  async move(from: NotePath, to: NotePath): Promise<void> {
    await this.#client.notes.move.mutate({ from, to })
  }

  async remove(path: NotePath): Promise<void> {
    await this.#client.notes.remove.mutate({ path })
  }

  async createDirectory(path: NotePath): Promise<void> {
    await this.#client.notes.createDirectory.mutate({ path })
  }

  search(query: SearchQuery): Promise<SearchHit[]> {
    // `search.query` is the procedure's path; the second `.query` is tRPC
    // asking which kind of operation it is. Reads badly and is correct --
    // renaming a route to make one call site prettier is the worse trade.
    return this.#client.search.query.query({
      pattern: query.pattern,
      regex: query.regex ?? false,
      caseSensitive: query.caseSensitive ?? false,
      under: query.under,
      limit: query.limit ?? 100,
    })
  }

  // `index` rather than `notesIndex`: the router mounts `notesIndexRouter`
  // under `index`, and the server is the side that gets to name things.
  // `outboundLinks` is deliberately not called -- the route exists, but
  // `Platform` does not expose it.

  annotations(filter: AnnotationFilter = {}): Promise<AnnotationRecord[]> {
    return this.#client.index.annotations.query(filter)
  }

  backlinks(path: NotePath): Promise<ResolvedLink[]> {
    return this.#client.index.backlinks.query({ path })
  }

  graph(): Promise<NoteGraph> {
    return this.#client.index.graph.query()
  }

  /**
   * The watcher, as a stream.
   *
   * What happens when the socket drops, said plainly: the link reconnects on
   * its own and re-sends this subscription, so changes start arriving again --
   * but **every change made during the gap is lost**. The server keeps no log
   * of past events to replay from, so there is nothing to ask for. A note
   * edited in nvim while the phone was in a lift stays stale in this client
   * until something refetches it.
   *
   * That is survivable rather than fine, and it is survivable for two specific
   * reasons. Nothing is corrupted: the version check on write still refuses a
   * stale save, so the worst case is being told about a conflict instead of
   * seeing the edit arrive. And the tree query carries a 30-second
   * `staleTime` (see `useTree`) precisely as the backstop for this, so a
   * created or deleted note reappears on the next refetch.
   */
  subscribeToChanges(listener: (event: FileChangeEvent) => void): Unsubscribe {
    const subscription = this.#client.notes.changes.subscribe(undefined, {
      onData: listener,
      onError: (error) => {
        // Reached for a subscription the server refused, not for a dropped
        // connection -- the link retries those itself without reporting here.
        console.warn('[platform] change subscription failed', error)
      },
    })

    return () => {
      subscription.unsubscribe()
    }
  }
}
