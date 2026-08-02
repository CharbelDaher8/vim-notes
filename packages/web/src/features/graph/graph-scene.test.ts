import { assertNotePath, type GraphEdge, type GraphNode, type NoteGraph } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { createLayout, isSettled, step } from './force-layout'
import {
  buildScene,
  estimateLabelWidth,
  LABEL_FONT_SIZE,
  LABEL_GAP,
  openTargetFor,
  truncateLabel,
  type Scene,
  type SceneNode,
} from './graph-scene'

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

  it('tells an ambiguous target apart from one that was never written', () => {
    // Resolution refuses to guess between two notes of the same name, so the
    // link comes back unresolved even though notes by that name exist. Saying
    // "no note by this name yet" to someone looking at two of them would read
    // as the app being broken.
    const scene = buildScene(
      graph(
        [
          node({ id: 'from', kind: 'note', label: 'today', path: p('journal/2026-08-02.md') }),
          node({ id: 'one', kind: 'note', label: 'roadmap', path: p('work/roadmap.md') }),
          node({ id: 'two', kind: 'note', label: 'roadmap', path: p('home/roadmap.md') }),
          node({ id: 'missing:roadmap', kind: 'note', label: 'roadmap' }),
          node({ id: 'missing:shed', kind: 'note', label: 'shed' }),
        ],
        [
          { from: 'from', to: 'missing:roadmap', kind: 'unresolved' },
          { from: 'from', to: 'missing:shed', kind: 'unresolved' },
        ],
      ),
    )

    const ambiguous = find(scene.nodes, 'missing:roadmap')
    const absent = find(scene.nodes, 'missing:shed')

    expect(ambiguous.missing).toBe(true)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.description).toContain('more than one note has this name')

    expect(absent.ambiguous).toBe(false)
    expect(absent.description).toContain('no note by this name yet')
  })

  it('matches an ambiguous name past the case the index lowercased away', () => {
    // Missing targets arrive normalised to lower case; a real note keeps the
    // capitals it was filed under. Comparing them literally would call every
    // ambiguous link absent.
    const scene = buildScene(
      graph(
        [
          node({ id: 'one', kind: 'note', label: 'Roadmap', path: p('work/Roadmap.md') }),
          node({ id: 'two', kind: 'note', label: 'Roadmap', path: p('home/Roadmap.md') }),
          node({ id: 'missing:roadmap', kind: 'note', label: 'roadmap' }),
        ],
        [{ from: 'one', to: 'missing:roadmap', kind: 'unresolved' }],
      ),
    )

    expect(find(scene.nodes, 'missing:roadmap').ambiguous).toBe(true)
  })

  it('does not call a link ambiguous because of a note the cap left out', () => {
    const nodes = [
      node({ id: 'hub', kind: 'note', label: 'hub', path: p('hub.md') }),
      node({ id: 'missing:roadmap', kind: 'note', label: 'roadmap' }),
      ...Array.from({ length: 30 }, (_, i) =>
        node({ id: `n${i}`, kind: 'note', label: 'roadmap', path: p(`folder${i}/roadmap.md`) }),
      ),
    ]

    const scene = buildScene(
      graph(nodes, [{ from: 'hub', to: 'missing:roadmap', kind: 'unresolved' }]),
      {
        maxNodes: 3,
      },
    )

    expect(find(scene.nodes, 'missing:roadmap').ambiguous).toBe(true)
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

describe('estimateLabelWidth', () => {
  it('grows with the text', () => {
    expect(estimateLabelWidth('ab', 10)).toBeGreaterThan(estimateLabelWidth('a', 10))
    expect(estimateLabelWidth('', 10)).toBe(0)
  })

  it('scales with the font size', () => {
    expect(estimateLabelWidth('hello', 20)).toBeCloseTo(estimateLabelWidth('hello', 10) * 2, 10)
  })

  it('knows an m is not an i', () => {
    // The whole reason not to multiply by a flat average: these differ by about
    // a factor of three, and reserving the same room for both would either
    // waste half the picture or put one label through another.
    expect(estimateLabelWidth('mmmm', 10)).toBeGreaterThan(estimateLabelWidth('iiii', 10) * 2)
  })

  it('errs wide rather than narrow on a realistic label', () => {
    // 10px system-ui renders "2026-08-02" at roughly 56px. Over-reserving looks
    // airy; under-reserving is the bug this exists to prevent.
    const estimate = estimateLabelWidth('2026-08-02', 10)

    expect(estimate).toBeGreaterThan(50)
    expect(estimate).toBeLessThan(75)
  })
})

describe('room for the label', () => {
  const withLabel = (label: string) =>
    buildScene(graph([node({ id: 'n', kind: 'note', label, path: p('n.md') })])).nodes[0]

  it('reserves width for the text, not just for the dot', () => {
    const long = withLabel('measure the bundle')
    const short = withLabel('a')

    expect(long?.spreadX).toBeGreaterThan((long?.radius ?? 0) * 3)
    expect(long?.spreadX).toBeGreaterThan(short?.spreadX ?? 0)
  })

  it('reserves height for a label that hangs below the node', () => {
    const labelled = withLabel('anything')

    expect(labelled?.spreadY).toBeGreaterThan((labelled?.radius ?? 0) + LABEL_GAP)
  })

  it('reserves nothing extra once the scene is too big to draw labels', () => {
    const crowded = buildScene(
      graph(
        Array.from({ length: 12 }, (_, i) =>
          node({ id: `n${i}`, kind: 'note', label: 'a fairly long name', path: p(`n${i}.md`) }),
        ),
      ),
      { labelLimit: 5 },
    )

    expect(crowded.labelled).toBe(false)
    for (const entry of crowded.nodes) {
      expect(entry.short).toBe('')
      // Down to the dot: nothing is drawn, so nothing needs keeping clear.
      expect(entry.spreadX).toBeLessThan(entry.radius + 10)
    }
  })
})

describe('labels that would only repeat their neighbour', () => {
  const daily = () =>
    buildScene(
      graph(
        [
          node({ id: 'day:2026-08-02', kind: 'day', label: '2026-08-02', day: '2026-08-02' }),
          node({
            id: 'note:journal/2026-08-02.md',
            kind: 'note',
            label: '2026-08-02',
            path: p('journal/2026-08-02.md'),
            day: '2026-08-02',
          }),
        ],
        [{ from: 'note:journal/2026-08-02.md', to: 'day:2026-08-02', kind: 'day' }],
      ),
    )

  it('draws a daily’s date once, on the day rather than on the file', () => {
    // A daily produces two nodes with the same name a few pixels apart. Drawing
    // both read as a rendering fault rather than as two different things.
    const scene = daily()

    expect(find(scene.nodes, 'day:2026-08-02').short).toBe('2026-08-02')
    expect(find(scene.nodes, 'note:journal/2026-08-02.md').short).toBe('')
  })

  it('keeps the full name for the tooltip and the screen reader', () => {
    const muted = find(daily().nodes, 'note:journal/2026-08-02.md')

    expect(muted.label).toBe('2026-08-02')
    expect(muted.description).toBe('Note journal/2026-08-02.md')
  })

  it('leaves two notes of the same name alone when nothing joins them', () => {
    // Same label, no edge between them: they are genuinely two different things
    // in two different places, and hiding either would be a lie.
    const scene = buildScene(
      graph([
        node({ id: 'a', kind: 'note', label: 'roadmap', path: p('work/roadmap.md') }),
        node({ id: 'b', kind: 'note', label: 'roadmap', path: p('home/roadmap.md') }),
      ]),
    )

    expect(find(scene.nodes, 'a').short).toBe('roadmap')
    expect(find(scene.nodes, 'b').short).toBe('roadmap')
  })
})

/**
 * The regression test for what a browser showed and no unit test had:
 * at a realistic size the labels landed on top of each other and the middle of
 * the picture read as a smudge. Everything above is a mechanism; this is the
 * property those mechanisms exist to produce.
 */
describe('a settled journal graph', () => {
  const journal = (dayCount = 2): Scene => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const days = Array.from(
      { length: dayCount },
      (_, i) =>
        `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    )
    const tasks = [
      'measure the bundle again after the graph lands',
      'conflict dialog: keep mine vs keep theirs wording',
      'the domain expires in November, renew it',
      'ring the plumber about the leak',
    ]

    days.forEach((day, index) => {
      const notePath = p(`journal/${day}.md`)
      nodes.push(node({ id: `day:${day}`, kind: 'day', label: day, day }))
      nodes.push(node({ id: `note:${day}`, kind: 'note', label: day, path: notePath, day }))
      edges.push({ from: `note:${day}`, to: `day:${day}`, kind: 'day' })

      for (let t = 0; t < 2; t += 1) {
        const id = `todo:${day}:${t}`
        const text = tasks[(index * 2 + t) % tasks.length] ?? 'something else'
        nodes.push({ ...node({ id, kind: 'todo', label: text, path: notePath, day }), line: t + 3 })
        edges.push({ from: `note:${day}`, to: id, kind: 'contains' })
        edges.push({ from: id, to: `day:${day}`, kind: 'day' })
      }

      nodes.push({
        ...node({
          id: `rem:${day}`,
          kind: 'reminder',
          label: 'standup at half nine',
          path: notePath,
          day,
        }),
        line: 9,
      })
      edges.push({ from: `note:${day}`, to: `rem:${day}`, kind: 'contains' })
    })

    for (const name of [
      'markdown',
      'bundle size',
      'tailscale',
      'roadmap',
      'plumbing',
      'codemirror',
    ]) {
      nodes.push(node({ id: `note:${name}`, kind: 'note', label: name, path: p(`${name}.md`) }))
      edges.push({ from: 'note:2026-08-01', to: `note:${name}`, kind: 'link' })
    }

    nodes.push(node({ id: 'missing:offline sync', kind: 'note', label: 'offline sync' }))
    edges.push({ from: 'note:roadmap', to: 'missing:offline sync', kind: 'unresolved' })

    return buildScene({ nodes, edges })
  }

  /**
   * Pairs of labels that read as one label.
   *
   * Deliberately not "pairs that overlap". Overlap was the first thing measured
   * here and it was the wrong thing: two words with a sliver of white space
   * between them do not overlap by any arithmetic and still read as a single
   * word -- `markdown` next to `inbox` is `markdownbox`. That was caught in a
   * browser, by eye, after this file reported the picture clean.
   *
   * So the test is a typographic one. If the rows overlap vertically and there
   * is less than an em of white between them, they run together, and a reader
   * cannot tell where one name ends.
   */
  const READS_AS_ONE_WORD = LABEL_FONT_SIZE

  const labelsRunningTogether = (scene: Scene): string[] => {
    const layout = createLayout({
      nodes: scene.nodes,
      edges: scene.edges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        length: edge.length,
        strength: edge.strength,
      })),
    })

    while (!isSettled(layout)) step(layout)

    const boxes = scene.nodes
      .filter((entry) => entry.short !== '')
      .map((entry) => {
        const placed = layout.byId.get(entry.id)
        if (placed === undefined) throw new Error(`no layout node for ${entry.id}`)
        return {
          label: entry.short,
          x: placed.x,
          y: placed.y + entry.radius + LABEL_GAP,
          halfWidth: estimateLabelWidth(entry.short, LABEL_FONT_SIZE) / 2,
          halfHeight: LABEL_FONT_SIZE / 2,
        }
      })

    const collisions: string[] = []
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const sameRow = Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight
        const whiteSpace = Math.abs(a.x - b.x) - (a.halfWidth + b.halfWidth)

        if (sameRow && whiteSpace < READS_AS_ONE_WORD) {
          collisions.push(`${a.label}${b.label} (${whiteSpace.toFixed(1)} apart)`)
        }
      }
    }

    return collisions
  }

  it('leaves no two labels reading as one', () => {
    expect(labelsRunningTogether(journal())).toEqual([])
  })

  it('keeps labels legible at a month, where a small graph is too easy to be a test', () => {
    // Sixteen nodes come out clean with any one of the four measures in place,
    // so that case cannot tell which is carrying the weight. A month cannot be
    // cleared by any single one: with the separation force removed this goes
    // from one pair to twenty-odd, which is what gives the assertion teeth.
    const scene = journal(30)
    const labels = scene.nodes.filter((entry) => entry.short !== '').length

    expect(labels).toBeGreaterThan(100)
    expect(labelsRunningTogether(scene).length).toBeLessThan(labels * 0.05)
  })

  it('keeps the widest label a small fraction of the whole picture', () => {
    const scene = journal()
    const layout = createLayout({
      nodes: scene.nodes,
      edges: scene.edges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        length: edge.length,
      })),
    })

    while (!isSettled(layout)) step(layout)

    const xs = layout.nodes.map((entry) => entry.x)
    const spread = Math.max(...xs) - Math.min(...xs)
    const widest = Math.max(
      ...scene.nodes.map((entry) => estimateLabelWidth(entry.short, LABEL_FONT_SIZE)),
    )

    // It was a third of the width when this read as a smudge. A label is a name
    // you glance at, not a column of text the graph has to be built around.
    expect(widest / spread).toBeLessThan(0.3)
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
