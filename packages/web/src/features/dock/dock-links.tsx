/**
 * The header entries for the three dockable views.
 *
 * Each is a plain link to the full page *and* a drag handle into the dock. That
 * pairing is the point: the link is what works with a keyboard, a screen reader
 * and a middle click, and the drag is the thing you reach for once you know it
 * is there. Neither is a mode you have to enter.
 *
 * The `+` menu beside them does the same job as the drag without a pointer,
 * because "drag this into that" is not an instruction a keyboard can follow.
 */
import { useEffect, useRef, useState } from 'react'

import { useMediaQuery } from '../../shared/use-media-query'
import { DOCK_PANEL_IDS, isDocked, type DockPanelId } from './dock-model'
import { useDockStore } from './dock-store'
import { startDockDrag } from './use-dock-drag'

const TITLES: Record<DockPanelId, string> = {
  graph: 'Graph',
  news: 'News',
  terminal: 'Terminal',
}

const HREFS: Record<DockPanelId, string> = {
  graph: '/graph',
  news: '/news',
  terminal: '/term',
}

export function DockLink({ id }: { id: DockPanelId }) {
  const docked = useDockStore((state) => isDocked(state.layout, id))
  const dragging = useDockStore((state) => state.dragging)

  return (
    <a
      className="app__term-link"
      href={HREFS[id]}
      data-docked={docked || undefined}
      title={`${TITLES[id]} — open as a page, or drag into the dock`}
      onPointerDown={(event) => {
        // Left button only. A middle click is "open in a new tab" and a right
        // click is a context menu; neither should arm a drag.
        if (event.button !== 0) return
        startDockDrag(id, event)
      }}
      onClick={(event) => {
        // A drag that started here ends with the pointer somewhere else, but
        // the browser still fires a click on the element it began on -- so
        // without this, every drag also navigates away.
        if (dragging !== null) event.preventDefault()
      }}
    >
      {HREFS[id]}
    </a>
  )
}

/** The keyboard path to the same thing. */
export function DockMenu() {
  const [open, setOpen] = useState(false)
  const layout = useDockStore((state) => state.layout)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (ref.current?.contains(event.target) === false) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="dock-menu" ref={ref}>
      <button
        type="button"
        className="icon-button"
        aria-expanded={open}
        aria-label="Docked panels"
        title="Panels in the sidebar"
        onClick={() => setOpen((value) => !value)}
      >
        ⊞
      </button>

      {!open ? null : (
        <div className="dock-menu__list" role="menu">
          {DOCK_PANEL_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={isDocked(layout, id)}
              className="dock-menu__item"
              onClick={() => {
                useDockStore.getState().toggle(id)
                setOpen(false)
              }}
            >
              <span className="dock-menu__check" aria-hidden="true">
                {isDocked(layout, id) ? '✓' : ''}
              </span>
              {TITLES[id]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Whether the dock is offered at all.
 *
 * Matches the breakpoint dock.css hides it at. Below it the editor needs every
 * pixel, and each panel already has a full page reachable from the same header.
 */
export function useHasRoomForDock(): boolean {
  return useMediaQuery('(min-width: 64rem)')
}
