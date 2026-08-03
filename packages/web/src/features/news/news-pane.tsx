/**
 * The feed, as a column you can read down.
 *
 * Ranked by the aggregator and rendered in the order it gives them -- there is
 * no sort control here on purpose, because the ranking is the product and a
 * client-side reorder would quietly discard it (see the NewsFeed port).
 *
 * The only thing this pane does that a browser tab would not is `Save`, which
 * writes the item into today's note. That is the reason the feed is in this app
 * at all rather than in a bookmark.
 */
import type { NewsCategory, NewsItem } from '@vim-notes/core'
import { useState } from 'react'

import { Check, LinkIcon } from '../../shared/ui/icons'
import { useNewsActions, useNewsFeed, useNewsStatus } from './use-news'

import './news.css'

const CATEGORIES: { value: NewsCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ai', label: 'AI' },
  { value: 'security', label: 'Security' },
  { value: 'tech', label: 'Tech' },
  { value: 'repos', label: 'Repos' },
]

export function NewsPane() {
  const [category, setCategory] = useState<NewsCategory | 'all'>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)

  const { data: status, isPending: statusPending } = useNewsStatus()
  const query = {
    ...(category === 'all' ? {} : { category }),
    ...(unreadOnly ? { unreadOnly: true } : {}),
  }
  const { data: items, error, isPending } = useNewsFeed(query)

  if (statusPending) return <p className="news__notice">Looking for the feed…</p>

  // Not an error state. A deployment without the aggregator is a supported
  // deployment, and this is what it looks like.
  if (status?.available !== true) {
    return (
      <div className="news__notice">
        <p className="news__notice-title">No news service here.</p>
        <p>
          The aggregator is a separate application. When it is running and <code>NEWS_API_URL</code>{' '}
          points at it, its feed appears here.
        </p>
      </div>
    )
  }

  return (
    <section className="news" aria-label="News">
      <header className="news__filters">
        <div className="news__categories" role="group" aria-label="Category">
          {CATEGORIES.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className="news__filter"
              aria-pressed={category === entry.value}
              onClick={() => setCategory(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="news__filter"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((value) => !value)}
        >
          Unread
        </button>
      </header>

      {error !== null ? (
        <p className="news__notice" role="alert">
          {error.message}
        </p>
      ) : isPending ? (
        <p className="news__notice">Reading the feed…</p>
      ) : items.length === 0 ? (
        <p className="news__notice">Nothing here — try a different filter.</p>
      ) : (
        <ol className="news__list">
          {items.map((item) => (
            <NewsRow key={item.id} item={item} />
          ))}
        </ol>
      )}

      <footer className="news__footer">
        {status.items} items, {status.enriched} scored
        {status.lastRun === null ? null : ` · refreshed ${relative(status.lastRun)}`}
      </footer>
    </section>
  )
}

function NewsRow({ item }: { item: NewsItem }) {
  const { setRead, toggleSaved, save } = useNewsActions()
  const [savedTo, setSavedTo] = useState<string | null>(null)

  return (
    <li className="news__item" data-read={item.read || undefined}>
      <div className="news__head">
        {item.score === null ? (
          // Not zero, and not blank: "fetched but not scored yet" is a real
          // state between a refresh and the LLM pass, and it is the one most
          // easily rendered as a very bad score.
          <span className="news__score" data-unscored="" title="Not scored yet">
            –
          </span>
        ) : (
          <span className="news__score" data-top={item.isTop || undefined}>
            {item.score}
          </span>
        )}

        <a
          className="news__title"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          // Opening it is reading it. Doing this on click rather than making
          // people mark it afterwards is the difference between a feed that
          // stays current and one that fills with things you have read.
          onClick={() => setRead.mutate({ id: item.id, read: true })}
        >
          {item.title}
        </a>
      </div>

      <p className="news__meta">
        {item.source}
        {item.signalLabel === '' ? null : ` · ${item.signalLabel}`}
        {` · ${item.category}`}
        {item.topReason === null ? null : <span className="news__reason"> · {item.topReason}</span>}
      </p>

      {item.summary === null ? null : <p className="news__summary">{item.summary}</p>}

      <div className="news__actions">
        <button
          type="button"
          className="news__action"
          aria-pressed={item.saved}
          onClick={() => toggleSaved.mutate(item.id)}
        >
          {item.saved ? 'Saved' : 'Save for later'}
        </button>

        <button
          type="button"
          className="news__action"
          disabled={save.isPending}
          onClick={() => {
            save.mutate(item.id, {
              onSuccess: (result) => setSavedTo(result.path),
            })
          }}
        >
          <LinkIcon size={12} />
          {savedTo === null ? 'Add to today' : 'Added'}
        </button>

        {savedTo === null ? null : (
          <span className="news__saved-to">
            <Check size={12} /> {savedTo}
          </span>
        )}

        <button
          type="button"
          className="news__action news__action--quiet"
          onClick={() => setRead.mutate({ id: item.id, read: !item.read })}
        >
          {item.read ? 'Unread' : 'Read'}
        </button>
      </div>
    </li>
  )
}

/** Coarse on purpose: a feed refreshed once a day does not need minutes. */
function relative(seconds: number): string {
  const hours = Math.round((Date.now() / 1000 - seconds) / 3600)

  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`

  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
