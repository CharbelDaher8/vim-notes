import { SearchPane } from '../features/search/search-pane'
import { TasksPane } from '../features/tasks/tasks-pane'
import { TreePane } from '../features/tree/tree-pane'
import { CheckSquare, SearchIcon } from '../shared/ui/icons'
import { useWorkspaceStore, type SidebarPanel } from '../shared/workspace-store'

/**
 * A persistent column on a wide screen and an overlay drawer on a narrow one.
 * Same markup either way -- the difference is entirely CSS, which keeps the
 * tree's state and focus intact when a phone is rotated into landscape.
 */

const PANELS = [
  { id: 'files', label: 'Files', icon: null },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
] as const satisfies ReadonlyArray<{
  id: SidebarPanel
  label: string
  icon: ((props: { size?: number }) => React.ReactElement) | null
}>

export function Sidebar() {
  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen)
  const panel = useWorkspaceStore((state) => state.sidebarPanel)

  return (
    <aside
      className="sidebar"
      data-open={drawerOpen || undefined}
      aria-label="Notes, search and tasks"
    >
      <nav className="sidebar__tabs">
        {PANELS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="sidebar__tab"
            aria-pressed={panel === id}
            onClick={() => useWorkspaceStore.setState({ sidebarPanel: id })}
          >
            {Icon === null ? null : <Icon size={13} />}
            {label}
          </button>
        ))}

        <button
          type="button"
          className="icon-button sidebar__close"
          aria-label="Hide notes"
          onClick={() => useWorkspaceStore.getState().setDrawerOpen(false)}
        >
          ×
        </button>
      </nav>

      {/*
        Only the selected panel is mounted. The tasks pane queries the index on
        mount, and keeping all three alive would have it refetching for a panel
        nobody is looking at every time the notes change.
      */}
      <div className="sidebar__panel">
        {panel === 'files' ? <TreePane /> : panel === 'search' ? <SearchPane /> : <TasksPane />}
      </div>
    </aside>
  )
}
