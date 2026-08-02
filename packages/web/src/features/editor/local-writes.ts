/**
 * Telling the open buffer that another part of *this* app wrote its file.
 *
 * The watcher cannot do this job. `decideReconcile` ignores events tagged
 * `api`, deliberately, because they are overwhelmingly the editor's own save
 * coming back and reacting to those means a cursor jump mid-sentence. But the
 * tasks panel is also `api`, and a tick from the panel is emphatically not the
 * editor's own write: without this, ticking a checkbox in a note you have open
 * leaves the buffer showing the old line and holding a baseline hash that is
 * now stale, so the user's next save is refused with a conflict dialog about a
 * conflict they created with themselves.
 *
 * A module-level slot rather than a store: this is a callback, not render
 * state, and putting it in Zustand would re-render every subscriber each time
 * the editor re-registers it. Same reasoning as `setNavigationGuard`.
 */
import type { NotePath } from '@vim-notes/core'

export type LocalWriteListener = (path: NotePath) => void

let listener: LocalWriteListener | null = null

export function setLocalWriteListener(next: LocalWriteListener | null): void {
  listener = next
}

export function announceLocalWrite(path: NotePath): void {
  listener?.(path)
}
