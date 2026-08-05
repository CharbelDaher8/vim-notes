/**
 * Swapping a data block for its picture, and back again.
 *
 * There is no preview pane in this application -- a note is the markdown you
 * are editing, decorated in place (`markdown-decorations.ts`). So a chart is
 * not "rendered output" somewhere else; it is a block widget that stands in
 * for the fence while the cursor is elsewhere, and gets out of the way the
 * moment the cursor lands inside it. Editing a chart means editing the text
 * that makes it, which is the same rule the rest of the editor follows.
 *
 * **This has to be a `StateField`, not a `ViewPlugin`.** Decorations that
 * change the vertical layout -- block widgets, and replacements spanning a
 * line break -- are not allowed from a view plugin, because the editor needs
 * them before it measures. `markdown-decorations.ts` is a plugin and can stay
 * one; it only ever styles what is already there.
 *
 * The widget re-renders when its **text** changes and at no other time. That
 * is what `eq` is for here: the field recomputes on every keystroke and every
 * cursor move, so without it a chart would be rebuilt from scratch while you
 * typed a sentence three paragraphs below it.
 */

import { StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

import { parseChartBlock, parseChartInfo } from './chart-block'
import { renderChart, renderChartError } from './render-chart'

import './charts.css'

export interface ChartBlock {
  /** Start of the opening fence line. */
  from: number
  /** End of the closing fence line. */
  to: number
  info: string
  body: string
  /** Document line number the body starts on, for mapping parse errors back. */
  bodyLine: number
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

/**
 * Every closed data block in the document.
 *
 * An *unclosed* fence is deliberately not one. Typing the opening line of a
 * block would otherwise make everything below it -- the rest of the note --
 * disappear into a widget until the closing fence was typed.
 */
export function findChartBlocks(doc: Text): ChartBlock[] {
  const blocks: ChartBlock[] = []

  let open: { marker: string; from: number; info: string; bodyLine: number } | null = null
  let body: string[] = []

  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    const match = FENCE.exec(line.text)

    if (match === null) {
      if (open !== null) body.push(line.text)
      continue
    }

    const marker = match[2] ?? ''

    if (open === null) {
      const info = (match[3] ?? '').trim()
      // Fences we do not claim still have to be tracked, or a ``` inside a
      // shell snippet would look like the start of a chart.
      open = { marker, from: line.from, info, bodyLine: number + 1 }
      body = []
      continue
    }

    // A closing fence is the same character, at least as long as the opener.
    if (marker[0] !== open.marker[0] || marker.length < open.marker.length) {
      body.push(line.text)
      continue
    }

    if (parseChartInfo(open.info) !== null) {
      blocks.push({
        from: open.from,
        to: line.to,
        info: open.info,
        body: body.join('\n'),
        bodyLine: open.bodyLine,
      })
    }

    open = null
    body = []
  }

  return blocks
}

class ChartWidget extends WidgetType {
  constructor(
    private readonly info: string,
    private readonly body: string,
  ) {
    super()
  }

  override eq(other: ChartWidget): boolean {
    return other.info === this.info && other.body === this.body
  }

  /**
   * The editor asks for this before anything is measured, so that scrolling
   * past an unrendered chart does not jump. A wrong guess is corrected on
   * measurement; no guess at all makes the scrollbar lurch.
   */
  override get estimatedHeight(): number {
    const parsed = parseChartBlock(this.info, this.body)
    if (parsed.ok === false) return 64
    return parsed.spec.type === 'table' ? -1 : parsed.spec.height + 76
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div')
    host.className = 'cm-chart'

    let drawnAt = 0

    const draw = () => {
      const available = host.clientWidth > 0 ? host.clientWidth : view.contentDOM.clientWidth
      // The figure's own padding and border come off the drawing, or the plot
      // overflows its card by exactly that much.
      const width = Math.max(240, Math.floor(available) - CARD_INSET)
      drawnAt = width

      const parsed = parseChartBlock(this.info, this.body)
      host.replaceChildren(
        parsed.ok ? renderChart(parsed.spec, width) : renderChartError(parsed.error, this.body),
      )
    }

    draw()

    /**
     * Clicking the picture puts the cursor back in the text that made it.
     *
     * The listener is on the widget's own element rather than in
     * `EditorView.domEventHandlers`, and that is not a style choice: a widget
     * whose `ignoreEvent` returns true is skipped by `eventBelongsToEditor`,
     * so the editor's registered handlers never see a click inside it at all.
     * The choice is between the editor hearing every click -- which breaks the
     * disclosure and text selection inside the table -- and hearing none, and
     * doing this one thing ourselves.
     *
     * The position is asked of the view at click time rather than remembered,
     * because a widget survives edits above it precisely by claiming it has
     * not changed, so anything it stored would be where it used to be.
     */
    host.addEventListener('mousedown', (event) => {
      const target = event.target
      // The disclosure and its table are the widget's own controls.
      if (target instanceof Element && target.closest('.chart-data') !== null) return

      const position = view.posAtDOM(host)
      const fence = view.state.doc.lineAt(position)
      // The start of the fence line does not count as being inside the block,
      // so the cursor goes to the line below: the first option or the first
      // row, which is what someone clicking a chart came to change anyway.
      const into = Math.min(fence.to + 1, view.state.doc.length)

      event.preventDefault()
      view.dispatch({ selection: { anchor: into } })
      view.focus()
    })

    /**
     * Redrawn on resize because the plot is laid out in pixels, not scaled by
     * a viewBox: scaling would stretch the type and the strokes with it, so a
     * chart in the dock and a chart on a phone would not look like the same
     * chart. The threshold keeps a redraw from feeding the observer that
     * triggered it.
     */
    const observer = new ResizeObserver(() => {
      const available = host.clientWidth
      if (available <= 0) return
      if (Math.abs(available - CARD_INSET - drawnAt) < RESIZE_THRESHOLD) return
      draw()
    })

    observer.observe(host)
    observers.set(host, observer)

    return host
  }

  override destroy(dom: HTMLElement): void {
    observers.get(dom)?.disconnect()
    observers.delete(dom)
  }

  /**
   * Clicks inside the widget belong to the widget -- the disclosure that opens
   * the table, and text selection inside it. Putting the cursor back into the
   * source is a job for the click handler below, which knows which parts are
   * interactive; treating every click as a cursor placement would make the
   * table impossible to open.
   */
  override ignoreEvent(): boolean {
    return true
  }
}

/** Padding and border of the `.chart` card, in pixels. Kept with charts.css. */
const CARD_INSET = 30

const RESIZE_THRESHOLD = 8

const observers = new WeakMap<HTMLElement, ResizeObserver>()

function buildChartDecorations(doc: Text, ranges: readonly { from: number; to: number }[]) {
  const decorations: Range<Decoration>[] = []

  for (const block of findChartBlocks(doc)) {
    /**
     * The source comes back the moment the selection touches the block, which
     * is what makes the picture editable: click it, and it is text again.
     *
     * The start of the block is deliberately *not* touching it. A new editor's
     * selection is at position zero, so with an inclusive test a note that
     * opens with a chart would show its source until you moved the cursor --
     * which is the first thing you would see and the wrong thing to show. The
     * end stays inclusive, so putting the cursor on the closing fence does not
     * fold the block under you while you are editing it.
     */
    const touched = ranges.some((range) => range.from <= block.to && range.to > block.from)
    if (touched) continue

    decorations.push(
      Decoration.replace({
        widget: new ChartWidget(block.info, block.body),
        block: true,
      }).range(block.from, block.to),
    )
  }

  return Decoration.set(decorations, true)
}

const chartField = StateField.define<DecorationSet>({
  create: (state) => buildChartDecorations(state.doc, state.selection.ranges),

  update: (value, transaction) => {
    if (!transaction.docChanged && transaction.selection === undefined) {
      return value.map(transaction.changes)
    }
    return buildChartDecorations(transaction.state.doc, transaction.state.selection.ranges)
  },

  provide: (field) => EditorView.decorations.from(field),
})

export function chartBlocks(): Extension {
  return [chartField]
}
