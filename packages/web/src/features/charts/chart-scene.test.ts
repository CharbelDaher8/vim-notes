import { describe, expect, it } from 'vitest'

import { parseChartBlock, type ChartSpec } from './chart-block'
import { barPath, buildChartScene, formatter, niceScale, type ChartScene } from './chart-scene'

function spec(info: string, body: string): ChartSpec {
  const result = parseChartBlock(info, body)
  if (result.ok === false) throw new Error(result.error.message)
  return result.spec
}

function scene(info: string, body: string, width = 600): ChartScene {
  const built = buildChartScene(spec(info, body), width)
  if (built === null) throw new Error('expected a scene')
  return built
}

describe('niceScale', () => {
  it('lands ticks on readable numbers', () => {
    expect(niceScale(0, 970).values).toEqual([0, 250, 500, 750, 1000])
    expect(niceScale(0, 8).values).toEqual([0, 2, 4, 6, 8])
  })

  it('keeps fractional steps exact rather than rounding them to a tenth', () => {
    expect(niceScale(0, 1).values).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('gives a flat series an axis to sit on', () => {
    expect(niceScale(5, 5).min).toBe(0)
    expect(niceScale(5, 5).max).toBeGreaterThanOrEqual(5)
    expect(niceScale(0, 0).values).toEqual([0, 0.5, 1])
  })

  it('spans zero when the data does', () => {
    const scale = niceScale(-30, 90)
    expect(scale.min).toBeLessThanOrEqual(-30)
    expect(scale.max).toBeGreaterThanOrEqual(90)
    expect(scale.values).toContain(0)
  })
})

describe('axes', () => {
  it('starts a bar chart at zero even when the data does not', () => {
    const built = scene('chart bar', 'month, revenue\nJan, 940\nFeb, 980')
    expect(built.ticks[0]?.value).toBe(0)
  })

  it('lets a line chart keep its own range, so a flat trend is still visible', () => {
    const built = scene('chart line', 'day, temp\nMon, 19.4\nTue, 19.9')
    expect(built.ticks[0]?.value).toBeGreaterThan(0)
  })

  it('draws a baseline only where the axis crosses zero', () => {
    expect(scene('chart bar', 'a, v\nx, 5\ny, 9').baselineY).not.toBeNull()
    expect(scene('chart line', 'a, v\nx, 500\ny, 900').baselineY).toBeNull()
  })

  it('thins category labels rather than overlapping them', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `2026-01-${String(index + 1)}, ${String(index)}`,
    )
    const built = scene('chart bar', `day, value\n${many.join('\n')}`, 400)

    expect(built.categories.length).toBeLessThan(40)
    expect(built.categories.length).toBeGreaterThan(0)
  })
})

describe('bars', () => {
  it('caps thickness so a band is never filled', () => {
    const built = scene('chart bar', 'a, v\nx, 1\ny, 2', 1200)
    if (built.figure.kind !== 'bars') throw new Error('expected bars')

    // 1200px over two rows is a 600px band; the mark spec caps the bar at 24.
    const widths = built.figure.marks.map((mark) => widthOf(mark.path))
    for (const width of widths) expect(width).toBeLessThanOrEqual(24)
  })

  it('rounds the data end and leaves the baseline square', () => {
    const path = barPath(0, 0, 20, 50, true, true)
    // The rounded end is the top: two quadratic curves up there, none below.
    expect(path.startsWith('M0,50')).toBe(true)
    expect((path.match(/Q/g) ?? []).length).toBe(2)
    expect(barPath(0, 0, 20, 50, true, false)).not.toContain('Q')
  })

  it('stacks positives up and negatives down from zero', () => {
    const built = scene('chart bar', 'stacked: true\nq, a, b\nQ1, 10, -4')
    if (built.figure.kind !== 'bars') throw new Error('expected bars')

    const [positive, negative] = built.figure.marks
    expect(positive).toBeDefined()
    expect(negative).toBeDefined()
    expect(topOf(positive?.path ?? '')).toBeLessThan(built.baselineY ?? 0)
    expect(topOf(negative?.path ?? '')).toBeGreaterThanOrEqual((built.baselineY ?? 0) - 0.5)
  })

  it('labels every bar when there are few and none when there are many', () => {
    expect(scene('chart bar', 'a, v\nx, 1\ny, 2').labels).toHaveLength(2)

    const many = Array.from({ length: 30 }, (_, index) => `r${String(index)}, ${String(index)}`)
    expect(scene('chart bar', `a, v\n${many.join('\n')}`).labels).toHaveLength(0)
  })
})

describe('lines', () => {
  it('draws one path per series through every point', () => {
    const built = scene('chart line', 'month, a, b\nJan, 1, 4\nFeb, 2, 5\nMar, 3, 6')
    if (built.figure.kind !== 'lines') throw new Error('expected lines')

    expect(built.figure.marks).toHaveLength(2)
    expect(built.figure.marks[0]?.points).toHaveLength(3)
    expect(built.figure.marks[0]?.path.startsWith('M')).toBe(true)
    expect((built.figure.marks[0]?.path.match(/L/g) ?? []).length).toBe(2)
  })

  it('drops end labels when the lines converge, rather than stacking them', () => {
    const apart = scene('chart line', 'x, a, b\n1, 0, 100\n2, 10, 90')
    const converged = scene('chart line', 'x, a, b\n1, 0, 100\n2, 50, 50')

    expect(apart.labels.length).toBeGreaterThan(0)
    expect(converged.labels).toHaveLength(0)
  })
})

describe('pie', () => {
  it('sweeps slices in order from twelve o clock', () => {
    const built = scene('chart pie', 'name, share\na, 25\nb, 25\nc, 50')
    if (built.figure.kind !== 'pie') throw new Error('expected pie')

    expect(built.figure.marks).toHaveLength(3)
    expect(built.figure.marks.map((mark) => mark.share)).toEqual([0.25, 0.25, 0.5])
  })

  it('draws a single slice as a whole circle rather than a zero-width wedge', () => {
    const built = scene('chart pie', 'name, share\nall, 10')
    if (built.figure.kind !== 'pie') throw new Error('expected pie')

    expect(built.figure.marks[0]?.path).toContain('A')
    expect(built.figure.marks[0]?.path).not.toContain('L')
  })

  it('labels only slices big enough to read', () => {
    const built = scene('chart pie', 'name, share\nbig, 90\ntiny, 1\nrest, 9')
    expect(built.labels.map((label) => label.text)).toContain('90%')
    expect(built.labels.some((label) => label.text.startsWith('1%'))).toBe(false)
  })

  it('folds the smallest slices past six into one, keeping written order', () => {
    const rows = ['a, 50', 'b, 40', 'c, 30', 'd, 20', 'e, 10', 'f, 5', 'g, 4', 'h, 3']
    const built = spec('chart pie', `name, value\n${rows.join('\n')}`)

    expect(built.labels).toEqual(['a', 'b', 'c', 'd', 'e', 'Other (3 more)'])
    expect(built.series[0]?.values).toEqual([50, 40, 30, 20, 10, 12])
    // Every original row survives in the table view.
    expect(built.rows).toHaveLength(8)
  })

  it('refuses the pies that would draw a false picture', () => {
    const negative = parseChartBlock('chart pie', 'name, v\na, 5\nb, -2')
    const empty = parseChartBlock('chart pie', 'name, v\na, 0')
    const twoColumns = parseChartBlock('chart pie', 'name, a, b\nx, 1, 2')

    expect(negative.ok).toBe(false)
    expect(empty.ok).toBe(false)
    expect(twoColumns.ok).toBe(false)
    if (negative.ok === false) expect(negative.error.message).toContain('negative')
  })
})

describe('formatting and layout', () => {
  it('treats percent as written rather than multiplying by a hundred', () => {
    expect(formatter(spec('chart bar', 'format: percent\na, 45')).call(null, 45)).toBe('45%')
  })

  it('formats currency and compact numbers', () => {
    expect(
      formatter(spec('chart bar', 'format: currency\ncurrency: EUR\na, 1')).call(null, 12),
    ).toContain('12')
    expect(formatter(spec('chart bar', 'format: compact\na, 1')).call(null, 12000)).toBe('12K')
  })

  it('reserves a gutter wide enough for the tick labels it drew', () => {
    const narrow = scene('chart bar', 'a, v\nx, 5')
    const wide = scene('chart bar', 'format: currency\na, v\nx, 5000000')

    expect(wide.plot.x).toBeGreaterThan(narrow.plot.x)
  })

  it('has no scene for a table', () => {
    expect(buildChartScene(spec('chart table', 'a, b\n1, 2'), 600)).toBeNull()
  })

  it('describes itself for a screen reader', () => {
    expect(scene('chart bar', 'month, revenue\nJan, 1').summary).toContain('revenue')
    expect(scene('chart pie', 'name, v\na, 1\nb, 2').summary).toContain('slices')
  })
})

/** The first horizontal run of a bar path is its width. */
function widthOf(path: string): number {
  const xs = [...path.matchAll(/[-\d.]+,[-\d.]+/g)].map((match) => Number(match[0].split(',')[0]))
  return Math.max(...xs) - Math.min(...xs)
}

function topOf(path: string): number {
  const ys = [...path.matchAll(/[-\d.]+,[-\d.]+/g)].map((match) => Number(match[0].split(',')[1]))
  return Math.min(...ys)
}
