/**
 * A complete `Platform` with no server behind it.
 *
 * This is not a mock in the "returns canned values" sense -- it enforces the
 * same optimistic-concurrency rule as the real store by calling core's
 * `decideWriteOrForce`, so the conflict UI can be developed and tested against
 * it and will behave identically against the filesystem adapter. The two
 * simulate* methods exist because the interesting cases in this app are all
 * *someone else wrote the file*, and without a way to provoke that on demand,
 * the conflict and reconcile paths would only ever be exercised by accident.
 */
import {
  assertNotePath,
  decideWriteOrForce,
  journalPathFor,
  notePathBasename,
  notePathContains,
  notePathParent,
  parseNotePath,
  type AnnotationFilter,
  type AnnotationRecord,
  type ChangeOrigin,
  type ContentHash,
  type ExpectedVersion,
  type FileChangeEvent,
  type FileChangeKind,
  type ForceWrite,
  type NewsItem,
  type NoteDocument,
  type NoteGraph,
  type NoteMetadata,
  type NotePath,
  type ResolvedLink,
  type SearchHit,
  type SearchQuery,
  type TreeEntry,
  type Unsubscribe,
  type WriteOutcome,
} from '@vim-notes/core'

import { byteLength, hashContent } from './content-hash'
import {
  deriveAnnotations,
  deriveBacklinks,
  deriveGraph,
  isIndexable,
  type IndexedNote,
} from './derive-index'
import { SEED_NEWS, SEED_NEWS_LAST_RUN } from './in-memory-seed'
import type { NewsClient, Platform } from './platform'
import { documentHost } from './document-host'

interface FileRecord {
  content: string
  hash: ContentHash
  modifiedAt: number
}

export interface InMemoryPlatformOptions {
  /** Path -> content. Parent directories are implied. */
  files?: Record<string, string>
  /** Artificial round-trip delay, so loading states are visible in dev. */
  latencyMs?: number
  now?: () => number
}

export class InMemoryPlatform implements Platform {
  readonly id = 'in-memory' as const
  readonly host = documentHost

  readonly #files = new Map<NotePath, FileRecord>()
  /** Directories with no files under them; the rest are derived from paths. */
  readonly #emptyDirectories = new Set<NotePath>()
  readonly #listeners = new Set<(event: FileChangeEvent) => void>()
  readonly #latencyMs: number
  readonly #now: () => number

  constructor(options: InMemoryPlatformOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0
    this.#now = options.now ?? (() => Date.now())

    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.#put(asPath(path), content)
    }
  }

  async tree(): Promise<TreeEntry[]> {
    await this.#settle()
    return buildTree(this.#files, this.#emptyDirectories)
  }

  async read(path: NotePath): Promise<NoteDocument | null> {
    await this.#settle()

    const record = this.#files.get(path)
    if (record === undefined) return null

    return { ...metadataOf(path, record), content: record.content }
  }

  async write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome> {
    await this.#settle()

    if (this.#isDirectory(path)) {
      throw new Error(`${path} is a directory`)
    }

    const existing = this.#files.get(path)
    const decision = decideWriteOrForce(expected, existing?.hash ?? null)

    if (!decision.ok) {
      return {
        ok: false,
        conflict: decision.conflict,
        actual: existing === undefined ? null : metadataOf(path, existing),
      }
    }

    const record = this.#put(path, content)
    this.#emit(existing === undefined ? 'created' : 'modified', path, record.hash, 'api')

    return { ok: true, metadata: metadataOf(path, record) }
  }

  async move(from: NotePath, to: NotePath): Promise<void> {
    await this.#settle()

    if (this.#files.has(to) || this.#isDirectory(to)) {
      throw new Error(`${to} already exists`)
    }

    const file = this.#files.get(from)

    if (file !== undefined) {
      this.#files.delete(from)
      this.#files.set(to, file)
      this.#emit('deleted', from, null, 'api')
      this.#emit('created', to, file.hash, 'api')
      return
    }

    if (!this.#isDirectory(from)) {
      throw new Error(`${from} does not exist`)
    }

    for (const [path, record] of [...this.#files]) {
      if (!notePathContains(from, path)) continue

      const moved = asPath(`${to}${path.slice(from.length)}`)
      this.#files.delete(path)
      this.#files.set(moved, record)
      this.#emit('deleted', path, null, 'api')
      this.#emit('created', moved, record.hash, 'api')
    }

    if (this.#emptyDirectories.delete(from)) this.#emptyDirectories.add(to)
  }

  async remove(path: NotePath): Promise<void> {
    await this.#settle()

    if (this.#files.delete(path)) {
      this.#emit('deleted', path, null, 'api')
      return
    }

    for (const candidate of [...this.#files.keys()]) {
      if (!notePathContains(path, candidate)) continue
      this.#files.delete(candidate)
      this.#emit('deleted', candidate, null, 'api')
    }

    this.#emptyDirectories.delete(path)

    for (const directory of [...this.#emptyDirectories]) {
      if (notePathContains(path, directory)) this.#emptyDirectories.delete(directory)
    }
  }

  async createDirectory(path: NotePath): Promise<void> {
    await this.#settle()

    if (this.#files.has(path)) throw new Error(`${path} is a file`)

    this.#emptyDirectories.add(path)
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    await this.#settle()

    const limit = query.limit ?? 100
    const matcher = compileMatcher(query)
    const hits: SearchHit[] = []

    // Sorted so results are stable between runs; ripgrep on the server walks
    // the tree in directory order, which is close enough to the same thing.
    for (const path of [...this.#files.keys()].sort()) {
      if (query.under !== undefined && !notePathContains(query.under, path)) continue

      const record = this.#files.get(path)
      if (record === undefined) continue

      const lines = record.content.split('\n')

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const column = matcher(line)
        if (column < 0) continue

        hits.push({ path, line: index + 1, column: column + 1, preview: line.trim().slice(0, 240) })
        if (hits.length >= limit) return hits
      }
    }

    return hits
  }

  subscribeToChanges(listener: (event: FileChangeEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // --- Derived views ---------------------------------------------------------
  // Computed with core's parser rather than canned, so the panels behave the
  // same offline as they do against the server index. See derive-index.ts.

  async annotations(filter?: AnnotationFilter): Promise<AnnotationRecord[]> {
    await this.#settle()
    return deriveAnnotations(this.#notes(), filter)
  }

  async backlinks(path: NotePath): Promise<ResolvedLink[]> {
    await this.#settle()
    return deriveBacklinks(this.#notes(), path)
  }

  async graph(): Promise<NoteGraph> {
    await this.#settle()
    return deriveGraph(this.#notes())
  }

  /**
   * A feed with no aggregator behind it.
   *
   * Seeded rather than empty, and available rather than not, because this is
   * the platform the UI is developed against: a pane that only ever renders
   * "no news service configured" is a pane nobody can lay out. Read and saved
   * state live in memory and reset with the page, which is the same bargain
   * every other dev affordance here makes.
   */
  /** Mutable, because read and saved state are the point of a dev feed. */
  readonly #news: NewsItem[] = SEED_NEWS.map((item) => ({ ...item }))

  readonly news: NewsClient = {
    status: async () => {
      await this.#settle()
      return {
        available: true,
        lastRun: SEED_NEWS_LAST_RUN,
        items: this.#news.length,
        enriched: this.#news.filter((item) => item.score !== null).length,
      }
    },

    list: async (query = {}) => {
      await this.#settle()
      return this.#news
        .filter((item) => query.category === undefined || item.category === query.category)
        .filter((item) => query.unreadOnly !== true || !item.read)
        .filter((item) => query.savedOnly !== true || item.saved)
        .slice(0, query.limit ?? 100)
    },

    setRead: async (id, read) => {
      await this.#settle()
      const item = this.#news.find((candidate) => candidate.id === id)
      if (item !== undefined) item.read = read
    },

    toggleSaved: async (id) => {
      await this.#settle()
      const item = this.#news.find((candidate) => candidate.id === id)
      if (item === undefined) return false
      item.saved = !item.saved
      return item.saved
    },

    /**
     * Writes a real note through the same store the editor uses, so the saved
     * item shows up in the tree, the search and the graph exactly as it would
     * against a server. Formatting deliberately matches the server's
     * `renderItem`; this is the one place in this file that duplicates
     * something, and it is duplicated so that what you see in dev is what you
     * get in production.
     */
    save: async (id, date, path) => {
      await this.#settle()
      const item = this.#news.find((candidate) => candidate.id === id)
      if (item === undefined) throw new Error('that item is no longer in the feed')

      const target =
        path ??
        assertNotePath(
          journalPathFor(
            date,
            this.#notes().map((note) => note.path),
          ),
        )
      const existing = await this.read(target)

      const facts = [
        item.score === null ? null : `score ${item.score}`,
        item.signalLabel === '' ? null : item.signalLabel,
        item.category,
      ].filter((fact): fact is string => fact !== null)

      const block = [
        `- [${item.title}](${item.url}) \u2014 ${item.source}`,
        `  ${facts.join(' \u00b7 ')}`,
        ...(item.summary === null ? [] : [`  > ${item.summary.replace(/\n+/g, ' ')}`]),
      ].join('\n')

      const content =
        existing === null
          ? `# ${date}\n\n${block}\n`
          : `${existing.content.replace(/\s*$/, '')}\n\n${block}\n`

      await this.write(target, content, existing === null ? null : existing.hash)
      item.read = true

      return { path: target, created: existing === null }
    },
  }

  // --- Dev affordances -------------------------------------------------------
  // These have no counterpart on the real platform; they stand in for nvim in
  // a pty writing to the same directory.

  /** Writes without a version check and reports it as someone else's edit. */
  simulateExternalWrite(path: NotePath, content: string, origin: ChangeOrigin = 'terminal'): void {
    const existed = this.#files.has(path)
    const record = this.#put(path, content)
    this.#emit(existed ? 'modified' : 'created', path, record.hash, origin)
  }

  simulateExternalDelete(path: NotePath, origin: ChangeOrigin = 'terminal'): void {
    if (!this.#files.delete(path)) return
    this.#emit('deleted', path, null, origin)
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Only the markdown. A `.png` dropped in the notes directory holds no tasks,
   * and running it through a line parser would put binary noise in the panel.
   * The server's index draws the same line, which is why `[[diagram.png]]`
   * resolves to nothing on both.
   */
  #notes(): IndexedNote[] {
    const notes: IndexedNote[] = []

    for (const [path, record] of this.#files) {
      if (isIndexable(path)) notes.push({ path, content: record.content })
    }

    return notes
  }

  #put(path: NotePath, content: string): FileRecord {
    const record: FileRecord = { content, hash: hashContent(content), modifiedAt: this.#now() }
    this.#files.set(path, record)

    // A directory stops being empty the moment something lands inside it.
    for (const directory of [...this.#emptyDirectories]) {
      if (notePathContains(directory, path)) this.#emptyDirectories.delete(directory)
    }

    return record
  }

  #isDirectory(path: NotePath): boolean {
    if (this.#emptyDirectories.has(path)) return true
    for (const candidate of this.#files.keys()) {
      if (notePathContains(path, candidate)) return true
    }
    return false
  }

  #emit(
    kind: FileChangeKind,
    path: NotePath,
    hash: ContentHash | null,
    origin: ChangeOrigin,
  ): void {
    const event: FileChangeEvent = { kind, path, hash, at: this.#now(), origin }

    // Delivered out of band, the way a socket would deliver it. Firing
    // synchronously inside `write` would let a listener observe the change
    // before the caller has its own result, which no real transport does.
    queueMicrotask(() => {
      for (const listener of [...this.#listeners]) listener(event)
    })
  }

  async #settle(): Promise<void> {
    if (this.#latencyMs <= 0) return
    await new Promise((resolve) => setTimeout(resolve, this.#latencyMs))
  }
}

function metadataOf(path: NotePath, record: FileRecord): NoteMetadata {
  return {
    path,
    hash: record.hash,
    size: byteLength(record.content),
    modifiedAt: record.modifiedAt,
  }
}

function asPath(value: string): NotePath {
  const result = parseNotePath(value)
  if (!result.ok) throw new Error(`invalid seed path: ${value}`)
  return result.value
}

function compileMatcher(query: SearchQuery): (line: string) => number {
  if (query.regex !== true) {
    const needle = query.caseSensitive === true ? query.pattern : query.pattern.toLowerCase()
    return (line) => (query.caseSensitive === true ? line : line.toLowerCase()).indexOf(needle)
  }

  const expression = new RegExp(query.pattern, query.caseSensitive === true ? '' : 'i')
  return (line) => line.search(expression)
}

/**
 * Directories are implied by file paths rather than stored, which matches what
 * a filesystem walk produces and means the seed data is just a path -> content
 * map instead of a nested literal nobody wants to edit.
 */
function buildTree(files: Map<NotePath, FileRecord>, emptyDirectories: Set<NotePath>): TreeEntry[] {
  const directories = new Map<NotePath | null, TreeEntry[]>([[null, []]])

  const ensureDirectory = (path: NotePath): TreeEntry[] => {
    const existing = directories.get(path)
    if (existing !== undefined) return existing

    const children: TreeEntry[] = []
    directories.set(path, children)

    const parent = notePathParent(path)
    const siblings = parent === null ? ensureRoot(directories) : ensureDirectory(parent)
    siblings.push({ kind: 'directory', path, name: notePathBasename(path), children })

    return children
  }

  for (const path of emptyDirectories) ensureDirectory(path)

  for (const [path, record] of files) {
    const parent = notePathParent(path)
    const siblings = parent === null ? ensureRoot(directories) : ensureDirectory(parent)

    siblings.push({
      kind: 'file',
      path,
      name: notePathBasename(path),
      size: byteLength(record.content),
      modifiedAt: record.modifiedAt,
    })
  }

  const root = ensureRoot(directories)
  sortEntries(root)
  return root
}

function ensureRoot(directories: Map<NotePath | null, TreeEntry[]>): TreeEntry[] {
  const root = directories.get(null)
  if (root === undefined) throw new Error('unreachable: root bucket is seeded in the constructor')
  return root
}

/** Directories first, then name-sorted -- the contract on `NoteStore.tree`. */
function sortEntries(entries: TreeEntry[]): void {
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  for (const entry of entries) {
    if (entry.kind === 'directory') sortEntries(entry.children)
  }
}
