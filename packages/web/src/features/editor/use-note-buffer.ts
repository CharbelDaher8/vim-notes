/**
 * Everything that happens *around* the document: loading it, saving it,
 * resolving conflicts, and refusing to let unsaved work disappear.
 *
 * CodeMirror still owns the text. This hook only ever asks for it (`getContent`
 * at the moment of a save) or hands a new one over (`loadDocument` when the
 * open note changes, `applyRemoteContent` when the file changed underneath).
 */
import { asContentHash, FORCE_WRITE } from '@vim-notes/core'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'

import { usePlatform } from '../../platform'
import { setNavigationGuard, useWorkspaceStore } from '../../shared/workspace-store'
import { createAutosaveScheduler } from './autosave'
import type { ConflictAction } from './conflict-model'
import type { EditorHandle } from './create-editor'
import { useEditorStore } from './editor-store'
import { setLocalWriteListener } from './local-writes'

export interface NoteBuffer {
  /** Called from CodeMirror's update listener for user-originated changes. */
  handleUserChange: () => void
  save: () => Promise<void>
  resolveConflict: (action: ConflictAction) => Promise<void>
  /** Turns a watcher notice into the full conflict dialog, opened on the diff. */
  reviewExternal: () => Promise<void>
  reloadFromDisk: () => Promise<void>
  dismissExternal: () => void
}

export function useNoteBuffer(handleRef: RefObject<EditorHandle | null>): NoteBuffer {
  const platform = usePlatform()
  const openPath = useWorkspaceStore((state) => state.openPath)
  const vimEnabled = useEditorStore((state) => state.vimEnabled)

  // Indirection so the scheduler, which is created once, always calls the
  // current save closure rather than the one captured on first render.
  const saveRef = useRef<() => void>(() => {})

  const autosave = useMemo(() => createAutosaveScheduler({ save: () => saveRef.current() }), [])

  const save = useCallback(async () => {
    const handle = handleRef.current
    const store = useEditorStore.getState()

    if (handle === null || store.path === null) return
    if (store.saveStatus === 'saving' || store.conflict !== null) return

    const path = store.path
    const content = handle.getContent()
    const revision = store.beginSave()

    try {
      const outcome = await platform.write(path, content, store.baselineHash)

      if (outcome.ok) {
        useEditorStore.getState().saveSucceeded(outcome.metadata, revision)
        return
      }

      // Refused. Fetch their version now rather than when the dialog opens, so
      // "view both" is instant and so the comparison is of the bytes that
      // caused the refusal.
      const theirs = await platform.read(path)

      useEditorStore.getState().setConflict({
        path,
        conflict: outcome.conflict,
        mine: content,
        theirs: theirs?.content ?? null,
        theirsMetadata: theirs,
        view: 'choices',
      })
    } catch (error) {
      useEditorStore.getState().saveFailed(describeError(error))
    }
  }, [handleRef, platform])

  saveRef.current = () => void save()

  const handleUserChange = useCallback(() => {
    const store = useEditorStore.getState()
    store.markDirty()

    // With vim on, `:w` is the save. An autosave firing mid-command would
    // produce writes -- and commits -- nobody asked for.
    if (!store.vimEnabled) autosave.schedule()
  }, [autosave])

  const reloadFromDisk = useCallback(async () => {
    const handle = handleRef.current
    const path = useEditorStore.getState().path
    if (handle === null || path === null) return

    try {
      const document = await platform.read(path)

      if (document === null) {
        useEditorStore.getState().markMissing()
        return
      }

      handle.applyRemoteContent(document.content)
      useEditorStore.getState().rebase(document)
    } catch (error) {
      useEditorStore.getState().loadFailed(describeError(error))
    }
  }, [handleRef, platform])

  const reviewExternal = useCallback(async () => {
    const store = useEditorStore.getState()
    const handle = handleRef.current
    if (store.path === null) return

    const mine = handle?.getContent() ?? ''
    const theirs = await platform.read(store.path)

    if (theirs === null) {
      useEditorStore.getState().setConflict({
        path: store.path,
        conflict: { kind: 'deleted-underneath', expected: store.baselineHash ?? asContentHash('') },
        mine,
        theirs: null,
        theirsMetadata: null,
        view: 'choices',
      })
    } else {
      // Genuinely the same situation as a refused write -- a stale baseline --
      // just noticed by the watcher first, so it reuses the same dialog.
      useEditorStore.getState().setConflict({
        path: store.path,
        conflict: {
          kind: 'stale',
          expected: store.baselineHash ?? theirs.hash,
          actual: theirs.hash,
        },
        mine,
        theirs: theirs.content,
        theirsMetadata: theirs,
        view: 'diff',
      })
    }

    useEditorStore.getState().setExternal(null)
  }, [handleRef, platform])

  const resolveConflict = useCallback(
    async (action: ConflictAction) => {
      const store = useEditorStore.getState()
      const conflict = store.conflict
      const handle = handleRef.current
      if (conflict === null) return

      if (action === 'view-both') {
        store.setConflictView('diff')
        return
      }

      if (action === 'discard-mine') {
        store.clear()
        // Straight past the navigation guard: there is nothing left to save,
        // and prompting about it would be absurd.
        useWorkspaceStore.getState().forceOpen(null)
        return
      }

      if (action === 'take-theirs') {
        if (conflict.theirs === null || conflict.theirsMetadata === null) return
        handle?.applyRemoteContent(conflict.theirs)
        store.rebase(conflict.theirsMetadata)
        store.setConflict(null)
        return
      }

      // keep-mine. The live buffer rather than the snapshot: the snapshot is
      // what the dialog compared, but what the user means by "mine" is what is
      // in front of them.
      const content = handle?.getContent() ?? conflict.mine
      const revision = store.beginSave()

      try {
        const outcome = await platform.write(conflict.path, content, FORCE_WRITE)

        if (outcome.ok) {
          useEditorStore.getState().saveSucceeded(outcome.metadata, revision)
          useEditorStore.getState().setConflict(null)
        } else {
          useEditorStore.getState().saveFailed('the write was refused even with force')
        }
      } catch (error) {
        useEditorStore.getState().saveFailed(describeError(error))
      }
    },
    [handleRef, platform],
  )

  const dismissExternal = useCallback(() => {
    useEditorStore.getState().setExternal(null)
  }, [])

  // --- Loading ---------------------------------------------------------------

  useEffect(() => {
    const handle = handleRef.current

    if (openPath === null) {
      useEditorStore.getState().clear()
      handle?.loadDocument('')
      return
    }

    let cancelled = false
    useEditorStore.getState().beginLoad(openPath)

    void (async () => {
      try {
        const document = await platform.read(openPath)
        if (cancelled) return

        if (document === null) {
          useEditorStore.getState().loadMissing(openPath)
          handle?.loadDocument('')
          return
        }

        handle?.loadDocument(document.content)
        useEditorStore.getState().loaded(document)

        const { reveal, clearReveal } = useWorkspaceStore.getState()
        if (reveal !== null) {
          handle?.reveal(reveal.line, reveal.column)
          clearReveal()
        }
      } catch (error) {
        if (!cancelled) useEditorStore.getState().loadFailed(describeError(error))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [handleRef, openPath, platform])

  /**
   * Another part of this app -- the tasks panel ticking a checkbox -- wrote the
   * file this buffer is showing. The watcher cannot deliver that (see
   * local-writes.ts), and ignoring it would leave the buffer holding a baseline
   * hash that is already stale.
   */
  useEffect(() => {
    setLocalWriteListener((path) => {
      const store = useEditorStore.getState()
      if (store.path !== path) return

      // A dirty buffer is never touched, exactly as for nvim's writes: the user
      // is told, and chooses.
      if (store.dirty) store.setExternal({ reason: 'modified', at: Date.now() })
      else void reloadFromDisk()
    })

    return () => setLocalWriteListener(null)
  }, [reloadFromDisk])

  // --- Not losing work -------------------------------------------------------

  useEffect(() => {
    // Toggling vim on mid-edit must not leave a timer armed behind it.
    if (vimEnabled) autosave.cancel()
    else if (useEditorStore.getState().dirty) autosave.schedule()
  }, [autosave, vimEnabled])

  useEffect(() => {
    setNavigationGuard(async (next) => {
      const store = useEditorStore.getState()
      if (!store.dirty || store.path === null) return true

      if (!store.vimEnabled) {
        // Autosave promised this would be handled without asking. Keep it.
        autosave.cancel()
        await save()
        return settled()
      }

      const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
        useEditorStore.getState().setDiscardPrompt({ next, resolve })
      })

      useEditorStore.getState().setDiscardPrompt(null)
      if (choice === 'cancel') return false
      if (choice === 'discard') return true

      await save()
      return settled()
    })

    return () => setNavigationGuard(null)
  }, [autosave, save])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!useEditorStore.getState().dirty) return
      event.preventDefault()
    }

    const onVisibilityChange = () => {
      // A backgrounded tab on a phone may never be resumed. Anything the
      // debounce was still holding gets written now.
      if (document.visibilityState === 'hidden') autosave.flush()
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [autosave])

  useEffect(() => () => autosave.cancel(), [autosave])

  return {
    handleUserChange,
    save,
    resolveConflict,
    reviewExternal,
    reloadFromDisk,
    dismissExternal,
  }
}

/** True when it is safe to walk away from the buffer. */
function settled(): boolean {
  const store = useEditorStore.getState()
  return !store.dirty && store.conflict === null
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
