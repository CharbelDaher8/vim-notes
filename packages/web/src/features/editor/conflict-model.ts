/**
 * What a refused write, or somebody else's edit, offers the user.
 *
 * The rule the whole app is built around (DECISIONS.md §5) only pays off if the
 * refusal reaches a human with a real choice attached. Silently retrying with
 * `force` throws away whatever nvim wrote; swallowing the error throws away
 * whatever the user just typed. Both are worse than an interruption.
 *
 * The mapping from conflict kind to available choices lives here, as data,
 * because it is the part that is easy to get wrong and impossible to notice:
 * "take theirs" is meaningless when the file was deleted underneath, and
 * "keep mine" means create rather than overwrite in that case.
 */
import type {
  ChangeOrigin,
  ContentHash,
  FileChangeEvent,
  NoteMetadata,
  NotePath,
  WriteConflict,
} from '@vim-notes/core'

export type ConflictAction = 'keep-mine' | 'take-theirs' | 'discard-mine' | 'view-both'

export interface ConflictChoice {
  action: ConflictAction
  label: string
  detail: string
  tone: 'primary' | 'danger' | 'default'
}

export interface ConflictState {
  path: NotePath
  conflict: WriteConflict
  /**
   * Snapshots taken at the instant the write was refused. This is not a mirror
   * of the live buffer -- CodeMirror still owns that -- it is the frozen pair
   * the dialog compares, and it is dropped when the conflict resolves.
   */
  mine: string
  /** Null when the note was deleted underneath. */
  theirs: string | null
  theirsMetadata: NoteMetadata | null
  /**
   * `hidden` is dismissal, not resolution. The conflict stays in the store and
   * in the status bar, and saving stays blocked, because the alternative is a
   * dialog that gets clicked away and then quietly clobbers something.
   */
  view: 'choices' | 'diff' | 'hidden'
}

export function conflictHeadline(conflict: WriteConflict): string {
  switch (conflict.kind) {
    case 'already-exists':
      return 'A note already exists here'
    case 'deleted-underneath':
      return 'This note was deleted while you were editing'
    case 'stale':
      return 'This note changed while you were editing'
  }
}

export function conflictExplanation(conflict: WriteConflict): string {
  switch (conflict.kind) {
    case 'already-exists':
      return 'Something was created at this path after you started. Your text has not been written.'
    case 'deleted-underneath':
      return 'The file is gone from the notes directory. Your text is still here, unsaved.'
    case 'stale':
      return 'Someone else wrote to this file — nvim in the terminal, or a git pull. Your text has not been written, and theirs is untouched.'
  }
}

export function choicesFor(conflict: WriteConflict): ConflictChoice[] {
  if (conflict.kind === 'deleted-underneath') {
    return [
      {
        action: 'keep-mine',
        label: 'Recreate the note',
        detail: 'Write what is in the editor back to this path.',
        tone: 'primary',
      },
      {
        action: 'discard-mine',
        label: 'Discard my changes',
        detail: 'Close the note and let the deletion stand.',
        tone: 'danger',
      },
    ]
  }

  const overwriting = conflict.kind === 'already-exists'

  return [
    {
      action: 'view-both',
      label: 'View both',
      detail: 'Compare line by line before deciding.',
      tone: 'default',
    },
    {
      action: 'keep-mine',
      label: 'Keep mine',
      detail: overwriting
        ? 'Overwrite the existing note with what is in the editor.'
        : 'Overwrite their version with what is in the editor.',
      tone: 'primary',
    },
    {
      action: 'take-theirs',
      label: 'Take theirs',
      detail: 'Replace the editor with their version. Your unsaved text is lost.',
      tone: 'danger',
    },
  ]
}

// --- Reconciling somebody else's write --------------------------------------

export type ReconcileDecision =
  | { kind: 'ignore' }
  /** Buffer is clean, so the newer bytes can simply replace it. */
  | { kind: 'reload' }
  /** Buffer is dirty; the user has to choose. Never touch the document. */
  | { kind: 'notify'; reason: 'modified' | 'deleted' }
  /** Buffer is clean and the file is gone. */
  | { kind: 'gone' }

export interface ReconcileContext {
  openPath: NotePath | null
  /** The hash the open buffer was read at, or null while creating a new note. */
  baselineHash: ContentHash | null
  dirty: boolean
}

/**
 * `api` is dropped because it is overwhelmingly this client's own write coming
 * back, and reacting to it means replacing the buffer a keystroke after the
 * save -- a cursor jump mid-sentence, which is the single most irritating bug
 * this class of app has.
 *
 * The cost is that a second browser tab also writes as `api` and will not be
 * picked up live. That is deliberate: the version check still refuses the stale
 * save, so the outcome is a conflict prompt rather than lost work, and trading
 * a rare correct notification for a common cursor jump is the right way round.
 */
export function decideReconcile(
  event: FileChangeEvent,
  context: ReconcileContext,
): ReconcileDecision {
  if (isOwnEcho(event.origin)) return { kind: 'ignore' }
  if (context.openPath === null || event.path !== context.openPath) return { kind: 'ignore' }

  if (event.kind === 'deleted') {
    return context.dirty ? { kind: 'notify', reason: 'deleted' } : { kind: 'gone' }
  }

  // Someone wrote the bytes we already have -- a `:w` with no changes, or a
  // git checkout that restored the same content. Nothing to reconcile.
  if (event.hash !== null && event.hash === context.baselineHash) return { kind: 'ignore' }

  return context.dirty ? { kind: 'notify', reason: 'modified' } : { kind: 'reload' }
}

function isOwnEcho(origin: ChangeOrigin): boolean {
  return origin === 'api'
}

/** Does an event change the shape of the tree, as opposed to a file's bytes? */
export function affectsTree(event: FileChangeEvent): boolean {
  return event.kind !== 'modified'
}
