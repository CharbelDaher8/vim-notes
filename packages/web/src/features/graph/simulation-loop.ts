/**
 * The animation loop, with the browser held at arm's length.
 *
 * This exists as its own module for one reason: "the loop stops when the tab is
 * hidden" and "the loop keeps running but does nothing while the tab is hidden"
 * are the same thing to look at and completely different things to be. The
 * second still wakes the compositor sixty times a second on a laptop running on
 * battery with the window behind something else.
 *
 * Telling them apart needs a test that can see whether a frame was *cancelled*
 * rather than merely wasted, and that needs the frame source to be something a
 * test can hold. So `FrameHost` is injected, exactly as
 * `createAutosaveScheduler` takes its clock -- and simulation-loop.test.ts
 * asserts the difference.
 */

import { isSettled, step, type Layout } from './force-layout'

export interface FrameHost {
  /** Returns a handle. Never 0: `requestAnimationFrame` handles start at 1. */
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  isHidden: () => boolean
}

export const browserFrameHost: FrameHost = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  isHidden: () => document.hidden,
}

export interface SimulationLoopOptions {
  layout: Layout
  draw: (layout: Layout) => void
  host: FrameHost
  /**
   * Steps taken per frame. Above 1 only makes sense when the intermediate
   * states are not painted, which is the reduced-motion case.
   */
  stepsPerFrame?: number
  /** False solves the layout and shows the answer, rather than animating it. */
  paintWhileRunning?: boolean
  onRunningChange?: (running: boolean) => void
}

export interface SimulationLoop {
  /** No-op when already running, hidden, settled, or stopped. */
  start: () => void
  /** Cancels the pending frame. Resumable. */
  pause: () => void
  /** Cancels the pending frame for good. */
  stop: () => void
  isRunning: () => boolean
}

export function createSimulationLoop({
  layout,
  draw,
  host,
  stepsPerFrame = 1,
  paintWhileRunning = true,
  onRunningChange,
}: SimulationLoopOptions): SimulationLoop {
  // 0 means "no frame pending", which is only safe because a real
  // `requestAnimationFrame` handle is never 0.
  let frame = 0
  let stopped = false
  let running = false

  const setRunning = (next: boolean) => {
    if (running === next) return
    running = next
    onRunningChange?.(next)
  }

  const cancelPending = () => {
    if (frame !== 0) host.cancelFrame(frame)
    frame = 0
  }

  const tick = () => {
    // Cleared before the work, not after: this frame has been delivered, so
    // there is nothing left to cancel until a new one is booked.
    frame = 0

    for (let i = 0; i < stepsPerFrame && !isSettled(layout); i += 1) step(layout)

    if (paintWhileRunning || isSettled(layout)) draw(layout)

    // Returning without booking another frame is the whole mechanism. There is
    // no idle loop to fall back to.
    if (isSettled(layout)) {
      setRunning(false)
      return
    }

    frame = host.requestFrame(tick)
  }

  return {
    start: () => {
      if (stopped || frame !== 0 || host.isHidden() || isSettled(layout)) return
      setRunning(true)
      frame = host.requestFrame(tick)
    },

    pause: () => {
      cancelPending()
      setRunning(false)
    },

    stop: () => {
      stopped = true
      cancelPending()
      setRunning(false)
    },

    isRunning: () => running,
  }
}
