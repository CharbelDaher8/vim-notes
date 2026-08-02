import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { assertNotePath as notePath, PathEscapeError } from '@vim-notes/core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { RipgrepSearch, SearchError, SearchUnavailableError } from './ripgrep-search'

const parents: string[] = []

afterAll(async () => {
  await Promise.all(parents.map((parent) => fs.rm(parent, { recursive: true, force: true })))
})

/** A notes root with a sibling directory, for the containment tests. */
async function makeRoot(files: Record<string, string> = {}) {
  const parent = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-rg-'))
  parents.push(parent)

  const root = nodePath.join(parent, 'notes')
  await fs.mkdir(root)

  for (const [relative, content] of Object.entries(files)) {
    const absolute = nodePath.join(root, relative)
    await fs.mkdir(nodePath.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }

  return { root, parent }
}

describe('RipgrepSearch', () => {
  let root: string
  let parent: string
  let search: RipgrepSearch

  beforeEach(async () => {
    ;({ root, parent } = await makeRoot({
      'inbox.md': 'a needle in here\nand nothing else\n',
      'work/standup.md': 'no match on this line\nanother needle, indented\n',
      'work/deep/notes.md': '  \tneedle with leading whitespace\n',
      'unrelated.md': 'nothing to see\n',
    }))
    search = new RipgrepSearch(root)
  })

  describe('finding things', () => {
    it('returns a hit per match, with path, line and preview', async () => {
      const hits = await search.query({ pattern: 'needle' })

      expect(hits).toEqual([
        { path: 'inbox.md', line: 1, column: 3, preview: 'a needle in here' },
        {
          path: 'work/deep/notes.md',
          line: 1,
          column: 4,
          preview: 'needle with leading whitespace',
        },
        { path: 'work/standup.md', line: 2, column: 9, preview: 'another needle, indented' },
      ])
    })

    it('returns nothing when nothing matches', async () => {
      expect(await search.query({ pattern: 'haystack' })).toEqual([])
    })

    it('is case-insensitive unless asked otherwise', async () => {
      await fs.writeFile(nodePath.join(root, 'shouty.md'), 'NEEDLE in caps\n')

      expect(await search.query({ pattern: 'needle' })).toHaveLength(4)
      expect(await search.query({ pattern: 'NEEDLE', caseSensitive: true })).toEqual([
        { path: 'shouty.md', line: 1, column: 1, preview: 'NEEDLE in caps' },
      ])
    })

    it('treats the pattern literally by default', async () => {
      // Otherwise a search for a filename or a bare `.` scans everything, and
      // an unbalanced bracket is an error rather than a search.
      await fs.writeFile(nodePath.join(root, 'literal.md'), 'a.b matches\naxb does not\n')

      const hits = await search.query({ pattern: 'a.b' })
      expect(hits).toEqual([{ path: 'literal.md', line: 1, column: 1, preview: 'a.b matches' }])
    })

    it('treats the pattern as a regex when asked', async () => {
      const hits = await search.query({ pattern: '^and\\b', regex: true })

      expect(hits).toEqual([{ path: 'inbox.md', line: 2, column: 1, preview: 'and nothing else' }])
    })

    it('does not error on a pattern that is not valid regex when literal', async () => {
      await fs.writeFile(nodePath.join(root, 'brackets.md'), 'a [unclosed bracket\n')

      const hits = await search.query({ pattern: '[unclosed' })
      expect(hits).toHaveLength(1)
    })

    it('caps the number of hits', async () => {
      await fs.writeFile(nodePath.join(root, 'many.md'), 'needle\n'.repeat(50))

      const hits = await search.query({ pattern: 'needle', limit: 5 })
      expect(hits).toHaveLength(5)
    })

    it('restricts to a subtree when given one', async () => {
      const hits = await search.query({ pattern: 'needle', under: notePath('work') })

      expect(hits.map((hit) => hit.path)).toEqual(['work/deep/notes.md', 'work/standup.md'])
    })

    it('returns nothing for a subtree that does not exist', async () => {
      expect(await search.query({ pattern: 'needle', under: notePath('gone') })).toEqual([])
    })

    it('reports columns as string offsets, not byte offsets', async () => {
      // Three different numbers describe this one position: ripgrep says byte 8,
      // a human reading the line says character 4, and CodeMirror -- which is
      // what consumes this -- says UTF-16 offset 4, because the rocket is a
      // surrogate pair. The port promises what an editor displays, and the
      // editor here indexes strings the way JavaScript does.
      const line = '\u{1F680}é needle here\n'
      expect(line.indexOf('needle')).toBe(4)
      expect(Buffer.from(line, 'utf8').indexOf('needle')).toBe(7)

      await fs.writeFile(nodePath.join(root, 'unicode.md'), line)

      const hits = await search.query({ pattern: 'needle', under: notePath('unicode.md') })
      expect(hits[0]?.column).toBe(5)
      expect(hits[0]?.preview.slice(4, 10)).toBe('needle')
    })

    it('searches hidden notes, which core treats as ordinary notes', async () => {
      await fs.writeFile(nodePath.join(root, '.hidden.md'), 'needle in a dotfile\n')

      const hits = await search.query({ pattern: 'needle' })
      expect(hits.map((hit) => hit.path)).toContain('.hidden.md')
    })

    it('truncates a very long line', async () => {
      await fs.writeFile(nodePath.join(root, 'long.md'), `needle${'x'.repeat(5_000)}\n`)

      const hits = await search.query({ pattern: 'needle', under: notePath('long.md') })
      expect(hits[0]?.preview.length).toBe(201)
      expect(hits[0]?.preview.endsWith('…')).toBe(true)
    })
  })

  describe('what it refuses to look at', () => {
    it('never searches .git', async () => {
      // Object files are compressed, but refs, logs and COMMIT_EDITMSG are not,
      // and none of them are notes.
      await fs.mkdir(nodePath.join(root, '.git'), { recursive: true })
      await fs.writeFile(nodePath.join(root, '.git', 'COMMIT_EDITMSG'), 'needle in the repo\n')

      const hits = await search.query({ pattern: 'needle' })
      expect(hits.map((hit) => hit.path)).not.toContain('.git/COMMIT_EDITMSG')
      expect(hits).toHaveLength(3)
    })

    it('refuses a subtree that leaves the root through a symlink', async () => {
      // ripgrep does not follow symlinks while walking a directory, but it does
      // follow one handed to it as an explicit path -- and then reports the hit
      // as `escape/secret.md`, which parses as a perfectly ordinary note path.
      // Without the containment check this is a read primitive for any file the
      // server user can open.
      await fs.mkdir(nodePath.join(parent, 'secrets'))
      await fs.writeFile(nodePath.join(parent, 'secrets', 'secret.md'), 'needle in a secret\n')
      await fs.symlink(nodePath.join(parent, 'secrets'), nodePath.join(root, 'escape'))

      await expect(
        search.query({ pattern: 'needle', under: notePath('escape') }),
      ).rejects.toBeInstanceOf(PathEscapeError)
    })

    it('does not walk into a symlink that points outside', async () => {
      await fs.mkdir(nodePath.join(parent, 'secrets'))
      await fs.writeFile(nodePath.join(parent, 'secrets', 'secret.md'), 'needle in a secret\n')
      await fs.symlink(nodePath.join(parent, 'secrets'), nodePath.join(root, 'escape'))

      const hits = await search.query({ pattern: 'needle' })
      expect(hits.map((hit) => hit.path)).not.toContain('escape/secret.md')
      expect(hits).toHaveLength(3)
    })

    it('drops hits in files core would refuse to address', async () => {
      await fs.writeFile(nodePath.join(root, 'aux.md'), 'needle in a windows-hostile name\n')

      const hits = await search.query({ pattern: 'needle' })
      expect(hits.map((hit) => hit.path)).not.toContain('aux.md')
    })

    it('returns nothing for an empty pattern rather than every line', async () => {
      expect(await search.query({ pattern: '' })).toEqual([])
    })
  })

  describe('the pattern is untrusted input', () => {
    it('does not let shell metacharacters do anything', async () => {
      // Reaches rg through an argument array, so this is a search for a silly
      // string, not a command.
      const canary = nodePath.join(root, 'pwned.md')

      const hits = await search.query({ pattern: `x"; touch ${canary}; echo "` })

      expect(hits).toEqual([])
      await expect(fs.stat(canary)).rejects.toThrow()
    })

    it('treats a pattern starting with a dash as a pattern, not a flag', async () => {
      await fs.writeFile(nodePath.join(root, 'dashes.md'), 'a --version string\n')

      const hits = await search.query({ pattern: '--version' })
      expect(hits).toEqual([
        { path: 'dashes.md', line: 1, column: 3, preview: 'a --version string' },
      ])
    })
  })

  describe('when ripgrep is not there', () => {
    it('says so, rather than failing obscurely', async () => {
      const missing = new RipgrepSearch(root, { binary: 'rg-that-does-not-exist' })

      await expect(missing.query({ pattern: 'needle' })).rejects.toBeInstanceOf(
        SearchUnavailableError,
      )
      await expect(missing.query({ pattern: 'needle' })).rejects.toThrow(/not installed/)
    })

    it('rejects a relative notes root at construction', () => {
      expect(() => new RipgrepSearch('notes')).toThrow(SearchError)
    })
  })
})
