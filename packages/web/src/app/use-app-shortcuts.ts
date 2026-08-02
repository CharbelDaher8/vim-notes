import { useEffect } from 'react'

import { useWorkspaceStore } from '../shared/workspace-store'

/**
 * The two shortcuts worth stealing from the browser. Both are captured before
 * CodeMirror sees them, because with vim on the editor claims almost every
 * chord and these have to work from inside the buffer.
 *
 * DECISIONS.md §10 is the reason there are only two: a browser eats `Cmd+W`,
 * `Cmd+T` and friends before any of this runs, so anything more ambitious
 * belongs in the Tauri build, where the window actually receives them.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Only the drawer. Escape inside the editor belongs to vim.
        if (useWorkspaceStore.getState().drawerOpen) {
          useWorkspaceStore.getState().setDrawerOpen(false)
        }
        return
      }

      if (event.altKey || !(event.metaKey || event.ctrlKey)) return

      if (event.key === 'k') {
        event.preventDefault()
        useWorkspaceStore.getState().setSidebarPanel('search')
        // The panel has to render before its input can take focus.
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.search__field input')?.focus()
        })
        return
      }

      if (event.key === 'b') {
        event.preventDefault()
        const { drawerOpen, setDrawerOpen } = useWorkspaceStore.getState()
        setDrawerOpen(!drawerOpen)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
