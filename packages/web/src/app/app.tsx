import { EditorPane } from '../features/editor/editor-pane'
import { useThemeSync } from '../shared/theme'
import { useWorkspaceStore } from '../shared/workspace-store'
import { AppHeader } from './app-header'
import { Sidebar } from './sidebar'
import { useAppShortcuts } from './use-app-shortcuts'

import './app.css'

export function App() {
  useThemeSync()
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
    </div>
  )
}
