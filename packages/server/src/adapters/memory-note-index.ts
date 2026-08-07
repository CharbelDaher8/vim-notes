/**
 * NoteIndex held in memory, derived from the markdown and nothing else.
 *
 * There is no persistence here on purpose. Every task, reminder and link is
 * `parseNoteMarkup` run over a file the user could equally have written in vim,
 * so a TODO typed in nvim in the pty reaches the panel without nvim knowing this
 * app exists (DECISIONS.md §1), and throwing the whole index away costs one walk
 * of the tree. Nothing a user could lose lives in this class.
 *
 * Two properties shape the implementation:
 *
 *   1. **A save must not re-read the world.** The first build walks `tree()` and
 *      reads every note; after that a watcher event re-reads exactly the path
 *      that changed. With two thousand notes the difference is between a panel
 *      that updates instantly and one that stalls on every keystroke pause.
 *   2. **Everything derived is keyed by path.** Deleting a note drops its
 *      annotations, its links and its graph nodes in one step, because they are
 *      only ever reachable through its entry. A ghost todo for a note that no
 *      longer exists is worse than no todo list at all.
 *
 * **It is eventually consistent, and there is no honest way around that.** The
 * index is updated from filesystem events, which the watcher debounces before it
 * reports them, so for a short window after a write `annotations()` describes the
 * note as it was a moment ago. It cannot be otherwise: nvim writes files this
 * process never hears about until the watcher says so. Callers that need
 * read-your-own-write should read the note, not the index. The specific windows
 * are noted at the places that create them.
 */
import {
  journalDateOf,
  notePathBasename,
  notePathExtension,
  parseNoteMarkup,
  parseNotePath,
  type Annotation,
  type AnnotationFilter,
  type AnnotationRecord,
  type BudgetDeclaration,
  type BudgetDeclarationRecord,
  type SpendEntry,
  type SpendFilter,
  type SpendRecord,
  type FileChangeEvent,
  type FileWatcher,
  type GraphEdge,
  type GraphNode,
  type NoteGraph,
  type NoteIndex,
  type NotePath,
  type NoteStore,
  type ResolvedLink,
  type TreeEntry,
  type Unsubscribe,
  type WikiLink,
} from '@vim-notes/core'

import { hashContent } from './content-hash'

export interface MemoryNoteIndexOptions {
  /**
   * Called when a build or an incremental update throws. There is nobody to
   * return these to -- the work was started by an inotify event, not a request
   * -- but swallowing them would hide an index that has quietly stopped
   * tracking the notes while continuing to answer queries confidently.
   */
  onError?: (error: unknown) => void
  /** Notes read at once during a full build. Bounded so a walk cannot exhaust fds. */
  concurrency?: number
}

/**
 * Only markdown is parsed.
 *
 * The store's tree happily contains images and PDFs, and running a four-megabyte
 * PNG through a line-oriented parser is pure waste for a file that is not a note
 * and cannot contain a task. The consequence to be aware of: `[[diagram.png]]`
 * never resolves, because as far as the index is concerned that file does not
 * exist.
 */
const INDEXED_EXTENSIONS = new Set(['md', 'markdown'])

const DEFAULT_CONCURRENCY = 32

/** Enough of a sha256 to identify a task line; see `annotationNodeId`. */
const ID_HASH_LENGTH = 16

interface IndexedNote {
  path: NotePath
  /** From the filename, so a daily joins the graph however it is filed. */
  day: string | null
  annotations: Annotation[]
  links: WikiLink[]
  spends: SpendEntry[]
  budget: BudgetDeclaration[]
  /** Normalised link targets, kept so the reverse index can be undone exactly. */
  targets: Set<string>
}

/**
 * All derived state in one object so a rebuild can swap it in atomically.
 *
 * The alternative -- clearing the maps in place and refilling them -- would let
 * a query run against a half-built index and report that half the notes have no
 * todos, which is indistinguishable from the user having ticked them all off.
 */
interface IndexState {
  notes: Map<NotePath, IndexedNote>
  /** Lowercased basename and stem -> the notes carrying it. Backs `resolve`. */
  byName: Map<string, Set<NotePath>>
  /** Normalised link target -> the notes that write it. Backs `backlinks`. */
  sourcesByTarget: Map<string, Set<NotePath>>
}

export class MemoryNoteIndex implements NoteIndex {
  private state: IndexState = createState()

  /** Resolves when the current build has landed. Queries wait on it. */
  private ready: Promise<void> = Promise.resolve()

  /** The build in flight, or null. Non-null means events must be deferred. */
  private building: Promise<void> | null = null

  /**
   * Paths that changed while a build was walking. Their updates were applied to
   * the state that build is about to replace, so they have to be redone.
   */
  private readonly missed = new Set<NotePath>()

  /**
   * Latest update token per path. Two reads of one note can be in flight at
   * once and can finish in either order; without this the older content wins
   * whenever it happens to land second.
   */
  private readonly revisions = new Map<NotePath, number>()
  private sequence = 0

  private readonly unsubscribe: Unsubscribe
  private readonly onError: (error: unknown) => void
  private readonly concurrency: number
  private closed = false

  constructor(
    private readonly store: NoteStore,
    watcher: FileWatcher,
    options: MemoryNoteIndexOptions = {},
  ) {
    this.onError = options.onError ?? ((error) => console.error('[note-index]', error))
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)

    // Subscribed before the first build starts, so a note written during the
    // walk is deferred rather than lost.
    this.unsubscribe = watcher.subscribe((event) => this.onChange(event))

    void this.rebuild().catch((error: unknown) => this.onError(error))
  }

  /** Construct and wait for the first build, for a composition root that can await. */
  static async start(
    store: NoteStore,
    watcher: FileWatcher,
    options: MemoryNoteIndexOptions = {},
  ): Promise<MemoryNoteIndex> {
    const index = new MemoryNoteIndex(store, watcher, options)
    await index.ready
    return index
  }

  /** Stop tracking changes. The index keeps answering from what it last knew. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
  }

  async annotations(filter: AnnotationFilter = {}): Promise<AnnotationRecord[]> {
    await this.ready

    const records: AnnotationRecord[] = []

    for (const note of this.state.notes.values()) {
      // Checked once per note rather than once per annotation: a day filter
      // over a journal is the common query and most notes fail it outright.
      if (filter.day !== undefined && note.day !== filter.day) continue

      for (const annotation of note.annotations) {
        if (filter.kind !== undefined && annotation.kind !== filter.kind) continue

        // `done: null` is "no checkbox", which is not the same as ticked -- see
        // the three-state note on Annotation. Hiding it here would make a plain
        // `TODO buy milk` disappear from the list that exists to show it.
        if (filter.includeDone === false && annotation.done === true) continue

        records.push({ ...annotation, path: note.path, day: note.day })
      }
    }

    records.sort(compareAnnotations)

    return filter.limit === undefined ? records : records.slice(0, filter.limit)
  }

  async spends(filter: SpendFilter = {}): Promise<SpendRecord[]> {
    await this.ready

    const records: SpendRecord[] = []
    const bounded = filter.since !== undefined || filter.until !== undefined

    for (const note of this.state.notes.values()) {
      for (const entry of note.spends) {
        // The line's own date wins over the note's day, so a spend logged late
        // counts on the day it happened rather than the day it was written up.
        const on = entry.date ?? note.day

        if (on === null) {
          // Undated money is real money. It only drops out when a range was
          // asked for, because it belongs to no month and cannot honestly be
          // put in one -- see the note on SpendFilter.
          if (bounded) continue
        } else {
          if (filter.since !== undefined && on < filter.since) continue
          if (filter.until !== undefined && on > filter.until) continue
        }

        if (filter.category !== undefined && entry.category !== filter.category) continue

        records.push({ ...entry, path: note.path, day: note.day, on })
      }
    }

    records.sort(compareSpends)

    return filter.limit === undefined ? records : records.slice(0, filter.limit)
  }

  async budgetDeclarations(): Promise<BudgetDeclarationRecord[]> {
    await this.ready

    const records: BudgetDeclarationRecord[] = []

    for (const note of this.state.notes.values()) {
      for (const declaration of note.budget) records.push({ ...declaration, path: note.path })
    }

    records.sort(compareDeclarations)

    return records
  }

  async backlinks(path: NotePath): Promise<ResolvedLink[]> {
    await this.ready

    // Only a handful of spellings can name a given note, so the reverse index
    // is asked about those rather than every note being scanned for links. The
    // buckets are candidates, not answers: `[[roadmap]]` lands in this note's
    // bucket and still resolves to null while a second roadmap.md exists, so
    // every candidate is confirmed by re-resolving it.
    const sources = new Set<NotePath>()
    for (const key of targetKeysFor(path)) {
      for (const source of this.state.sourcesByTarget.get(key) ?? []) sources.add(source)
    }

    const found: ResolvedLink[] = []

    for (const source of sources) {
      const note = this.state.notes.get(source)
      if (note === undefined) continue

      for (const link of note.links) {
        if (this.resolveNow(link.target) !== path) continue
        found.push({
          from: source,
          to: path,
          target: link.target,
          label: link.label,
          line: link.line,
        })
      }
    }

    return found.sort(compareLinks)
  }

  async outboundLinks(path: NotePath): Promise<ResolvedLink[]> {
    await this.ready

    const note = this.state.notes.get(path)
    if (note === undefined) return []

    // Unresolved links are returned with `to: null` rather than dropped. A link
    // to a note that has not been written yet is a normal state in a journal,
    // and the panel has to be able to show it as missing.
    return note.links.map((link) => ({
      from: path,
      to: this.resolveNow(link.target),
      target: link.target,
      label: link.label,
      line: link.line,
    }))
  }

  async graph(): Promise<NoteGraph> {
    await this.ready

    const nodes = new Map<string, GraphNode>()
    const edges = new Map<string, GraphEdge>()

    const addEdge = (from: string, to: string, kind: GraphEdge['kind']): void => {
      // Keyed, because two wikilinks to the same note on different lines are one
      // relationship. Drawn twice they are two lines on top of each other and a
      // doubled edge weight in any force layout.
      edges.set(`${kind}\u0000${from}\u0000${to}`, { from, to, kind })
    }

    for (const note of this.state.notes.values()) {
      const noteId = noteNodeId(note.path)

      nodes.set(noteId, {
        id: noteId,
        kind: 'note',
        label: noteLabel(note.path),
        path: note.path,
        line: null,
        day: note.day,
        done: null,
      })

      if (note.day !== null) {
        const dayId = dayNodeId(note.day)

        // The day is its own node rather than the daily note wearing two hats.
        // Two notes can name one day -- `journal/2026-08-02.md` and
        // `archive/2026-08-02.md` -- and a day that is also a note would then
        // have to pick one of them, which is a choice with no right answer.
        nodes.set(dayId, {
          id: dayId,
          kind: 'day',
          label: note.day,
          path: null,
          line: null,
          day: note.day,
          done: null,
        })
        addEdge(noteId, dayId, 'day')
      }

      const occurrences = new Map<string, number>()

      for (const annotation of note.annotations) {
        const id = annotationNodeId(note.path, annotation, occurrences)

        nodes.set(id, {
          id,
          kind: annotation.kind,
          label: annotation.text,
          path: note.path,
          // The one field here that is *not* stable across an edit, and that is
          // the point of it being a field: inserting a line above a task moves
          // its line while its id stays put, so the layout holds and the jump
          // target still lands on the right row.
          line: annotation.line,
          day: note.day,
          done: annotation.done,
        })

        addEdge(noteId, id, 'contains')

        // The day it was written on, not the day it is due. `due` is a property
        // of the task; the graph question is "what was I doing that day".
        if (note.day !== null) addEdge(id, dayNodeId(note.day), 'day')
      }

      for (const link of note.links) {
        const target = this.resolveNow(link.target)

        if (target !== null) {
          addEdge(noteId, noteNodeId(target), 'link')
          continue
        }

        // A placeholder node, so the edge has both ends. Every graph library
        // either drops or throws on an edge to an id it has never seen, and
        // dropping it is precisely what the 'unresolved' kind exists to
        // prevent: a link to a note that does not exist yet has to be visibly
        // missing rather than silently absent.
        //
        // An ambiguous target arrives here too. It is a different problem --
        // two roadmap.md rather than none -- but the same thing is true of it:
        // the link goes nowhere and the user should be able to see that.
        const missingId = missingNodeId(link.target)
        if (!nodes.has(missingId)) {
          nodes.set(missingId, {
            id: missingId,
            kind: 'note',
            // The normalised target, not this link's alias. Several notes can
            // link the same missing name with different aliases, and a label
            // taken from whichever was walked first would change when an
            // unrelated note was saved.
            label: normaliseTarget(link.target),
            path: null,
            // Deliberately null even though the link was written on a line.
            // Several notes can link the same missing name, so there is no one
            // line this node points at, and picking the first one walked would
            // send a click to an unrelated note.
            line: null,
            day: null,
            done: null,
          })
        }
        addEdge(noteId, missingId, 'unresolved')
      }
    }

    // Sorted rather than left in map order. Incremental updates re-insert a
    // changed note at the end of the map, so without this a rebuilt index would
    // return the same graph in a different order -- and "delete the index and
    // rebuild" would stop being the no-op the port promises it is.
    return {
      nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
      edges: [...edges.values()].sort(compareEdges),
    }
  }

  async resolve(target: string): Promise<NotePath | null> {
    await this.ready
    return this.resolveNow(target)
  }

  rebuild(): Promise<void> {
    // One walk at a time. A second concurrent walk would race the first's swap,
    // and whichever finished second would discard the notes the other had
    // already collected the missed-path set for.
    this.building ??= this.runBuild()

    const attempt = this.building

    // Queries wait for the build but must not inherit its failure. An index
    // that failed to build is empty, not broken, and a `graph()` that rejects
    // forever afterwards would take the whole panel down with it. The caller of
    // rebuild() still gets the rejection, which is the point of a manual
    // rebuild being the recovery path.
    this.ready = attempt.catch(() => {})

    return attempt
  }

  private async runBuild(): Promise<void> {
    this.missed.clear()

    try {
      const next = createState()
      const paths = indexablePaths(await this.store.tree())

      // Batched rather than one enormous Promise.all: two thousand concurrent
      // opens is a good way to hit the file descriptor limit, and the walk is
      // not the latency-sensitive path anyway.
      for (let start = 0; start < paths.length; start += this.concurrency) {
        const batch = paths.slice(start, start + this.concurrency)

        const documents = await Promise.all(
          batch.map(async (path) => ({ path, document: await this.store.read(path) })),
        )

        for (const { path, document } of documents) {
          // Null means it was deleted between the walk and the read. Leaving it
          // out is correct; the watcher event for the deletion will also arrive
          // and find nothing to remove.
          if (document !== null) put(next, path, document.content)
        }
      }

      // Until this line queries still see the previous state, complete and
      // slightly stale, rather than a partially filled one.
      this.state = next

      // Any refresh still in flight is abandoned by this, which is what we
      // want: it started before the walk did, so the walk's read of that file
      // is the newer one. It also keeps the map from growing across the
      // lifetime of the process.
      this.revisions.clear()
    } finally {
      this.building = null
    }

    // Changes that landed during the walk were applied to the state just
    // discarded, so they are redone against the new one. There are only as many
    // of these as the user managed to save while the walk was running.
    const redo = [...this.missed]
    this.missed.clear()

    await Promise.all(redo.map((path) => this.refresh(path)))
  }

  private onChange(event: FileChangeEvent): void {
    if (this.closed) return
    if (!isIndexable(event.path)) return

    if (this.building !== null) {
      this.missed.add(event.path)
      return
    }

    void this.refresh(event.path).catch((error: unknown) => this.onError(error))
  }

  /**
   * Re-read one note and replace what is known about it.
   *
   * Deletions are not handled separately: the file is read and its absence is
   * what removes the entry. That follows the watcher's own rule that the raw
   * event sequence lies -- a rename is reported as a delete and a create, and
   * an editor's atomic save briefly looks like a deletion. Deciding from the
   * file's actual state means a rename lands as one entry moving rather than
   * two entries, in whichever order the two events arrive.
   */
  private async refresh(path: NotePath): Promise<void> {
    const token = ++this.sequence
    this.revisions.set(path, token)

    try {
      const document = await this.store.read(path)

      // A newer refresh for this path started while this read was in flight.
      // Its answer is the fresher one and applying ours would undo it.
      if (this.revisions.get(path) !== token) return

      if (document === null) forget(this.state, path)
      else put(this.state, path, document.content)
    } finally {
      if (this.revisions.get(path) === token) this.revisions.delete(path)
    }
  }

  /**
   * The synchronous half of `resolve`, so the query methods can use it without
   * awaiting readiness once per link.
   */
  private resolveNow(target: string): NotePath | null {
    const cleaned = cleanTarget(target)
    if (cleaned === '') return null

    // An exact path wins outright. Case-sensitive, because the store is: on the
    // filesystem this deploys to, `Roadmap.md` and `roadmap.md` are two notes.
    // `parseNotePath` is what stops `[[../../.ssh/id_rsa]]` naming anything --
    // the index is derived from user-authored text like everything else here.
    const direct = parseNotePath(cleaned)
    if (direct.ok) {
      if (this.state.notes.has(direct.value)) return direct.value

      // `[[projects/roadmap]]` is how a path link is written by hand; the
      // extension is implied.
      const completed = parseNotePath(`${cleaned}.md`)
      if (completed.ok && this.state.notes.has(completed.value)) return completed.value
    }

    // Then a unique basename, matched case-insensitively -- nobody capitalises
    // a wikilink the same way they named the file.
    const candidates = this.state.byName.get(cleaned.toLowerCase())
    if (candidates === undefined || candidates.size !== 1) return null

    // size === 1, so the iterator yields exactly one path.
    for (const candidate of candidates) return candidate
    return null
  }
}

// --- State mutation ----------------------------------------------------------

function createState(): IndexState {
  return { notes: new Map(), byName: new Map(), sourcesByTarget: new Map() }
}

function put(state: IndexState, path: NotePath, content: string): void {
  // Removed first so the secondary indexes never keep a stale bucket entry for
  // a link the note used to have and no longer does.
  forget(state, path)

  const markup = parseNoteMarkup(content)
  const targets = new Set(markup.links.map((link) => normaliseTarget(link.target)))

  state.notes.set(path, {
    path,
    day: journalDateOf(path),
    annotations: markup.annotations,
    links: markup.links,
    spends: markup.spends,
    budget: markup.budget,
    targets,
  })

  for (const key of nameKeysFor(path)) addTo(state.byName, key, path)
  for (const target of targets) addTo(state.sourcesByTarget, target, path)
}

function forget(state: IndexState, path: NotePath): void {
  const existing = state.notes.get(path)
  if (existing === undefined) return

  state.notes.delete(path)

  for (const key of nameKeysFor(path)) removeFrom(state.byName, key, path)
  for (const target of existing.targets) removeFrom(state.sourcesByTarget, target, path)
}

function addTo(buckets: Map<string, Set<NotePath>>, key: string, path: NotePath): void {
  const bucket = buckets.get(key)
  if (bucket === undefined) buckets.set(key, new Set([path]))
  else bucket.add(path)
}

function removeFrom(buckets: Map<string, Set<NotePath>>, key: string, path: NotePath): void {
  const bucket = buckets.get(key)
  if (bucket === undefined) return

  bucket.delete(path)

  // Pruned rather than left empty. An empty bucket is not just waste: it would
  // make `resolve` see size 0 where it should see a missing key, and it would
  // grow without bound in a directory that is renamed often.
  if (bucket.size === 0) buckets.delete(key)
}

// --- Paths -------------------------------------------------------------------

function indexablePaths(entries: readonly TreeEntry[]): NotePath[] {
  const paths: NotePath[] = []

  const walk = (nodes: readonly TreeEntry[]): void => {
    for (const entry of nodes) {
      if (entry.kind === 'directory') walk(entry.children)
      else if (isIndexable(entry.path)) paths.push(entry.path)
    }
  }

  walk(entries)
  return paths
}

function isIndexable(path: NotePath): boolean {
  return INDEXED_EXTENSIONS.has(notePathExtension(path))
}

/** `notes/Roadmap.md` -> `roadmap.md` and `roadmap`, both of which may be written. */
function nameKeysFor(path: NotePath): string[] {
  const basename = notePathBasename(path).toLowerCase()
  const stem = stemOf(basename)

  return stem === basename ? [basename] : [basename, stem]
}

/**
 * Every normalised spelling that could name this note, for the reverse lookup in
 * `backlinks`. Must agree with `normaliseTarget`, or a link written one way
 * lands in a bucket the lookup never asks about.
 */
function targetKeysFor(path: NotePath): Set<string> {
  const lower = path.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const directory = slash === -1 ? '' : lower.slice(0, slash + 1)
  const basename = lower.slice(slash + 1)
  const stem = stemOf(basename)

  // The extension is stripped from the basename rather than from the whole
  // path, so a directory with a dot in its name -- `refs.old/roadmap` -- does
  // not have its own name truncated instead.
  return new Set([lower, `${directory}${stem}`, basename, stem])
}

/** Trimmed and tidied, but not case-folded: the exact-path lookup needs the case. */
function cleanTarget(target: string): string {
  return target
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
}

function normaliseTarget(target: string): string {
  return cleanTarget(target).toLowerCase()
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // `dot <= 0` leaves a dotfile alone: `.gitignore` has no extension to strip.
  return dot <= 0 ? name : name.slice(0, dot)
}

function noteLabel(path: NotePath): string {
  return stemOf(notePathBasename(path))
}

// --- Node ids ----------------------------------------------------------------
//
// Ids have to survive a rebuild unchanged, because a graph layout is keyed by
// them: an id that moves makes every node it touches spring to a new position
// the moment a note is saved. They must therefore be a function of the content
// and nothing else -- no counters, no insertion order, no timestamps.

function noteNodeId(path: NotePath): string {
  return `note:${path}`
}

function dayNodeId(day: string): string {
  return `day:${day}`
}

function missingNodeId(target: string): string {
  return `missing:${normaliseTarget(target)}`
}

/**
 * Identified by its text rather than its line number.
 *
 * A line number is stable across a rebuild but not across an edit, and inserting
 * one line at the top of a daily would renumber every task under it -- so the
 * whole day's subgraph would be torn down and rebuilt with new ids on a
 * keystroke. The text is what makes a task that task to the person reading it.
 *
 * Hashed rather than embedded because a task line can be a paragraph, and these
 * ids travel to the browser once per node.
 *
 * The same text twice in one note gets an occurrence suffix. Deleting the first
 * of those does move the second's id; it is the one case with no fixed point,
 * and it is rarer than the line-number problem it replaces.
 */
function annotationNodeId(
  path: NotePath,
  annotation: Annotation,
  occurrences: Map<string, number>,
): string {
  const key = `${annotation.kind}:${path}:${hashContent(annotation.text).slice(0, ID_HASH_LENGTH)}`

  const seen = occurrences.get(key) ?? 0
  occurrences.set(key, seen + 1)

  return seen === 0 ? key : `${key}:${seen}`
}

// --- Ordering ----------------------------------------------------------------

/**
 * Newest day first, undated notes last, then by path and line.
 *
 * Not arbitrary: `limit` takes the first N, and with paths sorted ascending a
 * journal named by date would hand back the oldest tasks in the repository as
 * "the first twenty todos". Deterministic throughout, so a rebuilt index returns
 * the same list in the same order.
 */
function compareAnnotations(a: AnnotationRecord, b: AnnotationRecord): number {
  if (a.day !== b.day) {
    if (a.day === null) return 1
    if (b.day === null) return -1
    return compareStrings(b.day, a.day)
  }

  const byPath = compareStrings(a.path, b.path)
  return byPath !== 0 ? byPath : a.line - b.line
}

/**
 * Newest first, undated last, then by path and line -- the same shape as
 * `compareAnnotations` and for the same reason: `limit` takes the first N, and
 * "the last twenty things I spent money on" is the only useful reading of that.
 */
function compareSpends(a: SpendRecord, b: SpendRecord): number {
  if (a.on !== b.on) {
    if (a.on === null) return 1
    if (b.on === null) return -1
    return compareStrings(b.on, a.on)
  }

  const byPath = compareStrings(a.path, b.path)
  return byPath !== 0 ? byPath : a.line - b.line
}

/** Document order. The fold decides which declaration wins, not this. */
function compareDeclarations(a: BudgetDeclarationRecord, b: BudgetDeclarationRecord): number {
  const byPath = compareStrings(a.path, b.path)
  return byPath !== 0 ? byPath : a.line - b.line
}

function compareLinks(a: ResolvedLink, b: ResolvedLink): number {
  const byPath = compareStrings(a.from, b.from)
  return byPath !== 0 ? byPath : a.line - b.line
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const byFrom = compareStrings(a.from, b.from)
  if (byFrom !== 0) return byFrom

  const byTo = compareStrings(a.to, b.to)
  return byTo !== 0 ? byTo : compareStrings(a.kind, b.kind)
}

/** Code-unit order, not locale order: this has to be identical on every machine. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
