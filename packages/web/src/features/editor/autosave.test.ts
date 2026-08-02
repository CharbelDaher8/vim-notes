import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAutosaveScheduler } from './autosave'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createAutosaveScheduler', () => {
  it('saves once the typing stops', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save, delayMs: 900 })

    scheduler.schedule()
    vi.advanceTimersByTime(899)
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('restarts the quiet period on every keystroke', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save, delayMs: 900, maxDelayMs: 60_000 })

    for (let i = 0; i < 5; i += 1) {
      scheduler.schedule()
      vi.advanceTimersByTime(500)
    }

    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(900)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('still saves someone who never stops typing, at the max delay', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save, delayMs: 900, maxDelayMs: 3_000 })

    for (let i = 0; i < 10; i += 1) {
      scheduler.schedule()
      vi.advanceTimersByTime(400)
    }

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('rearms cleanly after firing', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save, delayMs: 100, maxDelayMs: 1_000 })

    scheduler.schedule()
    vi.advanceTimersByTime(100)
    scheduler.schedule()
    vi.advanceTimersByTime(100)

    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flushes a pending save and does nothing when none is pending', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save })

    scheduler.flush()
    expect(save).not.toHaveBeenCalled()

    scheduler.schedule()
    expect(scheduler.isPending()).toBe(true)
    scheduler.flush()

    expect(save).toHaveBeenCalledTimes(1)
    expect(scheduler.isPending()).toBe(false)

    // The flush consumed the pending save; the timer must not fire again.
    vi.advanceTimersByTime(10_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('cancel drops a pending save', () => {
    const save = vi.fn()
    const scheduler = createAutosaveScheduler({ save, delayMs: 100 })

    scheduler.schedule()
    scheduler.cancel()
    vi.advanceTimersByTime(10_000)

    expect(save).not.toHaveBeenCalled()
  })
})
