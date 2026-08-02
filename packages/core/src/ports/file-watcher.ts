import type { ContentHash } from '../domain/conflict'
import type { NotePath } from '../domain/note-path'
import type { Unsubscribe } from './common'

export type FileChangeKind = 'created' | 'modified' | 'deleted'

/**
 * `origin` lets a client ignore the echo of its own write.
 *
 * Without it, saving from the web editor produces a change event that the
 * editor then reacts to by reloading the buffer it just saved -- at best a
 * flicker, at worst a cursor jump mid-keystroke. The API adapter tags writes it
 * performed itself; anything else is `terminal` (nvim wrote it) or `git` (a
 * pull landed it).
 */
export type ChangeOrigin = 'api' | 'terminal' | 'git' | 'unknown'

export interface FileChangeEvent {
  kind: FileChangeKind
  path: NotePath
  /** Null for deletions. */
  hash: ContentHash | null
  /** Epoch milliseconds. */
  at: number
  origin: ChangeOrigin
}

export interface FileWatcher {
  subscribe(listener: (event: FileChangeEvent) => void): Unsubscribe
  close(): Promise<void>
}
