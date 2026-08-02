import { describe, expect, it } from 'vitest'

import {
  centreOn,
  clampScale,
  distanceBetween,
  fitToBounds,
  IDENTITY,
  MAX_FIT_SCALE,
  MAX_SCALE,
  midpointOf,
  MIN_SCALE,
  panBy,
  pinchViewport,
  toScreen,
  toWorld,
  wheelZoomFactor,
  zoomAround,
  type Viewport,
} from './viewport'

const SIZE = { width: 800, height: 600 }

describe('clampScale', () => {
  it('holds the scale inside its limits', () => {
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(0)).toBe(MIN_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('falls back to 1 rather than propagating a NaN through the transform', () => {
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MAX_SCALE)
  })
})

describe('toWorld and toScreen', () => {
  it('are inverses of each other', () => {
    const view: Viewport = { x: -120, y: 45, k: 2.5 }
    const point = { x: 317, y: -88 }

    const round = toScreen(view, toWorld(view, point))

    expect(round.x).toBeCloseTo(point.x, 10)
    expect(round.y).toBeCloseTo(point.y, 10)
  })
})

describe('zoomAround', () => {
  it('leaves the anchor exactly where it was', () => {
    const anchor = { x: 200, y: 150 }
    const before = toWorld({ x: 10, y: 20, k: 1 }, anchor)

    const after = toWorld(zoomAround({ x: 10, y: 20, k: 1 }, 2.4, anchor), anchor)

    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('holds the anchor even when the zoom hits its ceiling', () => {
    const anchor = { x: 400, y: 300 }
    const start: Viewport = { x: 0, y: 0, k: MAX_SCALE }

    const zoomed = zoomAround(start, 10, anchor)

    expect(zoomed.k).toBe(MAX_SCALE)
    expect(toWorld(zoomed, anchor)).toEqual(toWorld(start, anchor))
  })
})

describe('panBy', () => {
  it('moves the origin and leaves the scale alone', () => {
    expect(panBy({ x: 5, y: 5, k: 3 }, 10, -4)).toEqual({ x: 15, y: 1, k: 3 })
  })
})

describe('fitToBounds', () => {
  it('puts the middle of the graph in the middle of the element', () => {
    const view = fitToBounds({ minX: 100, minY: 200, maxX: 300, maxY: 400 }, SIZE)
    const centre = toScreen(view, { x: 200, y: 300 })

    expect(centre.x).toBeCloseTo(400, 6)
    expect(centre.y).toBeCloseTo(300, 6)
  })

  it('brings every corner inside the element', () => {
    const bounds = { minX: -4000, minY: -2500, maxX: 4000, maxY: 2500 }
    const view = fitToBounds(bounds, SIZE)

    for (const corner of [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
    ]) {
      const point = toScreen(view, corner)
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(SIZE.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(SIZE.height)
    }
  })

  it('refuses to magnify a tiny graph until it fills the screen', () => {
    const view = fitToBounds({ minX: -5, minY: -5, maxX: 5, maxY: 5 }, SIZE)

    expect(view.k).toBeLessThanOrEqual(MAX_FIT_SCALE)
  })

  it('survives bounds with no extent at all', () => {
    const view = fitToBounds({ minX: 7, minY: 7, maxX: 7, maxY: 7 }, SIZE)

    expect(Number.isFinite(view.x)).toBe(true)
    expect(Number.isFinite(view.y)).toBe(true)
    expect(view.k).toBeGreaterThan(0)
  })

  it('survives an element smaller than its own padding', () => {
    const view = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { width: 30, height: 20 })

    expect(view.k).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(Number.isFinite(view.x)).toBe(true)
  })
})

describe('centreOn', () => {
  it('keeps the zoom and moves the point to the middle', () => {
    const view = centreOn({ x: 0, y: 0, k: 2 }, { x: 50, y: -25 }, SIZE)
    const point = toScreen(view, { x: 50, y: -25 })

    expect(view.k).toBe(2)
    expect(point.x).toBeCloseTo(400, 6)
    expect(point.y).toBeCloseTo(300, 6)
  })
})

describe('pinchViewport', () => {
  const start = { view: IDENTITY, distance: 100, centre: { x: 300, y: 300 } }

  it('changes nothing while the fingers have not moved', () => {
    const view = pinchViewport(start, 100, { x: 300, y: 300 })

    expect(view.k).toBeCloseTo(1, 10)
    expect(view.x).toBeCloseTo(0, 10)
    expect(view.y).toBeCloseTo(0, 10)
  })

  it('zooms in as the fingers separate and back out as they close', () => {
    expect(pinchViewport(start, 200, start.centre).k).toBeCloseTo(2, 10)
    expect(pinchViewport(start, 50, start.centre).k).toBeCloseTo(0.5, 10)
  })

  it('returns to the original view when the gesture returns to where it began', () => {
    // Derived from the gesture's start rather than accumulated frame by frame,
    // so a pinch out and back does not leave the zoom slightly off.
    const wandered = pinchViewport(start, 260, { x: 120, y: 480 })
    expect(wandered.k).not.toBeCloseTo(1, 3)

    const back = pinchViewport(start, 100, { x: 300, y: 300 })
    expect(back).toEqual(pinchViewport(start, 100, { x: 300, y: 300 }))
    expect(back.k).toBeCloseTo(1, 10)
  })

  it('pans with two fingers moving together', () => {
    const view = pinchViewport(start, 100, { x: 340, y: 310 })

    expect(view.x).toBeCloseTo(40, 6)
    expect(view.y).toBeCloseTo(10, 6)
  })

  it('does not divide by zero when both fingers land on the same point', () => {
    const view = pinchViewport({ ...start, distance: 0 }, 10, start.centre)

    expect(Number.isFinite(view.k)).toBe(true)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in scrolling up and out scrolling down', () => {
    expect(wheelZoomFactor(-50)).toBeGreaterThan(1)
    expect(wheelZoomFactor(50)).toBeLessThan(1)
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it('reads line and page deltas as bigger than pixel ones', () => {
    expect(wheelZoomFactor(3, 1)).toBeLessThan(wheelZoomFactor(3, 0))
    expect(wheelZoomFactor(1, 2)).toBeLessThan(wheelZoomFactor(1, 1))
  })

  it('caps a trackpad flick so one event cannot jump to the limit', () => {
    expect(wheelZoomFactor(4000)).toBe(wheelZoomFactor(120))
  })
})

describe('gesture geometry', () => {
  it('measures the distance and midpoint between two pointers', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpointOf({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 })
  })
})
