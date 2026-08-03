import { lazy } from 'react'

/**
 * The graph, as its own chunk, imported in exactly one place.
 *
 * Lazy for the same reason the terminal is: the graph carries a force
 * simulation and an SVG scene that nobody needs until they ask for it, and the
 * phone is the client that pays for anything left in the initial bundle
 * (DECISIONS.md §13).
 *
 * This module exists because there are now two mount sites -- the `/graph`
 * route and the panel beside the editor -- and the rule that keeps the chunk
 * split is fragile: one eager import anywhere, a barrel re-export, or an
 * `import type` written without the `type`, folds the whole thing back into the
 * main bundle, and nothing fails to make that visible. One shared `lazy` call
 * leaves exactly one place where that mistake can be made.
 */
export const LazyGraphView = lazy(() =>
  import('../features/graph/graph-view').then((module) => ({ default: module.GraphView })),
)
