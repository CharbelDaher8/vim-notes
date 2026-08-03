// @vitest-environment jsdom
/**
 * The one test in this package that builds a real `EditorView`.
 *
 * It exists because of a bug that every other kind of test passed straight
 * through. The store knew vim was on, the status bar badge said VIM, the
 * preference module resolved `true`, the compartment was reconfigured, and the
 * editor had no vim in it -- each half correct, tested, and not connected to
 * the next. The only place that is visible is the object itself, so this asks
 * the running editor rather than anything that reports on it.
 *
 * `getCM` is `@replit/codemirror-vim`'s own "is vim installed in this view",
 * and `x` deleting a character is normal mode actually handling a keystroke.
 */
import { EditorSelection } from '@codemirror/state'
import { getCM } from '@replit/codemirror-vim'
import { afterEach, expect, test, vi } from 'vitest'

import { createEditor, type EditorHandle } from './create-editor'

const handles: EditorHandle[] = []

afterEach(() => {
  while (handles.length > 0) handles.pop()?.destroy()
  document.body.replaceChildren()
})

/**
 * Built the way `EditorPane` builds it: `vimEnabled` comes from the store, and
 * at the moment the pane's layout effect runs the store still says false --
 * `useVimMode` resolves the preference from media queries in a passive effect,
 * which React runs afterwards. Every desktop goes through this sequence.
 */
function mountEditor(doc: string, vimEnabled = false): EditorHandle {
  const parent = document.createElement('div')
  document.body.append(parent)

  const handle = createEditor({
    parent,
    doc,
    vimEnabled,
    dark: false,
    onUserChange: () => {},
    onSave: () => {},
    onClose: () => {},
    onOpenLink: () => {},
  })

  handles.push(handle)
  return handle
}

/** A keystroke as the browser delivers it, into the editor's own listener. */
function press(handle: EditorHandle, key: string): void {
  handle.view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

const vimIsLive = (handle: EditorHandle) => getCM(handle.view) !== null

test('vim reaches an editor that was built before the preference resolved', async () => {
  const handle = mountEditor('alpha\nbeta\ngamma\n')

  expect(vimIsLive(handle)).toBe(false)

  handle.setVimEnabled(true)

  // The chunk is fetched here, not at construction. That is the whole fix:
  // asking for the extension is what orders it.
  await vi.waitFor(() => {
    expect(vimIsLive(handle)).toBe(true)
  })

  // And it is not just present -- it is handling keys. `x` in normal mode
  // deletes the character under the cursor.
  handle.view.dispatch({ selection: EditorSelection.cursor(0) })
  press(handle, 'x')
  expect(handle.view.state.doc.toString()).toBe('lpha\nbeta\ngamma\n')
})

test('vim survives opening another note, which rebuilds the editor state', async () => {
  const handle = mountEditor('alpha\nbeta\n')
  handle.setVimEnabled(true)
  await vi.waitFor(() => {
    expect(vimIsLive(handle)).toBe(true)
  })

  // What `useNoteBuffer` does on every note it opens: a fresh state, so undo
  // cannot cross note boundaries.
  handle.loadDocument('second note\n')

  expect(vimIsLive(handle)).toBe(true)

  handle.view.dispatch({ selection: EditorSelection.cursor(0) })
  press(handle, 'x')
  expect(handle.view.state.doc.toString()).toBe('econd note\n')
})

test('turning vim off and on again leaves it working', async () => {
  const handle = mountEditor('alpha\n')
  handle.setVimEnabled(true)
  await vi.waitFor(() => {
    expect(vimIsLive(handle)).toBe(true)
  })

  handle.setVimEnabled(false)
  expect(vimIsLive(handle)).toBe(false)

  handle.setVimEnabled(true)
  await vi.waitFor(() => {
    expect(vimIsLive(handle)).toBe(true)
  })

  handle.view.dispatch({ selection: EditorSelection.cursor(0) })
  press(handle, 'x')
  expect(handle.view.state.doc.toString()).toBe('lpha\n')
})

test('an editor whose vim is never asked for does not get it', async () => {
  const handle = mountEditor('alpha\n')

  // Long enough that a chunk requested at construction would have landed.
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(vimIsLive(handle)).toBe(false)

  // Plain typing territory: `x` is a character, not a command.
  handle.view.dispatch({ selection: EditorSelection.cursor(0) })
  press(handle, 'x')
  expect(handle.view.state.doc.toString()).toBe('alpha\n')
})
