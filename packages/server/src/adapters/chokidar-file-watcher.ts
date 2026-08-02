/**
 * FileWatcher over the notes directory.
 *
 * This is what makes the two-writer design in DECISIONS.md §3 actually work:
 * nvim saves a note in the pty, and the phone holding that note open has to find
 * out. Without it the web client is looking at a photograph of the file.
 *
 * Three things are more subtle than they look:
 *
 *   1. **Our own temp files.** Every atomic write creates and renames away a
 *      scratch file. Reporting those would emit a created + deleted pair per
 *      save for a path no client has ever heard of, so they are filtered at the
 *      source using the same matcher the store names them with.
 *   2. **`origin`.** The filesystem cannot say which process wrote a file, and
 *      the client's behaviour depends on the answer -- it must ignore the echo
 *      of its own save and must not ignore anything else. See `originOf` and
 *      `write-journal.ts`.
 *   3. **Bursts.** Editors write in flurries, and an atomic save is an unlink
 *      and an add a millisecond apart. Events are debounced per path and the
 *      file is read once at the end, so a burst becomes one event describing
 *      where the file actually ended up.
 *
 * Everything is decided from the file's real state at flush time rather than
 * from the sequence of raw events, because the raw sequence lies: a rename
 * looks like a delete, and a `:w` in nvim can look like a create.
 *
 * The notes root should exist before this starts. Chokidar comes up empty on a
 * missing directory rather than failing, and would not notice it appearing.
 */
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

import {
  parseNotePath,
  type ChangeOrigin,
  type ContentHash,
  type FileChangeEvent,
  type FileChangeKind,
  type FileWatcher,
  type NotePath,
  type Unsubscribe,
} from '@vim-notes/core'
import { watch, type FSWatcher } from 'chokidar'

import { hashContent } from './content-hash'
import { isTemporaryFileName } from './fs-note-store'
import type { WriteJournal } from './write-journal'

export interface ChokidarFileWatcherOptions {
  /** Where writers say "this one was mine". Without it everything is 'unknown'. */
  journal?: WriteJournal
  /** Quiet period per path before the file is read and an event emitted. */
  debounceMs?: number
  /** How recently git must have touched its index for a change to count as 'git'. */
  gitWindowMs?: number
  /**
   * Stat on an interval rather than subscribing to kernel notifications.
   *
   * Needed wherever those notifications are unreliable or absent: network
   * filesystems, and Docker bind mounts from a macOS or Windows host -- which is
   * how this ships. The failure mode without it is the bad one, a watcher that
   * reports nothing and looks healthy while doing it. It costs a stat per file
   * per interval, which for a personal notes directory is nothing.
   */
  usePolling?: boolean
  pollIntervalMs?: number
  /**
   * Called for watcher failures and for exceptions thrown by subscribers. There
   * is nobody to return these to -- the work was started by an inotify event,
   * not a request -- but swallowing them silently would hide a watcher that has
   * quietly stopped reporting, so the default at least says something.
   */
  onError?: (error: unknown) => void
}

const DEFAULT_DEBOUNCE_MS = 75
const DEFAULT_GIT_WINDOW_MS = 2_000
const DEFAULT_POLL_INTERVAL_MS = 100

/** Written by essentially every git operation that disturbs the working tree. */
const GIT_ACTIVITY_FILES = ['index', 'HEAD']

export class ChokidarFileWatcher implements FileWatcher {
  /**
   * Wrapped rather than held directly, so that subscribing the same function
   * twice is two subscriptions. A Set would silently collapse them into one,
   * and then whichever unsubscribe ran first would cancel both.
   */
  private readonly listeners = new Set<{ notify: (event: FileChangeEvent) => void }>()

  /** Paths believed to exist. Seeded by the initial scan, which emits nothing. */
  private readonly known = new Set<NotePath>()

  /** Last hash reported per path, so a save that changed nothing stays quiet. */
  private readonly lastHash = new Map<NotePath, ContentHash>()

  private readonly pending = new Map<NotePath, NodeJS.Timeout>()

  private readonly journal: WriteJournal | undefined
  private readonly debounceMs: number
  private readonly gitWindowMs: number
  private readonly onError: (error: unknown) => void

  private ready = false
  private closing: Promise<void> | null = null

  private constructor(
    private readonly root: string,
    private readonly watcher: FSWatcher,
    options: ChokidarFileWatcherOptions,
  ) {
    this.journal = options.journal
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.gitWindowMs = options.gitWindowMs ?? DEFAULT_GIT_WINDOW_MS
    this.onError = options.onError ?? ((error) => console.error('[file-watcher]', error))
  }

  /**
   * Resolves once the initial scan is done, so callers know that any event they
   * receive afterwards is genuine news rather than an artefact of starting up.
   */
  static async start(
    root: string,
    options: ChokidarFileWatcherOptions = {},
  ): Promise<ChokidarFileWatcher> {
    const resolvedRoot = nodePath.resolve(root)

    const watcher = watch(resolvedRoot, {
      // The initial scan is wanted: it is what distinguishes a note that was
      // created from one that was merely edited. Nothing is emitted from it.
      ignoreInitial: false,
      // A symlink out of the notes directory would otherwise deliver events for
      // files no client can address, and pull an arbitrary subtree into the
      // watch set. The store refuses to read through them for the same reason.
      followSymlinks: false,
      // Coalesces the unlink/add pair an atomic save produces into one change.
      atomic: true,
      usePolling: options.usePolling ?? false,
      interval: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      ignored: (candidate: string) => shouldIgnore(resolvedRoot, candidate),
    })

    const instance = new ChokidarFileWatcher(resolvedRoot, watcher, options)

    try {
      await instance.attach()
    } catch (error) {
      await watcher.close()
      throw error
    }

    return instance
  }

  subscribe(listener: (event: FileChangeEvent) => void): Unsubscribe {
    const entry = { notify: listener }
    this.listeners.add(entry)

    // Idempotent by contract, and idempotent in the strict sense: calling this
    // twice removes this subscription once and leaves any other alone.
    return () => {
      this.listeners.delete(entry)
    }
  }

  close(): Promise<void> {
    this.closing ??= this.shutDown()
    return this.closing
  }

  private async shutDown(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.listeners.clear()

    // Chokidar's close() is what actually releases the underlying watches. On a
    // large tree those are a real resource, and a leaked watcher keeps reading
    // a directory nobody is looking at any more.
    await this.watcher.close()
  }

  private attach(): Promise<void> {
    this.watcher.on('add', (absolute) => this.onRaw('add', absolute))
    this.watcher.on('change', (absolute) => this.onRaw('change', absolute))
    this.watcher.on('unlink', (absolute) => this.onRaw('unlink', absolute))

    return new Promise((resolve, reject) => {
      const onReady = () => {
        detach()
        this.ready = true
        // Only now does an error become something to report rather than a
        // reason to fail construction.
        this.watcher.on('error', (error) => this.onError(error))
        resolve()
      }
      const onError = (error: unknown) => {
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const detach = () => {
        this.watcher.off('ready', onReady)
        this.watcher.off('error', onError)
      }

      this.watcher.once('ready', onReady)
      this.watcher.once('error', onError)
    })
  }

  private onRaw(kind: 'add' | 'change' | 'unlink', absolute: string): void {
    const path = this.toNotePath(absolute)
    if (path === null) return

    if (!this.ready) {
      // The initial scan is inventory, not news. It records what already exists
      // so that the first real event can say created rather than modified.
      if (kind === 'add') this.known.add(path)
      return
    }

    this.schedule(path)
  }

  private schedule(path: NotePath): void {
    const existing = this.pending.get(path)
    if (existing !== undefined) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.pending.delete(path)
      void this.flush(path).catch((error: unknown) => this.onError(error))
    }, this.debounceMs)

    // A debounce in flight should never be the reason the process will not exit.
    timer.unref()
    this.pending.set(path, timer)
  }

  /** Reads where the file actually ended up and reports that, once. */
  private async flush(path: NotePath): Promise<void> {
    if (this.closing !== null) return

    const bytes = await readFileOrNull(nodePath.join(this.root, path))

    if (bytes === null) {
      // A file created and removed inside one debounce window: no client was
      // ever told it existed, so there is nothing to tell them about its going.
      if (!this.known.delete(path)) return

      this.lastHash.delete(path)
      await this.deliver('deleted', path, null)
      return
    }

    const hash = hashContent(bytes)

    // `:w` with no edits, or a write of identical bytes, still moves mtime. The
    // client's copy is already correct, and reloading it would move the cursor
    // for nothing.
    if (this.lastHash.get(path) === hash) return

    const kind: FileChangeKind = this.known.has(path) ? 'modified' : 'created'
    this.known.add(path)
    this.lastHash.set(path, hash)

    await this.deliver(kind, path, hash)
  }

  private async deliver(
    kind: FileChangeKind,
    path: NotePath,
    hash: ContentHash | null,
  ): Promise<void> {
    const event: FileChangeEvent = {
      kind,
      path,
      hash,
      at: Date.now(),
      origin: await this.originOf(path, hash),
    }

    for (const listener of [...this.listeners]) {
      try {
        listener.notify(event)
      } catch (error) {
        // One bad subscriber must not cost the others their event.
        this.onError(error)
      }
    }
  }

  /**
   * Who did this.
   *
   * Only two answers can be evidenced. A writer that recorded the change gets
   * credit for it, and git leaves a mark on its own index that no other writer
   * does. Everything else is 'unknown'.
   *
   * `'terminal'` is deliberately never returned. Nothing on the filesystem
   * distinguishes a write by nvim from a write by `cp`, and a client that
   * trusted a guessed 'terminal' would be acting on a fabricated fact. If the
   * terminal adapter ever learns of nvim's saves directly -- an autocmd over
   * RPC -- it can record them in the journal and they will be labelled properly.
   *
   * The git signal is a window, not proof: the auto-committer commits after
   * every save, so the index is warm for a couple of seconds after any write,
   * and an nvim save in that window is reported as 'git' rather than 'unknown'.
   * Both mean "somebody else changed this, reload it", so the client does the
   * same thing either way.
   */
  private async originOf(path: NotePath, hash: ContentHash | null): Promise<ChangeOrigin> {
    const claimed = this.journal?.claim(path, hash) ?? null
    if (claimed !== null) return claimed

    return (await this.gitTouchedRecently()) ? 'git' : 'unknown'
  }

  private async gitTouchedRecently(): Promise<boolean> {
    const cutoff = Date.now() - this.gitWindowMs

    const stats = await Promise.all(
      GIT_ACTIVITY_FILES.map((name) => statOrNull(nodePath.join(this.root, '.git', name))),
    )

    return stats.some((stat) => stat !== null && stat.mtimeMs >= cutoff)
  }

  private toNotePath(absolute: string): NotePath | null {
    const relative = nodePath.relative(this.root, absolute)
    if (relative === '' || relative.startsWith('..')) return null

    // A name core refuses -- `aux.md`, a trailing dot -- can exist on disk
    // because nvim can create it, but no client could ever open it, so an event
    // about it would only be noise. tree() drops the same names.
    const parsed = parseNotePath(relative.split(nodePath.sep).join('/'))
    return parsed.ok ? parsed.value : null
  }
}

function shouldIgnore(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate)
  if (relative === '') return false
  if (relative.startsWith('..')) return true

  const segments = relative.split(nodePath.sep)

  // Pruned rather than filtered later: the object store of a busy repository
  // generates a great deal of churn, and none of it is a note.
  if (segments.includes('.git')) return true

  return isTemporaryFileName(segments[segments.length - 1] ?? '')
}

async function readFileOrNull(absolute: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absolute)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

async function statOrNull(absolute: string) {
  try {
    return await fs.stat(absolute)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

function isAbsent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false

  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}
