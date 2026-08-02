import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotePath, ResolvedLink } from '@vim-notes/core'
import { useEffect } from 'react'

import { usePlatform } from '../../platform'

export const BACKLINKS_QUERY_KEY = 'backlinks'

/**
 * What links *at* the open note.
 *
 * Invalidated on any file change, including this client's own writes: a link
 * typed into another note in another tab, or into nvim in the pty, is exactly
 * the event this list exists to notice.
 */
export function useBacklinks(path: NotePath | null) {
  const platform = usePlatform()
  const client = useQueryClient()

  useEffect(
    () =>
      platform.subscribeToChanges(() => {
        void client.invalidateQueries({ queryKey: [BACKLINKS_QUERY_KEY] })
      }),
    [client, platform],
  )

  return useQuery<ResolvedLink[]>({
    queryKey: [BACKLINKS_QUERY_KEY, path],
    queryFn: () => (path === null ? Promise.resolve([]) : platform.backlinks(path)),
    enabled: path !== null,
    staleTime: 10_000,
  })
}
