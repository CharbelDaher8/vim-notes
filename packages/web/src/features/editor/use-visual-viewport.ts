import { useEffect, useRef } from 'react'

/**
 * The virtual keyboard, measured properly.
 *
 * `window.innerHeight` does not change when the keyboard opens on iOS -- the
 * layout viewport stays put and the keyboard covers the bottom of it -- so a
 * layout sized with `100vh` or `innerHeight` puts the last few lines of the
 * note, and often the cursor, underneath the keys. `visualViewport` is the only
 * thing that reports what is actually visible.
 *
 * Publishes two custom properties on the root element:
 *   --viewport-height  what the user can see, keyboard excluded
 *   --keyboard-inset   how much is covered at the bottom
 *
 * and sets `data-keyboard="open" | "closed"` so chrome that is pointless while
 * typing can get out of the way.
 */
const KEYBOARD_THRESHOLD_PX = 120

export function useVisualViewport(onKeyboardOpened?: () => void): void {
  const callbackRef = useRef(onKeyboardOpened)
  callbackRef.current = onKeyboardOpened

  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    let wasOpen = false

    const apply = () => {
      const height = viewport?.height ?? window.innerHeight
      const offsetTop = viewport?.offsetTop ?? 0
      const inset = Math.max(0, Math.round(window.innerHeight - (height + offsetTop)))

      root.style.setProperty('--viewport-height', `${Math.round(height)}px`)
      root.style.setProperty('--keyboard-inset', `${inset}px`)

      const open = inset > KEYBOARD_THRESHOLD_PX
      root.dataset.keyboard = open ? 'open' : 'closed'

      // Only on the rising edge: the viewport also fires while scrolling with
      // the keyboard up, and yanking the cursor back then would fight the user.
      if (open && !wasOpen) callbackRef.current?.()
      wasOpen = open
    }

    apply()

    viewport?.addEventListener('resize', apply)
    viewport?.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', apply)

    return () => {
      viewport?.removeEventListener('resize', apply)
      viewport?.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', apply)
    }
  }, [])
}
