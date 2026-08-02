import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { linkAt, rangesOf } from './wikilink-extension'

const doc = (...lines: string[]) => Text.of(lines)

describe('rangesOf', () => {
  it('maps a link on a later line to the right document offsets', () => {
    const text = doc('# Day', 'See [[architecture]] today.')

    const ranges = rangesOf(text)

    expect(ranges).toHaveLength(1)
    const range = ranges[0]
    if (range === undefined) throw new Error('expected a link')

    // Line 1 is 5 characters plus a newline, so line 2 starts at offset 6.
    expect(range.from).toBe(10)
    expect(text.sliceString(range.from, range.to)).toBe('[[architecture]]')
  })

  it('finds every link on a line, in order', () => {
    const ranges = rangesOf(doc('[[a]] then [[b|the second]]'))

    expect(ranges.map((range) => range.link.target)).toEqual(['a', 'b'])
    expect(ranges.map((range) => range.link.label)).toEqual(['a', 'the second'])
  })

  it('ignores a link inside a fenced code block', () => {
    // A quotation, not a link -- and the editor has to agree with the index
    // about that or the two disagree about what is clickable.
    const ranges = rangesOf(doc('```md', 'See [[architecture]]', '```', '[[real]]'))

    expect(ranges.map((range) => range.link.target)).toEqual(['real'])
  })
})

describe('linkAt', () => {
  const text = doc('See [[architecture]] today.')

  it('finds the link a click landed inside', () => {
    expect(linkAt(text, 8, false)?.target).toBe('architecture')
  })

  it('does not claim a click past the closing bracket', () => {
    // Offset 20 is the character after `]]`, which is a click on the space.
    expect(linkAt(text, 20, false)).toBeNull()
  })

  it('counts a cursor parked on the closing bracket as inside', () => {
    expect(linkAt(text, 20, true)?.target).toBe('architecture')
  })

  it('has nothing to say about a position outside every link', () => {
    expect(linkAt(text, 1, true)).toBeNull()
    expect(linkAt(text, 25, true)).toBeNull()
  })
})
