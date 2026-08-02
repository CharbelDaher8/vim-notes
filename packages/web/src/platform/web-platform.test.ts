/**
 * What this asserts is the *procedure path* each port method reaches for, and
 * that is on purpose.
 *
 * The types now guarantee that whatever `WebPlatform` calls exists on the
 * router, but they said nothing at all while the client was typed against a
 * hand-written interface -- and under that interface this file called
 * `notesIndex.*` for routes the router mounts under `index`, and `search.query`
 * for a procedure that is reached as `search.query.query`. Both would have
 * failed on the first real request and neither was visible to a test that only
 * checked the values coming back.
 */
import { FORCE_WRITE, toContentHash, toNotePath, type FileChangeEvent } from '@vim-notes/core'
import { describe, expect, it, vi } from 'vitest'

import type { NotesClient } from './trpc-client'
import { WebPlatform } from './web-platform'

interface RecordedCall {
  path: string
  input: unknown
  /** Second argument. Only subscriptions have one; it carries the listeners. */
  handlers: unknown
}

/**
 * A stand-in for the tRPC proxy client, built the way the real one is: any
 * property access extends a path, and calling it is the request. That is what
 * lets the path itself be the thing under test.
 */
function recordingClient(result: unknown = null): {
  calls: RecordedCall[]
  unsubscribe: () => void
  client: NotesClient
} {
  const calls: RecordedCall[] = []
  const unsubscribe = vi.fn()

  const at = (segments: string[]): any =>
    new Proxy(() => undefined, {
      get: (_target, key) => (typeof key === 'string' ? at([...segments, key]) : undefined),
      apply: (_target, _thisArg, args: unknown[]) => {
        const path = segments.join('.')
        calls.push({ path, input: args[0], handlers: args[1] })

        // Subscriptions answer with a handle rather than a promise, and the
        // listener is the second argument rather than the input.
        if (segments[segments.length - 1] === 'subscribe') return { unsubscribe }

        return Promise.resolve(result)
      },
    })

  return { calls, unsubscribe, client: at([]) as NotesClient }
}

describe('WebPlatform', () => {
  it('reads and writes notes through the notes router', async () => {
    const { calls, client } = recordingClient()
    const platform = new WebPlatform(client)

    await platform.tree()
    await platform.read(toNotePath('projects/roadmap.md'))
    await platform.move(toNotePath('a.md'), toNotePath('b.md'))
    await platform.remove(toNotePath('a.md'))
    await platform.createDirectory(toNotePath('archive'))

    expect(calls.map((call) => call.path)).toEqual([
      'notes.tree.query',
      'notes.read.query',
      'notes.move.mutate',
      'notes.remove.mutate',
      'notes.createDirectory.mutate',
    ])
  })

  it('sends an expected hash as an ordinary write', async () => {
    const { calls, client } = recordingClient()

    await new WebPlatform(client).write(toNotePath('note.md'), 'hello', toContentHash('deadbeef'))

    expect(calls[0]).toEqual({
      path: 'notes.write.mutate',
      input: { path: 'note.md', content: 'hello', expected: 'deadbeef', force: false },
    })
  })

  it('turns FORCE_WRITE into the force flag, because a symbol cannot be sent', async () => {
    const { calls, client } = recordingClient()

    await new WebPlatform(client).write(toNotePath('note.md'), 'mine', FORCE_WRITE)

    expect(calls[0]).toEqual({
      path: 'notes.write.mutate',
      input: { path: 'note.md', content: 'mine', expected: null, force: true },
    })
  })

  it('fills in the search defaults the router requires', async () => {
    const { calls, client } = recordingClient([])

    await new WebPlatform(client).search({ pattern: 'roadmap' })

    expect(calls[0]).toEqual({
      path: 'search.query.query',
      input: {
        pattern: 'roadmap',
        regex: false,
        caseSensitive: false,
        under: undefined,
        limit: 100,
      },
    })
  })

  it('reaches the derived views under index, not notesIndex', async () => {
    const { calls, client } = recordingClient([])
    const platform = new WebPlatform(client)

    await platform.annotations({ kind: 'todo' })
    await platform.backlinks(toNotePath('projects/roadmap.md'))
    await platform.graph()

    expect(calls).toEqual([
      { path: 'index.annotations.query', input: { kind: 'todo' } },
      { path: 'index.backlinks.query', input: { path: 'projects/roadmap.md' } },
      { path: 'index.graph.query', input: undefined },
    ])
  })

  it('subscribes to changes and hands the event through untouched', () => {
    const { calls, client, unsubscribe } = recordingClient()
    const seen: FileChangeEvent[] = []

    const stop = new WebPlatform(client).subscribeToChanges((event) => seen.push(event))

    const call = calls[0]
    expect(call?.path).toBe('notes.changes.subscribe')
    expect(call?.input).toBeUndefined()

    const event: FileChangeEvent = {
      kind: 'modified',
      path: toNotePath('journal/2026-08-03.md'),
      hash: toContentHash('abc123'),
      at: 1_754_179_200_000,
      origin: 'terminal',
    }
    ;(call?.handlers as { onData: (event: FileChangeEvent) => void }).onData(event)

    // Delivered as-is. `origin` above all: the platform must not swallow its
    // own echo here, because a second browser tab is also `api` and to that
    // tab the change is news. Filtering is the listener's job.
    expect(seen).toEqual([event])

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
