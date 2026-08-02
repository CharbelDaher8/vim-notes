import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { cycleHeading, insertLink, toggleLinePrefix, wrapSelection } from './markup-actions'

function stateWith(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
}

function applied(state: EditorState, spec: TransactionSpec): string {
  return state.update(spec).state.doc.toString()
}

describe('wrapSelection', () => {
  it('wraps a selection', () => {
    const state = stateWith('hello world', 0, 5)
    expect(applied(state, wrapSelection(state, '**'))).toBe('**hello** world')
  })

  it('unwraps when the markers sit just outside the selection', () => {
    const state = stateWith('**hello** world', 2, 7)
    expect(applied(state, wrapSelection(state, '**'))).toBe('hello world')
  })

  it('unwraps when the markers are inside the selection', () => {
    const state = stateWith('**hello** world', 0, 9)
    expect(applied(state, wrapSelection(state, '**'))).toBe('hello world')
  })

  it('inserts an empty pair at the cursor and lands between them', () => {
    const state = stateWith('ab', 1)
    const next = state.update(wrapSelection(state, '`')).state

    expect(next.doc.toString()).toBe('a``b')
    expect(next.selection.main.head).toBe(2)
  })

  it('supports asymmetric markers', () => {
    const state = stateWith('x', 0, 1)
    expect(applied(state, wrapSelection(state, '<', '>'))).toBe('<x>')
  })
})

describe('toggleLinePrefix', () => {
  it('adds the prefix to every selected line', () => {
    const state = stateWith('one\ntwo\nthree', 0, 9)
    expect(applied(state, toggleLinePrefix(state, '- '))).toBe('- one\n- two\n- three')
  })

  it('removes it only when every line already has it', () => {
    const all = stateWith('- one\n- two', 0, 11)
    expect(applied(all, toggleLinePrefix(all, '- '))).toBe('one\ntwo')

    const some = stateWith('- one\ntwo', 0, 9)
    expect(applied(some, toggleLinePrefix(some, '- '))).toBe('- one\n- two')
  })

  it('keeps the existing indent', () => {
    const state = stateWith('    deep', 0)
    expect(applied(state, toggleLinePrefix(state, '> '))).toBe('    > deep')
  })
})

describe('cycleHeading', () => {
  it('cycles up to three levels and back to plain text', () => {
    let text = 'title'

    for (const expected of ['# title', '## title', '### title', 'title']) {
      const state = stateWith(text, 0)
      text = applied(state, cycleHeading(state))
      expect(text).toBe(expected)
    }
  })

  it('applies to every selected line independently of their current level', () => {
    const state = stateWith('# a\nb', 0, 5)
    expect(applied(state, cycleHeading(state))).toBe('## a\n# b')
  })
})

describe('insertLink', () => {
  it('keeps the selection as the label and selects the url placeholder', () => {
    const state = stateWith('docs', 0, 4)
    const next = state.update(insertLink(state)).state

    expect(next.doc.toString()).toBe('[docs](url)')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('url')
  })

  it('works from an empty cursor', () => {
    const state = stateWith('', 0)
    expect(applied(state, insertLink(state))).toBe('[](url)')
  })
})
