import { isSafeExternalUrl } from './external-url'
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
 *
 * The native-only members are real no-ops rather than throws, and callers check
 * `capabilities` before offering the affordance. A browser genuinely cannot
 * open Finder, and making every call site handle a rejection for a case that is
 * simply absent buys nothing.
 */
export const documentHost: PlatformHost = {
  kind: 'browser',
  capabilities: { revealInFileManager: false, commands: false },

  setWindowTitle(title) {
    // Guarded so the platform can be constructed under vitest's default
    // environment, where there is no document at all.
    if (typeof document !== 'undefined') document.title = title
  },

  async openExternal(url) {
    if (!isSafeExternalUrl(url)) return

    // `noopener` matters: without it the opened page gets a handle on this
    // window through `window.opener` and can navigate it somewhere else.
    window.open(url, '_blank', 'noopener,noreferrer')
  },

  async revealInFileManager() {
    // Nothing a browser can do; `capabilities.revealInFileManager` says so.
  },

  onCommand() {
    // No menus, no tray, no global hotkeys. See DECISIONS.md §10 for why that
    // is the main thing the desktop build buys.
    return () => {}
  },
}
