import { assertNotePath, type SpendRecord } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { parseChartBlock, parseChartQuery, type ChartQuery } from './chart-block'
import { resolveChartQuery } from './derived-rows'

const PATH = assertNotePath('journal/2026-08-01.md')

let line = 1
const spend = (
  amountMinor: number,
  category: string,
  on: string | null,
  currency: string | null = null,
): SpendRecord => ({
  amountMinor,
  currency,
  category,
  text: category,
  line: line++,
  date: on,
  path: PATH,
  day: on,
  on,
})

const SPENDS = [
  spend(42_50, 'groceries', '2026-08-01'),
  spend(120_000, 'rent', '2026-08-01'),
  spend(8_00, 'coffee', '2026-08-04'),
  spend(60_00, 'groceries', '2026-07-30'),
  spend(15_00, 'stamps', null),
  spend(90_00, 'wine', '2026-08-02', 'EUR'),
]

const query = (overrides: Partial<ChartQuery> = {}): ChartQuery => ({
  source: 'spend',
  group: 'category',
  since: null,
  until: null,
  category: null,
  ...overrides,
})

describe('parseChartQuery', () => {
  it('is null for a block that carries its own rows', () => {
    expect(parseChartQuery('chart', 'type: pie\na, 1\nb, 2')).toBeNull()
  })

  it('is null for a fence that is not a data block', () => {
    expect(parseChartQuery('ts', 'source: spend')).toBeNull()
  })

  it('reads a full query', () => {
    expect(
      parseChartQuery(
        'chart',
        [
          'type: pie',
          'source: spend',
          'group: month',
          'since: 2026-08-01',
          'until: 2026-08-31',
        ].join('\n'),
      ),
    ).toEqual({
      source: 'spend',
      group: 'month',
      since: '2026-08-01',
      until: '2026-08-31',
      category: null,
    })
  })

  it('defaults the grouping to category', () => {
    expect(parseChartQuery('chart', 'source: spend')).toMatchObject({ group: 'category' })
  })

  it('lowercases a category so it matches what the parser stored', () => {
    expect(parseChartQuery('chart', 'source: spend\ncategory: Groceries')).toMatchObject({
      category: 'groceries',
    })
  })

  it('rejects an unknown source and says what there is', () => {
    const result = parseChartQuery('chart', 'source: stonks')

    expect(result).toMatchObject({ message: expect.stringContaining('spend') })
  })

  it('rejects an unknown grouping', () => {
    expect(parseChartQuery('chart', 'source: spend\ngroup: colour')).toMatchObject({
      message: expect.stringContaining('category'),
    })
  })

  /** `last month` would need a clock, and a block whose meaning drifts by the
   *  day it is read is a much larger promise than this one. */
  it('takes only a literal day', () => {
    expect(parseChartQuery('chart', 'source: spend\nsince: last month')).toMatchObject({
      message: expect.stringContaining('YYYY-MM-DD'),
    })
    expect(parseChartQuery('chart', 'source: spend\nsince: 2026-8-1')).toMatchObject({
      message: expect.stringContaining('YYYY-MM-DD'),
    })
  })
})

describe('resolveChartQuery', () => {
  it('groups by category, largest first', () => {
    const rows = resolveChartQuery(query(), SPENDS, 'USD')

    expect(rows.columns).toEqual(['category', 'spent'])
    expect(rows.rows).toEqual([
      ['rent', '1200.00'],
      ['groceries', '102.50'],
      ['stamps', '15.00'],
      ['coffee', '8.00'],
    ])
  })

  it('leaves out what it cannot convert', () => {
    const rows = resolveChartQuery(query(), SPENDS, 'USD')

    expect(rows.rows.map(([category]) => category)).not.toContain('wine')
  })

  it('bounds by date, dropping undated spends', () => {
    const rows = resolveChartQuery(
      query({ since: '2026-08-01', until: '2026-08-31' }),
      SPENDS,
      'USD',
    )

    expect(rows.rows).toEqual([
      ['rent', '1200.00'],
      ['groceries', '42.50'],
      ['coffee', '8.00'],
    ])
  })

  it('narrows to one category', () => {
    const rows = resolveChartQuery(query({ category: 'groceries' }), SPENDS, 'USD')

    expect(rows.rows).toEqual([['groceries', '102.50']])
  })

  it('groups by month, oldest first', () => {
    const rows = resolveChartQuery(query({ group: 'month' }), SPENDS, 'USD')

    expect(rows.columns).toEqual(['month', 'spent'])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]?.[1]).toBe('60.00')
    expect(rows.rows[1]?.[1]).toBe('1250.50')
  })

  it('answers an unmatched query with no rows rather than throwing', () => {
    expect(resolveChartQuery(query({ category: 'yachts' }), SPENDS, 'USD').rows).toEqual([])
  })
})

describe('parseChartBlock with resolved rows', () => {
  const BODY = ['type: pie', 'source: spend', 'title: August'].join('\n')

  it('builds the same spec a literal block would', () => {
    const resolved = resolveChartQuery(query(), SPENDS, 'USD')
    const parsed = parseChartBlock('chart', BODY, resolved)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.spec.type).toBe('pie')
    expect(parsed.spec.title).toBe('August')
    // Six-slice ceiling and the "Other" fold are §14's rules, applied here too
    // because this is the same builder.
    expect(parsed.spec.labels[0]).toBe('rent')
    expect(parsed.spec.series[0]?.values[0]).toBe(1200)
  })

  it('says a query matched nothing rather than "add rows below"', () => {
    const parsed = parseChartBlock('chart', BODY, { columns: ['category', 'spent'], rows: [] })

    expect(parsed).toMatchObject({ ok: false, error: { message: 'Nothing matched this query.' } })
  })

  it('refuses a block that has both a query and its own rows', () => {
    const parsed = parseChartBlock('chart', `${BODY}\ngroceries, 42`, {
      columns: ['category', 'spent'],
      rows: [['a', '1']],
    })

    expect(parsed).toMatchObject({ ok: false, error: { message: expect.stringContaining('both') } })
  })

  it('reports a query with no answer rather than pretending', () => {
    expect(parseChartBlock('chart', BODY)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('loading') },
    })
  })

  it('leaves a literal block completely alone', () => {
    const parsed = parseChartBlock('chart', 'type: bar\nmonth, spent\nJan, 120')

    expect(parsed.ok).toBe(true)
  })
})
