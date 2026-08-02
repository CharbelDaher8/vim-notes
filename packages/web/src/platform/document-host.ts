import type { PlatformHost } from './platform'

/**
 * PlatformHost for anything rendering in a browser tab, which is both the web
 * client and -- for now -- the Tauri build, since DECISIONS.md §10 makes the
 * desktop app a thin client rather than a separate runtime.
 *
 * It exists so that `document.title` is written in exactly one place. When the
 * Tauri shell grows a real window-title command, that is a new implementation
 * of this interface rather than a hunt through feature code for direct
 * assignments.
 */
export const documentHost: PlatformHost = {
  setWindowTitle(title) {
    // Guarded so the platform can be constructed under vitest's default
    // environment, where there is no document at all.
    if (typeof document !== 'undefined') document.title = title
  },
}
