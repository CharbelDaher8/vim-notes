import { useEffect } from 'react'

import { usePlatform } from '../platform'
import { useThemeSync } from '../shared/theme'
import { useWorkspaceStore } from '../shared/workspace-store'
import { GraphRoute } from './graph-route'
import { NotesWorkspace } from './notes-workspace'
import { TerminalRoute } from './terminal-route'
import { useRoute } from './use-route'

import './app.css'

/**
 * The notes workspace is eager and the terminal is lazy, not the other way
 * round and not both.
 *
 * The asymmetry is the point. `/` is what a phone opens, so it should paint
 * without waiting for a second round trip; `/term` is a desktop route by
 * DECISIONS.md §3, reached deliberately, where one extra fetch is invisible.
 * The cost is that `/term` also downloads CodeMirror it will not use -- worth
 * it, because that lands on a work PC on the tailnet rather than on a phone on
 * mobile data.
 */
export function App() {
  useThemeSync()
  useWindowTitle()

  switch (useRoute()) {
    case 'terminal':
      return <TerminalRoute />
    case 'graph':
      return <GraphRoute />
    default:
      return <NotesWorkspace />
  }
}

function useWindowTitle(): void {
  const platform = usePlatform()
  const openPath = useWorkspaceStore((state) => state.openPath)

  // In an effect rather than the render body: setting a title is a side effect
  // on the world, and React may render a component more than once per commit.
  //
  // It goes through the host rather than assigning `document.title` directly so
  // the Tauri build can set the real OS window title instead.
  useEffect(() => {
    platform.host.setWindowTitle(openPath === null ? 'vim-notes' : `${openPath} — vim-notes`)
  }, [platform, openPath])
}
