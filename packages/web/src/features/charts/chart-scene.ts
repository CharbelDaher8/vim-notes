/**
 * A `ChartSpec` turned into coordinates, without touching the DOM.
 *
 * Same split as `graph-scene.ts`, for the same reason: every decision the
 * picture depends on is made here rather than in the element-building code, so
 * the interesting rules are reachable from a unit test in an environment with
 * no jsdom. The renderer's job is reduced to "draw these paths at these
 * coordinates".
 *
 * The mark specs are not arbitrary. Bars cap at 24px and let the leftover band
 * be air; the data end is rounded 4px and the baseline end is square; touching
 * fills are separated by a 2px gap in the surface colour rather than a stroke,
 * because a stroke adds ink that is not data. Lines are 2px with markers at
 * least 8px across. Gridlines are solid hairlines -- dashing reads as
 * "projection" when it is just a grid.
 *
 * Two rules about axes are worth stating because they differ on purpose:
 *
 *  - **A bar chart always includes zero.** Bar *length* encodes the value, so a
 *    truncated axis misstates every ratio on the chart.
 *  - **A line chart does not have to.** Line *position* encodes the value and
 *    the subject is the shape of the change, so forcing zero onto a series that
 *    lives between 19.4 and 19.9 flattens the only thing being asked about.
 *
 * Text is measured by estimate rather than by the browser, since this module
 * never sees one. `CHAR_WIDTH` is the average advance of a digit in the UI sans
 * at the axis size; it is used to reserve gutters and to decide whether a label
 * fits, both of which fail gracefully -- a slightly wide gutter, or a label
 * dropped to the tooltip.
 */

import type { ChartSpec, LegendPlacement, ValueFormat } from './chart-block'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface AxisTick {
  value: number
  y: number
  label: string
}

export interface CategoryLabel {
  x: number
  text: string
}

export interface LegendEntry {
  name: string
  slot: number
}

export interface DirectLabel {
  x: number
  y: number
  text: string
  anchor: 'start' | 'middle' | 'end'
}

export interface BarMark {
  path: string
  slot: number
  series: string
  label: string
  value: number
  formatted: string
}

export interface LinePoint {
  x: number
  y: number
  value: number
  formatted: string
  label: string
}

export interface LineMark {
  slot: number
  series: string
  path: string
  points: LinePoint[]
}

export interface SliceMark {
  path: string
  slot: number
  label: string
  value: number
  formatted: string
  /** 0..1 of the total, for the tooltip and the direct label. */
  share: number
}

export type ChartFigure =
  | { kind: 'bars'; marks: BarMark[] }
  | { kind: 'lines'; marks: LineMark[] }
  | { kind: 'pie'; marks: SliceMark[]; center: { x: number; y: number }; radius: number }

export interface ChartScene {
  width: number
  height: number
  plot: Box
  title: string | null
  ticks: AxisTick[]
  categories: CategoryLabel[]
  /** Where value zero sits, when the axis crosses it. */
  baselineY: number | null
  legend: { placement: LegendPlacement; entries: LegendEntry[] }
  labels: DirectLabel[]
  figure: ChartFigure
  /** What a screen reader is told the picture shows. */
  summary: string
}

/** Bars never fill their band: the leftover is what keeps a chart quiet. */
const MAX_BAR = 24

/** The surface gap that separates touching fills, and the bar corner radius. */
const GAP = 2
const CORNER = 4

const AXIS_FONT = 11
const CHAR_WIDTH = 6.1
const CATEGORY_HEIGHT = 20
const PAD_TOP = 10
const PAD_RIGHT = 12
const MIN_GUTTER = 28

/** Beyond this many marks a value on each one is noise, not information. */
const MAX_DIRECT_LABELS = 12

/** A pie slice smaller than this cannot hold a legible share. */
const MIN_LABELLED_SHARE = 0.08

export function buildChartScene(spec: ChartSpec, width: number): ChartScene | null {
  if (spec.type === 'table') return null

  const height = spec.height
  const entries: LegendEntry[] =
    spec.type === 'pie'
      ? spec.labels.map((name, slot) => ({ name, slot }))
      : spec.series.map((series, slot) => ({ name: series.name, slot }))

  const legend = { placement: spec.legend, entries }
  const format = formatter(spec)

  if (spec.type === 'pie') return pieScene(spec, width, height, legend, format)

  const values = spec.stacked ? stackedExtent(spec) : plainExtent(spec)
  const zeroFloor = spec.type === 'bar'
  const scale = niceScale(
    zeroFloor ? Math.min(0, values.min) : values.min,
    zeroFloor ? Math.max(0, values.max) : values.max,
  )

  const tickLabels = scale.values.map((value) => format(value))
  const gutter = Math.max(
    MIN_GUTTER,
    Math.max(...tickLabels.map((label) => label.length)) * CHAR_WIDTH + 10,
  )

  // The title and the legend are HTML around this drawing, not text inside it,
  // so the plot owns the whole box: wrapping a long legend and selecting a
  // title are things the browser does well and SVG text does not.
  const plot: Box = {
    x: gutter,
    y: PAD_TOP,
    width: Math.max(10, width - gutter - PAD_RIGHT),
    height: Math.max(10, height - PAD_TOP - CATEGORY_HEIGHT),
  }

  const toY = (value: number) =>
    plot.y + plot.height * (1 - (value - scale.min) / (scale.max - scale.min))

  const ticks: AxisTick[] = scale.values.map((value, index) => ({
    value,
    y: toY(value),
    label: tickLabels[index] ?? '',
  }))

  const baselineY = scale.min <= 0 && scale.max >= 0 ? toY(0) : null
  const categories = categoryLabels(spec.labels, plot)

  const figure =
    spec.type === 'bar'
      ? barFigure(spec, plot, toY, baselineY ?? toY(scale.min), format)
      : lineFigure(spec, plot, toY, format)

  return {
    width,
    height,
    plot,
    title: spec.title,
    ticks,
    categories,
    baselineY,
    legend,
    labels: figure.labels,
    figure: figure.figure,
    summary: summarise(spec),
  }
}

/**
 * A value on every mark is chaos and goes unread, so direct labels are capped
 * rather than drawn for free -- past `MAX_DIRECT_LABELS` the axis, the legend
 * and the tooltip carry the numbers, and the table view carries all of them.
 */
function barFigure(
  spec: ChartSpec,
  plot: Box,
  toY: (value: number) => number,
  zeroY: number,
  format: (value: number) => string,
): { figure: ChartFigure; labels: DirectLabel[] } {
  const marks: BarMark[] = []
  const labels: DirectLabel[] = []

  const rows = spec.labels.length
  const count = spec.series.length
  const band = plot.width / Math.max(rows, 1)

  const thickness = spec.stacked
    ? Math.min(MAX_BAR, band * 0.62)
    : Math.min(MAX_BAR, Math.max(3, (band * 0.78 - GAP * (count - 1)) / count))

  const groupWidth = spec.stacked ? thickness : thickness * count + GAP * (count - 1)
  const labelEvery = !spec.stacked && rows * count <= MAX_DIRECT_LABELS

  for (let row = 0; row < rows; row += 1) {
    const left = plot.x + band * row + (band - groupWidth) / 2
    const label = spec.labels[row] ?? ''

    // Positives stack up from zero and negatives stack down from it, which is
    // the only reading of a stack that stays true when a series goes negative.
    let up = 0
    let down = 0

    for (const [slot, series] of spec.series.entries()) {
      const value = series.values[row] ?? 0
      const formatted = format(value)

      let x: number
      let top: number
      let bottom: number

      if (spec.stacked) {
        x = left
        const base = value >= 0 ? up : down
        const next = base + value
        top = toY(Math.max(base, next))
        bottom = toY(Math.min(base, next))
        if (value >= 0) up = next
        else down = next
      } else {
        x = left + slot * (thickness + GAP)
        top = value >= 0 ? toY(value) : zeroY
        bottom = value >= 0 ? zeroY : toY(value)
      }

      const outermost = spec.stacked ? isOutermost(spec, row, slot, value) : true
      // The gap belongs between segments, so it comes off the baseline end of
      // every segment that has another one below it.
      const height = Math.max(0, bottom - top - (spec.stacked && !outermost ? GAP : 0))
      if (height <= 0 && value === 0) continue

      marks.push({
        path: barPath(x, top, thickness, Math.max(height, 1), value >= 0, outermost),
        slot,
        series: series.name,
        label,
        value,
        formatted,
      })

      if (labelEvery && thickness >= 14) {
        labels.push({
          x: x + thickness / 2,
          y: value >= 0 ? top - 5 : bottom + AXIS_FONT,
          text: formatted,
          anchor: 'middle',
        })
      }
    }
  }

  return { figure: { kind: 'bars', marks }, labels }
}

/** The last segment on its side of zero -- the only one with a free end. */
function isOutermost(spec: ChartSpec, row: number, slot: number, value: number): boolean {
  const sign = value >= 0
  for (let other = slot + 1; other < spec.series.length; other += 1) {
    const next = spec.series[other]?.values[row] ?? 0
    if (next === 0) continue
    if (next >= 0 === sign) return false
  }
  return true
}

function lineFigure(
  spec: ChartSpec,
  plot: Box,
  toY: (value: number) => number,
  format: (value: number) => string,
): { figure: ChartFigure; labels: DirectLabel[] } {
  const rows = spec.labels.length
  const step = rows > 1 ? plot.width / (rows - 1) : 0
  const toX = (row: number) => (rows > 1 ? plot.x + step * row : plot.x + plot.width / 2)

  const marks: LineMark[] = spec.series.map((series, slot) => {
    const points: LinePoint[] = series.values.map((value, row) => ({
      x: toX(row),
      y: toY(value),
      value,
      formatted: format(value),
      label: spec.labels[row] ?? '',
    }))

    return {
      slot,
      series: series.name,
      path: points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`)
        .join(' '),
      points,
    }
  })

  /**
   * Only the end of each line is labelled, and only while the ends stay apart.
   * Nudging converging labels off their lines detaches them from what they
   * name and reads as noise -- past that point the legend and the tooltip are
   * the honest channel.
   */
  const labels: DirectLabel[] = []
  const ends = marks
    .map((mark) => ({ point: mark.points.at(-1), slot: mark.slot }))
    .filter((end): end is { point: LinePoint; slot: number } => end.point !== undefined)

  const collides = ends.some((end, index) =>
    ends.some(
      (other, otherIndex) => otherIndex > index && Math.abs(other.point.y - end.point.y) < 13,
    ),
  )

  if (!collides && ends.length <= 4) {
    for (const end of ends) {
      labels.push({
        x: end.point.x - 6,
        y: end.point.y - 8,
        text: end.point.formatted,
        anchor: 'end',
      })
    }
  }

  return { figure: { kind: 'lines', marks }, labels }
}

function pieScene(
  spec: ChartSpec,
  width: number,
  height: number,
  legend: { placement: LegendPlacement; entries: LegendEntry[] },
  format: (value: number) => string,
): ChartScene {
  const values = spec.series[0]?.values ?? []
  const total = values.reduce((sum, value) => sum + value, 0)

  const plot: Box = {
    x: 0,
    y: PAD_TOP,
    width: Math.max(10, width),
    height: Math.max(10, height - PAD_TOP * 2),
  }

  const center = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 }
  // The gutter is for the share labels that sit outside the circle; without it
  // they would be clipped by the viewBox rather than by anything meaningful.
  const radius = Math.max(10, Math.min(plot.width / 2 - 56, plot.height / 2 - 6))

  const marks: SliceMark[] = []
  const labels: DirectLabel[] = []
  let placedLeft = -Infinity
  let placedRight = -Infinity
  let angle = -Math.PI / 2

  for (const [slot, value] of values.entries()) {
    const share = total === 0 ? 0 : value / total
    const sweep = share * Math.PI * 2
    const end = angle + sweep

    marks.push({
      path: slicePath(center, radius, angle, end, values.length === 1),
      slot,
      label: spec.labels[slot] ?? '',
      value,
      formatted: format(value),
      share,
    })

    if (share >= MIN_LABELLED_SHARE) {
      const middle = angle + sweep / 2
      const x = center.x + Math.cos(middle) * (radius + 8)
      const y = center.y + Math.sin(middle) * (radius + 8) + 4
      const rightSide = Math.cos(middle) >= 0
      const previous = rightSide ? placedRight : placedLeft

      // Two labels on the same side within a line-height of each other read as
      // one smudge; the smaller slice keeps its value in the tooltip instead.
      if (Math.abs(y - previous) >= 13) {
        labels.push({ x, y, text: `${percent(share)}`, anchor: rightSide ? 'start' : 'end' })
        if (rightSide) placedRight = y
        else placedLeft = y
      }
    }

    angle = end
  }

  return {
    width,
    height,
    plot,
    title: spec.title,
    ticks: [],
    categories: [],
    baselineY: null,
    legend,
    labels,
    figure: { kind: 'pie', marks, center, radius },
    summary: summarise(spec),
  }
}

/**
 * A bar as a path rather than a `<rect rx>`, because only the data end is
 * rounded: a rounded baseline would lift the bar off its axis and make short
 * bars look like they start above zero.
 */
export function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  upward: boolean,
  rounded: boolean,
): string {
  const radius = rounded ? Math.min(CORNER, width / 2, height) : 0
  const left = round(x)
  const right = round(x + width)
  const top = round(y)
  const bottom = round(y + height)

  if (radius <= 0) return `M${left},${top} H${right} V${bottom} H${left} Z`

  if (upward) {
    return (
      `M${left},${bottom} V${round(y + radius)} Q${left},${top} ${round(x + radius)},${top} ` +
      `H${round(x + width - radius)} Q${right},${top} ${right},${round(y + radius)} ` +
      `V${bottom} Z`
    )
  }

  return (
    `M${left},${top} V${round(y + height - radius)} Q${left},${bottom} ${round(x + radius)},${bottom} ` +
    `H${round(x + width - radius)} Q${right},${bottom} ${right},${round(y + height - radius)} ` +
    `V${top} Z`
  )
}

/** A whole-circle "slice" has no wedge to draw, so it is drawn as a circle. */
export function slicePath(
  center: { x: number; y: number },
  radius: number,
  from: number,
  to: number,
  whole: boolean,
): string {
  if (whole || to - from >= Math.PI * 2 - 1e-6) {
    return (
      `M${round(center.x)},${round(center.y - radius)} ` +
      `A${round(radius)},${round(radius)} 0 1 1 ${round(center.x - 0.01)},${round(center.y - radius)} Z`
    )
  }

  const start = { x: center.x + Math.cos(from) * radius, y: center.y + Math.sin(from) * radius }
  const end = { x: center.x + Math.cos(to) * radius, y: center.y + Math.sin(to) * radius }
  const large = to - from > Math.PI ? 1 : 0

  return (
    `M${round(center.x)},${round(center.y)} L${round(start.x)},${round(start.y)} ` +
    `A${round(radius)},${round(radius)} 0 ${String(large)} 1 ${round(end.x)},${round(end.y)} Z`
  )
}

/**
 * Ticks land on 1, 2, 2.5 or 5 times a power of ten, which is what makes an
 * axis readable at a glance: 0 / 250 / 500 / 750 rather than 0 / 233 / 466.
 */
export function niceScale(
  min: number,
  max: number,
  count = 4,
): { min: number; max: number; step: number; values: number[] } {
  let low = Math.min(min, max)
  let high = Math.max(min, max)

  if (!Number.isFinite(low) || !Number.isFinite(high))
    return { min: 0, max: 1, step: 1, values: [0, 1] }
  if (low === high) {
    // A flat series still needs an axis with room above and below the line.
    if (low === 0) return { min: 0, max: 1, step: 0.5, values: [0, 0.5, 1] }
    low = Math.min(0, low)
    high = Math.max(0, high)
    if (low === high) high = low + 1
  }

  const rawStep = (high - low) / Math.max(count, 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  const step = nice * magnitude

  const niceMin = Math.floor(low / step) * step
  const niceMax = Math.ceil(high / step) * step
  const values: number[] = []

  // Accumulating by addition drifts on fractional steps, so each tick is
  // computed from the index instead.
  const steps = Math.round((niceMax - niceMin) / step)
  for (let index = 0; index <= steps; index += 1) {
    // Six decimals, not one: a 0.25 step rounded to a tenth would relabel the
    // axis 0 / 0.3 / 0.5 / 0.8, which is both wrong and ugly.
    values.push(Math.round((niceMin + step * index) * 1e6) / 1e6)
  }

  return { min: niceMin, max: niceMax, step, values }
}

/**
 * Category labels thin out rather than overlap. Dropping every other label is
 * how a dense axis stays readable; rotating them would cost more vertical room
 * than a note-sized chart has.
 */
function categoryLabels(labels: string[], plot: Box): CategoryLabel[] {
  const band = plot.width / Math.max(labels.length, 1)
  const widest = Math.max(...labels.map((label) => label.length), 1) * CHAR_WIDTH
  const every = Math.max(1, Math.ceil((widest + 8) / Math.max(band, 1)))

  return labels
    .map((text, index) => ({ x: plot.x + band * index + band / 2, text, index }))
    .filter((label) => label.index % every === 0)
    .map(({ x, text }) => ({ x, text }))
}

/**
 * The true range of the data, with no zero forced into it. Whether zero
 * belongs on the axis is the caller's decision and differs by chart type --
 * folding it in here would quietly make every line chart start at zero.
 */
function plainExtent(spec: ChartSpec): { min: number; max: number } {
  const values = spec.series.flatMap((series) => series.values)
  return { min: Math.min(...values), max: Math.max(...values) }
}

function stackedExtent(spec: ChartSpec): { min: number; max: number } {
  let min = 0
  let max = 0

  for (let row = 0; row < spec.labels.length; row += 1) {
    let up = 0
    let down = 0
    for (const series of spec.series) {
      const value = series.values[row] ?? 0
      if (value >= 0) up += value
      else down += value
    }
    min = Math.min(min, down)
    max = Math.max(max, up)
  }

  return { min, max }
}

/**
 * How much horizontal room a `legend: right` costs the drawing.
 *
 * Fixed rather than measured because the caller has to subtract it *before*
 * the scene is built, and a scene whose width depended on rendered text would
 * have to be built twice.
 */
export const LEGEND_WIDTH = 132

function summarise(spec: ChartSpec): string {
  const names = spec.series.map((series) => series.name)

  if (spec.type === 'pie') {
    return `Pie chart of ${names[0] ?? 'values'} across ${String(spec.labels.length)} slices: ${spec.labels.join(', ')}.`
  }

  return (
    `${spec.type === 'bar' ? 'Bar' : 'Line'} chart of ${names.join(', ')} ` +
    `across ${String(spec.labels.length)} ${spec.labelColumn || 'rows'}.`
  )
}

/**
 * `percent` formats the *number as written*, so 45 becomes "45%". Multiplying
 * by a hundred the way `Intl`'s percent style does would silently turn a table
 * of percentages into a table of ten-thousands.
 */
export function formatter(spec: ChartSpec): (value: number) => string {
  const format: ValueFormat = spec.format

  if (format === 'currency') {
    const intl = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: spec.currency,
      maximumFractionDigits: 2,
    })
    return (value) => intl.format(value)
  }

  if (format === 'compact') {
    const intl = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    return (value) => intl.format(value)
  }

  const intl = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
  return format === 'percent' ? (value) => `${intl.format(value)}%` : (value) => intl.format(value)
}

function percent(share: number): string {
  const value = share * 100
  return `${value < 1 ? value.toFixed(1) : String(Math.round(value))}%`
}

/** Coordinates carry no meaning past a tenth of a pixel; paths get shorter. */
function round(value: number): number {
  return Math.round(value * 10) / 10
}
