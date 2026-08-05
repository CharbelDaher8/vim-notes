// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { parseChartBlock, type ChartError, type ChartSpec } from './chart-block'
import { renderChart, renderChartError } from './render-chart'

function spec(info: string, body: string): ChartSpec {
  const result = parseChartBlock(info, body)
  if (result.ok === false) throw new Error(result.error.message)
  return result.spec
}

function render(info: string, body: string, width = 600): HTMLElement {
  return renderChart(spec(info, body), width)
}

function failure(info: string, body: string): ChartError {
  const result = parseChartBlock(info, body)
  if (result.ok === true) throw new Error('expected a parse error')
  return result.error
}

describe('tables', () => {
  it('draws the header and every row', () => {
    const figure = render('chart table', 'name, status\nDeploy, blocked\nReview, done')

    expect([...figure.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'name',
      'status',
    ])
    expect(figure.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(figure.querySelector('svg')).toBeNull()
  })

  it('right-aligns a column only when every cell in it is a number', () => {
    const figure = render('chart table', 'name, count, note\na, 1, ok\nb, 22, ok')
    const headers = [...figure.querySelectorAll('th')]

    expect(headers[0]?.classList.contains('chart-numeric')).toBe(false)
    expect(headers[1]?.classList.contains('chart-numeric')).toBe(true)
    expect(headers[2]?.classList.contains('chart-numeric')).toBe(false)
  })
})

describe('charts', () => {
  it('draws one mark per value, each carrying its palette slot', () => {
    const figure = render('chart bar', 'month, revenue, costs\nJan, 120, 80\nFeb, 180, 95')
    const bars = [...figure.querySelectorAll('.chart-bar')]

    expect(bars).toHaveLength(4)
    expect(bars.map((bar) => bar.getAttribute('data-slot'))).toEqual(['0', '1', '0', '1'])
  })

  it('gives every mark a tooltip naming its row, series and value', () => {
    const figure = render('chart bar', 'month, revenue\nJan, 120')

    expect(figure.querySelector('.chart-bar title')?.textContent).toBe('Jan · revenue: 120')
  })

  it('draws a line per series with a marker on each point', () => {
    const figure = render('chart line', 'x, a\n1, 5\n2, 6\n3, 7')

    expect(figure.querySelectorAll('.chart-line')).toHaveLength(1)
    expect(figure.querySelectorAll('.chart-dot')).toHaveLength(3)
  })

  it('drops the markers on a dense line rather than beading it', () => {
    const rows = Array.from({ length: 60 }, (_, index) => `${String(index)}, ${String(index)}`)
    const figure = render('chart line', `x, a\n${rows.join('\n')}`)

    expect(figure.querySelectorAll('.chart-line')).toHaveLength(1)
    expect(figure.querySelectorAll('.chart-dot')).toHaveLength(0)
  })

  it('shows a legend for several series and omits it for one', () => {
    const many = render('chart bar', 'month, revenue, costs\nJan, 120, 80')
    const one = render('chart bar', 'month, revenue\nJan, 120')

    expect(
      [...many.querySelectorAll('.chart-legend-name')].map((item) => item.textContent),
    ).toEqual(['revenue', 'costs'])
    expect(one.querySelector('.chart-legend')).toBeNull()
  })

  it('names pie slices in the legend, since the slices are the identities', () => {
    const figure = render('chart pie', 'name, share\nrent, 50\nfood, 30\ntravel, 20')

    expect(figure.querySelectorAll('.chart-slice')).toHaveLength(3)
    expect(
      [...figure.querySelectorAll('.chart-legend-name')].map((item) => item.textContent),
    ).toEqual(['rent', 'food', 'travel'])
  })

  it('carries its own table, so no value is reachable only by colour', () => {
    const figure = render('chart bar', 'month, revenue\nJan, 120\nFeb, 180')
    const table = figure.querySelector('.chart-data table')

    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(figure.querySelector('.chart-data-toggle')?.textContent).toBe('Data')
  })

  it('describes the picture for a screen reader', () => {
    const figure = render('chart bar', 'month, revenue\nJan, 120')

    expect(figure.querySelector('svg')?.getAttribute('role')).toBe('img')
    expect(figure.querySelector('svg > title')?.textContent).toContain('revenue')
  })
})

describe('untrusted text', () => {
  it('puts markup from a note in the document as text, never as markup', () => {
    const figure = render('chart table', 'name, note\n<img src=x onerror=boom>, <b>hi</b>')

    expect(figure.querySelectorAll('img')).toHaveLength(0)
    expect(figure.querySelectorAll('b')).toHaveLength(0)
    expect(figure.textContent).toContain('<img src=x onerror=boom>')
  })

  it('keeps a title and a label as text too', () => {
    const figure = render('chart bar', 'title: <script>a</script>\nname, v\n<b>x</b>, 1')

    expect(figure.querySelectorAll('script')).toHaveLength(0)
    expect(figure.querySelector('.chart-title')?.textContent).toBe('<script>a</script>')
  })
})

describe('errors', () => {
  it('shows the message and the line it happened on', () => {
    const body = 'month, revenue\nJan, 120\nFeb, n/a'
    const card = renderChartError(failure('chart line', body), body)

    expect(card.querySelector('.chart-error-message')?.textContent).toContain('not a number')
    expect(card.querySelector('.chart-error-source')?.textContent).toBe('Feb, n/a')
  })

  it('shows no source line for an error about the block as a whole', () => {
    const body = 'month\nJan'
    const card = renderChartError(failure('chart bar', body), body)

    expect(card.querySelector('.chart-error-message')?.textContent).toContain('two columns')
    expect(card.querySelector('.chart-error-source')).toBeNull()
  })
})
