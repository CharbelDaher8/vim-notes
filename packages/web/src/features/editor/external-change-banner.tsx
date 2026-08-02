import { Warning } from '../../shared/ui/icons'
import type { ExternalNotice } from './editor-store'

/**
 * Deliberately not a modal. This fires while someone is typing, triggered by
 * something they did not do; stealing focus for it would be worse than the
 * problem. The buffer is untouched either way -- see `decideReconcile`.
 */
export function ExternalChangeBanner({
  notice,
  onReview,
  onSaveNow,
  onDismiss,
}: {
  notice: ExternalNotice
  onReview: () => void
  onSaveNow: () => void
  onDismiss: () => void
}) {
  const deleted = notice.reason === 'deleted'

  return (
    <div className="banner" role="status" data-tone={deleted ? 'danger' : 'warn'}>
      <Warning />

      <p className="banner__text">
        {deleted
          ? 'This note was deleted outside the editor. Your text is still here, unsaved.'
          : 'This note changed outside the editor. Your unsaved edits have not been touched.'}
      </p>

      <div className="banner__actions">
        {deleted ? (
          <button type="button" className="button" data-tone="primary" onClick={onSaveNow}>
            Recreate it
          </button>
        ) : (
          <button type="button" className="button" onClick={onReview}>
            Compare
          </button>
        )}

        <button type="button" className="button" data-tone="quiet" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
