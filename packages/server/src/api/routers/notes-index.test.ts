import type { FileWatcher, Unsubscribe } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { InMemoryNoteStore } from '../../adapters/in-memory-note-store'
import { MemoryNoteIndex } from '../../adapters/memory-note-index'
import { appRouter } from '../router'
import { createCallerFactory, type AppContext } from '../trpc'

/** Nothing here changes files, so the index never needs telling about one. */
class SilentFileWatcher implements FileWatcher {
  subscribe(): Unsubscribe {
    return () => {}
  }

  async close(): Promise<void> {}
}

/**
 * Only `index` is reachable from this router, so the other ports are left out
 * rather than stubbed. A stub that is never called is a stub that will rot.
 */
async function callerFor(files: Record<string, string>) {
  const store = new InMemoryNoteStore()
  await store.seed(files)

  const index = await MemoryNoteIndex.start(store, new SilentFileWatcher())

  return createCallerFactory(appRouter)({ index } as unknown as AppContext)
}

describe('index router', () => {
  it('lists annotations and honours the filter', async () => {
    const caller = await callerFor({
      'journal/2026-08-02.md': 'TODO call the bank\nReminder standup\n',
      'journal/2026-08-03.md': '- [x] TODO done already\n',
    })

    expect((await caller.index.annotations({})).map((record) => record.text)).toEqual([
      'done already',
      'call the bank',
      'standup',
    ])

    expect(
      (await caller.index.annotations({ kind: 'todo', includeDone: false })).map((r) => r.text),
    ).toEqual(['call the bank'])

    expect(
      (await caller.index.annotations({ day: '2026-08-02', limit: 1 })).map((r) => r.text),
    ).toEqual(['call the bank'])
  })

  it('returns links in both directions', async () => {
    const caller = await callerFor({
      'projects/roadmap.md': 'see [[nowhere]]\n',
      'journal/2026-08-02.md': '[[roadmap]]\n',
    })

    expect(await caller.index.backlinks({ path: 'projects/roadmap.md' })).toMatchObject([
      { from: 'journal/2026-08-02.md', to: 'projects/roadmap.md' },
    ])

    expect(await caller.index.outboundLinks({ path: 'projects/roadmap.md' })).toMatchObject([
      { target: 'nowhere', to: null },
    ])
  })

  it('returns the graph', async () => {
    const caller = await callerFor({ 'journal/2026-08-02.md': 'TODO call the bank\n' })

    const graph = await caller.index.graph()
    expect(graph.nodes.map((node) => node.kind).sort()).toEqual(['day', 'note', 'todo'])
  })

  it('rejects a day that is not a calendar date', async () => {
    const caller = await callerFor({})

    // 2026 is not a leap year, and a filter that silently matches nothing looks
    // exactly like a journal with no tasks in it.
    await expect(caller.index.annotations({ day: '2026-02-29' })).rejects.toThrow()
    await expect(caller.index.annotations({ day: 'yesterday' })).rejects.toThrow()
  })

  it('rejects a path that tries to leave the notes root', async () => {
    const caller = await callerFor({})

    await expect(caller.index.backlinks({ path: '../../.ssh/id_rsa' })).rejects.toThrow()
  })
})
