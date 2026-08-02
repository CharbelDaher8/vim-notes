import { asContentHash, assertNotePath, type FileChangeEvent } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { affectsTree, choicesFor, decideReconcile } from './conflict-model'

const open = assertNotePath('journal/today.md')
const other = assertNotePath('inbox.md')
const baseline = asContentHash('base')

function change(overrides: Partial<FileChangeEvent> = {}): FileChangeEvent {
  return {
    kind: 'modified',
    path: open,
    hash: asContentHash('newer'),
    at: 0,
    origin: 'terminal',
    ...overrides,
  }
}

describe('choicesFor', () => {
  it('offers a comparison and both directions for a stale write', () => {
    const actions = choicesFor({
      kind: 'stale',
      expected: baseline,
      actual: asContentHash('newer'),
    }).map((choice) => choice.action)

    expect(actions).toEqual(['view-both', 'keep-mine', 'take-theirs'])
  })

  it('never offers "take theirs" when theirs no longer exists', () => {
    const actions = choicesFor({ kind: 'deleted-underneath', expected: baseline }).map(
      (choice) => choice.action,
    )

    expect(actions).toEqual(['keep-mine', 'discard-mine'])
    expect(actions).not.toContain('take-theirs')
  })

  it('marks the destructive option so the UI can style it as such', () => {
    const takeTheirs = choicesFor({
      kind: 'stale',
      expected: baseline,
      actual: asContentHash('newer'),
    }).find((choice) => choice.action === 'take-theirs')

    expect(takeTheirs?.tone).toBe('danger')
  })
})

describe('decideReconcile', () => {
  const clean = { openPath: open, baselineHash: baseline, dirty: false }
  const dirty = { openPath: open, baselineHash: baseline, dirty: true }

  it('ignores the echo of our own write', () => {
    expect(decideReconcile(change({ origin: 'api' }), clean)).toEqual({ kind: 'ignore' })
    expect(decideReconcile(change({ origin: 'api' }), dirty)).toEqual({ kind: 'ignore' })
  })

  it('ignores changes to notes that are not open', () => {
    expect(decideReconcile(change({ path: other }), clean)).toEqual({ kind: 'ignore' })
    expect(decideReconcile(change(), { ...clean, openPath: null })).toEqual({ kind: 'ignore' })
  })

  it('ignores a write that produced the bytes we already hold', () => {
    expect(decideReconcile(change({ hash: baseline }), clean)).toEqual({ kind: 'ignore' })
  })

  it('reloads silently when the buffer is clean', () => {
    expect(decideReconcile(change(), clean)).toEqual({ kind: 'reload' })
    expect(decideReconcile(change({ origin: 'git' }), clean)).toEqual({ kind: 'reload' })
    expect(decideReconcile(change({ origin: 'unknown' }), clean)).toEqual({ kind: 'reload' })
  })

  it('never touches a dirty buffer, only notifies', () => {
    expect(decideReconcile(change(), dirty)).toEqual({ kind: 'notify', reason: 'modified' })
  })

  it('distinguishes a deletion under a clean buffer from one under a dirty buffer', () => {
    const deleted = change({ kind: 'deleted', hash: null })

    expect(decideReconcile(deleted, clean)).toEqual({ kind: 'gone' })
    expect(decideReconcile(deleted, dirty)).toEqual({ kind: 'notify', reason: 'deleted' })
  })

  it('reloads a note that reappeared, e.g. a git checkout', () => {
    expect(decideReconcile(change({ kind: 'created' }), clean)).toEqual({ kind: 'reload' })
  })
})

describe('affectsTree', () => {
  it('is true for anything that adds or removes a path', () => {
    expect(affectsTree(change({ kind: 'created' }))).toBe(true)
    expect(affectsTree(change({ kind: 'deleted' }))).toBe(true)
    expect(affectsTree(change({ kind: 'modified' }))).toBe(false)
  })
})
