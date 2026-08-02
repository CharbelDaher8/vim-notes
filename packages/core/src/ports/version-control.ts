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
  /** Commits on the local branch not yet on the remote. */
  ahead: number
  /** Commits on the remote not yet pulled. */
  behind: number
  /** Non-empty when a rebase or merge left conflict markers on disk. */
  conflicted: NotePath[]
}

export type SyncOutcome =
  | { ok: true; pulled: number; pushed: number }
  /** A rebase left conflict markers; these paths need a human. */
  | { ok: false; reason: 'conflict'; conflicted: NotePath[] }
  /**
   * The remote moved between our fetch and our push, so the push was refused
   * with nothing on disk to resolve. This is the race any shared remote invites
   * -- a laptop clone pushing while the server was mid-sync -- and it is
   * distinct from 'conflict': retrying usually fixes it, and no file needs
   * attention. Folding it into 'conflict' with an empty path list would make
   * the UI offer a resolution screen for something the user cannot act on.
   */
  | { ok: false; reason: 'rejected'; message: string }
  /**
   * 'auth' is separated from 'network' because they need opposite responses: a
   * bad deploy key will never succeed on retry and needs a human to fix
   * credentials, whereas a transient transport failure should just be retried.
   * Detection is necessarily heuristic on git's stderr, so implementations
   * should fall back to 'network' when unsure rather than guess.
   */
  | { ok: false; reason: 'no-remote' | 'network' | 'auth' | 'dirty'; message: string }

/**
 * Git, exposed only as far as this app needs it.
 *
 * The notes directory is an ordinary clone of a shared remote (DECISIONS.md
 * §2); `sync` is pull --rebase followed by push. Conflicts are returned rather
 * than thrown for the same reason as in NoteStore: with a laptop clone and a
 * server working copy both committing, conflicts are a normal outcome and the
 * UI has to surface them.
 *
 * Nothing here names GitHub, and it should not. The port describes a remote, and
 * the only thing that changes if the remote moves back on-premise is the URL.
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
