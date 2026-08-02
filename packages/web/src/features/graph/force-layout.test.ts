import { describe, expect, it } from 'vitest'

import {
  createLayout,
  isExhausted,
  isSettled,
  layoutBounds,
  layoutPositions,
  step,
  type Layout,
  type LayoutNode,
  type Vec,
} from './force-layout'

function at(layout: Layout, id: string): LayoutNode {
  const node = layout.byId.get(id)
  if (node === undefined) throw new Error(`no node ${id} in layout`)
  return node
}

function apart(layout: Layout, a: string, b: string): number {
  return Math.hypot(at(layout, a).x - at(layout, b).x, at(layout, a).y - at(layout, b).y)
}

function run(layout: Layout, steps: number): void {
  for (let i = 0; i < steps; i += 1) step(layout)
}

function runUntilSettled(layout: Layout): number {
  while (!isSettled(layout)) step(layout)
  return layout.ticks
}

function placed(entries: Record<string, Vec>): Map<string, Vec> {
  return new Map(Object.entries(entries))
}

function ids(count: number): { id: string }[] {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}` }))
}

describe('createLayout', () => {
  it('drops edges naming a node that is not in the graph', () => {
    const layout = createLayout({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'ghost' },
        { from: 'ghost', to: 'other-ghost' },
      ],
    })

    expect(layout.springs).toHaveLength(1)
  })

  it('drops self-edges, which have no direction to pull along', () => {
    const layout = createLayout({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'a' }] })

    expect(layout.springs).toHaveLength(0)
  })

  it('keeps one node per id when the graph repeats one', () => {
    const layout = createLayout({
      nodes: [{ id: 'a' }, { id: 'a' }, { id: 'b' }],
      edges: [],
    })

    expect(layout.nodes).toHaveLength(2)
  })

  it('places the same graph the same way twice', () => {
    const input = {
      nodes: ids(24),
      edges: [
        { from: 'n0', to: 'n5' },
        { from: 'n5', to: 'n9' },
      ],
    }

    const first = createLayout(input)
    const second = createLayout(input)
    run(first, 60)
    run(second, 60)

    expect(layoutPositions(first)).toEqual(layoutPositions(second))
  })

  it('does not depend on the order the nodes arrive in', () => {
    const edges = [{ from: 'n0', to: 'n1' }]

    const forwards = createLayout({ nodes: ids(6), edges })
    const backwards = createLayout({ nodes: [...ids(6)].reverse(), edges })

    expect(at(forwards, 'n3').x).toBeCloseTo(at(backwards, 'n3').x, 10)
    expect(at(forwards, 'n3').y).toBeCloseTo(at(backwards, 'n3').y, 10)
  })
})

describe('carrying positions across a rebuild', () => {
  it('leaves an existing node exactly where it was', () => {
    const previous = placed({ a: { x: 120, y: -40 }, b: { x: -30, y: 55 } })

    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
      {},
      previous,
    )

    expect(at(layout, 'a')).toMatchObject({ x: 120, y: -40 })
    expect(at(layout, 'b')).toMatchObject({ x: -30, y: 55 })
  })

  it('starts a new node next to the neighbours that already had a place', () => {
    const previous = placed({ note: { x: 400, y: 400 } })

    const layout = createLayout(
      {
        nodes: [{ id: 'note' }, { id: 'todo' }],
        edges: [{ from: 'note', to: 'todo' }],
      },
      { springLength: 70 },
      previous,
    )

    // Within a spring of its note rather than at a hashed point on the far side
    // of the picture, which is what stops a new TODO flying across the screen.
    expect(apart(layout, 'note', 'todo')).toBeLessThan(70)
  })

  it('separates several newcomers hanging off one note', () => {
    const previous = placed({ note: { x: 0, y: 0 } })

    const layout = createLayout(
      {
        nodes: [{ id: 'note' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [
          { from: 'note', to: 'a' },
          { from: 'note', to: 'b' },
          { from: 'note', to: 'c' },
        ],
      },
      {},
      previous,
    )

    expect(apart(layout, 'a', 'b')).toBeGreaterThan(0)
    expect(apart(layout, 'b', 'c')).toBeGreaterThan(0)
  })

  it('seeds a node with no placed neighbours rather than stacking it at the origin', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'lonely' }], edges: [] },
      {},
      placed({ a: { x: 10, y: 10 } }),
    )

    expect(apart(layout, 'a', 'lonely')).toBeGreaterThan(1)
  })
})

/**
 * Cooling is switched off throughout this block. It is what makes the layout
 * terminate rather than what makes it correct, and leaving it on would mean
 * every assertion about the force law was really an assertion about where the
 * heat happened to run out. Termination gets its own block below.
 */
describe('the forces', () => {
  const forcesOnly = { repulsion: 0, gravity: 0, alphaDecay: 0 }

  it('pulls a linked pair to the rest length of their edge', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', length: 80 }] },
      forcesOnly,
      placed({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }),
    )

    runUntilSettled(layout)

    expect(apart(layout, 'a', 'b')).toBeCloseTo(80, 0)
  })

  it('pushes a linked pair apart when they start on top of each other', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', length: 80 }] },
      forcesOnly,
      placed({ a: { x: 0, y: 0 }, b: { x: 2, y: 0 } }),
    )

    runUntilSettled(layout)

    expect(apart(layout, 'a', 'b')).toBeCloseTo(80, 0)
  })

  it('lands near the rest length with cooling on, which is what ships', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', length: 80 }] },
      { repulsion: 0, gravity: 0 },
      placed({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }),
    )

    runUntilSettled(layout)

    // Annealing freezes the graph a little short of its exact equilibrium. A
    // few percent on an edge length is invisible; the alternative is a
    // simulation that is exactly right and never stops.
    expect(apart(layout, 'a', 'b')).toBeGreaterThan(72)
    expect(apart(layout, 'a', 'b')).toBeLessThan(88)
  })

  it('drives unlinked nodes away from each other', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
      {},
      placed({ a: { x: -3, y: 0 }, b: { x: 3, y: 0 } }),
    )

    runUntilSettled(layout)

    expect(apart(layout, 'a', 'b')).toBeGreaterThan(30)
  })

  it('holds a graph with no edges at all together with gravity alone', () => {
    const layout = createLayout({ nodes: ids(40), edges: [] })

    runUntilSettled(layout)
    const box = layoutBounds(layout)

    // The test that matters is that this terminates at a finite size: without
    // gravity, mutual repulsion in a disconnected graph never stops expanding.
    expect(Math.max(box.maxX - box.minX, box.maxY - box.minY)).toBeLessThan(4000)
  })

  it('keeps a shorter edge kind shorter than a longer one', () => {
    const layout = createLayout(
      {
        nodes: [{ id: 'note' }, { id: 'todo' }, { id: 'far' }],
        edges: [
          { from: 'note', to: 'todo', length: 40, strength: 0.1 },
          { from: 'note', to: 'far', length: 120, strength: 0.045 },
        ],
      },
      forcesOnly,
    )

    runUntilSettled(layout)

    expect(apart(layout, 'note', 'todo')).toBeLessThan(apart(layout, 'note', 'far'))
  })
})

describe('settling', () => {
  /**
   * A ring with chords: every node is pulled by neighbours that disagree, which
   * is what a real note graph looks like and what a chain deliberately is not.
   * This shape does not converge under damping alone -- measured, its peak speed
   * plateaus and stays there -- so it is the case the cooling schedule exists
   * for, and the one worth asserting on.
   */
  const frustrated = (count: number) => ({
    nodes: ids(count),
    edges: Array.from({ length: Math.round(count * 1.4) }, (_, i) => ({
      from: `n${i % count}`,
      to: `n${(i * 7 + 3) % count}`,
    })),
  })

  it('reaches stillness well inside the tick budget', () => {
    const layout = createLayout({
      nodes: ids(40),
      edges: Array.from({ length: 39 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    })

    const ticks = runUntilSettled(layout)

    expect(ticks).toBeLessThan(layout.options.maxTicks)
    expect(isExhausted(layout)).toBe(false)
  })

  /**
   * Steps for the heat to fall from 1 to `alphaMin`, solved rather than
   * observed.
   *
   * Derived on purpose. A literal here would be a number that happened to pass
   * on the day it was written, and would go quietly stale the moment anyone
   * tuned the schedule -- still green, no longer meaning anything. Computed from
   * the options, it keeps asserting the same property whatever the constants
   * become, and it fails loudly if the decay stops being geometric.
   */
  const coolingSteps = (layout: Layout) =>
    Math.ceil(Math.log(layout.options.alphaMin) / Math.log(1 - layout.options.alphaDecay))

  it.each([40, 300, 1000])('stops on a %i-node graph that never finds an equilibrium', (count) => {
    const layout = createLayout(frustrated(count))

    const ticks = runUntilSettled(layout)

    // By cooling or by going still -- never by hitting the tick ceiling, which
    // is a backstop rather than the mechanism.
    expect(ticks).toBeLessThanOrEqual(coolingSteps(layout))
    expect(isExhausted(layout)).toBe(false)
  })

  it('bounds how long it can run by the cooling schedule, whatever the graph', () => {
    // Four hundred times the nodes, and two shapes that behave completely
    // differently: a chain relaxes into an equilibrium, a chorded ring never
    // does. Neither may outlast the schedule.
    const graphs = [
      createLayout(frustrated(5)),
      createLayout(frustrated(200)),
      createLayout(frustrated(2000)),
      createLayout({
        nodes: ids(200),
        edges: Array.from({ length: 199 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
      }),
    ]

    for (const layout of graphs) {
      runUntilSettled(layout)

      expect(layout.ticks).toBeLessThanOrEqual(coolingSteps(layout))
      // And it really did stop for a reason, rather than the harness giving up.
      expect(
        layout.alpha <= layout.options.alphaMin || layout.stillFor >= layout.options.settleSteps,
      ).toBe(true)
    }
  })

  it('runs the heat down geometrically, so the bound above is the real one', () => {
    const layout = createLayout(frustrated(50))
    const { alphaDecay, alphaMin } = layout.options

    expect(layout.alpha).toBe(1)

    step(layout)
    expect(layout.alpha).toBeCloseTo(1 - alphaDecay, 12)

    step(layout)
    expect(layout.alpha).toBeCloseTo((1 - alphaDecay) ** 2, 12)

    for (let i = layout.ticks; i < coolingSteps(layout); i += 1) step(layout)
    expect(layout.alpha).toBeLessThanOrEqual(alphaMin)
  })

  it('starts a barely-changed rebuild cool, so a save nudges instead of reshuffling', () => {
    const first = createLayout(frustrated(50))
    runUntilSettled(first)

    const settled = layoutPositions(first)
    const withOneMore = {
      nodes: [...ids(50), { id: 'new-todo' }],
      edges: [...frustrated(50).edges, { from: 'n3', to: 'new-todo' }],
    }

    const nudged = createLayout(withOneMore, {}, settled)
    const cold = createLayout(withOneMore)

    expect(nudged.alpha).toBeLessThan(0.35)
    expect(cold.alpha).toBe(1)

    // And therefore stops far sooner, which is the point: the picture was
    // already right and only needed somewhere to put one new node.
    expect(runUntilSettled(nudged)).toBeLessThan(runUntilSettled(cold))
  })

  it('anneals properly when a rebuild replaces most of the graph', () => {
    const wholesale = createLayout(
      frustrated(50),
      {},
      // Positions for nodes that are almost all gone: an import, not a save.
      new Map([['n0', { x: 0, y: 0 }]]),
    )

    expect(wholesale.alpha).toBeGreaterThan(0.9)
  })

  it('needs several consecutive still steps, not one', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
      { settleSteps: 5 },
      placed({ a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }),
    )

    step(layout)
    expect(isSettled(layout)).toBe(false)
  })

  it('gives up rather than running forever', () => {
    // A tick budget of one is the same shape as a graph that oscillates
    // instead of converging: the loop has to end either way, because an
    // animation frame that never stops is a flat battery on an idle tab.
    const layout = createLayout({ nodes: ids(10), edges: [] }, { maxTicks: 1, settleSteps: 1000 })

    step(layout)

    expect(isSettled(layout)).toBe(true)
    expect(isExhausted(layout)).toBe(true)
  })

  it('treats an empty graph as already settled', () => {
    const layout = createLayout({ nodes: [], edges: [] })

    expect(isSettled(layout)).toBe(true)
    expect(layoutBounds(layout)).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 })
  })

  it('settles a single node without dividing by anything', () => {
    const layout = createLayout({ nodes: [{ id: 'only' }], edges: [] })

    runUntilSettled(layout)

    expect(Number.isFinite(at(layout, 'only').x)).toBe(true)
  })
})

describe('numerical safety', () => {
  it('separates nodes that start at exactly the same point', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] },
      {},
      placed({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 } }),
    )

    run(layout, 120)

    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }

    expect(apart(layout, 'a', 'b')).toBeGreaterThan(0)
    expect(apart(layout, 'b', 'c')).toBeGreaterThan(0)
  })

  it('stays finite when a spring has zero length and no slack', () => {
    const layout = createLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b', length: 0, strength: 1 }],
      },
      {},
      placed({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }),
    )

    run(layout, 60)

    expect(Number.isFinite(at(layout, 'a').x)).toBe(true)
    expect(Number.isFinite(at(layout, 'b').y)).toBe(true)
  })

  it('never lets a node exceed the speed ceiling', () => {
    const layout = createLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', strength: 40 }] },
      { maxSpeed: 24 },
      placed({ a: { x: -900, y: 0 }, b: { x: 900, y: 0 } }),
    )

    for (let i = 0; i < 80; i += 1) {
      expect(step(layout)).toBeLessThanOrEqual(24 + 1e-9)
    }
  })
})

describe('Barnes-Hut approximation', () => {
  const graph = {
    nodes: ids(300),
    edges: Array.from({ length: 299 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  }

  it('computes nearly the same forces as the exact pairwise sum it replaces', () => {
    const exact = createLayout(graph, { exactBelow: 0, theta: 0 })
    const approximate = createLayout(graph, { exactBelow: 0, theta: 0.5 })

    // Compared before either has taken a step, so both are evaluating forces at
    // exactly the same positions and the only difference left is the
    // approximation itself. Stepping first would mix in how far two chaotic
    // systems drift apart, which is a different question.
    let error = 0
    let total = 0

    for (const node of exact.nodes) {
      const other = at(approximate, node.id)
      error += (node.ax - other.ax) ** 2 + (node.ay - other.ay) ** 2
      total += node.ax ** 2 + node.ay ** 2
    }

    // Root-mean-square across the whole graph rather than the worst single
    // node: a node sitting where the forces nearly cancel has a tiny reference
    // value, so its relative error is enormous and means nothing.
    expect(Math.sqrt(error / total)).toBeLessThan(0.05)
  })

  it('produces a picture the same size as the exact sum would', () => {
    const exact = createLayout(graph, { exactBelow: 0, theta: 0 })
    const approximate = createLayout(graph, { exactBelow: 0, theta: 0.5 })

    runUntilSettled(exact)
    runUntilSettled(approximate)

    // Node-for-node agreement is not on offer and is not the claim: a force
    // simulation is chaotic, so a fraction of a percent of force error puts
    // individual nodes somewhere else entirely. What has to hold is that the
    // layout comes out at the same scale, because that is what someone looking
    // at it would notice.
    const a = layoutBounds(exact)
    const b = layoutBounds(approximate)
    const spread = (box: typeof a) => Math.max(box.maxX - box.minX, box.maxY - box.minY)

    expect(spread(b) / spread(a)).toBeGreaterThan(0.75)
    expect(spread(b) / spread(a)).toBeLessThan(1.35)
  })

  it('lays out a graph past the exact threshold without producing NaN', () => {
    const big = createLayout({
      nodes: ids(1000),
      edges: Array.from({ length: 1400 }, (_, i) => ({
        from: `n${i % 1000}`,
        to: `n${(i * 7 + 3) % 1000}`,
      })),
    })

    run(big, 60)

    expect(big.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
    expect(Number.isFinite(big.peakSpeed)).toBe(true)
  })
})

describe('layoutPositions', () => {
  it('round-trips into a rebuild unchanged', () => {
    const first = createLayout({
      nodes: ids(12),
      edges: [
        { from: 'n0', to: 'n1' },
        { from: 'n1', to: 'n2' },
      ],
    })
    run(first, 50)

    const second = createLayout(
      {
        nodes: ids(12),
        edges: [
          { from: 'n0', to: 'n1' },
          { from: 'n1', to: 'n2' },
        ],
      },
      {},
      layoutPositions(first),
    )

    expect(layoutPositions(second)).toEqual(layoutPositions(first))
  })
})
