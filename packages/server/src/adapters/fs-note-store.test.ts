import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { assertNotePath as notePath, FORCE_WRITE } from '@vim-notes/core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { hashContent } from './content-hash'
import { FsNoteStore } from './fs-note-store'
import { describeNoteStoreContract } from './note-store-contract'
import { NoteStoreError, PathEscapeError } from './note-store-common'

const temporaryRoots: string[] = []

/**
 * A fresh notes root under a fresh parent, so that tests which need a *sibling*
 * of the root -- the `/notes` vs `/notes-backup` prefix trap -- have somewhere
 * to put one.
 *
 * On macOS this lands under `/var/folders/...`, where `/var` is itself a
 * symlink to `/private/var`. That makes every test here an incidental check
 * that the root is realpath'd too: a naive implementation would decide the
 * notes root does not contain its own files.
 */
async function makeRoot(): Promise<{ root: string; parent: string }> {
  const parent = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-'))
  temporaryRoots.push(parent)

  const root = nodePath.join(parent, 'notes')
  await fs.mkdir(root)

  return { root, parent }
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

describeNoteStoreContract('FsNoteStore', async () => new FsNoteStore((await makeRoot()).root))

describe('FsNoteStore', () => {
  let root: string
  let parent: string
  let store: FsNoteStore

  beforeEach(async () => {
    ;({ root, parent } = await makeRoot())
    store = new FsNoteStore(root)
  })

  describe('construction', () => {
    it('refuses a relative notes root', () => {
      // The root comes from configuration, and a relative one would silently
      // mean "wherever the process happened to be started".
      expect(() => new FsNoteStore('notes')).toThrow(NoteStoreError)
    })
  })

  describe('containment', () => {
    it('refuses to read through a symlink pointing outside the root', async () => {
      // The case a string check cannot see: `notes-backup` is a sibling of
      // `notes`, so the resolved path even shares a prefix with the root.
      await fs.mkdir(nodePath.join(parent, 'notes-backup'))
      await fs.writeFile(nodePath.join(parent, 'notes-backup', 'secret.md'), 'not yours')
      await fs.symlink(nodePath.join(parent, 'notes-backup'), nodePath.join(root, 'backup'))

      await expect(store.read(notePath('backup/secret.md'))).rejects.toBeInstanceOf(PathEscapeError)
      await expect(store.stat(notePath('backup/secret.md'))).rejects.toBeInstanceOf(PathEscapeError)
    })

    it('refuses to write through a symlink pointing outside the root', async () => {
      await fs.mkdir(nodePath.join(parent, 'notes-backup'))
      await fs.symlink(nodePath.join(parent, 'notes-backup'), nodePath.join(root, 'backup'))

      // The destination does not exist yet, so containment has to be decided
      // from the deepest existing ancestor rather than from the target itself.
      await expect(
        store.write(notePath('backup/planted.md'), 'payload', null),
      ).rejects.toBeInstanceOf(PathEscapeError)
      await expect(
        store.write(notePath('backup/planted.md'), 'payload', FORCE_WRITE),
      ).rejects.toBeInstanceOf(PathEscapeError)

      expect(await fs.readdir(nodePath.join(parent, 'notes-backup'))).toEqual([])
    })

    it('refuses to follow a symlink to an absolute path outside the root', async () => {
      await fs.symlink('/etc', nodePath.join(root, 'system'))

      await expect(store.read(notePath('system/hosts'))).rejects.toBeInstanceOf(PathEscapeError)
      await expect(store.remove(notePath('system/hosts'))).rejects.toBeInstanceOf(PathEscapeError)
      await expect(
        store.move(notePath('system/hosts'), notePath('stolen.md')),
      ).rejects.toBeInstanceOf(PathEscapeError)
    })

    it('does not follow or list symlinks in the tree', async () => {
      await fs.mkdir(nodePath.join(parent, 'elsewhere'))
      await fs.writeFile(nodePath.join(parent, 'elsewhere', 'secret.md'), 'not yours')
      await fs.symlink(nodePath.join(parent, 'elsewhere'), nodePath.join(root, 'link'))
      await store.write(notePath('real.md'), 'body', null)

      expect(await store.tree()).toEqual([
        expect.objectContaining({ kind: 'file', name: 'real.md' }),
      ])
    })
  })

  describe('tree', () => {
    it('is empty when the notes root does not exist yet', async () => {
      // First boot against an empty volume: nothing there is not an error.
      const missing = new FsNoteStore(nodePath.join(parent, 'not-created-yet'))
      expect(await missing.tree()).toEqual([])
    })

    it('skips .git entirely', async () => {
      await fs.mkdir(nodePath.join(root, '.git', 'hooks'), { recursive: true })
      await fs.writeFile(nodePath.join(root, '.git', 'config'), '[core]')
      await store.write(notePath('note.md'), 'body', null)

      expect(await store.tree()).toEqual([
        expect.objectContaining({ kind: 'file', name: 'note.md' }),
      ])
    })

    it('skips names that core would refuse to address', async () => {
      // nvim can create these; the API can never open them, because there is no
      // NotePath for them. Listing them would only produce broken rows.
      await fs.writeFile(nodePath.join(root, 'aux.md'), 'windows-hostile')
      await fs.writeFile(nodePath.join(root, 'trailing.'), 'windows-hostile')
      await store.write(notePath('note.md'), 'body', null)

      expect((await store.tree()).map((entry) => entry.name)).toEqual(['note.md'])
    })

    it('lists unicode names', async () => {
      await store.write(notePath('日本語/メモ.md'), 'body', null)

      expect(await store.tree()).toEqual([
        expect.objectContaining({
          kind: 'directory',
          name: '日本語',
          children: [expect.objectContaining({ name: 'メモ.md' })],
        }),
      ])
    })
  })

  describe('atomic writes', () => {
    it('leaves no temporary files behind, on success or refusal', async () => {
      await store.write(notePath('note.md'), 'v1', null)
      await store.write(notePath('note.md'), 'v2', hashContent('nope'))

      expect(await fs.readdir(root)).toEqual(['note.md'])
    })

    it('leaves a reader that opened the note first with the whole old version', async () => {
      // The property atomicity actually buys, stated without a race: nvim has
      // the note open, the API saves over it, and nvim's handle still yields a
      // complete v1 rather than a truncated or interleaved buffer. Writing in
      // place would empty the file underneath that handle.
      const created = await store.write(notePath('note.md'), 'v1', null)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const reader = await fs.open(nodePath.join(root, 'note.md'), 'r')
      try {
        expect(
          (await store.write(notePath('note.md'), 'v2 is longer', created.metadata.hash)).ok,
        ).toBe(true)

        expect(await reader.readFile('utf8')).toBe('v1')
      } finally {
        await reader.close()
      }

      expect(await fs.readFile(nodePath.join(root, 'note.md'), 'utf8')).toBe('v2 is longer')
    })

    it('replaces the note with a new inode rather than rewriting it in place', async () => {
      // The mechanical signature of write-then-rename, and the reason the test
      // above can hold: the old inode survives for whoever still has it open.
      const created = await store.write(notePath('note.md'), 'v1', null)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const absolute = nodePath.join(root, 'note.md')
      const before = await fs.stat(absolute)

      expect((await store.write(notePath('note.md'), 'v2', created.metadata.hash)).ok).toBe(true)

      expect((await fs.stat(absolute)).ino).not.toBe(before.ino)
    })

    it('preserves the permissions of the note it replaces', async () => {
      // rename() swaps in a new inode, so a deliberately private note would
      // silently become world-readable without this.
      await store.write(notePath('private.md'), 'v1', null)
      const absolute = nodePath.join(root, 'private.md')
      await fs.chmod(absolute, 0o600)

      const hash = hashContent('v1')
      expect((await store.write(notePath('private.md'), 'v2', hash)).ok).toBe(true)
      expect((await fs.stat(absolute)).mode & 0o777).toBe(0o600)
    })
  })

  describe('the other writer', () => {
    it('notices a write that happened outside the API', async () => {
      // The nvim case, which is the entire reason for the hash check.
      const created = await store.write(notePath('note.md'), 'from the phone', null)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await fs.writeFile(nodePath.join(root, 'note.md'), 'from nvim')

      const outcome = await store.write(notePath('note.md'), 'phone edit', created.metadata.hash)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return

      expect(outcome.conflict).toEqual({
        kind: 'stale',
        expected: created.metadata.hash,
        actual: hashContent('from nvim'),
      })
      expect(await fs.readFile(nodePath.join(root, 'note.md'), 'utf8')).toBe('from nvim')
    })

    it('hashes the bytes on disk, not the decoded string', async () => {
      // A file nvim wrote in some other encoding still has to produce a hash
      // that changes when the file changes.
      const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe])
      await fs.writeFile(nodePath.join(root, 'binary.md'), bytes)

      const document = await store.read(notePath('binary.md'))
      expect(document?.hash).toBe(hashContent(bytes))
      expect(document?.size).toBe(4)
      // The decoded string is lossy, so hashing it would have been wrong.
      expect(document?.hash).not.toBe(hashContent(document?.content ?? ''))
    })
  })

  describe('write', () => {
    it('creates the notes root on first write', async () => {
      const fresh = new FsNoteStore(nodePath.join(parent, 'brand-new'))
      expect((await fresh.write(notePath('first.md'), 'body', null)).ok).toBe(true)

      expect((await fresh.read(notePath('first.md')))?.content).toBe('body')
    })
  })
})
