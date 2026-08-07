/**
 * Feeding derived data blocks, from React into CodeMirror and back out again.
 *
 * A chart widget is constructed by the editor, not by React, so it has no
 * context to read and no hook to call. This is the same module-level-slot
 * pattern `local-writes.ts` uses and for the same reason: what crosses the
 * boundary is a subscription, not render state, and putting it in a store would
 * re-render every subscriber whenever the editor rebuilt a widget.
 *
 * **Nothing is fetched until a chart asks.** A note with no `source:` block --
 * which is nearly all of them -- must not cost a query, so demand is counted
 * here and the provider hook enables its queries only while at least one widget
 * is subscribed. Opening a note with a budget pie starts the fetch; navigating
 * away from it stops the refetching.
 */
import type { SpendRecord } from '@vim-notes/core'

export interface ChartData {
  spends: SpendRecord[]
  /** Resolved once here so every block on the page agrees about it. */
  currency: string
}

type Listener = () => void

let snapshot: ChartData | null = null
const listeners = new Set<Listener>()
let onDemandChange: ((demanded: boolean) => void) | null = null

/** The current data, or null while nothing has been fetched yet. */
export function chartData(): ChartData | null {
  return snapshot
}

export function publishChartData(next: ChartData): void {
  snapshot = next
  for (const listener of [...listeners]) listener()
}

/**
 * Subscribe a widget, and register its demand.
 *
 * The returned function must be called from the widget's `destroy`, or the
 * queries keep refetching for a chart the editor has thrown away.
 */
export function subscribeChartData(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) onDemandChange?.(true)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) onDemandChange?.(false)
  }
}

/** Registered by the provider hook; there is exactly one at a time. */
export function setChartDemandListener(next: ((demanded: boolean) => void) | null): void {
  onDemandChange = next
  // A widget can subscribe before the provider mounts -- the editor renders
  // first -- so the current demand is replayed rather than waiting for the next
  // change, which might never come.
  if (next !== null && listeners.size > 0) next(true)
}

/** Test seam. Production has one provider and never needs this. */
export function resetChartData(): void {
  snapshot = null
  listeners.clear()
  onDemandChange = null
}
