import { Suspense } from 'react'

import type { OpenTarget } from '../features/graph/graph-scene'
import { useMediaQuery } from '../shared/use-media-query'
import { useWorkspaceStore } from '../shared/workspace-store'
import { LazyGraphView } from './graph-chunk'

/**
 * The whole graph, beside the editor.
 *
 * The same view `/graph` renders, in a column -- not a different, smaller
 * graph. Two graphs that disagree about what the notes look like would be two
 * things to keep true, and the one on the right is the one you glance at while
 * writing, so it has to be the same picture you would get by opening the route.
 *
 * Clicking a node here just opens it in the editor next to it, which is the
 * whole point of the panel and the reason `GraphView` takes the behaviour as a
 * prop: on the route the identical click has to leave the page instead.
 */
export function GraphPanel() {
  const open = useWorkspaceStore((state) => state.graphPanelOpen)
  const room = useHasRoomForGraph()

  // Not merely hidden by CSS: a closed panel must not fetch the chunk, mount a
  // simulation, or hold a subscription to the index. Rotating a phone into
  // landscape is enough to satisfy the media query, so the preference alone is
  // not enough to go on.
  if (!open || !room) return null

  return (
    <aside className="app__graph" aria-label="Note graph">
      <Suspense fallback={<p className="app__graph-loading">Loading graph…</p>}>
        <LazyGraphView className="graph--panel" onOpen={openInEditor} />
      </Suspense>
    </aside>
  )
}

function openInEditor(target: OpenTarget): void {
  void useWorkspaceStore
    .getState()
    .openNote(target.path, target.line === undefined ? undefined : { line: target.line })
}

/**
 * Whether there is room for the panel at all.
 *
 * Below this the editor would be squeezed into a column narrower than the
 * sidebar, and a force-directed graph in what is left is a smudge. The phone
 * still has `/graph`, where it gets the whole screen -- which is the right
 * shape for it there, and the reason the route is staying.
 *
 * Exported because the header's toggle and the panel itself have to agree, and
 * a second breakpoint written out by hand is how they stop agreeing.
 */
export function useHasRoomForGraph(): boolean {
  return useMediaQuery('(min-width: 64rem)')
}
