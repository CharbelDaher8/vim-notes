import { describe, expect, it } from 'vitest'

import { parseChartBlock, parseChartInfo, toNumber, type ChartSpec } from './chart-block'

/** Every test wants the spec or a readable failure, never a union to unwrap. */
function parse(info: string, body: string): ChartSpec {
  const result = parseChartBlock(info, body)
  if (result.ok === false) throw new Error(`expected a spec, got: ${result.error.message}`)
  return result.spec
}

function error(info: string, body: string) {
  const result = parseChartBlock(info, body)
  if (result.ok === true) throw new Error('expected a parse error, got a spec')
  return result.error
}

describe('parseChartInfo', () => {
  it('claims a bare chart fence', () => {
    expect(parseChartInfo('chart')).toEqual({ type: null })
  })

  it('reads the type from the fence', () => {
    expect(parseChartInfo('chart bar')).toEqual({ type: 'bar' })
    expect(parseChartInfo('  chart   pie  ')).toEqual({ type: 'pie' })
  })

  it('leaves every other fence alone', () => {
    expect(parseChartInfo('ts')).toBeNull()
    expect(parseChartInfo('charts')).toBeNull()
    expect(parseChartInfo('')).toBeNull()
    expect(parseChartInfo('chart histogram')).toBeNull()
  })

  it('refuses options in the info string, so there is one place to put them', () => {
    expect(parseChartInfo('chart bar stacked')).toBeNull()
  })
})

describe('data', () => {
  it('reads a csv block', () => {
    const spec = parse('chart bar', 'month, revenue, costs\nJan, 120, 80\nFeb, 180, 95')

    expect(spec.labels).toEqual(['Jan', 'Feb'])
    expect(spec.series).toEqual([
      { name: 'revenue', values: [120, 180] },
      { name: 'costs', values: [80, 95] },
    ])
  })

  it('reads a pipe table identically', () => {
    const piped = parse(
      'chart bar',
      ['| month | revenue | costs |', '| ----- | ------- | ----- |', '| Jan | 120 | 80 |'].join(
        '\n',
      ),
    )
    const csv = parse('chart bar', 'month, revenue, costs\nJan, 120, 80')

    expect(piped.labels).toEqual(csv.labels)
    expect(piped.series).toEqual(csv.series)
  })

  it('does not mistake a csv label containing a pipe for a pipe table', () => {
    const spec = parse('chart bar', 'name, value\na | b, 3')

    expect(spec.labels).toEqual(['a | b'])
    expect(spec.series[0]?.values).toEqual([3])
  })

  it('synthesises column names when the first row is already data', () => {
    const spec = parse('chart bar', 'Jan, 120\nFeb, 180')

    expect(spec.labels).toEqual(['Jan', 'Feb'])
    expect(spec.series[0]?.values).toEqual([120, 180])
  })

  it('ignores blank lines between rows', () => {
    const spec = parse('chart bar', 'month, revenue\n\nJan, 120\n\nFeb, 180\n')

    expect(spec.labels).toEqual(['Jan', 'Feb'])
  })

  it('reads numbers written the way people write them', () => {
    expect(toNumber('1,200')).toBe(1200)
    expect(toNumber('$45.50')).toBe(45.5)
    expect(toNumber('12%')).toBe(12)
    expect(toNumber('-3')).toBe(-3)
    expect(toNumber('1e3')).toBe(1000)
    expect(toNumber('n/a')).toBeNull()
    expect(toNumber('')).toBeNull()
  })

  it('reports the row and the column when a cell is not a number', () => {
    const failure = error('chart line', 'month, revenue\nJan, 120\nFeb, n/a')

    expect(failure.message).toContain("'n/a'")
    expect(failure.message).toContain('revenue')
    expect(failure.line).toBe(2)
  })

  it('reports a ragged row against the header', () => {
    const failure = error('chart bar', 'a, b, c\n1, 2')

    expect(failure.message).toContain('2 cells')
    expect(failure.message).toContain('3')
    expect(failure.line).toBe(1)
  })

  it('needs rows, not just a header', () => {
    expect(error('chart bar', 'month, revenue').message).toContain('nothing to draw')
  })

  it('needs a value column beside the labels', () => {
    expect(error('chart bar', 'month\nJan\nFeb').message).toContain('at least two columns')
  })
})

describe('options', () => {
  it('defaults to a table, which cannot fail on the data', () => {
    const spec = parse('chart', 'name, status\nDeploy, blocked')

    expect(spec.type).toBe('table')
    expect(spec.rows).toEqual([['Deploy', 'blocked']])
  })

  it('takes the type from a header line', () => {
    expect(parse('chart', 'type: pie\na, 1\nb, 2').type).toBe('pie')
  })

  it('refuses a fence and a header line that disagree', () => {
    expect(error('chart bar', 'type: pie\na, 1').message).toContain('Keep one of them')
  })

  it('suggests the nearest key for a typo', () => {
    expect(error('chart bar', 'titel: Hello\na, 1').message).toContain("Did you mean 'title'")
  })

  it('lists the options for a key that is not close to anything', () => {
    expect(error('chart bar', 'colour: red\na, 1').message).toContain('Options are')
  })

  it('refuses the same option twice', () => {
    expect(error('chart bar', 'title: a\ntitle: b\nx, 1').message).toContain('set twice')
  })

  it('plots every column but the first by default', () => {
    const spec = parse('chart line', 'month, revenue, costs\nJan, 120, 80\nFeb, 180, 95')

    expect(spec.series.map((series) => series.name)).toEqual(['revenue', 'costs'])
  })

  it('selects and orders columns with y', () => {
    const spec = parse(
      'chart line',
      'y: costs, revenue\nmonth, revenue, costs, note\nJan, 120, 80, ok',
    )

    expect(spec.series.map((series) => series.name)).toEqual(['costs', 'revenue'])
    expect(spec.columns).toEqual(['month', 'costs', 'revenue'])
    expect(spec.rows).toEqual([['Jan', '80', '120']])
  })

  it('points at y when a text column lands among the numbers', () => {
    const failure = error('chart line', 'month, revenue, note\nJan, 120, ok')

    expect(failure.message).toContain("'ok'")
    expect(failure.message).toContain("'y:'")
  })

  it('names the columns it has when x or y misses', () => {
    const failure = error('chart bar', 'x: quarter\nmonth, revenue\nJan, 120')

    expect(failure.message).toContain("'quarter'")
    expect(failure.message).toContain('month')
    expect(failure.line).toBe(0)
  })

  it('sorts rows by the first value column', () => {
    const spec = parse('chart bar', 'sort: desc\nname, score\na, 1\nb, 9\nc, 5')

    expect(spec.labels).toEqual(['b', 'c', 'a'])
    expect(spec.series[0]?.values).toEqual([9, 5, 1])
    expect(spec.rows).toEqual([
      ['b', '9'],
      ['c', '5'],
      ['a', '1'],
    ])
  })

  it('validates enums and booleans with the allowed values in the message', () => {
    expect(error('chart bar', 'stacked: perhaps\na, 1').message).toContain('true or false')
    expect(error('chart bar', 'legend: sideways\na, 1').message).toContain('bottom')
    expect(error('chart bar', 'format: dollars\na, 1').message).toContain('currency')
    expect(error('chart bar', 'currency: dollars\na, 1').message).toContain('three letters')
  })

  it('shows a legend for more than one series and hides it for one', () => {
    expect(parse('chart bar', 'a, b, c\nx, 1, 2').legend).toBe('bottom')
    expect(parse('chart bar', 'a, b\nx, 1').legend).toBe('none')
    expect(parse('chart bar', 'legend: none\na, b, c\nx, 1, 2').legend).toBe('none')
  })

  it('clamps height to something a note can hold', () => {
    expect(parse('chart bar', 'height: 10\na, 1').height).toBe(80)
    expect(parse('chart bar', 'height: 5000\na, 1').height).toBe(800)
    expect(parse('chart bar', 'height: 300\na, 1').height).toBe(300)
  })
})

describe('series limit', () => {
  it('folds everything past the eighth series into one, rather than inventing a hue', () => {
    const columns = ['label', ...Array.from({ length: 11 }, (_, index) => `s${String(index)}`)]
    const row = ['x', ...Array.from({ length: 11 }, () => '2')]
    const spec = parse('chart bar', `${columns.join(', ')}\n${row.join(', ')}`)

    expect(spec.series).toHaveLength(8)
    expect(spec.series.at(-1)?.name).toBe('Other (4 more)')
    // The four folded columns held 2 each, and every one of them is still in
    // the table view.
    expect(spec.series.at(-1)?.values).toEqual([8])
    expect(spec.columns).toHaveLength(12)
  })
})
