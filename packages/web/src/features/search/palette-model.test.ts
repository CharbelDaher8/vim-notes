import { assertNotePath as notePath, type SearchHit } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import {
  buildPaletteResults,
  moveSelection,
  selectedItem,
  selectionIndex,
  type PaletteItem,
} from './palette-model'

function hit(path: string, line: number, preview = 'a line'): SearchHit {
  return { path: notePath(path), line, column: 1, preview }
}

function keys(items: PaletteItem[]): string[] {
  return items.map((item) => item.key)
}

describe('buildPaletteResults', () => {
  it('is empty when nothing matched', () => {
    const results = buildPaletteResults({ names: [], hits: [] })

    expect(results.sections).toEqual([])
    expect(results.items).toEqual([])
  })

  it('puts filename matches before content matches', () => {
    // Enter with no arrow keys should open the note you named, not the first
    // line of prose that happens to mention it.
    const results = buildPaletteResults({
      names: [notePath('watering.md')],
      hits: [hit('journal.md', 3)],
    })

    expect(results.sections.map((section) => section.id)).toEqual(['names', 'contents'])
    expect(keys(results.items)).toEqual(['note:watering.md', 'hit:journal.md:3'])
  })

  it('omits a section that has no items', () => {
    const onlyHits = buildPaletteResults({ names: [], hits: [hit('a.md', 1)] })
    expect(onlyHits.sections.map((section) => section.id)).toEqual(['contents'])

    const onlyNames = buildPaletteResults({ names: [notePath('a.md')], hits: [] })
    expect(onlyNames.sections.map((section) => section.id)).toEqual(['names'])
  })

  it('splits a note path into name and directory for display', () => {
    const results = buildPaletteResults({ names: [notePath('work/deep/standup.md')], hits: [] })

    expect(results.items[0]).toMatchObject({
      kind: 'note',
      name: 'standup.md',
      directory: 'work/deep',
    })
  })

  it('leaves the directory null for a note at the root', () => {
    const results = buildPaletteResults({ names: [notePath('inbox.md')], hits: [] })

    expect(results.items[0]).toMatchObject({ name: 'inbox.md', directory: null })
  })

  it('marks the first hit in each file, so the path is drawn once', () => {
    const results = buildPaletteResults({
      names: [],
      hits: [hit('a.md', 1), hit('a.md', 7), hit('b.md', 2)],
    })

    expect(results.items.map((item) => item.kind === 'hit' && item.startsGroup)).toEqual([
      true,
      false,
      true,
    ])
  })

  it('carries the line and column through, so a hit can be revealed', () => {
    const results = buildPaletteResults({
      names: [],
      hits: [{ path: notePath('a.md'), line: 12, column: 5, preview: 'x' }],
    })

    expect(results.items[0]).toMatchObject({ path: 'a.md', line: 12, column: 5 })
  })

  it('caps the hits but still reports how many there were', () => {
    const many = Array.from({ length: 100 }, (_, index) => hit('a.md', index + 1))

    const results = buildPaletteResults({ names: [], hits: many, hitLimit: 10 })

    expect(results.items).toHaveLength(10)
    expect(results.shownHits).toBe(10)
    expect(results.totalHits).toBe(100)
  })

  it('stops at the cap partway through a file, and adds no later ones', () => {
    const results = buildPaletteResults({
      names: [],
      hits: [hit('a.md', 1), hit('a.md', 2), hit('a.md', 3), hit('b.md', 1)],
      hitLimit: 2,
    })

    expect(keys(results.items)).toEqual(['hit:a.md:1', 'hit:a.md:2'])
    expect(results.totalHits).toBe(4)
  })

  it('gives every item a distinct key', () => {
    // The selection is tracked by key, so a duplicate would make two rows
    // highlight together and Enter open the wrong one.
    const results = buildPaletteResults({
      names: [notePath('a.md'), notePath('b.md')],
      hits: [hit('a.md', 1), hit('a.md', 2), hit('b.md', 1)],
    })

    expect(new Set(keys(results.items)).size).toBe(results.items.length)
  })
})

describe('selection', () => {
  const items = buildPaletteResults({
    names: [notePath('a.md'), notePath('b.md')],
    hits: [hit('c.md', 1)],
  }).items

  it('starts on the first item', () => {
    expect(selectionIndex(items, null)).toBe(0)
    expect(selectedItem(items, null)?.key).toBe('note:a.md')
  })

  it('finds the selected key', () => {
    expect(selectionIndex(items, 'note:b.md')).toBe(1)
    expect(selectionIndex(items, 'hit:c.md:1')).toBe(2)
  })

  it('falls back to the first item when the selection has gone', () => {
    // Every keystroke replaces the results. Landing on nothing would mean Enter
    // did nothing at the moment the user pressed it.
    expect(selectionIndex(items, 'note:deleted.md')).toBe(0)
    expect(selectedItem(items, 'note:deleted.md')?.key).toBe('note:a.md')
  })

  it('reports nothing selectable for an empty list', () => {
    expect(selectionIndex([], null)).toBe(-1)
    expect(selectedItem([], null)).toBeNull()
    expect(moveSelection([], null, 1)).toBeNull()
  })

  describe('moveSelection', () => {
    it('steps down and up', () => {
      expect(moveSelection(items, 'note:a.md', 1)).toBe('note:b.md')
      expect(moveSelection(items, 'hit:c.md:1', -1)).toBe('note:b.md')
    })

    it('treats no selection as being on the first item', () => {
      expect(moveSelection(items, null, 1)).toBe('note:b.md')
    })

    it('wraps at both ends', () => {
      expect(moveSelection(items, 'hit:c.md:1', 1)).toBe('note:a.md')
      expect(moveSelection(items, 'note:a.md', -1)).toBe('hit:c.md:1')
    })

    it('wraps to itself in a list of one', () => {
      const single = buildPaletteResults({ names: [notePath('only.md')], hits: [] }).items

      expect(moveSelection(single, 'note:only.md', 1)).toBe('note:only.md')
      expect(moveSelection(single, 'note:only.md', -1)).toBe('note:only.md')
    })

    it('steps from the top when the selection has gone stale', () => {
      expect(moveSelection(items, 'note:deleted.md', 1)).toBe('note:b.md')
    })
  })
})
