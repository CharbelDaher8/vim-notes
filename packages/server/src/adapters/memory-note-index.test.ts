import {
  assertNotePath as notePath,
  type FileChangeEvent,
  type FileChangeKind,
  type FileWatcher,
  type NoteGraph,
  type NotePath,
  type Unsubscribe,
} from '@vim-notes/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryNoteStore } from './in-memory-note-store'
import { MemoryNoteIndex } from './memory-note-index'

/**
 * Drives change events by hand. The real watcher's debouncing and origin
 * detection are its own problem and have their own tests; what matters here is
 * what the index does with an event once it arrives.
 */
class FakeFileWatcher implements FileWatcher {
  private readonly listeners = new Set<(event: FileChangeEvent) => void>()

  subscribe(listener: (event: FileChangeEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.listeners.clear()
  }

  emit(kind: FileChangeKind, path: NotePath): void {
    for (const listener of [...this.listeners]) {
      listener({ kind, path, hash: null, at: Date.now(), origin: 'unknown' })
    }
  }
}

/** Counts what the index actually touches, which is the performance claim. */
class CountingNoteStore extends InMemoryNoteStore {
  reads = 0
  walks = 0

  override async tree() {
    this.walks += 1
    return super.tree()
  }

  override async read(path: NotePath) {
    this.reads += 1
    return super.read(path)
  }
}

/** Lets the fire-and-forget update chain finish without leaning on timers. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 100; tick++) await Promise.resolve()
}

async function build(files: Record<string, string>): Promise<{
  store: CountingNoteStore
  watcher: FakeFileWatcher
  index: MemoryNoteIndex
}> {
  const store = new CountingNoteStore()
  await store.seed(files)

  const watcher = new FakeFileWatcher()
  const index = await MemoryNoteIndex.start(store, watcher)

  return { store, watcher, index }
}

/** Writes a note and tells the index about it, as the watcher would. */
async function save(
  store: CountingNoteStore,
  watcher: FakeFileWatcher,
  path: string,
  content: string,
): Promise<void> {
  await store.seed({ [path]: content })
  watcher.emit('modified', notePath(path))
  await settle()
}

async function remove(
  store: CountingNoteStore,
  watcher: FakeFileWatcher,
  path: string,
): Promise<void> {
  await store.remove(notePath(path))
  watcher.emit('deleted', notePath(path))
  await settle()
}

function labelsOf(graph: NoteGraph, kind: string): string[] {
  return graph.nodes
    .filter((node) => node.kind === kind)
    .map((node) => node.label)
    .sort()
}

function idsOf(graph: NoteGraph, kind: string): string[] {
  return graph.nodes
    .filter((node) => node.kind === kind)
    .map((node) => node.id)
    .sort()
}

describe('MemoryNoteIndex annotations', () => {
  it('finds todos and reminders and dates them from the filename', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': 'TODO call the bank\nReminder: standup at nine\n',
      'projects/roadmap.md': 'TODO ship the graph view\n',
    })

    const records = await index.annotations()

    expect(records).toEqual([
      {
        kind: 'todo',
        text: 'call the bank',
        line: 1,
        done: null,
        due: null,
        path: 'journal/2026-08-02.md',
        day: '2026-08-02',
      },
      {
        kind: 'reminder',
        text: 'standup at nine',
        line: 2,
        done: null,
        due: null,
        path: 'journal/2026-08-02.md',
        day: '2026-08-02',
      },
      // Still a task, just with no day to hang off in the graph.
      {
        kind: 'todo',
        text: 'ship the graph view',
        line: 1,
        done: null,
        due: null,
        path: 'projects/roadmap.md',
        day: null,
      },
    ])
  })

  it('orders newest day first and undated notes last', async () => {
    const { index } = await build({
      'journal/2026-08-01.md': 'TODO older\n',
      'journal/2026-08-03.md': 'TODO newer\n',
      'inbox.md': 'TODO undated\n',
    })

    expect((await index.annotations()).map((record) => record.text)).toEqual([
      'newer',
      'older',
      'undated',
    ])
  })

  it('takes the useful end of the list when a limit is given', async () => {
    const { index } = await build({
      'journal/2026-08-01.md': 'TODO older\n',
      'journal/2026-08-03.md': 'TODO newer\n',
    })

    expect((await index.annotations({ limit: 1 })).map((record) => record.text)).toEqual(['newer'])
  })

  it('filters by kind and by day', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': 'TODO a task\nReminder a reminder\n',
      'journal/2026-08-03.md': 'TODO another task\n',
    })

    expect((await index.annotations({ kind: 'reminder' })).map((r) => r.text)).toEqual([
      'a reminder',
    ])
    expect((await index.annotations({ day: '2026-08-03' })).map((r) => r.text)).toEqual([
      'another task',
    ])
  })

  it('hides ticked items but keeps ones that were never asked', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': '- [x] TODO ticked\n- [ ] TODO open\nTODO bare\n',
    })

    expect((await index.annotations({ includeDone: false })).map((r) => r.text)).toEqual([
      'open',
      'bare',
    ])
    expect(await index.annotations()).toHaveLength(3)
  })

  it('ignores files that are not markdown', async () => {
    const { index } = await build({
      'attachments/diagram.png': 'TODO not really a task\n',
      'notes.md': 'TODO a real one\n',
    })

    expect((await index.annotations()).map((r) => r.text)).toEqual(['a real one'])
  })
})

describe('MemoryNoteIndex resolve', () => {
  let index: MemoryNoteIndex

  beforeEach(async () => {
    ;({ index } = await build({
      'projects/roadmap.md': '',
      'archive/roadmap.md': '',
      'inbox.md': '',
      'journal/2026-08-02.md': '',
    }))
  })

  it('takes an exact path first', async () => {
    expect(await index.resolve('projects/roadmap.md')).toBe('projects/roadmap.md')
  })

  it('completes a path written without its extension', async () => {
    expect(await index.resolve('archive/roadmap')).toBe('archive/roadmap.md')
  })

  it('takes a unique basename, however it is capitalised', async () => {
    expect(await index.resolve('inbox')).toBe('inbox.md')
    expect(await index.resolve('Inbox.md')).toBe('inbox.md')
  })

  it('refuses to guess between two notes with the same name', async () => {
    // Picking one would send someone to the wrong note and look like a bug in
    // their own filing.
    expect(await index.resolve('roadmap')).toBeNull()
  })

  it('returns null for a note that does not exist', async () => {
    expect(await index.resolve('someday')).toBeNull()
  })

  it('refuses a target that tries to leave the notes root', async () => {
    expect(await index.resolve('../../.ssh/id_rsa')).toBeNull()
  })
})

describe('MemoryNoteIndex links', () => {
  it('reports outbound links, resolved and not', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': 'see [[roadmap|the plan]] and [[nothing-here]]\n',
      'projects/roadmap.md': '',
    })

    expect(await index.outboundLinks(notePath('journal/2026-08-02.md'))).toEqual([
      {
        from: 'journal/2026-08-02.md',
        to: 'projects/roadmap.md',
        target: 'roadmap',
        label: 'the plan',
        line: 1,
      },
      {
        from: 'journal/2026-08-02.md',
        to: null,
        target: 'nothing-here',
        label: 'nothing-here',
        line: 1,
      },
    ])
  })

  it('finds backlinks written as a basename or as a full path', async () => {
    const { index } = await build({
      'projects/roadmap.md': '',
      'journal/2026-08-01.md': '[[roadmap]]\n',
      'journal/2026-08-02.md': 'x\n[[projects/roadmap.md]]\n',
      'journal/2026-08-03.md': '[[unrelated]]\n',
    })

    expect(await index.backlinks(notePath('projects/roadmap.md'))).toEqual([
      {
        from: 'journal/2026-08-01.md',
        to: 'projects/roadmap.md',
        target: 'roadmap',
        label: 'roadmap',
        line: 1,
      },
      {
        from: 'journal/2026-08-02.md',
        to: 'projects/roadmap.md',
        target: 'projects/roadmap.md',
        label: 'projects/roadmap.md',
        line: 2,
      },
    ])
  })

  it('drops a backlink once its bare name becomes ambiguous', async () => {
    const { store, watcher, index } = await build({
      'projects/roadmap.md': '',
      'journal/2026-08-01.md': '[[roadmap]]\n',
    })

    expect(await index.backlinks(notePath('projects/roadmap.md'))).toHaveLength(1)

    await save(store, watcher, 'archive/roadmap.md', '')

    // The link text did not change; what it means did. A second roadmap.md
    // makes the bare name name nothing.
    expect(await index.backlinks(notePath('projects/roadmap.md'))).toEqual([])
    expect(await index.resolve('roadmap')).toBeNull()
  })

  it('resolves a link once its target is finally written', async () => {
    const { store, watcher, index } = await build({
      'journal/2026-08-02.md': '[[someday]]\n',
    })

    expect(await index.outboundLinks(notePath('journal/2026-08-02.md'))).toMatchObject([
      { to: null },
    ])

    await save(store, watcher, 'someday.md', 'here at last\n')

    expect(await index.outboundLinks(notePath('journal/2026-08-02.md'))).toMatchObject([
      { to: 'someday.md' },
    ])
  })
})

describe('MemoryNoteIndex graph', () => {
  it('joins notes, days, todos and reminders', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': 'TODO call the bank\nsee [[roadmap]]\n',
      'projects/roadmap.md': 'Reminder review this\n',
    })

    const graph = await index.graph()

    expect(labelsOf(graph, 'day')).toEqual(['2026-08-02'])
    expect(labelsOf(graph, 'note')).toEqual(['2026-08-02', 'roadmap'])
    expect(labelsOf(graph, 'todo')).toEqual(['call the bank'])
    expect(labelsOf(graph, 'reminder')).toEqual(['review this'])

    const todo = graph.nodes.find((node) => node.kind === 'todo')
    expect(todo?.day).toBe('2026-08-02')

    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-02.md',
      to: 'note:projects/roadmap.md',
      kind: 'link',
    })
    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-02.md',
      to: 'day:2026-08-02',
      kind: 'day',
    })
    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-02.md',
      to: todo?.id ?? '',
      kind: 'contains',
    })
    expect(graph.edges).toContainEqual({ from: todo?.id ?? '', to: 'day:2026-08-02', kind: 'day' })

    // A reminder in a note that is not a daily has no day to belong to.
    const reminder = graph.nodes.find((node) => node.kind === 'reminder')
    expect(reminder?.day).toBeNull()
    expect(graph.edges.filter((edge) => edge.from === reminder?.id)).toEqual([])
  })

  it('keeps an unresolved link visible rather than dropping it', async () => {
    const { index } = await build({
      'journal/2026-08-02.md': 'see [[someday]]\n',
    })

    const graph = await index.graph()

    const missing = graph.nodes.find((node) => node.path === null && node.kind === 'note')
    expect(missing).toMatchObject({ label: 'someday', path: null, day: null })

    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-02.md',
      to: missing?.id ?? '',
      kind: 'unresolved',
    })

    // Every edge must have both ends present, or a layout silently drops it --
    // which is exactly what the 'unresolved' kind exists to prevent.
    const ids = new Set(graph.nodes.map((node) => node.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })

  it('draws one edge for two links to the same note', async () => {
    const { index } = await build({
      'a.md': '[[b]]\nand again [[b]]\n',
      'b.md': '',
    })

    const graph = await index.graph()
    expect(graph.edges.filter((edge) => edge.kind === 'link')).toHaveLength(1)
  })

  it('gives an identical graph after a rebuild', async () => {
    const { store, watcher, index } = await build({
      'journal/2026-08-02.md': 'TODO call the bank\nsee [[roadmap]] and [[missing]]\n',
      'projects/roadmap.md': 'Reminder review this\n',
    })

    // Incremental updates leave the maps in a different order than a fresh walk
    // does, which is the thing most likely to break "rebuild is a no-op".
    await save(store, watcher, 'journal/2026-08-02.md', 'TODO call the bank\nsee [[roadmap]]\n')
    await save(
      store,
      watcher,
      'journal/2026-08-02.md',
      'TODO call the bank\nsee [[roadmap]] and [[missing]]\n',
    )

    const before = await index.graph()
    await index.rebuild()

    expect(await index.graph()).toEqual(before)
  })

  it('keeps annotation ids when a line is inserted above them', async () => {
    const { store, watcher, index } = await build({
      'journal/2026-08-02.md': 'TODO alpha\nTODO beta\n',
    })

    const before = idsOf(await index.graph(), 'todo')

    await save(store, watcher, 'journal/2026-08-02.md', 'a heading\nTODO alpha\nTODO beta\n')

    // Ids off line numbers would have renumbered both and made the layout jump.
    expect(idsOf(await index.graph(), 'todo')).toEqual(before)
  })

  it('distinguishes the same task written twice in one note', async () => {
    const { index } = await build({ 'journal/2026-08-02.md': 'TODO alpha\nTODO alpha\n' })

    expect(idsOf(await index.graph(), 'todo')).toHaveLength(2)
  })
})

describe('MemoryNoteIndex staying current', () => {
  it('re-reads only the note that changed', async () => {
    const { store, watcher, index } = await build({
      'a.md': 'TODO one\n',
      'b.md': 'TODO two\n',
      'c.md': 'TODO three\n',
    })

    const readsAfterBuild = store.reads
    const walksAfterBuild = store.walks

    await save(store, watcher, 'a.md', 'TODO one changed\n')

    expect(store.reads - readsAfterBuild).toBe(1)
    // The whole point: a save must not walk the tree again.
    expect(store.walks).toBe(walksAfterBuild)

    expect((await index.annotations()).map((record) => record.text)).toContain('one changed')
  })

  it('drops a deleted note from annotations, links and the graph', async () => {
    const { store, watcher, index } = await build({
      'projects/roadmap.md': 'TODO ship it\n',
      'journal/2026-08-02.md': 'see [[roadmap]]\n',
    })

    await remove(store, watcher, 'projects/roadmap.md')

    expect(await index.annotations()).toEqual([])
    expect(await index.resolve('roadmap')).toBeNull()
    expect(await index.backlinks(notePath('projects/roadmap.md'))).toEqual([])
    expect(await index.outboundLinks(notePath('projects/roadmap.md'))).toEqual([])

    const graph = await index.graph()
    expect(graph.nodes.some((node) => node.path === 'projects/roadmap.md')).toBe(false)

    // The link that pointed at it is now visibly missing rather than gone.
    expect(graph.edges.filter((edge) => edge.kind === 'unresolved')).toHaveLength(1)
  })

  it('drops a deleted note as a source of backlinks too', async () => {
    const { store, watcher, index } = await build({
      'target.md': '',
      'source.md': '[[target]]\n',
    })

    expect(await index.backlinks(notePath('target.md'))).toHaveLength(1)

    await remove(store, watcher, 'source.md')
    expect(await index.backlinks(notePath('target.md'))).toEqual([])
  })

  it('lands a rename as one note moving, in either event order', async () => {
    for (const deleteFirst of [true, false]) {
      const { store, watcher, index } = await build({ 'old.md': 'TODO keep me\n' })

      await store.move(notePath('old.md'), notePath('new.md'))

      // The watcher reports a rename as a delete and a create, and the two can
      // arrive in either order.
      const rename: [FileChangeKind, string][] = [
        ['deleted', 'old.md'],
        ['created', 'new.md'],
      ]

      for (const [kind, path] of deleteFirst ? rename : [...rename].reverse()) {
        watcher.emit(kind, notePath(path))
      }
      await settle()

      const records = await index.annotations()
      expect(records).toHaveLength(1)
      expect(records[0]?.path).toBe('new.md')
    }
  })

  it('picks up a note created after the first build', async () => {
    const { store, watcher, index } = await build({ 'a.md': '' })

    await save(store, watcher, 'journal/2026-08-02.md', 'TODO fresh\n')

    expect((await index.annotations()).map((record) => record.text)).toEqual(['fresh'])
    expect(labelsOf(await index.graph(), 'day')).toEqual(['2026-08-02'])
  })

  it('does not lose a change that landed during a rebuild', async () => {
    const { store, watcher, index } = await build({ 'a.md': 'TODO before\n' })

    // Hold the rebuild open *after* it has read the old content, so the write
    // below is unambiguously one the walk cannot see. Without the missed-path
    // set the swap would then quietly reinstate 'before'.
    let releaseRead = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve
    })

    const realRead = store.read.bind(store)
    let gated = true
    store.read = async (path: NotePath) => {
      const document = await realRead(path)
      if (gated) {
        gated = false
        await held
      }
      return document
    }

    const rebuilding = index.rebuild()
    await settle()

    await store.seed({ 'a.md': 'TODO after\n' })
    watcher.emit('modified', notePath('a.md'))

    releaseRead()
    await rebuilding
    await settle()

    expect((await index.annotations()).map((record) => record.text)).toEqual(['after'])
  })

  it('ignores events after close', async () => {
    const { store, watcher, index } = await build({ 'a.md': 'TODO before\n' })

    index.close()
    await save(store, watcher, 'a.md', 'TODO after\n')

    expect((await index.annotations()).map((record) => record.text)).toEqual(['before'])
  })

  it('keeps answering when the store fails to build', async () => {
    const store = new CountingNoteStore()
    await store.seed({ 'a.md': 'TODO one\n' })

    const watcher = new FakeFileWatcher()
    const errors: unknown[] = []
    const index = await MemoryNoteIndex.start(store, watcher, {
      onError: (error) => errors.push(error),
    })

    store.tree = () => Promise.reject(new Error('disk went away'))

    // The explicit caller learns it failed...
    await expect(index.rebuild()).rejects.toThrow('disk went away')

    // ...and queries carry on against what was last known rather than hanging
    // or rejecting forever.
    expect((await index.annotations()).map((record) => record.text)).toEqual(['one'])
    expect(errors).toEqual([])
  })
})
