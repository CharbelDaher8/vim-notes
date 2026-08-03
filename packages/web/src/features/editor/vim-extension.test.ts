/**
 * The rule this file exists for: asking for the vim extension is what fetches
 * the vim chunk.
 *
 * Those used to be two separate calls, and the second one was missed on the
 * path that matters. `EditorPane` builds the editor before the vim preference
 * is known -- it resolves from media queries in an effect that runs after the
 * pane mounts -- so the editor is built with vim off and switched on a tick
 * later, on every desktop. Only construction fetched the chunk. Everything
 * downstream then looked right: the store said vim, the status bar badge said
 * VIM, the line-number gutter appeared, and the buffer had no vim in it,
 * because `vimExtension(true)` kept returning `[]` for a chunk nobody had
 * asked for.
 *
 * So the assertions below are about the mode line rather than about internal
 * state. `vim({ status: true })` contributes the panel that renders
 * `--NORMAL--`, which is the thing whose absence was the bug report.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { showPanel } from '@codemirror/view'
import { beforeEach, expect, test, vi } from 'vitest'

/**
 * The chunk is remembered in module scope, so each test needs its own copy of
 * the module to be able to observe the not-yet-loaded state at all.
 */
beforeEach(() => {
  vi.resetModules()
})

/** Whether an editor configured with `extensions` would show the vim mode line. */
function hasModeLine(extensions: Extension): boolean {
  return EditorState.create({ extensions })
    .facet(showPanel)
    .some((panel) => panel !== null)
}

test('asking for vim while the chunk is missing fetches it, then reports back', async () => {
  const { vimExtension } = await import('./vim-extension')

  let landed: (() => void) | null = null
  const onLoad = vi.fn(() => landed?.())
  const loaded = new Promise<void>((resolve) => {
    landed = resolve
  })

  // What the editor is configured with on the very first pass: nothing yet.
  expect(hasModeLine(vimExtension(true, onLoad))).toBe(false)

  // Nothing else in the app asks for the chunk. If this call did not order it,
  // the editor stays in the state above forever -- which is the bug.
  await loaded
  expect(onLoad).toHaveBeenCalled()

  // Asking again, which is what the reported `onLoad` is for.
  expect(hasModeLine(vimExtension(true, onLoad))).toBe(true)
})

test('asking with vim off neither fetches the chunk nor reports back', async () => {
  const { vimExtension } = await import('./vim-extension')

  const onLoad = vi.fn()

  expect(hasModeLine(vimExtension(false, onLoad))).toBe(false)

  // Long enough for a resolved dynamic import to have called back.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(onLoad).not.toHaveBeenCalled()

  // And the chunk really is still absent: a phone that never turns vim on
  // never downloads it (DECISIONS.md §4). If the previous call had loaded it,
  // this one would come back with the mode line already in it.
  expect(hasModeLine(vimExtension(true, onLoad))).toBe(false)
})

test('the chunk is fetched once however many editors ask for it', async () => {
  const { vimExtension } = await import('./vim-extension')

  const first = vi.fn()
  const second = vi.fn()

  vimExtension(true, first)
  vimExtension(true, second)

  await vi.waitFor(() => {
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
