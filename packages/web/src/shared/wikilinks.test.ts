import { assertNotePath, type NotePath, type TreeEntry } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { collectNotePaths, resolveWikiTarget, suggestNotePath } from './wikilinks'

const paths = (...values: string[]): NotePath[] => values.map(assertNotePath)

describe('resolveWikiTarget', () => {
  const notes = paths(
    'inbox.md',
    'journal/2026-08-01.md',
    'projects/vim-notes/architecture.md',
    'projects/garden/watering.md',
  )

  it('matches an exact path', () => {
    expect(resolveWikiTarget(notes, 'journal/2026-08-01.md')).toBe('journal/2026-08-01.md')
  })

  it('appends .md when the target left it off', () => {
    expect(resolveWikiTarget(notes, 'journal/2026-08-01')).toBe('journal/2026-08-01.md')
  })

  it('matches a unique basename, with or without the extension', () => {
    expect(resolveWikiTarget(notes, 'architecture')).toBe('projects/vim-notes/architecture.md')
    expect(resolveWikiTarget(notes, 'watering.md')).toBe('projects/garden/watering.md')
  })

  it('resolves an ambiguous basename to nothing rather than guessing', () => {
    const twins = paths('projects/a/roadmap.md', 'projects/b/roadmap.md')

    expect(resolveWikiTarget(twins, 'roadmap')).toBeNull()
  })

  it('prefers the path that only needed an extension over a shared basename', () => {
    const both = paths('roadmap.md', 'projects/roadmap.md')

    expect(resolveWikiTarget(both, 'roadmap')).toBe('roadmap.md')
  })

  it('returns null for a target nobody has written yet', () => {
    expect(resolveWikiTarget(notes, 'not-a-note')).toBeNull()
  })

  it('ignores surrounding whitespace, a leading ./ and sloppy slashes', () => {
    expect(resolveWikiTarget(notes, '  ./inbox  ')).toBe('inbox.md')
    expect(resolveWikiTarget(notes, 'projects//garden/watering/')).toBe(
      'projects/garden/watering.md',
    )
  })

  it('matches a basename case-insensitively, because nobody capitalises a link', () => {
    expect(resolveWikiTarget(notes, 'Architecture')).toBe('projects/vim-notes/architecture.md')
  })

  it('matches an exact path case-sensitively, because the filesystem does', () => {
    const cased = paths('Roadmap.md')

    // Two notes differing only in case are two notes on the server's disk, so
    // an exact-path link must not quietly land on the other one.
    expect(resolveWikiTarget(cased, 'roadmap.md')).toBe('Roadmap.md')
    expect(resolveWikiTarget([...cased, ...paths('roadmap.md')], 'roadmap.md')).toBe('roadmap.md')
  })

  it('refuses to let a link escape the notes root', () => {
    expect(resolveWikiTarget(notes, '../../.ssh/id_rsa')).toBeNull()
    expect(resolveWikiTarget(notes, '/etc/passwd')).toBeNull()
  })

  it('has nothing to say about an empty target', () => {
    expect(resolveWikiTarget(notes, '   ')).toBeNull()
  })
})

describe('suggestNotePath', () => {
  const from = assertNotePath('projects/vim-notes/architecture.md')

  it('puts a bare name beside the note that linked to it', () => {
    expect(suggestNotePath('roadmap', from)).toBe('projects/vim-notes/roadmap.md')
  })

  it('reads a target containing a slash as a path from the root', () => {
    expect(suggestNotePath('reference/git', from)).toBe('reference/git.md')
  })

  it('leaves an extension the user typed alone', () => {
    expect(suggestNotePath('notes.txt', from)).toBe('projects/vim-notes/notes.txt')
  })

  it('falls back to the root when the linking note is at the root', () => {
    expect(suggestNotePath('roadmap', assertNotePath('inbox.md'))).toBe('roadmap.md')
    expect(suggestNotePath('roadmap', null)).toBe('roadmap.md')
  })

  it('does not mistake a dot in a directory name for an extension', () => {
    expect(suggestNotePath('notes.2026/plan', null)).toBe('notes.2026/plan.md')
  })
})

describe('collectNotePaths', () => {
  const file = (path: string): TreeEntry => ({
    kind: 'file',
    path: assertNotePath(path),
    name: path.slice(path.lastIndexOf('/') + 1),
    size: 0,
    modifiedAt: 0,
  })

  const tree: TreeEntry[] = [
    {
      kind: 'directory',
      path: assertNotePath('journal'),
      name: 'journal',
      children: [file('journal/2026-08-01.md')],
    },
    file('inbox.md'),
    file('diagram.png'),
  ]

  it('flattens the tree to files, because a directory is not a link target', () => {
    expect(collectNotePaths(tree)).toContain('journal/2026-08-01.md')
    expect(collectNotePaths(tree)).toContain('inbox.md')
  })

  it('leaves out what the index does not read, so the editor agrees with it', () => {
    // The server only indexes markdown, so `[[diagram.png]]` resolves to
    // nothing there. Colouring it as a live link here would be a lie.
    expect(collectNotePaths(tree)).not.toContain('diagram.png')
  })
})
