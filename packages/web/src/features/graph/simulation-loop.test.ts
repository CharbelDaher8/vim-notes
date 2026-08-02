import { describe, expect, it, vi } from 'vitest'

import { createLayout, isSettled, step, type Layout } from './force-layout'
import { createSimulationLoop, type FrameHost } from './simulation-loop'

/**
 * A frame source a test can hold still.
 *
 * It counts cancellations separately from deliveries, which is the only way to
 * tell "the loop stopped" from "the loop kept running and did nothing" -- the
 * distinction this whole module exists for.
 */
function fakeHost() {
  const pending = new Map<number, () => void>()
  let nextHandle = 1
  let cancelled = 0
  let hidden = false

  const host: FrameHost = {
    requestFrame: (callback) => {
      const handle = nextHandle
      nextHandle += 1
      pending.set(handle, callback)
      return handle
    },
    cancelFrame: (handle) => {
      if (pending.delete(handle)) cancelled += 1
    },
    isHidden: () => hidden,
  }

  return {
    host,
    /** Deliver every queued callback once, as a browser would on one frame. */
    deliverFrame: () => {
      const queued = [...pending.values()]
      pending.clear()
      for (const callback of queued) callback()
    },
    booked: () => pending.size,
    cancelled: () => cancelled,
    hide: () => {
      hidden = true
    },
    show: () => {
      hidden = false
    },
  }
}

const moving = (): Layout =>
  createLayout({
    nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })),
    edges: Array.from({ length: 11 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  })

const alreadySettled = (): Layout => {
  const layout = moving()
  while (!isSettled(layout)) step(layout)
  return layout
}

describe('running', () => {
  it('books a frame when started, and one at a time', () => {
    const fake = fakeHost()
    const loop = createSimulationLoop({ layout: moving(), draw: () => {}, host: fake.host })

    loop.start()
    loop.start()

    expect(fake.booked()).toBe(1)
    expect(loop.isRunning()).toBe(true)
  })

  it('advances the layout and paints once per frame', () => {
    const fake = fakeHost()
    const layout = moving()
    const draw = vi.fn()
    const loop = createSimulationLoop({ layout, draw, host: fake.host })

    loop.start()
    fake.deliverFrame()
    fake.deliverFrame()

    expect(layout.ticks).toBe(2)
    expect(draw).toHaveBeenCalledTimes(2)
  })

  it('takes several steps per frame when asked, painting once', () => {
    const fake = fakeHost()
    const layout = moving()
    const draw = vi.fn()
    const loop = createSimulationLoop({ layout, draw, host: fake.host, stepsPerFrame: 8 })

    loop.start()
    fake.deliverFrame()

    expect(layout.ticks).toBe(8)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('paints only the finished layout when animation is not wanted', () => {
    const fake = fakeHost()
    const layout = moving()
    const draw = vi.fn()
    const loop = createSimulationLoop({
      layout,
      draw,
      host: fake.host,
      stepsPerFrame: 8,
      paintWhileRunning: false,
    })

    loop.start()
    fake.deliverFrame()
    expect(draw).not.toHaveBeenCalled()

    while (fake.booked() > 0) fake.deliverFrame()

    // Exactly once, at the end: reduced motion gets the answer, not the working.
    expect(draw).toHaveBeenCalledTimes(1)
    expect(isSettled(layout)).toBe(true)
  })
})

describe('stopping when the layout settles', () => {
  it('books no further frame once nothing is moving', () => {
    const fake = fakeHost()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()

    let frames = 0
    while (fake.booked() > 0) {
      if (frames > 2_000) throw new Error('the loop never stopped booking frames')
      fake.deliverFrame()
      frames += 1
    }

    expect(isSettled(layout)).toBe(true)
    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })

  it('refuses to start a layout that is already finished', () => {
    const fake = fakeHost()
    const loop = createSimulationLoop({
      layout: alreadySettled(),
      draw: () => {},
      host: fake.host,
    })

    loop.start()

    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })

  it('reports each transition once rather than on every frame', () => {
    const fake = fakeHost()
    const onRunningChange = vi.fn()
    const loop = createSimulationLoop({
      layout: moving(),
      draw: () => {},
      host: fake.host,
      onRunningChange,
    })

    loop.start()
    loop.start()
    while (fake.booked() > 0) fake.deliverFrame()

    expect(onRunningChange.mock.calls).toEqual([[true], [false]])
  })
})

/**
 * The property this module was extracted to make testable. A loop that keeps
 * being scheduled and returns early each frame passes every assertion about
 * "the layout did not advance" and still wakes the compositor sixty times a
 * second behind another window.
 */
describe('when the tab is hidden', () => {
  it('cancels the pending frame rather than letting it fire and do nothing', () => {
    const fake = fakeHost()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()
    expect(fake.booked()).toBe(1)

    fake.hide()
    loop.pause()

    // Cancelled, not merely wasted: nothing is left booked, and the browser was
    // told so rather than being left to deliver a frame that would no-op.
    expect(fake.cancelled()).toBe(1)
    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })

  it('does no further work, because there is no frame left to deliver', () => {
    const fake = fakeHost()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()
    fake.deliverFrame()
    const ticksWhenHidden = layout.ticks

    fake.hide()
    loop.pause()

    for (let i = 0; i < 100; i += 1) fake.deliverFrame()

    expect(layout.ticks).toBe(ticksWhenHidden)
  })

  it('books nothing if asked to start while hidden', () => {
    const fake = fakeHost()
    fake.hide()

    const loop = createSimulationLoop({ layout: moving(), draw: () => {}, host: fake.host })
    loop.start()

    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })

  /**
   * Found in a browser, not here: a page that renders in a background tab and
   * is screenshotted without ever being switched to gets no `visibilitychange`
   * at all. Waiting for one meant the layout stayed on its seeded scatter for
   * good -- which read as a graph whose forces were not running, because none
   * of them ever had been.
   */
  it('solves the layout instead of waiting, when there is nobody to animate for', () => {
    const fake = fakeHost()
    fake.hide()
    const layout = moving()
    const draw = vi.fn()

    const loop = createSimulationLoop({ layout, draw, host: fake.host })
    loop.start()

    expect(isSettled(layout)).toBe(true)
    expect(layout.ticks).toBeGreaterThan(1)
    // Once, at the end. Painting every intermediate step would be the cost the
    // loop stops for, paid without the benefit anyone would see.
    expect(draw).toHaveBeenCalledTimes(1)
    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })

  it('has nothing left to do when the tab is finally shown', () => {
    const fake = fakeHost()
    fake.hide()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()
    fake.show()
    loop.start()

    expect(fake.booked()).toBe(0)
  })

  it('still refuses to solve after stop', () => {
    const fake = fakeHost()
    fake.hide()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.stop()
    loop.start()

    expect(layout.ticks).toBe(0)
  })

  it('picks up where it left off when the tab comes back', () => {
    const fake = fakeHost()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()
    fake.deliverFrame()
    const ticksWhenHidden = layout.ticks

    fake.hide()
    loop.pause()
    fake.show()
    loop.start()
    fake.deliverFrame()

    expect(layout.ticks).toBe(ticksWhenHidden + 1)
    expect(loop.isRunning()).toBe(true)
  })

  it('does not wake a settled layout when the tab comes back', () => {
    const fake = fakeHost()
    const layout = moving()
    const loop = createSimulationLoop({ layout, draw: () => {}, host: fake.host })

    loop.start()
    while (fake.booked() > 0) fake.deliverFrame()

    fake.hide()
    loop.pause()
    fake.show()
    loop.start()

    expect(fake.booked()).toBe(0)
  })

  it('pausing twice cancels once and stays quiet', () => {
    const fake = fakeHost()
    const loop = createSimulationLoop({ layout: moving(), draw: () => {}, host: fake.host })

    loop.start()
    loop.pause()
    loop.pause()

    expect(fake.cancelled()).toBe(1)
    expect(fake.booked()).toBe(0)
  })
})

describe('stop', () => {
  it('cancels the pending frame and refuses to restart', () => {
    const fake = fakeHost()
    const loop = createSimulationLoop({ layout: moving(), draw: () => {}, host: fake.host })

    loop.start()
    loop.stop()

    expect(fake.cancelled()).toBe(1)

    // Unmounting has to be final. A visibility change arriving after teardown
    // must not resurrect a loop whose component is gone.
    loop.start()
    expect(fake.booked()).toBe(0)
    expect(loop.isRunning()).toBe(false)
  })
})
