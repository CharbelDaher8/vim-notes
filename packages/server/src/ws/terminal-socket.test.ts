/**
 * Two kinds of test here, deliberately.
 *
 * The transport rules -- framing, debounce, back pressure, what happens to the
 * attachment when a socket dies -- are driven against a fake session, because
 * they are decisions this file makes and a real pty would only add latency and
 * timing noise to observing them.
 *
 * Reconnect is driven against a real pty, because it is not a decision this file
 * makes on its own: it is the interaction between a socket closing, a child that
 * keeps writing to nobody, and a ring that has to hand the next socket a stream
 * it can splice onto what it already has. A fake session would be testing the
 * fake.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import websocketPlugin from '@fastify/websocket'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { TerminalExit, Unsubscribe } from '@vim-notes/core'

import {
  NodePtyTerminalHost,
  type NodePtyTerminalHostOptions,
  type PtySession,
  type ScrollbackReplay,
} from '../adapters/node-pty-terminal-host'
import {
  attachTerminalSocket,
  openTerminalSession,
  terminalSocketPlugin,
  TERMINAL_CLOSE_EXITED,
  TERMINAL_CLOSE_PROTOCOL,
  type ServerControlFrame,
  type TerminalWebSocket,
} from './terminal-socket'

// --- doubles -----------------------------------------------------------------

type Listener = (...args: any[]) => void

class FakeSocket implements TerminalWebSocket {
  bufferedAmount = 0
  readonly sent: Array<string | Buffer> = []
  closedWith: { code?: number; reason?: string } | null = null

  private readonly listeners = new Map<string, Listener[]>()

  /** Set to make the next `send` throw, the way `ws` does on a dead socket. */
  failNextSend: Error | null = null

  send(data: string | Uint8Array): void {
    const failure = this.failNextSend
    if (failure !== null) {
      this.failNextSend = null
      throw failure
    }
    this.sent.push(typeof data === 'string' ? data : Buffer.from(data))
  }

  pings = 0
  terminated = false

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return
    this.closedWith = { code, reason }
    this.emit('close')
  }

  ping(): void {
    this.pings += 1
  }

  terminate(): void {
    this.terminated = true
  }

  /** What a live peer's WebSocket implementation does without being asked. */
  clientPong(): void {
    this.emit('pong')
  }

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  // --- what a test asks it ---

  control(): ServerControlFrame[] {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as ServerControlFrame)
  }

  frameOfType<T extends ServerControlFrame['type']>(
    type: T,
  ): Extract<ServerControlFrame, { type: T }> | undefined {
    return this.control().find(
      (frame): frame is Extract<ServerControlFrame, { type: T }> => frame.type === type,
    )
  }

  output(): Buffer {
    return Buffer.concat(this.sent.filter((frame): frame is Buffer => Buffer.isBuffer(frame)))
  }

  // --- what a client does to it ---

  clientBinary(data: Buffer | string): void {
    this.emit('message', Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), true)
  }

  clientControl(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'), false)
  }

  clientText(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'), false)
  }

  drop(): void {
    this.emit('close')
  }
}

class FakePtySession implements PtySession {
  readonly id = 'fake-session'
  cols = 80
  rows = 24
  exit: TerminalExit | null = null
  attachments = 0
  bytesProduced = 0

  readonly resizes: Array<[number, number]> = []
  readonly written: Buffer[] = []
  readonly killedWith: Array<string | undefined> = []
  pauseDepth = 0
  redraws = 0

  replay: ScrollbackReplay = { bytes: Buffer.alloc(0), offset: 0, reset: false }

  private readonly byteListeners = new Set<(chunk: Buffer) => void>()
  private readonly exitListeners = new Set<(exit: TerminalExit) => void>()

  write(data: string): void {
    this.writeBytes(Buffer.from(data, 'utf8'))
  }

  writeBytes(data: Buffer): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push([cols, rows])
  }

  nudgeRedraw(): void {
    this.redraws += 1
  }

  onData(): Unsubscribe {
    return () => {}
  }

  onBytes(listener: (chunk: Buffer) => void): Unsubscribe {
    this.byteListeners.add(listener)
    return () => this.byteListeners.delete(listener)
  }

  onExit(listener: (exit: TerminalExit) => void): Unsubscribe {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  scrollbackSince(): ScrollbackReplay {
    return this.replay
  }

  attach(): Unsubscribe {
    this.attachments += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.attachments -= 1
    }
  }

  pause(): void {
    this.pauseDepth += 1
  }

  resume(): void {
    this.pauseDepth -= 1
  }

  kill(signal?: string): void {
    this.killedWith.push(signal)
  }

  waitForExit(): Promise<TerminalExit> {
    return Promise.resolve(this.exit ?? { code: 0 })
  }

  // --- what a test makes it do ---

  emitBytes(data: string | Buffer): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    this.bytesProduced += chunk.length
    for (const listener of this.byteListeners) listener(chunk)
  }

  emitExit(exit: TerminalExit): void {
    this.exit = exit
    for (const listener of [...this.exitListeners]) listener(exit)
  }
}

// --- fixtures ----------------------------------------------------------------

const hosts: NodePtyTerminalHost[] = []
const roots: string[] = []
const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(hosts.splice(0).map((host) => host.killAll()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

interface Client {
  socket: WebSocket
  opened: Promise<void>
  frameOfType<T extends ServerControlFrame['type']>(
    type: T,
  ): Extract<ServerControlFrame, { type: T }> | undefined
  output(): Buffer
}

/**
 * A browser-shaped WebSocket client. The message listener is attached before the
 * open handshake finishes, because the server writes `ready` the instant its
 * route handler runs and a listener added afterwards has already missed it.
 */
function openClient(url: string): Client {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'

  const control: ServerControlFrame[] = []
  let output = Buffer.alloc(0)

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      control.push(JSON.parse(event.data) as ServerControlFrame)
      return
    }
    output = Buffer.concat([output, Buffer.from(event.data as ArrayBuffer)])
  })

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), {
      once: true,
    })
  })

  return {
    socket,
    opened,
    frameOfType: (type) =>
      control.find(
        (frame): frame is Extract<ServerControlFrame, { type: typeof type }> => frame.type === type,
      ),
    output: () => output,
  }
}

async function makeHost(
  options: Partial<NodePtyTerminalHostOptions> = {},
): Promise<NodePtyTerminalHost> {
  const root = nodePath.join(await fs.realpath(tmpdir()), `vim-notes-ws-${randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  roots.push(root)

  const host = new NodePtyTerminalHost({
    notesRoot: root,
    command: '/bin/sh',
    args: ['-c', 'cat'],
    ...options,
  })
  hosts.push(host)
  return host
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await delay(5)
  }
}

const FAST_RESIZE = { resizeIdleMs: 10, resizeMaxDelayMs: 40 }

describe('attachTerminalSocket', () => {
  it('announces the session before any output', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    session.replay = { bytes: Buffer.from('older output'), offset: 12, reset: true }

    attachTerminalSocket(socket, session, { resumed: true, cols: 100, rows: 40 })

    // Order is part of the contract: a client cannot know what to reset, or what
    // offset to count from, until `ready` has landed.
    expect(typeof socket.sent[0]).toBe('string')
    expect(socket.frameOfType('ready')).toEqual({
      type: 'ready',
      sessionId: 'fake-session',
      resumed: true,
      reset: true,
      offset: 12,
      cols: 100,
      rows: 40,
    })
    expect(socket.output().toString('utf8')).toBe('older output')
  })

  it('streams pty output as binary frames', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    session.emitBytes('┌───┐')

    expect(socket.output().equals(Buffer.from('┌───┐', 'utf8'))).toBe(true)
  })

  it('forwards binary frames to the pty untouched', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    const keystrokes = Buffer.from('i😀', 'utf8')
    socket.clientBinary(keystrokes)

    expect(Buffer.concat(session.written).equals(keystrokes)).toBe(true)
  })

  it('debounces a flood of resizes into one', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, FAST_RESIZE)

    for (let cols = 100; cols <= 120; cols++) {
      socket.clientControl({ type: 'resize', cols, rows: 40 })
    }

    expect(session.resizes).toHaveLength(0)

    await waitFor(() => session.resizes.length > 0)
    await delay(30)

    expect(session.resizes).toEqual([[120, 40]])
  })

  it('applies a resize within the ceiling even while they keep arriving', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, { resizeIdleMs: 1_000, resizeMaxDelayMs: 30 })

    socket.clientControl({ type: 'resize', cols: 110, rows: 40 })
    // A drag that never pauses would push a plain idle debounce back forever.
    const dragging = setInterval(
      () => socket.clientControl({ type: 'resize', cols: 111, rows: 41 }),
      5,
    )

    try {
      await waitFor(() => session.resizes.length > 0, 1_000)
    } finally {
      clearInterval(dragging)
    }
  })

  it('applies the last requested size even if the socket closes first', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, { resizeIdleMs: 1_000, resizeMaxDelayMs: 1_000 })

    socket.clientControl({ type: 'resize', cols: 132, rows: 50 })
    socket.drop()

    expect(session.resizes).toEqual([[132, 50]])
  })

  it('answers a ping', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    socket.clientControl({ type: 'ping' })

    expect(socket.frameOfType('pong')).toEqual({ type: 'pong' })
  })

  it('kills the session when the client asks it to', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    socket.clientControl({ type: 'kill' })

    expect(session.killedWith).toHaveLength(1)
  })

  it('reports a malformed control frame without ending the session', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    socket.clientText('{ not json')
    socket.clientControl({ type: 'resize', cols: 0, rows: -4 })
    socket.clientControl({ type: 'somethingNew' })

    expect(socket.control().filter((frame) => frame.type === 'error')).toHaveLength(3)
    expect(socket.closedWith).toBeNull()
    expect(session.attachments).toBe(1)
  })

  it('closes a connection that sends an oversized frame', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, { maxMessageBytes: 16 })

    socket.clientBinary(Buffer.alloc(64, 0x61))

    expect(session.written).toHaveLength(0)
    expect(socket.closedWith?.code).toBe(TERMINAL_CLOSE_PROTOCOL)
  })

  it('pauses the pty when the socket falls behind and resumes when it drains', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, {
      sendHighWaterMark: 100,
      sendLowWaterMark: 10,
      drainPollMs: 5,
    })

    socket.bufferedAmount = 500
    session.emitBytes('flood')
    expect(session.pauseDepth).toBe(1)

    // Still congested: no thrashing between paused and running.
    await delay(20)
    expect(session.pauseDepth).toBe(1)

    socket.bufferedAmount = 0
    await waitFor(() => session.pauseDepth === 0)
  })

  it('never leaves the pty paused when the socket dies mid-congestion', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, {
      sendHighWaterMark: 100,
      sendLowWaterMark: 10,
      drainPollMs: 5,
    })

    socket.bufferedAmount = 500
    session.emitBytes('flood')
    expect(session.pauseDepth).toBe(1)

    socket.drop()
    expect(session.pauseDepth).toBe(0)
  })

  it('detaches without killing the pty when the socket closes', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    expect(session.attachments).toBe(1)
    socket.drop()

    expect(session.attachments).toBe(0)
    expect(session.killedWith).toHaveLength(0)
    expect(session.exit).toBeNull()
  })

  it('stops writing to a socket that has gone', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    socket.drop()
    session.emitBytes('output nobody asked for')

    expect(socket.output()).toHaveLength(0)
  })

  it('reports the exit and closes', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session)

    session.emitExit({ code: 0, signal: undefined })

    expect(socket.frameOfType('exit')).toEqual({ type: 'exit', code: 0 })
    expect(socket.closedWith?.code).toBe(TERMINAL_CLOSE_EXITED)
    expect(session.attachments).toBe(0)
  })

  it('forces a repaint after a replay that could not be a continuation', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    session.replay = { bytes: Buffer.from('truncated history'), offset: 900, reset: true }

    attachTerminalSocket(socket, session)

    expect(session.redraws).toBe(1)
  })

  it('lets the resize do the repainting when the client arrived at a new size', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    session.replay = { bytes: Buffer.from('truncated history'), offset: 900, reset: true }

    attachTerminalSocket(socket, session, { cols: 120, rows: 50 })

    expect(session.resizes).toEqual([[120, 50]])
    expect(session.redraws).toBe(0)
  })

  it('does not repaint a session that has produced nothing yet', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    session.replay = { bytes: Buffer.alloc(0), offset: 0, reset: true }

    attachTerminalSocket(socket, session)

    expect(session.redraws).toBe(0)
  })

  it('tears down a connection that stops answering the heartbeat', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, { heartbeatMs: 10 })

    // A socket whose peer walked off a wifi network sends no close frame, so
    // nothing but this will ever release its attachment -- and until it does,
    // the reaper sees a session somebody is still using.
    await waitFor(() => socket.terminated)
    expect(session.attachments).toBe(0)
  })

  it('leaves a connection alone while its peer is still answering', async () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    attachTerminalSocket(socket, session, { heartbeatMs: 10 })

    const answering = setInterval(() => socket.clientPong(), 5)
    try {
      await waitFor(() => socket.pings >= 3)
    } finally {
      clearInterval(answering)
    }

    expect(socket.terminated).toBe(false)
    expect(session.attachments).toBe(1)
  })

  it('releases the attachment when a write to the socket throws', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()
    const errors: unknown[] = []

    attachTerminalSocket(socket, session, { onError: (error) => errors.push(error) })

    // `ws` throws on a socket that has already gone. Marking the connection dead
    // without unwinding the attachment would leave the session looking busy
    // forever, and the reaper would never touch it.
    socket.failNextSend = new Error('socket is not open')
    session.emitBytes('output into the void')

    expect(errors).toHaveLength(1)
    expect(session.attachments).toBe(0)
    expect(session.exit).toBeNull()
  })

  it('never subscribes a socket that failed on its very first write', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()

    socket.failNextSend = new Error('socket is not open')
    attachTerminalSocket(socket, session, { onError: () => {} })

    expect(session.attachments).toBe(0)

    // Listeners registered after teardown would never be removed by anything.
    session.emitBytes('later output')
    expect(socket.output()).toHaveLength(0)
  })

  it('returns a teardown that releases the attachment', () => {
    const socket = new FakeSocket()
    const session = new FakePtySession()

    const detach = attachTerminalSocket(socket, session)
    detach()

    expect(session.attachments).toBe(0)
    expect(session.exit).toBeNull()
  })
})

describe('reconnect against a real pty', () => {
  it('survives a dropped socket and hands the next one only what it missed', async () => {
    const host = await makeHost({ command: '/bin/sh', args: ['-c', 'printf first; cat'] })
    const session = await host.spawn({ cols: 80, rows: 24 })

    const first = new FakeSocket()
    attachTerminalSocket(first, session, FAST_RESIZE)
    await waitFor(() => first.output().toString('utf8').includes('first'))

    // Exactly the bookkeeping a browser client does: start where `ready` says,
    // add every binary frame, hand the total back as `after` next time.
    const consumed = (first.frameOfType('ready')?.offset ?? 0) + first.output().length

    first.drop()
    expect(session.exit).toBeNull()
    expect(host.get(session.id)).toBe(session)

    // The pty keeps working with nobody watching, which is the property the
    // whole design exists for.
    session.write('while away\n')
    await waitFor(() => session.bytesProduced > consumed)

    const second = new FakeSocket()
    attachTerminalSocket(second, session, { ...FAST_RESIZE, after: consumed, resumed: true })

    const ready = second.frameOfType('ready')
    expect(ready?.resumed).toBe(true)
    expect(ready?.reset).toBe(false)

    const resumedOutput = second.output().toString('utf8')
    expect(resumedOutput).toContain('while away')
    expect(resumedOutput).not.toContain('first')
  })

  it('replays the whole ring and asks for a reset when the client has no offset', async () => {
    const host = await makeHost({ command: '/bin/sh', args: ['-c', 'printf welcome; cat'] })
    const session = await host.spawn({ cols: 80, rows: 24 })

    const first = new FakeSocket()
    attachTerminalSocket(first, session, FAST_RESIZE)
    await waitFor(() => first.output().toString('utf8').includes('welcome'))
    first.drop()

    // A reloaded page: same session id in the URL, no idea how much it had seen.
    const second = new FakeSocket()
    attachTerminalSocket(second, session, { ...FAST_RESIZE, after: null, resumed: true })

    expect(second.frameOfType('ready')?.reset).toBe(true)
    expect(second.output().toString('utf8')).toContain('welcome')
  })

  it('carries keystrokes to the child and its output back', async () => {
    const host = await makeHost()
    const session = await host.spawn({ cols: 80, rows: 24 })

    const socket = new FakeSocket()
    attachTerminalSocket(socket, session, FAST_RESIZE)

    socket.clientBinary('héllo\n')

    await waitFor(() => socket.output().toString('utf8').includes('héllo'))
  })

  it('sends an exit frame when the child dies', async () => {
    const host = await makeHost({ command: '/bin/sh', args: ['-c', 'exit 7'] })
    const session = await host.spawn({ cols: 80, rows: 24 })

    const socket = new FakeSocket()
    attachTerminalSocket(socket, session, FAST_RESIZE)

    await waitFor(() => socket.frameOfType('exit') !== undefined)
    expect(socket.frameOfType('exit')?.code).toBe(7)
    expect(socket.closedWith?.code).toBe(TERMINAL_CLOSE_EXITED)
  })
})

/**
 * Over a real listening server and a real WebSocket, because the parts this
 * exercises are the ones a double cannot reproduce: the upgrade, the close
 * handshake, and `ws`'s decision about whether a frame was text or binary.
 *
 * The client is Node's global WebSocket, which is the same API the browser
 * gives xterm.js -- so `send(string)` and `send(Uint8Array)` land on the text
 * and binary sides of the protocol here exactly as they will from a real tab.
 *
 * Not `app.injectWS`: its in-process transport does not deliver the client's
 * close to the server side, which is the single most important event in this
 * file. A test that passed against it would be testing the harness.
 */
describe('terminalSocketPlugin', () => {
  it('speaks the protocol end to end and outlives the connection', async () => {
    const host = await makeHost()
    const app = Fastify()

    await app.register(websocketPlugin)
    await app.register(terminalSocketPlugin({ host, ...FAST_RESIZE }))
    const origin = await app.listen({ port: 0, host: '127.0.0.1' })
    servers.push(app)

    const first = openClient(`${origin.replace('http', 'ws')}/term/ws?cols=90&rows=30`)
    await first.opened

    await waitFor(() => first.frameOfType('ready') !== undefined)
    const ready = first.frameOfType('ready')
    expect(ready).toMatchObject({ resumed: false, reset: true, offset: 0, cols: 90, rows: 30 })

    const sessionId = ready?.sessionId ?? ''
    expect(host.get(sessionId)?.cols).toBe(90)

    first.socket.send(new TextEncoder().encode('typed by hand\n'))
    await waitFor(() => first.output().toString('utf8').includes('typed by hand'))

    first.socket.send(JSON.stringify({ type: 'ping' }))
    await waitFor(() => first.frameOfType('pong') !== undefined)

    first.socket.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }))
    await waitFor(() => host.get(sessionId)?.cols === 132)

    const consumed = (ready?.offset ?? 0) + first.output().length

    // Closing the connection is not closing the editor.
    first.socket.close()
    await waitFor(() => host.get(sessionId)?.attachments === 0)
    expect(host.get(sessionId)?.exit).toBeNull()

    // ...and the pty keeps working while nothing is listening.
    host.get(sessionId)?.write('offline edit\n')
    await waitFor(() => (host.get(sessionId)?.bytesProduced ?? 0) > consumed)

    const second = openClient(
      `${origin.replace('http', 'ws')}/term/ws?session=${sessionId}&after=${consumed}&cols=132&rows=43`,
    )
    await second.opened
    await waitFor(() => second.frameOfType('ready') !== undefined)

    expect(second.frameOfType('ready')).toMatchObject({ resumed: true, reset: false })
    await waitFor(() => second.output().toString('utf8').includes('offline edit'))
    expect(second.output().toString('utf8')).not.toContain('typed by hand')

    second.socket.close()
  })

  it('registers @fastify/websocket itself when the application has not', async () => {
    const host = await makeHost()
    const app = Fastify()

    await app.register(terminalSocketPlugin({ host, path: '/terminal' }))

    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })
})

describe('openTerminalSession', () => {
  it('starts a new session when none was asked for', async () => {
    const host = await makeHost()

    const opened = await openTerminalSession(host, { cols: 100, rows: 40 })

    expect(opened.resumed).toBe(false)
    expect(opened.after).toBeNull()
    expect(opened.session.cols).toBe(100)
  })

  it('resumes a live session', async () => {
    const host = await makeHost()
    const existing = await host.spawn({ cols: 80, rows: 24 })

    const opened = await openTerminalSession(host, { session: existing.id, after: 42 })

    expect(opened.session).toBe(existing)
    expect(opened.resumed).toBe(true)
    expect(opened.after).toBe(42)
  })

  it('starts fresh, and drops the offset, when the session is gone', async () => {
    const host = await makeHost()

    const opened = await openTerminalSession(host, { session: randomUUID(), after: 42 })

    // Keeping the offset would replay a stranger's screen: it was counted
    // against a pty that no longer exists.
    expect(opened.resumed).toBe(false)
    expect(opened.after).toBeNull()
  })

  it('does not resume a session whose child has exited', async () => {
    const host = await makeHost({ command: '/bin/sh', args: ['-c', 'exit 0'] })
    const dead = await host.spawn({ cols: 80, rows: 24 })
    await dead.waitForExit()

    const opened = await openTerminalSession(host, { session: dead.id })

    expect(opened.session).not.toBe(dead)
    expect(opened.resumed).toBe(false)
  })
})
