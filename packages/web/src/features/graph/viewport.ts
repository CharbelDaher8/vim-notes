/**
 * Pan and zoom, as arithmetic.
 *
 * A viewport is the affine transform `screen = world * k + (x, y)` -- exactly
 * what an SVG `translate(x y) scale(k)` does, so the numbers in here go
 * straight onto the element with no conversion step in between.
 *
 * Separate from the component for the same reason the simulation is: "does
 * zooming keep the point under the finger still?" is a question about numbers,
 * and answering it by pinching a phone is slow and unrepeatable.
 */

import type { Bounds, Vec } from './force-layout'

export interface Viewport {
  x: number
  y: number
  /** Scale. 1 means one world unit per CSS pixel. */
  k: number
}

export interface Size {
  width: number
  height: number
}

export const IDENTITY: Viewport = { x: 0, y: 0, k: 1 }

export const MIN_SCALE = 0.08
export const MAX_SCALE = 6

/**
 * A graph of three nodes should not be blown up until they fill the screen and
 * look like a mistake, so fitting stops short of magnifying.
 */
export const MAX_FIT_SCALE = 1.35

export function clampScale(k: number): number {
  // NaN survives every comparison, so `Math.min`/`Math.max` would pass it
  // straight through and put a NaN in the SVG transform, which silently blanks
  // the whole graph. Infinity needs no special case -- it clamps.
  if (Number.isNaN(k)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { x: view.x + dx, y: view.y + dy, k: view.k }
}

/**
 * Zoom while holding one screen point still.
 *
 * The anchor is the whole trick: zooming about the centre of the element makes
 * the thing you were looking at slide away, so the cursor (or the midpoint
 * between two fingers) has to be the fixed point instead.
 */
export function zoomAround(view: Viewport, factor: number, anchor: Vec): Viewport {
  const k = clampScale(view.k * factor)
  const world = toWorld(view, anchor)

  return { k, x: anchor.x - world.x * k, y: anchor.y - world.y * k }
}

export function toWorld(view: Viewport, point: Vec): Vec {
  return { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k }
}

export function toScreen(view: Viewport, point: Vec): Vec {
  return { x: point.x * view.k + view.x, y: point.y * view.k + view.y }
}

/** Put a world point in the middle of the element without changing the zoom. */
export function centreOn(view: Viewport, point: Vec, size: Size): Viewport {
  return {
    k: view.k,
    x: size.width / 2 - point.x * view.k,
    y: size.height / 2 - point.y * view.k,
  }
}

/** The view that shows all of `bounds`, with room around the edge. */
export function fitToBounds(bounds: Bounds, size: Size, padding = 44): Viewport {
  const width = Math.max(bounds.maxX - bounds.minX, 1)
  const height = Math.max(bounds.maxY - bounds.minY, 1)

  // Padding is clamped rather than trusted: on a narrow phone in landscape it
  // can exceed the element, and a negative usable width would invert the scale.
  const usableWidth = Math.max(size.width - padding * 2, 1)
  const usableHeight = Math.max(size.height - padding * 2, 1)

  const k = clampScale(Math.min(usableWidth / width, usableHeight / height, MAX_FIT_SCALE))
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }

  return centreOn({ x: 0, y: 0, k }, centre, size)
}

export interface PinchStart {
  view: Viewport
  /** Distance between the two pointers when the gesture began. */
  distance: number
  /** Midpoint between them, in element coordinates. */
  centre: Vec
}

/**
 * The view for a two-finger gesture, computed from where it started rather than
 * from the previous frame.
 *
 * Accumulating deltas frame by frame drifts: every rounding error is kept, and
 * a pinch that returns to where it began does not return to the original zoom.
 * Deriving the whole transform from the gesture's start makes that impossible.
 */
export function pinchViewport(start: PinchStart, distance: number, centre: Vec): Viewport {
  const factor = distance / Math.max(start.distance, 1)
  const zoomed = zoomAround(start.view, factor, start.centre)

  // Two fingers moving together pan as well as zoom, which is what makes a
  // pinch feel like it is holding the canvas rather than scaling it in place.
  return panBy(zoomed, centre.x - start.centre.x, centre.y - start.centre.y)
}

export function distanceBetween(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function midpointOf(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * A wheel notch as a zoom factor.
 *
 * `deltaMode` matters: a mouse wheel usually reports pixels, but Firefox on
 * some platforms reports lines, and treating 3 lines as 3 pixels makes the
 * wheel feel broken. The delta is also capped, because a trackpad flick can
 * deliver a single event of several hundred and jump the zoom to a limit.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  const capped = Math.max(-120, Math.min(120, pixels))

  return Math.exp(-capped / 320)
}
