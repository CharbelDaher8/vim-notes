/**
 * `Platform` for the Tauri desktop shell.
 *
 * DECISIONS.md §10 is explicit that the desktop app is a thin client and that
 * offline/local sync is deliberately deferred, so the note operations are
 * *identical* to the browser's -- same server, same tRPC, same optimistic
 * concurrency. This class delegates every one of them to `WebPlatform` rather
 * than reimplementing them, because two copies of the conflict-handling path
 * would be two places for it to diverge, and that path is the one rule the
 * whole system rests on.
 *
 * What it actually adds is the host: native window title, links that open in
 * the OS browser instead of destroying the app, reveal-in-Finder, and the menu
 * and global-hotkey commands that are the reason for a desktop build at all.
 *
 * The seam for a later local-filesystem implementation is the delegate. When
 * offline editing stops being deferred, a `LocalFilesystemPlatform` replaces
 * the `WebPlatform` passed to the constructor -- or is chosen between them per
 * call for a sync layer -- and `TauriHost` is untouched. That is why the
 * delegate is a constructor parameter typed as `Platform` rather than a
 * `WebPlatform` built inside.
 */
import type {
  AnnotationFilter,
  AnnotationRecord,
  ExpectedVersion,
  FileChangeEvent,
  ForceWrite,
  NoteDocument,
  NoteGraph,
  NotePath,
  ResolvedLink,
  SearchHit,
  SearchQuery,
  TreeEntry,
  Unsubscribe,
  WriteOutcome,
} from '@vim-notes/core'

import { documentHost } from './document-host'
import { isSafeExternalUrl } from './external-url'
import type { HostCommand, Platform, PlatformHost } from './platform'

export class TauriPlatform implements Platform {
  readonly id = 'tauri' as const
  readonly host: PlatformHost

  readonly #notes: Platform

  constructor(notes: Platform, host: PlatformHost = createTauriHost()) {
    this.#notes = notes
    this.host = host
  }

  tree(): Promise<TreeEntry[]> {
    return this.#notes.tree()
  }

  read(path: NotePath): Promise<NoteDocument | null> {
    return this.#notes.read(path)
  }

  write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome> {
    return this.#notes.write(path, content, expected)
  }

  move(from: NotePath, to: NotePath): Promise<void> {
    return this.#notes.move(from, to)
  }

  remove(path: NotePath): Promise<void> {
    return this.#notes.remove(path)
  }

  createDirectory(path: NotePath): Promise<void> {
    return this.#notes.createDirectory(path)
  }

  search(query: SearchQuery): Promise<SearchHit[]> {
    return this.#notes.search(query)
  }

  subscribeToChanges(listener: (event: FileChangeEvent) => void): Unsubscribe {
    return this.#notes.subscribeToChanges(listener)
  }

  annotations(filter?: AnnotationFilter): Promise<AnnotationRecord[]> {
    return this.#notes.annotations(filter)
  }

  backlinks(path: NotePath): Promise<ResolvedLink[]> {
    return this.#notes.backlinks(path)
  }

  graph(): Promise<NoteGraph> {
    return this.#notes.graph()
  }
}

// --- The native side ---------------------------------------------------------

/**
 * Reached through the globals rather than `@tauri-apps/api`.
 *
 * That package is not a dependency of this workspace, and adding one requires
 * an install that is not mine to run. `withGlobalTauri` in `tauri.conf.json`
 * exposes the same functions on `window.__TAURI__`, which is enough for the
 * five calls below. Swap this for the real import when the desktop package
 * lands its dependencies -- the interface above does not change.
 */
interface TauriGlobal {
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
  event?: {
    listen?: (
      event: string,
      handler: (payload: { payload: unknown }) => void,
    ) => Promise<() => void>
  }
  window?: {
    getCurrentWindow?: () => { setTitle?: (title: string) => Promise<void> }
  }
}

/**
 * Commands from `tauri-plugin-opener`, addressed through the core `invoke`.
 *
 * `plugin:<name>|<command>` is how a plugin command is reached without its npm
 * package -- `@tauri-apps/plugin-opener` is not a dependency here and would only
 * be a thin wrapper around these two strings. Both are granted individually in
 * src-tauri/capabilities/default.json; the plugin refuses anything else.
 *
 * The shell previously invoked `open_external` and `reveal_in_file_manager`,
 * which were never implemented on the Rust side. `invoke` rejects an unknown
 * command, so every external link in the desktop build failed -- and this is
 * the one that matters, because the fallback in a webview is a navigation that
 * replaces the running application.
 */
const OPEN_URL = 'plugin:opener|open_url'
const REVEAL_ITEM = 'plugin:opener|reveal_item_in_dir'

/**
 * Detection reads the global rather than importing `@tauri-apps/api`, and
 * `app.withGlobalTauri` is set in tauri.conf.json to put it there.
 *
 * Do not "tidy" this into an import without also changing that setting and
 * adding the dependency. Without the global this returns null in a real desktop
 * window, the host silently falls back to the browser one, and the only UI that
 * can tell the app where its server lives -- gated on `kind === 'tauri'` --
 * never renders. The app then ships unable to reach anything, with no way to
 * discover why.
 */
function tauri(): TauriGlobal | null {
  const global = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  return global ?? null
}

export function isRunningInTauri(): boolean {
  return tauri() !== null
}

export function createTauriHost(): PlatformHost {
  const api = tauri()

  // Falling back to the browser host rather than throwing: a developer running
  // `vite dev` in a plain browser while working on the desktop build should get
  // a working app, not a blank screen.
  if (api === null) return documentHost

  return {
    kind: 'tauri',
    capabilities: { revealInFileManager: true, commands: true },

    setWindowTitle: (title) => {
      void api.window?.getCurrentWindow?.().setTitle?.(title)
    },

    openExternal: async (url) => {
      // Refused before it reaches the OS. In a webview a bad navigation does
      // not just open a tab, it replaces the application.
      if (!isSafeExternalUrl(url)) return
      await api.core?.invoke?.(OPEN_URL, { url })
    },

    revealInFileManager: async (path) => {
      await api.core?.invoke?.(REVEAL_ITEM, { path })
    },

    /**
     * Wired on this side only. The Rust shell does not emit
     * `vim-notes://command` yet, so nothing arrives and no menu accelerator or
     * global hotkey fires.
     *
     * Worth saying out loud rather than leaving to be discovered by someone
     * wondering why Cmd+N does nothing: DECISIONS §10 names keyboard capture as
     * the reason the desktop build exists at all. What is done is the half that
     * mattered first -- the macOS menu deliberately *omits* Cmd+W and Cmd+T so
     * the webview receives them. Emitting commands from the native side is the
     * unfinished half.
     */
    onCommand: (listener) => {
      let cancel: (() => void) | null = null
      let cancelled = false

      void api.event
        ?.listen?.('vim-notes://command', ({ payload }) => {
          if (isHostCommand(payload)) listener(payload)
        })
        .then((unlisten) => {
          // `listen` is async, so an unsubscribe can land before it resolves.
          if (cancelled) unlisten()
          else cancel = unlisten
        })

      return () => {
        cancelled = true
        cancel?.()
      }
    },
  }
}

const HOST_COMMANDS: readonly HostCommand[] = [
  'new-note',
  'search',
  'save',
  'toggle-vim',
  'close-note',
]

function isHostCommand(value: unknown): value is HostCommand {
  return typeof value === 'string' && (HOST_COMMANDS as readonly string[]).includes(value)
}
