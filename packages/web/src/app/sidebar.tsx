import { SearchPane } from '../features/search/search-pane'
import { TreePane } from '../features/tree/tree-pane'
import { SearchIcon } from '../shared/ui/icons'
import { useWorkspaceStore } from '../shared/workspace-store'

/**
 * A persistent column on a wide screen and an overlay drawer on a narrow one.
 * Same markup either way -- the difference is entirely CSS, which keeps the
 * tree's state and focus intact when a phone is rotated into landscape.
 */
export function Sidebar() {
  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen)
  const panel = useWorkspaceStore((state) => state.sidebarPanel)

  return (
    <aside className="sidebar" data-open={drawerOpen || undefined} aria-label="Notes and search">
      <nav className="sidebar__tabs">
        <button
          type="button"
          className="sidebar__tab"
          aria-pressed={panel === 'files'}
          onClick={() => useWorkspaceStore.setState({ sidebarPanel: 'files' })}
        >
          Files
        </button>
        <button
          type="button"
          className="sidebar__tab"
          aria-pressed={panel === 'search'}
          onClick={() => useWorkspaceStore.setState({ sidebarPanel: 'search' })}
        >
          <SearchIcon size={13} />
          Search
        </button>

        <button
          type="button"
          className="icon-button sidebar__close"
          aria-label="Hide notes"
          onClick={() => useWorkspaceStore.getState().setDrawerOpen(false)}
        >
          ×
        </button>
      </nav>

      <div className="sidebar__panel">{panel === 'files' ? <TreePane /> : <SearchPane />}</div>
    </aside>
  )
}
