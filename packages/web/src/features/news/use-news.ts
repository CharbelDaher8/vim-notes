import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NewsQuery } from '@vim-notes/core'

import { usePlatform } from '../../platform'

export const NEWS_STATUS_KEY = ['news', 'status'] as const
export const NEWS_FEED_KEY = ['news', 'feed'] as const

/**
 * Asked once and answered even when nothing is deployed.
 *
 * Separate from the feed itself because it is the question that decides whether
 * to ask the other one at all: the aggregator is a separate application that a
 * deployment may simply not have, and "not configured" is an ordinary answer
 * the pane renders calmly rather than an error.
 */
export function useNewsStatus() {
  const platform = usePlatform()

  return useQuery({
    queryKey: NEWS_STATUS_KEY,
    queryFn: () => platform.news.status(),
    // Nothing pushes here -- the aggregator refreshes on a timer measured in
    // hours -- so this is the whole invalidation story.
    staleTime: 5 * 60_000,
  })
}

export function useNewsFeed(query: NewsQuery) {
  const platform = usePlatform()
  const { data: status } = useNewsStatus()

  return useQuery({
    queryKey: [...NEWS_FEED_KEY, query],
    queryFn: () => platform.news.list(query),
    // Asking for a feed from a service that has already said it is not there
    // buys a guaranteed failure and an error state to render.
    enabled: status?.available === true,
    staleTime: 60_000,
  })
}

export function useNewsActions() {
  const platform = usePlatform()
  const client = useQueryClient()

  // Every mutation invalidates the feed rather than patching it in place. The
  // list is *ranked* by the aggregator, and read state is one of the inputs to
  // what it returns -- so a local edit could leave the pane showing an order
  // the server would not have produced.
  const invalidate = () => client.invalidateQueries({ queryKey: NEWS_FEED_KEY })

  const setRead = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => platform.news.setRead(id, read),
    onSuccess: invalidate,
  })

  const toggleSaved = useMutation({
    mutationFn: (id: string) => platform.news.toggleSaved(id),
    onSuccess: invalidate,
  })

  const save = useMutation({
    // The date is taken here rather than on the server: the server is a box in
    // whichever region was cheapest, and the day someone is having is not UTC.
    mutationFn: (id: string) => platform.news.save(id, localDate()),
    onSuccess: invalidate,
  })

  return { setRead, toggleSaved, save }
}

/** Today, in the reader's own timezone, as the `YYYY-MM-DD` the API expects. */
export function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
