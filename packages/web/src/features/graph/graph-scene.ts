/**
 * `NoteGraph` turned into something drawable, without touching the DOM.
 *
 * Every decision the picture depends on is made here rather than in JSX: which
 * shape a kind gets, how big it is, how hard its edges pull, how much room its
 * label needs, what a screen reader is told, and what happens when the graph is
 * bigger than a browser will happily draw. That keeps the component down to
 * "put these shapes at these coordinates", and it means the interesting rules
 * can be tested in a package that has no jsdom.
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
  /**
   * What to draw under the node, shortened to fit. Empty means draw nothing --
   * either the whole scene is past the label limit, or this label would only
   * repeat the one next to it.
   */
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
  /**
   * Half-extents of the box this node needs kept clear, label included.
   *
   * The layout uses these to hold nodes apart, which is the only thing that
   * stops labels landing on top of each other. It has to live here rather than
   * in the simulation because it depends on what the text says, and the
   * simulation deliberately knows nothing about notes.
   */
  spreadX: number
  spreadY: number
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
  /** Whether the scene is small enough for every node to carry a label. */
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

/**
 * Label geometry, shared with the CSS and the JSX so the three cannot drift.
 *
 * The layout reserves space using these numbers; if the stylesheet disagreed
 * about the font size, it would reserve the wrong amount and the labels would
 * collide again with nothing in the model to explain why.
 */
export const LABEL_FONT_SIZE = 10
export const LABEL_GAP = 13

/**
 * Below this many rendered pixels a label stops being a word and becomes grey
 * texture, so it is not drawn at all.
 *
 * This is the one thing zooming genuinely fixes. Collisions do not resolve on
 * zoom -- labels live inside the scaled group, so text and the gaps between
 * nodes grow together and the overlap ratio never changes, which is why they
 * have to be solved in the layout instead. Legibility is different: it depends
 * on the scale alone, so zooming in really does bring the words back.
 */
export const MIN_LABEL_PIXELS = 7
const LABEL_HEIGHT = 11

/**
 * Clear space a label wants around it, in multiples of its own size.
 *
 * Not "so the boxes do not overlap" -- so the words do not read as one word.
 * Two labels separated by less than a word space run together at a glance:
 * `markdown` beside `inbox` is read as `markdownbox`, and no measurement of
 * overlap catches that, because there is no overlap. Asking for better than an
 * em on each side puts a clear two ems between neighbours.
 *
 * Sideways only. Labels are wide and short, so horizontal neighbours are the
 * ones that run together; vertically they are already separated by their own
 * line height and a generous gap there would just make the picture tall.
 */
const LABEL_MARGIN_X = LABEL_FONT_SIZE * 1.2
const LABEL_MARGIN_Y = LABEL_FONT_SIZE * 0.4

/** Nodes with nothing written under them only need to not touch. */
const NODE_MARGIN = 3

/**
 * Longest label drawn.
 *
 * Measured rather than chosen: at the previous 26 the widest label came out a
 * third of the entire graph's width on a sixteen-node journal, which is what
 * made the middle of the picture unreadable. A graph label is a name you scan,
 * not text you read -- the tooltip and the note itself carry the rest.
 */
const MAX_LABEL = 18

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
 *
 * The absolute numbers are set against label width rather than against node
 * radius. Nodes are about 12 units across and a label is about 80, so lengths
 * tuned to the dots put the text of one node straight through the text of its
 * neighbour.
 */
const EDGE_FORCE: Record<GraphEdgeKind, { length: number; strength: number }> = {
  contains: { length: 66, strength: 0.09 },
  day: { length: 104, strength: 0.055 },
  link: { length: 158, strength: 0.04 },
  // Weakest and longest: a link to a note that does not exist should hang off
  // the edge of the picture rather than pull anything into the middle of it.
  unresolved: { length: 136, strength: 0.026 },
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
  const labelled = kept.length <= labelLimit

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

  const drawn = dedupeEdges(edges)
  const muted = mutedLabels(kept, drawn)

  const nodes = kept.map((node): SceneNode => {
    const links = degree.get(node.id) ?? 0
    const done = node.done === true
    // Two independent signals for the same fact, because either can be absent:
    // the index may model a phantom target as a pathless note, and it may
    // simply be the far end of an unresolved edge.
    const missing = (node.kind === 'note' && node.path === null) || unresolvedTargets.has(node.id)
    const ambiguous = missing && namesWithNotes.has(node.label.toLowerCase())

    const radius = radiusFor(node.kind, links, missing)
    const short = labelled && !muted.has(node.id) ? truncateLabel(node.label) : ''
    const labelWidth = short === '' ? 0 : estimateLabelWidth(short, LABEL_FONT_SIZE)

    return {
      id: node.id,
      kind: node.kind,
      shape: SHAPES[node.kind],
      tone: toneFor(node.kind, done, missing),
      label: node.label,
      short,
      path: node.path,
      line: node.line,
      day: node.day,
      done,
      missing,
      ambiguous,
      radius,
      spreadX:
        short === '' ? radius + NODE_MARGIN : Math.max(radius, labelWidth / 2) + LABEL_MARGIN_X,
      // The label hangs below the node, so the real box is lopsided. Treating
      // it as symmetric about the node costs a little vertical room and saves
      // the simulation from caring which way up a node is.
      spreadY:
        short === ''
          ? radius + NODE_MARGIN
          : radius + LABEL_GAP + LABEL_HEIGHT / 2 + LABEL_MARGIN_Y,
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

  return {
    nodes,
    edges: drawn,
    totalNodes: sourceNodes.length,
    omitted: sourceNodes.length - nodes.length,
    dangling,
    labelled,
  }
}

/**
 * Labels that would only repeat the one next to them.
 *
 * A daily produces two nodes with the same name -- the note that is the file
 * and the day that is the date -- joined by a short edge, so every journal
 * entry drew its date twice, a few pixels apart. That reads as a rendering
 * fault rather than as two different things.
 *
 * The senior end keeps the text: a day is the structure a journal hangs off, a
 * note outranks the tasks inside it, and equal ranks fall back to the id so the
 * choice is the same on every rebuild.
 */
function mutedLabels(
  nodes: readonly { id: string; kind: GraphNodeKind; label: string }[],
  edges: readonly SceneEdge[],
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const muted = new Set<string>()

  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (a === undefined || b === undefined) continue
    if (a.label !== b.label) continue

    const junior =
      labelRank(a.kind) === labelRank(b.kind)
        ? a.id < b.id
          ? b
          : a
        : labelRank(a.kind) < labelRank(b.kind)
          ? b
          : a
    muted.add(junior.id)
  }

  return muted
}

function labelRank(kind: GraphNodeKind): number {
  return kind === 'day' ? 0 : kind === 'note' ? 1 : 2
}

/**
 * How wide a label will be, without a browser to ask.
 *
 * `getComputedTextLength` needs a laid-out document and this package has no
 * jsdom, so the width is estimated from the characters. The weights are rough
 * -- proportional fonts vary and the UI font is whatever the OS supplies -- but
 * the alternative is treating every character as equally wide, which is wrong
 * by a factor of three between `iiii` and `mmmm` and would reserve visibly the
 * wrong amount of room for a date against a sentence.
 *
 * Erring wide is the safe direction: too much space merely looks airy, too
 * little puts one label through another.
 */
export function estimateLabelWidth(text: string, fontSize: number): number {
  let units = 0

  for (const character of text) {
    if (character === ' ') units += 0.27
    else if (NARROW.has(character)) units += 0.31
    else if (WIDE.has(character)) units += 0.85
    else if (character >= 'A' && character <= 'Z') units += 0.64
    else if (character >= '0' && character <= '9') units += 0.56
    else units += 0.53
  }

  return units * fontSize
}

const NARROW = new Set([...`ijltfIJ.,;:'"\`!|()[]{}-`])
const WIDE = new Set([...'mwMW@%'])

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
      const byKind = labelRank(a.kind) - labelRank(b.kind)
      if (byKind !== 0) return byKind

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, maxNodes)
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
