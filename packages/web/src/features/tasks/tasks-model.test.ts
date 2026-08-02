import { assertNotePath, type AnnotationRecord } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { addDays, bucketOf, dueChip, formatDay, groupAnnotations, todayIso } from './tasks-model'

const TODAY = '2026-08-02'

function record(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    kind: 'todo',
    text: 'ship it',
    line: 1,
    done: null,
    due: null,
    path: assertNotePath('journal/2026-08-02.md'),
    day: '2026-08-02',
    ...overrides,
  }
}

const ALL = { kind: 'all', includeDone: false } as const

describe('bucketOf', () => {
  it('treats a passed due date as overdue whatever day it was written on', () => {
    const item = record({ due: '2026-07-20', day: '2026-08-02' })

    expect(bucketOf(item, TODAY)).toBe('overdue')
  })

  it('does not call a dateless line from last month overdue', () => {
    // Nobody promised a date. It is backlog, and flagging it red would make
    // the red heading meaningless for the items that did have a promise.
    const item = record({ due: null, day: '2026-07-04' })

    expect(bucketOf(item, TODAY)).toBe('earlier')
  })

  it('files a due date ahead of a journal day', () => {
    const item = record({ due: '2026-08-09', day: '2026-07-04' })

    expect(bucketOf(item, TODAY)).toBe('upcoming')
  })

  it("counts today's journal, and anything due today, as today", () => {
    expect(bucketOf(record({ day: TODAY }), TODAY)).toBe('today')
    expect(bucketOf(record({ day: '2026-01-01', due: TODAY }), TODAY)).toBe('today')
  })

  it('has a home for a task in a note that is not a journal', () => {
    expect(bucketOf(record({ day: null, due: null }), TODAY)).toBe('undated')
  })

  it('reports a ticked item as done regardless of its dates', () => {
    expect(bucketOf(record({ done: true, due: '2020-01-01' }), TODAY)).toBe('done')
  })
})

describe('groupAnnotations', () => {
  it('orders the panel urgent first, then the backlog newest first', () => {
    const groups = groupAnnotations(
      [
        record({ line: 1, due: null, day: '2026-07-04' }),
        record({ line: 2, due: '2026-07-30' }),
        record({ line: 3, day: TODAY }),
        record({ line: 4, due: '2026-08-09' }),
        record({ line: 5, due: null, day: '2026-07-28' }),
        record({ line: 6, due: null, day: null, path: assertNotePath('inbox.md') }),
      ],
      TODAY,
      ALL,
    )

    expect(groups.map((group) => group.bucket)).toEqual([
      'overdue',
      'today',
      'upcoming',
      'earlier',
      'earlier',
      'undated',
    ])
    expect(groups[3]?.items[0]?.line).toBe(5)
    expect(groups[4]?.items[0]?.line).toBe(1)
  })

  it('sorts overdue items oldest first, because that is the reading order', () => {
    const groups = groupAnnotations(
      [record({ line: 1, due: '2026-07-31' }), record({ line: 2, due: '2026-06-01' })],
      TODAY,
      ALL,
    )

    expect(groups[0]?.items.map((item) => item.line)).toEqual([2, 1])
  })

  it('hides ticked items unless they are asked for', () => {
    const items = [record({ line: 1, done: true }), record({ line: 2, done: false })]

    expect(groupAnnotations(items, TODAY, ALL)).toHaveLength(1)

    const withDone = groupAnnotations(items, TODAY, { kind: 'all', includeDone: true })
    expect(withDone.map((group) => group.bucket)).toEqual(['today', 'done'])
  })

  it('keeps a line that was never asked the question in the list', () => {
    // `done: null` is "no checkbox", not "finished".
    const groups = groupAnnotations([record({ done: null })], TODAY, ALL)

    expect(groups[0]?.items).toHaveLength(1)
  })

  it('filters by kind', () => {
    const items = [record({ line: 1 }), record({ line: 2, kind: 'reminder' })]

    const groups = groupAnnotations(items, TODAY, { kind: 'reminder', includeDone: false })

    expect(groups.flatMap((group) => group.items).map((item) => item.line)).toEqual([2])
  })

  it('splits upcoming into one group per day, soonest first', () => {
    const groups = groupAnnotations(
      [record({ line: 1, due: '2026-08-20' }), record({ line: 2, due: '2026-08-03' })],
      TODAY,
      ALL,
    )

    expect(groups.map((group) => group.label)).toEqual(['Tomorrow', groups[1]?.label])
    expect(groups[0]?.items[0]?.line).toBe(2)
  })
})

describe('dates', () => {
  it('names the three days people do not want to decode', () => {
    expect(formatDay(TODAY, TODAY)).toBe('Today')
    expect(formatDay('2026-08-03', TODAY)).toBe('Tomorrow')
    expect(formatDay('2026-08-01', TODAY)).toBe('Yesterday')
  })

  it('crosses a month boundary without arithmetic errors', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('reads today from local time rather than UTC', () => {
    // 00:30 local on the 2nd is still the 2nd, even where that is the 1st in UTC.
    expect(todayIso(new Date(2026, 7, 2, 0, 30))).toBe('2026-08-02')
  })

  it('describes a reminder as overdue, today or upcoming', () => {
    expect(dueChip(record({ due: '2026-07-30' }), TODAY)?.bucket).toBe('overdue')
    expect(dueChip(record({ due: TODAY }), TODAY)).toMatchObject({
      bucket: 'today',
      description: 'Due today',
    })
    expect(dueChip(record({ due: '2026-08-03' }), TODAY)).toMatchObject({
      bucket: 'upcoming',
      description: 'Due Tomorrow',
    })
  })

  it('has no chip for an item nobody put a date on', () => {
    expect(dueChip(record({ due: null }), TODAY)).toBeNull()
  })
})
