import { assertNotePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import {
  deriveAnnotations,
  deriveBacklinks,
  deriveBudgetDeclarations,
  deriveGraph,
  deriveSpends,
  type IndexedNote,
} from './derive-index'

const note = (path: string, content: string): IndexedNote => ({
  path: assertNotePath(path),
  content,
})

const NOTES = [
  note(
    'journal/2026-08-01.md',
    [
      '# Saturday',
      '',
      '- [ ] TODO finish the conflict dialog',
      '- [x] TODO pay the invoice',
      'Reminder: renew the domain 2026-09-14',
      '',
      'See [[architecture]] and [[not written yet]].',
    ].join('\n'),
  ),
  note(
    'projects/vim-notes/architecture.md',
    [
      '# Architecture',
      '',
      'TODO write the graph section',
      '',
      'Back to [[journal/2026-08-01]].',
    ].join('\n'),
  ),
  note('inbox.md', '```sh\n# TODO not a task, it is a shell comment\n```\n'),
]

describe('deriveAnnotations', () => {
  it('reports the day from the filename, newest first, undated last', () => {
    // The order matters beyond tidiness: `limit` takes the first N, and with
    // paths sorted ascending a journal would hand back its oldest tasks.
    const records = deriveAnnotations(NOTES)

    expect(records.map((record) => [record.text, record.day])).toEqual([
      ['finish the conflict dialog', '2026-08-01'],
      ['pay the invoice', '2026-08-01'],
      ['renew the domain 2026-09-14', '2026-08-01'],
      ['write the graph section', null],
    ])
  })

  it('does not mine code blocks for tasks', () => {
    expect(deriveAnnotations(NOTES).some((record) => record.path === 'inbox.md')).toBe(false)
  })

  it('carries the three-valued done state through untouched', () => {
    const records = deriveAnnotations(NOTES)

    expect(records.map((record) => record.done)).toEqual([false, true, null, null])
  })

  it('picks a due date out of the text', () => {
    const reminder = deriveAnnotations(NOTES, { kind: 'reminder' })

    expect(reminder).toHaveLength(1)
    expect(reminder[0]?.due).toBe('2026-09-14')
  })

  it('hides only explicitly ticked items when asked', () => {
    const open = deriveAnnotations(NOTES, { includeDone: false })

    expect(open.map((record) => record.text)).not.toContain('pay the invoice')
    // A bare `TODO` was never asked the question, so it is still outstanding.
    expect(open.map((record) => record.text)).toContain('write the graph section')
  })

  it('honours day and limit', () => {
    expect(deriveAnnotations(NOTES, { day: '2026-08-01' })).toHaveLength(3)
    expect(deriveAnnotations(NOTES, { limit: 2 })).toHaveLength(2)
  })
})

describe('deriveBacklinks', () => {
  it('finds what points at a note, through a basename link', () => {
    const links = deriveBacklinks(NOTES, assertNotePath('projects/vim-notes/architecture.md'))

    expect(links).toEqual([
      {
        from: 'journal/2026-08-01.md',
        to: 'projects/vim-notes/architecture.md',
        target: 'architecture',
        label: 'architecture',
        line: 7,
      },
    ])
  })

  it('finds a link written as a path without its extension', () => {
    const links = deriveBacklinks(NOTES, assertNotePath('journal/2026-08-01.md'))

    expect(links.map((link) => link.from)).toEqual(['projects/vim-notes/architecture.md'])
  })

  it('is empty for a note nobody links to', () => {
    expect(deriveBacklinks(NOTES, assertNotePath('inbox.md'))).toEqual([])
  })
})

describe('deriveGraph', () => {
  const graph = deriveGraph(NOTES)
  const ids = new Set(graph.nodes.map((node) => node.id))
  const nodeFor = (text: string) => graph.nodes.find((node) => node.label === text)

  it('has a node per note, per annotation and per day', () => {
    expect(ids.has('note:inbox.md')).toBe(true)
    expect(ids.has('day:2026-08-01')).toBe(true)
    expect(nodeFor('finish the conflict dialog')).toMatchObject({ kind: 'todo', line: 3 })
  })

  it('labels a note by its stem, not its filename', () => {
    expect(nodeFor('architecture')?.id).toBe('note:projects/vim-notes/architecture.md')
  })

  it('identifies a task by its text so that inserting a line above it is free', () => {
    const before = nodeFor('write the graph section')?.id

    const shifted = deriveGraph([
      note('projects/vim-notes/architecture.md', '\n\n\nTODO write the graph section'),
    ])

    expect(shifted.nodes.find((node) => node.kind === 'todo')).toMatchObject({
      id: before,
      // The line moved and is reported; the identity did not.
      line: 4,
    })
  })

  it('hangs a task off the day it was written, not the day it is due', () => {
    // `due` is a property of the task. The graph question is "what was I doing
    // that day", so a 2026-09-14 reminder written on 2026-08-01 joins August.
    const reminder = nodeFor('renew the domain 2026-09-14')

    expect(reminder?.day).toBe('2026-08-01')
    expect(ids.has('day:2026-09-14')).toBe(false)
  })

  it('gives notes and days no line to point at', () => {
    expect(graph.nodes.find((node) => node.id === 'note:inbox.md')?.line).toBeNull()
    expect(graph.nodes.find((node) => node.id === 'day:2026-08-01')?.line).toBeNull()
  })

  it('keeps an unresolved target visible rather than dropping the link', () => {
    const missing = graph.nodes.find((node) => node.id === 'missing:not written yet')

    expect(missing).toMatchObject({ kind: 'note', path: null, label: 'not written yet' })
    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-01.md',
      to: 'missing:not written yet',
      kind: 'unresolved',
    })
  })

  it('returns nodes and edges in a stable order whatever order the notes arrive', () => {
    const reversed = deriveGraph([...NOTES].reverse())

    expect(reversed.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id))
    expect(reversed.edges).toEqual(graph.edges)
  })

  it('joins a daily note to its day', () => {
    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-01.md',
      to: 'day:2026-08-01',
      kind: 'day',
    })
  })

  it('resolves a link between two notes', () => {
    expect(graph.edges).toContainEqual({
      from: 'note:journal/2026-08-01.md',
      to: 'note:projects/vim-notes/architecture.md',
      kind: 'link',
    })
  })

  it('draws one edge for a relationship, however many times it is written', () => {
    const twice = [note('a.md', 'See [[b]] and again [[b|the other one]].'), note('b.md', 'Hello.')]

    const edges = deriveGraph(twice).edges.filter((edge) => edge.kind === 'link')

    expect(edges).toEqual([{ from: 'note:a.md', to: 'note:b.md', kind: 'link' }])
  })

  it('carries the done state onto the annotation nodes', () => {
    expect(nodeFor('pay the invoice')).toMatchObject({ kind: 'todo', done: true, line: 4 })
  })

  it('tells two identical tasks in one note apart', () => {
    const twins = deriveGraph([note('a.md', 'TODO ring the vet\nTODO ring the vet')])
    const todos = twins.nodes.filter((node) => node.kind === 'todo')

    expect(new Set(todos.map((node) => node.id)).size).toBe(2)
    expect(todos.map((node) => node.line).sort()).toEqual([1, 2])
  })
})

/**
 * The corpus both index implementations are checked against.
 *
 * Exported so `memory-note-index.test.ts` on the server can assert the same
 * facts about the same input. `derive-index.ts` promises to match that class
 * decision for decision, and a promise nothing checks is a comment.
 */
export const SPEND_NOTES = [
  note(
    'journal/2026-08-01.md',
    ['# Saturday', '', 'Spent 42.50 groceries', 'Spent 3 bus', 'TODO not a spend'].join('\n'),
  ),
  note('journal/2026-08-04.md', ['Spent 1200 rent', 'Spent 8 coffee'].join('\n')),
  note('journal/2026-07-30.md', 'Spent 60 groceries'),
  note(
    'budget.md',
    [
      'Balance: 5000 as of 2026-08-01',
      'Income: 3000/month',
      '',
      'Spent 15 stamps',
      '',
      '```',
      'Spent 999 quoted, not spent',
      '```',
    ].join('\n'),
  ),
  // Backdated: written up in August, counts in July.
  note('journal/2026-08-06.md', 'Spent 25 books 2026-07-15'),
]

describe('deriveSpends', () => {
  it('finds every spend and skips fenced ones', () => {
    expect(deriveSpends(SPEND_NOTES)).toHaveLength(7)
  })

  it('orders newest first with undated last', () => {
    expect(deriveSpends(SPEND_NOTES).map((entry) => entry.on)).toEqual([
      '2026-08-04',
      '2026-08-04',
      '2026-08-01',
      '2026-08-01',
      '2026-07-30',
      '2026-07-15',
      null,
    ])
  })

  it('lets a written date beat the journal day', () => {
    const backdated = deriveSpends(SPEND_NOTES).find((entry) => entry.category === 'books')

    expect(backdated).toMatchObject({ on: '2026-07-15', day: '2026-08-06', date: '2026-07-15' })
  })

  it('gives a spend outside a journal a null day, and keeps it', () => {
    const stamps = deriveSpends(SPEND_NOTES).find((entry) => entry.category === 'stamps')

    expect(stamps).toMatchObject({ on: null, day: null, amountMinor: 1500 })
  })

  it('bounds on the effective date, not the note', () => {
    const august = deriveSpends(SPEND_NOTES, { since: '2026-08-01', until: '2026-08-31' })

    expect(august.map((entry) => entry.category)).toEqual(['rent', 'coffee', 'groceries', 'bus'])
  })

  /** Undated money is real money; it only drops out when a range is asked for. */
  it('drops undated spends from a bounded query and only then', () => {
    expect(deriveSpends(SPEND_NOTES, { since: '2020-01-01' }).some((e) => e.on === null)).toBe(
      false,
    )
    expect(deriveSpends(SPEND_NOTES).some((entry) => entry.on === null)).toBe(true)
  })

  it('filters by category', () => {
    expect(deriveSpends(SPEND_NOTES, { category: 'groceries' }).map((e) => e.amountMinor)).toEqual([
      4250, 6000,
    ])
  })

  it('takes the newest N when limited', () => {
    expect(deriveSpends(SPEND_NOTES, { limit: 2 }).map((entry) => entry.category)).toEqual([
      'rent',
      'coffee',
    ])
  })
})

describe('deriveBudgetDeclarations', () => {
  it('returns declarations in document order, with their note', () => {
    expect(deriveBudgetDeclarations(SPEND_NOTES)).toEqual([
      expect.objectContaining({
        kind: 'balance',
        amountMinor: 500_000,
        asOf: '2026-08-01',
        line: 1,
      }),
      expect.objectContaining({ kind: 'income', amountMinor: 300_000, period: 'month', line: 2 }),
    ])
  })

  it('is empty when nothing declares one', () => {
    expect(deriveBudgetDeclarations([note('a.md', 'Spent 5 tea')])).toEqual([])
  })
})
