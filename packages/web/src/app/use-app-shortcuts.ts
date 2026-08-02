import { useEffect } from 'react'

import { useWorkspaceStore } from '../shared/workspace-store'

/**
 * The two shortcuts worth stealing from the browser: Cmd/Ctrl+K for the command
 * palette and Cmd/Ctrl+B for the sidebar. Both are captured before CodeMirror
 * sees them, because with vim on the editor claims almost every chord and these
 * have to work from inside the buffer.
 *
 * DECISIONS.md §10 is the reason there are only two: a browser eats `Cmd+W`,
 * `Cmd+T` and friends before any of this runs, so anything more ambitious
 * belongs in the Tauri build, where the window actually receives them.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The palette is a modal dialog and closes itself; letting this run as
        // well would shut the drawer behind it in the same keystroke.
        if (useWorkspaceStore.getState().paletteOpen) return

        // Only the drawer. Escape inside the editor belongs to vim.
        if (useWorkspaceStore.getState().drawerOpen) {
          useWorkspaceStore.getState().setDrawerOpen(false)
        }
        return
      }

      if (event.altKey || !(event.metaKey || event.ctrlKey)) return

      if (event.key === 'k') {
        event.preventDefault()
        // Toggles: the same chord that opened it is the one people reach for
        // when they change their mind about it.
        const { paletteOpen, setPaletteOpen } = useWorkspaceStore.getState()
        setPaletteOpen(!paletteOpen)
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
