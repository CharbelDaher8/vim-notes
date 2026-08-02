import { formatBytes, formatRelativeTime } from '../../shared/format'
import { useEditorStore } from './editor-store'

/**
 * One line of truth about the buffer. Ordered by how much it should worry you:
 * an unresolved conflict outranks an error, which outranks unsaved changes.
 */
export function EditorStatus({ onReopenConflict }: { onReopenConflict: () => void }) {
  const status = useEditorStore((state) => state.status)
  const dirty = useEditorStore((state) => state.dirty)
  const saveStatus = useEditorStore((state) => state.saveStatus)
  const savedAt = useEditorStore((state) => state.savedAt)
  const error = useEditorStore((state) => state.error)
  const conflict = useEditorStore((state) => state.conflict)
  const metadata = useEditorStore((state) => state.metadata)
  const vimEnabled = useEditorStore((state) => state.vimEnabled)

  return (
    <footer className="status">
      <span className="status__state" data-state={stateName()}>
        {conflict !== null ? (
          <button type="button" className="status__link" onClick={onReopenConflict}>
            Unresolved conflict
          </button>
        ) : (
          label()
        )}
      </span>

      {metadata === null ? null : (
        <span className="status__meta">
          {formatBytes(metadata.size)} · {formatRelativeTime(metadata.modifiedAt)}
        </span>
      )}

      <span className="status__mode" title={vimEnabled ? 'Vim keys on' : 'Vim keys off'}>
        {vimEnabled ? 'VIM' : 'INS'}
      </span>
    </footer>
  )

  function stateName(): string {
    if (conflict !== null) return 'conflict'
    if (saveStatus === 'error' || status === 'error') return 'error'
    if (status === 'missing') return 'missing'
    if (dirty) return 'dirty'
    return saveStatus
  }

  function label(): string {
    if (saveStatus === 'error') return error ?? 'Save failed'
    if (status === 'error') return error ?? 'Could not open this note'
    if (status === 'loading') return 'Opening…'
    if (status === 'missing') return 'Deleted on disk — saving recreates it'
    if (saveStatus === 'saving') return 'Saving…'
    if (dirty) return vimEnabled ? 'Unsaved — :w to write' : 'Unsaved'
    if (savedAt !== null) return `Saved ${formatRelativeTime(savedAt)}`
    return status === 'ready' ? 'Up to date' : ''
  }
}
