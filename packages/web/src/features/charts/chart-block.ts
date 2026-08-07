/**
 * The data-block language: text in, a validated `ChartSpec` out.
 *
 * The whole feature rests on one rule -- **a data block is parsed and drawn,
 * never executed**. There is no transpile step to TSX or Python and no `eval`
 * anywhere downstream: this module turns text into a plain data structure, and
 * `chart-scene.ts` turns that into coordinates. Notes arrive from a git remote
 * (DECISIONS.md §2) and are therefore not fully trusted input -- the same
 * reasoning that makes `NotePath` reject `..` by hand rather than resolve it
 * (§7). A note that renders a chart must not be a note that runs code.
 *
 * The shape of the language follows from where it lives. A block sits inside a
 * markdown fence, so it has to stay legible as plain text in nvim and in
 * GitHub's web view -- which is why the data rows are either a markdown pipe
 * table or plain CSV, both of which someone can read without this application.
 * Everything configurable is a `key: value` line above the data, so the common
 * case is short and the elaborate case is still one flat list.
 *
 *     ```chart
 *     type: bar
 *     title: Revenue vs costs
 *     stacked: true
 *     month, revenue, costs
 *     Jan, 120, 80
 *     ```
 *
 * Failure is a value, not an exception: `parseChartBlock` returns either a spec
 * or a message and the line it happened on, and the widget draws that message
 * where the chart would have been. A block you are halfway through typing is
 * invalid most of the time, so being told *why* is the entire editing
 * experience.
 */

export type ChartType = 'bar' | 'line' | 'pie' | 'table'

export type ValueFormat = 'plain' | 'compact' | 'percent' | 'currency'

export type LegendPlacement = 'top' | 'bottom' | 'right' | 'none'

export type SortOrder = 'none' | 'asc' | 'desc'

/** One named column of numbers, ready to draw. Empty for `type: table`. */
export interface ChartSeries {
  name: string
  values: number[]
}

export interface ChartSpec {
  type: ChartType
  title: string | null
  /** Row labels -- the x axis for bar and line, the slice names for pie. */
  labels: string[]
  /** The name of the column the labels came from, for the table header. */
  labelColumn: string
  series: ChartSeries[]
  /**
   * The displayed cells exactly as written, including non-numeric ones.
   * `type: table` draws this; the chart types keep it so the same block can be
   * flipped to a table without reparsing.
   */
  columns: string[]
  rows: string[][]
  stacked: boolean
  legend: LegendPlacement
  format: ValueFormat
  /** ISO 4217 code, only meaningful when `format` is `currency`. */
  currency: string
  height: number
}

export interface ChartError {
  message: string
  /** 0-based line within the block body, or -1 when it is about the block. */
  line: number
}

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; error: ChartError }

const CHART_TYPES: ChartType[] = ['bar', 'line', 'pie', 'table']

/**
 * `table` rather than an error, because it is the one type that cannot fail on
 * the data: every cell is text. A bare block therefore always renders
 * something, and naming a chart type is how you ask for more.
 */
const DEFAULT_TYPE: ChartType = 'table'

const DEFAULT_HEIGHT = 220
const MIN_HEIGHT = 80
const MAX_HEIGHT = 800

/**
 * Past this many series the categorical palette runs out, and generating a
 * ninth hue produces a colour that is indistinguishable from an existing one
 * under colour-vision deficiency. The tail folds into "Other" instead.
 */
export const MAX_SERIES = 8

/** Part-to-whole stops being readable at a glance well before the hue limit. */
export const MAX_SLICES = 6

/** The fence info string that claims a block, i.e. the language tag. */
export const CHART_LANGUAGE = 'chart'

/**
 * Is this fence a data block, and did its info string name a type?
 *
 * ```` ```chart ```` and ```` ```chart bar ```` are both ours; ```` ```charts ````
 * and ```` ```ts ```` are not. Returns null for anything that is not a data
 * block so the caller can leave other fences alone.
 */
export function parseChartInfo(info: string): { type: ChartType | null } | null {
  const words = info.trim().split(/\s+/).filter(Boolean)
  const [language, ...rest] = words
  if (language !== CHART_LANGUAGE) return null

  const named = rest[0]
  if (named === undefined) return { type: null }
  if (!isChartType(named)) return null

  // A second word would be an option, and options belong on their own line.
  // Refusing here rather than ignoring it keeps one way to write a block.
  if (rest.length > 1) return null

  return { type: named }
}

/**
 * The option table is data rather than a switch so that the error message for
 * a misspelled key can list the real ones and suggest the nearest.
 */
const OPTION_KEYS = [
  'type',
  'title',
  'x',
  'y',
  'stacked',
  'legend',
  'format',
  'currency',
  'sort',
  'height',
  // The query options. See `parseChartQuery` for what they cost.
  'source',
  'group',
  'since',
  'until',
  'category',
] as const

type OptionKey = (typeof OPTION_KEYS)[number]

/**
 * A block whose rows come from the notes instead of from the fence.
 *
 *     ```chart
 *     type: pie
 *     source: spend
 *     group: category
 *     since: 2026-08-01
 *     ```
 *
 * **This is still parsed and drawn, never executed** -- DECISIONS.md §14's rule
 * survives intact, because a query is a declaration of *what* is wanted and not
 * a program that says how to get it. There is no expression language here: five
 * keys with closed sets of values, every one of them validated below.
 *
 * What it does cost is §14's other property, and it is worth stating plainly:
 * a literal block is legible as data in nvim and in GitHub's web view, and a
 * derived one is not. Reading `source: spend` in a plain-text viewer tells you
 * what the picture was of, not what it said. That is a real regression for a
 * design whose whole pitch is that the data outlives the app -- mitigated only
 * by the fact that the numbers *are* still in the repository, spread across the
 * journal lines the query sums up.
 */
export interface ChartQuery {
  /** Only spends exist so far; the key is named for the ones that might not. */
  source: 'spend'
  group: 'category' | 'month'
  /** Inclusive ISO bounds, or null for unbounded. */
  since: string | null
  until: string | null
  /** Restrict to one category, for a block about a single line of spending. */
  category: string | null
}

const QUERY_SOURCES = ['spend'] as const
const QUERY_GROUPS = ['category', 'month'] as const

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The query a block declares, or null when it is self-contained.
 *
 * Separate from `parseChartBlock` because the caller has to *answer* the query
 * before a spec can exist, and that answer is asynchronous. The split keeps the
 * spec pipeline exactly as it was: the resolved rows are appended to the body
 * as ordinary text, so a derived pie and a literal pie are built by the same
 * code and cannot drift apart -- which is also what gives a derived block its
 * disclosure table for free.
 */
export function parseChartQuery(info: string, body: string): ChartQuery | ChartError | null {
  if (parseChartInfo(info) === null) return null

  const options = readOptions(body)
  const source = options.get('source')
  if (source === undefined) return null

  if (!isOneOf(source.value.toLowerCase(), QUERY_SOURCES)) {
    return {
      message: `Unknown source '${source.value}'. Try: ${QUERY_SOURCES.join(', ')}.`,
      line: source.line,
    }
  }

  const group = options.get('group')
  const grouping = group === undefined ? 'category' : group.value.toLowerCase()
  if (!isOneOf(grouping, QUERY_GROUPS)) {
    return {
      message: `Unknown group '${group?.value ?? ''}'. Try: ${QUERY_GROUPS.join(', ')}.`,
      line: group?.line ?? -1,
    }
  }

  const since = readDate(options.get('since'))
  if (since !== null && 'message' in since) return since

  const until = readDate(options.get('until'))
  if (until !== null && 'message' in until) return until

  const category = options.get('category')

  return {
    source: 'spend',
    group: grouping,
    since: since?.value ?? null,
    until: until?.value ?? null,
    category:
      category === undefined ? (category ?? null) : category.value.trim().toLowerCase() || null,
  }
}

function readDate(option: Option | undefined): { value: string } | ChartError | null {
  if (option === undefined) return null

  const value = option.value.trim()
  // Only a literal day. `last month` and friends would need a clock, and a
  // block whose meaning changes with the date it is read on is a different and
  // much larger promise than this one.
  if (!ISO_DAY.test(value)) {
    return { message: `'${value}' is not a date. Write it as YYYY-MM-DD.`, line: option.line }
  }

  return { value }
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value)
}

/**
 * A line that looks like an option: an identifier, a colon, then anything.
 *
 * The header ends at the first line this does not match, which is what lets
 * the data start without a marker between the two. A data row whose first cell
 * contains a colon (`Rent: paid, 1200`) would be read as an option and then
 * rejected as an unknown key -- an error that says so, rather than a chart
 * quietly missing its first row.
 */
const OPTION_LINE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/

/** A separator row in a pipe table: only dashes, colons, pipes and spaces. */
const PIPE_SEPARATOR = /^[\s|:-]+$/

/**
 * Thousands separators, a currency symbol and a trailing percent are all
 * things people actually type into a table, and none of them mean the cell is
 * text. Stripped before the number is read, never re-derived afterwards --
 * `format` decides how a value is *displayed*, independently of how it was
 * written.
 */
const NUMERIC_NOISE = /[\s,$£€]/g

/** Rows a caller resolved for a `source:` block, in place of the fence's own. */
export interface ResolvedRows {
  columns: string[]
  rows: string[][]
}

export function parseChartBlock(info: string, body: string, resolved?: ResolvedRows): ChartParse {
  const claimed = parseChartInfo(info)
  if (claimed === null) return fail('Not a data block.', -1)

  const header = scanOptions(body)
  if (header.error !== null) return { ok: false, error: header.error }

  const { options, dataStart } = header
  const dataLines = body.split('\n').slice(dataStart)

  const type = resolveType(claimed.type, options)
  if (type.ok === false) return type

  const hasRows = dataLines.some((line) => line.trim() !== '')

  if (options.has('source')) {
    // Rows and a query are two answers to one question, and picking either
    // silently would make the other look broken. Better to say so.
    if (hasRows) return fail('This block has both `source:` and rows. Remove one.', dataStart)

    // The caller has not answered the query. Reachable only through a direct
    // call -- the widget resolves first and shows a placeholder meanwhile.
    if (resolved === undefined) return fail('This block is still loading its data.', -1)

    // An empty result is an answer, not a mistake in the block, so it says so
    // in those terms rather than "no data, add rows below".
    if (resolved.rows.length === 0) return fail('Nothing matched this query.', -1)

    return buildSpec(
      type.value,
      // Every row came from the index rather than from a line of the block, so
      // there is no source line an error could point at.
      { columns: resolved.columns, rows: resolved.rows, rowLines: resolved.rows.map(() => -1) },
      options,
    )
  }

  const table = readTable(dataLines, dataStart)
  if (table.ok === false) return table

  return buildSpec(type.value, table.value, options)
}

interface OptionScan {
  options: Map<OptionKey, Option>
  /** Index of the first line below the header. */
  dataStart: number
  /** The first thing wrong with the header, or null. */
  error: ChartError | null
}

/**
 * The `key: value` header, and where it ends.
 *
 * Shared by `parseChartBlock` and `parseChartQuery` so the two cannot disagree
 * about which lines are options -- the query needs to read `source` out of a
 * block the spec parser may go on to reject for an unrelated reason, so it
 * collects everything it can and reports the first problem rather than
 * stopping at it.
 */
function scanOptions(body: string): OptionScan {
  const lines = body.split('\n')
  const options = new Map<OptionKey, Option>()
  let error: ChartError | null = null

  let cursor = 0
  for (; cursor < lines.length; cursor += 1) {
    const raw = lines[cursor] ?? ''
    // Blank lines above the data are spacing. Blank lines between rows are
    // dropped by `readTable`, which by then owns everything below here.
    if (raw.trim() === '') continue

    const match = OPTION_LINE.exec(raw)
    if (match === null) break

    const key = (match[1] ?? '').toLowerCase()

    if (!isOptionKey(key)) {
      error ??= { message: `Unknown option '${match[1] ?? ''}'.${suggest(key)}`, line: cursor }
      continue
    }
    if (options.has(key)) {
      error ??= { message: `'${key}' is set twice.`, line: cursor }
      continue
    }

    options.set(key, { value: (match[2] ?? '').trim(), line: cursor })
  }

  return { options, dataStart: cursor, error }
}

/** The header alone, for callers that only need the options. */
function readOptions(body: string): Map<OptionKey, Option> {
  return scanOptions(body).options
}

interface Option {
  value: string
  line: number
}

interface Table {
  columns: string[]
  rows: string[][]
  /** Where each row started in the block body, for error messages. */
  rowLines: number[]
}

/**
 * Pipe table or CSV, decided by whether the first non-empty data line contains
 * a pipe. Supporting both is one branch here and saves choosing between a
 * block that reads well in nvim and one that is quick to type.
 */
function readTable(lines: string[], offset: number): Result<Table> {
  const cells: { values: string[]; line: number }[] = []
  // Decided by the header row alone, not by any line containing a pipe: a CSV
  // block with one pipe in one label should not silently reparse as a table
  // with the wrong number of columns.
  const piped = (lines.find((line) => line.trim() !== '') ?? '').includes('|')

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    if (piped && PIPE_SEPARATOR.test(line)) continue

    cells.push({ values: splitRow(line, piped), line: offset + index })
  }

  if (cells.length === 0) return fail('No data. Add rows below the options.', -1)

  const header = cells[0]
  if (header === undefined) return fail('No data. Add rows below the options.', -1)

  /**
   * A header row is assumed unless the first row is already data -- which is
   * knowable, because a header's value cells are names and a data row's are
   * numbers. Without this, the shortest useful block (two columns, no header)
   * would silently lose its first row to the header.
   */
  const headerIsData = header.values.length > 1 && header.values.slice(1).every(isNumeric)

  const columns = headerIsData
    ? header.values.map((_, index) => (index === 0 ? 'label' : `value ${index}`))
    : header.values
  const body = headerIsData ? cells : cells.slice(1)

  if (body.length === 0) return fail('No rows. The header alone has nothing to draw.', header.line)

  const width = columns.length
  const rows: string[][] = []
  const rowLines: number[] = []

  for (const row of body) {
    if (row.values.length !== width) {
      return fail(
        `This row has ${String(row.values.length)} cells; the header has ${String(width)}.`,
        row.line,
      )
    }
    rows.push(row.values)
    rowLines.push(row.line)
  }

  return { ok: true, value: { columns, rows, rowLines } }
}

function splitRow(line: string, piped: boolean): string[] {
  if (!piped) return line.split(',').map((cell) => cell.trim())

  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => cell.trim())
}

function resolveType(
  fromInfo: ChartType | null,
  options: Map<OptionKey, Option>,
): Result<ChartType> {
  const declared = options.get('type')
  if (declared === undefined) return { ok: true, value: fromInfo ?? DEFAULT_TYPE }

  const value = declared.value.toLowerCase()
  if (!isChartType(value)) {
    return fail(`'${declared.value}' is not a chart type. Use ${list(CHART_TYPES)}.`, declared.line)
  }
  if (fromInfo !== null && fromInfo !== value) {
    return fail(
      `The fence says '${fromInfo}' but 'type:' says '${value}'. Keep one of them.`,
      declared.line,
    )
  }

  return { ok: true, value }
}

function buildSpec(type: ChartType, table: Table, options: Map<OptionKey, Option>): ChartParse {
  const labelColumn = options.get('x')
  const xIndex = labelColumn === undefined ? 0 : findColumn(table.columns, labelColumn.value)
  if (xIndex === -1 && labelColumn !== undefined) {
    return fail(
      `No column called '${labelColumn.value}'. This block has ${list(table.columns)}.`,
      labelColumn.line,
    )
  }

  const valueColumns = options.get('y')
  let yIndexes: number[]

  if (valueColumns === undefined) {
    yIndexes = table.columns.map((_, index) => index).filter((index) => index !== xIndex)
  } else {
    yIndexes = []
    for (const name of valueColumns.value.split(',').map((part) => part.trim())) {
      if (name === '') continue
      const index = findColumn(table.columns, name)
      if (index === -1) {
        return fail(
          `No column called '${name}'. This block has ${list(table.columns)}.`,
          valueColumns.line,
        )
      }
      yIndexes.push(index)
    }
    if (yIndexes.length === 0) return fail("'y' names no columns.", valueColumns.line)
  }

  if (yIndexes.length === 0) {
    return fail('A data block needs at least two columns: a label and a value.', -1)
  }

  const sort = readEnum(options, 'sort', ['none', 'asc', 'desc'] as const, 'none')
  if (sort.ok === false) return sort

  const order = sortedOrder(table, xIndex, yIndexes[0] ?? xIndex, sort.value)

  const labels = order.map((row) => table.rows[row]?.[xIndex] ?? '')
  const series: ChartSeries[] = []

  // A table draws its cells as written, so it is the one type that never has
  // to be numeric -- which is what makes it the safe default above.
  if (type !== 'table') {
    for (const column of yIndexes) {
      const values: number[] = []

      for (const row of order) {
        const cell = table.rows[row]?.[column] ?? ''
        const value = toNumber(cell)
        if (value === null) {
          // A block with one text column among the numbers is the usual cause,
          // and naming the numeric ones is the fix -- so the message says so
          // rather than leaving someone to find `y:` in the documentation.
          return fail(
            `'${cell}' in column '${table.columns[column] ?? ''}' is not a number.` +
              " Plot only some columns with 'y:'.",
            table.rowLines[row] ?? -1,
          )
        }
        values.push(value)
      }

      series.push({ name: table.columns[column] ?? '', values })
    }
  }

  let sliceLabels = labels
  let chartSeries = foldSeriesTail(series)

  if (type === 'pie') {
    const pie = buildPie(labels, series, valueColumns?.line ?? -1)
    if (pie.ok === false) return pie
    sliceLabels = pie.value.labels
    chartSeries = [pie.value.series]
  }

  const stacked = readBoolean(options, 'stacked', false)
  if (stacked.ok === false) return stacked

  const legend = readEnum(
    options,
    'legend',
    ['auto', 'top', 'bottom', 'right', 'none'] as const,
    'auto',
  )
  if (legend.ok === false) return legend

  const format = readEnum(
    options,
    'format',
    ['plain', 'compact', 'percent', 'currency'] as const,
    'plain',
  )
  if (format.ok === false) return format

  const height = readHeight(options)
  if (height.ok === false) return height

  const currency = options.get('currency')?.value.toUpperCase() ?? 'USD'
  if (!/^[A-Z]{3}$/.test(currency)) {
    return fail(
      `'${currency}' is not a currency code. Use three letters, like USD or EUR.`,
      options.get('currency')?.line ?? -1,
    )
  }

  const displayed = [xIndex, ...yIndexes]

  return {
    ok: true,
    spec: {
      type,
      title: options.get('title')?.value ?? null,
      labels: sliceLabels,
      labelColumn: table.columns[xIndex] ?? '',
      series: chartSeries,
      columns: displayed.map((index) => table.columns[index] ?? ''),
      rows: order.map((row) => displayed.map((index) => table.rows[row]?.[index] ?? '')),
      stacked: stacked.value,
      // A pie's identities are its slices, not its one column, so it needs the
      // legend that a single-series bar chart does not.
      legend:
        legend.value === 'auto'
          ? (type === 'pie' ? sliceLabels.length : series.length) > 1
            ? 'bottom'
            : 'none'
          : legend.value,
      format: format.value,
      currency,
      height: height.value,
    },
  }
}

/**
 * The three things a pie needs that a bar chart does not.
 *
 * One column, because two pies of the same circle is not a chart; no negative
 * values, because a slice of a whole cannot be less than nothing; and a total
 * above zero, because there is no whole to take a part of otherwise. All three
 * are checked here rather than drawn badly later -- a wedge for a negative
 * number renders as a plausible-looking picture of a false fact, which is the
 * one failure mode worth spending an error message on.
 */
function buildPie(
  labels: string[],
  series: ChartSeries[],
  line: number,
): Result<{ labels: string[]; series: ChartSeries }> {
  const values = series[0]
  if (series.length !== 1 || values === undefined) {
    return fail(
      `A pie shows one column of values, and this block has ${String(series.length)}.` +
        " Name the one to show with 'y:'.",
      line,
    )
  }

  const negative = values.values.findIndex((value) => value < 0)
  if (negative !== -1) {
    return fail(
      `A pie cannot show a negative value, and '${labels[negative] ?? ''}' is one.` +
        ' Use a bar chart.',
      -1,
    )
  }

  if (values.values.reduce((total, value) => total + value, 0) <= 0) {
    return fail('A pie needs at least one value above zero.', -1)
  }

  return { ok: true, value: foldSlices(labels, values) }
}

/**
 * Past six slices a pie stops being readable at a glance, which is the only
 * thing a pie is for. The smallest are folded rather than the last few, since
 * position in the block carries no meaning here -- and the kept slices stay in
 * the order they were written, so the picture does not rearrange itself when a
 * value changes.
 */
function foldSlices(
  labels: string[],
  series: ChartSeries,
): { labels: string[]; series: ChartSeries } {
  if (labels.length <= MAX_SLICES) return { labels, series }

  const kept = labels
    .map((_, index) => index)
    .sort((left, right) => (series.values[right] ?? 0) - (series.values[left] ?? 0))
    .slice(0, MAX_SLICES - 1)
    .sort((left, right) => left - right)

  const keptSet = new Set(kept)
  const folded = labels.map((_, index) => index).filter((index) => !keptSet.has(index))
  const total = folded.reduce((sum, index) => sum + (series.values[index] ?? 0), 0)

  return {
    labels: [...kept.map((index) => labels[index] ?? ''), `Other (${String(folded.length)} more)`],
    series: {
      name: series.name,
      values: [...kept.map((index) => series.values[index] ?? 0), total],
    },
  }
}

/**
 * Series past the eighth become one "Other" series carrying their sum.
 *
 * The alternative is generating a ninth hue, and a generated hue is
 * indistinguishable from one of the first eight under colour-vision
 * deficiency -- so the chart would look complete while being unreadable for
 * roughly one man in twelve. Summing is honest about what it did: the name
 * says so, and every original column is still in the table view.
 */
function foldSeriesTail(series: ChartSeries[]): ChartSeries[] {
  if (series.length <= MAX_SERIES) return series

  const kept = series.slice(0, MAX_SERIES - 1)
  const folded = series.slice(MAX_SERIES - 1)
  const length = folded[0]?.values.length ?? 0

  const values = Array.from({ length }, (_, row) =>
    folded.reduce((total, item) => total + (item.values[row] ?? 0), 0),
  )

  return [...kept, { name: `Other (${String(folded.length)} more)`, values }]
}

function sortedOrder(table: Table, xIndex: number, byIndex: number, order: SortOrder): number[] {
  const indexes = table.rows.map((_, index) => index)
  if (order === 'none') return indexes

  const column = byIndex === xIndex ? xIndex : byIndex
  const numeric = table.rows.every((row) => isNumeric(row[column] ?? ''))
  const direction = order === 'asc' ? 1 : -1

  return indexes.sort((left, right) => {
    const a = table.rows[left]?.[column] ?? ''
    const b = table.rows[right]?.[column] ?? ''
    if (numeric) return ((toNumber(a) ?? 0) - (toNumber(b) ?? 0)) * direction
    return a.localeCompare(b) * direction
  })
}

function readHeight(options: Map<OptionKey, Option>): Result<number> {
  const option = options.get('height')
  if (option === undefined) return { ok: true, value: DEFAULT_HEIGHT }

  const value = Number(option.value)
  if (!Number.isFinite(value)) {
    return fail(`'${option.value}' is not a number of pixels.`, option.line)
  }

  return { ok: true, value: Math.min(Math.max(Math.round(value), MIN_HEIGHT), MAX_HEIGHT) }
}

function readBoolean(
  options: Map<OptionKey, Option>,
  key: OptionKey,
  fallback: boolean,
): Result<boolean> {
  const option = options.get(key)
  if (option === undefined) return { ok: true, value: fallback }

  const value = option.value.toLowerCase()
  if (value === 'true' || value === 'yes') return { ok: true, value: true }
  if (value === 'false' || value === 'no') return { ok: true, value: false }

  return fail(`'${key}' takes true or false, not '${option.value}'.`, option.line)
}

function readEnum<T extends string>(
  options: Map<OptionKey, Option>,
  key: OptionKey,
  allowed: readonly T[],
  fallback: T,
): Result<T> {
  const option = options.get(key)
  if (option === undefined) return { ok: true, value: fallback }

  const value = option.value.toLowerCase() as T
  if (!allowed.includes(value)) {
    return fail(`'${key}' takes ${list(allowed)}, not '${option.value}'.`, option.line)
  }

  return { ok: true, value }
}

function findColumn(columns: string[], name: string): number {
  const wanted = name.trim().toLowerCase()
  return columns.findIndex((column) => column.trim().toLowerCase() === wanted)
}

export function toNumber(cell: string): number | null {
  const cleaned = cell.replace(NUMERIC_NOISE, '').replace(/%$/, '')
  if (cleaned === '' || cleaned === '-') return null

  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

function isNumeric(cell: string): boolean {
  return toNumber(cell) !== null
}

function isChartType(value: string): value is ChartType {
  return (CHART_TYPES as string[]).includes(value)
}

function isOptionKey(value: string): value is OptionKey {
  return (OPTION_KEYS as readonly string[]).includes(value)
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`
}

/**
 * One edit is enough to catch the mistakes that actually happen -- `titel`,
 * `hight`, `stacke` -- without claiming `x` meant `y`.
 *
 * Transposition counts as one edit, which plain Levenshtein does not: swapping
 * two neighbouring letters is the single most common way to mistype a word,
 * and `titel` for `title` is exactly that. Counted as two edits it would fall
 * outside the threshold and the suggestion would never fire on the case it was
 * written for.
 */
function suggest(key: string): string {
  const near = OPTION_KEYS.find((candidate) => isOneEditApart(candidate, key))
  return near === undefined ? ` Options are ${list(OPTION_KEYS)}.` : ` Did you mean '${near}'?`
}

function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false

  const head = commonPrefix(a, b)
  if (head === Math.min(a.length, b.length)) return true

  // One substitution, or one insertion on whichever side is longer.
  const rest = (left: string, right: string) => left.slice(head + 1) === right.slice(head + 1)
  if (a.length === b.length && rest(a, b)) return true
  if (a.length > b.length && a.slice(head + 1) === b.slice(head)) return true
  if (b.length > a.length && b.slice(head + 1) === a.slice(head)) return true

  // One transposition of neighbours.
  return (
    a.length === b.length &&
    a[head] === b[head + 1] &&
    a[head + 1] === b[head] &&
    a.slice(head + 2) === b.slice(head + 2)
  )
}

function commonPrefix(a: string, b: string): number {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1
  return index
}

type Result<T> = { ok: true; value: T } | { ok: false; error: ChartError }

function fail(message: string, line: number): { ok: false; error: ChartError } {
  return { ok: false, error: { message, line } }
}
