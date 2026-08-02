/**
 * The graph layout, as physics. No DOM, no React, no timers.
 *
 * Hand-rolled rather than d3-force because the layout is the *only* part of
 * that library this view would use, and pulling in a graph package to get it
 * would hand back the bundle we just won by code-splitting xterm off the mobile
 * path. What is actually needed here -- repulsion, spring edges, a pull toward
 * the middle -- is a page of arithmetic.
 *
 * Keeping it pure is the other half of the reason. A layout that only exists
 * inside a `requestAnimationFrame` callback can only be checked by looking at
 * it; this one can be asserted on. Every interesting property of the picture
 * (linked notes end up a spring's length apart, unconnected ones push away,
 * the same graph lays out the same way twice, a rebuild does not move anything
 * that already had a position) is a test in force-layout.test.ts.
 *
 * Integrated with velocity Verlet rather than the more common semi-implicit
 * Euler. Verlet uses the acceleration at both ends of the step, so it stays
 * stable at a step size where Euler visibly overshoots and rings -- which
 * matters because a bigger step means fewer frames before the thing settles,
 * and settling is what lets the animation loop stop (see `isSettled`).
 */

const TAU = Math.PI * 2

export interface Vec {
  x: number
  y: number
}

export interface LayoutNode {
  readonly id: string
  x: number
  y: number
  vx: number
  vy: number
  /**
   * Acceleration from the current step, kept between steps because Verlet
   * needs the old value to finish the velocity update.
   */
  ax: number
  ay: number
  /**
   * Repulsion strength -- charge, not inertia. A note with twenty backlinks
   * needs more room around it than a stub, and every node responds to force
   * equally regardless, so this deliberately does not divide into acceleration.
   */
  charge: number
}

export interface LayoutEdgeInput {
  from: string
  to: string
  /** The distance this edge would like to be. Defaults to `springLength`. */
  length?: number
  strength?: number
}

export interface LayoutInput {
  nodes: readonly { id: string }[]
  edges: readonly LayoutEdgeInput[]
}

export interface LayoutOptions {
  /** Inverse-square push between every pair. */
  repulsion: number
  /** Rest length for an edge that does not ask for its own. */
  springLength: number
  springStrength: number
  /**
   * A weak pull toward the origin. Without it, components that link to nothing
   * are pushed away by everything and never stop; the graph would expand
   * forever and never settle.
   */
  gravity: number
  /** Velocity retained per step. This is what turns motion into stillness. */
  damping: number
  timeStep: number
  /** Added to every squared distance, so coincident nodes cannot divide by 0. */
  softening: number
  /** Velocity ceiling. A safety rail against a stiff graph exploding. */
  maxSpeed: number
  /** Peak speed under which a step counts as still. */
  settleSpeed: number
  /** Consecutive still steps before the layout is called settled. */
  settleSteps: number
  /**
   * Hard stop, whatever the graph is doing. A pathological graph that oscillates
   * instead of converging must not be able to hold a `requestAnimationFrame`
   * loop open forever on a laptop nobody is looking at.
   */
  maxTicks: number
  /**
   * Barnes-Hut opening angle. 0 forces exact pairwise repulsion; larger is
   * faster and coarser. 0.8 is the usual compromise.
   */
  theta: number
  /**
   * Below this many nodes the quadtree costs more to build than the pairwise
   * sum costs to compute, so small graphs take the exact path.
   */
  exactBelow: number
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  repulsion: 2600,
  springLength: 74,
  springStrength: 0.05,
  gravity: 0.014,
  damping: 0.84,
  timeStep: 1,
  softening: 24,
  maxSpeed: 24,
  settleSpeed: 0.04,
  settleSteps: 10,
  maxTicks: 900,
  theta: 0.8,
  exactBelow: 192,
}

export interface LayoutSpring {
  a: LayoutNode
  b: LayoutNode
  length: number
  strength: number
}

export interface Layout {
  readonly nodes: LayoutNode[]
  readonly byId: Map<string, LayoutNode>
  /**
   * In the order the edges were given, minus any that named a node the layout
   * does not have. `buildScene` removes those first, which is what lets the
   * renderer pair spring `i` with scene edge `i` and skip a lookup per frame.
   */
  readonly springs: LayoutSpring[]
  readonly options: LayoutOptions
  /** Steps taken since this layout was created. */
  ticks: number
  /** Fastest node in the last step. The settling signal. */
  peakSpeed: number
  /** How many consecutive steps have been under `settleSpeed`. */
  stillFor: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Build a layout, optionally reusing positions from the one it replaces.
 *
 * `previous` is the whole point of the port promising stable node ids. Saving a
 * note rebuilds the index and hands back a graph object that shares nothing with
 * the old one, and re-seeding from scratch would make the entire picture leap
 * every time someone types. Anything already placed keeps its coordinates and
 * the simulation carries on from there, so a save nudges the graph instead of
 * throwing it in the air.
 */
export function createLayout(
  input: LayoutInput,
  overrides: Partial<LayoutOptions> = {},
  previous?: ReadonlyMap<string, Vec> | null,
): Layout {
  const options = { ...DEFAULT_LAYOUT_OPTIONS, ...overrides }

  const nodes: LayoutNode[] = []
  const byId = new Map<string, LayoutNode>()
  const radius = seedRadius(input.nodes.length, options.springLength)

  for (const { id } of input.nodes) {
    // A duplicate id would get two nodes sharing one identity, and every edge
    // naming it would attach to whichever came first. Dropping the second is
    // the only reading that keeps the picture consistent with the data.
    if (byId.has(id)) continue

    const carried = previous?.get(id)
    const seed = carried ?? seedPosition(id, radius)
    const node: LayoutNode = {
      id,
      x: seed.x,
      y: seed.y,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      charge: 1,
    }

    nodes.push(node)
    byId.set(id, node)
  }

  const springs: LayoutSpring[] = []
  const degree = new Map<string, number>()

  for (const edge of input.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)

    // An edge naming a node that is not here is dropped rather than fatal. The
    // index is rebuilt in the background and can hand over a graph mid-flight;
    // a truncated picture is still worth drawing, a thrown exception is not.
    if (a === undefined || b === undefined || a === b) continue

    springs.push({
      a,
      b,
      length: edge.length ?? options.springLength,
      strength: edge.strength ?? options.springStrength,
    })

    degree.set(a.id, (degree.get(a.id) ?? 0) + 1)
    degree.set(b.id, (degree.get(b.id) ?? 0) + 1)
  }

  // Square root rather than linear: a hub with forty links should claim more
  // space than a leaf, but not forty times more, or it clears the screen.
  for (const node of nodes) node.charge = Math.sqrt(1 + (degree.get(node.id) ?? 0))

  const layout: Layout = {
    nodes,
    byId,
    springs,
    options,
    ticks: 0,
    peakSpeed: Number.POSITIVE_INFINITY,
    stillFor: 0,
  }

  placeNewcomers(layout, previous)

  // Verlet's first half-step reads an acceleration, so it has to exist before
  // the first `step` rather than being left at zero.
  accumulate(layout)

  return layout
}

/**
 * Advance one step. Returns the fastest node's speed, which is the number
 * everything else here decides "has it stopped?" from.
 */
export function step(layout: Layout): number {
  const { timeStep, damping, maxSpeed, settleSpeed } = layout.options
  const half = timeStep / 2

  for (const node of layout.nodes) {
    node.x += node.vx * timeStep + node.ax * half * timeStep
    node.y += node.vy * timeStep + node.ay * half * timeStep
    node.vx += node.ax * half
    node.vy += node.ay * half
  }

  accumulate(layout)

  let peak = 0

  for (const node of layout.nodes) {
    node.vx = (node.vx + node.ax * half) * damping
    node.vy = (node.vy + node.ay * half) * damping

    const speed = Math.hypot(node.vx, node.vy)
    if (speed > maxSpeed) {
      const brake = maxSpeed / speed
      node.vx *= brake
      node.vy *= brake
      peak = Math.max(peak, maxSpeed)
    } else {
      peak = Math.max(peak, speed)
    }
  }

  layout.ticks += 1
  layout.peakSpeed = peak
  // Counted rather than tested once, because a node reversing direction passes
  // through zero speed. One still step means nothing; ten in a row means the
  // graph has actually stopped.
  layout.stillFor = peak <= settleSpeed ? layout.stillFor + 1 : 0

  return peak
}

/** True once the animation loop can stop without the picture changing. */
export function isSettled(layout: Layout): boolean {
  if (layout.nodes.length === 0) return true
  return layout.stillFor >= layout.options.settleSteps || layout.ticks >= layout.options.maxTicks
}

/** Ran out of ticks rather than actually converging. Worth admitting in the UI. */
export function isExhausted(layout: Layout): boolean {
  return layout.ticks >= layout.options.maxTicks && layout.stillFor < layout.options.settleSteps
}

/** A snapshot to hand to the next `createLayout` as `previous`. */
export function layoutPositions(layout: Layout): Map<string, Vec> {
  const positions = new Map<string, Vec>()
  for (const node of layout.nodes) positions.set(node.id, { x: node.x, y: node.y })
  return positions
}

/** The box every node fits in. Empty layouts get a unit box, never NaN. */
export function layoutBounds(layout: Layout): Bounds {
  if (layout.nodes.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const node of layout.nodes) {
    if (node.x < minX) minX = node.x
    if (node.y < minY) minY = node.y
    if (node.x > maxX) maxX = node.x
    if (node.y > maxY) maxY = node.y
  }

  return { minX, minY, maxX, maxY }
}

// --- Forces ----------------------------------------------------------------

function accumulate(layout: Layout): void {
  const { gravity, theta, exactBelow } = layout.options

  for (const node of layout.nodes) {
    node.ax = -gravity * node.x
    node.ay = -gravity * node.y
  }

  if (layout.nodes.length <= exactBelow || theta <= 0) exactRepulsion(layout)
  else approximateRepulsion(layout)

  applySprings(layout)
}

function applySprings(layout: Layout): void {
  for (const spring of layout.springs) {
    const dx = spring.b.x - spring.a.x
    const dy = spring.b.y - spring.a.y
    // Floored rather than guarded: two nodes exactly on top of each other have
    // no direction to be pulled along, and dividing by their distance would
    // produce Infinity and poison every later frame.
    const distance = Math.max(Math.hypot(dx, dy), 0.01)
    const pull = (spring.strength * (distance - spring.length)) / distance

    spring.a.ax += dx * pull
    spring.a.ay += dy * pull
    spring.b.ax -= dx * pull
    spring.b.ay -= dy * pull
  }
}

function exactRepulsion(layout: Layout): void {
  const { repulsion, softening } = layout.options
  const nodes = layout.nodes

  for (const [i, a] of nodes.entries()) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      if (b === undefined) continue

      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy

      if (d2 < 1e-9) {
        // Coincident nodes have no direction to separate along. Deriving one
        // from the two ids rather than from `Math.random` is what keeps the
        // whole layout reproducible, which is what makes it testable.
        const angle = ((hash(`${a.id} ${b.id}`) % 3600) / 3600) * TAU
        dx = Math.cos(angle) * 0.01
        dy = Math.sin(angle) * 0.01
        d2 = dx * dx + dy * dy
      }

      const soft = d2 + softening
      const scale = (repulsion * a.charge * b.charge) / (soft * Math.sqrt(soft))

      a.ax -= dx * scale
      a.ay -= dy * scale
      b.ax += dx * scale
      b.ay += dy * scale
    }
  }
}

/**
 * Barnes-Hut: distant clumps of nodes are treated as one heavy node.
 *
 * This is the difference between a graph that opens and one that hangs. Every
 * pair repelling every other pair is O(n^2) -- a million distance calculations
 * per frame at a thousand nodes, which does not fit in 16ms. A quadtree gets it
 * to O(n log n) at a cost in accuracy that is invisible, because the error is
 * in the weakest, most distant forces.
 *
 * It is also the reason the exact sum above is kept rather than deleted: the
 * test suite checks this against it, which is the only honest way to know the
 * approximation is a shortcut and not a different picture.
 */
function approximateRepulsion(layout: Layout): void {
  const root = buildTree(layout.nodes)
  if (root === null) return

  const { repulsion, softening, theta } = layout.options
  const theta2 = theta * theta
  const pending: Cell[] = []

  for (const node of layout.nodes) {
    pending.length = 0
    pending.push(root)

    while (pending.length > 0) {
      const cell = pending.pop()
      if (cell === undefined || cell.charge === 0) continue

      const leaf = cell.nw === null && cell.ne === null && cell.sw === null && cell.se === null
      // Skipping self, but only when this cell holds nothing else -- otherwise
      // the co-located bodies folded in at max depth would lose their push.
      if (leaf && cell.body === node && cell.charge === node.charge) continue

      const dx = cell.cx - node.x
      const dy = cell.cy - node.y
      const d2 = dx * dx + dy * dy

      if (leaf || cell.size * cell.size < theta2 * d2) {
        const soft = d2 + softening
        const scale = (repulsion * node.charge * cell.charge) / (soft * Math.sqrt(soft))
        node.ax -= dx * scale
        node.ay -= dy * scale
        continue
      }

      if (cell.nw !== null) pending.push(cell.nw)
      if (cell.ne !== null) pending.push(cell.ne)
      if (cell.sw !== null) pending.push(cell.sw)
      if (cell.se !== null) pending.push(cell.se)
    }
  }
}

// --- Quadtree --------------------------------------------------------------

interface Cell {
  ox: number
  oy: number
  size: number
  /** Centre of charge, and the total, for the whole subtree. */
  cx: number
  cy: number
  charge: number
  /** The single node in a leaf, or null once the cell has subdivided. */
  body: LayoutNode | null
  nw: Cell | null
  ne: Cell | null
  sw: Cell | null
  se: Cell | null
}

/**
 * Two nodes at the same coordinates would subdivide forever, each split leaving
 * both on the same side. At this depth the cells are far smaller than a pixel
 * at any zoom this view offers, so the remaining bodies are merged into the
 * cell's charge and the recursion stops.
 */
const MAX_DEPTH = 24

function buildTree(nodes: readonly LayoutNode[]): Cell | null {
  if (nodes.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const node of nodes) {
    if (node.x < minX) minX = node.x
    if (node.y < minY) minY = node.y
    if (node.x > maxX) maxX = node.x
    if (node.y > maxY) maxY = node.y
  }

  // Square, and a hair larger than the data, so the >= tests below cannot put
  // the rightmost node in a quadrant that does not exist.
  const size = Math.max(maxX - minX, maxY - minY, 1) * 1.01
  const root = createCell(minX, minY, size)

  for (const node of nodes) insert(root, node, 0)

  return root
}

function createCell(ox: number, oy: number, size: number): Cell {
  return {
    ox,
    oy,
    size,
    cx: 0,
    cy: 0,
    charge: 0,
    body: null,
    nw: null,
    ne: null,
    sw: null,
    se: null,
  }
}

function insert(cell: Cell, node: LayoutNode, depth: number): void {
  const total = cell.charge + node.charge
  cell.cx = (cell.cx * cell.charge + node.x * node.charge) / total
  cell.cy = (cell.cy * cell.charge + node.y * node.charge) / total
  cell.charge = total

  const empty =
    cell.body === null &&
    cell.nw === null &&
    cell.ne === null &&
    cell.sw === null &&
    cell.se === null

  if (empty) {
    cell.body = node
    return
  }

  if (depth >= MAX_DEPTH) return

  const resident = cell.body
  if (resident !== null) {
    cell.body = null
    descend(cell, resident, depth)
  }

  descend(cell, node, depth)
}

function descend(parent: Cell, node: LayoutNode, depth: number): void {
  const half = parent.size / 2
  const east = node.x >= parent.ox + half
  const south = node.y >= parent.oy + half

  const existing = east ? (south ? parent.se : parent.ne) : south ? parent.sw : parent.nw
  const child =
    existing ??
    createCell(east ? parent.ox + half : parent.ox, south ? parent.oy + half : parent.oy, half)

  if (existing === null) {
    if (east && south) parent.se = child
    else if (east) parent.ne = child
    else if (south) parent.sw = child
    else parent.nw = child
  }

  insert(child, node, depth + 1)
}

// --- Seeding ---------------------------------------------------------------

function seedRadius(count: number, springLength: number): number {
  // Area per node held roughly constant, so a big graph starts spread out
  // instead of as one dense knot that takes hundreds of ticks to unpick.
  return Math.max(springLength, Math.sqrt(Math.max(count, 1)) * springLength * 0.55)
}

/**
 * A node's starting point, derived from its id.
 *
 * From the id rather than from its position in the array, because the array
 * order is the index's business and can change between rebuilds. From a hash
 * rather than `Math.random` because a layout you cannot reproduce is a layout
 * you cannot write a test about.
 */
function seedPosition(id: string, radius: number): Vec {
  const h = hash(id)
  const angle = ((h % 65_536) / 65_536) * TAU
  // Square-rooted so the points land uniformly across the disc rather than
  // piling up in the middle, where they would take longer to push apart.
  const distance = radius * Math.sqrt(((h >>> 16) % 65_536) / 65_536)

  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance }
}

/**
 * Nodes that were not in the previous layout start next to the neighbours that
 * were.
 *
 * Otherwise a TODO typed into today's journal enters at a hashed point on the
 * far side of the picture and flies across it to reach the note it belongs to.
 * The graph is right either way; only one of them looks like the app understood
 * what just happened.
 */
function placeNewcomers(layout: Layout, previous?: ReadonlyMap<string, Vec> | null): void {
  if (previous === undefined || previous === null || previous.size === 0) return

  const anchors = new Map<string, Vec[]>()

  const consider = (node: LayoutNode, neighbour: LayoutNode) => {
    if (previous.has(node.id)) return
    const known = previous.get(neighbour.id)
    if (known === undefined) return

    const list = anchors.get(node.id)
    if (list === undefined) anchors.set(node.id, [known])
    else list.push(known)
  }

  for (const spring of layout.springs) {
    consider(spring.a, spring.b)
    consider(spring.b, spring.a)
  }

  for (const node of layout.nodes) {
    const nearby = anchors.get(node.id)
    if (nearby === undefined || nearby.length === 0) continue

    let x = 0
    let y = 0
    for (const point of nearby) {
      x += point.x
      y += point.y
    }

    // Offset off the centroid so several newcomers sharing one note do not all
    // land on the same pixel and have to be prised apart.
    const jitter = seedPosition(node.id, layout.options.springLength * 0.4)
    node.x = x / nearby.length + jitter.x
    node.y = y / nearby.length + jitter.y
  }
}

/** FNV-1a. Small, fast, and good enough to scatter ids around a circle. */
function hash(text: string): number {
  let value = 0x811c9dc5

  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }

  return value >>> 0
}
