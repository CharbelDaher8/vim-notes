import { notePathBasename } from '@vim-notes/core'

import { Dialog } from '../../shared/ui/dialog'
import { useEditorStore } from './editor-store'

/**
 * Only ever seen with vim on, where there is no autosave to fall back on --
 * `E37: No write since last change`, with buttons.
 */
export function UnsavedChangesDialog() {
  const prompt = useEditorStore((state) => state.discardPrompt)
  const path = useEditorStore((state) => state.path)

  if (prompt === null) return null

  return (
    <Dialog
      open
      title="Unsaved changes"
      description={
        path === null
          ? 'This note has changes that have not been written.'
          : `${notePathBasename(path)} has changes that have not been written.`
      }
      onClose={() => prompt.resolve('cancel')}
      actions={
        <>
          <button
            type="button"
            className="button"
            data-tone="quiet"
            onClick={() => prompt.resolve('cancel')}
          >
            Stay here
          </button>
          <button
            type="button"
            className="button"
            data-tone="danger"
            onClick={() => prompt.resolve('discard')}
          >
            Discard
          </button>
          <button
            type="button"
            className="button"
            data-tone="primary"
            onClick={() => prompt.resolve('save')}
          >
            Write and go
          </button>
        </>
      }
    />
  )
}
