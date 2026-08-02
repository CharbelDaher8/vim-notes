import { assertNotePath, type TreeEntry } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import {
  ancestorsOf,
  editableName,
  findEntry,
  flattenTree,
  parentForNewEntry,
  withMarkdownExtension,
} from './tree-model'

const p = assertNotePath

const file = (path: string): TreeEntry => ({
  kind: 'file',
  path: p(path),
  name: path.split('/').at(-1) ?? path,
  size: 0,
  modifiedAt: 0,
})

const directory = (path: string, children: TreeEntry[]): TreeEntry => ({
  kind: 'directory',
  path: p(path),
  name: path.split('/').at(-1) ?? path,
  children,
})

const tree: TreeEntry[] = [
  directory('journal', [directory('journal/2026', [file('journal/2026/august.md')])]),
  file('inbox.md'),
]

describe('flattenTree', () => {
  it('shows only the top level when nothing is expanded', () => {
    const rows = flattenTree(tree, new Set())
    expect(rows.map((row) => row.entry.path)).toEqual(['journal', 'inbox.md'])
  })

  it('expands one level at a time', () => {
    const rows = flattenTree(tree, new Set(['journal']))

    expect(rows.map((row) => row.entry.path)).toEqual(['journal', 'journal/2026', 'inbox.md'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0])
  })

  it('reports expansion and kind for each row', () => {
    const rows = flattenTree(tree, new Set(['journal', 'journal/2026']))

    expect(rows.map((row) => `${row.entry.path}:${row.depth}`)).toEqual([
      'journal:0',
      'journal/2026:1',
      'journal/2026/august.md:2',
      'inbox.md:0',
    ])
    expect(rows[0]?.expanded).toBe(true)
    expect(rows.at(-1)?.isDirectory).toBe(false)
  })

  it('ignores an expanded path that is not a directory', () => {
    const rows = flattenTree(tree, new Set(['inbox.md']))
    expect(rows).toHaveLength(2)
  })
})

describe('ancestorsOf', () => {
  it('lists every directory on the way down, excluding the file itself', () => {
    expect(ancestorsOf(p('journal/2026/august.md'))).toEqual(['journal', 'journal/2026'])
  })

  it('is empty at the root', () => {
    expect(ancestorsOf(p('inbox.md'))).toEqual([])
  })
})

describe('findEntry', () => {
  it('finds nested entries', () => {
    expect(findEntry(tree, p('journal/2026/august.md'))?.kind).toBe('file')
    expect(findEntry(tree, p('journal/2026'))?.kind).toBe('directory')
  })

  it('returns null for a path that is not there', () => {
    expect(findEntry(tree, p('nope.md'))).toBeNull()
  })
})

describe('parentForNewEntry', () => {
  it('creates inside a selected directory', () => {
    expect(parentForNewEntry(tree, p('journal/2026'))).toBe('journal/2026')
  })

  it('creates beside a selected file', () => {
    expect(parentForNewEntry(tree, p('journal/2026/august.md'))).toBe('journal/2026')
  })

  it('falls back to the root', () => {
    expect(parentForNewEntry(tree, null)).toBeNull()
    expect(parentForNewEntry(tree, p('inbox.md'))).toBeNull()
    expect(parentForNewEntry(tree, p('gone.md'))).toBeNull()
  })
})

describe('name helpers', () => {
  it('adds .md unless an extension was typed', () => {
    expect(withMarkdownExtension('ideas')).toBe('ideas.md')
    expect(withMarkdownExtension('notes.txt')).toBe('notes.txt')
  })

  it('hides the extension when renaming a file but not a directory', () => {
    expect(editableName(p('journal/august.md'), false)).toBe('august')
    expect(editableName(p('journal'), true)).toBe('journal')
    expect(editableName(p('.gitignore'), false)).toBe('.gitignore')
  })
})
