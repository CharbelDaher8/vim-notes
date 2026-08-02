import { assertNotePath as notePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { hashContent } from './content-hash'
import { InMemoryNoteStore } from './in-memory-note-store'
import { describeNoteStoreContract } from './note-store-contract'

describeNoteStoreContract('InMemoryNoteStore', async () => new InMemoryNoteStore())

describe('InMemoryNoteStore', () => {
  it('seeds notes without a conflict check', async () => {
    const store = new InMemoryNoteStore()
    await store.seed({
      'inbox.md': 'todo',
      'work/standup.md': 'standup',
    })

    expect((await store.read(notePath('work/standup.md')))?.content).toBe('standup')
    expect((await store.stat(notePath('inbox.md')))?.hash).toBe(hashContent('todo'))
    // Seeding implies the directories, exactly as a write would.
    expect((await store.tree()).map((entry) => entry.name)).toEqual(['work', 'inbox.md'])
  })

  it('takes an injected clock, so tests need not sleep', async () => {
    let tick = 1_000
    const store = new InMemoryNoteStore({ now: () => (tick += 1_000) })

    await store.seed({ 'a.md': 'a' })
    await store.seed({ 'b.md': 'b' })

    expect((await store.stat(notePath('a.md')))?.modifiedAt).toBe(2_000)
    expect((await store.stat(notePath('b.md')))?.modifiedAt).toBe(3_000)
  })

  it('keeps two stores independent', async () => {
    const one = new InMemoryNoteStore()
    const two = new InMemoryNoteStore()

    await one.seed({ 'note.md': 'one' })

    expect(await two.read(notePath('note.md'))).toBeNull()
    expect(await two.tree()).toEqual([])
  })
})
