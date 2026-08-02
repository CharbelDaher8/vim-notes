import { assertNotePath, type SearchHit, type TreeEntry } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { groupHits, highlightPreview, matchFilenames } from './search-model'

const p = assertNotePath

const hit = (path: string, line: number): SearchHit => ({
  path: p(path),
  line,
  column: 1,
  preview: `line ${line}`,
})

describe('groupHits', () => {
  it('collects consecutive hits per file', () => {
    const groups = groupHits([hit('a.md', 1), hit('a.md', 4), hit('b.md', 2)])

    expect(groups.map((group) => group.path)).toEqual(['a.md', 'b.md'])
    expect(groups[0]?.hits).toHaveLength(2)
  })

  it('handles no hits', () => {
    expect(groupHits([])).toEqual([])
  })
})

describe('highlightPreview', () => {
  const text = (segments: { text: string; match: boolean }[]) =>
    segments.map((segment) => (segment.match ? `[${segment.text}]` : segment.text)).join('')

  it('marks every literal occurrence, case insensitively by default', () => {
    expect(text(highlightPreview('Foo and foo', 'foo'))).toBe('[Foo] and [foo]')
  })

  it('respects case sensitivity', () => {
    expect(text(highlightPreview('Foo and foo', 'foo', { caseSensitive: true }))).toBe(
      'Foo and [foo]',
    )
  })

  it('treats the pattern literally unless regex is asked for', () => {
    expect(text(highlightPreview('a.b axb', 'a.b'))).toBe('[a.b] axb')
    expect(text(highlightPreview('a.b axb', 'a.b', { regex: true }))).toBe('[a.b] [axb]')
  })

  it('leaves the line alone when the regex will not compile', () => {
    expect(highlightPreview('anything', '(unclosed', { regex: true })).toEqual([
      { text: 'anything', match: false },
    ])
  })

  it('does not loop forever on a pattern that matches nothing', () => {
    expect(highlightPreview('abc', 'x*', { regex: true })).toEqual([{ text: 'abc', match: false }])
  })
})

describe('matchFilenames', () => {
  const tree: TreeEntry[] = [
    {
      kind: 'directory',
      path: p('projects'),
      name: 'projects',
      children: [
        {
          kind: 'file',
          path: p('projects/watering.md'),
          name: 'watering.md',
          size: 0,
          modifiedAt: 0,
        },
        { kind: 'file', path: p('projects/notes.md'), name: 'notes.md', size: 0, modifiedAt: 0 },
      ],
    },
    { kind: 'file', path: p('inbox.md'), name: 'inbox.md', size: 0, modifiedAt: 0 },
  ]

  it('finds files by name at any depth', () => {
    expect(matchFilenames(tree, 'water')).toEqual(['projects/watering.md'])
  })

  it('ranks an early name match above a directory-only match', () => {
    expect(matchFilenames(tree, 'projects')).toEqual(['projects/notes.md', 'projects/watering.md'])
  })

  it('is empty for a blank query', () => {
    expect(matchFilenames(tree, '   ')).toEqual([])
  })

  it('honours the limit', () => {
    expect(matchFilenames(tree, '.md', 1)).toHaveLength(1)
  })
})
