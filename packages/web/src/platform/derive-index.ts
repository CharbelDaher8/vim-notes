/**
 * The derived index -- annotations, backlinks, the graph -- computed from the
 * markdown in the browser.
 *
 * This exists so `InMemoryPlatform` is a real platform rather than a fixture.
 * It runs core's `parseNoteMarkup`, the same parser the server indexes with, so
 * the offline UI is answering the same question the real one does instead of
 * agreeing with a plausible-looking mock. When the panel is wrong here, it is
 * wrong there too, which is the only version of this worth having.
 *
 * It is therefore written to match `MemoryNoteIndex` in the server package
 * decision for decision -- sort order, node ids, what a label is, which day an
 * annotation hangs off -- because a UI that behaves differently offline is a UI
 * that has to be debugged twice. Where the two deliberately differ, and there
 * is exactly one place, it is called out at `annotationNodeId` below.
 *
 * The structure differs completely, though, and should: the server's index is
 * incremental because it is fed by a watcher over a repository. This one
 * recomputes from scratch on every call, which is affordable at the few hundred
 * notes a dev fixture holds and keeps the whole file free of cache invalidation.
 */
import {
  journalDateOf,
  notePathBasename,
  notePathExtension,
  parseNoteMarkup,
  type Annotation,
  type AnnotationFilter,
  type AnnotationRecord,
  type BudgetDeclarationRecord,
  type SpendFilter,
  type SpendRecord,
  type GraphEdge,
  type GraphNode,
  type NoteGraph,
  type NotePath,
  type ResolvedLink,
} from '@vim-notes/core'

import { resolveWikiTarget } from '../shared/wikilinks'
import { hashContent } from './content-hash'

/** Matches the server's `INDEXED_EXTENSIONS`; a PNG holds no tasks. */
const INDEXED_EXTENSIONS = new Set(['md', 'markdown'])

export interface IndexedNote {
  path: NotePath
  content: string
}

export function isIndexable(path: NotePath): boolean {
  return INDEXED_EXTENSIONS.has(notePathExtension(path))
}

export function deriveAnnotations(
  notes: readonly IndexedNote[],
  filter: AnnotationFilter = {},
): AnnotationRecord[] {
  const records: AnnotationRecord[] = []

  for (const note of notes) {
    const day = journalDateOf(note.path)
    if (filter.day !== undefined && day !== filter.day) continue

    for (const annotation of parseNoteMarkup(note.content).annotations) {
      if (filter.kind !== undefined && annotation.kind !== filter.kind) continue

      // `done: null` is "no checkbox", which is not the same as ticked. Hiding
      // it would make a plain `TODO buy milk` disappear from the list that
      // exists to show it.
      if (filter.includeDone === false && annotation.done === true) continue

      records.push({ ...annotation, path: note.path, day })
    }
  }

  records.sort(compareAnnotations)

  return filter.limit === undefined ? records : records.slice(0, filter.limit)
}

/** Matches `MemoryNoteIndex.spends` decision for decision; see the file header. */
export function deriveSpends(
  notes: readonly IndexedNote[],
  filter: SpendFilter = {},
): SpendRecord[] {
  const records: SpendRecord[] = []
  const bounded = filter.since !== undefined || filter.until !== undefined

  for (const note of notes) {
    const day = journalDateOf(note.path)

    for (const entry of parseNoteMarkup(note.content).spends) {
      // The line's own date wins over the note's day, so a spend logged late
      // counts on the day it happened rather than the day it was written up.
      const on = entry.date ?? day

      if (on === null) {
        // Undated money is real money. It only drops out when a range was asked
        // for, because it belongs to no month and cannot honestly be put in one.
        if (bounded) continue
      } else {
        if (filter.since !== undefined && on < filter.since) continue
        if (filter.until !== undefined && on > filter.until) continue
      }

      if (filter.category !== undefined && entry.category !== filter.category) continue

      records.push({ ...entry, path: note.path, day, on })
    }
  }

  records.sort(compareSpends)

  return filter.limit === undefined ? records : records.slice(0, filter.limit)
}

export function deriveBudgetDeclarations(notes: readonly IndexedNote[]): BudgetDeclarationRecord[] {
  const records: BudgetDeclarationRecord[] = []

  for (const note of notes) {
    for (const declaration of parseNoteMarkup(note.content).budget) {
      records.push({ ...declaration, path: note.path })
    }
  }

  return records.sort(compareDeclarations)
}

export function deriveBacklinks(notes: readonly IndexedNote[], path: NotePath): ResolvedLink[] {
  const paths = notes.map((note) => note.path)
  const found: ResolvedLink[] = []

  for (const note of notes) {
    for (const link of parseNoteMarkup(note.content).links) {
      if (resolveWikiTarget(paths, link.target) !== path) continue

      found.push({
        from: note.path,
        to: path,
        target: link.target,
        label: link.label,
        line: link.line,
      })
    }
  }

  return found.sort(compareLinks)
}

export function deriveOutboundLinks(notes: readonly IndexedNote[], path: NotePath): ResolvedLink[] {
  const note = notes.find((candidate) => candidate.path === path)
  if (note === undefined) return []

  const paths = notes.map((candidate) => candidate.path)

  // Unresolved links come back with `to: null` rather than being dropped: a
  // link to a note that has not been written yet is a normal state.
  return parseNoteMarkup(note.content).links.map((link) => ({
    from: path,
    to: resolveWikiTarget(paths, link.target),
    target: link.target,
    label: link.label,
    line: link.line,
  }))
}

export function deriveGraph(notes: readonly IndexedNote[]): NoteGraph {
  const paths = notes.map((note) => note.path)
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  const addEdge = (from: string, to: string, kind: GraphEdge['kind']) => {
    // Keyed, because two wikilinks to the same note on different lines are one
    // relationship. Drawn twice they are two lines on top of each other and a
    // doubled edge weight in any force layout.
    edges.set(`${kind}\u0000${from}\u0000${to}`, { from, to, kind })
  }

  for (const note of notes) {
    const day = journalDateOf(note.path)
    const noteId = `note:${note.path}`

    nodes.set(noteId, {
      id: noteId,
      kind: 'note',
      label: stemOf(notePathBasename(note.path)),
      path: note.path,
      line: null,
      day,
      done: null,
    })

    if (day !== null) {
      const dayId = `day:${day}`

      // The day is its own node rather than the daily note wearing two hats:
      // two notes can name one day, and a day that is also a note would have to
      // pick one of them.
      nodes.set(dayId, {
        id: dayId,
        kind: 'day',
        label: day,
        path: null,
        line: null,
        day,
        done: null,
      })
      addEdge(noteId, dayId, 'day')
    }

    const markup = parseNoteMarkup(note.content)
    const occurrences = new Map<string, number>()

    for (const annotation of markup.annotations) {
      const id = annotationNodeId(note.path, annotation, occurrences)

      nodes.set(id, {
        id,
        kind: annotation.kind,
        label: annotation.text,
        path: note.path,
        // The line is carried here rather than in the id, so that inserting a
        // line above a task does not change its identity and spring the layout.
        line: annotation.line,
        day,
        done: annotation.done,
      })

      addEdge(noteId, id, 'contains')

      // The day it was written on, not the day it is due. `due` is a property
      // of the task; the graph question is "what was I doing that day".
      if (day !== null) addEdge(id, `day:${day}`, 'day')
    }

    for (const link of markup.links) {
      const resolved = resolveWikiTarget(paths, link.target)

      if (resolved !== null) {
        addEdge(noteId, `note:${resolved}`, 'link')
        continue
      }

      // A placeholder, so the edge has both ends: every graph library either
      // drops or throws on an edge to an id it has never seen, and dropping it
      // is precisely what the 'unresolved' kind exists to prevent.
      const missingId = `missing:${normaliseTarget(link.target)}`

      if (!nodes.has(missingId)) {
        nodes.set(missingId, {
          id: missingId,
          kind: 'note',
          // The normalised target, not this link's alias: several notes can
          // link the same missing name with different aliases, and a label
          // taken from whichever came first would change when an unrelated
          // note was saved.
          label: normaliseTarget(link.target),
          path: null,
          line: null,
          day: null,
          done: null,
        })
      }

      addEdge(noteId, missingId, 'unresolved')
    }
  }

  // Sorted rather than left in insertion order, so that rebuilding the index
  // returns the same graph and "delete it and rebuild" stays the no-op the port
  // promises it is.
  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: [...edges.values()].sort(compareEdges),
  }
}

/**
 * Identified by its text rather than its line number, so that inserting a line
 * at the top of a daily does not renumber -- and so tear down and rebuild --
 * every task under it. The same text twice in one note gets an occurrence
 * suffix.
 *
 * The one deliberate divergence from the server: the digest is the client's
 * cheap FNV hash rather than sha256, so the ids are stable and content-derived
 * but not byte-identical to the server's for the same note. Nothing compares
 * ids across the two -- a graph is laid out from one index at a time -- and
 * pulling `node:crypto`'s replacement into the bundle to make two dev fixtures
 * agree would be a poor trade.
 */
function annotationNodeId(
  path: NotePath,
  annotation: Annotation,
  occurrences: Map<string, number>,
): string {
  const key = `${annotation.kind}:${path}:${hashContent(annotation.text)}`

  const seen = occurrences.get(key) ?? 0
  occurrences.set(key, seen + 1)

  return seen === 0 ? key : `${key}:${seen}`
}

function normaliseTarget(target: string): string {
  return target
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/** Newest day first, undated notes last, then by path and line. */
function compareAnnotations(a: AnnotationRecord, b: AnnotationRecord): number {
  if (a.day !== b.day) {
    if (a.day === null) return 1
    if (b.day === null) return -1
    return compareStrings(b.day, a.day)
  }

  const byPath = compareStrings(a.path, b.path)
  return byPath !== 0 ? byPath : a.line - b.line
}

/** Newest first, undated last, then path and line -- as `compareAnnotations`. */
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
