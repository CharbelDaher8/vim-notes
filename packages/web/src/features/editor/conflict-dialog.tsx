import { Dialog } from '../../shared/ui/dialog'
import {
  choicesFor,
  conflictExplanation,
  conflictHeadline,
  type ConflictAction,
  type ConflictState,
} from './conflict-model'
import { DiffView } from './diff-view'

/**
 * The payoff for the whole hashing scheme (DECISIONS.md §5).
 *
 * Dismissible on purpose: the conflict stays in the status bar and the buffer
 * stays dirty, so nothing is lost by closing it, and forcing a decision at the
 * instant of a save is the kind of modal that gets clicked through blindly.
 * What it never does is overwrite, or retry quietly.
 */
export function ConflictDialog({
  conflict,
  busy,
  onResolve,
  onDismiss,
}: {
  conflict: ConflictState
  busy: boolean
  onResolve: (action: ConflictAction) => void
  onDismiss: () => void
}) {
  const choices = choicesFor(conflict.conflict)
  const showingDiff = conflict.view === 'diff' && conflict.theirs !== null

  return (
    <Dialog
      open
      size={showingDiff ? 'wide' : 'regular'}
      title={conflictHeadline(conflict.conflict)}
      description={
        <>
          {conflictExplanation(conflict.conflict)}
          <code className="conflict__path">{conflict.path}</code>
        </>
      }
      onClose={onDismiss}
      actions={
        <>
          <button type="button" className="button" data-tone="quiet" onClick={onDismiss}>
            Decide later
          </button>

          {choices.map((choice) => (
            <button
              key={choice.action}
              type="button"
              className="button"
              data-tone={choice.tone === 'default' ? undefined : choice.tone}
              disabled={busy || (choice.action === 'take-theirs' && conflict.theirs === null)}
              onClick={() => onResolve(choice.action)}
            >
              {choice.label}
            </button>
          ))}
        </>
      }
    >
      {showingDiff && conflict.theirs !== null ? (
        <DiffView mine={conflict.mine} theirs={conflict.theirs} />
      ) : (
        <ul className="conflict__choices">
          {choices.map((choice) => (
            <li key={choice.action}>
              <strong>{choice.label}</strong>
              <span>{choice.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
