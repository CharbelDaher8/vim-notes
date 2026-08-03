/**
 * NewsFeed over the aggregator's JSON API.
 *
 * The aggregator is a separate application in another language with its own
 * repository, and the only thing this file knows about it is four endpoints and
 * a wire shape. It is also *optional*: a deployment that never cloned it, or
 * one whose container is down, has to keep serving notes exactly as before.
 *
 * That optionality is what shapes the error handling here. `status()` answers
 * "is it there?" without throwing, because the client asks that question on
 * every page load and "not configured" is an ordinary answer rather than a
 * fault. The mutating calls do throw, because a save that silently did nothing
 * is worse than an error message.
 *
 * Every response is validated rather than cast. The producer is a Python
 * process that can be redeployed independently of this one, so "the shape
 * changed underneath us" is a real event and not a hypothetical -- and an
 * unvalidated cast turns it into `undefined` reaching a React component three
 * layers away.
 */
import type { NewsFeed, NewsItem, NewsQuery, NewsStatus } from '@vim-notes/core'
import { z } from 'zod'

export class NewsFeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * Short, because this is a sidebar on a page that has already rendered. A feed
 * that has not answered in three seconds is one the reader should be told
 * about, not one worth blocking on.
 */
const DEFAULT_TIMEOUT_MS = 3_000

const itemSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  sourceKey: z.string(),
  category: z.string(),
  author: z.string().nullable(),
  published: z.number().nullable(),
  firstSeen: z.number(),
  signal: z.number(),
  signalLabel: z.string(),
  summary: z.string().nullable(),
  score: z.number().nullable(),
  isTop: z.boolean(),
  topReason: z.string().nullable(),
  read: z.boolean(),
  saved: z.boolean(),
})

const feedSchema = z.object({ items: z.array(itemSchema), total: z.number() })

const healthSchema = z.object({
  ok: z.boolean(),
  items: z.number(),
  enriched: z.number(),
  lastRun: z.number().nullable(),
})

const savedSchema = z.object({ saved: z.boolean() })

export interface HttpNewsFeedOptions {
  /** Absent means no news service is configured, and `status` says so. */
  baseUrl?: string
  timeoutMs?: number
  /** Injected in tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

export class HttpNewsFeed implements NewsFeed {
  private readonly baseUrl: string | null
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: HttpNewsFeedOptions = {}) {
    const raw = options.baseUrl?.trim()
    // Trailing slashes are how `${base}/feed` becomes `//feed`, which some
    // servers answer and some do not.
    this.baseUrl = raw === undefined || raw === '' ? null : raw.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** True when an address was configured at all. Says nothing about reachability. */
  get configured(): boolean {
    return this.baseUrl !== null
  }

  async status(): Promise<NewsStatus> {
    const unavailable: NewsStatus = {
      available: false,
      lastRun: null,
      items: 0,
      enriched: 0,
    }

    if (this.baseUrl === null) return unavailable

    try {
      const health = healthSchema.parse(await this.request('GET', '/health'))
      return {
        available: health.ok,
        lastRun: health.lastRun,
        items: health.items,
        enriched: health.enriched,
      }
    } catch {
      // Deliberately swallowed, and the only place in this file that does.
      // Every reason this can fail -- not deployed, still starting, wrong
      // address, container stopped -- has the same answer for a caller, and
      // that answer is a field in the object rather than an exception.
      return unavailable
    }
  }

  async list(query: NewsQuery = {}): Promise<NewsItem[]> {
    const params = new URLSearchParams()
    if (query.category !== undefined) params.set('category', query.category)
    if (query.unreadOnly === true) params.set('unread', '1')
    if (query.savedOnly === true) params.set('saved', '1')
    if (query.days !== undefined) params.set('days', String(query.days))
    if (query.limit !== undefined) params.set('limit', String(query.limit))

    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return feedSchema.parse(await this.request('GET', `/feed${suffix}`)).items
  }

  async setRead(id: string, read: boolean): Promise<void> {
    await this.request('POST', `/items/${encodeURIComponent(id)}/read`, { read })
  }

  async toggleSaved(id: string): Promise<boolean> {
    const body = await this.request('POST', `/items/${encodeURIComponent(id)}/saved`)
    return savedSchema.parse(body).saved
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.baseUrl === null) {
      throw new NewsFeedError('no news service is configured; set NEWS_API_URL')
    }

    // `AbortSignal.timeout` rather than a hand-rolled race: a race leaves the
    // request running after the timeout fires, and on a page that polls, those
    // accumulate.
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }).catch((error: unknown) => {
      // Network-level failure, which for this service is the common one.
      throw new NewsFeedError(
        `could not reach the news service at ${this.baseUrl}: ${describe(error)}`,
      )
    })

    if (!response.ok) {
      throw new NewsFeedError(`news service answered ${response.status} for ${method} ${path}`)
    }

    try {
      return await response.json()
    } catch (error: unknown) {
      throw new NewsFeedError(`news service returned malformed JSON: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // A timeout arrives as a DOMException named TimeoutError, whose message is
    // "The operation was aborted due to timeout" -- true, and not what anyone
    // reading a log wants to work out.
    return error.name === 'TimeoutError' ? 'timed out' : error.message
  }
  return String(error)
}
