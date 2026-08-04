/**
 * Dragging a panel into the dock, and dragging one within it.
 *
 * Pointer events rather than HTML5 drag-and-drop, for three reasons that all
 * bite here: HTML5 drag does not fire on touch at all, its drag image cannot be
 * a live element, and `dragover` gives no way to place a drop indicator in the
 * gap it would actually land in. This is a few dozen lines of arithmetic
 * instead, and it behaves the same under a finger.
 *
 * The controller is a plain module rather than a hook because two different
 * places start drags -- the header links and the docked panels' own headers --
 * and two hook instances would mean two sets of window listeners and two
 * disagreeing ideas of what is being dragged. A drag has one lifetime, so it
 * gets one controller, and React subscribes to the result through the store.
 *
 * One drag serves both jobs. `open(id, index)` moves a panel that is already
 * docked rather than duplicating it, so nothing here needs to know which case
 * it is in.
 */
import type { DockPanelId } from './dock-model'
import { useDockStore } from './dock-store'

/** How far the pointer must travel before a press becomes a drag. */
const SLOP = 5

interface Pending {
  id: DockPanelId
  from: { x: number; y: number }
  armed: boolean
}

let pending: Pending | null = null

export function startDockDrag(id: DockPanelId, event: { clientX: number; clientY: number }): void {
  pending = { id, from: { x: event.clientX, y: event.clientY }, armed: false }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

function onMove(event: PointerEvent): void {
  if (pending === null) return

  if (!pending.armed) {
    const travelled = Math.hypot(event.clientX - pending.from.x, event.clientY - pending.from.y)
    // Under the slop this is still a click, and a link that starts dragging the
    // moment it is pressed is a link nobody can follow.
    if (travelled < SLOP) return

    pending.armed = true
    useDockStore.getState().setDragging(pending.id)
  }

  useDockStore.getState().setDropIndex(indexAt(event.clientX, event.clientY))
}

function onUp(): void {
  const drag = pending
  pending = null

  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)

  if (drag === null || !drag.armed) return

  const { dropIndex, setDragging, setDropIndex, open } = useDockStore.getState()

  setDragging(null)
  setDropIndex(null)

  // Dropped outside the dock. Deliberately a no-op rather than "undock": the
  // close button is right there, and a panel vanishing because a drag ended
  // over the editor is not something anyone would predict.
  if (dropIndex === null) return

  open(drag.id, dropIndex)
}

/**
 * Which gap the pointer is over, or null when it is not over the dock.
 *
 * Measured against each panel's midpoint: above the middle means "before this
 * one", below means "after". Against the element's own top and bottom alone,
 * the whole lower half of the last panel would mean "before the last panel",
 * which reads as the indicator refusing to go to the end.
 */
function indexAt(x: number, y: number): number | null {
  const dock = useDockStore.getState().dockElement
  if (dock === null) return null

  const bounds = dock.getBoundingClientRect()
  // Horizontal as well: the dock is a column beside an editor, and a drag that
  // wanders left has left.
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null

  const panels = [...dock.querySelectorAll('[data-dock-panel]')]
  if (panels.length === 0) return 0

  for (const [index, panel] of panels.entries()) {
    const rect = panel.getBoundingClientRect()
    if (y < rect.top + rect.height / 2) return index
  }

  return panels.length
}
