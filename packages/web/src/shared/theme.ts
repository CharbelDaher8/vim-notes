import { useEffect } from 'react'
import { create } from 'zustand'

import { readSetting, SETTING_KEYS, writeSetting } from './local-storage'
import { useMediaQuery } from './use-media-query'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference !== 'system') return preference
  return systemPrefersDark ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  const stored = readSetting(SETTING_KEYS.theme)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

interface ThemeState {
  preference: ThemePreference
  systemPrefersDark: boolean
  setPreference: (preference: ThemePreference) => void
  setSystemPrefersDark: (prefersDark: boolean) => void
}

/**
 * A store rather than a hook with local state, because the editor needs the
 * resolved theme too -- CodeMirror's `dark` flag is not something CSS variables
 * can carry -- and two independent `useState`s reading the same localStorage
 * key is a desync waiting to happen.
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  preference: storedPreference(),
  systemPrefersDark: false,

  setPreference: (preference) => {
    set({ preference })
    writeSetting(SETTING_KEYS.theme, preference === 'system' ? null : preference)
  },

  setSystemPrefersDark: (systemPrefersDark) => set({ systemPrefersDark }),
}))

export function useResolvedTheme(): ResolvedTheme {
  return useThemeStore((state) => resolveTheme(state.preference, state.systemPrefersDark))
}

/** Called once, at the top of the app. */
export function useThemeSync(): void {
  const systemPrefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const preference = useThemeStore((state) => state.preference)
  const setSystemPrefersDark = useThemeStore((state) => state.setSystemPrefersDark)

  useEffect(() => {
    setSystemPrefersDark(systemPrefersDark)
  }, [systemPrefersDark, setSystemPrefersDark])

  useEffect(() => {
    // The attribute only has to set `color-scheme`; every colour in tokens.css
    // is a `light-dark()` pair, so this one write repaints the whole app.
    const root = document.documentElement
    if (preference === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', preference)
  }, [preference])
}
