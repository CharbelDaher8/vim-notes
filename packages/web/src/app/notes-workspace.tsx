import { EditorPane } from '../features/editor/editor-pane'
import { CommandPalette } from '../features/search/command-palette'
import { useWorkspaceStore } from '../shared/workspace-store'
import { AppHeader } from './app-header'
import { Sidebar } from './sidebar'
import { useAppShortcuts } from './use-app-shortcuts'

export function NotesWorkspace() {
  useAppShortcuts()

  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen)

  return (
    <div className="app">
      <AppHeader />

      <div className="app__body">
        <Sidebar />

        {/* Only exists as a target on narrow screens; CSS keeps it out of the
            way of the persistent sidebar. */}
        <div
          className="app__scrim"
          data-visible={drawerOpen || undefined}
          onClick={() => useWorkspaceStore.getState().setDrawerOpen(false)}
        />

        <main className="app__main">
          <EditorPane />
        </main>
      </div>

      {/* Outside app__body: `<dialog>` renders in the top layer, so its place
          in the tree only decides who owns its state, not where it appears. */}
      <CommandPalette />
    </div>
  )
}
