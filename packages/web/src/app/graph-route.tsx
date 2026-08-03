import { lazy, Suspense } from 'react'

// Type-only, and it has to stay that way: see the note on the lazy import
// below. `import type` is erased before the bundler sees it, so this costs
// nothing; dropping the keyword would pull the whole graph into the main chunk.
import type { OpenTarget } from '../features/graph/graph-scene'
import { noteHref } from './note-url'

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
    // GraphView is `height: 100%`, so something above it has to establish one.
    // It happens to resolve through #root today, but relying on that means the
    // graph silently collapses the first time this route is nested in anything.
    //
    // `--viewport-height` rather than 100dvh so the mobile keyboard shrinks it
    // the same way it does everywhere else; see use-visual-viewport.ts.
    <div className="route-fill">
      <Suspense fallback={<p className="route-loading">Loading graph…</p>}>
        <GraphView onOpen={openInWorkspace} />
      </Suspense>
    </div>
  )
}

/**
 * Clicking a node here leaves for the workspace, carrying the note in the URL.
 *
 * There is no editor on this route, so the store this used to write to had
 * nobody rendering it: clicking a node updated the window title and did nothing
 * else, which is the same "correct, tested, never connected" shape as the rest
 * of DECISIONS §6.
 *
 * A real navigation rather than a client-side transition, for the reason the
 * header links are: the graph's chunk and its simulation are dropped on the way
 * out rather than left resident behind the editor.
 */
function openInWorkspace(target: OpenTarget): void {
  window.location.assign(
    noteHref(target.path, target.line === undefined ? null : { line: target.line }),
  )
}
