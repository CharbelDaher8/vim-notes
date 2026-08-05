// @vitest-environment jsdom
/**
 * The wiring test, and it is the point of this file.
 *
 * Every other test here checks a piece in isolation, which is exactly the
 * shape of bug this codebase keeps producing: two correct halves that were
 * never connected (DECISIONS.md §6). So this builds the real editor the way
 * `EditorPane` builds it and asks the resulting document whether there is a
 * chart in it -- not whether the extension would have produced one.
 */
import { EditorSelection, Text } from '@codemirror/state'
import { afterEach, beforeAll, expect, test } from 'vitest'

import { createEditor, type EditorHandle } from '../editor/create-editor'
import { findChartBlocks } from './chart-extension'

beforeAll(() => {
  // jsdom has no layout and therefore no ResizeObserver. The widget uses one
  // to redraw at a new width; here it simply never fires.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const handles: EditorHandle[] = []

afterEach(() => {
  while (handles.length > 0) handles.pop()?.destroy()
  document.body.replaceChildren()
})

function mountEditor(doc: string): EditorHandle {
  const parent = document.createElement('div')
  document.body.append(parent)

  const handle = createEditor({
    parent,
    doc,
    vimEnabled: false,
    dark: false,
    onUserChange: () => {},
    onSave: () => {},
    onClose: () => {},
    onOpenLink: () => {},
  })

  handles.push(handle)
  return handle
}

const BLOCK = ['```chart bar', 'month, revenue', 'Jan, 120', 'Feb, 180', '```'].join('\n')

test('a data block in a note becomes a chart in the running editor', () => {
  const handle = mountEditor(`# Notes\n\n${BLOCK}\n\nAfter.`)

  const figure = handle.view.dom.querySelector('.chart')
  expect(figure).not.toBeNull()
  expect(figure?.querySelectorAll('.chart-bar')).toHaveLength(2)

  // The prose around it is still prose.
  expect(handle.view.dom.textContent).toContain('After.')
})

test('the source comes back when the cursor lands in the block, and goes again when it leaves', () => {
  const handle = mountEditor(`Above\n\n${BLOCK}\n\nBelow`)
  expect(handle.view.dom.querySelector('.chart')).not.toBeNull()

  const inside = handle.view.state.doc.line(4).from
  handle.view.dispatch({ selection: EditorSelection.cursor(inside) })

  expect(handle.view.dom.querySelector('.chart')).toBeNull()
  expect(handle.view.dom.textContent).toContain('month, revenue')

  handle.view.dispatch({ selection: EditorSelection.cursor(0) })
  expect(handle.view.dom.querySelector('.chart')).not.toBeNull()
})

test('a chart is not rebuilt while you type somewhere else', () => {
  const handle = mountEditor(`Above\n\n${BLOCK}\n\nBelow`)
  const before = handle.view.dom.querySelector('.chart')

  handle.view.dispatch({ changes: { from: 0, insert: 'more words ' } })

  // Same node, not an equal one: `eq` kept the widget alive across the edit.
  expect(handle.view.dom.querySelector('.chart')).toBe(before)
})

test('editing the block redraws it', () => {
  const handle = mountEditor(`${BLOCK}\n\nBelow`)
  expect(handle.view.dom.querySelectorAll('.chart-bar')).toHaveLength(2)

  // A row added while the cursor is in the block, then the cursor moved out --
  // which is the sequence someone editing a chart actually performs.
  const line = handle.view.state.doc.line(3)
  handle.view.dispatch({
    changes: { from: line.from, to: line.to, insert: 'Jan, 120\nMar, 40\nApr, 50' },
    selection: EditorSelection.cursor(line.from),
  })
  expect(handle.view.dom.querySelector('.chart')).toBeNull()

  handle.view.dispatch({ selection: EditorSelection.cursor(handle.view.state.doc.length) })
  expect(handle.view.dom.querySelectorAll('.chart-bar')).toHaveLength(4)
})

test('clicking a chart puts the cursor on the first line inside the block', () => {
  const handle = mountEditor(`Above\n\n${BLOCK}\n\nBelow`)
  const figure = handle.view.dom.querySelector('.chart')

  figure?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  // Line 3 is the opening fence, so the cursor belongs on line 4.
  const cursor = handle.view.state.selection.main.head
  expect(handle.view.state.doc.lineAt(cursor).number).toBe(4)
  expect(handle.view.dom.querySelector('.chart')).toBeNull()
})

test('the data disclosure is the widget´s own, not a click into the source', () => {
  const handle = mountEditor(`Above\n\n${BLOCK}\n\nBelow`)
  const toggle = handle.view.dom.querySelector('.chart-data-toggle')

  toggle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  expect(handle.view.dom.querySelector('.chart')).not.toBeNull()
})

test('a broken block shows what is wrong instead of the chart', () => {
  const broken = ['```chart line', 'month, revenue', 'Jan, 120', 'Feb, n/a', '```'].join('\n')
  const handle = mountEditor(`Above\n\n${broken}\n\nBelow`)

  const message = handle.view.dom.querySelector('.chart-error-message')?.textContent
  expect(message).toContain('not a number')
  expect(handle.view.dom.querySelector('.chart-error-source')?.textContent).toBe('Feb, n/a')
})

test('finds the blocks it owns and leaves every other fence alone', () => {
  const doc = Text.of(
    [
      '```chart',
      'a, 1',
      '```',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '```chart pie',
      'a, 1',
      '```',
    ]
      .join('\n')
      .split('\n'),
  )

  const blocks = findChartBlocks(doc)
  expect(blocks).toHaveLength(2)
  expect(blocks[0]?.info).toBe('chart')
  expect(blocks[1]?.info).toBe('chart pie')
  expect(blocks[0]?.body).toBe('a, 1')
})

test('ignores an unclosed block, so typing one does not swallow the note', () => {
  const doc = Text.of(['```chart', 'a, 1', '', 'Still writing.'])
  expect(findChartBlocks(doc)).toHaveLength(0)
})

test('does not mistake a fence inside a longer fence for a block of its own', () => {
  const doc = Text.of(['````chart', 'a, 1', '```', 'b, 2', '````'])
  const blocks = findChartBlocks(doc)

  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.body).toBe('a, 1\n```\nb, 2')
})
