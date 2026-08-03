/**
 * Vim, loaded on demand.
 *
 * `@replit/codemirror-vim` and what it drags in (`@codemirror/search`,
 * `@codemirror/autocomplete`) is around 320 kB of source -- comfortably the
 * largest thing in the bundle, and by DECISIONS.md §4 it is off by default on
 * exactly the device that can least afford to download it. A dynamic import
 * moves it into its own chunk that a phone never fetches.
 *
 * The cost is that turning vim on is asynchronous, and `vimExtension` below is
 * shaped around making that cost impossible to forget.
 */
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { editorCommands, NO_COMMANDS, type EditorCommands } from './editor-commands'

type VimModule = typeof import('@replit/codemirror-vim')

let loaded: VimModule | null = null
let loading: Promise<VimModule | null> | null = null

export function loadVim(): Promise<VimModule | null> {
  loading ??= import('@replit/codemirror-vim')
    .then((module) => {
      defineExCommands(module.Vim)
      loaded = module
      return module
    })
    .catch((error: unknown) => {
      // Offline, or a chunk that failed to fetch. The editor stays usable
      // without vim, which is a far better outcome than a blank pane.
      console.error('[editor] vim mode failed to load', error)
      loading = null
      return null
    })

  return loading
}

/**
 * The extension for the current flag -- and, while the chunk is still missing,
 * the request that fetches it.
 *
 * `onLoad` is required on purpose. Until the chunk is in memory this returns
 * `[]`, which inside a compartment is indistinguishable from vim being off:
 * the editor is configured for vim, has no vim in it, and nothing anywhere
 * says so. Asking for the extension is therefore also what orders it, and the
 * caller cannot end up configured-but-empty forever by forgetting a separate
 * call.
 *
 * It used to be a separate call, and it was forgotten. The editor is built
 * before the vim preference is known -- it resolves from media queries in an
 * effect that runs after the pane mounts -- so it is built with vim off and
 * switched on a tick later. Only construction fetched the chunk, so on every
 * desktop the store said vim, the status bar said VIM, and the buffer had no
 * vim keymap in it.
 *
 * The fetch is memoised in `loadVim`, so asking from three call sites is still
 * one request, and `onLoad` is not called if it fails -- reconfiguring to the
 * same empty extension would achieve nothing.
 */
export function vimExtension(enabled: boolean, onLoad: () => void): Extension {
  if (!enabled) return []

  if (loaded === null) {
    void loadVim().then((module) => {
      if (module !== null) onLoad()
    })
    return []
  }

  return loaded.vim({ status: true })
}

function defineExCommands(Vim: VimModule['Vim']): void {
  // `:w` exists upstream but calls `CM.commands.save`, which does not exist in
  // the CodeMirror 6 adapter -- so out of the box it silently does nothing,
  // which is a bad thing for a save command to do.
  Vim.defineEx('write', 'w', (cm) => commandsOf(cm).save())
  Vim.defineEx('quit', 'q', (cm) => commandsOf(cm).close())

  Vim.defineEx('wq', 'wq', (cm) => {
    const found = commandsOf(cm)
    found.save()
    found.close()
  })

  Vim.defineEx('xit', 'x', (cm) => {
    const found = commandsOf(cm)
    found.save()
    found.close()
  })
}

function commandsOf(cm: { cm6: unknown }): EditorCommands {
  const view = cm.cm6 as EditorView | undefined
  return view === undefined ? NO_COMMANDS : view.state.facet(editorCommands)
}
