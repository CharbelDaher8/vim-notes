import { useEffect, useState } from 'react'

export type Route = 'notes' | 'terminal'

/**
 * Two routes, so no router.
 *
 * A routing library would be a dependency and a chunk to serve `/` and `/term`,
 * which are not so much two pages as two applications that happen to share a
 * server. If a third route ever appears this should become a real router rather
 * than growing more `startsWith`.
 */
export function routeFor(pathname: string): Route {
  return pathname === '/term' || pathname.startsWith('/term/') ? 'terminal' : 'notes'
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
