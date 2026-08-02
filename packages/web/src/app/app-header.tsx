import { notePathBasename, notePathParent } from '@vim-notes/core'

import { useVimMode } from '../features/editor/use-vim-mode'
import { useThemeStore } from '../shared/theme'
import { Keyboard, Menu, Moon, Sun } from '../shared/ui/icons'
import { useWorkspaceStore } from '../shared/workspace-store'
import { DevTools } from './dev-tools'

export function AppHeader() {
  // Called here because this is where the toggle lives; the hook keeps the
  // editor store in step with the media queries as a side effect.
  const vim = useVimMode()

  const preference = useThemeStore((state) => state.preference)
  const setPreference = useThemeStore((state) => state.setPreference)
  const openPath = useWorkspaceStore((state) => state.openPath)

  const parent = openPath === null ? null : notePathParent(openPath)

  return (
    <header className="app__header">
      <button
        type="button"
        className="icon-button app__drawer-toggle"
        aria-label="Show notes"
        onClick={() => useWorkspaceStore.getState().setDrawerOpen(true)}
      >
        <Menu />
      </button>

      <h1 className="app__title">
        {openPath === null ? (
          <span className="app__brand">vim-notes</span>
        ) : (
          <>
            {parent === null ? null : <span className="app__crumb">{parent}/</span>}
            <span className="app__file">{notePathBasename(openPath)}</span>
          </>
        )}
      </h1>

      <DevTools />

      <button
        type="button"
        className="icon-button"
        aria-pressed={vim.enabled}
        title={
          vim.enabled
            ? 'Vim keys on — click to turn off'
            : 'Vim keys off — click to turn on (needs a real keyboard)'
        }
        aria-label="Vim keybindings"
        onClick={vim.toggle}
      >
        <Keyboard />
      </button>

      <button
        type="button"
        className="icon-button"
        title={`Theme: ${preference}`}
        aria-label={`Theme: ${preference}. Click to change.`}
        onClick={() => setPreference(nextTheme(preference))}
      >
        {preference === 'dark' ? <Moon /> : <Sun />}
      </button>
    </header>
  )
}

/** system -> light -> dark -> system. Three states, one button. */
function nextTheme(current: 'system' | 'light' | 'dark') {
  if (current === 'system') return 'light'
  return current === 'light' ? 'dark' : 'system'
}
