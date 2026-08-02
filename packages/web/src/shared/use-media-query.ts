import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * A media query as a reactive value.
 *
 * Everything that depends on device capability in this app -- vim defaults,
 * light/dark, sidebar versus drawer -- has to re-evaluate when the answer
 * changes, not once at mount. Pairing a phone with a Bluetooth keyboard, or
 * flipping the OS theme, both fire `change` on an existing MediaQueryList and
 * would otherwise leave the UI stuck on whatever was true at page load.
 */
export function useMediaQuery(query: string): boolean {
  const list = useMemo(
    () => (typeof window === 'undefined' ? null : window.matchMedia(query)),
    [query],
  )

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (list === null) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [list],
  )

  const getSnapshot = useCallback(() => list?.matches ?? false, [list])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
