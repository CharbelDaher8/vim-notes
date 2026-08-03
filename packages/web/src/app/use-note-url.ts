/**
 * Keeps the address bar and the open note in step.
 *
 * Two directions, and they are not symmetrical. On the way in, the URL wins
 * once: whatever `/graph` or a bookmark named is opened. After that the
 * workspace wins, and the URL is rewritten to follow it.
 *
 * Always `replaceState`, never `pushState`. Every note you opened becoming a
 * history entry sounds helpful right up until Back walks you through eleven
 * notes instead of leaving the app -- and with the editor holding unsaved
 * changes behind a navigation guard, half of those steps would have to be
 * refused, which is not something the back button can do gracefully.
 */
import { useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../shared/workspace-store'
import { noteFromSearch, workspaceHref } from './note-url'

export function useNoteUrl(): void {
  // Read during the first render rather than in an effect, so it is taken
  // before anything below has a chance to rewrite the thing being read.
  const [arrived] = useState(() => noteFromSearch(window.location.search))

  const openPath = useWorkspaceStore((state) => state.openPath)

  // Written during render on purpose, like `labelledRef` in the graph: it is a
  // fact about what has already happened, not state anything renders from.
  const openedRef = useRef(false)
  if (openPath !== null) openedRef.current = true

  useEffect(() => {
    if (arrived === null) return
    void useWorkspaceStore.getState().openNote(arrived.path, arrived.reveal)
  }, [arrived])

  useEffect(() => {
    // Nothing is open *yet* and the URL named something: the effect above is
    // one tick from opening it, and rewriting the URL to `/` in the meantime
    // would throw away the request before it was answered.
    if (openPath === null && arrived !== null && !openedRef.current) return

    const next = workspaceHref(openPath)
    if (`${window.location.pathname}${window.location.search}` === next) return

    window.history.replaceState(null, '', next)
  }, [arrived, openPath])
}
