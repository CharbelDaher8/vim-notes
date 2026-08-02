import type { NotePath } from '@vim-notes/core'
import { create } from 'zustand'

export interface RevealTarget {
  /** 1-indexed, matching SearchHit. */
  line: number
  column?: number
}

export type SidebarPanel = 'files' | 'search' | 'tasks'

/**
 * Returns false to cancel the navigation. The editor registers one so that
 * leaving a buffer with unsaved changes can ask first -- with vim on there is
 * no autosave to fall back on, so a silent navigation loses work.
 *
 * It lives outside the store because it is a callback, not render state:
 * putting it in the store would make every subscriber re-render whenever the
 * editor re-registers it.
 */
export type NavigationGuard = (next: NotePath | null) => boolean | Promise<boolean>

let navigationGuard: NavigationGuard | null = null

export function setNavigationGuard(guard: NavigationGuard | null): void {
  navigationGuard = guard
}

interface WorkspaceState {
  openPath: NotePath | null
  reveal: RevealTarget | null
  /** The mobile drawer. On desktop the sidebar is always laid out. */
  drawerOpen: boolean
  sidebarPanel: SidebarPanel
  /**
   * The command palette. Here rather than in the component because the keyboard
   * shortcut that opens it is bound at the window, a long way from the dialog.
   */
  paletteOpen: boolean

  openNote: (path: NotePath, reveal?: RevealTarget) => Promise<void>
  closeNote: () => Promise<void>
  /** Bypasses the guard. For paths that no longer exist, or after a rename. */
  forceOpen: (path: NotePath | null) => void
  clearReveal: () => void
  setDrawerOpen: (open: boolean) => void
  setSidebarPanel: (panel: SidebarPanel) => void
  setPaletteOpen: (open: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  openPath: null,
  reveal: null,
  drawerOpen: false,
  sidebarPanel: 'files',
  paletteOpen: false,

  openNote: async (path, reveal) => {
    if (get().openPath !== path && navigationGuard !== null) {
      if ((await navigationGuard(path)) === false) return
    }

    set({ openPath: path, reveal: reveal ?? null, drawerOpen: false })
  },

  closeNote: async () => {
    if (get().openPath !== null && navigationGuard !== null) {
      if ((await navigationGuard(null)) === false) return
    }

    set({ openPath: null, reveal: null })
  },

  forceOpen: (path) => set({ openPath: path, reveal: null }),

  clearReveal: () => set({ reveal: null }),

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  setSidebarPanel: (sidebarPanel) => set({ sidebarPanel, drawerOpen: true }),

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}))
