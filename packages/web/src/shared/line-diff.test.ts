import { describe, expect, it } from 'vitest'

import { collapseUnchanged, diffLines, diffStats } from './line-diff'

function render(mine: string, theirs: string): string[] {
  return diffLines(mine, theirs).map((row) => {
    const sign = row.kind === 'same' ? ' ' : row.kind === 'added' ? '+' : '-'
    return `${sign}${row.text}`
  })
}

describe('diffLines', () => {
  it('reports nothing for identical text', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nb\nc'))).toEqual({ added: 0, removed: 0 })
  })

  it('isolates a change in the middle', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c'])
  })

  it('handles a pure insertion', () => {
    expect(render('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c'])
  })

  it('handles a pure deletion', () => {
    expect(render('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c'])
  })

  it('numbers lines independently on each side', () => {
    const rows = diffLines('a\nb\nc', 'a\nc')

    expect(rows).toEqual([
      { kind: 'same', text: 'a', mineLine: 1, theirsLine: 1 },
      { kind: 'removed', text: 'b', mineLine: 2 },
      { kind: 'same', text: 'c', mineLine: 3, theirsLine: 2 },
    ])
  })

  it('treats two files with nothing in common as a full replacement', () => {
    expect(render('a\nb', 'x\ny')).toEqual(['-a', '-b', '+x', '+y'])
  })

  it('survives empty input on either side', () => {
    expect(diffStats(diffLines('', 'a\nb'))).toEqual({ added: 2, removed: 1 })
    expect(diffStats(diffLines('a\nb', ''))).toEqual({ added: 1, removed: 2 })
  })
})

describe('collapseUnchanged', () => {
  it('folds runs outside the context window', () => {
    const mine = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const theirs = mine.replace('line 10', 'LINE 10')

    const chunks = collapseUnchanged(diffLines(mine, theirs), 2)

    expect(chunks[0]).toEqual({ kind: 'gap', lines: 8 })
    expect(chunks.at(-1)).toEqual({ kind: 'gap', lines: 7 })
    expect(chunks.filter((chunk) => chunk.kind !== 'gap')).toHaveLength(6)
  })

  it('leaves a short diff alone', () => {
    const chunks = collapseUnchanged(diffLines('a\nb', 'a\nB'), 3)
    expect(chunks.some((chunk) => chunk.kind === 'gap')).toBe(false)
  })
})
