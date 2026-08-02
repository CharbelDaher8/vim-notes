/**
 * localStorage that cannot take the page down.
 *
 * Safari in private browsing throws on `setItem`, and an app whose entire
 * persisted state is three preference strings should degrade to "forgets your
 * settings" rather than to a blank screen.
 */
export function readSetting(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Preferences are a nicety; losing them is not worth an error path.
  }
}

export const SETTING_KEYS = {
  theme: 'vim-notes:theme',
  vimMode: 'vim-notes:vim-mode',
  sidebarWidth: 'vim-notes:sidebar-width',
} as const
