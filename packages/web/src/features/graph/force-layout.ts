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
 * stable at a step size where Euler visibly overshoots and rings, which means
 * fewer frames to reach the same picture.
 *
 * Termination is the other half of the design and it is not left to physics.
 * Forces are scaled by a heat that decays to nothing over about 220 steps, so
 * the animation ends on a schedule whether or not the graph found an
 * arrangement it liked -- see `alphaDecay` for the measurement that made that
 * necessary. A graph that does settle earlier stops earlier; `maxTicks` is
 * behind both as a backstop that should never fire.
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
  /** Half-extents of the box nothing else may overlap. See `separation`. */
  spreadX: number
  spreadY: number
  /**
   * Held where it was put, by someone dragging it.
   *
   * A fixed node is skipped by the integrator but not by the forces: everything
   * else still feels its repulsion and still hangs off its springs, which is the
   * whole point of pinning one. Dropping it out of `accumulate` instead would
   * make a pinned hub stop pushing its neighbours apart and let them pile on top
   * of it.
   */
  fixed: boolean
}

export interface LayoutEdgeInput {
  from: string
  to: string
  /** The distance this edge would like to be. Defaults to `springLength`. */
  length?: number
  strength?: number
}

export interface LayoutNodeInput {
  id: string
  /**
   * Half-extents of the box this node wants kept clear.
   *
   * Optional, and the simulation does not care what fills it. The caller knows
   * it is a label; from in here it is just a rectangle nothing else may sit
   * inside.
   */
  spreadX?: number
  spreadY?: number
}

export interface LayoutInput {
  nodes: readonly LayoutNodeInput[]
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
  /** Velocity retained per step. */
  damping: number
  /**
   * Fraction of the remaining heat given up each step.
   *
   * This is what actually guarantees the animation stops, and it is not
   * optional. Damping alone only converges if the graph *has* an equilibrium to
   * fall into, and a real one usually does not: a note wanting to sit near
   * three others that are pulling in different directions is a frustrated
   * constraint, and the system will trade one arrangement for an equally bad
   * one forever. Measured on a thousand-node graph, peak speed plateaus around
   * 4 px/step and never approaches stillness.
   *
   * So the forces are scaled by a heat that decays geometrically to nothing.
   * That turns the simulation from a physics model into what it actually is --
   * an optimiser being annealed -- and makes termination arithmetic rather than
   * a hope. The default reaches `alphaMin` in about 220 steps, so a cold start
   * is roughly four seconds of motion at 60fps.
   */
  alphaDecay: number
  /** Heat below which the layout is done, whatever it is still doing. */
  alphaMin: number
  /**
   * Heat a rebuild starts at when nothing much changed.
   *
   * A save should nudge the graph, not re-anneal it. Starting a carried-over
   * layout at full heat would shake a picture that was already correct, which
   * is the same jump that keeping the positions exists to avoid.
   */
  reheat: number
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
   * Hard stop, whatever the graph is doing.
   *
   * Cooling already guarantees an end, so this should never be reached. It is
   * here because "should never" is not "cannot", and a `requestAnimationFrame`
   * loop that fails to stop is a flat battery on a tab nobody is looking at.
   */
  maxTicks: number
  /**
   * How hard overlapping nodes shove each other out of the way.
   *
   * Repulsion alone cannot do this job. It is inverse-square and long-range, so
   * it decides the overall spread of the picture but is easily beaten locally
   * by a short spring -- which is exactly the case that matters, because a todo
   * is pulled hard against the note containing it and its label is six times
   * wider than either dot. Separation is short-range and stiff: it does nothing
   * at all until two boxes actually touch.
   */
  separation: number
  /**
   * Node count above which separation is skipped.
   *
   * Above the label limit nothing carries text, so the boxes collapse to the
   * dots themselves and repulsion already keeps those apart -- measured, a
   * thousand-node layout settles with no pair closer than 14 units. Which makes
   * this pass pure cost on exactly the graphs that can least afford an O(n^2)
   * sweep.
   */
  separateBelow: number
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
  // 0.001 ^ (1 / 220): heat runs out after about 220 steps.
  alphaDecay: 0.0309,
  alphaMin: 0.001,
  reheat: 0.25,
  timeStep: 1,
  softening: 24,
  maxSpeed: 24,
  settleSpeed: 0.04,
  settleSteps: 10,
  maxTicks: 900,
  // Measured: 0.5 is where label collisions reach zero across a sixteen-node
  // journal, a month and a busy three hundred. Above 0.5 nothing improves and
  // nothing costs, so this sits just past the knee rather than on it.
  separation: 0.6,
  separateBelow: 400,
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
  /**
   * Remaining heat: every force is scaled by this, and it decays to nothing.
   * Starts at 1 for a fresh graph and lower for a rebuild that barely changed.
   */
  alpha: number
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
 *
 * `pinned` is the same idea for positions a person chose by hand, and it is
 * separate from `previous` rather than folded into it because the two survive
 * different things: a carried position is a starting guess the physics is free
 * to overrule, and a pin is not. Ids that are not in this layout are ignored,
 * which is what lets the caller hand over a set saved before a note was renamed.
 */
export function createLayout(
  input: LayoutInput,
  overrides: Partial<LayoutOptions> = {},
  previous?: ReadonlyMap<string, Vec> | null,
  pinned?: ReadonlyMap<string, Vec> | null,
): Layout {
  const options = { ...DEFAULT_LAYOUT_OPTIONS, ...overrides }

  const nodes: LayoutNode[] = []
  const byId = new Map<string, LayoutNode>()
  const radius = seedRadius(input.nodes.length, options.springLength)

  for (const input_ of input.nodes) {
    const id = input_.id
    // A duplicate id would get two nodes sharing one identity, and every edge
    // naming it would attach to whichever came first. Dropping the second is
    // the only reading that keeps the picture consistent with the data.
    if (byId.has(id)) continue

    // A pin outranks a carried position, and both outrank the seed: the pin is
    // where someone put this node on purpose.
    const pin = pinned?.get(id)
    const carried = pin ?? previous?.get(id)
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
      spreadX: input_.spreadX ?? 0,
      spreadY: input_.spreadY ?? 0,
      fixed: pin !== undefined,
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
    alpha: startingHeat(nodes, options, previous),
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
  const { timeStep, damping, maxSpeed, settleSpeed, alphaDecay } = layout.options
  const half = timeStep / 2

  for (const node of layout.nodes) {
    if (node.fixed) continue
    node.x += node.vx * timeStep + node.ax * half * timeStep
    node.y += node.vy * timeStep + node.ay * half * timeStep
    node.vx += node.ax * half
    node.vy += node.ay * half
  }

  accumulate(layout)

  let peak = 0

  for (const node of layout.nodes) {
    // A pinned node is not still, it is held -- so it contributes no speed and
    // keeps none. Letting its velocity accumulate while it cannot move would
    // fire it across the picture the moment it was released.
    if (node.fixed) {
      node.vx = 0
      node.vy = 0
      continue
    }

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
  layout.alpha -= layout.alpha * alphaDecay
  // Counted rather than tested once, because a node reversing direction passes
  // through zero speed. One still step means nothing; ten in a row means the
  // graph has actually stopped.
  layout.stillFor = peak <= settleSpeed ? layout.stillFor + 1 : 0

  return peak
}

/**
 * True once the animation loop can stop without the picture changing.
 *
 * Three ways to be finished, and they are not redundant. A graph that found an
 * equilibrium goes still and stops early. A graph that never will runs out of
 * heat and stops on schedule. And `maxTicks` catches whatever neither of those
 * anticipated.
 */
export function isSettled(layout: Layout): boolean {
  if (layout.nodes.length === 0) return true

  return (
    layout.alpha <= layout.options.alphaMin ||
    layout.stillFor >= layout.options.settleSteps ||
    layout.ticks >= layout.options.maxTicks
  )
}

/**
 * Stopped on the hard tick limit rather than by cooling or going still.
 *
 * Should not happen: cooling reaches `alphaMin` in about a fifth of the budget.
 * If it ever does, the constants are wrong rather than the graph being unusual.
 */
export function isExhausted(layout: Layout): boolean {
  return (
    layout.ticks >= layout.options.maxTicks &&
    layout.alpha > layout.options.alphaMin &&
    layout.stillFor < layout.options.settleSteps
  )
}

/** A snapshot to hand to the next `createLayout` as `previous`. */
export function layoutPositions(layout: Layout): Map<string, Vec> {
  const positions = new Map<string, Vec>()
  for (const node of layout.nodes) positions.set(node.id, { x: node.x, y: node.y })
  return positions
}

/** The same, for `pinned`: only the nodes someone placed by hand. */
export function layoutPins(layout: Layout): Map<string, Vec> {
  const pins = new Map<string, Vec>()
  for (const node of layout.nodes) if (node.fixed) pins.set(node.id, { x: node.x, y: node.y })
  return pins
}

/**
 * Put some heat back in, so a settled layout starts moving again.
 *
 * Needed because settling is deliberately terminal: `isSettled` is what makes
 * the animation loop stop booking frames, and `start` declines on a layout that
 * is already settled. Dragging a node is the first thing in this view that
 * changes the graph without replacing it, so it is the first thing that needs a
 * way back.
 *
 * `ticks` is reset along with the heat, which makes `maxTicks` a budget per
 * warm-up rather than per layout. That is the reading that matches what it is
 * for: a backstop against a loop that will not stop, not a lifetime allowance
 * that quietly runs out on a graph somebody has been rearranging for an hour.
 */
export function reheat(layout: Layout, alpha: number): void {
  layout.alpha = Math.min(1, Math.max(layout.alpha, alpha))
  layout.stillFor = 0
  layout.ticks = 0
}

/** Hold a node at a point. Idempotent, and unknown ids are ignored. */
export function pinNode(layout: Layout, id: string, point: Vec): void {
  const node = layout.byId.get(id)
  if (node === undefined) return

  node.x = point.x
  node.y = point.y
  node.vx = 0
  node.vy = 0
  node.fixed = true
}

export function unpinNode(layout: Layout, id: string): void {
  const node = layout.byId.get(id)
  if (node !== undefined) node.fixed = false
}

export function unpinAll(layout: Layout): void {
  for (const node of layout.nodes) node.fixed = false
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
  applySeparation(layout)

  // Every force scaled by the remaining heat, in one place at the end rather
  // than threaded through each of them. As the heat runs out the forces vanish,
  // damping takes the last of the momentum, and the graph stops -- which is the
  // only thing here that makes stopping a certainty rather than a hope.
  for (const node of layout.nodes) {
    node.ax *= layout.alpha
    node.ay *= layout.alpha
  }
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

/**
 * Keeps each node's box clear of every other node's box.
 *
 * Measured in a normalised space where both boxes become one shape, so the push
 * comes out along a smooth gradient rather than along whichever axis happened
 * to overlap least. Snapping to an axis is the usual way to separate rectangles
 * and it jitters here: label boxes are six times wider than they are tall, so
 * the cheaper direction is nearly always straight up, and nodes end up
 * shuffling into columns and flipping between axes as they cross.
 *
 * That shape is a superellipse rather than an ellipse. An inscribed ellipse
 * leaves the four corners of the box unprotected, which for something this wide
 * and flat is most of its outline -- measured, it let a couple of labels
 * overlap diagonally on a month of journal while reporting no overlap itself.
 * Raising the exponent pulls the curve out towards the corners; 4 is close
 * enough to a rectangle to fix that and still smooth enough not to chatter.
 *
 * The force is scaled back out to world units per axis on the way, which is
 * what makes it push mostly sideways for wide boxes -- the direction where the
 * room is actually needed.
 */
function applySeparation(layout: Layout): void {
  const { separation, separateBelow } = layout.options
  const nodes = layout.nodes
  if (separation <= 0 || nodes.length > separateBelow) return

  for (const [i, a] of nodes.entries()) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      if (b === undefined) continue

      const reachX = a.spreadX + b.spreadX
      const reachY = a.spreadY + b.spreadY
      if (reachX <= 0 || reachY <= 0) continue

      const dx = b.x - a.x
      const dy = b.y - a.y

      // Cheap rejection first: most pairs in a settled graph are nowhere near
      // each other, and this is the inner loop.
      if (Math.abs(dx) >= reachX || Math.abs(dy) >= reachY) continue

      const nx = dx / reachX
      const ny = dy / reachY
      // The superellipse norm: (nx^4 + ny^4)^(1/4), two square roots rather
      // than a `Math.pow` because this is the inner loop.
      const distance = Math.sqrt(Math.sqrt(nx ** 4 + ny ** 4))
      if (distance >= 1) continue

      if (distance < 1e-6) {
        // Two boxes exactly concentric have no direction to part along. Taken
        // from the ids so the tie-break is reproducible, like everywhere else.
        const angle = ((hash(`${a.id} ${b.id}`) % 3600) / 3600) * TAU
        a.ax -= Math.cos(angle) * separation * reachX
        a.ay -= Math.sin(angle) * separation * reachY
        b.ax += Math.cos(angle) * separation * reachX
        b.ay += Math.sin(angle) * separation * reachY
        continue
      }

      const push = (separation * (1 - distance)) / distance
      const fx = nx * push * reachX
      const fy = ny * push * reachY

      a.ax -= fx
      a.ay -= fy
      b.ax += fx
      b.ay += fy
    }
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
        const angle = ((hash(`${a.id}\u0000${b.id}`) % 3600) / 3600) * TAU
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

/**
 * How hot to start, from how much of the graph is new.
 *
 * A cold start is fully hot. A rebuild after someone saved a note is mostly the
 * same graph, so it starts barely warm: enough to let a new TODO find its place
 * and its neighbours shuffle over, not enough to redraw a picture that was
 * already right. Between the two it scales with the churn, so a big import
 * anneals properly rather than settling into whatever the old layout was.
 */
function startingHeat(
  nodes: readonly LayoutNode[],
  options: LayoutOptions,
  previous?: ReadonlyMap<string, Vec> | null,
): number {
  if (previous === undefined || previous === null || previous.size === 0) return 1
  if (nodes.length === 0) return options.reheat

  let carried = 0
  for (const node of nodes) if (previous.has(node.id)) carried += 1

  const churn = 1 - carried / nodes.length
  return Math.min(1, options.reheat + churn)
}

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
    // A pin is a position too, even for a node this layout is seeing for the
    // first time -- restoring one saved before the app was reloaded arrives
    // exactly that way.
    if (node.fixed || previous.has(node.id)) return
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
