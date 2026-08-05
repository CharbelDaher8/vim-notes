/**
 * A `ChartSpec` turned into elements.
 *
 * Everything interesting already happened in `chart-scene.ts`; this walks the
 * scene and creates nodes. Two rules hold it together.
 *
 * **Nothing is ever built from a string of markup.** Every value from the note
 * reaches the document through `textContent` or `setAttribute`, never through
 * `innerHTML`. That is the same promise the parser makes in a different
 * register: a note that draws a chart must not be a note that injects markup,
 * and the way to keep that promise is to have no code path where it could.
 *
 * **The palette lives in CSS, not here.** A mark carries `data-slot` and
 * paints itself with `currentColor`; `charts.css` maps the slot to a hue, once,
 * for both themes. So this module never mentions a colour, and the light and
 * dark steps cannot drift apart in a place TypeScript would not look.
 */

import { toNumber, type ChartError, type ChartSpec } from './chart-block'
import { buildChartScene, LEGEND_WIDTH, type ChartScene } from './chart-scene'

const SVG = 'http://www.w3.org/2000/svg'

/** Markers get a ring in the surface colour so they stay legible when they overlap. */
const DOT_RADIUS = 4

/** Past this many points a dot on each one is a beaded necklace, not a chart. */
const MAX_DOTS = 40

export function renderChart(spec: ChartSpec, width: number): HTMLElement {
  const figure = element('figure', 'chart')
  figure.dataset.type = spec.type

  if (spec.title !== null && spec.title !== '') {
    figure.append(element('figcaption', 'chart-title', spec.title))
  }

  if (spec.type === 'table') {
    figure.append(renderTable(spec))
    return figure
  }

  const plotWidth = spec.legend === 'right' ? Math.max(160, width - LEGEND_WIDTH) : width
  const scene = buildChartScene(spec, plotWidth)
  if (scene === null) return figure

  const body = element('div', 'chart-body')
  body.dataset.legend = spec.legend

  if (spec.legend === 'top') body.append(renderLegend(scene))
  body.append(renderPlot(scene, spec))
  if (spec.legend !== 'top' && spec.legend !== 'none') body.append(renderLegend(scene))

  figure.append(body)

  /**
   * Every chart carries its own table.
   *
   * Three of the light-mode series colours sit below a 3:1 contrast ratio
   * against the page, which is allowed only where the values are also
   * reachable without reading a colour. Direct labels cover some of that; this
   * covers all of it, and it is the same disclosure a screen reader gets.
   */
  const data = element('details', 'chart-data')
  data.append(element('summary', 'chart-data-toggle', 'Data'))
  data.append(renderTable(spec))
  figure.append(data)

  return figure
}

function renderPlot(scene: ChartScene, spec: ChartSpec): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'chart-plot')
  svg.setAttribute('width', String(scene.width))
  svg.setAttribute('height', String(scene.height))
  svg.setAttribute('viewBox', `0 0 ${String(scene.width)} ${String(scene.height)}`)
  svg.setAttribute('role', 'img')

  const summary = document.createElementNS(SVG, 'title')
  summary.textContent = scene.summary
  svg.append(summary)

  if (scene.figure.kind !== 'pie') {
    const grid = svgGroup('chart-grid')

    for (const tick of scene.ticks) {
      grid.append(
        svgLine('chart-gridline', scene.plot.x, tick.y, scene.plot.x + scene.plot.width, tick.y),
      )
      const label = svgText('chart-tick', scene.plot.x - 6, tick.y + 3.5, tick.label)
      label.setAttribute('text-anchor', 'end')
      grid.append(label)
    }

    for (const category of scene.categories) {
      const label = svgText(
        'chart-category',
        category.x,
        scene.plot.y + scene.plot.height + 15,
        category.text,
      )
      label.setAttribute('text-anchor', 'middle')
      grid.append(label)
    }

    svg.append(grid)

    if (scene.baselineY !== null) {
      svg.append(
        svgLine(
          'chart-baseline',
          scene.plot.x,
          scene.baselineY,
          scene.plot.x + scene.plot.width,
          scene.baselineY,
        ),
      )
    }
  }

  svg.append(renderMarks(scene, spec))

  if (scene.labels.length > 0) {
    const labels = svgGroup('chart-values')
    for (const label of scene.labels) {
      const text = svgText('chart-value', label.x, label.y, label.text)
      text.setAttribute('text-anchor', label.anchor)
      labels.append(text)
    }
    svg.append(labels)
  }

  return svg
}

function renderMarks(scene: ChartScene, spec: ChartSpec): SVGGElement {
  const group = svgGroup('chart-marks')

  if (scene.figure.kind === 'bars') {
    for (const mark of scene.figure.marks) {
      const path = svgPath('chart-bar', mark.path, mark.slot)
      path.append(tooltip(`${mark.label} · ${mark.series}: ${mark.formatted}`))
      group.append(path)
    }
    return group
  }

  if (scene.figure.kind === 'lines') {
    for (const mark of scene.figure.marks) {
      const line = svgPath('chart-line', mark.path, mark.slot)
      line.append(tooltip(mark.series))
      group.append(line)

      if (mark.points.length > MAX_DOTS) continue

      for (const point of mark.points) {
        const dot = document.createElementNS(SVG, 'circle')
        dot.setAttribute('class', 'chart-dot')
        dot.setAttribute('cx', String(point.x))
        dot.setAttribute('cy', String(point.y))
        dot.setAttribute('r', String(DOT_RADIUS))
        dot.dataset.slot = String(mark.slot)
        dot.append(tooltip(`${point.label} · ${mark.series}: ${point.formatted}`))
        group.append(dot)
      }
    }
    return group
  }

  for (const mark of scene.figure.marks) {
    const slice = svgPath('chart-slice', mark.path, mark.slot)
    const share = `${String(Math.round(mark.share * 1000) / 10)}%`
    slice.append(tooltip(`${mark.label}: ${mark.formatted} (${share})`))
    group.append(slice)
  }

  // A single-column pie has one series name that the legend never shows, so
  // the spec's own column name is the only place it appears.
  if (spec.series.length === 1 && spec.series[0]?.name !== undefined) {
    group.setAttribute('aria-label', spec.series[0].name)
  }

  return group
}

function renderLegend(scene: ChartScene): HTMLElement {
  const list = element('ul', 'chart-legend')

  for (const entry of scene.legend.entries) {
    const item = element('li', 'chart-legend-item')
    item.dataset.slot = String(entry.slot)

    const swatch = element('span', 'chart-swatch')
    swatch.setAttribute('aria-hidden', 'true')

    item.append(swatch, element('span', 'chart-legend-name', entry.name))
    list.append(item)
  }

  return list
}

/**
 * The table view, and the whole of `type: table`.
 *
 * A column is right-aligned only when every cell in it is a number, which is
 * also what decides tabular figures: aligning the digits of a column of names
 * gains nothing and makes the text look mechanical.
 */
function renderTable(spec: ChartSpec): HTMLElement {
  const wrapper = element('div', 'chart-table-scroll')
  const table = element('table', 'chart-table')
  const head = element('thead')
  const headRow = element('tr')

  const numeric = spec.columns.map((_, column) =>
    spec.rows.every((row) => toNumber(row[column] ?? '') !== null),
  )

  for (const [index, column] of spec.columns.entries()) {
    const cell = element('th', undefined, column)
    cell.setAttribute('scope', 'col')
    if (numeric[index] === true) cell.classList.add('chart-numeric')
    headRow.append(cell)
  }

  head.append(headRow)
  table.append(head)

  const body = element('tbody')
  for (const row of spec.rows) {
    const tr = element('tr')
    for (const [index, value] of row.entries()) {
      const cell = element('td', undefined, value)
      if (numeric[index] === true) cell.classList.add('chart-numeric')
      tr.append(cell)
    }
    body.append(tr)
  }

  table.append(body)
  wrapper.append(table)
  return wrapper
}

/**
 * What a broken block looks like.
 *
 * It shows the offending line as well as the message, because the block itself
 * is hidden behind this card until the cursor goes back into it -- being told
 * "'n/a' is not a number" without being shown which row said so would mean
 * clicking back in to hunt for it.
 */
export function renderChartError(error: ChartError, body: string): HTMLElement {
  const card = element('div', 'chart-error')
  card.setAttribute('role', 'note')

  card.append(element('p', 'chart-error-message', error.message))

  const line = body.split('\n')[error.line]
  if (error.line >= 0 && line !== undefined && line.trim() !== '') {
    card.append(element('pre', 'chart-error-source', line))
  }

  return card
}

function tooltip(text: string): SVGTitleElement {
  const title = document.createElementNS(SVG, 'title')
  title.textContent = text
  return title
}

function svgGroup(className: string): SVGGElement {
  const group = document.createElementNS(SVG, 'g')
  group.setAttribute('class', className)
  return group
}

function svgPath(className: string, definition: string, slot: number): SVGPathElement {
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('class', className)
  path.setAttribute('d', definition)
  path.dataset.slot = String(slot)
  return path
}

function svgLine(
  className: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SVGLineElement {
  const line = document.createElementNS(SVG, 'line')
  line.setAttribute('class', className)
  line.setAttribute('x1', String(x1))
  line.setAttribute('y1', String(y1))
  line.setAttribute('x2', String(x2))
  line.setAttribute('y2', String(y2))
  return line
}

function svgText(className: string, x: number, y: number, text: string): SVGTextElement {
  const node = document.createElementNS(SVG, 'text')
  node.setAttribute('class', className)
  node.setAttribute('x', String(x))
  node.setAttribute('y', String(y))
  node.textContent = text
  return node
}

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
