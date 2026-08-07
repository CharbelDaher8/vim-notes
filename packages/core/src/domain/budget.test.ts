import { describe, expect, it } from 'vitest'

import { categoryOf, parseBudgetDeclaration, parseMoney, parseSpendLine } from './budget'
import { parseNoteMarkup } from './note-markup'

const spend = (raw: string) => parseSpendLine(raw, 1)
const spendsOf = (content: string) => parseNoteMarkup(content).spends

describe('parseMoney', () => {
  it('reads a bare number as major units', () => {
    expect(parseMoney('500 groceries')).toMatchObject({ amountMinor: 50_000, currency: null })
  })

  it('reads a fraction without going through a float', () => {
    expect(parseMoney('12.40')?.amountMinor).toBe(1240)
    expect(parseMoney('0.07')?.amountMinor).toBe(7)
    expect(parseMoney('1.1')?.amountMinor).toBe(110)
  })

  it('accumulates exactly, which is the entire reason for minor units', () => {
    const total = ['0.10', '0.20', '0.30'].reduce(
      (sum, text) => sum + (parseMoney(text)?.amountMinor ?? 0),
      0,
    )
    expect(total).toBe(60)
  })

  it('accepts grouped thousands', () => {
    expect(parseMoney('1,234.56')?.amountMinor).toBe(123_456)
    expect(parseMoney('1,000,000')?.amountMinor).toBe(100_000_000)
  })

  it('takes a symbol on either side', () => {
    expect(parseMoney('$500')).toMatchObject({ amountMinor: 50_000, currency: 'USD' })
    expect(parseMoney('500$')).toMatchObject({ amountMinor: 50_000, currency: 'USD' })
    expect(parseMoney('€20')?.currency).toBe('EUR')
    expect(parseMoney('£20')?.currency).toBe('GBP')
  })

  it('takes an upper-case ISO code', () => {
    expect(parseMoney('500 USD rent')).toMatchObject({ amountMinor: 50_000, currency: 'USD' })
    expect(parseMoney('500 CAD')?.currency).toBe('CAD')
  })

  /**
   * The bug this exists to prevent: `gas` is three letters, and reading it as a
   * currency would drop the category silently.
   */
  it('never mistakes a lower-case word for a currency code', () => {
    expect(parseMoney('500 gas')).toMatchObject({ currency: null, rest: 'gas' })
    expect(parseMoney('500 try')).toMatchObject({ currency: null, rest: 'try' })
    expect(parseMoney('500 cad')).toMatchObject({ currency: null, rest: 'cad' })
  })

  it('refuses more than two decimal places rather than rounding a typo', () => {
    expect(parseMoney('12.400')).toBeNull()
    expect(parseMoney('1.005')).toBeNull()
  })

  it('returns the remainder, trimmed', () => {
    expect(parseMoney('$42   coffee with sam')?.rest).toBe('coffee with sam')
    expect(parseMoney('42')?.rest).toBe('')
  })

  it('is null for text that does not begin with money', () => {
    expect(parseMoney('groceries 500')).toBeNull()
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('-20')).toBeNull()
  })
})

describe('categoryOf', () => {
  it('takes the first word', () => {
    expect(categoryOf('groceries')).toBe('groceries')
    expect(categoryOf('Groceries at the market')).toBe('groceries')
  })

  it('steps over words that introduce rather than name, however they stack', () => {
    expect(categoryOf('on groceries')).toBe('groceries')
    expect(categoryOf('for the car')).toBe('car')
    expect(categoryOf('at Whole Foods')).toBe('whole')
    expect(categoryOf('for some new headphones')).toBe('new')
  })

  it('prefers an explicit tag, which is the only way to say two words', () => {
    expect(categoryOf('dinner with sam #eating-out')).toBe('eating-out')
    expect(categoryOf('#rent August')).toBe('rent')
  })

  it('falls back rather than returning empty', () => {
    expect(categoryOf('')).toBe('uncategorised')
    expect(categoryOf('!!!')).toBe('uncategorised')
  })
})

describe('parseSpendLine', () => {
  it('reads the shape from the seed note', () => {
    expect(spend('Spent 500 groceries')).toMatchObject({
      amountMinor: 50_000,
      currency: null,
      category: 'groceries',
      text: 'groceries',
      line: 1,
      date: null,
    })
  })

  it('is case-insensitive and takes a colon', () => {
    expect(spend('spent 42 coffee')?.amountMinor).toBe(4200)
    expect(spend('SPENT: 42 coffee')?.amountMinor).toBe(4200)
  })

  it('takes a list marker, so it sits in a bulleted journal', () => {
    expect(spend('- Spent 12.40 coffee')?.amountMinor).toBe(1240)
    expect(spend('  * Spent 12.40 coffee')?.amountMinor).toBe(1240)
    expect(spend('1. Spent 12.40 coffee')?.amountMinor).toBe(1240)
  })

  it('picks up an explicit date, for logging something after the fact', () => {
    expect(spend('Spent 500 USD rent 2026-08-01')).toMatchObject({
      amountMinor: 50_000,
      currency: 'USD',
      category: 'rent',
      date: '2026-08-01',
    })
  })

  it('rejects a date that is not a day', () => {
    expect(spend('Spent 10 x 2026-02-31')?.date).toBeNull()
  })

  it('is not a spend without an amount', () => {
    expect(spend('Spent')).toBeNull()
    expect(spend('Spent all afternoon on the roof')).toBeNull()
    expect(spend('Spent: ')).toBeNull()
  })

  /** Anchored, or every sentence mentioning the word becomes an expense. */
  it('does not match mid-sentence', () => {
    expect(spend('I spent 500 on groceries')).toBeNull()
    expect(spend('We spent 500')).toBeNull()
  })

  it('refuses a negative amount rather than making a slice a pie cannot draw', () => {
    expect(spend('Spent -20 refund')).toBeNull()
  })
})

describe('parseBudgetDeclaration', () => {
  it('reads an opening balance with its anchor date', () => {
    expect(parseBudgetDeclaration('Balance: 5000 as of 2026-08-01', 3)).toMatchObject({
      kind: 'balance',
      amountMinor: 500_000,
      asOf: '2026-08-01',
      period: null,
      line: 3,
    })
  })

  it('takes a bare date as the anchor too', () => {
    expect(parseBudgetDeclaration('Balance: $5000 2026-08-01', 1)?.asOf).toBe('2026-08-01')
  })

  it('allows an undated balance, and says so with null', () => {
    expect(parseBudgetDeclaration('Balance: 5000', 1)).toMatchObject({
      amountMinor: 500_000,
      asOf: null,
    })
  })

  it('reads income as monthly whether or not the period is written', () => {
    expect(parseBudgetDeclaration('Income: 3000/month', 1)).toMatchObject({
      kind: 'income',
      amountMinor: 300_000,
      period: 'month',
    })
    expect(parseBudgetDeclaration('Income: 3000', 1)?.period).toBe('month')
    expect(parseBudgetDeclaration('Income: 3000 per month', 1)?.period).toBe('month')
  })

  it('keeps the currency when one is given', () => {
    expect(parseBudgetDeclaration('Balance: 5000 USD', 1)?.currency).toBe('USD')
    expect(parseBudgetDeclaration('Income: €3000/month', 1)?.currency).toBe('EUR')
  })

  it('is not a declaration without an amount', () => {
    expect(parseBudgetDeclaration('Balance: unknown', 1)).toBeNull()
    expect(parseBudgetDeclaration('Balancing the books', 1)).toBeNull()
  })
})

describe('parseNoteMarkup, spends', () => {
  it('collects spends with their line numbers', () => {
    const spends = spendsOf(['# August', '', 'Spent 42 groceries', 'Spent 12.40 coffee'].join('\n'))

    expect(spends).toHaveLength(2)
    expect(spends[0]).toMatchObject({ amountMinor: 4200, line: 3 })
    expect(spends[1]).toMatchObject({ amountMinor: 1240, line: 4 })
  })

  /**
   * The property §12 already bought for todos, and it matters more here: a note
   * that documents the syntax would otherwise log money nobody spent.
   */
  it('skips fenced blocks', () => {
    const content = ['Spent 42 real', '```', 'Spent 999 example', '```', 'Spent 8 also real'].join(
      '\n',
    )

    expect(spendsOf(content).map((entry) => entry.amountMinor)).toEqual([4200, 800])
  })

  it('skips a data block holding example rows', () => {
    const content = ['```chart', 'type: pie', 'Spent 999 not a spend', '```'].join('\n')

    expect(spendsOf(content)).toEqual([])
  })

  it('collects declarations separately from spends', () => {
    const markup = parseNoteMarkup(
      ['Balance: 5000 as of 2026-08-01', 'Income: 3000/month', 'Spent 42 groceries'].join('\n'),
    )

    expect(markup.budget.map((entry) => entry.kind)).toEqual(['balance', 'income'])
    expect(markup.spends).toHaveLength(1)
  })

  /** A spend is not a task, and must not reach the todo panel or the graph. */
  it('keeps spends out of the annotation list', () => {
    const markup = parseNoteMarkup('Spent 42 groceries\nTODO buy milk')

    expect(markup.annotations).toHaveLength(1)
    expect(markup.annotations[0]?.kind).toBe('todo')
  })

  it('survives CRLF, which silently emptied this list once before', () => {
    expect(spendsOf('Spent 42 groceries\r\nSpent 8 bus\r\n')).toHaveLength(2)
  })
})
