/**
 * `[[wikilinks]]` in the buffer: styled, clickable, and out of the way.
 *
 * The link positions come from core's `parseNoteMarkup` rather than a regex of
 * this module's own, which is what guarantees the editor and the index agree
 * about what a link is -- including the parts that are easy to forget, like a
 * `[[link]]` inside a fenced code block being a quotation and not a link.
 *
 * ## Not fighting vim
 *
 * Following is bound to `Mod-Enter` and to a plain click. It is deliberately
 * *not* bound to Enter: with vim off, Enter inside a link has to insert a
 * newline, and with vim on it is a motion. A wiki link is not worth taking the
 * single most-pressed key in the editor away from the editor, and `Mod-Enter`
 * is unbound in both modes. `followAtCursor` returns false whenever the cursor
 * is not inside a link, so even that key falls through untouched everywhere
 * else.
 *
 * A plain click follows, rather than requiring a modifier the way a desktop
 * editor would. This app exists for the phone (DECISIONS.md §3), and there is
 * no Ctrl on a phone. The cost is that placing the caret inside a link with the
 * pointer means clicking just outside the brackets first; the keyboard reaches
 * it as normal, and a drag-select over a link is left alone because a
 * non-empty selection is not treated as a click.
 */
import { Facet, Prec, RangeSetBuilder, type Extension, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { parseNoteMarkup, type NotePath, type WikiLink } from '@vim-notes/core'

export interface FollowedLink {
  /** Exactly as written between the brackets. */
  target: string
  /** Null when no note answers to that name -- which is how one gets created. */
  resolved: NotePath | null
}

export interface WikiLinkContext {
  resolve: (target: string) => NotePath | null
  follow: (link: FollowedLink) => void
  /**
   * Every note that could be linked to, for completion.
   *
   * The same list `resolve` is closed over, handed out rather than hidden,
   * because "which notes exist" is the question completion asks and `resolve`
   * only answers it one name at a time.
   */
  paths: readonly NotePath[]
}

/**
 * Null until the file tree has loaded. Links are then styled as links but not
 * yet as missing, because "no note answers to this name" and "I have not
 * looked yet" are different claims and only one of them should be drawn.
 */
const wikiLinkContext = Facet.define<WikiLinkContext | null, WikiLinkContext | null>({
  combine: (values) => values[0] ?? null,
})

const PUNCT = Decoration.mark({ class: 'cm-md-punct' })
const LINK = Decoration.mark({ class: 'cm-wikilink' })
const MISSING = Decoration.mark({ class: 'cm-wikilink cm-wikilink--missing' })

/**
 * Parsing the whole document is a per-keystroke cost, so the result is cached
 * against the `Text` it came from. `Text` is immutable and shared by identity,
 * which makes it a safe key even if two editors ever exist at once.
 */
let cachedDoc: Text | null = null
let cachedLinks: readonly WikiLink[] = []

function linksOf(doc: Text): readonly WikiLink[] {
  if (doc !== cachedDoc) {
    cachedDoc = doc
    cachedLinks = parseNoteMarkup(doc.toString()).links
  }

  return cachedLinks
}

export interface LinkRange {
  link: WikiLink
  /** Document offsets of the whole `[[...]]`. */
  from: number
  to: number
}

/**
 * Exported, and taking the document rather than the view, so the part with the
 * arithmetic in it -- line-and-column to document offset -- is reachable from a
 * test without a DOM. Same reasoning as `buildMarkdownDecorations`.
 */
export function rangesOf(doc: Text): LinkRange[] {
  const ranges: LinkRange[] = []

  for (const link of linksOf(doc)) {
    // A stale cache would be a crash rather than a wrong colour, and the doc
    // can legitimately be mid-update when a handler asks.
    if (link.line > doc.lines) continue

    const line = doc.line(link.line)
    ranges.push({ link, from: line.from + link.start, to: line.from + link.end })
  }

  return ranges
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const context = view.state.facet(wikiLinkContext)

  for (const { link, from, to } of rangesOf(view.state.doc)) {
    if (!view.visibleRanges.some((range) => from <= range.to && to >= range.from)) continue

    const known = context === null ? null : context.resolve(link.target)
    const inner = context !== null && known === null ? MISSING : LINK

    // The brackets are dimmed like every other piece of markup punctuation, so
    // the line still reads as prose while you are editing it.
    builder.add(from, from + 2, PUNCT)
    builder.add(from + 2, to - 2, inner)
    builder.add(to - 2, to, PUNCT)
  }

  return builder.finish()
}

const wikiLinkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      const contextChanged =
        update.startState.facet(wikiLinkContext) !== update.state.facet(wikiLinkContext)

      if (!update.docChanged && !update.viewportChanged && !contextChanged) return
      this.decorations = buildDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/**
 * `inclusive` is the difference between a click and a cursor: a click at the
 * closing bracket's offset landed *after* the link, but a cursor sitting there
 * is still in it as far as anyone pressing a key is concerned.
 */
export function linkAt(doc: Text, position: number, inclusive: boolean): WikiLink | null {
  for (const { link, from, to } of rangesOf(doc)) {
    if (position < from) continue
    if (inclusive ? position <= to : position < to) return link
  }

  return null
}

function follow(view: EditorView, link: WikiLink): boolean {
  const context = view.state.facet(wikiLinkContext)
  if (context === null) return false

  context.follow({ target: link.target, resolved: context.resolve(link.target) })
  return true
}

const followOnClick = EditorView.domEventHandlers({
  click: (event, view) => {
    // Modified clicks belong to the editor: they extend selections and drop
    // extra cursors, and a wiki has no business intercepting either.
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return false
    }

    // A drag that ended on a link is a selection, not a navigation.
    if (!view.state.selection.main.empty) return false

    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position === null) return false

    const link = linkAt(view.state.doc, position, false)
    if (link === null || !follow(view, link)) return false

    event.preventDefault()
    return true
  },
})

function followAtCursor(view: EditorView): boolean {
  const link = linkAt(view.state.doc, view.state.selection.main.head, true)
  return link === null ? false : follow(view, link)
}

export function wikiLinksExtension(context: WikiLinkContext | null): Extension {
  return [
    wikiLinkContext.of(context),
    wikiLinkDecorations,
    followOnClick,
    // `highest` for the same reason Mod-s is, in create-editor.ts: with vim on,
    // vim's own handler sees the key first, and a binding that silently stops
    // working in normal mode is worse than not having one. Harmless at this
    // precedence because `followAtCursor` declines every key it does not want.
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: followAtCursor }])),
  ]
}
