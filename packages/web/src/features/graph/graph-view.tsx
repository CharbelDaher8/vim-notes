/**
 * The graph, drawn.
 *
 * SVG rather than canvas. It costs a DOM node per shape, which is the reason to
 * think about it at all, and buys three things worth more than that at this
 * size: it stays sharp on a phone's display and at any zoom without a
 * device-pixel-ratio dance; every node is a real element, so focus, `:hover`,
 * `aria-label` and the browser's own tooltip work rather than being
 * reimplemented against a hit-test; and when it looks wrong you can inspect the
 * thing that is wrong.
 *
 * The one place that discipline is broken is positions. React renders the
 * shapes; the animation loop writes `transform` and the line endpoints straight
 * onto the elements. Reconciling a thousand nodes sixty times a second is not
 * something any renderer does in 16ms, and coordinates are the one part of this
 * that no other component, no event handler and no piece of state ever reads --
 * so nothing is gained by routing them through React and a great deal is lost.
 */
import type { GraphEdgeKind, NoteGraph } from '@vim-notes/core'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { useWorkspaceStore } from '../../shared/workspace-store'
import { layoutBounds, type Layout, type Vec } from './force-layout'
import { buildScene, openTargetFor, type NodeShape, type SceneNode } from './graph-scene'
import { useGraph, useGraphSync } from './use-graph'
import { useSimulation } from './use-simulation'
import {
  centreOn,
  distanceBetween,
  fitToBounds,
  IDENTITY,
  midpointOf,
  panBy,
  pinchViewport,
  wheelZoomFactor,
  zoomAround,
  type PinchStart,
  type Size,
  type Viewport,
} from './viewport'

import './graph.css'

const EMPTY_GRAPH: NoteGraph = { nodes: [], edges: [] }

/**
 * How far a finger may slide and still count as a tap.
 *
 * Without this, tapping a node on a phone almost never opens it: a thumb moves
 * two or three pixels between touching down and lifting, every one of those
 * pixels pans the graph, and the gesture is read as a drag.
 */
const TAP_SLOP = 6

export interface GraphViewProps {
  /** Merged with the feature's own class, for whatever mounts this. */
  className?: string
}

export function GraphView({ className }: GraphViewProps) {
  useGraphSync()

  const { data: graph, error, isPending } = useGraph()

  const scene = useMemo(() => buildScene(graph ?? EMPTY_GRAPH), [graph])

  const openPath = useWorkspaceStore((state) => state.openPath)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const nodeRefs = useRef<(SVGGElement | null)[]>([])
  const edgeRefs = useRef<(SVGLineElement | null)[]>([])

  const viewRef = useRef<Viewport>(IDENTITY)
  const sizeRef = useRef<Size>({ width: 0, height: 0 })
  const originRef = useRef<Vec>({ x: 0, y: 0 })
  /** Once someone has panned or zoomed, the view is theirs and stops refitting. */
  const framedRef = useRef(false)

  const pointersRef = useRef(new Map<number, Vec>())
  const panRef = useRef<{ pointerId: number; travelled: number } | null>(null)
  const pinchRef = useRef<PinchStart | null>(null)
  const draggedRef = useRef(false)
  const focusedRef = useRef(0)

  const arrowId = useId()
  const hintId = useId()

  // How much to pull each edge back from its target, so an arrowhead lands on
  // the node's edge rather than underneath it.
  const trims = useMemo(() => {
    const radii = new Map(scene.nodes.map((node) => [node.id, node.radius]))
    return scene.edges.map((edge) => (radii.get(edge.target) ?? 0) + (directed(edge.kind) ? 5 : 1))
  }, [scene])

  const applyView = useCallback(() => {
    const view = viewRef.current
    worldRef.current?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`)
  }, [])

  const setView = useCallback(
    (next: Viewport) => {
      viewRef.current = next
      applyView()
    },
    [applyView],
  )

  const measure = useCallback(() => {
    const element = surfaceRef.current
    if (element === null) return

    const rect = element.getBoundingClientRect()
    sizeRef.current = { width: rect.width, height: rect.height }
    originRef.current = { x: rect.left, y: rect.top }
  }, [])

  useEffect(() => {
    nodeRefs.current.length = scene.nodes.length
    edgeRefs.current.length = scene.edges.length
    focusedRef.current = 0
  }, [scene])

  const draw = useCallback(
    (layout: Layout) => {
      // Index-for-index with what React rendered: `buildScene` guarantees
      // unique ids and no dangling or self edges, so `createLayout` keeps every
      // node and every edge, in order. graph-scene.test.ts pins that down.
      for (const [index, node] of layout.nodes.entries()) {
        nodeRefs.current[index]?.setAttribute(
          'transform',
          `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`,
        )
      }

      for (const [index, spring] of layout.springs.entries()) {
        const element = edgeRefs.current[index]
        if (element == null) continue

        const dx = spring.b.x - spring.a.x
        const dy = spring.b.y - spring.a.y
        const distance = Math.max(Math.hypot(dx, dy), 0.01)
        const trim = Math.min(trims[index] ?? 0, distance - 1)

        element.setAttribute('x1', spring.a.x.toFixed(1))
        element.setAttribute('y1', spring.a.y.toFixed(1))
        element.setAttribute('x2', (spring.b.x - (dx / distance) * trim).toFixed(1))
        element.setAttribute('y2', (spring.b.y - (dy / distance) * trim).toFixed(1))
      }

      // Refit every frame while the layout is still moving, so the graph grows
      // into the element instead of settling half off the edge of it.
      if (!framedRef.current) {
        viewRef.current = fitToBounds(layoutBounds(layout), sizeRef.current)
        applyView()
      }
    },
    [applyView, trims],
  )

  const { layoutRef, running } = useSimulation(scene, draw)

  const fit = useCallback(() => {
    const layout = layoutRef.current
    if (layout === null) return
    setView(fitToBounds(layoutBounds(layout), sizeRef.current))
  }, [layoutRef, setView])

  /*
   * A layout effect rather than a passive one, and not because it touches
   * layout: it has to run *before* the simulation's effect, which paints its
   * first frame and needs a measured element to fit that frame into. React runs
   * every layout effect in a commit before any passive one, which makes the
   * ordering a guarantee rather than a consequence of where this sits in the
   * file.
   */
  useLayoutEffect(() => {
    const element = surfaceRef.current
    if (element === null) return

    measure()

    const observer = new ResizeObserver(() => {
      measure()
      // Rotating a phone changes the frame, not the intent: a view that was
      // still automatic stays automatic.
      if (!framedRef.current) fit()
    })
    observer.observe(element)

    // Registered by hand because React attaches `onWheel` passively, and a
    // passive listener cannot call `preventDefault` -- so the page would scroll
    // at the same time as the graph zoomed.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      framedRef.current = true
      setView(
        zoomAround(viewRef.current, wheelZoomFactor(event.deltaY, event.deltaMode), {
          x: event.clientX - originRef.current.x,
          y: event.clientY - originRef.current.y,
        }),
      )
    }

    element.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      observer.disconnect()
      element.removeEventListener('wheel', onWheel)
    }
  }, [fit, measure, setView])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pointers = pointersRef.current
      const previous = pointers.get(event.pointerId)
      if (previous === undefined) return

      const point = {
        x: event.clientX - originRef.current.x,
        y: event.clientY - originRef.current.y,
      }
      pointers.set(event.pointerId, point)

      const pinch = pinchRef.current
      if (pinch !== null && pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        if (a === undefined || b === undefined) return

        draggedRef.current = true
        framedRef.current = true
        setView(pinchViewport(pinch, distanceBetween(a, b), midpointOf(a, b)))
        return
      }

      const pan = panRef.current
      if (pan === null || pan.pointerId !== event.pointerId) return

      const dx = point.x - previous.x
      const dy = point.y - previous.y
      pan.travelled += Math.hypot(dx, dy)

      // The movement is applied from the first pixel, but only counts as a drag
      // past the slop -- so a tap that wobbles still opens the note, and the
      // graph twitching two pixels under a thumb is not something anyone sees.
      if (pan.travelled > TAP_SLOP) {
        draggedRef.current = true
        framedRef.current = true
      }

      setView(panBy(viewRef.current, dx, dy))
    }

    const onRelease = (event: PointerEvent) => {
      const pointers = pointersRef.current
      pointers.delete(event.pointerId)

      if (pointers.size < 2) pinchRef.current = null

      if (pointers.size === 0) {
        panRef.current = null
        return
      }

      // Lifting one finger of a pinch hands panning to the one still down,
      // already past the slop so it cannot be mistaken for a tap.
      const [pointerId] = [...pointers.keys()]
      if (pointerId !== undefined) panRef.current = { pointerId, travelled: TAP_SLOP + 1 }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
    }
  }, [setView])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Re-read here rather than only on resize: the surface also moves when the
    // sidebar opens or the page scrolls, and a stale origin puts every zoom
    // anchor in the wrong place.
    measure()

    const pointers = pointersRef.current
    pointers.set(event.pointerId, {
      x: event.clientX - originRef.current.x,
      y: event.clientY - originRef.current.y,
    })

    if (pointers.size === 1) {
      draggedRef.current = false
      panRef.current = { pointerId: event.pointerId, travelled: 0 }
      return
    }

    const [a, b] = [...pointers.values()]
    if (a === undefined || b === undefined) return

    panRef.current = null
    pinchRef.current = {
      view: viewRef.current,
      distance: distanceBetween(a, b),
      centre: midpointOf(a, b),
    }
  }

  const open = useCallback((node: SceneNode) => {
    // A pan that happened to start on a node is not a click on it.
    if (draggedRef.current) return

    const target = openTargetFor(node)
    if (target === null) return

    void useWorkspaceStore
      .getState()
      .openNote(target.path, target.line === undefined ? undefined : { line: target.line })
  }, [])

  const focusNode = useCallback(
    (index: number) => {
      const count = scene.nodes.length
      if (count === 0) return

      const wrapped = ((index % count) + count) % count
      focusedRef.current = wrapped
      nodeRefs.current[wrapped]?.focus()

      // Moving focus to something off-screen would be a keyboard user pressing
      // an arrow key and watching nothing happen.
      const node = layoutRef.current?.nodes[wrapped]
      if (node === undefined) return

      framedRef.current = true
      setView(centreOn(viewRef.current, node, sizeRef.current))
    },
    [layoutRef, scene, setView],
  )

  const zoomBy = useCallback(
    (factor: number) => {
      framedRef.current = true
      const { width, height } = sizeRef.current
      setView(zoomAround(viewRef.current, factor, { x: width / 2, y: height / 2 }))
    },
    [setView],
  )

  const refit = useCallback(() => {
    // Asking to be framed puts the view back under the simulation's control,
    // so it keeps tracking while the graph is still moving.
    framedRef.current = false
    fit()
  }, [fit])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (delta: number) => {
      event.preventDefault()
      focusNode(focusedRef.current + delta)
    }

    switch (event.key) {
      // j/k and n/p alongside the arrows, for the same reason the palette has
      // them: the premise of this app is that vim is in your fingers.
      case 'ArrowRight':
      case 'ArrowDown':
      case 'j':
      case 'n':
        return step(1)
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'k':
      case 'p':
        return step(-1)
      case 'Home':
        event.preventDefault()
        return focusNode(0)
      case 'End':
        event.preventDefault()
        return focusNode(scene.nodes.length - 1)
      case 'Enter':
      case ' ': {
        const node = scene.nodes[focusedRef.current]
        if (node === undefined) return
        event.preventDefault()
        return open(node)
      }
      case '+':
      case '=':
        event.preventDefault()
        return zoomBy(1.3)
      case '-':
      case '_':
        event.preventDefault()
        return zoomBy(1 / 1.3)
      case '0':
        event.preventDefault()
        return refit()
      case 'Escape':
        return surfaceRef.current?.focus()
      default:
        return
    }
  }

  const empty = scene.totalNodes === 0

  return (
    <section className={className === undefined ? 'graph' : `graph ${className}`}>
      <div
        ref={surfaceRef}
        className="graph__surface"
        // `application` because this widget owns its arrow keys: without it a
        // screen reader intercepts them for its own reading cursor and the
        // graph cannot be walked at all.
        role="application"
        aria-label="Note graph"
        aria-roledescription="Graph"
        aria-describedby={hintId}
        tabIndex={0}
        data-empty={empty || undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <svg className="graph__canvas" width="100%" height="100%" aria-hidden={empty || undefined}>
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="graph__arrow" d="M0 0.8 L7.5 4 L0 7.2 Z" />
            </marker>
          </defs>

          <g ref={worldRef}>
            <g className="graph__edges">
              {scene.edges.map((edge, index) => (
                <line
                  key={edge.id}
                  ref={(element) => {
                    edgeRefs.current[index] = element
                  }}
                  className="graph__edge"
                  data-kind={edge.kind}
                  markerEnd={directed(edge.kind) ? `url(#${arrowId})` : undefined}
                />
              ))}
            </g>

            <g
              className="graph__nodes"
              role="group"
              aria-label={`${scene.nodes.length} nodes`}
              data-labelled={scene.labelled || undefined}
            >
              {scene.nodes.map((node, index) => (
                <g
                  key={node.id}
                  ref={(element) => {
                    nodeRefs.current[index] = element
                  }}
                  className="graph__node"
                  data-kind={node.kind}
                  data-tone={node.tone}
                  data-done={node.done || undefined}
                  data-missing={node.missing || undefined}
                  data-open={(node.path !== null && node.path === openPath) || undefined}
                  role="button"
                  // One tab stop for the whole graph, not one per node: at a
                  // thousand nodes, tabbing through them is not navigation.
                  // Arrow keys move between them once focus is inside.
                  tabIndex={-1}
                  aria-label={node.description}
                  aria-disabled={node.path === null || undefined}
                  onFocus={() => {
                    focusedRef.current = index
                  }}
                  onClick={() => open(node)}
                >
                  <title>{node.description}</title>

                  {/* Small shapes are hard to hit with a thumb. The visible
                      glyph stays the right size and this catches the miss. */}
                  <circle className="graph__hit" r={node.radius + 7} />

                  <circle className="graph__ring" r={node.radius + 5} />
                  <NodeGlyph shape={node.shape} radius={node.radius} done={node.done} />

                  <text className="graph__label" y={node.radius + 13}>
                    {node.short}
                  </text>
                </g>
              ))}
            </g>
          </g>
        </svg>

        {error !== null ? (
          <p className="graph__overlay" role="alert">
            {error.message}
          </p>
        ) : isPending ? (
          <p className="graph__overlay">Reading the index…</p>
        ) : empty ? (
          <div className="graph__overlay">
            <p className="graph__empty-title">Nothing to draw yet.</p>
            <p>
              Notes join up here as you link them with <code>[[wikilinks]]</code>. Days appear as
              you write them, and lines starting <code>TODO</code> or <code>Reminder</code> hang off
              the note they are in.
            </p>
          </div>
        ) : null}

        <div
          className="graph__controls"
          // The controls sit inside the surface, so without this a press on a
          // button also arms a pan, and Enter on a focused button would fall
          // through to the graph's own Enter and open whatever node was last
          // focused.
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.3)}
          >
            <ZoomIn />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.3)}
          >
            <ZoomOut />
          </button>
          <button type="button" className="icon-button" aria-label="Fit to view" onClick={refit}>
            <Frame />
          </button>
        </div>

        <p id={hintId} className="visually-hidden">
          Arrow keys move between nodes, Enter opens one. Plus and minus zoom, 0 fits the graph to
          the window. Drag to pan, pinch or scroll to zoom.
        </p>
      </div>

      <footer className="graph__footer">
        <ul className="graph__legend">
          {LEGEND.map((entry) => (
            <li key={entry.label} className="graph__legend-item">
              <svg
                className="graph__legend-glyph"
                viewBox="-9 -9 18 18"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <g
                  className="graph__node"
                  data-tone={entry.tone}
                  data-kind={entry.kind}
                  data-done={entry.done || undefined}
                  data-missing={entry.missing || undefined}
                >
                  <NodeGlyph shape={entry.shape} radius={6.5} done={entry.done === true} />
                </g>
              </svg>
              {entry.label}
            </li>
          ))}
        </ul>

        <p className="graph__meta" aria-live="polite">
          {empty
            ? null
            : scene.omitted > 0
              ? `Showing the ${scene.nodes.length} best-connected of ${scene.totalNodes} nodes.`
              : `${scene.nodes.length} nodes, ${scene.edges.length} links.`}
          {/* Hidden from the live region: it reports motion, and motion is not
              something a screen reader user is waiting to hear about. */}
          {running ? (
            <span className="graph__settling" aria-hidden="true">
              {' '}
              Settling…
            </span>
          ) : null}
        </p>
      </footer>
    </section>
  )
}

/** Containment and day membership are obvious from proximity; links are not. */
function directed(kind: GraphEdgeKind): boolean {
  return kind === 'link' || kind === 'unresolved'
}

function NodeGlyph({ shape, radius, done }: { shape: NodeShape; radius: number; done: boolean }) {
  if (shape === 'square') {
    return (
      <>
        <rect
          className="graph__glyph"
          x={-radius}
          y={-radius}
          width={radius * 2}
          height={radius * 2}
          rx={1.5}
        />
        {/* A third signal that a todo is done, after the muted fill and the
            struck-through label -- so it still reads as done in monochrome. */}
        {done ? <path className="graph__tick" d={tickPath(radius)} /> : null}
      </>
    )
  }

  if (shape === 'triangle') {
    return <path className="graph__glyph" d={trianglePath(radius)} />
  }

  // Circle and ring are the same element; the fill is what differs, and that
  // belongs in CSS with the rest of the palette.
  return <circle className="graph__glyph" r={radius} />
}

/** Equilateral, point up, centred on the origin so it orbits like the others. */
function trianglePath(radius: number): string {
  const corners = [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6].map(
    (angle) => `${(Math.cos(angle) * radius).toFixed(2)} ${(Math.sin(angle) * radius).toFixed(2)}`,
  )

  return `M${corners.join(' L')} Z`
}

function tickPath(radius: number): string {
  const at = (x: number, y: number) => `${(x * radius).toFixed(2)} ${(y * radius).toFixed(2)}`
  return `M${at(-0.52, 0.02)} L${at(-0.12, 0.42)} L${at(0.55, -0.45)}`
}

interface LegendEntry {
  shape: NodeShape
  kind: string
  tone: string
  label: string
  done?: boolean
  missing?: boolean
}

/**
 * The key to the shape vocabulary, and therefore not optional decoration: the
 * whole point of encoding kind as silhouette is lost if nobody is told what the
 * silhouettes mean.
 */
const LEGEND: LegendEntry[] = [
  { shape: 'circle', kind: 'note', tone: 'note', label: 'Note' },
  { shape: 'ring', kind: 'day', tone: 'structure', label: 'Day' },
  { shape: 'square', kind: 'todo', tone: 'task', label: 'Todo' },
  { shape: 'square', kind: 'todo', tone: 'done', label: 'Done', done: true },
  { shape: 'triangle', kind: 'reminder', tone: 'task', label: 'Reminder' },
  { shape: 'circle', kind: 'note', tone: 'structure', label: 'Not written yet', missing: true },
]

const ICON = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const

const ZoomIn = () => (
  <svg {...ICON}>
    <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4.5 4.5M8 11h6M11 8v6" />
  </svg>
)

const ZoomOut = () => (
  <svg {...ICON}>
    <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4.5 4.5M8 11h6" />
  </svg>
)

const Frame = () => (
  <svg {...ICON}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)
