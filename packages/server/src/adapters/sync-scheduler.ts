/**
 * Pulls and pushes on a timer.
 *
 * This is what replaced the hub's post-receive hook (DECISIONS §2). With a bare
 * repo on the same box, a laptop push could tell the server instantly. With
 * GitHub as the remote and a server that is tailnet-only, no webhook can reach
 * us, so the server has to ask. Polling is the cost of that trade and this file
 * is where it is paid.
 *
 * Like AutoCommitter, it is deliberately not part of the VersionControl port.
 * `sync()` already does fetch, rebase and push and returns a typed outcome for
 * every failure; *when* to call it is application policy. Nothing here grows its
 * own git logic -- if this file ever needs to know what a rebase is, something
 * has gone wrong in the port.
 *
 * Three things it has to get right:
 *
 * - **A failed sync must never kill the loop.** The most likely failures --
 *   laptop offline, GitHub down, key not yet installed -- are all temporary,
 *   and a scheduler that stops on the first one turns a five-minute outage into
 *   permanent silence.
 * - **It must not hammer.** An auth failure will fail identically forever, so
 *   retrying every minute produces a log nobody reads and pointless load on
 *   someone else's servers.
 * - **It must not fight the auto-committer.** A sync that starts while a save is
 *   pending finds a dirty tree and refuses to rebase, so the pending commit is
 *   flushed first.
 */

import type { SyncOutcome, VersionControl } from '@vim-notes/core'

export interface SyncLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export interface SyncSchedulerOptions {
  /** Milliseconds between syncs. 0 disables polling entirely. */
  intervalMs?: number
  /** Delay before the first sync. Zero means "as soon as the loop starts". */
  initialDelayMs?: number
  /** Ceiling for the backoff after repeated failures. */
  maxBackoffMs?: number
  /**
   * Runs immediately before each sync. In practice this flushes the
   * auto-committer, so that work already on disk is committed and can be
   * rebased rather than blocking the rebase as an uncommitted change.
   */
  beforeSync?: () => Promise<unknown>
  onOutcome?: (outcome: SyncOutcome) => void
  /** Only for a throw. A returned failure is an outcome, not an error. */
  onError?: (error: unknown) => void
  logger?: SyncLogger
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000

/**
 * Failures that will keep failing until a person intervenes.
 *
 * These get the loud log and the backoff. The rest -- a network blip, a push
 * that lost a race, a tree that was dirty for a moment -- are expected in
 * normal operation and resolve on their own.
 */
const NEEDS_A_HUMAN = new Set(['auth', 'no-remote', 'conflict'])

export class SyncScheduler {
  private readonly intervalMs: number
  private readonly initialDelayMs: number
  private readonly maxBackoffMs: number
  private readonly beforeSync: (() => Promise<unknown>) | null
  private readonly onOutcome: (outcome: SyncOutcome) => void
  private readonly onError: (error: unknown) => void
  private readonly logger: SyncLogger

  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<SyncOutcome | null> | null = null
  private stopped = false

  /** Current wait after a failure; reset by any success. */
  private backoffMs: number

  /** What was last logged, so a persistent failure is not logged every cycle. */
  private lastLogged: string | null = null

  constructor(
    private readonly versionControl: VersionControl,
    options: SyncSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.initialDelayMs = options.initialDelayMs ?? 0
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.beforeSync = options.beforeSync ?? null
    this.onOutcome = options.onOutcome ?? (() => {})
    this.onError = options.onError ?? (() => {})
    this.logger = options.logger ?? console
    this.backoffMs = this.intervalMs
  }

  /** True when polling is switched off by configuration. */
  get enabled(): boolean {
    return this.intervalMs > 0
  }

  start(): void {
    if (!this.enabled) {
      // Worth a line in the boot log. A server that never syncs looks identical
      // to one whose syncs are all failing, and the difference matters.
      this.logger.info('sync: polling disabled (SYNC_INTERVAL_MS=0)')
      return
    }

    this.stopped = false
    this.schedule(this.initialDelayMs)
  }

  /** Sync now, outside the schedule. Returns null if one was already running. */
  async syncNow(): Promise<SyncOutcome | null> {
    if (this.inFlight !== null) return this.inFlight
    return this.run()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Awaited rather than abandoned: a sync in flight is holding git's index
    // lock, and exiting under it leaves a lock file that blocks the next boot.
    await this.inFlight
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.enabled) return

    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, delayMs)
  }

  private run(): Promise<SyncOutcome | null> {
    const attempt = this.attempt().finally(() => {
      this.inFlight = null
    })
    this.inFlight = attempt
    return attempt
  }

  private async attempt(): Promise<SyncOutcome | null> {
    let nextDelayMs = this.intervalMs

    try {
      if (this.beforeSync !== null) {
        // A failure to commit must not stop the pull: the remote may hold work
        // this box has not seen, and fetching it is still worth doing.
        await this.beforeSync().catch((error: unknown) => this.onError(error))
      }

      const outcome = await this.versionControl.sync()
      this.onOutcome(outcome)
      nextDelayMs = this.record(outcome)
      return outcome
    } catch (error) {
      // A throw is not a modelled outcome -- git missing, a corrupt repository.
      // Backing off is right for the same reason as an auth failure.
      this.onError(error)
      this.logOnce('threw', () => this.logger.error('sync: failed unexpectedly; backing off'))
      nextDelayMs = this.nextBackoff()
      return null
    } finally {
      // Scheduled from `finally` so that no path through this method can leave
      // the loop dead, which is the one failure that would be permanent.
      this.schedule(nextDelayMs)
    }
  }

  /** Logs the outcome and returns how long to wait before the next attempt. */
  private record(outcome: SyncOutcome): number {
    if (outcome.ok) {
      // Only worth a line when something moved. A quiet server syncing every
      // minute would otherwise fill the log with "changed nothing".
      if (outcome.pulled > 0 || outcome.pushed > 0) {
        this.logger.info(`sync: pulled ${outcome.pulled}, pushed ${outcome.pushed}`)
      }
      this.backoffMs = this.intervalMs
      this.lastLogged = null
      return this.intervalMs
    }

    if (outcome.reason === 'dirty') {
      // Expected: a save landed between the flush and the rebase. The next tick
      // will almost certainly succeed, so this neither backs off nor shouts.
      this.logOnce('dirty', () => this.logger.info('sync: working tree busy, will retry'))
      return this.intervalMs
    }

    if (NEEDS_A_HUMAN.has(outcome.reason)) {
      this.logOnce(outcome.reason, () => this.logger.error(`sync: ${describe(outcome)}`))
      return this.nextBackoff()
    }

    this.logOnce(outcome.reason, () => this.logger.warn(`sync: ${describe(outcome)}`))
    return this.nextBackoff()
  }

  /**
   * Logs only when the situation changes.
   *
   * Backoff already thins these out, but a remote that is down for a day would
   * still produce a wall of identical lines, and a log that repeats itself is
   * one people stop reading -- which defeats the point of logging the failure
   * loudly in the first place.
   */
  private logOnce(key: string, write: () => void): void {
    if (this.lastLogged === key) return
    this.lastLogged = key
    write()
  }

  private nextBackoff(): number {
    const next = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    this.backoffMs = next
    return next
  }
}

function describe(outcome: Exclude<SyncOutcome, { ok: true }>): string {
  switch (outcome.reason) {
    case 'conflict':
      return outcome.conflicted.length === 0
        ? 'the remote and this copy have diverged and cannot be reconciled automatically'
        : `conflicting notes need resolving: ${outcome.conflicted.join(', ')}`
    case 'auth':
      return `the remote rejected our credentials, which will not fix itself: ${outcome.message}`
    case 'no-remote':
      return `no remote to sync with: ${outcome.message}`
    case 'rejected':
      return `push refused, the remote moved first: ${outcome.message}`
    case 'network':
      return `could not reach the remote: ${outcome.message}`
    case 'dirty':
      return `working tree not clean: ${outcome.message}`
  }
}
