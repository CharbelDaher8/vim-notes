import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import {
  createLayout,
  layoutPositions,
  reheat,
  type Layout,
  type LayoutOptions,
  type Vec,
} from './force-layout'
import type { Scene } from './graph-scene'
import { browserFrameHost, createSimulationLoop, type SimulationLoop } from './simulation-loop'

/**
 * The layout's lifetime across React renders: build it, drive it, and hand its
 * positions to whatever replaces it.
 *
 * The loop itself lives in simulation-loop.ts, where it can be tested against a
 * frame source that holds still. What is left here is the part that genuinely
 * needs React and a document: rebuilding when the scene changes, carrying
 * positions across that rebuild, and connecting `visibilitychange` to the
 * loop's pause. That last one is not covered by the browser -- throttling a
 * background tab is a heuristic rather than a guarantee, and a tab on a second
 * monitor may not be throttled at all.
 */

export interface Simulation {
  /** The live layout. Positions are read off this inside `draw`. */
  layoutRef: RefObject<Layout | null>
  /** Whether frames are currently being scheduled. */
  running: boolean
  /**
   * Put some heat back in and start the loop again.
   *
   * For changes made to the layout in place, which means dragging: the loop
   * stops for good once the graph settles, so a node moved after that would
   * hold its new position and never be drawn in it, and its neighbours would
   * never make room.
   */
  nudge: (alpha?: number) => void
}

export interface SimulationOptions {
  overrides?: Partial<LayoutOptions>
  /**
   * Nodes held where someone put them, by id.
   *
   * A ref rather than a value because it is read at every rebuild and changes
   * on every frame of a drag: as a dependency it would tear the simulation down
   * and start the layout again mid-gesture.
   */
  pins?: RefObject<ReadonlyMap<string, Vec> | null>
}

/**
 * With reduced motion asked for, the layout is solved rather than animated.
 * Nobody is watching the intermediate states, which frees the loop to take
 * several steps per frame and finish in a fraction of the wall time.
 */
const REDUCED_MOTION_STEPS = 8

/**
 * How warm a drag makes the graph.
 *
 * Low on purpose. Enough that the neighbours of the node under the finger
 * shuffle over to make room, not so much that the rest of the picture
 * rearranges itself while somebody is trying to tidy one corner of it.
 */
const DRAG_HEAT = 0.15

export function useSimulation(
  scene: Scene,
  draw: (layout: Layout) => void,
  options: SimulationOptions = {},
): Simulation {
  const layoutRef = useRef<Layout | null>(null)
  const loopRef = useRef<SimulationLoop | null>(null)
  const carriedRef = useRef<Map<string, Vec> | null>(null)
  const drawRef = useRef(draw)
  const optionsRef = useRef(options.overrides)
  const pinsRef = options.pins

  const [running, setRunning] = useState(false)

  // Kept in a ref so a new `draw` closure -- which happens on every render,
  // because it reads the current scene -- does not tear down the animation loop
  // and start the layout again from nothing.
  useEffect(() => {
    drawRef.current = draw
    optionsRef.current = options.overrides
  })

  useEffect(() => {
    const layout = createLayout(
      {
        // `spreadX`/`spreadY` ride along on the scene nodes: the simulation
        // takes them as boxes to keep clear and never learns they are labels.
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
      // And the ones a person chose, which a save must not undo either.
      pinsRef?.current,
    )

    layoutRef.current = layout

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const loop = createSimulationLoop({
      layout,
      host: browserFrameHost,
      draw: (current) => drawRef.current(current),
      stepsPerFrame: calm ? REDUCED_MOTION_STEPS : 1,
      paintWhileRunning: !calm,
      onRunningChange: setRunning,
    })

    loopRef.current = loop

    const onVisibilityChange = () => {
      if (document.hidden) loop.pause()
      else loop.start()
    }

    // Paint before the first frame so that a layout restored from the previous
    // scene -- or one that is already settled, which is every empty graph --
    // still puts something on screen.
    drawRef.current(layout)
    loop.start()

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      loop.stop()
      loopRef.current = null
      document.removeEventListener('visibilitychange', onVisibilityChange)

      /*
       * Only worth carrying if it actually moved.
       *
       * Strict mode mounts, unmounts and mounts again, and the first mount
       * never gets an animation frame -- so without this guard the throwaway
       * layout's *seed* positions get saved, and the real run finds every id
       * already placed and starts at `reheat` instead of cold. A quarter of the
       * heat, from a scatter that has not relaxed at all, settles into a
       * visibly worse picture: measured on the dev seed graph, 9 overlapping
       * pairs against 6, worst clearance 0.91 against 0.97.
       *
       * Leaving the previous snapshot alone rather than clearing it, because a
       * scene replaced before its first frame has not moved off the positions
       * it inherited, and those are still the right ones to hand on.
       */
      if (layout.ticks === 0) return
      // On the way out, not only on settling: a graph replaced mid-flight still
      // has positions worth keeping, and losing them is the jump this whole
      // mechanism exists to avoid.
      carriedRef.current = layoutPositions(layout)
    }
  }, [pinsRef, scene])

  const nudge = useCallback((alpha = DRAG_HEAT) => {
    const layout = layoutRef.current
    if (layout === null) return

    reheat(layout, alpha)
    loopRef.current?.start()
  }, [])

  return { layoutRef, running, nudge }
}
