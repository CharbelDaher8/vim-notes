import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NoteGraph } from '@vim-notes/core'
import { useEffect } from 'react'

import { usePlatform } from '../../platform'

export const GRAPH_QUERY_KEY = ['graph'] as const

export function useGraph() {
  const platform = usePlatform()

  return useQuery<NoteGraph>({
    queryKey: GRAPH_QUERY_KEY,
    queryFn: () => platform.graph(),
    // The watcher pushes changes, so this is only the backstop for a dropped
    // subscription. Rebuilding the index is not free, and the picture does not
    // rot on its own.
    staleTime: 60_000,
  })
}

/**
 * Keeps the picture honest when a note is saved -- from here, from nvim in the
 * terminal, or from a `git pull` on the server.
 *
 * Debounced, and generously. Autosave fires on every pause in typing, and each
 * one would otherwise rebuild the index and hand back a whole new graph.
 * Positions carry across a rebuild so nothing jumps, but the work is real, and
 * nobody is watching the graph for a change they made a quarter of a second
 * ago.
 */
export function useGraphSync(): void {
  const platform = usePlatform()
  const client = useQueryClient()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    // Not filtered to other people's writes, unlike the editor's subscription:
    // a TODO this client just typed is precisely the thing the graph should
    // grow a node for.
    const unsubscribe = platform.subscribeToChanges(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: GRAPH_QUERY_KEY })
      }, 1500)
    })

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [client, platform])
}
