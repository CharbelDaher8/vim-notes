import { assertNotePath, type GraphEdge, type GraphNode, type NoteGraph } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { createLayout } from './force-layout'
import { buildScene, openTargetFor, truncateLabel, type SceneNode } from './graph-scene'

const p = assertNotePath

const node = (over: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind'>): GraphNode => ({
  label: over.id,
  path: null,
  line: null,
  day: null,
  done: null,
  ...over,
})

const graph = (nodes: GraphNode[], edges: GraphEdge[] = []): NoteGraph => ({ nodes, edges })

const find = (nodes: SceneNode[], id: string): SceneNode => {
  const found = nodes.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no node ${id} in scene`)
  return found
}

describe('node kinds', () => {
  const mixed = () =>
    buildScene(
      graph([
        node({ id: 'n', kind: 'note', path: p('a.md') }),
        node({ id: 'd', kind: 'day', day: '2026-08-02' }),
        node({ id: 't', kind: 'todo', path: p('a.md'), line: 3 }),
        node({ id: 'r', kind: 'reminder', path: p('a.md'), line: 4 }),
      ]),
    )

  it('gives every kind its own silhouette, so colour is never the only signal', () => {
    const shapes = mixed().nodes.map((entry) => entry.shape)

    expect(shapes).toEqual(['circle', 'ring', 'square', 'triangle'])
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  it('uses fewer colours than kinds, so the two channels stay independent', () => {
    // Todos and reminders share a tone and differ by shape. The point is that
    // someone who cannot tell the tones apart still sees four kinds.
    const scene = mixed()

    expect(find(scene.nodes, 't').tone).toBe(find(scene.nodes, 'r').tone)
    expect(find(scene.nodes, 'n').tone).not.toBe(find(scene.nodes, 'd').tone)
  })

  it('marks a ticked todo done, and an unticked one not', () => {
    const scene = buildScene(
      graph([
        node({ id: 'open', kind: 'todo', path: p('a.md'), done: false }),
        node({ id: 'shut', kind: 'todo', path: p('a.md'), done: true }),
        // `null` is "the line has no checkbox at all", which reads as not done.
        node({ id: 'bare', kind: 'todo', path: p('a.md'), done: null }),
      ]),
    )

    expect(find(scene.nodes, 'open').done).toBe(false)
    expect(find(scene.nodes, 'shut').done).toBe(true)
    expect(find(scene.nodes, 'bare').done).toBe(false)
    expect(find(scene.nodes, 'shut').tone).toBe('done')
    expect(find(scene.nodes, 'open').tone).toBe('task')
  })

  it('says what a node is, for anyone hearing it rather than seeing it', () => {
    const scene = mixed()

    expect(find(scene.nodes, 't').description).toBe('Todo in a.md: t')
    expect(find(scene.nodes, 'd').description).toBe('Day d')
  })

  it('grows a note with its connections but stops before it swallows the view', () => {
    const leaves = Array.from({ length: 60 }, (_, i) =>
      node({ id: `leaf${i}`, kind: 'note', path: p(`leaf${i}.md`) }),
    )
    const edges: GraphEdge[] = leaves.map((leaf) => ({ from: 'hub', to: leaf.id, kind: 'link' }))

    const scene = buildScene(
      graph([node({ id: 'hub', kind: 'note', path: p('hub.md') }), ...leaves], edges),
    )

    const hub = find(scene.nodes, 'hub')
    const leaf = find(scene.nodes, 'leaf0')

    expect(hub.radius).toBeGreaterThan(leaf.radius)
    expect(hub.radius).toBeLessThan(leaf.radius * 3)
  })
})

describe('unresolved links', () => {
  it('reads a pathless note as a note that does not exist yet', () => {
    const scene = buildScene(graph([node({ id: 'ghost', kind: 'note', label: 'Roadmap' })]))

    expect(find(scene.nodes, 'ghost').missing).toBe(true)
    expect(find(scene.nodes, 'ghost').description).toContain('no note by this name yet')
  })

  it('also reads the far end of an unresolved edge as missing', () => {
    // Belt and braces: the index may model a phantom target either way, and
    // neither reading should produce a node that looks like an ordinary note.
    const scene = buildScene(
      graph(
        [
          node({ id: 'from', kind: 'note', path: p('a.md') }),
          node({ id: 'ghost', kind: 'note', path: p('somehow.md') }),
        ],
        [{ from: 'from', to: 'ghost', kind: 'unresolved' }],
      ),
    )

    expect(find(scene.nodes, 'ghost').missing).toBe(true)
  })

  it('holds an unresolved link further out and more loosely than a real one', () => {
    const scene = buildScene(
      graph(
        [
          node({ id: 'a', kind: 'note', path: p('a.md') }),
          node({ id: 'b', kind: 'note', path: p('b.md') }),
          node({ id: 'ghost', kind: 'note' }),
        ],
        [
          { from: 'a', to: 'b', kind: 'link' },
          { from: 'a', to: 'ghost', kind: 'unresolved' },
        ],
      ),
    )

    const link = scene.edges.find((edge) => edge.kind === 'link')
    const unresolved = scene.edges.find((edge) => edge.kind === 'unresolved')

    expect(unresolved?.strength).toBeLessThan(link?.strength ?? 0)
  })

  it('keeps an annotation tight against the note that contains it', () => {
    const scene = buildScene(
      graph(
        [
          node({ id: 'a', kind: 'note', path: p('a.md') }),
          node({ id: 'b', kind: 'note', path: p('b.md') }),
          node({ id: 't', kind: 'todo', path: p('a.md'), line: 2 }),
        ],
        [
          { from: 'a', to: 't', kind: 'contains' },
          { from: 'a', to: 'b', kind: 'link' },
        ],
      ),
    )

    const contains = scene.edges.find((edge) => edge.kind === 'contains')
    const link = scene.edges.find((edge) => edge.kind === 'link')

    expect(contains?.length).toBeLessThan(link?.length ?? 0)
  })
})

describe('graphs that do not fit the contract', () => {
  it('drops an edge naming a node that is not in the graph, and counts it', () => {
    const scene = buildScene(
      graph(
        [node({ id: 'a', kind: 'note', path: p('a.md') })],
        [
          { from: 'a', to: 'nowhere', kind: 'link' },
          { from: 'nowhere', to: 'a', kind: 'link' },
        ],
      ),
    )

    expect(scene.edges).toHaveLength(0)
    expect(scene.dangling).toBe(2)
  })

  it('drops a self-edge', () => {
    const scene = buildScene(
      graph(
        [node({ id: 'a', kind: 'note', path: p('a.md') })],
        [{ from: 'a', to: 'a', kind: 'link' }],
      ),
    )

    expect(scene.edges).toHaveLength(0)
  })

  it('keeps one node per id', () => {
    const scene = buildScene(
      graph([node({ id: 'a', kind: 'note' }), node({ id: 'a', kind: 'day' })]),
    )

    expect(scene.nodes).toHaveLength(1)
    expect(scene.totalNodes).toBe(1)
  })

  it('keeps both edges when a pair is connected two ways', () => {
    const scene = buildScene(
      graph(
        [
          node({ id: 'a', kind: 'note', path: p('a.md') }),
          node({ id: 't', kind: 'todo', path: p('a.md'), line: 9 }),
        ],
        [
          { from: 'a', to: 't', kind: 'contains' },
          { from: 'a', to: 't', kind: 'link' },
        ],
      ),
    )

    expect(scene.edges).toHaveLength(2)
  })

  it('collapses an edge repeated identically', () => {
    const scene = buildScene(
      graph(
        [
          node({ id: 'a', kind: 'note', path: p('a.md') }),
          node({ id: 'b', kind: 'note', path: p('b.md') }),
        ],
        [
          { from: 'a', to: 'b', kind: 'link' },
          { from: 'a', to: 'b', kind: 'link' },
        ],
      ),
    )

    expect(scene.edges).toHaveLength(1)
  })

  it('handles a graph with nothing in it', () => {
    expect(buildScene(graph([]))).toMatchObject({
      nodes: [],
      edges: [],
      totalNodes: 0,
      omitted: 0,
    })
  })
})

describe('graphs too big to draw', () => {
  const crowd = (count: number): NoteGraph => {
    const nodes = Array.from({ length: count }, (_, i) =>
      node({ id: `n${i}`, kind: 'note', path: p(`n${i}.md`) }),
    )
    // n0 is the hub; everything else has one link or none.
    const edges: GraphEdge[] = Array.from({ length: count - 1 }, (_, i) => ({
      from: 'n0',
      to: `n${i + 1}`,
      kind: 'link',
    }))

    return graph(nodes, edges)
  }

  it('draws the best-connected part and says how much it left out', () => {
    const scene = buildScene(crowd(500), { maxNodes: 100 })

    expect(scene.nodes).toHaveLength(100)
    expect(scene.totalNodes).toBe(500)
    expect(scene.omitted).toBe(400)
    expect(scene.nodes.some((entry) => entry.id === 'n0')).toBe(true)
  })

  it('keeps no edge pointing at a node it left out', () => {
    const scene = buildScene(crowd(500), { maxNodes: 100 })
    const drawn = new Set(scene.nodes.map((entry) => entry.id))

    for (const edge of scene.edges) {
      expect(drawn.has(edge.source)).toBe(true)
      expect(drawn.has(edge.target)).toBe(true)
    }
  })

  it('picks the same nodes every time, so a rebuild does not reshuffle the view', () => {
    const first = buildScene(crowd(500), { maxNodes: 100 })
    const second = buildScene(crowd(500), { maxNodes: 100 })

    expect(second.nodes.map((entry) => entry.id)).toEqual(first.nodes.map((entry) => entry.id))
  })

  it('drops the labels once there are more of them than the eye can use', () => {
    expect(buildScene(crowd(40), { labelLimit: 100 }).labelled).toBe(true)
    expect(buildScene(crowd(400), { labelLimit: 100 }).labelled).toBe(false)
  })
})

/**
 * The renderer writes positions onto elements by index rather than by id,
 * sixty times a second. That is only safe because a scene contains no duplicate
 * ids, no self-edges and no dangling edges -- which is exactly what
 * `createLayout` drops. If that ever stopped holding, every node in the graph
 * would be drawn at some other node's coordinates, which is the kind of bug
 * that looks like the physics being wrong.
 */
describe('the scene lines up with the layout built from it', () => {
  it('keeps every node and every edge, in order', () => {
    const scene = buildScene(
      graph(
        [
          node({ id: 'day', kind: 'day', day: '2026-08-02' }),
          node({ id: 'note', kind: 'note', path: p('journal/2026-08-02.md') }),
          node({ id: 'note', kind: 'note', path: p('duplicate.md') }),
          node({ id: 'todo', kind: 'todo', path: p('journal/2026-08-02.md'), line: 4 }),
          node({ id: 'ghost', kind: 'note' }),
        ],
        [
          { from: 'day', to: 'note', kind: 'day' },
          { from: 'note', to: 'todo', kind: 'contains' },
          { from: 'note', to: 'ghost', kind: 'unresolved' },
          { from: 'note', to: 'note', kind: 'link' },
          { from: 'note', to: 'vanished', kind: 'link' },
        ],
      ),
    )

    const layout = createLayout({
      nodes: scene.nodes,
      edges: scene.edges.map((edge) => ({ from: edge.source, to: edge.target })),
    })

    expect(layout.nodes.map((entry) => entry.id)).toEqual(scene.nodes.map((entry) => entry.id))
    expect(layout.springs).toHaveLength(scene.edges.length)

    for (const [index, spring] of layout.springs.entries()) {
      expect(spring.a.id).toBe(scene.edges[index]?.source)
      expect(spring.b.id).toBe(scene.edges[index]?.target)
    }
  })
})

describe('truncateLabel', () => {
  it('leaves a short label alone', () => {
    expect(truncateLabel('buy milk')).toBe('buy milk')
  })

  it('collapses the whitespace a wrapped markdown line leaves behind', () => {
    expect(truncateLabel('  buy   milk\t')).toBe('buy milk')
  })

  it('cuts a long one and marks that it was cut', () => {
    const short = truncateLabel('a'.repeat(80), 10)

    expect(short).toHaveLength(10)
    expect(short.endsWith('…')).toBe(true)
  })
})

describe('openTargetFor', () => {
  const scene = buildScene(
    graph([
      node({
        id: 't',
        kind: 'todo',
        label: 'buy milk',
        path: p('journal/2026-08-02.md'),
        line: 12,
      }),
      node({ id: 'r', kind: 'reminder', label: 'bins', path: p('journal/2026-08-02.md'), line: 3 }),
      node({ id: 'n', kind: 'note', label: 'roadmap', path: p('roadmap.md') }),
      node({ id: 'ghost', kind: 'note', label: 'not written yet' }),
      node({ id: 'd', kind: 'day', label: '2026-08-02', day: '2026-08-02' }),
      node({ id: 'odd', kind: 'todo', label: 'no line', path: p('a.md'), line: 0 }),
    ]),
  )

  it('opens a todo at its line', () => {
    expect(openTargetFor(find(scene.nodes, 't'))).toEqual({
      path: 'journal/2026-08-02.md',
      line: 12,
    })
  })

  it('opens a reminder at its line too', () => {
    expect(openTargetFor(find(scene.nodes, 'r'))?.line).toBe(3)
  })

  it('opens a note at the top, having no single line to point at', () => {
    expect(openTargetFor(find(scene.nodes, 'n'))).toEqual({ path: 'roadmap.md' })
  })

  it('opens the top of the note rather than passing on a line the editor cannot use', () => {
    expect(openTargetFor(find(scene.nodes, 'odd'))).toEqual({ path: 'a.md' })
  })

  it('has nowhere to go for a note that does not exist yet', () => {
    // Deliberately not "create it": a click that looks like navigation should
    // never write a file.
    expect(openTargetFor(find(scene.nodes, 'ghost'))).toBeNull()
  })

  it('has nowhere to go for a day with no note behind it', () => {
    expect(openTargetFor(find(scene.nodes, 'd'))).toBeNull()
  })
})
