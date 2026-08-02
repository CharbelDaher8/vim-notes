/**
 * Who caused a change, for the few hundred milliseconds it takes the watcher to
 * notice it.
 *
 * The filesystem cannot tell you which process wrote a file. All the watcher
 * sees is "note.md changed", and it has to decide whether that was the API
 * (whose client already has the new text and must ignore the echo, or the
 * editor reloads the buffer it just saved and jumps the cursor mid-keystroke) or
 * somebody else (whose change the client genuinely needs).
 *
 * So the answer is recorded on the way in rather than guessed on the way out:
 * whoever performs a change leaves a short-lived note here, and the watcher
 * claims it when the event surfaces.
 *
 * Two kinds of claim, because they are worth very different amounts:
 *
 *   - `recordContent` is content-addressed. It matches only if the bytes on
 *     disk hash to what the writer said it wrote, so a write by nvim landing in
 *     the same window can never be mistaken for the API's -- different content,
 *     different hash, no match. This covers every note write.
 *   - `recordSubtree` matches on path and time alone, because deletions and
 *     moves leave no content to compare. This one is a genuine heuristic; see
 *     the honesty note on `claim`.
 *
 * Not restricted to the API: any component that knows it caused a change can
 * record with its own origin. The terminal adapter can claim nvim's writes if
 * it ever learns of them (an autocmd over RPC), and the git adapter can claim
 * the working-tree churn of a checkout.
 */
import {
  notePathContains,
  type ChangeOrigin,
  type ContentHash,
  type NotePath,
} from '@vim-notes/core'

/**
 * The narrow half of the journal, for components that only ever record.
 *
 * FsNoteStore takes this rather than the class so it depends on "somewhere to
 * report a write" instead of on the watcher's machinery.
 */
export interface WriteObserver {
  recordContent(path: NotePath, hash: ContentHash, origin?: ChangeOrigin): void
  recordSubtree(path: NotePath, origin?: ChangeOrigin): void
}

export interface WriteJournalOptions {
  /**
   * How long a claim stays valid. Long enough to cover watcher latency plus the
   * debounce, short enough that a stale entry cannot silence a later change --
   * see the tradeoff on `claim`.
   */
  ttlMs?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 5_000

interface Entry {
  origin: ChangeOrigin
  at: number
}

export class WriteJournal implements WriteObserver {
  private readonly ttlMs: number
  private readonly now: () => number

  /** Keyed by path and hash together: the claim is only good for those bytes. */
  private readonly byContent = new Map<string, Entry>()
  private readonly bySubtree = new Map<NotePath, Entry>()

  constructor(options: WriteJournalOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  recordContent(path: NotePath, hash: ContentHash, origin: ChangeOrigin = 'api'): void {
    this.prune()
    this.byContent.set(contentKey(path, hash), { origin, at: this.now() })
  }

  recordSubtree(path: NotePath, origin: ChangeOrigin = 'api'): void {
    this.prune()
    this.bySubtree.set(path, { origin, at: this.now() })
  }

  /**
   * The origin that claims this change, or null if nobody does.
   *
   * Where this can be wrong, stated plainly:
   *
   *   - A content claim can only be wrong if another writer wrote *byte for
   *     byte the same thing* inside the window. The event is then labelled
   *     'api' and the client skips a reload it did not need -- its buffer
   *     already holds those exact bytes.
   *   - A subtree claim has no content to check, so an nvim delete of the same
   *     path within the window after an API delete is labelled 'api'. The
   *     outcome on disk is identical either way, so the client's reaction would
   *     have been the same.
   *   - If the watcher never sees the event at all, the claim simply expires.
   *
   * The costly direction -- labelling somebody else's *different* content as
   * 'api' and dropping their change on the floor -- is the one content
   * addressing rules out.
   */
  claim(path: NotePath, hash: ContentHash | null): ChangeOrigin | null {
    this.prune()

    if (hash !== null) {
      const key = contentKey(path, hash)
      const entry = this.byContent.get(key)
      if (entry !== undefined) {
        // Consumed: these exact bytes are accounted for. A later write of the
        // same content is somebody else's until they say otherwise.
        this.byContent.delete(key)
        return entry.origin
      }
    }

    for (const [prefix, entry] of this.bySubtree) {
      // Left to expire rather than consumed: removing a directory produces one
      // event per note under it, and they all belong to this claim.
      if (prefix === path || notePathContains(prefix, path)) return entry.origin
    }

    return null
  }

  /** Live claims. Exposed so tests can assert entries do not accumulate. */
  get size(): number {
    this.prune()
    return this.byContent.size + this.bySubtree.size
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs

    for (const [key, entry] of this.byContent) {
      if (entry.at <= cutoff) this.byContent.delete(key)
    }
    for (const [key, entry] of this.bySubtree) {
      if (entry.at <= cutoff) this.bySubtree.delete(key)
    }
  }
}

/** NUL separates the two halves because it is the one byte a path cannot hold. */
function contentKey(path: NotePath, hash: ContentHash): string {
  return `${path}\0${hash}`
}
