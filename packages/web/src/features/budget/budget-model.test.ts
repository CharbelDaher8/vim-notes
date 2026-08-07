import { assertNotePath, type BudgetDeclarationRecord, type SpendRecord } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import {
  accountCurrency,
  currentOpening,
  formatMonth,
  monthBounds,
  summariseBudget,
  totalsByCategory,
  totalsByMonth,
  wholeMonthsBetween,
} from './budget-model'

const PATH = assertNotePath('budget.md')

const balance = (
  amountMinor: number,
  asOf: string | null,
  line = 1,
  currency: string | null = null,
): BudgetDeclarationRecord => ({
  kind: 'balance',
  amountMinor,
  currency,
  asOf,
  period: null,
  line,
  path: PATH,
})

const income = (
  amountMinor: number,
  line = 2,
  currency: string | null = null,
): BudgetDeclarationRecord => ({
  kind: 'income',
  amountMinor,
  currency,
  asOf: null,
  period: 'month',
  line,
  path: PATH,
})

let nextLine = 1
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
  line: nextLine++,
  date: on,
  path: PATH,
  day: on,
  on,
})

describe('wholeMonthsBetween', () => {
  it('counts arrivals, not calendar boundaries', () => {
    expect(wholeMonthsBetween('2026-01-15', '2026-08-06')).toBe(6)
    expect(wholeMonthsBetween('2026-01-15', '2026-08-15')).toBe(7)
    expect(wholeMonthsBetween('2026-01-15', '2026-08-16')).toBe(7)
  })

  it('is zero within the first month', () => {
    expect(wholeMonthsBetween('2026-08-01', '2026-08-06')).toBe(0)
    expect(wholeMonthsBetween('2026-08-01', '2026-08-31')).toBe(0)
    expect(wholeMonthsBetween('2026-08-01', '2026-09-01')).toBe(1)
  })

  it('crosses a year end', () => {
    expect(wholeMonthsBetween('2025-11-01', '2026-02-01')).toBe(3)
  })

  it('never goes negative for a future anchor', () => {
    expect(wholeMonthsBetween('2027-01-01', '2026-08-06')).toBe(0)
  })
})

describe('currentOpening', () => {
  it('takes the latest dated balance that has arrived', () => {
    const declarations = [balance(500_000, '2026-01-01', 1), balance(720_000, '2026-08-01', 2)]

    expect(currentOpening(declarations, '2026-08-06')?.amountMinor).toBe(720_000)
  })

  /** Appending supersedes; the old line stays as a record of what was true. */
  it('ignores a balance dated in the future', () => {
    const declarations = [balance(500_000, '2026-01-01', 1), balance(999_000, '2026-12-01', 2)]

    expect(currentOpening(declarations, '2026-08-06')?.amountMinor).toBe(500_000)
  })

  it('breaks a same-day tie with the later line', () => {
    const declarations = [balance(1, '2026-08-01', 1), balance(2, '2026-08-01', 2)]

    expect(currentOpening(declarations, '2026-08-06')?.amountMinor).toBe(2)
  })

  it('falls back to an undated line rather than nothing', () => {
    expect(currentOpening([balance(500_000, null)], '2026-08-06')?.amountMinor).toBe(500_000)
  })

  it('is null when no balance was ever declared', () => {
    expect(currentOpening([income(300_000)], '2026-08-06')).toBeNull()
  })
})

describe('summariseBudget', () => {
  const declarations = [balance(500_000, '2026-08-01', 1), income(300_000, 2)]

  it('folds opening plus accrual minus spending', () => {
    const summary = summariseBudget(
      declarations,
      [spend(42_50, 'groceries', '2026-08-02'), spend(120_000, 'rent', '2026-08-03')],
      '2026-08-06',
    )

    expect(summary).toMatchObject({
      openingMinor: 500_000,
      monthsAccrued: 0,
      accruedIncomeMinor: 0,
      spentMinor: 124_250,
      balanceMinor: 375_750,
      currency: 'USD',
    })
  })

  it('accrues income once a whole month has passed', () => {
    const summary = summariseBudget(declarations, [], '2026-10-01')

    expect(summary).toMatchObject({
      monthsAccrued: 2,
      accruedIncomeMinor: 600_000,
      balanceMinor: 1_100_000,
    })
  })

  /**
   * The bug this exists to prevent: a balance stated on 1 August already has
   * July's spending in it, and deducting July again makes the figure drift
   * further from the truth the longer the journal goes back.
   */
  it('does not deduct spending the opening balance already accounts for', () => {
    const summary = summariseBudget(
      declarations,
      [spend(60_000, 'groceries', '2026-07-20'), spend(10_000, 'bus', '2026-08-02')],
      '2026-08-06',
    )

    expect(summary.spentMinor).toBe(10_000)
    expect(summary.balanceMinor).toBe(490_000)
  })

  it('counts an undated spend, erring towards having less', () => {
    const summary = summariseBudget(declarations, [spend(5_000, 'stamps', null)], '2026-08-06')

    expect(summary.spentMinor).toBe(5_000)
  })

  it('leaves a foreign-currency spend out of the total and says so', () => {
    const summary = summariseBudget(
      [balance(500_000, '2026-08-01', 1, 'USD'), income(300_000, 2)],
      [spend(10_000, 'bus', '2026-08-02'), spend(5_000, 'wine', '2026-08-03', 'EUR')],
      '2026-08-06',
    )

    expect(summary.spentMinor).toBe(10_000)
    expect(summary.foreign).toHaveLength(1)
    expect(summary.caveats).toContainEqual({
      kind: 'foreign-currency',
      count: 1,
      currencies: ['EUR'],
    })
  })

  it('still answers without an opening balance, and flags it', () => {
    const summary = summariseBudget([], [spend(10_000, 'bus', '2026-08-02')], '2026-08-06')

    expect(summary).toMatchObject({ openingMinor: 0, spentMinor: 10_000, balanceMinor: -10_000 })
    expect(summary.caveats).toContainEqual({ kind: 'no-opening-balance' })
    expect(summary.caveats).toContainEqual({ kind: 'no-income' })
  })

  it('does not accrue from an undated balance, and flags that too', () => {
    const summary = summariseBudget([balance(500_000, null), income(300_000)], [], '2026-12-01')

    expect(summary).toMatchObject({ monthsAccrued: 0, accruedIncomeMinor: 0 })
    expect(summary.caveats).toContainEqual({ kind: 'undated-opening-balance' })
  })
})

describe('accountCurrency', () => {
  it('believes a declaration first', () => {
    expect(accountCurrency([balance(1, null, 1, 'GBP')], [spend(1, 'x', null, 'EUR')])).toBe('GBP')
  })

  it('adopts a spend currency only on an outright majority of all spends', () => {
    const spends = [
      spend(1, 'a', null, 'EUR'),
      spend(1, 'b', null, 'EUR'),
      spend(1, 'c', null, 'USD'),
    ]

    expect(accountCurrency([], spends)).toBe('EUR')
  })

  /**
   * The bug this exists to prevent, found by running it: one euro purchase
   * among unmarked entries redenominated the whole budget, which also hid the
   * caveat that reports unconvertible money.
   */
  it('is not redenominated by a single foreign purchase', () => {
    const spends = [
      spend(1, 'rent', null),
      spend(1, 'food', null),
      spend(1, 'bus', null),
      spend(1, 'wine', null, 'EUR'),
    ]

    expect(accountCurrency([], spends)).toBe('USD')
  })

  it('reaches the default only when nothing says anything', () => {
    expect(accountCurrency([], [spend(1, 'a', null)])).toBe('USD')
  })
})

describe('totalsByCategory', () => {
  it('sums per category, largest first, with shares', () => {
    const totals = totalsByCategory(
      [
        spend(10_000, 'rent', '2026-08-01'),
        spend(5_000, 'food', '2026-08-02'),
        spend(5_000, 'rent', '2026-08-03'),
      ],
      'USD',
    )

    expect(totals[0]).toMatchObject({ category: 'rent', totalMinor: 15_000, count: 2, share: 0.75 })
    expect(totals[1]).toMatchObject({ category: 'food', totalMinor: 5_000, share: 0.25 })
  })

  it('excludes what it cannot convert', () => {
    const totals = totalsByCategory(
      [spend(10_000, 'rent', '2026-08-01'), spend(9_000, 'wine', '2026-08-02', 'EUR')],
      'USD',
    )

    expect(totals.map((entry) => entry.category)).toEqual(['rent'])
  })

  it('does not divide by zero on an empty set', () => {
    expect(totalsByCategory([], 'USD')).toEqual([])
  })
})

describe('totalsByMonth', () => {
  it('buckets by month, oldest first', () => {
    const totals = totalsByMonth(
      [
        spend(10_000, 'a', '2026-08-01'),
        spend(5_000, 'b', '2026-07-30'),
        spend(1_000, 'c', '2026-08-29'),
      ],
      'USD',
    )

    expect(totals).toEqual([
      { month: '2026-07', totalMinor: 5_000, count: 1 },
      { month: '2026-08', totalMinor: 11_000, count: 2 },
    ])
  })

  /** Or a six-month chart would move whenever an undated note was edited. */
  it('leaves undated spends out rather than putting them in this month', () => {
    expect(totalsByMonth([spend(10_000, 'a', null)], 'USD')).toEqual([])
  })
})

describe('monthBounds', () => {
  it('finds the last day without knowing month lengths', () => {
    expect(monthBounds('2026-08-06')).toEqual({ since: '2026-08-01', until: '2026-08-31' })
    expect(monthBounds('2026-02-10')).toEqual({ since: '2026-02-01', until: '2026-02-28' })
    expect(monthBounds('2024-02-10')).toEqual({ since: '2024-02-01', until: '2024-02-29' })
    expect(monthBounds('2026-09-30')).toEqual({ since: '2026-09-01', until: '2026-09-30' })
  })
})

describe('formatMonth', () => {
  it('is a readable month and year', () => {
    expect(formatMonth('2026-08')).toMatch(/2026/)
  })

  it('hands back anything it cannot read', () => {
    expect(formatMonth('nonsense')).toBe('nonsense')
  })
})
