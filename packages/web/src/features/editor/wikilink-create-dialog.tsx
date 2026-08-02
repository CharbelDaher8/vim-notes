import { describeNotePathError, parseNotePath, type NotePath } from '@vim-notes/core'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Dialog } from '../../shared/ui/dialog'
import { suggestNotePath } from '../../shared/wikilinks'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { useTreeActions } from '../tree/use-tree'

/**
 * Following a link to a note that has not been written yet.
 *
 * The path is editable rather than fixed, because the one thing the app cannot
 * work out is which folder a new idea belongs in. It is prefilled with the
 * obvious answer -- beside the note that linked to it -- so the common case is
 * still one tap.
 *
 * Creation goes through the tree's own mutation so the note is created by
 * exactly the same rule as the plus button: `expected: null`, meaning "nothing
 * is here", which the store refuses if something already is.
 */
export function WikiLinkCreateDialog({
  target,
  from,
  onClose,
}: {
  target: string
  from: NotePath | null
  onClose: () => void
}) {
  const { createNote } = useTreeActions()
  const [value, setValue] = useState(() => suggestNotePath(target, from))
  const [failure, setFailure] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const parsed = useMemo(() => (value.trim() === '' ? null : parseNotePath(value.trim())), [value])

  const path = parsed !== null && parsed.ok ? parsed.value : null
  const rejection = parsed !== null && !parsed.ok ? describeNotePathError(parsed.error) : null

  const create = () => {
    if (path === null) return
    setFailure(null)

    createNote.mutate(path, {
      onSuccess: (created) => {
        void useWorkspaceStore.getState().openNote(created)
        onClose()
      },
      onError: (error) => setFailure(error.message),
    })
  }

  return (
    <Dialog
      open
      title="Create this note?"
      description={
        <>
          Nothing answers to <code>[[{target}]]</code> yet.
        </>
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button" data-tone="quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            data-tone="primary"
            disabled={createNote.isPending || path === null}
            onClick={create}
          >
            Create
          </button>
        </>
      }
    >
      <input
        ref={inputRef}
        className="field field--mono"
        value={value}
        aria-label="Path for the new note"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          create()
        }}
      />

      <p className="dialog__hint" data-tone={rejection === null ? undefined : 'error'}>
        {rejection ?? 'The link keeps working wherever you put it, as long as the name is unique.'}
      </p>

      {failure === null ? null : <p className="dialog__error">{failure}</p>}
    </Dialog>
  )
}
