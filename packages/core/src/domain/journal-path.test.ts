import { describe, expect, it } from 'vitest'

import { journalPathFor } from './journal-path'
import { assertNotePath, type NotePath } from './note-path'

const paths = (...values: string[]): NotePath[] => values.map(assertNotePath)

describe('journalPathFor', () => {
  it('falls back to journal/ when there are no days to learn from', () => {
    expect(journalPathFor('2026-08-03', paths('inbox.md', 'projects/roadmap.md'))).toBe(
      'journal/2026-08-03.md',
    )
  })

  /**
   * The reason this is inferred rather than hardcoded. `journalDateOf` calls a
   * note a day because of its *name*, so someone filing under `daily/` has a
   * working vault -- and a save that created `journal/` would start a second,
   * parallel run of dailies that never joins the first in the graph.
   */
  it('follows wherever the days already live', () => {
    const vault = paths('daily/2026-08-01.md', 'daily/2026-08-02.md', 'inbox.md')

    expect(journalPathFor('2026-08-03', vault)).toBe('daily/2026-08-03.md')
  })

  it('goes to the root when the days are filed flat', () => {
    expect(journalPathFor('2026-08-03', paths('2026-08-01.md', '2026-08-02.md'))).toBe(
      '2026-08-03.md',
    )
  })

  it('picks the folder most of them are in', () => {
    const vault = paths('journal/2026-07-30.md', 'journal/2026-07-31.md', 'archive/2020-01-01.md')

    expect(journalPathFor('2026-08-03', vault)).toBe('journal/2026-08-03.md')
  })

  it('prefers the shallower folder when two are equally used', () => {
    const vault = paths('journal/2026-08-01.md', 'archive/old/journal/2026-08-02.md')

    expect(journalPathFor('2026-08-03', vault)).toBe('journal/2026-08-03.md')
  })

  /**
   * Not aesthetic. Without a deterministic tie-break the answer depends on the
   * order the tree was walked in, so the same vault saves to `a/` today and
   * `b/` tomorrow, and nobody can reproduce either.
   */
  it('does not depend on the order the vault was listed in', () => {
    const forwards = paths('b/2026-08-01.md', 'a/2026-08-02.md')
    const backwards = paths('a/2026-08-02.md', 'b/2026-08-01.md')

    expect(journalPathFor('2026-08-03', forwards)).toBe(journalPathFor('2026-08-03', backwards))
  })

  it('ignores notes that merely live beside the days', () => {
    const vault = paths('journal/2026-08-01.md', 'journal/index.md', 'journal/todo.md')

    expect(journalPathFor('2026-08-03', vault)).toBe('journal/2026-08-03.md')
  })

  it('is not confused by a date in the middle of a name', () => {
    // `journalDateOf` matches the whole basename, so this is not a day note and
    // its folder must not attract tomorrow's journal.
    const vault = paths('meetings/standup-2026-08-01.md')

    expect(journalPathFor('2026-08-03', vault)).toBe('journal/2026-08-03.md')
  })
})
