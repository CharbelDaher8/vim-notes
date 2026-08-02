import { useLayoutEffect, useRef } from 'react'

import { useResolvedTheme } from '../../shared/theme'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { ConflictDialog } from './conflict-dialog'
import { createEditor, type EditorHandle } from './create-editor'
import { EditorStatus } from './editor-status'
import { useEditorStore } from './editor-store'
import { ExternalChangeBanner } from './external-change-banner'
import { MarkupBar } from './markup-bar'
import { UnsavedChangesDialog } from './unsaved-changes-dialog'
import { useExternalChanges } from './use-external-changes'
import { useNoteBuffer } from './use-note-buffer'
import { useVisualViewport } from './use-visual-viewport'

import './editor.css'

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<EditorHandle | null>(null)

  const buffer = useNoteBuffer(handleRef)
  // The editor is created once and outlives every render, so its callbacks have
  // to reach the current closures rather than the ones captured on mount.
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer

  useExternalChanges(buffer.reloadFromDisk)
  useVisualViewport(() => handleRef.current?.scrollCursorIntoView())

  const dark = useResolvedTheme() === 'dark'
  const vimEnabled = useEditorStore((state) => state.vimEnabled)
  const status = useEditorStore((state) => state.status)
  const conflict = useEditorStore((state) => state.conflict)
  const external = useEditorStore((state) => state.external)
  const saving = useEditorStore((state) => state.saveStatus === 'saving')

  const darkRef = useRef(dark)
  darkRef.current = dark

  /**
   * A layout effect, not a passive one: it has to run before the load effect
   * inside `useNoteBuffer`, which needs the handle to exist. All layout effects
   * run before any passive effect, whichever hook registered them.
   *
   * Empty deps on purpose. Vim and theme changes reconfigure the running editor
   * below; rebuilding it would throw away the selection, the scroll position
   * and the undo history.
   */
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const handle = createEditor({
      parent: host,
      doc: '',
      vimEnabled: useEditorStore.getState().vimEnabled,
      dark: darkRef.current,
      onUserChange: () => bufferRef.current.handleUserChange(),
      onSave: () => void bufferRef.current.save(),
      onClose: () => void useWorkspaceStore.getState().closeNote(),
    })

    handleRef.current = handle

    return () => {
      handle.destroy()
      handleRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    handleRef.current?.setVimEnabled(vimEnabled)
  }, [vimEnabled])

  useLayoutEffect(() => {
    handleRef.current?.setDark(dark)
  }, [dark])

  return (
    <section className="editor" aria-label="Note">
      {external === null ? null : (
        <ExternalChangeBanner
          notice={external}
          onReview={() => void buffer.reviewExternal()}
          onSaveNow={() => void buffer.save()}
          onDismiss={buffer.dismissExternal}
        />
      )}

      <div className="editor__surface">
        <div className="editor__host" ref={hostRef} />

        {status === 'empty' ? (
          <div className="editor__blank">
            <p className="editor__blank-title">No note open</p>
            <p>Pick one from the tree, or create a new one.</p>
          </div>
        ) : null}
      </div>

      {vimEnabled ? null : <MarkupBar handleRef={handleRef} />}

      <EditorStatus onReopenConflict={() => useEditorStore.getState().setConflictView('choices')} />

      {conflict === null || conflict.view === 'hidden' ? null : (
        <ConflictDialog
          conflict={conflict}
          busy={saving}
          onResolve={(action) => void buffer.resolveConflict(action)}
          onDismiss={() => useEditorStore.getState().setConflictView('hidden')}
        />
      )}

      <UnsavedChangesDialog />
    </section>
  )
}
