/**
 * Markdown language support, loaded on demand.
 *
 * `@codemirror/lang-markdown` statically pulls in `@codemirror/language`, the
 * whole `@lezer` stack, and -- through its nested code-block support --
 * `lang-html`, which drags in `lang-javascript`, `lang-css` and
 * `@codemirror/autocomplete`. Measured, that is 85 kB gzipped, about a third of
 * the initial payload, on a client whose reason to exist is being opened on a
 * phone (DECISIONS.md §3).
 *
 * Deferring it is unusually cheap here because `markdown-decorations.ts` does
 * the highlighting from a regex line scan rather than the parse tree. Nothing
 * about how a note *looks* waits for this chunk. What waits is the editing
 * behaviour the parser drives -- `markdownKeymap`, so Enter continues a list or
 * a blockquote -- for one round trip on first visit and nothing at all after,
 * since the chunk is a hashed, cacheable asset.
 *
 * If the highlighting ever moves to a real `HighlightStyle` over the syntax
 * tree (see the note in markdown-decorations.ts), this trade stops being free
 * and should be reconsidered: the editor would then paint unstyled until the
 * chunk lands, which is a different and much worse thing to defer.
 */
import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

type MarkdownModule = typeof import('@codemirror/lang-markdown')

let loaded: MarkdownModule | null = null
let loading: Promise<MarkdownModule | null> | null = null

export function loadMarkdownLanguage(): Promise<MarkdownModule | null> {
  loading ??= import('@codemirror/lang-markdown')
    .then((module) => {
      loaded = module
      return module
    })
    .catch((error: unknown) => {
      // The editor is fully usable without it -- plain text with our own
      // highlighting -- so this degrades rather than breaks.
      console.error('[editor] markdown language support failed to load', error)
      loading = null
      return null
    })

  return loading
}

/**
 * `[]` until the chunk is in memory. Placed ahead of the default keymap by the
 * caller so that Enter hits `insertNewlineContinueMarkup` first.
 */
export function markdownLanguageExtension(): Extension {
  if (loaded === null) return []
  return [loaded.markdown(), keymap.of([...loaded.markdownKeymap])]
}
