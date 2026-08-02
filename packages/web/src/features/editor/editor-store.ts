import type { ContentHash, NoteDocument, NoteMetadata, NotePath } from '@vim-notes/core'
import { create } from 'zustand'

import { readSetting, SETTING_KEYS, writeSetting } from '../../shared/local-storage'
import type { ConflictState } from './conflict-model'
import { parseVimOverride, type VimOverride } from './vim-preference'

export type LoadStatus = 'empty' | 'loading' | 'ready' | 'missing' | 'error'
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** Somebody else touched the open note. Non-blocking: the user may be typing. */
export interface ExternalNotice {
  reason: 'modified' | 'deleted'
  at: number
}

export interface DiscardPrompt {
  next: NotePath | null
  resolve: (choice: 'save' | 'discard' | 'cancel') => void
}

interface EditorState {
  path: NotePath | null
  status: LoadStatus
  /** The hash the buffer was read at. What every save is checked against. */
  baselineHash: ContentHash | null
  metadata: NoteMetadata | null

  dirty: boolean
  /**
   * Bumped on every user edit. A save carries the revision it snapshotted, so
   * a save that lands after two more keystrokes cannot report the buffer clean.
   */
  revision: number

  saveStatus: SaveStatus
  savedAt: number | null
  error: string | null

  conflict: ConflictState | null
  external: ExternalNotice | null
  discardPrompt: DiscardPrompt | null

  vimOverride: VimOverride
  vimEnabled: boolean

  beginLoad: (path: NotePath) => void
  loaded: (document: NoteDocument) => void
  loadMissing: (path: NotePath) => void
  loadFailed: (message: string) => void
  clear: () => void

  markDirty: () => void
  beginSave: () => number
  saveSucceeded: (metadata: NoteMetadata, revision: number) => void
  saveFailed: (message: string) => void

  /** After taking their version, or after a silent reload. */
  rebase: (metadata: NoteMetadata) => void

  setConflict: (conflict: ConflictState | null) => void
  setConflictView: (view: ConflictState['view']) => void
  setExternal: (notice: ExternalNotice | null) => void
  setDiscardPrompt: (prompt: DiscardPrompt | null) => void
  markMissing: () => void

  setVimOverride: (override: VimOverride) => void
  setVimEnabled: (enabled: boolean) => void
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  path: null,
  status: 'empty',
  baselineHash: null,
  metadata: null,

  dirty: false,
  revision: 0,

  saveStatus: 'idle',
  savedAt: null,
  error: null,

  conflict: null,
  external: null,
  discardPrompt: null,

  vimOverride: parseVimOverride(readSetting(SETTING_KEYS.vimMode)),
  vimEnabled: false,

  beginLoad: (path) =>
    set({
      path,
      status: 'loading',
      baselineHash: null,
      metadata: null,
      dirty: false,
      revision: 0,
      saveStatus: 'idle',
      savedAt: null,
      error: null,
      conflict: null,
      external: null,
    }),

  loaded: (document) =>
    set({
      path: document.path,
      status: 'ready',
      baselineHash: document.hash,
      metadata: document,
      dirty: false,
      saveStatus: 'idle',
      error: null,
    }),

  loadMissing: (path) => set({ path, status: 'missing', baselineHash: null, metadata: null }),

  loadFailed: (message) => set({ status: 'error', error: message }),

  clear: () =>
    set({
      path: null,
      status: 'empty',
      baselineHash: null,
      metadata: null,
      dirty: false,
      revision: 0,
      saveStatus: 'idle',
      savedAt: null,
      error: null,
      conflict: null,
      external: null,
    }),

  markDirty: () => set((state) => ({ dirty: true, revision: state.revision + 1, error: null })),

  beginSave: () => {
    set({ saveStatus: 'saving', error: null })
    return get().revision
  },

  saveSucceeded: (metadata, revision) =>
    set((state) => ({
      baselineHash: metadata.hash,
      metadata,
      // Only clean if nothing was typed while the write was in flight.
      dirty: state.revision !== revision,
      saveStatus: 'saved',
      savedAt: Date.now(),
      error: null,
      conflict: null,
      external: null,
      status: state.status === 'missing' ? 'ready' : state.status,
    })),

  saveFailed: (message) => set({ saveStatus: 'error', error: message }),

  rebase: (metadata) =>
    set({
      baselineHash: metadata.hash,
      metadata,
      dirty: false,
      status: 'ready',
      saveStatus: 'idle',
      error: null,
      external: null,
    }),

  // A conflict is not a save error -- nothing failed, the write was refused on
  // purpose -- so `saveStatus` returns to idle and the conflict is its own
  // signal. The status bar renders it ahead of everything else.
  setConflict: (conflict) => set({ conflict, saveStatus: 'idle' }),

  setConflictView: (view) =>
    set((state) => (state.conflict === null ? {} : { conflict: { ...state.conflict, view } })),

  setExternal: (external) => set({ external }),

  setDiscardPrompt: (discardPrompt) => set({ discardPrompt }),

  markMissing: () => set({ status: 'missing', baselineHash: null, metadata: null }),

  setVimOverride: (vimOverride) => {
    set({ vimOverride })
    writeSetting(SETTING_KEYS.vimMode, vimOverride)
  },

  setVimEnabled: (vimEnabled) => set({ vimEnabled }),
}))
