/**
 * The right-hand dock, as arithmetic.
 *
 * A list of panels sharing one column, each with a share of its height, and the
 * column with a width. Every operation here is a pure function from one layout
 * to the next: adding, removing, moving, and the two kinds of resize.
 *
 * Kept separate from the component for the reason the graph's force layout is:
 * "does dragging a divider up by 40px take exactly 40px from the panel above
 * and give it to the one below, and does the panel at the bottom stay put?" is
 * a question about numbers, and answering it by dragging things in a browser is
 * slow and forgettable. dock-model.test.ts asserts it instead.
 *
 * Sizes are *fractions of the column*, not pixels, and always sum to 1. Pixels
 * would mean every window resize needs a reflow pass with rounding to reconcile,
 * and a dock whose panels drift by a pixel each time it is resized.
 */

export type DockPanelId = 'graph' | 'news' | 'terminal'

export const DOCK_PANEL_IDS: readonly DockPanelId[] = ['graph', 'news', 'terminal']

export interface DockPanel {
  id: DockPanelId
  /** Fraction of the dock's height. All panels in a layout sum to 1. */
  size: number
}

export interface DockLayout {
  /** Fraction of the window given to the dock. */
  width: number
  panels: DockPanel[]
}

/**
 * Narrow enough that the editor keeps a usable measure on a laptop, wide enough
 * that a graph in the dock is a picture rather than a smudge.
 */
export const MIN_DOCK_WIDTH = 0.15
export const MAX_DOCK_WIDTH = 0.6
export const DEFAULT_DOCK_WIDTH = 0.26

/**
 * A panel may not be squeezed below this fraction of the dock.
 *
 * Without a floor, dragging a divider to the end collapses its neighbour to
 * nothing -- and a zero-height panel is invisible, still mounted, still holding
 * a pty or a simulation, and impossible to get back with the pointer because
 * there is nothing left to grab.
 */
export const MIN_PANEL_SIZE = 0.1

export const EMPTY_LAYOUT: DockLayout = { width: DEFAULT_DOCK_WIDTH, panels: [] }

export function isDocked(layout: DockLayout, id: DockPanelId): boolean {
  return layout.panels.some((panel) => panel.id === id)
}

/**
 * Add a panel, taking its room from the others in proportion.
 *
 * `at` inserts at a position, which is what a drop between two panels means.
 * Adding one that is already docked moves it instead, so dragging a link that
 * is already in the dock reorders rather than duplicating.
 */
export function addPanel(layout: DockLayout, id: DockPanelId, at?: number): DockLayout {
  if (isDocked(layout, id)) return movePanel(layout, id, at ?? layout.panels.length)

  const share = 1 / (layout.panels.length + 1)
  const scaled = layout.panels.map((panel) => ({ ...panel, size: panel.size * (1 - share) }))
  const index = clampIndex(at ?? scaled.length, scaled.length)

  return {
    ...layout,
    panels: normalise([...scaled.slice(0, index), { id, size: share }, ...scaled.slice(index)]),
  }
}

export function removePanel(layout: DockLayout, id: DockPanelId): DockLayout {
  const panels = layout.panels.filter((panel) => panel.id !== id)
  // Width is deliberately kept. Closing the last panel and opening another
  // should give back the dock you had, not a default one.
  return { ...layout, panels: normalise(panels) }
}

export function togglePanel(layout: DockLayout, id: DockPanelId): DockLayout {
  return isDocked(layout, id) ? removePanel(layout, id) : addPanel(layout, id)
}

/** Move a docked panel to a new index, keeping every panel's size. */
export function movePanel(layout: DockLayout, id: DockPanelId, to: number): DockLayout {
  const from = layout.panels.findIndex((panel) => panel.id === id)
  if (from === -1) return layout

  const panels = [...layout.panels]
  const [moved] = panels.splice(from, 1)
  if (moved === undefined) return layout

  // Clamped against the list *after* removal, so dropping at the end lands at
  // the end rather than one past it.
  panels.splice(clampIndex(to > from ? to - 1 : to, panels.length), 0, moved)

  return { ...layout, panels }
}

/**
 * Drag the divider below `index` by `delta` (a fraction of the dock's height).
 *
 * Only the two panels either side move. The obvious alternative -- scale
 * everything below -- means grabbing one divider silently resizes panels the
 * pointer never touched, which feels like the layout is fighting back.
 */
export function resizePanel(layout: DockLayout, index: number, delta: number): DockLayout {
  const above = layout.panels[index]
  const below = layout.panels[index + 1]
  if (above === undefined || below === undefined) return layout

  // Clamped to what both neighbours can give, so a fast drag past the floor
  // stops at it rather than pushing the excess into the next panel along.
  const room = Math.max(
    -(above.size - MIN_PANEL_SIZE),
    Math.min(below.size - MIN_PANEL_SIZE, delta),
  )

  const panels = layout.panels.map((panel, at) => {
    if (at === index) return { ...panel, size: panel.size + room }
    if (at === index + 1) return { ...panel, size: panel.size - room }
    return panel
  })

  return { ...layout, panels }
}

export function resizeDock(layout: DockLayout, width: number): DockLayout {
  return { ...layout, width: clamp(width, MIN_DOCK_WIDTH, MAX_DOCK_WIDTH) }
}

/**
 * Read a layout that a previous version of this app wrote.
 *
 * The one place where "the shape changed between releases" is a real event
 * rather than a hypothetical, so anything unrecognised is dropped rather than
 * repaired: a dock that opens empty is a shrug, a dock that throws is a blank
 * page where the notes used to be.
 */
export function parseLayout(value: unknown): DockLayout {
  if (typeof value !== 'object' || value === null) return EMPTY_LAYOUT

  const raw = value as { width?: unknown; panels?: unknown }
  const width =
    typeof raw.width === 'number' && Number.isFinite(raw.width)
      ? clamp(raw.width, MIN_DOCK_WIDTH, MAX_DOCK_WIDTH)
      : DEFAULT_DOCK_WIDTH

  if (!Array.isArray(raw.panels)) return { width, panels: [] }

  const seen = new Set<DockPanelId>()
  const panels: DockPanel[] = []

  for (const entry of raw.panels) {
    if (typeof entry !== 'object' || entry === null) continue

    const { id, size } = entry as { id?: unknown; size?: unknown }
    if (!isPanelId(id) || seen.has(id)) continue

    seen.add(id)
    panels.push({
      id,
      size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : MIN_PANEL_SIZE,
    })
  }

  return { width, panels: normalise(panels) }
}

function isPanelId(value: unknown): value is DockPanelId {
  return typeof value === 'string' && (DOCK_PANEL_IDS as readonly string[]).includes(value)
}

/**
 * Rescale so the sizes sum to 1 exactly.
 *
 * Called after every structural change rather than trusted to arithmetic: sizes
 * are floats, adding and removing panels multiplies them, and a layout that
 * sums to 0.9999 leaves a sliver of background at the bottom of the dock that
 * grows every time somebody opens a panel.
 */
function normalise(panels: DockPanel[]): DockPanel[] {
  if (panels.length === 0) return []

  const total = panels.reduce((sum, panel) => sum + panel.size, 0)
  if (total <= 0) return panels.map((panel) => ({ ...panel, size: 1 / panels.length }))

  return panels.map((panel) => ({ ...panel, size: panel.size / total }))
}

function clamp(value: number, low: number, high: number): number {
  // NaN survives every comparison, so Math.min/max would pass it through into a
  // CSS length and collapse the dock with no clue why.
  if (Number.isNaN(value)) return low
  return Math.min(high, Math.max(low, value))
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length
  return Math.min(length, Math.max(0, Math.trunc(index)))
}
