/**
 * Debounces saves into commits.
 *
 * This is deliberately not part of the VersionControl port. The port exposes a
 * plain `commit()` because that is what git offers; *when* to commit is an
 * application policy, and one that changes with the client -- the editor saves
 * on every keystroke pause, a future import job would want one commit for the
 * whole batch. Keeping the policy here means the git adapter stays a thin
 * translation of the port and this file stays testable against a fake.
 *
 * Two properties matter:
 *
 * - Rapid saves coalesce. Typing in CodeMirror with autosave produces a save
 *   every few hundred milliseconds; one commit per save would make the history
 *   useless as history and spend more time in `git` than in the editor.
 * - It is explicitly flushable. On shutdown the last edit must reach a commit
 *   before the process exits, otherwise the source of truth quietly loses the
 *   thing the user typed most recently.
 *
 * `commit()` returning null is the normal case here, not an error: the debounce
 * often fires when a previous commit already swept up the change.
 */

import type { CommitRef, NotePath, VersionControl } from '@vim-notes/core'

export interface AutoCommitterOptions {
  /** Quiet period after the last save before committing. */
  idleMs?: number
  /**
   * Upper bound on how long a change can sit uncommitted. Without it, a steady
   * stream of saves -- someone typing without pausing for two seconds -- would
   * push the deadline back forever and never commit at all.
   */
  maxDelayMs?: number
  /** Overridable so the API can label a commit with something better. */
  formatMessage?: (paths: NotePath[]) => string
  /**
   * Called when a commit throws. There is nobody to return the error to: the
   * commit was triggered by a timer, not by a request. Swallowing it silently
   * would hide a repository that has stopped recording history, so a sink is
   * required in practice even though it defaults to doing nothing.
   */
  onError?: (error: unknown) => void
}

const DEFAULT_IDLE_MS = 2_000
const DEFAULT_MAX_DELAY_MS = 30_000

/** Enough to identify the change; beyond this the diff is the better record. */
const MAX_LISTED_PATHS = 20

export class AutoCommitter {
  private readonly idleMs: number
  private readonly maxDelayMs: number
  private readonly formatMessage: (paths: NotePath[]) => string
  private readonly onError: (error: unknown) => void

  private readonly pending = new Set<NotePath>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private windowStartedAt = 0
  private inFlight: Promise<unknown> | null = null
  private stopped = false

  constructor(
    private readonly versionControl: VersionControl,
    options: AutoCommitterOptions = {},
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.formatMessage = options.formatMessage ?? describeChange
    this.onError = options.onError ?? (() => {})
  }

  /** Record that a note was written. Cheap and synchronous by design. */
  recordSave(path: NotePath): void {
    if (this.stopped) return
    this.pending.add(path)
    this.schedule()
  }

  /** True while a commit is owed. Useful for a health endpoint. */
  get hasPending(): boolean {
    return this.timer !== null || this.pending.size > 0
  }

  /**
   * Commit now rather than waiting out the debounce. Waits for any commit
   * already in flight first, so callers never race one.
   */
  async flush(): Promise<CommitRef | null> {
    this.cancelTimer()
    return this.commitAfterInFlight()
  }

  /** Flush, then ignore any further saves. For shutdown. */
  async stop(): Promise<CommitRef | null> {
    this.stopped = true
    return this.flush()
  }

  private schedule(): void {
    const now = Date.now()

    if (this.timer === null) this.windowStartedAt = now
    else clearTimeout(this.timer)

    const remainingBudget = this.maxDelayMs - (now - this.windowStartedAt)
    const delay = Math.max(0, Math.min(this.idleMs, remainingBudget))

    this.timer = setTimeout(() => {
      this.timer = null
      void this.commitAfterInFlight().catch(this.onError)
    }, delay)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private commitAfterInFlight(): Promise<CommitRef | null> {
    const run = (this.inFlight ?? Promise.resolve()).then(
      () => this.runCommit(),
      () => this.runCommit(),
    )

    // Track it so the next caller queues behind this one, but never let a
    // rejection here become an unhandled one: runCommit already reports errors.
    this.inFlight = run.then(
      () => undefined,
      () => undefined,
    )

    return run
  }

  private async runCommit(): Promise<CommitRef | null> {
    // Claim the batch before the first await. Saves that arrive while git is
    // running belong to the next commit, and their own debounce will schedule
    // it -- if that commit finds the work already swept up it returns null,
    // which is why null has to be an ordinary outcome.
    const paths = [...this.pending].sort()
    this.pending.clear()

    try {
      // No pathspec: the commit takes the whole working tree. nvim in the pty
      // writes files this process never hears about (DECISIONS §3), and scoping
      // the commit to the paths we happen to know about would leave those
      // uncommitted indefinitely. The paths only shape the message.
      return await this.versionControl.commit(this.formatMessage(paths))
    } catch (error) {
      // Not re-queued: the files are still uncommitted on disk, so the next
      // commit picks them up regardless. Only the message loses their names.
      this.onError(error)
      return null
    }
  }
}

export function describeChange(paths: readonly NotePath[]): string {
  if (paths.length === 0) return 'Update notes'
  if (paths.length === 1) return `Update ${paths[0]}`

  const listed = paths.slice(0, MAX_LISTED_PATHS)
  const remainder = paths.length - listed.length
  const body = remainder > 0 ? [...listed, `...and ${remainder} more`] : [...listed]

  // Subject line, blank line, then one path per line: the git convention, and
  // the reason `log` has to survive multi-line messages.
  return `Update ${paths.length} notes\n\n${body.join('\n')}`
}
