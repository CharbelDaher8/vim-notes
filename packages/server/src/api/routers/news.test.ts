import type { NewsFeed, NewsItem, NewsStatus } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { InMemoryNoteStore } from '../../adapters/in-memory-note-store'
import { appRouter } from '../router'
import { createCallerFactory, type AppContext } from '../trpc'

const ITEM: NewsItem = {
  id: 'abc',
  url: 'https://example.com/x',
  title: 'A thing happened',
  source: 'Hacker News',
  sourceKey: 'hn',
  category: 'ai',
  author: null,
  published: null,
  firstSeen: 0,
  signal: 842,
  signalLabel: '842 pts',
  summary: 'Someone found something.',
  score: 88,
  isTop: false,
  topReason: null,
  read: false,
  saved: false,
}

/** Records what it was told, so the router's side effects are assertable. */
class FakeNewsFeed implements NewsFeed {
  readonly marked: { id: string; read: boolean }[] = []

  constructor(private readonly items: NewsItem[] = [ITEM]) {}

  async list(): Promise<NewsItem[]> {
    return this.items
  }

  async setRead(id: string, read: boolean): Promise<void> {
    this.marked.push({ id, read })
  }

  async toggleSaved(): Promise<boolean> {
    return true
  }

  async status(): Promise<NewsStatus> {
    return { available: true, lastRun: null, items: this.items.length, enriched: 0 }
  }
}

async function callerFor(files: Record<string, string>, news = new FakeNewsFeed()) {
  const notes = new InMemoryNoteStore()
  await notes.seed(files)

  return {
    caller: createCallerFactory(appRouter)({ notes, news } as unknown as AppContext),
    notes,
    news,
  }
}

describe('save', () => {
  it('creates today’s journal note when there is not one yet', async () => {
    const { caller, notes } = await callerFor({ 'inbox.md': '# Inbox\n' })

    const result = await caller.news.save({ id: 'abc', date: '2026-08-03' })

    expect(result).toMatchObject({ path: 'journal/2026-08-03.md', created: true })
    const written = await notes.read(result.path)
    expect(written?.content).toContain('# 2026-08-03')
    expect(written?.content).toContain('[A thing happened](https://example.com/x)')
    expect(written?.content).toContain('> Someone found something.')
  })

  it('appends to the day note that is already there', async () => {
    const { caller, notes } = await callerFor({
      'journal/2026-08-03.md': '# 2026-08-03\n\nWrote some notes.\n',
    })

    await caller.news.save({ id: 'abc', date: '2026-08-03' })

    const written = await notes.read('journal/2026-08-03.md' as never)
    expect(written?.content).toMatch(/Wrote some notes\.\n\n- \[A thing happened]/)
    // Exactly once, and the original heading is not duplicated.
    expect(written?.content.match(/# 2026-08-03/g)).toHaveLength(1)
  })

  /** The point of inferring rather than hardcoding `journal/`. */
  it('follows wherever the day notes already live', async () => {
    const { caller } = await callerFor({
      'daily/2026-08-01.md': '# 2026-08-01\n',
      'daily/2026-08-02.md': '# 2026-08-02\n',
    })

    const result = await caller.news.save({ id: 'abc', date: '2026-08-03' })

    expect(result.path).toBe('daily/2026-08-03.md')
  })

  it('writes where it is told when given a path', async () => {
    const { caller } = await callerFor({ 'reading.md': '# Reading\n' })

    const result = await caller.news.save({
      id: 'abc',
      date: '2026-08-03',
      path: 'reading.md',
    })

    expect(result).toMatchObject({ path: 'reading.md', created: false })
  })

  it('marks a saved item read, because saving is reading', async () => {
    const { caller, news } = await callerFor({})

    await caller.news.save({ id: 'abc', date: '2026-08-03' })

    expect(news.marked).toEqual([{ id: 'abc', read: true }])
  })

  /**
   * The item is looked up in the feed rather than taken from the request. A
   * client that could supply the title and URL could write arbitrary markdown
   * into a note through a field that looks like a lookup key.
   */
  it('refuses an id the feed does not have', async () => {
    const { caller, notes } = await callerFor({})

    await expect(caller.news.save({ id: 'not-there', date: '2026-08-03' })).rejects.toThrow(
      /no longer in the feed/,
    )
    expect(await notes.tree()).toEqual([])
  })

  it('refuses a path that escapes the notes root', async () => {
    const { caller } = await callerFor({})

    await expect(
      caller.news.save({ id: 'abc', date: '2026-08-03', path: '../../etc/passwd' }),
    ).rejects.toThrow()
  })

  it('rejects a date that is not a calendar day', async () => {
    const { caller } = await callerFor({})

    await expect(caller.news.save({ id: 'abc', date: 'today' })).rejects.toThrow()
  })

  it('still writes the note when marking it read fails', async () => {
    class Failing extends FakeNewsFeed {
      override async setRead(): Promise<void> {
        throw new Error('news is down')
      }
    }

    const { caller, notes } = await callerFor({}, new Failing())

    const result = await caller.news.save({ id: 'abc', date: '2026-08-03' })

    expect((await notes.read(result.path))?.content).toContain('A thing happened')
  })

  it('leaves an unscored item without a score line rather than writing zero', async () => {
    const unscored = { ...ITEM, score: null, summary: null, signalLabel: '' }
    const { caller, notes } = await callerFor({}, new FakeNewsFeed([unscored]))

    const result = await caller.news.save({ id: 'abc', date: '2026-08-03' })
    const written = await notes.read(result.path)

    expect(written?.content).not.toContain('score')
    expect(written?.content).not.toContain('>')
    expect(written?.content).toContain('ai')
  })
})

describe('status', () => {
  it('passes the feed’s own answer through', async () => {
    const { caller } = await callerFor({})

    expect(await caller.news.status()).toMatchObject({ available: true })
  })
})
