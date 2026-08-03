import { assertNotePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { noteFromSearch, noteHref, workspaceHref } from './note-url'

describe('noteFromSearch', () => {
  it('reads a note out of a query string', () => {
    expect(noteFromSearch('?note=journal/2026-08-01.md')).toEqual({
      path: 'journal/2026-08-01.md',
    })
  })

  it('reads the line a graph node was opened at', () => {
    expect(noteFromSearch('?note=inbox.md&line=12')).toEqual({
      path: 'inbox.md',
      reveal: { line: 12 },
    })
  })

  it('reads what noteHref writes, including the escaped slashes', () => {
    const href = noteHref(assertNotePath('projects/vim-notes/architecture.md'), { line: 4 })

    expect(noteFromSearch(href.slice(href.indexOf('?')))).toEqual({
      path: 'projects/vim-notes/architecture.md',
      reveal: { line: 4 },
    })
  })

  it.each([
    ['nothing at all', ''],
    ['some other query', '?theme=dark'],
    ['an empty note', '?note='],
  ])('finds no note in %s', (_name, search) => {
    expect(noteFromSearch(search)).toBeNull()
  })

  /**
   * The reason this goes through `parseNotePath` rather than being read as a
   * string. A query string is the least trustworthy input in the app: it
   * arrives from a link somebody else wrote.
   */
  it.each([
    ['an escape from the notes root', '?note=../../.ssh/id_rsa'],
    ['an absolute path', '?note=/etc/passwd'],
  ])('refuses %s', (_name, search) => {
    expect(noteFromSearch(search)).toBeNull()
  })

  it.each([
    ['zero', '?note=a.md&line=0'],
    ['negative', '?note=a.md&line=-3'],
    ['fractional', '?note=a.md&line=2.5'],
    ['not a number', '?note=a.md&line=middle'],
  ])('opens the note at the top when the line is %s', (_name, search) => {
    expect(noteFromSearch(search)).toEqual({ path: 'a.md' })
  })
})

describe('workspaceHref', () => {
  it('is the bare workspace when nothing is open', () => {
    expect(workspaceHref(null)).toBe('/')
  })

  it('names the open note otherwise', () => {
    expect(noteFromSearch(workspaceHref(assertNotePath('a/b.md')).slice(1))).toEqual({
      path: 'a/b.md',
    })
  })
})
