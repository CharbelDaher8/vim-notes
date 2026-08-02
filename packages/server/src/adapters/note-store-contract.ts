/**
 * One suite, run against every NoteStore implementation.
 *
 * The in-memory store exists so the API layer can be tested without a disk, and
 * that is only sound if the two stores are indistinguishable through the port.
 * Anything asserted here is part of the contract; anything an implementation
 * needs on its own -- symlinks, temporary files, injected clocks -- belongs in
 * its own test file.
 *
 * Not named `*.test.ts` on purpose: it defines tests, it does not contain them.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  assertNotePath as path,
  FORCE_WRITE,
  type ContentHash,
  type NoteMetadata,
  type NoteStore,
  type TreeEntry,
  type WriteOutcome,
} from '@vim-notes/core'

import { hashContent } from './content-hash'
import { NotFoundError, NoteStoreError, PathOccupiedError } from './note-store-common'

function expectWritten(outcome: WriteOutcome): NoteMetadata {
  if (!outcome.ok) {
    throw new Error(`expected the write to succeed, but it was refused: ${outcome.conflict.kind}`)
  }
  return outcome.metadata
}

function expectRefused(outcome: WriteOutcome) {
  if (outcome.ok) throw new Error('expected the write to be refused')
  return outcome
}

/** Shorthand for the shape a tree assertion actually cares about. */
function outline(entries: TreeEntry[]): unknown[] {
  return entries.map((entry) =>
    entry.kind === 'directory'
      ? { directory: entry.name, children: outline(entry.children) }
      : { file: entry.name },
  )
}

export function describeNoteStoreContract(name: string, createStore: () => Promise<NoteStore>) {
  describe(`${name} (NoteStore contract)`, () => {
    let store: NoteStore

    beforeEach(async () => {
      store = await createStore()
    })

    async function create(at: string, content: string): Promise<ContentHash> {
      return expectWritten(await store.write(path(at), content, null)).hash
    }

    describe('read and stat', () => {
      it('return null for a note that does not exist', async () => {
        expect(await store.read(path('nope.md'))).toBeNull()
        expect(await store.stat(path('deep/nope.md'))).toBeNull()
      })

      it('round-trip content, hash and size', async () => {
        const before = Date.now()
        await create('note.md', '# hello\n')

        const document = await store.read(path('note.md'))
        expect(document).not.toBeNull()
        expect(document?.content).toBe('# hello\n')
        expect(document?.path).toBe('note.md')
        expect(document?.hash).toBe(hashContent('# hello\n'))
        expect(document?.size).toBe(8)
        // Filesystem timestamps have coarse resolution; allow a second of slack.
        expect(document?.modifiedAt).toBeGreaterThanOrEqual(before - 1000)
      })

      it('report modifiedAt as whole milliseconds', async () => {
        // APFS and ext4 expose sub-millisecond precision, so the filesystem
        // store gets a float from mtimeMs while the in-memory twin gets an
        // integer from Date.now(). Two stores that disagree about the shape of
        // a field are not interchangeable, which defeats the point of the twin.
        await create('precision.md', 'x')

        const document = await store.read(path('precision.md'))
        expect(Number.isInteger(document?.modifiedAt)).toBe(true)

        const metadata = await store.stat(path('precision.md'))
        expect(Number.isInteger(metadata?.modifiedAt)).toBe(true)
      })

      it('report size in bytes, not characters', async () => {
        await create('unicode.md', 'héllo 🚀')

        const document = await store.read(path('unicode.md'))
        expect(document?.content).toBe('héllo 🚀')
        expect(document?.size).toBe(Buffer.byteLength('héllo 🚀', 'utf8'))
      })

      it('agree with each other', async () => {
        await create('note.md', 'body')

        const document = await store.read(path('note.md'))
        const metadata = await store.stat(path('note.md'))
        expect(metadata).toEqual({
          path: document?.path,
          hash: document?.hash,
          size: document?.size,
          modifiedAt: document?.modifiedAt,
        })
      })

      it('return null for a directory, which is not a note', async () => {
        await store.createDirectory(path('folder'))

        expect(await store.read(path('folder'))).toBeNull()
        expect(await store.stat(path('folder'))).toBeNull()
      })
    })

    describe('write', () => {
      it('creates a note when expecting nothing', async () => {
        const metadata = expectWritten(await store.write(path('new.md'), 'body', null))

        expect(metadata.path).toBe('new.md')
        expect(metadata.hash).toBe(hashContent('body'))
        expect((await store.read(path('new.md')))?.content).toBe('body')
      })

      it('creates missing parent directories', async () => {
        await create('a/b/c/deep.md', 'body')

        expect((await store.read(path('a/b/c/deep.md')))?.content).toBe('body')
        expect(outline(await store.tree())).toEqual([
          {
            directory: 'a',
            children: [
              { directory: 'b', children: [{ directory: 'c', children: [{ file: 'deep.md' }] }] },
            ],
          },
        ])
      })

      it('updates a note when the expected hash matches', async () => {
        const first = await create('note.md', 'one')
        const second = expectWritten(await store.write(path('note.md'), 'two', first))

        expect(second.hash).toBe(hashContent('two'))
        expect((await store.read(path('note.md')))?.content).toBe('two')
      })

      it('refuses to create over an existing note', async () => {
        const existing = await create('note.md', 'mine')

        const outcome = expectRefused(await store.write(path('note.md'), 'theirs', null))
        expect(outcome.conflict).toEqual({ kind: 'already-exists', actual: existing })
        expect(outcome.actual?.hash).toBe(existing)
        expect((await store.read(path('note.md')))?.content).toBe('mine')
      })

      it('refuses a stale write and leaves the note alone', async () => {
        // The scenario the whole mechanism exists for: the phone loaded v1,
        // nvim saved v2, the phone tries to save on top of v1.
        const v1 = await create('note.md', 'v1')
        const v2 = expectWritten(await store.write(path('note.md'), 'v2', v1)).hash

        const outcome = expectRefused(await store.write(path('note.md'), 'phone edit', v1))
        expect(outcome.conflict).toEqual({ kind: 'stale', expected: v1, actual: v2 })
        expect(outcome.actual?.hash).toBe(v2)
        expect((await store.read(path('note.md')))?.content).toBe('v2')
      })

      it('refuses a write to a note that was deleted underneath', async () => {
        const v1 = await create('note.md', 'v1')
        await store.remove(path('note.md'))

        const outcome = expectRefused(await store.write(path('note.md'), 'edit', v1))
        expect(outcome.conflict).toEqual({ kind: 'deleted-underneath', expected: v1 })
        expect(outcome.actual).toBeNull()
        expect(await store.read(path('note.md'))).toBeNull()
      })

      it('overrides every conflict when forced', async () => {
        const v1 = await create('note.md', 'v1')
        expectWritten(await store.write(path('note.md'), 'v2', v1))

        expectWritten(await store.write(path('note.md'), 'forced', FORCE_WRITE))
        expect((await store.read(path('note.md')))?.content).toBe('forced')

        // Force also covers the create case, so "keep mine" works on a note that
        // was deleted while the client was editing it.
        await store.remove(path('note.md'))
        expectWritten(await store.write(path('note.md'), 'recreated', FORCE_WRITE))
        expect((await store.read(path('note.md')))?.content).toBe('recreated')
      })

      it('leaves the parent directory behind even when refused', async () => {
        // Both stores create the directory before checking, because the
        // filesystem one has to have somewhere to put its temporary file. This
        // asserts the wart rather than endorsing it -- if it is ever fixed, it
        // must be fixed in both.
        expectRefused(await store.write(path('folder/note.md'), 'edit', hashContent('gone')))

        expect(outline(await store.tree())).toEqual([{ directory: 'folder', children: [] }])
        expect(await store.read(path('folder/note.md'))).toBeNull()
      })

      it('throws when a directory is already at the path', async () => {
        await store.createDirectory(path('folder'))

        await expect(store.write(path('folder'), 'body', null)).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
      })

      it('throws when a file is in the way of a parent directory', async () => {
        await create('note.md', 'body')

        await expect(store.write(path('note.md/child.md'), 'body', null)).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
      })
    })

    describe('tree', () => {
      it('is empty for an empty store', async () => {
        expect(await store.tree()).toEqual([])
      })

      it('puts directories first, then sorts case-insensitively', async () => {
        await create('zeta.md', 'z')
        await create('alpha.md', 'a')
        await create('Beta.md', 'b')
        await store.createDirectory(path('Middle'))
        await store.createDirectory(path('archive'))

        expect(outline(await store.tree())).toEqual([
          { directory: 'archive', children: [] },
          { directory: 'Middle', children: [] },
          { file: 'alpha.md' },
          { file: 'Beta.md' },
          { file: 'zeta.md' },
        ])
      })

      it('recurses, and sorts at every level', async () => {
        await create('work/standup.md', 's')
        await create('work/1on1.md', 'o')
        await create('work/projects/api.md', 'a')
        await create('inbox.md', 'i')

        expect(outline(await store.tree())).toEqual([
          {
            directory: 'work',
            children: [
              { directory: 'projects', children: [{ file: 'api.md' }] },
              { file: '1on1.md' },
              { file: 'standup.md' },
            ],
          },
          { file: 'inbox.md' },
        ])
      })

      it('carries file metadata', async () => {
        await create('note.md', 'body')

        const entries = await store.tree()
        const entry = entries[0]
        expect(entry?.kind).toBe('file')
        if (entry?.kind !== 'file') return

        expect(entry).toMatchObject({ path: 'note.md', name: 'note.md', size: 4 })
        expect(entry.modifiedAt).toBeGreaterThan(0)
      })
    })

    describe('move', () => {
      it('moves a note, preserving its content', async () => {
        const hash = await create('from.md', 'body')
        await store.move(path('from.md'), path('to.md'))

        expect(await store.read(path('from.md'))).toBeNull()
        const moved = await store.read(path('to.md'))
        expect(moved?.content).toBe('body')
        expect(moved?.hash).toBe(hash)
      })

      it('creates missing parent directories of the destination', async () => {
        await create('note.md', 'body')
        await store.move(path('note.md'), path('archive/2026/note.md'))

        expect((await store.read(path('archive/2026/note.md')))?.content).toBe('body')
      })

      it('leaves the source directory behind', async () => {
        await create('folder/note.md', 'body')
        await store.move(path('folder/note.md'), path('note.md'))

        expect(outline(await store.tree())).toEqual([
          { directory: 'folder', children: [] },
          { file: 'note.md' },
        ])
      })

      it('moves a directory and everything under it', async () => {
        await create('work/a.md', 'a')
        await create('work/deep/b.md', 'b')
        await store.move(path('work'), path('archive/work'))

        expect(await store.read(path('work/a.md'))).toBeNull()
        expect((await store.read(path('archive/work/a.md')))?.content).toBe('a')
        expect((await store.read(path('archive/work/deep/b.md')))?.content).toBe('b')
      })

      it('refuses to overwrite an existing destination', async () => {
        await create('from.md', 'from')
        await create('to.md', 'to')

        await expect(store.move(path('from.md'), path('to.md'))).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
        expect((await store.read(path('to.md')))?.content).toBe('to')
        expect((await store.read(path('from.md')))?.content).toBe('from')
      })

      it('refuses a destination occupied by a directory', async () => {
        await create('from.md', 'from')
        await store.createDirectory(path('to'))

        await expect(store.move(path('from.md'), path('to'))).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
      })

      it('throws when the source does not exist', async () => {
        await expect(store.move(path('nope.md'), path('to.md'))).rejects.toBeInstanceOf(
          NotFoundError,
        )
      })

      it('refuses to move a directory into itself', async () => {
        await create('work/a.md', 'a')

        await expect(store.move(path('work'), path('work/nested'))).rejects.toBeInstanceOf(
          NoteStoreError,
        )
      })
    })

    describe('remove', () => {
      it('deletes a note', async () => {
        await create('note.md', 'body')
        await store.remove(path('note.md'))

        expect(await store.read(path('note.md'))).toBeNull()
      })

      it('leaves the parent directory behind', async () => {
        await create('folder/note.md', 'body')
        await store.remove(path('folder/note.md'))

        expect(outline(await store.tree())).toEqual([{ directory: 'folder', children: [] }])
      })

      it('deletes a directory and everything under it', async () => {
        await create('work/a.md', 'a')
        await create('work/deep/b.md', 'b')
        await create('keep.md', 'k')

        await store.remove(path('work'))

        expect(await store.read(path('work/a.md'))).toBeNull()
        expect(await store.read(path('work/deep/b.md'))).toBeNull()
        expect(outline(await store.tree())).toEqual([{ file: 'keep.md' }])
      })

      it('throws when nothing is there', async () => {
        await expect(store.remove(path('nope.md'))).rejects.toBeInstanceOf(NotFoundError)
      })
    })

    describe('createDirectory', () => {
      it('creates an empty directory that shows up in the tree', async () => {
        await store.createDirectory(path('folder/nested'))

        expect(outline(await store.tree())).toEqual([
          { directory: 'folder', children: [{ directory: 'nested', children: [] }] },
        ])
      })

      it('is idempotent', async () => {
        await store.createDirectory(path('folder'))
        await store.createDirectory(path('folder'))

        expect(outline(await store.tree())).toEqual([{ directory: 'folder', children: [] }])
      })

      it('is idempotent for a directory that already holds notes', async () => {
        await create('folder/note.md', 'body')
        await store.createDirectory(path('folder'))

        expect(outline(await store.tree())).toEqual([
          { directory: 'folder', children: [{ file: 'note.md' }] },
        ])
      })

      it('throws when a note is already at the path', async () => {
        await create('note.md', 'body')

        await expect(store.createDirectory(path('note.md'))).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
        expect((await store.read(path('note.md')))?.content).toBe('body')
      })

      it('throws when a note is in the way of a parent', async () => {
        await create('note.md', 'body')

        await expect(store.createDirectory(path('note.md/nested'))).rejects.toBeInstanceOf(
          PathOccupiedError,
        )
      })
    })
  })
}
