import type { NotePath } from '@vim-notes/core'

import { AutoCommitter } from './adapters/auto-committer'
import { ChokidarFileWatcher } from './adapters/chokidar-file-watcher'
import { FsNoteStore } from './adapters/fs-note-store'
import { GitVersionControl } from './adapters/git-version-control'
import { MemoryNoteIndex } from './adapters/memory-note-index'
import { NodePtyTerminalHost } from './adapters/node-pty-terminal-host'
import { RipgrepSearch } from './adapters/ripgrep-search'
import { WriteJournal } from './adapters/write-journal'
import { SyncScheduler } from './adapters/sync-scheduler'
import type { AppContext } from './api/trpc'
import type { Config } from './config'
import { gitEnvironment } from './git-environment'

/**
 * The composition root: the one place that knows which implementation backs
 * which port.
 *
 * Everything above this file depends on the interfaces in core, which is why
 * the API layer can be tested against InMemoryNoteStore with no disk and no
 * git. Manual constructor injection, no container -- at six objects and one
 * binding set, a container would be pure indirection (DECISIONS.md §6).
 */

export interface Application {
  context: AppContext
  terminals: NodePtyTerminalHost
  /** Flush pending work and release watches, ptys and timers. */
  shutdown: () => Promise<void>
}

export async function createApplication(config: Config): Promise<Application> {
  const onError = (scope: string) => (error: unknown) => {
    console.error(`[${scope}]`, error)
  }

  // Shared by the store and the watcher: the store records what it is about to
  // write, and the watcher reads those claims to tell our own writes apart from
  // nvim's. Both must hold the *same* journal or every event reads as unknown.
  const journal = new WriteJournal()

  const notes = new FsNoteStore(config.NOTES_ROOT, { observer: journal })

  const vcs = new GitVersionControl(config.NOTES_ROOT, {
    remote: config.GIT_REMOTE,
    defaultAuthor: { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL },
    // Carries the deploy key. Built in one place so preflight can test the
    // remote with exactly the credentials the real sync will use.
    env: gitEnvironment(config),
  })

  const autoCommitter = new AutoCommitter(vcs, {
    idleMs: config.AUTOCOMMIT_DEBOUNCE_MS,
    maxDelayMs: config.AUTOCOMMIT_MAX_DELAY_MS,
    onError: onError('auto-commit'),
  })

  const search = new RipgrepSearch(config.NOTES_ROOT)

  const watcher = await ChokidarFileWatcher.start(config.NOTES_ROOT, {
    journal,
    usePolling: config.WATCH_POLLING,
    pollIntervalMs: config.WATCH_POLL_INTERVAL_MS,
    onError: onError('watcher'),
  })

  // Built after the watcher exists and before anything can query it, so the
  // first request does not race the initial walk. `start` waits for that walk;
  // the constructor alone would return an index that answers "no todos"
  // confidently while it is still reading the notes.
  const index = await MemoryNoteIndex.start(notes, watcher, { onError: onError('note-index') })

  const terminals = new NodePtyTerminalHost({
    notesRoot: config.NOTES_ROOT,
    command: config.TERMINAL_COMMAND,
    idleTimeoutMs: config.TERMINAL_IDLE_TIMEOUT_MS,
    onError: onError('terminal'),
  })

  /**
   * Auto-commit is driven by the watcher rather than by the API layer, and that
   * is the important wiring decision in this file.
   *
   * nvim writes notes directly in the pty; those writes never pass through a
   * tRPC procedure, so an API-driven committer would silently never commit
   * anything typed in the terminal -- the primary editing surface on a real
   * keyboard. The watcher sees every write regardless of who made it.
   *
   * Deletes and moves count too: a note removed in the tree must not stay in
   * history's HEAD forever just because nothing was "saved".
   */
  const unsubscribeAutoCommit = watcher.subscribe((event) => {
    autoCommitter.recordSave(event.path as NotePath)
  })

  /**
   * Polling replaces the hub's post-receive hook (DECISIONS §2): the server is
   * tailnet-only, so GitHub cannot call us and we have to ask.
   *
   * `beforeSync` is the important wiring here. A sync that runs while a save is
   * still pending finds a dirty tree and refuses to rebase -- reported honestly
   * as `dirty`, but a pull that never lands is a pull that never lands.
   * Flushing first turns the pending save into a commit the rebase can move.
   */
  const syncScheduler = new SyncScheduler(vcs, {
    intervalMs: config.SYNC_INTERVAL_MS,
    beforeSync: () => autoCommitter.flush(),
    onError: onError('sync'),
  })
  syncScheduler.start()

  return {
    context: { notes, vcs, search, watcher, terminals, index },
    terminals,

    shutdown: async () => {
      // Order matters. Stop new events first, then flush what is already owed,
      // then tear down the ptys -- flushing after killing nvim would lose the
      // last save, which is exactly the moment it matters most.
      unsubscribeAutoCommit()
      index.close()

      // Before the flush below, so a sync cannot start while the final commit
      // is being made. No final push is attempted on the way out: the commit is
      // already durable on disk, the next boot syncs immediately, and the only
      // case that would lose is a box that never comes back -- which is also
      // the case where nothing graceful runs at all.
      await syncScheduler.stop()

      await watcher.close()
      await autoCommitter.stop()
      await terminals.killAll()
    },
  }
}
