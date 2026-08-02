import { assertNotePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { deriveAnnotations, deriveBacklinks, deriveGraph, type IndexedNote } from './derive-index'

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
