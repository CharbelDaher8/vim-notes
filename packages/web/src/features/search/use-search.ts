import { useQuery } from '@tanstack/react-query'
import type { SearchHit } from '@vim-notes/core'
import { useEffect, useState } from 'react'

import { usePlatform } from '../../platform'

export interface SearchOptions {
  pattern: string
  regex: boolean
  caseSensitive: boolean
}

/** Typing is fast, ripgrep is a subprocess. Do not race them. */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return settled
}

export function useSearch(options: SearchOptions) {
  const platform = usePlatform()
  const enabled = options.pattern.trim().length > 0

  return useQuery<SearchHit[]>({
    queryKey: ['search', options.pattern, options.regex, options.caseSensitive],
    queryFn: () =>
      platform.search({
        pattern: options.pattern,
        regex: options.regex,
        caseSensitive: options.caseSensitive,
        limit: 200,
      }),
    enabled,
    // Results go stale the moment anyone writes a note, and re-running is
    // cheap; keeping them around only long enough to survive a panel switch.
    staleTime: 10_000,
  })
}
