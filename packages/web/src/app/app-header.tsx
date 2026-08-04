import { notePathBasename, notePathParent } from '@vim-notes/core'

import { useVimMode } from '../features/editor/use-vim-mode'
import { DockLink, DockMenu, useHasRoomForDock } from '../features/dock/dock-links'
import { useNewsStatus } from '../features/news/use-news'
import { useThemeStore } from '../shared/theme'
import { useMediaQuery } from '../shared/use-media-query'
import { Keyboard, Menu, Moon, Sun } from '../shared/ui/icons'
import { useWorkspaceStore } from '../shared/workspace-store'
import { DevTools } from './dev-tools'
import { ServerSettings } from './server-settings'

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

      <DockLinks />

      <DevTools />

      {/* Renders nothing in the browser build -- see ServerSettings. */}
      <ServerSettings />

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

/**
 * The three dockable views: a link to each full page, and a drag handle into
 * the dock beside it.
 *
 * `/term` is offered only where there is a keyboard. DECISIONS §3 and §4 are
 * explicit that it is the desktop client and a touch device gets CodeMirror
 * instead; offering it to a thumb would be offering a shell prompt, and then
 * modal editing with no Esc key. The graph and the news are fine under a thumb
 * -- both are things you read.
 *
 * News appears only once there is a feed behind it, so a deployment without the
 * aggregator has no link to a page explaining that it has no aggregator.
 */
function DockLinks() {
  const hasKeyboard = useMediaQuery('(hover: hover) and (pointer: fine)')
  const hasRoom = useHasRoomForDock()
  const { data: news } = useNewsStatus()

  return (
    <>
      <DockLink id="graph" />
      {news?.available === true ? <DockLink id="news" /> : null}
      {hasKeyboard ? <DockLink id="terminal" /> : null}
      {/* The pointer-free path to the same thing, and pointless where the dock
          itself is hidden. */}
      {hasRoom ? <DockMenu /> : null}
    </>
  )
}

/** system -> light -> dark -> system. Three states, one button. */
function nextTheme(current: 'system' | 'light' | 'dark') {
  if (current === 'system') return 'light'
  return current === 'light' ? 'dark' : 'system'
}
