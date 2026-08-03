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
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { useWorkspaceStore } from '../../shared/workspace-store'
import { layoutBounds, pinNode, unpinAll, type Layout, type Vec } from './force-layout'
import {
  buildScene,
  LABEL_FONT_SIZE,
  LABEL_GAP,
  MIN_LABEL_PIXELS,
  openTargetFor,
  type NodeShape,
  type OpenTarget,
  type SceneNode,
} from './graph-scene'
import { readPins, writePins } from './pin-storage'
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
  toWorld,
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

/** How far one press of shift-arrow moves the focused node, in CSS pixels. */
const KEY_NUDGE = 12

/** How long after the last move a rearrangement is written to storage. */
const PERSIST_DELAY = 500

interface Drag {
  pointerId: number
  id: string
  index: number
  /**
   * World-space distance from the pointer to the node's centre when it was
   * grabbed. Without it the node jumps so its centre is under the finger, which
   * on a big node is a visible lurch at the start of every drag.
   */
  offset: Vec
  travelled: number
}

export interface GraphViewProps {
  /**
   * What clicking a node does.
   *
   * Required, and deliberately not defaulted to "open it in the workspace
   * store". That default is right in the sidebar, where an editor is sitting
   * next to the graph, and silently wrong on `/graph`, where setting the open
   * note updates a store nothing on the page is rendering -- which is precisely
   * how this feature spent its first life looking broken. Making the caller say
   * moves that decision to the two places that know the answer.
   */
  onOpen: (target: OpenTarget) => void
  /** Merged with the feature's own class, for whatever mounts this. */
  className?: string
}

export function GraphView({ onOpen, className }: GraphViewProps) {
  useGraphSync()

  const { data: graph, error, isPending } = useGraph()

  const scene = useMemo(() => buildScene(graph ?? EMPTY_GRAPH), [graph])

  const openPath = useWorkspaceStore((state) => state.openPath)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const nodesRef = useRef<SVGGElement>(null)
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

  /*
   * Where the nodes someone moved by hand belong, by id.
   *
   * The durable copy, and deliberately not React state: it is written on every
   * frame of a drag, and re-rendering a thousand nodes to move one of them is
   * the thing this whole component is arranged to avoid. Only the count is
   * state, because only the count is rendered.
   */
  const pinsRef = useRef<Map<string, Vec> | null>(null)
  pinsRef.current ??= readPins()

  const [pinCount, setPinCount] = useState(() => pinsRef.current?.size ?? 0)

  const dragRef = useRef<Drag | null>(null)
  const persistRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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

    // Written straight onto the element rather than held in state, for the same
    // reason the transform is: this changes on every frame of a pinch, and a
    // re-render per frame would reconcile every node in the graph.
    const group = nodesRef.current
    if (group === null) return

    const mode =
      LABEL_FONT_SIZE * view.k < MIN_LABEL_PIXELS ? 'off' : labelledRef.current ? 'on' : 'hover'
    if (group.getAttribute('data-labels') !== mode) group.setAttribute('data-labels', mode)
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

  // Read by `applyView`, which runs outside React on every frame of a gesture
  // and so cannot close over a render's value.
  const labelledRef = useRef(scene.labelled)
  labelledRef.current = scene.labelled

  /**
   * Mark the pinned nodes on the elements React just rendered.
   *
   * From `pinsRef` rather than from the layout, because this runs on a scene
   * change and the layout is rebuilt by the simulation's own effect, which is
   * registered later and therefore runs after this one. The pins are the same
   * either way; only one of the two is guaranteed to be current here.
   */
  const markPins = useCallback(() => {
    const pins = pinsRef.current
    if (pins === null) return

    for (const [index, node] of scene.nodes.entries()) {
      const element = nodeRefs.current[index]
      if (element == null) continue

      if (pins.has(node.id)) element.setAttribute('data-pinned', '')
      else element.removeAttribute('data-pinned')
    }
  }, [scene])

  const persistSoon = useCallback(() => {
    clearTimeout(persistRef.current)
    // Debounced because a drag would otherwise serialise the whole arrangement
    // sixty times a second, and an arrow key held down would do it faster.
    persistRef.current = setTimeout(() => {
      if (pinsRef.current !== null) writePins(pinsRef.current)
    }, PERSIST_DELAY)
  }, [])

  // Whatever is pending when this unmounts is a rearrangement someone made and
  // would expect to find again -- and navigating away is exactly when the timer
  // is most likely to still be waiting.
  useEffect(
    () => () => {
      clearTimeout(persistRef.current)
      if (pinsRef.current !== null) writePins(pinsRef.current)
    },
    [],
  )

  useEffect(() => {
    nodeRefs.current.length = scene.nodes.length
    edgeRefs.current.length = scene.edges.length
    focusedRef.current = 0
    markPins()
    // A scene can cross the label limit without the view moving at all, and the
    // label mode is derived from both.
    applyView()
  }, [applyView, markPins, scene])

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

  const { layoutRef, running, nudge } = useSimulation(scene, draw, { pins: pinsRef })

  /** Hold a node at a world point, and remember that someone put it there. */
  const pinAt = useCallback(
    (index: number, id: string, point: Vec) => {
      const layout = layoutRef.current
      if (layout === null) return

      pinNode(layout, id, point)
      pinsRef.current?.set(id, point)
      nodeRefs.current[index]?.setAttribute('data-pinned', '')

      setPinCount(pinsRef.current?.size ?? 0)
      persistSoon()
      // The layout has almost certainly settled and stopped booking frames by
      // the time anyone drags anything, so without this the node would hold its
      // new position and never be painted in it.
      nudge()
    },
    [layoutRef, nudge, persistSoon],
  )

  const releaseAll = useCallback(() => {
    const layout = layoutRef.current
    if (layout !== null) unpinAll(layout)

    pinsRef.current?.clear()
    for (const element of nodeRefs.current) element?.removeAttribute('data-pinned')

    setPinCount(0)
    persistSoon()
    // Warmer than a drag: this is a request for the graph to lay itself out
    // again, and at drag heat it would barely move off the arrangement being
    // abandoned.
    nudge(0.5)
  }, [layoutRef, nudge, persistSoon])

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

      const drag = dragRef.current
      if (drag !== null && drag.pointerId === event.pointerId) {
        drag.travelled += Math.hypot(point.x - previous.x, point.y - previous.y)
        // Under the slop this is still a tap in progress, and pinning a node
        // someone only meant to open would leave pins scattered everywhere.
        if (drag.travelled <= TAP_SLOP) return

        draggedRef.current = true
        // The view is not moving, but an unframed one refits itself every frame
        // while the layout is warm -- and a drag makes it warm.
        framedRef.current = true

        const world = toWorld(viewRef.current, point)
        pinAt(drag.index, drag.id, { x: world.x + drag.offset.x, y: world.y + drag.offset.y })
        return
      }

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

      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null

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
  }, [pinAt, setView])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Re-read here rather than only on resize: the surface also moves when the
    // sidebar opens or the page scrolls, and a stale origin puts every zoom
    // anchor in the wrong place.
    measure()

    const pointers = pointersRef.current
    const point = {
      x: event.clientX - originRef.current.x,
      y: event.clientY - originRef.current.y,
    }
    pointers.set(event.pointerId, point)

    if (pointers.size === 1) {
      draggedRef.current = false

      // A press that landed on a node moves that node; anywhere else moves the
      // view. Hit-tested from the event target rather than against the
      // positions, because the browser has already done it -- and it did it
      // against the shapes actually painted, including the oversized invisible
      // circle that exists to be hittable by a thumb.
      const index = nodeIndexAt(event.target)

      if (index !== null) {
        const node = scene.nodes[index]
        const placed = layoutRef.current?.nodes[index]

        if (node !== undefined && placed !== undefined) {
          const world = toWorld(viewRef.current, point)
          panRef.current = null
          dragRef.current = {
            pointerId: event.pointerId,
            id: node.id,
            index,
            offset: { x: placed.x - world.x, y: placed.y - world.y },
            travelled: 0,
          }
          return
        }
      }

      panRef.current = { pointerId: event.pointerId, travelled: 0 }
      return
    }

    const [a, b] = [...pointers.values()]
    if (a === undefined || b === undefined) return

    // A second finger turns a node drag into a pinch. Fighting over which one
    // the gesture is would be worse than picking the one that moves the view.
    dragRef.current = null
    panRef.current = null
    pinchRef.current = {
      view: viewRef.current,
      distance: distanceBetween(a, b),
      centre: midpointOf(a, b),
    }
  }

  const open = useCallback(
    (node: SceneNode) => {
      // A pan or a drag that happened to start on a node is not a click on it.
      if (draggedRef.current) return

      const target = openTargetFor(node)
      if (target === null) return

      onOpen(target)
    },
    [onOpen],
  )

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

  /**
   * Move the focused node, for people who are not holding a pointer.
   *
   * Bound to shift-arrow rather than to a mode, so it is one key away from the
   * arrows that already walk the graph. Moving a node this way pins it, exactly
   * as dragging it does -- there is no third state where a node has been placed
   * but is not being held.
   */
  const moveFocused = (dx: number, dy: number) => {
    const index = focusedRef.current
    const node = scene.nodes[index]
    const placed = layoutRef.current?.nodes[index]
    if (node === undefined || placed === undefined) return

    // Divided by the scale so a press moves the same distance on the screen at
    // any zoom, rather than a fixed distance in the world.
    const distance = KEY_NUDGE / viewRef.current.k
    pinAt(index, node.id, { x: placed.x + dx * distance, y: placed.y + dy * distance })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (delta: number) => {
      event.preventDefault()
      focusNode(focusedRef.current + delta)
    }

    const move = (dx: number, dy: number) => {
      event.preventDefault()
      moveFocused(dx, dy)
    }

    if (event.shiftKey) {
      switch (event.key) {
        case 'ArrowLeft':
          return move(-1, 0)
        case 'ArrowRight':
          return move(1, 0)
        case 'ArrowUp':
          return move(0, -1)
        case 'ArrowDown':
          return move(0, 1)
        default:
          break
      }
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
              ref={nodesRef}
              className="graph__nodes"
              role="group"
              aria-label={`${scene.nodes.length} nodes`}
              // `data-labels` is set by `applyView`, not here: it depends on the
              // current zoom, which React deliberately never sees.
            >
              {scene.nodes.map((node, index) => (
                <g
                  key={node.id}
                  ref={(element) => {
                    nodeRefs.current[index] = element
                  }}
                  className="graph__node"
                  // Read back by `nodeIndexAt` to turn a press on any shape
                  // inside this group into the node it belongs to.
                  data-index={index}
                  data-kind={node.kind}
                  data-tone={node.tone}
                  data-done={node.done || undefined}
                  data-missing={node.missing || undefined}
                  // Drawn the same as an unwritten target -- both are links
                  // that go nowhere -- but exposed so the difference is
                  // stylable without reaching back into the model.
                  data-ambiguous={node.ambiguous || undefined}
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

                  {/* Empty when the scene is past the label limit, or when the
                      text would only repeat the node next to it. */}
                  {node.short === '' ? null : (
                    <text className="graph__label" y={node.radius + LABEL_GAP}>
                      {node.short}
                    </text>
                  )}
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

          {/* Only there when there is something to undo. A permanent control
              for a state nobody is in is a control that has to be explained. */}
          {pinCount === 0 ? null : (
            <button
              type="button"
              className="icon-button"
              aria-label={`Release ${pinCount} pinned ${pinCount === 1 ? 'node' : 'nodes'}`}
              title="Let the graph lay itself out again"
              onClick={releaseAll}
            >
              <Unpin />
            </button>
          )}
        </div>

        <p id={hintId} className="visually-hidden">
          Arrow keys move between nodes, Enter opens one. Shift with an arrow key moves the focused
          node and pins it there. Plus and minus zoom, 0 fits the graph to the window. Drag a node
          to place it, drag the background to pan, pinch or scroll to zoom.
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

/**
 * Which node a press landed on, or null for the background.
 *
 * The target is whichever shape was actually hit -- a glyph, a label, the
 * invisible hit circle -- so this climbs to the group that owns it. `closest`
 * works on SVG elements, which is the only reason the index can live in an
 * attribute rather than in a map built per render.
 */
function nodeIndexAt(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null

  const group = target.closest('.graph__node')
  if (group === null) return null

  const index = Number(group.getAttribute('data-index'))
  return Number.isInteger(index) && index >= 0 ? index : null
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
  // Not "not written yet": the same outline is also how an ambiguous link is
  // drawn, and naming only the common case would make the legend wrong for the
  // other one. The tooltip says which.
  { shape: 'circle', kind: 'note', tone: 'structure', label: 'No note behind it', missing: true },
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

/** A pin, struck through. Same silhouette as the marker on a pinned node. */
const Unpin = () => (
  <svg {...ICON}>
    <path d="M12 17v4M9.5 4h5l-.7 5 2.7 3v2H7.5v-2l2.7-3-.7-5ZM4 4l16 16" />
  </svg>
)
