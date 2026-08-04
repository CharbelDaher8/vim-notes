/**
 * The right-hand dock: panels stacked in a column, each resizable.
 *
 * Renders nothing at all when empty, and that is load-bearing rather than
 * tidiness -- an empty dock still occupying a strip of the window would take
 * measure away from the editor for a feature nobody is using.
 *
 * Sizes come from the model as fractions and go onto the elements as
 * `flex: <fraction>`, so a window resize needs no arithmetic here: the browser
 * redistributes and the stored layout is still true.
 */
import { Suspense, useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { Close } from '../../shared/ui/icons'
import { MIN_DOCK_WIDTH, MAX_DOCK_WIDTH, type DockPanelId } from './dock-model'
import { useHasRoomForDock } from './dock-links'
import { useDockPanelDefinitions } from './dock-panels'
import { useDockStore } from './dock-store'
import { startDockDrag } from './use-dock-drag'

import './dock.css'

export function Dock() {
  const layout = useDockStore((state) => state.layout)
  const dragging = useDockStore((state) => state.dragging)
  const dropIndex = useDockStore((state) => state.dropIndex)
  const definitions = useDockPanelDefinitions()
  const hasRoom = useHasRoomForDock()

  // Registered rather than passed: the drag controller measures the dock from
  // outside React, so it needs the element and not a ref React happens to hold.
  const dockRef = useCallback((element: HTMLElement | null) => {
    useDockStore.getState().setDockElement(element)
  }, [])

  // Not rendered at all below the breakpoint, rather than hidden by CSS. The
  // stylesheet hides it too -- belt and braces for a resize mid-render -- but
  // `display: none` alone would leave a pty, a force simulation and a polling
  // feed running behind a dock nobody can see, which is the same mistake the
  // graph panel was careful to avoid before the dock replaced it.
  if (!hasRoom) return null

  // While something is being dragged the dock has to exist even when empty, or
  // there is nothing on screen to drop onto.
  if (layout.panels.length === 0 && dragging === null) return null

  return (
    <aside
      ref={dockRef}
      className="dock"
      style={{ width: `${layout.width * 100}%` }}
      data-empty={layout.panels.length === 0 || undefined}
      data-dropping={dragging !== null || undefined}
      aria-label="Docked panels"
    >
      <DockResizer />

      {layout.panels.length === 0 ? (
        <p className="dock__notice">Drop it here</p>
      ) : (
        layout.panels.map((panel, index) => (
          <div
            key={panel.id}
            className="dock__slot"
            data-dock-panel=""
            style={{ flex: `${panel.size} 1 0` }}
          >
            {dropIndex === index ? <span className="dock__drop" aria-hidden="true" /> : null}

            <DockPanel
              id={panel.id}
              title={definitions[panel.id].title}
              href={definitions[panel.id].href}
              onGrab={(event) => startDockDrag(panel.id, event)}
            >
              {definitions[panel.id].render()}
            </DockPanel>

            {/* No divider under the last panel: there is nothing below it to
                trade height with, and a handle that does nothing is worse than
                no handle. */}
            {index < layout.panels.length - 1 ? <PanelResizer index={index} /> : null}
          </div>
        ))
      )}

      {dropIndex === layout.panels.length && layout.panels.length > 0 ? (
        <span className="dock__drop" aria-hidden="true" />
      ) : null}
    </aside>
  )
}

function DockPanel({
  id,
  title,
  href,
  onGrab,
  children,
}: {
  id: DockPanelId
  title: string
  href: string
  onGrab: (event: ReactPointerEvent) => void
  children: React.ReactNode
}) {
  return (
    <section className="dock__panel" aria-label={title}>
      <header className="dock__header" onPointerDown={onGrab}>
        <span className="dock__title">{title}</span>

        <a
          className="dock__link"
          href={href}
          title={`Open ${title} as a full page`}
          // Or the pointerdown on the header starts a drag from the link.
          onPointerDown={(event) => event.stopPropagation()}
        >
          ↗
        </a>

        <button
          type="button"
          className="dock__close"
          aria-label={`Close ${title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => useDockStore.getState().close(id)}
        >
          <Close size={13} />
        </button>
      </header>

      <div className="dock__body">
        <Suspense fallback={<p className="dock__notice">Loading…</p>}>{children}</Suspense>
      </div>
    </section>
  )
}

/** The divider between two panels. Drag it to trade height between them. */
function PanelResizer({ index }: { index: number }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const dock = event.currentTarget.closest('.dock')
    if (dock === null) return

    const height = dock.getBoundingClientRect().height
    let last = event.clientY

    const onMove = (move: PointerEvent) => {
      // As a fraction of the dock, because that is what the model speaks. Sent
      // as a delta rather than an absolute so the model owns the clamping and
      // a drag past the floor simply stops instead of jumping.
      useDockStore.getState().resize(index, (move.clientY - last) / height)
      last = move.clientY
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className="dock__divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panels"
      onPointerDown={onPointerDown}
    />
  )
}

/** The dock's own left edge. Drag it to take width from the editor. */
function DockResizer() {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const onMove = (move: PointerEvent) => {
      // Measured from the right edge of the window rather than accumulated from
      // the previous frame: a fraction that accumulates drifts, and the dock
      // ends up not under the pointer that is dragging it.
      useDockStore.getState().setWidth((window.innerWidth - move.clientX) / window.innerWidth)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const width = useDockStore((state) => state.layout.width)

  return (
    <div
      className="dock__edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the dock"
      aria-valuenow={Math.round(width * 100)}
      aria-valuemin={Math.round(MIN_DOCK_WIDTH * 100)}
      aria-valuemax={Math.round(MAX_DOCK_WIDTH * 100)}
      onPointerDown={onPointerDown}
    />
  )
}
