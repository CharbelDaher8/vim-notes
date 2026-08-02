import { lazy, Suspense } from 'react'

/**
 * Lazy for the same reason the terminal is: the graph carries a force
 * simulation and an SVG scene that nobody needs until they ask for the graph,
 * and the phone is the client that pays for anything left in the initial chunk
 * (DECISIONS.md §13).
 *
 * This must stay the only reference to the module. An eager import anywhere --
 * a barrel re-export, an `import type` written without `type` -- silently folds
 * it back into the main bundle, and nothing fails to make that visible.
 */
const GraphView = lazy(() =>
  import('../features/graph/graph-view').then((module) => ({ default: module.GraphView })),
)

export function GraphRoute() {
  return (
    <Suspense fallback={<p className="route-loading">Loading graph…</p>}>
      <GraphView />
    </Suspense>
  )
}
