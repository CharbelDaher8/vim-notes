import type { NotePath } from '@vim-notes/core'
import { create } from 'zustand'

export type TreeAction =
  | { kind: 'create-file'; parent: NotePath | null }
  | { kind: 'create-directory'; parent: NotePath | null }
  | { kind: 'rename'; target: NotePath; isDirectory: boolean }
  | { kind: 'delete'; target: NotePath; isDirectory: boolean }

interface TreeState {
  /** Directory paths currently open. Replaced, never mutated, so React sees it. */
  expanded: ReadonlySet<NotePath>
  /** The keyboard cursor. Distinct from the open note: you can browse without opening. */
  selected: NotePath | null
  action: TreeAction | null

  toggle: (path: NotePath) => void
  expand: (paths: readonly NotePath[]) => void
  collapse: (path: NotePath) => void
  select: (path: NotePath | null) => void
  setAction: (action: TreeAction | null) => void
}

export const useTreeStore = create<TreeState>()((set) => ({
  expanded: new Set<NotePath>(),
  selected: null,
  action: null,

  toggle: (path) =>
    set((state) => {
      const next = new Set(state.expanded)
      if (!next.delete(path)) next.add(path)
      return { expanded: next }
    }),

  expand: (paths) =>
    set((state) => {
      if (paths.every((path) => state.expanded.has(path))) return {}

      const next = new Set(state.expanded)
      for (const path of paths) next.add(path)
      return { expanded: next }
    }),

  collapse: (path) =>
    set((state) => {
      if (!state.expanded.has(path)) return {}

      const next = new Set(state.expanded)
      next.delete(path)
      return { expanded: next }
    }),

  select: (selected) => set({ selected }),

  setAction: (action) => set({ action }),
}))
