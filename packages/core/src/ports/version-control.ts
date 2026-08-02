import type { NotePath } from '../domain/note-path'

export interface CommitRef {
  sha: string
}

export interface CommitEntry extends CommitRef {
  message: string
  /** Epoch milliseconds. */
  authoredAt: number
  paths: NotePath[]
}

export interface RepoStatus {
  branch: string
  /** True when the working tree has changes not yet committed. */
  dirty: boolean
  /** Commits on the local branch not yet on the hub. */
  ahead: number
  /** Commits on the hub not yet pulled. */
  behind: number
  /** Non-empty when a rebase or merge left conflict markers on disk. */
  conflicted: NotePath[]
}

export type SyncOutcome =
  | { ok: true; pulled: number; pushed: number }
  | { ok: false; reason: 'conflict'; conflicted: NotePath[] }
  | { ok: false; reason: 'no-remote' | 'network' | 'dirty'; message: string }

/**
 * Git, exposed only as far as this app needs it.
 *
 * The notes directory is a working copy whose hub is a bare repo; `sync` is
 * pull --rebase followed by push. Conflicts are returned rather than thrown for
 * the same reason as in NoteStore: with a laptop clone and a server working copy
 * both committing, conflicts are a normal outcome and the UI has to surface
 * them.
 */
export interface VersionControl {
  /** Returns null when there was nothing to commit. */
  commit(message: string, paths?: NotePath[]): Promise<CommitRef | null>

  log(options?: { path?: NotePath; limit?: number }): Promise<CommitEntry[]>

  /** Unified diff of `ref` against its parent, optionally scoped to one path. */
  diff(ref: CommitRef, path?: NotePath): Promise<string>

  /** Returns the restored content without writing it, leaving that to NoteStore. */
  restore(path: NotePath, ref: CommitRef): Promise<string>

  status(): Promise<RepoStatus>

  sync(): Promise<SyncOutcome>
}
