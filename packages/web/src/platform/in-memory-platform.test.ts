import { assertNotePath, FORCE_WRITE, type FileChangeEvent } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { InMemoryPlatform } from './in-memory-platform'

const p = assertNotePath

/** Change events are delivered out of band; give the microtask queue a turn. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function collect(platform: InMemoryPlatform): FileChangeEvent[] {
  const events: FileChangeEvent[] = []
  platform.subscribeToChanges((event) => events.push(event))
  return events
}

describe('InMemoryPlatform tree', () => {
  it('derives directories from file paths, directories first and name sorted', async () => {
    const platform = new InMemoryPlatform({
      files: { 'zebra.md': 'z', 'inbox.md': 'i', 'journal/2026-08-01.md': 'j' },
    })

    const tree = await platform.tree()

    expect(tree.map((entry) => entry.name)).toEqual(['journal', 'inbox.md', 'zebra.md'])

    const journal = tree[0]
    if (journal?.kind !== 'directory') throw new Error('expected a directory first')
    expect(journal.children.map((entry) => entry.path)).toEqual(['journal/2026-08-01.md'])
  })

  it('sorts numerically so note-2 precedes note-10', async () => {
    const platform = new InMemoryPlatform({
      files: { 'note-10.md': '', 'note-2.md': '', 'note-1.md': '' },
    })

    const tree = await platform.tree()
    expect(tree.map((entry) => entry.name)).toEqual(['note-1.md', 'note-2.md', 'note-10.md'])
  })

  it('keeps a directory created explicitly even while it is empty', async () => {
    const platform = new InMemoryPlatform()
    await platform.createDirectory(p('archive'))

    const tree = await platform.tree()
    expect(tree).toEqual([{ kind: 'directory', path: 'archive', name: 'archive', children: [] }])
  })
})

describe('InMemoryPlatform write', () => {
  it('creates a note when the client expects nothing to be there', async () => {
    const platform = new InMemoryPlatform()

    const outcome = await platform.write(p('new.md'), 'hello', null)

    expect(outcome.ok).toBe(true)
    expect(await platform.read(p('new.md'))).toMatchObject({ content: 'hello' })
  })

  it('refuses a create when something already exists', async () => {
    const platform = new InMemoryPlatform({ files: { 'taken.md': 'theirs' } })

    const outcome = await platform.write(p('taken.md'), 'mine', null)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.conflict.kind).toBe('already-exists')
    // The caller needs the current metadata to offer "take theirs".
    expect(outcome.actual?.hash).toBeDefined()
  })

  it('refuses a stale update and leaves the file untouched', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'original' } })
    const opened = await platform.read(p('note.md'))
    if (opened === null) throw new Error('seed missing')

    platform.simulateExternalWrite(p('note.md'), 'nvim got here first')

    const outcome = await platform.write(p('note.md'), 'my edit', opened.hash)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.conflict.kind).toBe('stale')
    expect(await platform.read(p('note.md'))).toMatchObject({ content: 'nvim got here first' })
  })

  it('reports a note deleted underneath rather than silently recreating it', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'original' } })
    const opened = await platform.read(p('note.md'))
    if (opened === null) throw new Error('seed missing')

    platform.simulateExternalDelete(p('note.md'))

    const outcome = await platform.write(p('note.md'), 'my edit', opened.hash)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.conflict.kind).toBe('deleted-underneath')
  })

  it('clobbers on FORCE_WRITE, which is what "keep mine" resolves to', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'theirs' } })

    const outcome = await platform.write(p('note.md'), 'mine', FORCE_WRITE)

    expect(outcome.ok).toBe(true)
    expect(await platform.read(p('note.md'))).toMatchObject({ content: 'mine' })
  })

  it('changes the hash when the content changes and keeps it stable otherwise', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'a' } })
    const first = await platform.read(p('note.md'))

    platform.simulateExternalWrite(p('note.md'), 'a')
    const unchanged = await platform.read(p('note.md'))

    platform.simulateExternalWrite(p('note.md'), 'b')
    const changed = await platform.read(p('note.md'))

    expect(unchanged?.hash).toBe(first?.hash)
    expect(changed?.hash).not.toBe(first?.hash)
  })
})

describe('InMemoryPlatform change events', () => {
  it('tags its own writes as api so the editor can ignore the echo', async () => {
    const platform = new InMemoryPlatform()
    const events = collect(platform)

    await platform.write(p('note.md'), 'hello', null)
    await flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'created', path: 'note.md', origin: 'api' })
  })

  it('tags a simulated nvim write as terminal', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'a' } })
    const events = collect(platform)

    platform.simulateExternalWrite(p('note.md'), 'b')
    await flush()

    expect(events[0]).toMatchObject({
      kind: 'modified',
      origin: 'terminal',
      hash: expect.any(String),
    })
  })

  it('reports a deletion with a null hash', async () => {
    const platform = new InMemoryPlatform({ files: { 'note.md': 'a' } })
    const events = collect(platform)

    await platform.remove(p('note.md'))
    await flush()

    expect(events[0]).toMatchObject({ kind: 'deleted', hash: null })
  })

  it('stops delivering after unsubscribe', async () => {
    const platform = new InMemoryPlatform()
    const events: FileChangeEvent[] = []
    const unsubscribe = platform.subscribeToChanges((event) => events.push(event))

    unsubscribe()
    await platform.write(p('note.md'), 'hello', null)
    await flush()

    expect(events).toEqual([])
  })
})

describe('InMemoryPlatform move and remove', () => {
  it('moves a whole subtree', async () => {
    const platform = new InMemoryPlatform({
      files: { 'a/one.md': '1', 'a/nested/two.md': '2', 'b/other.md': '3' },
    })

    await platform.move(p('a'), p('archive/a'))

    expect(await platform.read(p('archive/a/nested/two.md'))).toMatchObject({ content: '2' })
    expect(await platform.read(p('a/one.md'))).toBeNull()
    expect(await platform.read(p('b/other.md'))).toMatchObject({ content: '3' })
  })

  it('refuses to move onto an existing path', async () => {
    const platform = new InMemoryPlatform({ files: { 'a.md': '1', 'b.md': '2' } })

    await expect(platform.move(p('a.md'), p('b.md'))).rejects.toThrow(/already exists/)
  })

  it('removes a directory and everything under it', async () => {
    const platform = new InMemoryPlatform({
      files: { 'a/one.md': '1', 'a/two.md': '2', 'keep.md': '3' },
    })

    await platform.remove(p('a'))

    expect(await platform.tree()).toEqual([
      { kind: 'file', path: 'keep.md', name: 'keep.md', size: 1, modifiedAt: expect.any(Number) },
    ])
  })
})

describe('InMemoryPlatform search', () => {
  const platform = new InMemoryPlatform({
    files: {
      'one.md': 'alpha\nBETA\ngamma',
      'nested/two.md': 'beta again',
    },
  })

  it('matches case insensitively by default and reports 1-indexed positions', async () => {
    const hits = await platform.search({ pattern: 'beta' })

    expect(hits).toEqual([
      { path: 'nested/two.md', line: 1, column: 1, preview: 'beta again' },
      { path: 'one.md', line: 2, column: 1, preview: 'BETA' },
    ])
  })

  it('honours caseSensitive', async () => {
    const hits = await platform.search({ pattern: 'beta', caseSensitive: true })
    expect(hits.map((hit) => hit.path)).toEqual(['nested/two.md'])
  })

  it('honours regex and the under filter', async () => {
    const hits = await platform.search({ pattern: '^g.mma$', regex: true, under: p('nested') })
    expect(hits).toEqual([])

    const all = await platform.search({ pattern: '^g.mma$', regex: true })
    expect(all.map((hit) => hit.line)).toEqual([3])
  })

  it('stops at the limit', async () => {
    const hits = await platform.search({ pattern: 'a', limit: 1 })
    expect(hits).toHaveLength(1)
  })
})
