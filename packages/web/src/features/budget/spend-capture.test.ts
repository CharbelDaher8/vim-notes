import { describe, expect, it } from 'vitest'

import { appendSpendLine, looksLikeSpend, parseSpendCommand } from './spend-capture'

const TODAY = '2026-08-06'

const draft = (input: string) => parseSpendCommand(input, TODAY)

describe('parseSpendCommand', () => {
  /**
   * The phrasing this feature was asked for, which the note parser refuses on
   * purpose. The command box can afford to be forgiving; the file gets the
   * canonical form either way.
   */
  it('accepts the way people actually say it', () => {
    expect(draft('i spent 500 on groceries')?.line).toBe('Spent 500 on groceries')
    expect(draft('I spent 500$ on groceries')?.line).toBe('Spent 500$ on groceries')
    expect(draft('spent 12.40 coffee')?.line).toBe('Spent 12.40 coffee')
    expect(draft('spend 12.40 coffee')?.line).toBe('Spent 12.40 coffee')
  })

  it('takes a bare amount with no keyword at all', () => {
    expect(draft('500 groceries')?.line).toBe('Spent 500 groceries')
  })

  it('normalises to something the note parser will read back the same way', () => {
    const result = draft('i spent 500 on groceries')

    expect(result?.entry).toMatchObject({
      amountMinor: 50_000,
      category: 'groceries',
      currency: null,
    })
  })

  it('files against today, keeping a written date as the day it happened', () => {
    const result = draft('spent 25 books 2026-07-15')

    expect(result?.date).toBe(TODAY)
    expect(result?.entry.date).toBe('2026-07-15')
  })

  it('keeps a currency', () => {
    expect(draft('spent €20 wine')?.entry.currency).toBe('EUR')
    expect(draft('spent 20 USD wine')?.entry.currency).toBe('USD')
  })

  it('is null when there is no amount to record', () => {
    expect(draft('spent')).toBeNull()
    expect(draft('i spent all afternoon on the roof')).toBeNull()
    expect(draft('')).toBeNull()
    expect(draft('   ')).toBeNull()
  })
})

describe('looksLikeSpend', () => {
  it('recognises the openings, so a command can be routed', () => {
    expect(looksLikeSpend('spent 5 tea')).toBe(true)
    expect(looksLikeSpend('i spent 5 tea')).toBe(true)
    expect(looksLikeSpend('Spend 5')).toBe(true)
  })

  it('leaves an ordinary search alone', () => {
    expect(looksLikeSpend('architecture')).toBe(false)
    expect(looksLikeSpend('500 groceries')).toBe(false)
  })
})

describe('appendSpendLine', () => {
  const entry = draft('spent 5 tea')

  it('starts a note that does not exist yet', () => {
    expect(appendSpendLine(null, entry!)).toBe('Spent 5 tea\n')
    expect(appendSpendLine('', entry!)).toBe('Spent 5 tea\n')
    expect(appendSpendLine('\n\n', entry!)).toBe('Spent 5 tea\n')
  })

  it('appends to an existing note', () => {
    expect(appendSpendLine('# Thursday\n\nTODO water the plants\n', entry!)).toBe(
      '# Thursday\n\nTODO water the plants\nSpent 5 tea\n',
    )
  })

  /** Or a note gains a blank line every time something is captured. */
  it('does not accumulate blank lines at the end', () => {
    expect(appendSpendLine('# Thursday\n\n\n\n', entry!)).toBe('# Thursday\nSpent 5 tea\n')
    expect(appendSpendLine('# Thursday', entry!)).toBe('# Thursday\nSpent 5 tea\n')
  })
})
