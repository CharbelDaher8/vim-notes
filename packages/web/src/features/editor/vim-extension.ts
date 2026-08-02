/**
 * Vim, loaded on demand.
 *
 * `@replit/codemirror-vim` and what it drags in (`@codemirror/search`,
 * `@codemirror/autocomplete`) is around 320 kB of source -- comfortably the
 * largest thing in the bundle, and by DECISIONS.md §4 it is off by default on
 * exactly the device that can least afford to download it. A dynamic import
 * moves it into its own chunk that a phone never fetches.
 *
 * The cost is that turning vim on is asynchronous. `createEditor` handles that
 * by reconfiguring the compartment when the module lands and re-reading the
 * flag at that point, so a toggle during the load is not lost.
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

/** `[]` until the chunk is in memory; call `loadVim` to make it non-empty. */
export function vimExtension(enabled: boolean): Extension {
  if (!enabled || loaded === null) return []
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
