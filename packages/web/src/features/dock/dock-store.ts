import { create } from 'zustand'

import { readSetting, SETTING_KEYS, writeSetting } from '../../shared/local-storage'
import {
  addPanel,
  EMPTY_LAYOUT,
  movePanel,
  parseLayout,
  removePanel,
  resizeDock,
  resizePanel,
  togglePanel,
  type DockLayout,
  type DockPanelId,
} from './dock-model'

/**
 * The dock's layout, persisted.
 *
 * A thin shell over dock-model: every operation is `state = f(state)` with the
 * arithmetic in the pure module, and the only thing this file adds is storage
 * and a place for React to subscribe.
 *
 * Which panels are open is the flag that decides whether a terminal, a force
 * simulation and a feed are running at all, so it has to survive a reload --
 * otherwise "close the terminal" is undone by refreshing the page.
 */
interface DockState {
  layout: DockLayout
  /** Which panel is being dragged, so the dock can show where it would land. */
  dragging: DockPanelId | null
  /** Where it would land, or null when the pointer is not over the dock. */
  dropIndex: number | null
  /**
   * The dock element, registered by the component that renders it.
   *
   * Here rather than in a ref passed around because the drag controller is a
   * module, not a hook -- it needs to measure the dock from outside React.
   */
  dockElement: HTMLElement | null

  toggle: (id: DockPanelId) => void
  open: (id: DockPanelId, at?: number) => void
  close: (id: DockPanelId) => void
  move: (id: DockPanelId, to: number) => void
  resize: (index: number, delta: number) => void
  setWidth: (width: number) => void
  setDragging: (id: DockPanelId | null) => void
  setDropIndex: (index: number | null) => void
  setDockElement: (element: HTMLElement | null) => void
}

function load(): DockLayout {
  const raw = readSetting(SETTING_KEYS.dock)
  if (raw === null) return EMPTY_LAYOUT

  try {
    return parseLayout(JSON.parse(raw))
  } catch {
    return EMPTY_LAYOUT
  }
}

export const useDockStore = create<DockState>()((set) => {
  // Written on every change, including every frame of a resize drag. That is
  // fine -- it is a few hundred bytes and localStorage is synchronous and fast
  // -- and it means a layout is never lost to a tab closed mid-drag.
  const persist = (layout: DockLayout): { layout: DockLayout } => {
    writeSetting(SETTING_KEYS.dock, JSON.stringify(layout))
    return { layout }
  }

  const apply = (change: (layout: DockLayout) => DockLayout) => {
    set((state) => persist(change(state.layout)))
  }

  return {
    layout: load(),
    dragging: null,
    dropIndex: null,
    dockElement: null,

    toggle: (id) => apply((layout) => togglePanel(layout, id)),
    open: (id, at) => apply((layout) => addPanel(layout, id, at)),
    close: (id) => apply((layout) => removePanel(layout, id)),
    move: (id, to) => apply((layout) => movePanel(layout, id, to)),
    resize: (index, delta) => apply((layout) => resizePanel(layout, index, delta)),
    setWidth: (width) => apply((layout) => resizeDock(layout, width)),

    setDragging: (dragging) => set({ dragging }),
    setDropIndex: (dropIndex) => set({ dropIndex }),
    setDockElement: (dockElement) => set({ dockElement }),
  }
})
