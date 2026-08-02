import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { assertNotePath as notePath, type FileChangeEvent } from '@vim-notes/core'
import { afterEach, describe, expect, it } from 'vitest'

import { ChokidarFileWatcher } from './chokidar-file-watcher'
import { hashContent } from './content-hash'
import { FsNoteStore, isTemporaryFileName, temporaryFileName } from './fs-note-store'
import { WriteJournal } from './write-journal'

/**
 * These run against a real directory and a real watcher, because the thing
 * worth testing is precisely the part a fake would paper over: what the
 * filesystem actually reports when a note is renamed into place.
 *
 * Every wait is on a condition rather than a fixed delay, except where the
 * assertion is "and then nothing happened", which cannot be expressed any other
 * way.
 *
 * Polling rather than kernel notifications, deliberately. With FSEvents these
 * tests failed roughly one run in three under the full suite -- a different test
 * each time, always a timeout waiting for an event that never arrived, because
 * macOS drops recursive-watch events when several workers hammer temp
 * directories at once. Polling is the same code path from the debounce onwards;
 * only the source of the raw event differs, and it is a supported production
 * mode besides.
 */
const started: ChokidarFileWatcher[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((watcher) => watcher.close()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

interface Harness {
  root: string
  watcher: ChokidarFileWatcher
  events: FileChangeEvent[]
  errors: unknown[]
  journal: WriteJournal
  store: FsNoteStore
}

async function harness(options: { debounceMs?: number } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-watch-'))
  roots.push(root)

  const journal = new WriteJournal()
  const events: FileChangeEvent[] = []
  const errors: unknown[] = []

  const watcher = await ChokidarFileWatcher.start(root, {
    journal,
    debounceMs: options.debounceMs ?? 20,
    usePolling: true,
    pollIntervalMs: 10,
    onError: (error) => errors.push(error),
  })
  started.push(watcher)
  watcher.subscribe((event) => events.push(event))

  return {
    root,
    watcher,
    events,
    errors,
    journal,
    store: new FsNoteStore(root, { observer: journal }),
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A write by something that is not this server: nvim, git, a stray `cp`. */
async function writeOutside(root: string, relative: string, content: string): Promise<void> {
  const absolute = nodePath.join(root, relative)
  await fs.mkdir(nodePath.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, content)
}

describe('ChokidarFileWatcher', () => {
  describe('what it reports', () => {
    it('reports a new note as created, with its hash', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'note.md', 'hello')
      await waitFor(() => events.length === 1, 'the created event')

      expect(events[0]).toMatchObject({
        kind: 'created',
        path: 'note.md',
        hash: hashContent('hello'),
      })
      expect(events[0]?.at).toBeGreaterThan(0)
    })

    it('reports an edit as modified', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => events.length === 1, 'the created event')

      await writeOutside(root, 'note.md', 'v2')
      await waitFor(() => events.length === 2, 'the modified event')

      expect(events[1]).toMatchObject({ kind: 'modified', hash: hashContent('v2') })
    })

    it('reports a removal as deleted, with no hash', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => events.length === 1, 'the created event')

      await fs.rm(nodePath.join(root, 'note.md'))
      await waitFor(() => events.length === 2, 'the deleted event')

      expect(events[1]).toMatchObject({ kind: 'deleted', path: 'note.md', hash: null })
    })

    it('reports notes in subdirectories', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'work/deep/note.md', 'nested')
      await waitFor(() => events.length === 1, 'the nested event')

      expect(events[0]?.path).toBe('work/deep/note.md')
    })
  })

  describe('what it stays quiet about', () => {
    it('says nothing about .git', async () => {
      // A commit rewrites a great deal in here, and none of it is a note.
      const { root, events } = await harness()

      await writeOutside(root, '.git/index', 'binary-ish')
      await writeOutside(root, '.git/refs/heads/main', 'deadbeef')
      await writeOutside(root, 'note.md', 'real')

      await waitFor(() => events.length === 1, 'the note event')
      await settle()

      expect(events.map((event) => event.path)).toEqual(['note.md'])
    })

    it('reports a save through the store as exactly one event', async () => {
      const { store, events } = await harness()

      expect((await store.write(notePath('note.md'), 'v1', null)).ok).toBe(true)
      await waitFor(() => events.length === 1, 'the write event')
      await settle()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'created', path: 'note.md' })
    })

    it('says nothing about a temporary file that outlives the write', async () => {
      // The test above passes even with the filter removed, because a file that
      // appears and vanishes inside one debounce window is suppressed anyway.
      // This one isolates the filter: a scratch file that sticks around -- a
      // slow write still in flight, or the leftovers of a crash -- is a path no
      // client has ever heard of and must stay invisible.
      const { root, events } = await harness()

      const scratch = temporaryFileName('note.md')
      // The two halves of the naming scheme have to agree, or the filter
      // silently stops matching what the store actually writes.
      expect(isTemporaryFileName(scratch)).toBe(true)

      await writeOutside(root, scratch, 'half-written')
      await writeOutside(root, 'note.md', 'real')

      // Waiting on the note rather than on a count, so that an unwanted extra
      // event fails the assertion below instead of timing out here.
      await waitFor(() => events.some((event) => event.path === 'note.md'), 'the real note event')
      await settle()

      expect(events.map((event) => event.path)).toEqual(['note.md'])
    })

    it('still reports a note that merely looks like a temporary file', async () => {
      // `.draft.tmp` is a legitimate note, and hiding it would be a bug. Only
      // the store's own UUID-bearing scheme is filtered.
      const { root, events } = await harness()

      await writeOutside(root, '.draft.tmp', 'a real note with an odd name')
      await waitFor(() => events.length === 1, 'the note event')

      expect(events[0]?.path).toBe('.draft.tmp')
    })

    it('says nothing when a save did not change the content', async () => {
      // `:w` on an unmodified buffer still moves mtime. The client's copy is
      // already right, and reloading it would move the cursor for nothing.
      const { root, events } = await harness()

      await writeOutside(root, 'note.md', 'same')
      await waitFor(() => events.length === 1, 'the created event')

      await writeOutside(root, 'note.md', 'same')
      await settle()

      expect(events).toHaveLength(1)
    })

    it('says nothing about names core would refuse to address', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'aux.md', 'windows-hostile')
      await writeOutside(root, 'note.md', 'fine')

      await waitFor(() => events.length === 1, 'the addressable event')
      await settle()

      expect(events.map((event) => event.path)).toEqual(['note.md'])
    })

    it('collapses a burst of writes into one event', async () => {
      const { root, events } = await harness({ debounceMs: 120 })

      for (const version of ['v1', 'v2', 'v3', 'v4', 'v5']) {
        await writeOutside(root, 'note.md', version)
      }

      await waitFor(() => events.length >= 1, 'the coalesced event')
      await settle()

      expect(events).toHaveLength(1)
      // And it describes where the file ended up, not where the burst started.
      expect(events[0]?.hash).toBe(hashContent('v5'))
    })
  })

  describe('origin', () => {
    it('labels the API its own writes, so the client can ignore its echo', async () => {
      const { store, events } = await harness()

      expect((await store.write(notePath('note.md'), 'from the phone', null)).ok).toBe(true)
      await waitFor(() => events.length === 1, 'the write event')

      expect(events[0]?.origin).toBe('api')
    })

    it('labels a write by anything else as not the API', async () => {
      const { root, events } = await harness()

      await writeOutside(root, 'note.md', 'from nvim')
      await waitFor(() => events.length === 1, 'the event')

      expect(events[0]?.origin).toBe('unknown')
    })

    it('does not claim a foreign write that lands right after one of ours', async () => {
      // The dangerous misattribution: if this said 'api', the client would
      // ignore it and quietly lose what nvim wrote.
      const { root, store, events } = await harness()

      expect((await store.write(notePath('note.md'), 'from the phone', null)).ok).toBe(true)
      await waitFor(() => events.length === 1, 'the api event')

      await writeOutside(root, 'note.md', 'from nvim, immediately after')
      await waitFor(() => events.length === 2, 'the foreign event')

      expect(events[0]?.origin).toBe('api')
      expect(events[1]?.origin).not.toBe('api')
    })

    it('labels a removal made through the store as api', async () => {
      const { store, events } = await harness()

      expect((await store.write(notePath('note.md'), 'v1', null)).ok).toBe(true)
      await waitFor(() => events.length === 1, 'the create')

      await store.remove(notePath('note.md'))
      await waitFor(() => events.length === 2, 'the delete')

      expect(events[1]).toMatchObject({ kind: 'deleted', origin: 'api' })
    })

    it('labels changes as git when git has just touched its index', async () => {
      const { root, events } = await harness()

      // What a pull or a rebase leaves behind, without running git for real.
      await fs.mkdir(nodePath.join(root, '.git'), { recursive: true })
      await fs.writeFile(nodePath.join(root, '.git', 'index'), 'x')

      await writeOutside(root, 'landed-by-pull.md', 'content')
      await waitFor(() => events.length === 1, 'the event')

      expect(events[0]?.origin).toBe('git')
    })

    it('does not call it git once the window has passed', async () => {
      const { root, events } = await harness()

      await fs.mkdir(nodePath.join(root, '.git'), { recursive: true })
      const index = nodePath.join(root, '.git', 'index')
      await fs.writeFile(index, 'x')

      const longAgo = new Date(Date.now() - 60_000)
      await fs.utimes(index, longAgo, longAgo)

      await writeOutside(root, 'note.md', 'content')
      await waitFor(() => events.length === 1, 'the event')

      expect(events[0]?.origin).toBe('unknown')
    })
  })

  describe('subscription', () => {
    it('delivers to every subscriber', async () => {
      const { root, watcher } = await harness()
      const first: FileChangeEvent[] = []
      const second: FileChangeEvent[] = []
      watcher.subscribe((event) => first.push(event))
      watcher.subscribe((event) => second.push(event))

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => first.length === 1 && second.length === 1, 'both subscribers')
    })

    it('stops delivering after unsubscribe', async () => {
      const { root, watcher } = await harness()
      const seen: FileChangeEvent[] = []
      const unsubscribe = watcher.subscribe((event) => seen.push(event))

      unsubscribe()
      await writeOutside(root, 'note.md', 'v1')
      await settle()

      expect(seen).toEqual([])
    })

    it('has an idempotent unsubscribe that does not cancel an identical listener', async () => {
      const { root, watcher, events } = await harness()
      const seen: FileChangeEvent[] = []
      const listener = (event: FileChangeEvent) => seen.push(event)

      const first = watcher.subscribe(listener)
      watcher.subscribe(listener)

      first()
      first()

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => events.length === 1, 'the event')

      // The second subscription of the same function is still live.
      expect(seen).toHaveLength(1)
    })

    it('keeps going when a subscriber throws', async () => {
      const { root, watcher, events, errors } = await harness()
      watcher.subscribe(() => {
        throw new Error('subscriber exploded')
      })
      const after: FileChangeEvent[] = []
      watcher.subscribe((event) => after.push(event))

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => events.length === 1 && after.length === 1, 'the surviving subscribers')

      expect(errors).toHaveLength(1)
    })
  })

  describe('close', () => {
    it('stops reporting and releases the watches', async () => {
      const { root, watcher, events } = await harness()

      await writeOutside(root, 'note.md', 'v1')
      await waitFor(() => events.length === 1, 'the first event')

      await watcher.close()

      await writeOutside(root, 'after-close.md', 'v1')
      await settle()

      expect(events).toHaveLength(1)
    })

    it('is idempotent', async () => {
      const { watcher } = await harness()

      await watcher.close()
      await watcher.close()
      await Promise.all([watcher.close(), watcher.close()])
    })
  })
})
