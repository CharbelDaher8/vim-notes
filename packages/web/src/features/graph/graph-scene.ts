/**
 * `NoteGraph` turned into something drawable, without touching the DOM.
 *
 * Every decision the picture depends on is made here rather than in JSX: which
 * shape a kind gets, how big it is, how hard its edges pull, what a screen
 * reader is told, and what happens when the graph is bigger than a browser will
 * happily draw. That keeps the component down to "put these shapes at these
 * coordinates", and it means the interesting rules can be tested in a package
 * that has no jsdom.
 *
 * The shape vocabulary is deliberate. Colour is the obvious way to separate
 * four node kinds and the wrong one: roughly one man in twelve cannot tell the
 * common pairings apart, Windows high contrast mode replaces the palette
 * outright, and a printed or thresholded screenshot loses it entirely. So the
 * kinds differ by silhouette first -- circle, ring, square, triangle -- which
 * survives all of that, and colour is a second, redundant channel carrying only
 * three values rather than a rainbow.
 */

import type { GraphEdgeKind, GraphNodeKind, NoteGraph, NotePath } from '@vim-notes/core'

export type NodeShape = 'circle' | 'ring' | 'square' | 'triangle'

/** Three roles, not four kinds. Shape carries the kind; this carries emphasis. */
export type NodeTone = 'note' | 'structure' | 'task' | 'done'

export interface SceneNode {
  id: string
  kind: GraphNodeKind
  shape: NodeShape
  tone: NodeTone
  /** Full text, for the tooltip and the accessible name. */
  label: string
  /** Shortened for drawing, because a long TODO would cover the graph. */
  short: string
  path: NotePath | null
  /** Where an annotation sits in its note, so a click can open the right line. */
  line: number | null
  day: string | null
  done: boolean
  /**
   * A wikilink target with no note behind it.
   *
   * Drawn as an outline rather than hidden or flagged: a link to a note you
   * have not written yet is an ordinary, useful state in a wiki -- it is how
   * you leave yourself a note-shaped hole -- so it should read as "not here
   * yet", not as a broken reference.
   */
  missing: boolean
  /**
   * The link goes nowhere because the name matches more than one note, not
   * because nothing is there.
   *
   * The index reports one edge kind for both, but they are opposite problems.
   * "Not written yet" is the normal, useful state; "two notes are called this"
   * is something to go and fix, and telling someone their note does not exist
   * while they are looking at two of them is worse than saying nothing.
   */
  ambiguous: boolean
  radius: number
  degree: number
  /** What a screen reader says, and what the tooltip shows. */
  description: string
}

export interface SceneEdge {
  id: string
  kind: GraphEdgeKind
  source: string
  target: string
  /** Rest length, so different relationships sit at different distances. */
  length: number
  strength: number
}

export interface Scene {
  nodes: SceneNode[]
  edges: SceneEdge[]
  /** Nodes in the graph before any cap was applied. */
  totalNodes: number
  /** Nodes left undrawn because the graph is larger than we will render. */
  omitted: number
  /** Edges dropped for naming a node that is not in the graph. */
  dangling: number
  /** Whether every node can afford a permanent label. */
  labelled: boolean
}

export interface SceneOptions {
  /**
   * The point past which the whole graph is not drawn.
   *
   * Not a guess about what the browser can survive -- it is roughly where an
   * SVG of this shape stops being readable. Beyond a thousand-odd nodes the
   * picture is a hairball whatever the frame rate, so the honest response is to
   * draw the best-connected part and say so, rather than to spend ten seconds
   * laying out something nobody can use.
   */
  maxNodes?: number
  /** At or below this many nodes, every node keeps a visible label. */
  labelLimit?: number
}

export const DEFAULT_MAX_NODES = 1200
export const DEFAULT_LABEL_LIMIT = 260

/** Longest label drawn. Beyond this the text is wider than the graph is tall. */
const MAX_LABEL = 26

const SHAPES: Record<GraphNodeKind, NodeShape> = {
  note: 'circle',
  day: 'ring',
  todo: 'square',
  reminder: 'triangle',
}

/**
 * Edge kinds want different distances, which is what gives the picture its
 * structure without any colour being involved: an annotation sits tight against
 * the note that contains it, a day holds its notes a little further out, and a
 * wikilink is a long, loose connection between two things that stand alone.
 */
const EDGE_FORCE: Record<GraphEdgeKind, { length: number; strength: number }> = {
  contains: { length: 42, strength: 0.1 },
  day: { length: 68, strength: 0.06 },
  link: { length: 112, strength: 0.045 },
  // Weakest and longest: a link to a note that does not exist should hang off
  // the edge of the picture rather than pull anything into the middle of it.
  unresolved: { length: 96, strength: 0.028 },
}

export function buildScene(graph: NoteGraph, options: SceneOptions = {}): Scene {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const labelLimit = options.labelLimit ?? DEFAULT_LABEL_LIMIT

  const sourceNodes = dedupe(graph.nodes)
  const present = new Set(sourceNodes.map((node) => node.id))

  const degree = new Map<string, number>()
  const unresolvedTargets = new Set<string>()
  let dangling = 0

  for (const edge of graph.edges) {
    if (!present.has(edge.from) || !present.has(edge.to) || edge.from === edge.to) {
      dangling += 1
      continue
    }

    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    if (edge.kind === 'unresolved') unresolvedTargets.add(edge.to)
  }

  const kept = selectNodes(sourceNodes, degree, maxNodes)
  const keptIds = new Set(kept.map((node) => node.id))

  // Names that do have notes behind them. A wikilink target only fails to
  // resolve while a note of that name exists if there is more than one, because
  // resolution refuses to guess between them -- so a hit here means ambiguous
  // rather than absent.
  //
  // Lowercased on both sides: the index normalises a missing target's label and
  // leaves a real note's basename as it was typed. Drawn from the whole graph
  // rather than the drawn subset, so the cap cannot change the answer.
  const namesWithNotes = new Set<string>()
  for (const node of sourceNodes) {
    if (node.kind === 'note' && node.path !== null) namesWithNotes.add(node.label.toLowerCase())
  }

  const nodes = kept.map((node): SceneNode => {
    const links = degree.get(node.id) ?? 0
    const done = node.done === true
    // Two independent signals for the same fact, because either can be absent:
    // the index may model a phantom target as a pathless note, and it may
    // simply be the far end of an unresolved edge.
    const missing = (node.kind === 'note' && node.path === null) || unresolvedTargets.has(node.id)
    const ambiguous = missing && namesWithNotes.has(node.label.toLowerCase())

    return {
      id: node.id,
      kind: node.kind,
      shape: SHAPES[node.kind],
      tone: toneFor(node.kind, done, missing),
      label: node.label,
      short: truncateLabel(node.label),
      path: node.path,
      line: node.line,
      day: node.day,
      done,
      missing,
      ambiguous,
      radius: radiusFor(node.kind, links, missing),
      degree: links,
      description: describe({
        kind: node.kind,
        label: node.label,
        path: node.path,
        day: node.day,
        done,
        missing,
        ambiguous,
      }),
    }
  })

  const edges: SceneEdge[] = []

  for (const edge of graph.edges) {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to) || edge.from === edge.to) continue

    const force = EDGE_FORCE[edge.kind] ?? EDGE_FORCE.link
    edges.push({
      // The index may legitimately report the same pair twice under different
      // kinds -- a note that both links to and contains something -- so the
      // kind is part of the key or React would see duplicates.
      id: `${edge.kind}:${edge.from}->${edge.to}`,
      kind: edge.kind,
      source: edge.from,
      target: edge.to,
      length: force.length,
      strength: force.strength,
    })
  }

  return {
    nodes,
    edges: dedupeEdges(edges),
    totalNodes: sourceNodes.length,
    omitted: sourceNodes.length - nodes.length,
    dangling,
    labelled: nodes.length <= labelLimit,
  }
}

/**
 * Which nodes survive the cap.
 *
 * By connectivity, because the point of a graph view is the connections: an
 * isolated note tells you nothing you could not get from the file tree, whereas
 * the hub with thirty backlinks is the thing you opened this to look at. Ties
 * break on the id so that the same oversized graph always yields the same
 * picture -- otherwise a rebuild would silently swap which notes are visible.
 */
function selectNodes<T extends { id: string; kind: GraphNodeKind }>(
  nodes: readonly T[],
  degree: ReadonlyMap<string, number>,
  maxNodes: number,
): T[] {
  if (nodes.length <= maxNodes) return [...nodes]

  return [...nodes]
    .sort((a, b) => {
      const byDegree = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
      if (byDegree !== 0) return byDegree

      // Days before notes before annotations: days are the spine of a journal,
      // and a spine with holes in it reads worse than missing leaves.
      const byKind = kindRank(a.kind) - kindRank(b.kind)
      if (byKind !== 0) return byKind

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, maxNodes)
}

function kindRank(kind: GraphNodeKind): number {
  return kind === 'day' ? 0 : kind === 'note' ? 1 : 2
}

function dedupe<T extends { id: string }>(nodes: readonly T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []

  for (const node of nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    unique.push(node)
  }

  return unique
}

function dedupeEdges(edges: readonly SceneEdge[]): SceneEdge[] {
  const seen = new Set<string>()
  const unique: SceneEdge[] = []

  for (const edge of edges) {
    if (seen.has(edge.id)) continue
    seen.add(edge.id)
    unique.push(edge)
  }

  return unique
}

function toneFor(kind: GraphNodeKind, done: boolean, missing: boolean): NodeTone {
  if (kind === 'day') return 'structure'
  if (kind === 'note') return missing ? 'structure' : 'note'
  return done ? 'done' : 'task'
}

function radiusFor(kind: GraphNodeKind, degree: number, missing: boolean): number {
  if (kind === 'day') return 10
  if (kind === 'note') {
    if (missing) return 5.5
    // Grows with connections but stops: past a dozen links the extra pixels
    // stop meaning anything and start covering the neighbours.
    return 6 + Math.min(degree, 14) * 0.38
  }

  // Triangles read smaller than circles of the same radius, so reminders get a
  // little back to keep the kinds looking like one family.
  return kind === 'reminder' ? 6.4 : 5.4
}

export function truncateLabel(label: string, max = MAX_LABEL): string {
  const clean = label.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean

  return `${clean.slice(0, max - 1).trimEnd()}…`
}

function describe(node: {
  kind: GraphNodeKind
  label: string
  path: NotePath | null
  day: string | null
  done: boolean
  missing: boolean
  ambiguous: boolean
}): string {
  if (node.kind === 'day') return `Day ${node.label}`

  if (node.kind === 'note') {
    if (!node.missing) return `Note ${node.path ?? node.label}`

    return node.ambiguous
      ? `${node.label} — more than one note has this name, so the link is not followed`
      : `${node.label} — no note by this name yet`
  }

  const kind = node.kind === 'todo' ? (node.done ? 'Todo, done' : 'Todo') : 'Reminder'
  const where = node.path === null ? '' : ` in ${node.path}`

  return `${kind}${where}: ${node.label}`
}

// --- Opening a node --------------------------------------------------------

export interface OpenTarget {
  path: NotePath
  /** 1-indexed, matching the editor. Absent for a whole-note target. */
  line?: number
}

/**
 * Where clicking a node goes, or null when there is nowhere to go.
 *
 * Null is a real answer rather than a failure. A wikilink target with no note
 * behind it has no file to open, and a day that nobody has written a daily for
 * is a node in the graph without being a note on disk. Creating the file on a
 * click would be a filesystem write triggered by a gesture that looks like
 * navigation, which is not a trade anyone would take knowingly.
 *
 * A line below 1 is treated as absent. The editor's reveal is 1-indexed, and a
 * 0 would either be clamped silently or land somewhere arbitrary; opening the
 * top of the right note is the better failure.
 */
export function openTargetFor(node: SceneNode): OpenTarget | null {
  if (node.path === null) return null
  if (node.line === null || node.line < 1) return { path: node.path }

  return { path: node.path, line: node.line }
}
