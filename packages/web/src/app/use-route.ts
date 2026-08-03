import { useEffect, useState } from 'react'

export type Route = 'notes' | 'terminal' | 'graph' | 'news'

/**
 * Four routes, still no router.
 *
 * A routing library would be a dependency and a chunk to serve what are really
 * three applications sharing a server, and the phone pays for every kilobyte
 * (DECISIONS.md §13). But a chain of `startsWith` calls is how this turns into
 * a mess, so the prefixes live in a table: adding a route is one entry, and the
 * matching rule stays in one place.
 *
 * If this ever needs parameters, nested routes or anything resembling a
 * history stack, replace it with a real router rather than extending the table.
 */
const ROUTES: ReadonlyArray<{ prefix: string; route: Route }> = [
  { prefix: '/term', route: 'terminal' },
  { prefix: '/graph', route: 'graph' },
  { prefix: '/news', route: 'news' },
]

export function routeFor(pathname: string): Route {
  // Matched on a segment boundary, so `/terminal-notes` is not the terminal.
  const match = ROUTES.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )

  return match?.route ?? 'notes'
}

export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return routeFor(pathname)
}
