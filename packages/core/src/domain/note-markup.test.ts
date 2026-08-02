import { describe, expect, it } from 'vitest'

import { assertNotePath } from './note-path'
import { journalDateOf, parseIsoDate, parseNoteMarkup } from './note-markup'

const annotationsOf = (content: string) => parseNoteMarkup(content).annotations
const linksOf = (content: string) => parseNoteMarkup(content).links

describe('annotations', () => {
  it('picks up a bare keyword at the start of a line', () => {
    const [todo] = annotationsOf('TODO water the plants')
    expect(todo).toMatchObject({ kind: 'todo', text: 'water the plants', line: 1, done: null })
  })

  it('accepts a colon, and strips it', () => {
    expect(annotationsOf('TODO: water the plants')[0]?.text).toBe('water the plants')
  })

  it('is case-insensitive, because nobody types consistently', () => {
    expect(annotationsOf('todo water')[0]?.kind).toBe('todo')
    expect(annotationsOf('ToDo water')[0]?.kind).toBe('todo')
    expect(annotationsOf('REMINDER call mum')[0]?.kind).toBe('reminder')
    expect(annotationsOf('Reminder call mum')[0]?.kind).toBe('reminder')
  })

  it('reads through list markers and indentation', () => {
    expect(annotationsOf('- TODO a')[0]?.text).toBe('a')
    expect(annotationsOf('  * TODO b')[0]?.text).toBe('b')
    expect(annotationsOf('    + TODO c')[0]?.text).toBe('c')
    expect(annotationsOf('1. TODO d')[0]?.text).toBe('d')
    expect(annotationsOf('2) TODO e')[0]?.text).toBe('e')
  })

  it('distinguishes unchecked, checked and no checkbox at all', () => {
    // Three states rather than a boolean: "not asked" is not the same claim as
    // "asked and not done", and only one of them should be rewritten on tick.
    expect(annotationsOf('- [ ] TODO a')[0]?.done).toBe(false)
    expect(annotationsOf('- [x] TODO a')[0]?.done).toBe(true)
    expect(annotationsOf('- [X] TODO a')[0]?.done).toBe(true)
    expect(annotationsOf('TODO a')[0]?.done).toBeNull()
  })

  it('reports 1-indexed lines, matching what editors display', () => {
    const found = annotationsOf('# Day\n\nTODO a\n\nReminder b\n')
    expect(found.map((a) => [a.kind, a.line])).toEqual([
      ['todo', 3],
      ['reminder', 5],
    ])
  })

  describe('does not claim things that merely mention the word', () => {
    it('mid-sentence', () => {
      expect(annotationsOf('I have a todo about this')).toEqual([])
      expect(annotationsOf('the reminder went off')).toEqual([])
    })

    it('as a prefix of another word', () => {
      expect(annotationsOf('todos are hard')).toEqual([])
      expect(annotationsOf('reminders pile up')).toEqual([])
    })

    it('inside a fenced code block', () => {
      // A shell snippet is a quotation, not a task. Pulling it into the panel
      // would make the whole feature untrustworthy the first time it happened.
      const content = ['# Notes', '', '```sh', '# TODO fix this in the script', '```', ''].join(
        '\n',
      )
      expect(annotationsOf(content)).toEqual([])
    })

    it('inside a tilde-fenced block', () => {
      expect(annotationsOf('~~~\nTODO nope\n~~~\n')).toEqual([])
    })

    it('but resumes after the block closes', () => {
      const content = ['```', 'TODO ignored', '```', 'TODO counted'].join('\n')
      expect(annotationsOf(content).map((a) => a.text)).toEqual(['counted'])
    })

    it('when the keyword has no text after it', () => {
      // Someone mid-keystroke, not a task. An empty row cannot be acted on.
      expect(annotationsOf('TODO')).toEqual([])
      expect(annotationsOf('TODO   ')).toEqual([])
      expect(annotationsOf('- [ ] TODO:')).toEqual([])
    })
  })

  describe('due dates', () => {
    it('are pulled out of the text', () => {
      expect(annotationsOf('Reminder call the dentist 2026-08-10')[0]?.due).toBe('2026-08-10')
    })

    it('are null when absent', () => {
      expect(annotationsOf('TODO no date here')[0]?.due).toBeNull()
    })

    it('reject impossible days rather than rolling them over', () => {
      // Date() turns 2026-02-31 into March 3 without complaint, and a task
      // silently moving to another month is worse than having no date.
      expect(annotationsOf('TODO thing 2026-02-31')[0]?.due).toBeNull()
      expect(annotationsOf('TODO thing 2026-13-01')[0]?.due).toBeNull()
    })

    it('accept a real leap day', () => {
      expect(parseIsoDate('2028-02-29')).toBe('2028-02-29')
      expect(parseIsoDate('2027-02-29')).toBeNull()
    })
  })
})

describe('wikilinks', () => {
  it('parses a plain link', () => {
    expect(linksOf('see [[roadmap]] for more')[0]).toMatchObject({
      target: 'roadmap',
      label: 'roadmap',
      line: 1,
    })
  })

  it('parses an aliased link', () => {
    expect(linksOf('see [[projects/roadmap|the roadmap]]')[0]).toMatchObject({
      target: 'projects/roadmap',
      label: 'the roadmap',
    })
  })

  it('finds several on one line without swallowing the gap', () => {
    expect(linksOf('[[a]] and [[b]]').map((l) => l.target)).toEqual(['a', 'b'])
  })

  it('reports offsets that bracket the whole link', () => {
    const [link] = linksOf('xx [[a]] yy')
    expect(link?.start).toBe(3)
    expect(link?.end).toBe(8)
    expect('xx [[a]] yy'.slice(link?.start, link?.end)).toBe('[[a]]')
  })

  it('ignores empty and malformed links', () => {
    expect(linksOf('[[]]')).toEqual([])
    expect(linksOf('[[   ]]')).toEqual([])
    expect(linksOf('[[unclosed')).toEqual([])
    expect(linksOf('single [brackets]')).toEqual([])
  })

  it('ignores links inside code blocks', () => {
    expect(linksOf('```\n[[not a link]]\n```')).toEqual([])
  })
})

describe('journalDateOf', () => {
  it('recognises a day by its filename, wherever it is filed', () => {
    // Matched on the basename rather than a fixed prefix, so however someone
    // organises their dailies they still join up in the graph.
    expect(journalDateOf(assertNotePath('journal/2026-08-02.md'))).toBe('2026-08-02')
    expect(journalDateOf(assertNotePath('daily/2026-08-02.md'))).toBe('2026-08-02')
    expect(journalDateOf(assertNotePath('2026-08-02.md'))).toBe('2026-08-02')
    expect(journalDateOf(assertNotePath('a/b/c/2026-08-02.md'))).toBe('2026-08-02')
  })

  it('is null for anything else', () => {
    expect(journalDateOf(assertNotePath('journal/standup.md'))).toBeNull()
    expect(journalDateOf(assertNotePath('2026-08.md'))).toBeNull()
    expect(journalDateOf(assertNotePath('notes-2026-08-02.md'))).toBeNull()
  })

  it('rejects a filename that looks like a date but is not one', () => {
    expect(journalDateOf(assertNotePath('journal/2026-02-31.md'))).toBeNull()
  })
})
