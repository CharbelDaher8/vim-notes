/**
 * `[[` opens a list of notes.
 *
 * Loaded on demand, like the markdown language and for the same reason: this
 * pulls in `@codemirror/autocomplete`, and the phone pays for anything in the
 * initial chunk (DECISIONS.md §13).
 *
 * Measured, on the production build, rather than assumed:
 *
 *   - the initial bundle grows 9.9 kB raw, 2.9 kB gzipped. Almost none of that
 *     is this file -- it is the theme block for the popup, plus the bundler
 *     re-partitioning the vendor chunks once `@codemirror/autocomplete` has two
 *     dynamic importers instead of one;
 *   - the deferred side grows 22 kB, in a chunk shared with the markdown
 *     language, and is fetched only by an editor somebody has opened.
 *
 * `@codemirror/lang-markdown` already depended on this package, but only needed
 * a sliver of it and tree-shaking dropped the rest. The popup is most of what
 * was being dropped, so "it is already a dependency" is not the same as "it is
 * already paid for", which is what the first version of this comment claimed.
 *
 * Splitting the loader into its own eager module and deferring everything else
 * was tried, and moved 1 kB. Not worth a file, or the divergence from
 * markdown-language.ts, which is arranged exactly like this.
 *
 * The keymap is at `Prec.highest` for the reason Mod-s and Mod-Enter are: with
 * vim on, vim's handler sees Escape, Enter and the arrows first, and a
 * completion popup you cannot dismiss or accept from normal insert mode is
 * worse than no popup. Every one of those commands returns false when no
 * completion is open, so the keys fall straight through to vim the rest of the
 * time -- which is all of the time, for someone who never types `[[`.
 */
// Type-only, so the package is still reached exclusively through the dynamic
// import below and stays out of the initial chunk.
import type { Completion } from '@codemirror/autocomplete'
import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import type { NotePath } from '@vim-notes/core'

import { closingAfter, wikiCompletions, wikiQueryBefore } from './wikilink-completion'

type AutocompleteModule = typeof import('@codemirror/autocomplete')

let loaded: AutocompleteModule | null = null
let loading: Promise<AutocompleteModule | null> | null = null

/**
 * How far back a query may reach.
 *
 * A wiki link is a note name, not a paragraph, and this bounds the per-keystroke
 * scan so it does not grow with the document.
 */
const MAX_QUERY = 200

export function loadWikiAutocomplete(): Promise<AutocompleteModule | null> {
  loading ??= import('@codemirror/autocomplete')
    .then((module) => {
      loaded = module
      return module
    })
    .catch((error: unknown) => {
      // Links can still be typed by hand, which is how they were typed until
      // now, so this degrades rather than breaks.
      console.error('[editor] wiki link completion failed to load', error)
      loading = null
      return null
    })

  return loading
}

/** `[]` until the chunk lands, and until the client knows which notes exist. */
export function wikiAutocompleteExtension(paths: readonly NotePath[] | null): Extension {
  if (loaded === null || paths === null || paths.length === 0) return []

  const { acceptCompletion, autocompletion, completionKeymap } = loaded
  const completions = wikiCompletions(paths)

  return [
    autocompletion({
      // The only thing being completed is a note name, and offering the
      // language's own word list alongside would bury it.
      override: [
        (context) => {
          const from = Math.max(0, context.pos - MAX_QUERY)
          const typed = wikiQueryBefore(context.state.doc.sliceString(from, context.pos))
          if (typed === null) return null

          return {
            from: context.pos - typed.length,
            options: completions.map((completion) => {
              // Matched and displayed as the full path, so two notes sharing a
              // name are told apart in the list, and so typing part of a folder
              // finds it. `apply` is what actually gets written.
              const label = stripExtension(completion.path)

              return {
                label,
                // Only when they differ, and then it is the shorter form that
                // is about to be inserted -- worth showing, since the list is
                // showing something else.
                detail: completion.insert === label ? undefined : completion.insert,
                apply: applier(completion.insert),
              }
            }),
            // Everything up to a bracket or a newline is still the same query,
            // so the list filters as you type instead of being rebuilt.
            validFor: /^[^\]\n]*$/,
          }
        },
      ],
    }),

    Prec.highest(keymap.of([...completionKeymap, { key: 'Tab', run: acceptCompletion }])),
  ]
}

/**
 * Write the name, then put the cursor after the closing brackets.
 *
 * Whether it has to *add* those brackets depends on how the link was started:
 * typing `[[` leaves nothing to close, while landing inside an existing `[[]]`
 * leaves two brackets that must be stepped over rather than duplicated.
 */
function applier(insert: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const after = view.state.doc.sliceString(to, Math.min(to + 2, view.state.doc.length))
    const existing = closingAfter(after)
    const text = existing === 2 ? insert : `${insert}]]`

    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length + existing },
    })
  }
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot <= slash + 1 ? path : path.slice(0, dot)
}
