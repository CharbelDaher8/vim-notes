/**
 * Markdown styling as view decorations rather than a `HighlightStyle`.
 *
 * The usual route is `syntaxHighlighting(HighlightStyle.define(...))` over the
 * Lezer tree, which is better: it is incremental and it cannot disagree with
 * the parser. It is not available here -- `@codemirror/language` and
 * `@lezer/highlight` are transitive dependencies of `@codemirror/lang-markdown`
 * rather than direct dependencies of this package, so under pnpm's strict
 * layout they do not resolve. See the note in the handover; adding those two
 * deps is the fix, and this module is then ~150 lines to delete.
 *
 * What this does instead: a line scan over the viewport with the fence state
 * carried from the top of the document, emitting stable class names that
 * editor.css owns. It gets one thing the tree approach does not give for free
 * -- the markup punctuation is dimmed rather than coloured, which is what keeps
 * a note readable as prose while you are editing it.
 */
import { type Range, type Text } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view'

const LINE_STYLES = {
  h1: Decoration.line({ class: 'cm-md-heading cm-md-h1' }),
  h2: Decoration.line({ class: 'cm-md-heading cm-md-h2' }),
  h3: Decoration.line({ class: 'cm-md-heading cm-md-h3' }),
  h4: Decoration.line({ class: 'cm-md-heading cm-md-h4' }),
  h5: Decoration.line({ class: 'cm-md-heading cm-md-h5' }),
  h6: Decoration.line({ class: 'cm-md-heading cm-md-h6' }),
  quote: Decoration.line({ class: 'cm-md-quote' }),
  rule: Decoration.line({ class: 'cm-md-rule' }),
  fence: Decoration.line({ class: 'cm-md-fence' }),
  code: Decoration.line({ class: 'cm-md-code-line' }),
  taskDone: Decoration.line({ class: 'cm-md-task-done' }),
} as const

const MARK = {
  punct: Decoration.mark({ class: 'cm-md-punct' }),
  marker: Decoration.mark({ class: 'cm-md-marker' }),
  strong: Decoration.mark({ class: 'cm-md-strong' }),
  em: Decoration.mark({ class: 'cm-md-em' }),
  strike: Decoration.mark({ class: 'cm-md-strike' }),
  code: Decoration.mark({ class: 'cm-md-code' }),
  link: Decoration.mark({ class: 'cm-md-link' }),
  url: Decoration.mark({ class: 'cm-md-url' }),
} as const

const HEADING = /^(#{1,6})\s+/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const QUOTE = /^\s{0,3}(>+)\s?/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/
const TASK = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(\[[ xX]\])(\s+)/

/** Order is priority: earlier patterns claim their range and later ones skip. */
const INLINE: { pattern: RegExp; inner: keyof typeof MARK; delimiter: number }[] = [
  { pattern: /(`+)([^`]+?)\1/g, inner: 'code', delimiter: 1 },
  { pattern: /(\*\*|__)(?=\S)([^\n]*?\S)\1/g, inner: 'strong', delimiter: 1 },
  { pattern: /(~~)(?=\S)([^\n]*?\S)\1/g, inner: 'strike', delimiter: 1 },
]

const EMPHASIS = /(^|[^*\w\\])(\*)([^\s*][^*]*?)(\*)(?!\*)/g
const LINK = /(!?\[)([^\]\n]*)(\]\()([^)\s]+)([^)\n]*)(\))/g
const BARE_URL = /<?(https?:\/\/[^\s<>)]+)>?/g

interface Claimed {
  from: number
  to: number
}

export const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view.state.doc, view.visibleRanges)
    }

    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
      if (!update.docChanged && !update.viewportChanged) return
      this.decorations = buildMarkdownDecorations(update.view.state.doc, update.view.visibleRanges)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

export interface VisibleRange {
  from: number
  to: number
}

/**
 * Takes the document and the visible ranges rather than the view, so the whole
 * scanner can be tested without a DOM. The plugin above is then a three-line
 * adapter, and the regex logic -- which is where the bugs live -- is reachable
 * from a unit test.
 */
export function buildMarkdownDecorations(
  doc: Text,
  visible: readonly VisibleRange[],
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lastVisible = visible.at(-1)?.to ?? 0

  // Fence state has to come from the top of the document, otherwise scrolling
  // into the middle of a code block styles it as prose.
  let fence: string | null = null

  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    if (line.from > lastVisible) break

    const text = line.text
    const fenceMatch = FENCE.exec(text)
    const opensOrCloses = fenceMatch !== null
    const wasInFence = fence !== null

    if (opensOrCloses) {
      const marker = fenceMatch[1] ?? ''
      if (fence === null) fence = marker[0] ?? '`'
      else if (marker.startsWith(fence)) fence = null
    }

    if (!isVisible(line.from, line.to, visible)) continue

    if (opensOrCloses) {
      ranges.push(LINE_STYLES.fence.range(line.from))
      continue
    }

    if (wasInFence) {
      ranges.push(LINE_STYLES.code.range(line.from))
      continue
    }

    decorateLine(ranges, line.from, text)
  }

  return Decoration.set(ranges, true)
}

function decorateLine(ranges: Range<Decoration>[], from: number, text: string): void {
  if (text.trim() === '') return

  const claimed: Claimed[] = []
  const claim = (start: number, end: number) => claimed.push({ from: start, to: end })
  const free = (start: number, end: number) =>
    !claimed.some((range) => start < range.to && end > range.from)

  const heading = HEADING.exec(text)
  if (heading !== null) {
    const level = (heading[1] ?? '#').length
    const style = LINE_STYLES[`h${level}` as 'h1'] ?? LINE_STYLES.h1
    ranges.push(style.range(from))
    push(ranges, from, 0, heading[0].length, MARK.punct)
    claim(0, heading[0].length)
  } else if (RULE.test(text)) {
    ranges.push(LINE_STYLES.rule.range(from))
    return
  } else {
    const quote = QUOTE.exec(text)
    if (quote !== null) {
      // The `>` may be indented by up to three spaces, so its offset is where
      // it actually starts, not the length of everything matched.
      const markerStart = quote[0].indexOf('>')
      const markerEnd = markerStart + (quote[1] ?? '').length

      ranges.push(LINE_STYLES.quote.range(from))
      push(ranges, from, markerStart, markerEnd, MARK.punct)
      claim(0, markerEnd)
    }

    const task = TASK.exec(text)
    if (task !== null) {
      const box = task[2] ?? ''
      const start = (task[1] ?? '').length
      if (box.toLowerCase() === '[x]') ranges.push(LINE_STYLES.taskDone.range(from))
      push(ranges, from, 0, start, MARK.marker)
      push(ranges, from, start, start + box.length, MARK.marker)
      claim(0, start + box.length)
    } else {
      const list = LIST_MARKER.exec(text)
      if (list !== null) {
        const start = (list[1] ?? '').length
        push(ranges, from, start, start + (list[2] ?? '').length, MARK.marker)
        claim(0, start + (list[2] ?? '').length)
      }
    }
  }

  for (const { pattern, inner, delimiter } of INLINE) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (!free(start, end)) continue

      const width = (match[delimiter] ?? '').length
      push(ranges, from, start, start + width, MARK.punct)
      push(ranges, from, start + width, end - width, MARK[inner])
      push(ranges, from, end - width, end, MARK.punct)
      claim(start, end)
    }
  }

  EMPHASIS.lastIndex = 0
  let emphasis: RegExpExecArray | null
  while ((emphasis = EMPHASIS.exec(text)) !== null) {
    const start = emphasis.index + (emphasis[1] ?? '').length
    const end = emphasis.index + emphasis[0].length
    if (!free(start, end)) continue

    push(ranges, from, start, start + 1, MARK.punct)
    push(ranges, from, start + 1, end - 1, MARK.em)
    push(ranges, from, end - 1, end, MARK.punct)
    claim(start, end)
  }

  LINK.lastIndex = 0
  let link: RegExpExecArray | null
  while ((link = LINK.exec(text)) !== null) {
    const start = link.index
    const end = start + link[0].length
    if (!free(start, end)) continue

    // `[` | label | `](` | url + any title | `)` -- the brackets and the
    // closing paren are punctuation, the url is dimmed but still legible.
    let cursor = start + (link[1] ?? '').length
    push(ranges, from, start, cursor, MARK.punct)
    push(ranges, from, cursor, cursor + (link[2] ?? '').length, MARK.link)
    cursor += (link[2] ?? '').length
    push(ranges, from, cursor, cursor + (link[3] ?? '').length, MARK.punct)
    cursor += (link[3] ?? '').length
    push(ranges, from, cursor, end - (link[6] ?? '').length, MARK.url)
    push(ranges, from, end - (link[6] ?? '').length, end, MARK.punct)
    claim(start, end)
  }

  BARE_URL.lastIndex = 0
  let url: RegExpExecArray | null
  while ((url = BARE_URL.exec(text)) !== null) {
    const start = url.index
    const end = start + url[0].length
    if (!free(start, end)) continue

    push(ranges, from, start, end, MARK.link)
    claim(start, end)
  }
}

function push(
  ranges: Range<Decoration>[],
  lineFrom: number,
  start: number,
  end: number,
  decoration: Decoration,
): void {
  // Zero-length mark decorations are rejected by CodeMirror, and the regexes
  // above can legitimately produce empty groups (`[](url)`).
  if (end <= start) return
  ranges.push(decoration.range(lineFrom + start, lineFrom + end))
}

function isVisible(from: number, to: number, visible: readonly VisibleRange[]) {
  return visible.some((range) => from <= range.to && to >= range.from)
}
