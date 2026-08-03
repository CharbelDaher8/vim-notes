/**
 * A ranked feed of things worth reading, from somewhere else.
 *
 * The one port here that is not about notes, and the shape of it is chosen to
 * keep it that way. It offers a *ranked list* rather than a query language,
 * because the ranking is the product -- what outranks what, and the rule that
 * stops a day of CVE disclosures burying everything else -- and it lives in the
 * aggregator that computes it. A port with `orderBy` would be an invitation to
 * re-decide that here, in a second place, in a second language.
 *
 * Everything an implementation may be asked is therefore a filter over a list
 * whose order it did not choose.
 *
 * Nothing in this file knows the feed arrives over HTTP, or that anything
 * behind it is written in Python. The adapter knows; DECISIONS §6.
 */

export type NewsCategory = 'ai' | 'security' | 'tech' | 'repos'

export interface NewsItem {
  /** Stable across refreshes: a hash of the normalised URL. */
  id: string
  url: string
  title: string
  /** Human-readable, e.g. "Hacker News". */
  source: string
  sourceKey: string
  category: string
  author: string | null
  /** Unix seconds. Null when the source did not say. */
  published: number | null
  firstSeen: number
  /** Raw popularity number, with `signalLabel` saying how to render it. */
  signal: number
  signalLabel: string
  /**
   * Null until the LLM pass has scored it, which is a state worth rendering:
   * "not scored yet" is not "scored zero", and a fetch that ran without the
   * scoring pass produces a feed full of the former.
   */
  summary: string | null
  score: number | null
  isTop: boolean
  topReason: string | null
  read: boolean
  saved: boolean
}

export interface NewsQuery {
  category?: NewsCategory
  unreadOnly?: boolean
  savedOnly?: boolean
  /** How far back to look. */
  days?: number
  limit?: number
}

export interface NewsFeed {
  /** In rank order, as decided by the aggregator. */
  list(query?: NewsQuery): Promise<NewsItem[]>
  setRead(id: string, read: boolean): Promise<void>
  /** Returns the new state, because it toggles rather than sets. */
  toggleSaved(id: string): Promise<boolean>
  /**
   * Whether the feed can be reached at all.
   *
   * Part of the port rather than left to a failed `list`, because "the news
   * service is not running" is a thing the UI has to say calmly and often --
   * it is an optional service on a box that may not have it configured, and an
   * error toast is the wrong shape for an answer that is simply "not here".
   */
  status(): Promise<NewsStatus>
}

export interface NewsStatus {
  available: boolean
  /** Null when unavailable, or when no refresh has ever run. */
  lastRun: number | null
  items: number
  /** How many have been through the scoring pass. */
  enriched: number
}
