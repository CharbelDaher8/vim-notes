import { parseNoteMarkup } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { setAnnotationDone } from './annotation-edit'

/** What the parser makes of a single line, which is the real contract here. */
function stateOf(content: string, line = 1): boolean | null | undefined {
  return parseNoteMarkup(content).annotations.find((a) => a.line === line)?.done
}

describe('setAnnotationDone', () => {
  it('ticks an open checkbox', () => {
    const edit = setAnnotationDone('- [ ] TODO ship it', 1, 'ship it', true)

    expect(edit).toEqual({ ok: true, content: '- [x] TODO ship it' })
  })

  it('unticks a done checkbox', () => {
    const edit = setAnnotationDone('- [X] TODO ship it', 1, 'ship it', false)

    expect(edit).toEqual({ ok: true, content: '- [ ] TODO ship it' })
  })

  it('inserts a checkbox and a list marker when the line was never asked', () => {
    const edit = setAnnotationDone('TODO ship it', 1, 'ship it', true)

    expect(edit).toEqual({ ok: true, content: '- [x] TODO ship it' })
    expect(stateOf('- [x] TODO ship it')).toBe(true)
  })

  it('inserts only the checkbox when a list marker is already there', () => {
    const edit = setAnnotationDone('  * TODO ship it', 1, 'ship it', true)

    expect(edit).toEqual({ ok: true, content: '  * [x] TODO ship it' })
  })

  it('keeps an ordered list ordered', () => {
    const edit = setAnnotationDone('3. TODO ship it', 1, 'ship it', true)

    expect(edit).toEqual({ ok: true, content: '3. [x] TODO ship it' })
  })

  it('round-trips: insert then untick leaves an open checkbox, not a bare line', () => {
    const inserted = setAnnotationDone('TODO ship it', 1, 'ship it', true)
    if (!inserted.ok) throw new Error('expected the insert to succeed')

    const unticked = setAnnotationDone(inserted.content, 1, 'ship it', false)

    expect(unticked).toEqual({ ok: true, content: '- [ ] TODO ship it' })
    expect(stateOf('- [ ] TODO ship it')).toBe(false)
  })

  it('preserves indentation, spacing and the rest of the line', () => {
    const line = '    - [ ]   Reminder: call the vet 2026-08-04'

    const edit = setAnnotationDone(line, 1, 'call the vet 2026-08-04', true)

    expect(edit).toEqual({ ok: true, content: '    - [x]   Reminder: call the vet 2026-08-04' })
  })

  it('only touches the line it was given', () => {
    const content = ['# Day', '', '- [ ] TODO one', '- [ ] TODO two'].join('\n')

    const edit = setAnnotationDone(content, 4, 'two', true)

    expect(edit).toEqual({
      ok: true,
      content: ['# Day', '', '- [ ] TODO one', '- [x] TODO two'].join('\n'),
    })
  })

  it('refuses when the line now holds a different task', () => {
    const content = ['- [ ] TODO inserted by nvim', '- [ ] TODO ship it'].join('\n')

    expect(setAnnotationDone(content, 1, 'ship it', true)).toEqual({ ok: false, reason: 'moved' })
  })

  it('refuses when the line is past the end of the note', () => {
    expect(setAnnotationDone('- [ ] TODO ship it', 9, 'ship it', true)).toEqual({
      ok: false,
      reason: 'moved',
    })
  })

  it('refuses a line that a fence has turned into a code sample', () => {
    const content = ['```sh', 'TODO ship it', '```'].join('\n')

    expect(setAnnotationDone(content, 2, 'ship it', true)).toEqual({ ok: false, reason: 'moved' })
  })

  it('leaves the trailing newline, and the rest of the file, byte-identical', () => {
    const content = '# Day\n\n- [ ] TODO ship it\n\nsome prose\n'

    const edit = setAnnotationDone(content, 3, 'ship it', true)

    expect(edit).toEqual({ ok: true, content: '# Day\n\n- [x] TODO ship it\n\nsome prose\n' })
  })
})
