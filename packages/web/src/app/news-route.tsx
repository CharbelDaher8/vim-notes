import { lazy, Suspense } from 'react'

/**
 * Lazy, like the graph and the terminal, and for the same reason: the phone
 * pays for anything in the initial chunk (DECISIONS §13), and a feed is
 * something you go and look at rather than something the workspace needs.
 *
 * This must stay the only reference to the module -- an eager import anywhere
 * folds it back into the main bundle, and nothing fails to make that visible.
 */
const NewsPane = lazy(() =>
  import('../features/news/news-pane').then((module) => ({ default: module.NewsPane })),
)

export function NewsRoute() {
  return (
    <div className="route-fill">
      <Suspense fallback={<p className="route-loading">Loading news…</p>}>
        <NewsPane />
      </Suspense>
    </div>
  )
}
