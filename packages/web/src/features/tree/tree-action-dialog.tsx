import {
  describeNotePathError,
  notePathBasename,
  notePathJoin,
  notePathParent,
  type NotePath,
} from '@vim-notes/core'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Dialog } from '../../shared/ui/dialog'
import { editableName, withMarkdownExtension } from './tree-model'
import type { TreeAction } from './tree-store'

/**
 * One dialog for create, rename and delete. They share the only part that is
 * fiddly -- turning a typed name into a validated `NotePath` and reporting why
 * it was rejected -- and `parseNotePath` already produces the error messages.
 */
export function TreeActionDialog({
  action,
  busy,
  error,
  onCancel,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onDelete,
}: {
  action: TreeAction
  busy: boolean
  error: string | null
  onCancel: () => void
  onCreateFile: (path: NotePath) => void
  onCreateDirectory: (path: NotePath) => void
  onRename: (from: NotePath, to: NotePath) => void
  onDelete: (path: NotePath) => void
}) {
  if (action.kind === 'delete') {
    return (
      <Dialog
        open
        title={action.isDirectory ? 'Delete this folder?' : 'Delete this note?'}
        description={
          action.isDirectory
            ? 'Everything inside it goes too. It stays in the git history, but not in the working copy.'
            : 'It stays in the git history, but not in the working copy.'
        }
        onClose={onCancel}
        actions={
          <>
            <button type="button" className="button" data-tone="quiet" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-tone="danger"
              disabled={busy}
              onClick={() => onDelete(action.target)}
            >
              Delete {notePathBasename(action.target)}
            </button>
          </>
        }
      >
        {error === null ? null : <p className="tree-dialog__error">{error}</p>}
      </Dialog>
    )
  }

  return (
    <NameDialog
      action={action}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={(path) => {
        if (action.kind === 'create-file') onCreateFile(path)
        else if (action.kind === 'create-directory') onCreateDirectory(path)
        else onRename(action.target, path)
      }}
    />
  )
}

function NameDialog({
  action,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  action: Exclude<TreeAction, { kind: 'delete' }>
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (path: NotePath) => void
}) {
  const renaming = action.kind === 'rename'
  const wantsDirectory = action.kind === 'create-directory' || (renaming && action.isDirectory)

  const parent = renaming ? notePathParent(action.target) : action.parent
  const initial = renaming ? editableName(action.target, action.isDirectory) : ''

  const [name, setName] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // `<dialog>` focuses the first focusable child, which is close enough, but
    // the selection matters more: renaming should start with the stem selected.
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [])

  const result = useMemo(() => {
    const trimmed = name.trim()
    if (trimmed === '') return null
    return notePathJoin(parent, wantsDirectory ? trimmed : withMarkdownExtension(trimmed))
  }, [name, parent, wantsDirectory])

  const path = result !== null && result.ok ? result.value : null
  const rejection = result !== null && !result.ok ? describeNotePathError(result.error) : null

  return (
    <Dialog
      open
      title={titleFor(action)}
      description={parent === null ? 'At the top of your notes.' : <code>{parent}/</code>}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="button" data-tone="quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            data-tone="primary"
            disabled={busy || path === null}
            onClick={() => path !== null && onSubmit(path)}
          >
            {renaming ? 'Rename' : 'Create'}
          </button>
        </>
      }
    >
      <input
        ref={inputRef}
        className="field field--mono"
        value={name}
        placeholder={wantsDirectory ? 'folder name' : 'note name'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || path === null) return
          event.preventDefault()
          onSubmit(path)
        }}
      />

      <p className="tree-dialog__hint" data-tone={rejection === null ? undefined : 'error'}>
        {rejection ??
          (wantsDirectory
            ? 'Slashes create nested folders.'
            : 'Ends up as .md unless you type an extension.')}
      </p>

      {error === null ? null : <p className="tree-dialog__error">{error}</p>}
    </Dialog>
  )
}

function titleFor(action: Exclude<TreeAction, { kind: 'delete' }>): string {
  if (action.kind === 'create-file') return 'New note'
  if (action.kind === 'create-directory') return 'New folder'
  return action.isDirectory ? 'Rename folder' : 'Rename note'
}
