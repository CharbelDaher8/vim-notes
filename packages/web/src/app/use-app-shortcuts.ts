import { useEffect } from 'react'

import { useWorkspaceStore } from '../shared/workspace-store'

/**
 * The three shortcuts worth stealing from the browser: Cmd/Ctrl+K for the
 * command palette, Cmd/Ctrl+B for the sidebar and Cmd/Ctrl+G for the graph.
 * All are captured before CodeMirror sees them, because with vim on the editor
 * claims almost every chord and these have to work from inside the buffer.
 *
 * DECISIONS.md §10 is the reason there are only three: a browser eats `Cmd+W`,
 * `Cmd+T` and friends before any of this runs, so anything more ambitious
 * belongs in the Tauri build, where the window actually receives them.
 *
 * Cmd+G is "find again" in a browser, which this app has no use for -- its
 * search is the palette and the search pane, neither of which is the browser's
 * find bar.
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
        return
      }

      // Deliberately not gated on the viewport: the panel decides for itself
      // whether there is room, and a shortcut that silently does nothing on a
      // narrow window is better than one that leaves a flag set behind your
      // back and surprises you when the window grows.
      if (event.key === 'g') {
        event.preventDefault()
        const { graphPanelOpen, setGraphPanelOpen } = useWorkspaceStore.getState()
        setGraphPanelOpen(!graphPanelOpen)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
