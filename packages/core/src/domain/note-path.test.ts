import { describe, expect, it } from 'vitest'

import {
  assertNotePath,
  isNotePath,
  MAX_PATH_LENGTH,
  notePathBasename,
  notePathContains,
  notePathExtension,
  notePathJoin,
  notePathParent,
  notePathSegments,
  parseNotePath,
} from './note-path'

/** Helper: assert a parse failed, and with which error kind. */
function expectRejected(input: string, kind: string) {
  const result = parseNotePath(input)
  expect(result.ok, `expected ${JSON.stringify(input)} to be rejected`).toBe(false)
  if (!result.ok) expect(result.error.kind).toBe(kind)
}

function expectAccepted(input: string, normalisedTo: string) {
  const result = parseNotePath(input)
  expect(result.ok, `expected ${JSON.stringify(input)} to be accepted`).toBe(true)
  if (result.ok) expect(result.value).toBe(normalisedTo)
}

describe('parseNotePath', () => {
  describe('accepts', () => {
    it.each([
      ['note.md', 'note.md'],
      ['work/standup.md', 'work/standup.md'],
      ['a/b/c/deep.md', 'a/b/c/deep.md'],
      ['no-extension', 'no-extension'],
      ['with spaces.md', 'with spaces.md'],
      ['unicode-日本語.md', 'unicode-日本語.md'],
      ['emoji-🚀.md', 'emoji-🚀.md'],
      ['.hidden.md', '.hidden.md'],
      ['dots.in.name.md', 'dots.in.name.md'],
    ])('%s', (input, expected) => expectAccepted(input, expected))
  })

  describe('normalises', () => {
    it.each([
      ['a//b.md', 'a/b.md'],
      ['a///b.md', 'a/b.md'],
      ['./a.md', 'a.md'],
      ['a/./b.md', 'a/b.md'],
      ['a/b.md/', 'a/b.md'],
      ['a/', 'a'],
    ])('%s -> %s', (input, expected) => expectAccepted(input, expected))
  })

  describe('rejects path traversal', () => {
    it.each([
      '..',
      '../secret.md',
      '../../etc/passwd',
      'a/../../../etc/passwd',
      'notes/../../.ssh/id_rsa',
      'a/..',
      'a/../b.md',
    ])('%s', (input) => expectRejected(input, 'traversal-segment'))
  })

  describe('rejects absolute paths', () => {
    it.each(['/etc/passwd', '/', '/a.md', 'C:/Windows/system.ini', 'c:/x'])('%s', (input) =>
      expectRejected(input, 'absolute'),
    )
  })

  describe('rejects .git at any depth', () => {
    // A write into .git/hooks/ is remote code execution on the next commit.
    it.each(['.git', '.git/config', '.git/hooks/post-commit', 'a/.git/hooks/pre-push', 'a/b/.git'])(
      '%s',
      (input) => expectRejected(input, 'reserved-segment'),
    )

    it('is case-insensitive', () => {
      expectRejected('.GIT/config', 'reserved-segment')
      expectRejected('a/.Git/hooks/x', 'reserved-segment')
    })
  })

  describe('rejects Windows-hostile names', () => {
    it.each(['con', 'CON', 'aux.md', 'NUL.txt', 'com1', 'com9.md', 'lpt1', 'a/prn.md'])(
      '%s',
      (input) => expectRejected(input, 'reserved-segment'),
    )

    // Windows objects to a segment *ending* in a space or dot. Interior spaces
    // are fine, so each of these has to end with the offending character.
    it.each(['note ', 'trailing-dot.', 'a/dir /b.md', 'a/dir./b.md'])('%s', (input) =>
      expectRejected(input, 'trailing-space-or-dot'),
    )

    it('allows reserved words as substrings', () => {
      expectAccepted('console.md', 'console.md')
      expectAccepted('auxiliary.md', 'auxiliary.md')
      expectAccepted('my-con.md', 'my-con.md')
    })

    it('allows interior spaces and dots', () => {
      expectAccepted('my note .md', 'my note .md')
      expectAccepted('a/b .md', 'a/b .md')
      expectAccepted('release.v1.notes.md', 'release.v1.notes.md')
    })
  })

  describe('rejects dangerous characters', () => {
    it('NUL byte', () => expectRejected('a\0b.md', 'nul-byte'))
    it('newline', () => expectRejected('a\nb.md', 'control-character'))
    it('carriage return', () => expectRejected('a\rb.md', 'control-character'))
    it('tab', () => expectRejected('a\tb.md', 'control-character'))
    it('DEL', () => expectRejected('a\u007Fb.md', 'control-character'))
    it('backslash', () => expectRejected('a\\b.md', 'backslash'))
    it('windows-style traversal', () => expectRejected('..\\..\\etc\\passwd', 'backslash'))
  })

  describe('rejects degenerate input', () => {
    it('empty string', () => expectRejected('', 'empty'))
    // Caught by the absolute-path check before it can reach the empty check,
    // which is the more informative answer anyway.
    it('only slashes', () => expectRejected('///', 'absolute'))
    it('only dots', () => expectRejected('.', 'empty'))
    it('whitespace-only segment', () => expectRejected('a/   /b.md', 'blank-segment'))

    it('over-long path', () => {
      expectRejected(`${'a/'.repeat(MAX_PATH_LENGTH)}b.md`, 'too-long')
    })

    it('over-long segment', () => {
      expectRejected(`${'a'.repeat(256)}.md`, 'segment-too-long')
    })
  })

  it('isNotePath agrees with parseNotePath', () => {
    expect(isNotePath('a.md')).toBe(true)
    expect(isNotePath('../a.md')).toBe(false)
  })

  it('assertNotePath throws with a readable message', () => {
    expect(() => assertNotePath('../x')).toThrowError(/'\.\.' segment/)
    expect(assertNotePath('a/b.md')).toBe('a/b.md')
  })
})

describe('accessors', () => {
  it('segments', () => {
    expect(notePathSegments(assertNotePath('a/b/c.md'))).toEqual(['a', 'b', 'c.md'])
  })

  it('basename', () => {
    expect(notePathBasename(assertNotePath('a/b/c.md'))).toBe('c.md')
    expect(notePathBasename(assertNotePath('c.md'))).toBe('c.md')
  })

  it('extension', () => {
    expect(notePathExtension(assertNotePath('a/b.md'))).toBe('md')
    expect(notePathExtension(assertNotePath('a/b.MD'))).toBe('md')
    expect(notePathExtension(assertNotePath('a/noext'))).toBe('')
    // A leading dot is a hidden file, not an extension.
    expect(notePathExtension(assertNotePath('.hidden'))).toBe('')
  })

  it('parent', () => {
    expect(notePathParent(assertNotePath('a/b/c.md'))).toBe('a/b')
    expect(notePathParent(assertNotePath('a.md'))).toBeNull()
  })

  it('join validates the result', () => {
    const parent = assertNotePath('work')
    expect(notePathJoin(parent, 'note.md')).toEqual({ ok: true, value: 'work/note.md' })
    expect(notePathJoin(null, 'note.md')).toEqual({ ok: true, value: 'note.md' })

    // Joining must not become a traversal escape hatch.
    const escaped = notePathJoin(parent, '../../etc/passwd')
    expect(escaped.ok).toBe(false)
  })

  it('contains is proper-prefix only', () => {
    const dir = assertNotePath('work')
    expect(notePathContains(dir, assertNotePath('work/a.md'))).toBe(true)
    expect(notePathContains(dir, assertNotePath('work/deep/a.md'))).toBe(true)
    expect(notePathContains(dir, assertNotePath('work'))).toBe(false)
    // The classic prefix bug: `work` must not appear to contain `workspace`.
    expect(notePathContains(dir, assertNotePath('workspace/a.md'))).toBe(false)
  })
})
