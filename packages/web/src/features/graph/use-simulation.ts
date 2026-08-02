import { useEffect, useRef, useState, type RefObject } from 'react'

import {
  createLayout,
  isSettled,
  layoutPositions,
  step,
  type Layout,
  type LayoutOptions,
  type Vec,
} from './force-layout'
import type { Scene } from './graph-scene'

/**
 * The bridge between the pure simulation and the browser: one animation loop,
 * and the rules for when it is allowed to run.
 *
 * Everything here is about *stopping*. A `requestAnimationFrame` loop is the
 * easiest way to flatten a laptop battery ever invented -- it will happily wake
 * the compositor sixty times a second forever, drawing a picture that stopped
 * changing two minutes ago.
 *
 * `isSettled` covers the layout's own reasons to stop: it went still, or it ran
 * out of heat, or it hit the tick ceiling. What this file adds is the reason
 * that has nothing to do with the layout -- the tab is not on screen. That one
 * is not covered by the browser either: throttling a background tab is a
 * heuristic rather than a guarantee, and a tab on a second monitor may not be
 * throttled at all.
 */

export interface Simulation {
  /** The live layout. Positions are read off this inside `draw`. */
  layoutRef: RefObject<Layout | null>
  /** Whether frames are currently being scheduled. */
  running: boolean
}

/**
 * With reduced motion asked for, the layout is not animated at all -- it is
 * solved and then shown. Which frees the loop to take several steps per frame,
 * because nobody is watching the intermediate ones.
 */
const REDUCED_MOTION_STEPS = 8

export function useSimulation(
  scene: Scene,
  draw: (layout: Layout) => void,
  overrides?: Partial<LayoutOptions>,
): Simulation {
  const layoutRef = useRef<Layout | null>(null)
  const carriedRef = useRef<Map<string, Vec> | null>(null)
  const drawRef = useRef(draw)
  const optionsRef = useRef(overrides)

  const [running, setRunning] = useState(false)

  // Kept in a ref so a new `draw` closure -- which happens on every render,
  // because it reads the current scene -- does not tear down the animation loop
  // and start the layout again from nothing.
  useEffect(() => {
    drawRef.current = draw
    optionsRef.current = overrides
  })

  useEffect(() => {
    const layout = createLayout(
      {
        nodes: scene.nodes,
        edges: scene.edges.map((edge) => ({
          from: edge.source,
          to: edge.target,
          length: edge.length,
          strength: edge.strength,
        })),
      },
      optionsRef.current,
      // The positions the previous scene finished with. This is what stops the
      // whole graph jumping when a note is saved.
      carriedRef.current,
    )

    layoutRef.current = layout

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const perFrame = calm ? REDUCED_MOTION_STEPS : 1

    let frame = 0
    let stopped = false

    const tick = () => {
      frame = 0

      for (let i = 0; i < perFrame && !isSettled(layout); i += 1) step(layout)

      // Under reduced motion the intermediate states are never painted, so what
      // appears is the finished layout rather than a graph shuffling itself
      // into place.
      if (!calm || isSettled(layout)) drawRef.current(layout)

      if (isSettled(layout)) {
        carriedRef.current = layoutPositions(layout)
        setRunning(false)
        return
      }

      frame = requestAnimationFrame(tick)
    }

    const start = () => {
      if (stopped || frame !== 0 || document.hidden || isSettled(layout)) return
      setRunning(true)
      frame = requestAnimationFrame(tick)
    }

    const onVisibilityChange = () => {
      if (!document.hidden) {
        start()
        return
      }

      cancelAnimationFrame(frame)
      frame = 0
      setRunning(false)
    }

    // Paint before the first tick so that a layout restored from the previous
    // scene -- or one that is already settled, which is every empty graph --
    // still puts something on screen.
    drawRef.current(layout)
    start()

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      // On the way out, not only on settling: a graph replaced mid-flight still
      // has positions worth keeping, and losing them is the jump this whole
      // mechanism exists to avoid.
      carriedRef.current = layoutPositions(layout)
    }
  }, [scene])

  return { layoutRef, running }
}
