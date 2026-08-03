import { assertNotePath, type NotePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { resolveWikiTarget } from '../../shared/wikilinks'
import { closingAfter, wikiCompletions, wikiQueryBefore } from './wikilink-completion'

const paths = (...values: string[]): NotePath[] => values.map(assertNotePath)

describe('wikiQueryBefore', () => {
  it('finds a link that has only just been opened', () => {
    expect(wikiQueryBefore('see [[')).toBe('')
  })

  it('returns what has been typed so far', () => {
    expect(wikiQueryBefore('see [[arch')).toBe('arch')
  })

  it('takes the innermost brackets when a line has more than one link', () => {
    expect(wikiQueryBefore('[[done]] and [[part')).toBe('part')
  })

  it('keeps a space, because note names have them', () => {
    expect(wikiQueryBefore('[[the graph')).toBe('the graph')
  })

  it.each([
    ['there are no brackets', 'plain prose'],
    ['the link is already closed', '[[done]] and then'],
    ['the cursor is on the line below the brackets', '[[open\nnext line'],
  ])('offers nothing when %s', (_name, text) => {
    expect(wikiQueryBefore(text)).toBeNull()
  })
})

describe('wikiCompletions', () => {
  it('writes a note whose name is unique as a bare name', () => {
    expect(wikiCompletions(paths('projects/vim-notes/architecture.md'))).toEqual([
      { insert: 'architecture', path: 'projects/vim-notes/architecture.md' },
    ])
  })

  it('writes a name two notes share as a path instead', () => {
    expect(wikiCompletions(paths('work/roadmap.md', 'garden/roadmap.md'))).toEqual([
      { insert: 'garden/roadmap', path: 'garden/roadmap.md' },
      { insert: 'work/roadmap', path: 'work/roadmap.md' },
    ])
  })

  it('counts a shared name case-insensitively, as resolution does', () => {
    const [first] = wikiCompletions(paths('a/Roadmap.md', 'b/roadmap.md'))

    expect(first?.insert).toBe('a/Roadmap')
  })

  it('is ordered by path, so the popup does not reshuffle between keystrokes', () => {
    const order = wikiCompletions(paths('z.md', 'a.md', 'm/b.md')).map((entry) => entry.path)

    expect(order).toEqual(['a.md', 'm/b.md', 'z.md'])
  })

  /**
   * The property the whole module exists for, asserted against the real
   * resolver rather than restated. An autocomplete that inserts links which do
   * not resolve is worse than no autocomplete: every suggestion is drawn as a
   * missing note, and it looks like the note is the thing that is wrong.
   */
  it('inserts something that resolves back to the note it came from', () => {
    const vault = paths(
      'inbox.md',
      'work/roadmap.md',
      'garden/roadmap.md',
      'projects/vim-notes/architecture.md',
      'reference/git.markdown',
      'journal/2026-08-01.md',
    )

    for (const { insert, path } of wikiCompletions(vault)) {
      expect(resolveWikiTarget(vault, insert)).toBe(path)
    }
  })
})

describe('closingAfter', () => {
  it('has brackets to step over inside an empty link', () => {
    expect(closingAfter(']] and more')).toBe(2)
  })

  it.each([
    ['nothing follows', ''],
    ['prose follows', ' and more'],
    ['only one bracket follows', '] odd'],
  ])('has none to step over when %s', (_name, after) => {
    expect(closingAfter(after)).toBe(0)
  })
})
