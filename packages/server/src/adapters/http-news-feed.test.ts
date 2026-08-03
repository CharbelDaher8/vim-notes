import { describe, expect, it } from 'vitest'

import { HttpNewsFeed, NewsFeedError } from './http-news-feed'

const ITEM = {
  id: 'abc',
  url: 'https://example.com/x',
  title: 'A thing happened',
  source: 'Hacker News',
  sourceKey: 'hn',
  category: 'ai',
  author: null,
  published: 1_700_000_000,
  firstSeen: 1_700_000_100,
  signal: 842,
  signalLabel: '842 pts',
  summary: 'Something about it.',
  score: 88,
  isTop: true,
  topReason: 'novel attack',
  read: false,
  saved: false,
}

/** A fetch that records what it was asked and answers with what it was given. */
function fakeFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; method: string; body: unknown }[] = []

  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })

    const result = handler(url, init)
    if (result instanceof Error) throw result

    const { status = 200, json = result } = (result ?? {}) as { status?: number; json?: unknown }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response
  }) as unknown as typeof globalThis.fetch

  return { impl, calls }
}

describe('status', () => {
  it('reports unavailable rather than throwing when nothing is configured', async () => {
    const feed = new HttpNewsFeed({})

    expect(await feed.status()).toEqual({
      available: false,
      lastRun: null,
      items: 0,
      enriched: 0,
    })
    expect(feed.configured).toBe(false)
  })

  /**
   * The property the whole error-handling design rests on. This runs on every
   * page load, on a box where the service is optional and may simply not be
   * there -- so "not deployed" has to be an ordinary answer and not an
   * exception something upstream has to catch.
   */
  it.each([
    ['the service is unreachable', new TypeError('fetch failed')],
    ['it answers 502', { status: 502, json: {} }],
    ['it answers something that is not the health shape', { json: { nonsense: true } }],
  ])('reports unavailable when %s', async (_name, response) => {
    const { impl } = fakeFetch(() => response)
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    expect((await feed.status()).available).toBe(false)
  })

  it('passes on what the service says when it is healthy', async () => {
    const { impl } = fakeFetch(() => ({
      json: { ok: true, items: 1305, enriched: 949, lastRun: 1_700_000_000 },
    }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    expect(await feed.status()).toEqual({
      available: true,
      items: 1305,
      enriched: 949,
      lastRun: 1_700_000_000,
    })
  })
})

describe('list', () => {
  it('asks for the whole ranked feed by default', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { items: [ITEM], total: 1 } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    const items = await feed.list()

    expect(calls[0]?.url).toBe('http://news:8787/feed')
    expect(items[0]?.title).toBe('A thing happened')
  })

  it('sends only the filters it was given', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { items: [], total: 0 } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    await feed.list({ category: 'security', unreadOnly: true, days: 3, limit: 20 })

    const url = new URL(calls[0]?.url ?? '')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: 'security',
      unread: '1',
      days: '3',
      limit: '20',
    })
    // False is not the same as absent: sending saved=0 would be asking the
    // service to interpret a flag it treats as presence-only.
    expect(url.searchParams.has('saved')).toBe(false)
  })

  /**
   * The producer is a separate application in another language, redeployed
   * independently. A cast would turn a renamed field into `undefined` arriving
   * in a React component three layers away.
   */
  it('refuses a response whose shape has drifted', async () => {
    const { impl } = fakeFetch(() => ({ json: { items: [{ id: 'abc' }], total: 1 } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    await expect(feed.list()).rejects.toThrow()
  })

  it('keeps an unscored item null rather than defaulting it', async () => {
    const { impl } = fakeFetch(() => ({
      json: { items: [{ ...ITEM, score: null, summary: null }], total: 1 },
    }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    const [item] = await feed.list()

    expect(item?.score).toBeNull()
    expect(item?.summary).toBeNull()
  })
})

describe('writes', () => {
  it('says which way it is marking an item', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { ok: true, read: false } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    await feed.setRead('abc', false)

    expect(calls[0]).toMatchObject({
      url: 'http://news:8787/items/abc/read',
      method: 'POST',
      body: { read: false },
    })
  })

  it('escapes an id rather than pasting it into a path', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { ok: true, saved: true } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    await feed.toggleSaved('../../admin')

    expect(calls[0]?.url).toBe('http://news:8787/items/..%2F..%2Fadmin/saved')
  })

  it('returns the new saved state, because it toggles', async () => {
    const { impl } = fakeFetch(() => ({ json: { ok: true, saved: true } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    expect(await feed.toggleSaved('abc')).toBe(true)
  })

  /** Unlike `status`, a write that failed must not look like it worked. */
  it('throws when the service rejects a write', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, json: { error: 'no such item' } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787', fetch: impl })

    await expect(feed.setRead('gone', true)).rejects.toThrow(NewsFeedError)
  })

  it('names the missing configuration rather than failing obscurely', async () => {
    const feed = new HttpNewsFeed({})

    await expect(feed.setRead('abc', true)).rejects.toThrow(/NEWS_API_URL/)
  })
})

describe('the base url', () => {
  it('tolerates a trailing slash', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { items: [], total: 0 } }))
    const feed = new HttpNewsFeed({ baseUrl: 'http://news:8787/', fetch: impl })

    await feed.list()

    expect(calls[0]?.url).toBe('http://news:8787/feed')
  })

  it('treats an empty setting as unconfigured', () => {
    expect(new HttpNewsFeed({ baseUrl: '   ' }).configured).toBe(false)
  })
})
