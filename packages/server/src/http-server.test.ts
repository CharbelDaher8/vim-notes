/**
 * The transport, exercised over a real socket against the real assembly.
 *
 * Everything here is deliberately black-box: it starts the server the way
 * main.ts starts it, opens a browser-grade `WebSocket` at the URL a browser
 * would use, and speaks tRPC's wire protocol by hand rather than through the
 * client. A test that imported the client and the router and called one from
 * the other would pass with `useWSS` switched off, with the plugin registered
 * in the wrong scope, and with the socket mounted at a path nothing serves --
 * which is the exact family of bug this file exists to catch.
 */
import {
  toContentHash,
  toNotePath,
  type FileChangeEvent,
  type FileWatcher,
  type Unsubscribe,
} from '@vim-notes/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { InMemoryNoteStore } from './adapters/in-memory-note-store'
import type { AppContext } from './api/trpc'
import { buildHttpServer } from './http-server'
import type { PtySessionHost } from './ws/terminal-socket'

class FakeFileWatcher implements FileWatcher {
  private readonly listeners = new Set<(event: FileChangeEvent) => void>()

  subscribe(listener: (event: FileChangeEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: FileChangeEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  async close(): Promise<void> {}
}

/** Registered, never connected to. The terminal has its own tests. */
const terminals: PtySessionHost = {
  spawn: () => {
    throw new Error('the terminal is not part of this test')
  },
  get: () => null,
}

const running: FastifyInstance[] = []
const openSockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close()
  for (const fastify of running.splice(0)) await fastify.close()
})

async function startServer(files: Record<string, string> = {}) {
  const notes = new InMemoryNoteStore()
  await notes.seed(files)

  const watcher = new FakeFileWatcher()

  // Only `notes` and `watcher` are reachable from what this exercises, so the
  // rest are left out rather than stubbed -- a stub that is never called is a
  // stub that will rot. Same reasoning as the index router's tests.
  const context = { notes, watcher } as unknown as AppContext

  const fastify = await buildHttpServer({ context, terminals, logger: false })
  running.push(fastify)

  await fastify.listen({ host: '127.0.0.1', port: 0 })

  const address = fastify.server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')

  return { fastify, watcher, origin: `127.0.0.1:${address.port}` }
}

/**
 * tRPC's WebSocket protocol, as a browser sees it. One JSON object per text
 * frame: the client names a request id and a procedure path, the server
 * answers `started` once and then a `data` message per emission.
 */
function connect(origin: string): {
  socket: WebSocket
  next: (predicate: (message: any) => boolean) => Promise<any>
} {
  const socket = new WebSocket(`ws://${origin}/trpc`)
  openSockets.push(socket)

  const received: any[] = []
  const waiting: Array<{ predicate: (message: any) => boolean; resolve: (m: any) => void }> = []

  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data))
    received.push(message)

    const index = waiting.findIndex((waiter) => waiter.predicate(message))
    if (index >= 0) waiting.splice(index, 1)[0]?.resolve(message)
  })

  const next = (predicate: (message: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const already = received.find(predicate)
      if (already !== undefined) {
        resolve(already)
        return
      }

      // A hang here is the interesting failure -- a socket that connected and
      // then delivered nothing -- so it has to fail rather than time the suite
      // out with no clue which step never happened.
      const timer = setTimeout(() => reject(new Error('no matching message within 5s')), 5_000)
      waiting.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })

  return { socket, next }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('socket failed to open')))
  })
}

describe('http server', () => {
  it('serves queries over HTTP under the prefix', async () => {
    const { fastify } = await startServer({ 'projects/roadmap.md': '# Roadmap\n' })

    const response = await fastify.inject({ method: 'GET', url: '/trpc/notes.tree' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      result: { data: [{ kind: 'directory', name: 'projects' }] },
    })
  })

  it('upgrades at the prefix itself and streams file changes', async () => {
    const { watcher, origin } = await startServer()
    const { socket, next } = connect(origin)

    await opened(socket)

    socket.send(
      JSON.stringify({ id: 1, method: 'subscription', params: { path: 'notes.changes' } }),
    )
    await next((message) => message.result?.type === 'started')

    // Only now is the watcher subscription live; emitting before `started`
    // would race the subscribe and make this test flaky rather than wrong.
    expect(watcher.subscriberCount).toBe(1)

    const change: FileChangeEvent = {
      kind: 'modified',
      path: toNotePath('journal/2026-08-03.md'),
      hash: toContentHash('abc123'),
      at: 1_754_179_200_000,
      origin: 'git',
    }
    watcher.emit(change)

    const message = await next((candidate) => candidate.result?.type === 'data')

    // Byte for byte. `origin` in particular: the client's echo suppression is
    // built on it, and a transport that helpfully normalised it would break
    // reconciliation in a way no client-side test could see.
    expect(message.result.data).toEqual(change)
  })

  it('releases the watcher subscription when the client stops', async () => {
    const { watcher, origin } = await startServer()
    const { socket, next } = connect(origin)

    await opened(socket)

    socket.send(
      JSON.stringify({ id: 7, method: 'subscription', params: { path: 'notes.changes' } }),
    )
    await next((message) => message.result?.type === 'started')

    socket.send(JSON.stringify({ id: 7, method: 'subscription.stop' }))
    await next((message) => message.result?.type === 'stopped')

    // A watcher accumulating a listener per connection is how a long-lived
    // server ends up delivering one event a hundred times.
    expect(watcher.subscriberCount).toBe(0)
  })

  it('drops the subscription when the socket goes away', async () => {
    const { watcher, origin } = await startServer()
    const { socket, next } = connect(origin)

    await opened(socket)

    socket.send(
      JSON.stringify({ id: 1, method: 'subscription', params: { path: 'notes.changes' } }),
    )
    await next((message) => message.result?.type === 'started')

    socket.close()

    await expect.poll(() => watcher.subscriberCount, { timeout: 5_000 }).toBe(0)
  })
})
