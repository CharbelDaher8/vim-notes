import type {
  CommitEntry,
  CommitRef,
  RepoStatus,
  SyncOutcome,
  VersionControl,
} from '@vim-notes/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SyncScheduler } from './sync-scheduler'

/**
 * Only `sync` is exercised. Driving a real repository here would make timing
 * assertions slow and flaky, and the scheduling policy is what is under test --
 * the git behaviour it depends on is covered by the adapter's own suite.
 */
class FakeVersionControl implements VersionControl {
  readonly calls: number[] = []
  outcome: SyncOutcome = { ok: true, pulled: 0, pushed: 0 }
  handler: (() => Promise<SyncOutcome>) | null = null

  async sync(): Promise<SyncOutcome> {
    this.calls.push(Date.now())
    if (this.handler !== null) return this.handler()
    return this.outcome
  }

  commit(): Promise<CommitRef | null> {
    throw new Error('the scheduler does not commit')
  }
  log(): Promise<CommitEntry[]> {
    throw new Error('the scheduler does not read history')
  }
  diff(): Promise<string> {
    throw new Error('the scheduler does not diff')
  }
  restore(): Promise<string> {
    throw new Error('the scheduler does not restore')
  }
  status(): Promise<RepoStatus> {
    throw new Error('the scheduler does not read status')
  }
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function recordingLogger() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (message: string) => lines.push(`info ${message}`),
      warn: (message: string) => lines.push(`warn ${message}`),
      error: (message: string) => lines.push(`error ${message}`),
    },
  }
}

const failure = (reason: 'auth' | 'network' | 'no-remote' | 'rejected' | 'dirty'): SyncOutcome => ({
  ok: false,
  reason,
  message: `${reason} happened`,
})

describe('SyncScheduler', () => {
  let vcs: FakeVersionControl

  beforeEach(() => {
    vi.useFakeTimers()
    vcs = new FakeVersionControl()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does nothing at all when the interval is zero', async () => {
    const scheduler = new SyncScheduler(vcs, { intervalMs: 0, logger: silentLogger() })

    expect(scheduler.enabled).toBe(false)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(vcs.calls).toHaveLength(0)
  })

  it('syncs on start and then on the interval', async () => {
    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vcs.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(3)

    await scheduler.stop()
  })

  it('flushes pending work before syncing', async () => {
    // The ordering is the point: a sync that runs first finds a dirty tree and
    // refuses to rebase.
    const order: string[] = []
    const scheduler = new SyncScheduler(vcs, {
      intervalMs: 60_000,
      logger: silentLogger(),
      beforeSync: async () => {
        order.push('flush')
      },
    })
    vcs.handler = async () => {
      order.push('sync')
      return { ok: true, pulled: 0, pushed: 0 }
    }

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(order).toEqual(['flush', 'sync'])
    await scheduler.stop()
  })

  it('syncs anyway when the flush fails', async () => {
    // The remote may hold work this box has never seen; failing to commit is no
    // reason to skip fetching it.
    const errors: unknown[] = []
    const scheduler = new SyncScheduler(vcs, {
      intervalMs: 60_000,
      logger: silentLogger(),
      onError: (error) => errors.push(error),
      beforeSync: async () => {
        throw new Error('commit failed')
      },
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(vcs.calls).toHaveLength(1)
    expect(errors).toHaveLength(1)
    await scheduler.stop()
  })

  it('does not start a second sync while one is running', async () => {
    let release: (outcome: SyncOutcome) => void = () => {}
    vcs.handler = () =>
      new Promise<SyncOutcome>((resolve) => {
        release = resolve
      })

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vcs.calls).toHaveLength(1)

    // Well past the interval, but the first sync has not finished.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(vcs.calls).toHaveLength(1)

    vcs.handler = null
    release({ ok: true, pulled: 0, pushed: 0 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(2)

    await scheduler.stop()
  })

  it('keeps polling after a thrown error', async () => {
    // The one failure that would be permanent is a loop that stops.
    const errors: unknown[] = []
    vcs.handler = async () => {
      throw new Error('git exploded')
    }

    const scheduler = new SyncScheduler(vcs, {
      intervalMs: 60_000,
      logger: silentLogger(),
      onError: (error) => errors.push(error),
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vcs.calls).toHaveLength(1)

    // Backed off to 120s, so nothing at 60s and a retry by 120s.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(2)

    expect(errors).toHaveLength(2)
    await scheduler.stop()
  })

  it('backs off on an auth failure rather than retrying every interval', async () => {
    // A bad deploy key fails identically forever; hammering it is noise and
    // pointless load on someone else's servers.
    vcs.outcome = failure('auth')

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vcs.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(2)

    // And again, doubling: 240s until the third.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vcs.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vcs.calls).toHaveLength(3)

    await scheduler.stop()
  })

  it('caps the backoff', async () => {
    vcs.outcome = failure('auth')
    const scheduler = new SyncScheduler(vcs, {
      intervalMs: 60_000,
      maxBackoffMs: 120_000,
      logger: silentLogger(),
    })

    scheduler.start()
    for (let tick = 0; tick < 10; tick++) await vi.advanceTimersByTimeAsync(120_000)

    // Without the cap this would have stopped retrying within the window.
    expect(vcs.calls.length).toBeGreaterThanOrEqual(9)
    await scheduler.stop()
  })

  it('resets the backoff after a success', async () => {
    vcs.outcome = failure('network')
    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    vcs.outcome = { ok: true, pulled: 0, pushed: 0 }

    // Backed off to 120s for the retry that then succeeds.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vcs.calls).toHaveLength(2)

    // Back to the normal interval.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vcs.calls).toHaveLength(3)

    await scheduler.stop()
  })

  it('does not back off on a dirty tree', async () => {
    // Expected when a save lands mid-cycle; the next tick usually succeeds.
    vcs.outcome = failure('dirty')
    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(vcs.calls).toHaveLength(3)
    await scheduler.stop()
  })

  it('logs a persistent failure once rather than every cycle', async () => {
    const { lines, logger } = recordingLogger()
    vcs.outcome = failure('auth')

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger })
    scheduler.start()
    for (let tick = 0; tick < 6; tick++) await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(vcs.calls.length).toBeGreaterThan(2)
    expect(lines.filter((line) => line.startsWith('error'))).toHaveLength(1)
    await scheduler.stop()
  })

  it('speaks up again when the failure changes', async () => {
    const { lines, logger } = recordingLogger()
    vcs.outcome = failure('network')

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    vcs.outcome = failure('auth')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(lines.filter((line) => line.startsWith('warn'))).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith('error'))).toHaveLength(1)
    await scheduler.stop()
  })

  it('stays quiet when a successful sync moved nothing', async () => {
    const { lines, logger } = recordingLogger()
    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(vcs.calls.length).toBeGreaterThan(2)
    expect(lines).toEqual([])
    await scheduler.stop()
  })

  it('reports a sync that moved commits', async () => {
    const { lines, logger } = recordingLogger()
    vcs.outcome = { ok: true, pulled: 2, pushed: 1 }

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(lines).toEqual(['info sync: pulled 2, pushed 1'])
    await scheduler.stop()
  })

  it('names the conflicting notes so the log says what to open', async () => {
    const { lines, logger } = recordingLogger()
    vcs.outcome = { ok: false, reason: 'conflict', conflicted: ['a.md', 'b.md'] as never }

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(lines[0]).toContain('a.md, b.md')
    await scheduler.stop()
  })

  it('stops cleanly and waits for a sync in flight', async () => {
    // Exiting under a running sync leaves git's index lock behind, which blocks
    // the next boot.
    let release: (outcome: SyncOutcome) => void = () => {}
    vcs.handler = () =>
      new Promise<SyncOutcome>((resolve) => {
        release = resolve
      })

    const scheduler = new SyncScheduler(vcs, { intervalMs: 60_000, logger: silentLogger() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)

    release({ ok: true, pulled: 0, pushed: 0 })
    await stopping
    expect(stopped).toBe(true)

    // And nothing further is scheduled.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(vcs.calls).toHaveLength(1)
  })
})
