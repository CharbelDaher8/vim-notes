/**
 * Two suites, for two kinds of question.
 *
 * `NodePtyTerminalHost` drives real ptys. Mocking node-pty would leave every
 * property worth testing there untested -- chunk boundaries are decided by the
 * kernel's tty buffer, SIGWINCH is delivered by the OS, and a mock's idea of
 * when a child dies is not the one that matters. `sh` and `cat` stand in for
 * nvim so the suite stays fast; nothing under test cares which program is on the
 * other end of the fd.
 *
 * `exit and the drain that follows it` drives a fake pty, for the opposite
 * reason. The property it covers is an *ordering* -- what happens to output that
 * lands after the child has been reaped -- and a real kernel will not order two
 * events on request. Left to a real pty this is a race that resolves one way on
 * a quiet laptop and the other way on a loaded CI runner, which is the same as
 * saying it is untested everywhere it passes. A fake pty turns the ordering into
 * something a test states outright.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import type { IDisposable, IPty } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'

import {
  NodePtyTerminalHost,
  TerminalHostError,
  type NodePtyTerminalHostOptions,
  type PtySession,
} from './node-pty-terminal-host'
import { itPtyDelivery } from './pty-delivery-gate'

const hosts: NodePtyTerminalHost[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.killAll()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

/** realpath'd because macOS hands out a symlinked tmpdir and `pwd` does not. */
async function makeRoot(): Promise<string> {
  const base = await fs.realpath(tmpdir())
  const root = nodePath.join(base, `vim-notes-pty-${randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

function makeHost(
  notesRoot: string,
  options: Partial<NodePtyTerminalHostOptions> = {},
): NodePtyTerminalHost {
  const host = new NodePtyTerminalHost({
    notesRoot,
    command: '/bin/sh',
    args: ['-c', 'cat'],
    ...options,
  })
  hosts.push(host)
  return host
}

function collect(session: PtySession): { bytes(): Buffer; text(): string } {
  const chunks: Buffer[] = []
  let decoded = ''

  session.onBytes((chunk) => chunks.push(chunk))
  session.onData((chunk) => {
    decoded += chunk
  })

  return { bytes: () => Buffer.concat(chunks), text: () => decoded }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await delay(5)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Says how `got` differs from `expected` in terms that name a cause.
 *
 * `equals` answers a yes/no question, and for a byte stream that has been
 * through a kernel that is not the one running the assertion, the interesting
 * part is *which* bytes and *where*. A truncated-but-otherwise-exact stream and
 * a stream with an interior hole fail the same assertion and are not the same
 * bug.
 */
function describeAgainst(got: Buffer, expected: Buffer): string {
  if (got.equals(expected)) return 'identical'

  const shared = Math.min(got.length, expected.length)
  let diverged = shared
  for (let i = 0; i < shared; i++) {
    if (got[i] !== expected[i]) {
      diverged = i
      break
    }
  }

  if (diverged === shared) {
    const missing = expected.length - got.length
    return missing > 0
      ? `truncated: an exact prefix, ${missing} of ${expected.length} trailing bytes never arrived`
      : `overlong: an exact prefix followed by ${-missing} unexpected trailing bytes`
  }

  return (
    `diverges at byte ${diverged} of ${expected.length} ` +
    `(got ${hexAround(got, diverged)}, expected ${hexAround(expected, diverged)}); ` +
    `lengths ${got.length} and ${expected.length}`
  )
}

function hexAround(buffer: Buffer, at: number): string {
  return buffer.subarray(at, at + 8).toString('hex')
}

/**
 * Prints `rows cols` every time the kernel delivers SIGWINCH -- the same signal
 * nvim redraws on, which is the thing a resize has to actually cause. `armed` is
 * printed after the trap is installed so the test never signals a shell that is
 * not listening yet. The sleep loop keeps it alive and short enough that the
 * trap runs promptly, since a POSIX shell defers traps until the running command
 * returns.
 */
const WINCH_REPORTER = 'trap "stty size" WINCH; printf armed; while true; do sleep 0.05; done'

describe('NodePtyTerminalHost', () => {
  it('rejects a notes root that is not absolute', async () => {
    expect(() => new NodePtyTerminalHost({ notesRoot: 'notes' })).toThrow(TerminalHostError)
  })

  it('starts the child in the notes root', async () => {
    const root = await makeRoot()
    // /bin/pwd rather than the shell builtin: the builtin trusts an inherited
    // $PWD, which here points at wherever vitest was started.
    const host = makeHost(root, { command: '/bin/pwd', args: [] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    const output = collect(session)

    await session.waitForExit()
    expect(output.text().trim()).toBe(root)
  })

  it('refuses to let the caller describe the child process', async () => {
    const root = await makeRoot()
    const host = makeHost(root)

    await expect(host.spawn({ cols: 80, rows: 24, command: '/bin/sh' })).rejects.toThrow(
      TerminalHostError,
    )
    await expect(host.spawn({ cols: 80, rows: 24, args: ['-c', 'id'] })).rejects.toThrow(
      TerminalHostError,
    )
    await expect(host.spawn({ cols: 80, rows: 24, cwd: '/etc' })).rejects.toThrow(TerminalHostError)
    await expect(
      host.spawn({ cols: 80, rows: 24, env: { LD_PRELOAD: '/tmp/x.so' } }),
    ).rejects.toThrow(TerminalHostError)

    expect(host.list()).toHaveLength(0)
  })

  it('clamps dimensions a caller got wrong', async () => {
    const root = await makeRoot()
    const host = makeHost(root)

    const session = await host.spawn({ cols: 0, rows: 10_000 })
    expect(session.cols).toBe(1)
    expect(session.rows).toBe(1000)
  })

  // The one case in this file that asserts pty *delivery* rather than this
  // adapter's behaviour, so it carries the same Linux-CI flake as the
  // diagnostic and is gated the same way. Everything else here runs everywhere.
  itPtyDelivery(
    'delivers output as bytes and holds multibyte characters across chunk boundaries',
    async () => {
      const root = await makeRoot()

      // Big enough that the tty buffer splits it into a couple of hundred reads,
      // and made entirely of three- and four-byte characters so most of those
      // splits land mid-character. Decoding chunk-at-a-time turns this into a
      // screenful of replacement characters, which is exactly the bug the
      // StringDecoder in the session exists to prevent.
      const content = '─'.repeat(60_000) + '😀'.repeat(5_000)
      const file = nodePath.join(root, 'boxes.txt')
      await fs.writeFile(file, content, 'utf8')

      const host = makeHost(root, { command: '/bin/cat', args: [file] })
      const session = await host.spawn({ cols: 80, rows: 24 })
      const output = collect(session)

      await session.waitForExit()

      const expected = Buffer.from(content, 'utf8')
      const got = output.bytes()

      // Asserted through a description first, and only then as the plain byte
      // comparison. This is the one test here whose failures have historically
      // shown up on a machine the person reading them cannot touch, and `expected
      // false to be true` is not a bug report. A short but otherwise perfect
      // prefix means the tail went missing as the child died; anything else means
      // bytes were altered or dropped mid-stream, which has a different cause.
      //
      // That description earned itself once already. This test failed on Linux CI
      // and only there, and the sentence it produced -- "truncated: an exact
      // prefix, 3397 of 200000 trailing bytes never arrived" -- settled in one run
      // what the boolean could not: nothing was corrupting bytes, something below
      // this adapter was dropping the end of the stream.
      //
      // It passes on Linux now, and nobody should read that as fixed. Neither the
      // scrollback default nor the exit drain nor the transport's flow control can
      // explain the change -- this test constructs no socket and never pauses --
      // so the likeliest reading is that the fault is intermittent. The suspect is
      // node-pty destroying the pty master 200ms after reaping the child, which
      // fires when the event loop stalls that long and so shows up on a loaded
      // runner and not an idle one. Nothing in this repository can prevent it: the
      // bytes are gone before the adapter is told the child exited.
      //
      // So if this goes red on CI again with a shortfall that moves between runs,
      // it is that, and the honest response is to record it rather than to hunt
      // for a regression that is not here. `pty-truncation-diagnostic.test.ts`
      // exists to tell those two cases apart.
      expect(describeAgainst(got, expected)).toBe('identical')
      expect(got.equals(expected)).toBe(true)
      expect(output.text()).toBe(content)
      expect(output.text()).not.toContain('�')
    },
  )

  it('reports the exit code', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', 'exit 3'] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    const exit = await session.waitForExit()

    expect(exit).toEqual({ code: 3, signal: undefined })
    await waitFor(() => host.get(session.id) === null)
  })

  it('keeps the pty alive when every connection detaches', async () => {
    const root = await makeRoot()
    const host = makeHost(root)

    const session = await host.spawn({ cols: 80, rows: 24 })
    const output = collect(session)

    const detach = session.attach()
    expect(session.attachments).toBe(1)
    detach()

    expect(session.attachments).toBe(0)
    expect(session.exit).toBeNull()
    expect(host.get(session.id)).toBe(session)

    // Still a working terminal with nobody watching -- which is the entire
    // point. `cat` echoes twice: once as terminal echo, once as its own output.
    session.write('still here\n')
    await waitFor(() => output.text().includes('still here'))
  })

  it('detaching twice does not double-count', async () => {
    const root = await makeRoot()
    const host = makeHost(root)
    const session = await host.spawn({ cols: 80, rows: 24 })

    const first = session.attach()
    const second = session.attach()
    first()
    first()

    expect(session.attachments).toBe(1)
    second()
    expect(session.attachments).toBe(0)
  })

  it('replays buffered output to a client that was not attached', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', 'printf hello; cat'] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    await waitFor(() => session.bytesProduced >= 5)

    const replay = session.scrollbackSince(null)
    expect(replay.bytes.toString('utf8')).toContain('hello')
    expect(replay.reset).toBe(true)
    // Nothing has been evicted, so the replay is the stream from its beginning.
    expect(replay.offset).toBe(0)
    expect(replay.bytes.length).toBe(session.bytesProduced)
  })

  it('serves only the unseen tail when a client resumes from an offset', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', 'printf first; cat'] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    await waitFor(() => session.bytesProduced >= 5)

    const seen = session.bytesProduced
    session.write('second')
    await waitFor(() => session.bytesProduced > seen)

    const replay = session.scrollbackSince(seen)
    expect(replay.reset).toBe(false)
    expect(replay.offset).toBe(seen)
    expect(replay.bytes.toString('utf8')).not.toContain('first')
    expect(replay.bytes.toString('utf8')).toContain('second')

    // The client's next `after` is exactly where it started plus what it read.
    expect(replay.offset + replay.bytes.length).toBe(session.bytesProduced)
  })

  it('bounds the scrollback and asks for a reset once history is evicted', async () => {
    const root = await makeRoot()

    const content = 'x'.repeat(200_000)
    const file = nodePath.join(root, 'big.txt')
    await fs.writeFile(file, content, 'utf8')

    // `cat file; cat` so the session is still alive to be inspected: the ring is
    // released when the child exits, and a dead session cannot be resumed.
    const host = makeHost(root, {
      command: '/bin/sh',
      args: ['-c', `cat ${file}; cat`],
      scrollbackBytes: 4_096,
    })

    const session = await host.spawn({ cols: 80, rows: 24 })
    await waitFor(() => session.bytesProduced >= content.length)

    const replay = session.scrollbackSince(null)
    expect(replay.bytes.length).toBeLessThanOrEqual(4_096)
    expect(replay.reset).toBe(true)

    // An offset the ring can no longer serve is a reset too: what is left is not
    // a suffix of anything the client holds.
    expect(session.scrollbackSince(0).reset).toBe(true)
  })

  it('passes a resize through to the child', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', WINCH_REPORTER] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    const output = collect(session)

    // The trap has to exist before the signal arrives, and a freshly forked
    // shell has not run its first line yet. Nothing about the adapter is
    // asynchronous here; this only waits for the fixture.
    await waitFor(() => output.text().includes('armed'))
    session.resize(100, 40)

    expect(session.cols).toBe(100)
    expect(session.rows).toBe(40)
    await waitFor(() => output.text().includes('40 100'))
  })

  it('nudgeRedraw provokes a repaint without changing the size', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', WINCH_REPORTER] })

    const session = await host.spawn({ cols: 90, rows: 30 })
    const output = collect(session)

    await waitFor(() => output.text().includes('armed'))
    session.nudgeRedraw()

    expect(session.cols).toBe(90)
    expect(session.rows).toBe(30)
    await waitFor(() => output.text().includes('30 90'))
  })

  it('reaps a session nobody is attached to', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { idleTimeoutMs: 20, reapIntervalMs: 10 })

    const session = await host.spawn({ cols: 80, rows: 24 })

    await waitFor(() => host.get(session.id) === null)
    expect(session.exit).not.toBeNull()
  })

  it('leaves an attached session alone, and collects it once it detaches', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { idleTimeoutMs: 20, reapIntervalMs: 10 })

    const session = await host.spawn({ cols: 80, rows: 24 })
    const detach = session.attach()

    await delay(150)
    expect(host.get(session.id)).toBe(session)
    expect(session.exit).toBeNull()

    detach()
    await waitFor(() => host.get(session.id) === null)
  })

  it('refuses to open more sessions than the limit allows', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { maxSessions: 2 })

    await host.spawn({ cols: 80, rows: 24 })
    await host.spawn({ cols: 80, rows: 24 })

    await expect(host.spawn({ cols: 80, rows: 24 })).rejects.toThrow(TerminalHostError)
  })

  it('killAll ends every session and refuses new ones', async () => {
    const root = await makeRoot()
    const host = makeHost(root)

    const first = await host.spawn({ cols: 80, rows: 24 })
    const second = await host.spawn({ cols: 80, rows: 24 })

    await host.killAll()

    expect(first.exit).not.toBeNull()
    expect(second.exit).not.toBeNull()
    expect(host.get(first.id)).toBeNull()
    await expect(host.spawn({ cols: 80, rows: 24 })).rejects.toThrow(TerminalHostError)
  })

  it('creates the notes root if it is not there yet', async () => {
    const base = await makeRoot()
    const root = nodePath.join(base, 'not', 'created', 'yet')
    const host = makeHost(root, { command: '/bin/pwd', args: [] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    const output = collect(session)

    await session.waitForExit()
    expect(output.text().trim()).toBe(root)
  })

  it('tells a late subscriber that the session has already exited', async () => {
    const root = await makeRoot()
    const host = makeHost(root, { command: '/bin/sh', args: ['-c', 'exit 0'] })

    const session = await host.spawn({ cols: 80, rows: 24 })
    await session.waitForExit()

    const exit = await session.waitForExit()
    expect(exit.code).toBe(0)
  })
})

/**
 * A pty whose two interesting events happen when the test says so.
 *
 * Everything here exists to be driven: `emitData` and `emitExit` are the levers,
 * and `paused` and `killedWith` are what the session's side of the bargain is
 * checked against. It implements `IPty` in full because the seam takes the real
 * type -- an interface trimmed to what the adapter happens to call today would
 * stop failing the moment the adapter started calling something else.
 */
class FakePty implements IPty {
  readonly pid = 4242
  cols = 80
  rows = 24
  readonly process = 'fake'
  handleFlowControl = false

  paused = false
  killedWith: string | undefined
  readonly writes: Buffer[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []

  private readonly dataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>()

  readonly onData = (listener: (chunk: string) => void): IDisposable => {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  readonly onExit = (listener: (e: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  /**
   * Buffers, not strings, because that is what node-pty delivers under
   * `encoding: null` and what the adapter's cast asserts. The signature is
   * `IEvent<string>` only because node-pty's typings do not model the option.
   */
  emitData(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk as unknown as string)
  }

  emitExit(exitCode = 0, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push({ cols, rows })
  }

  clear(): void {}

  write(data: string | Buffer): void {
    this.writes.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  }

  kill(signal?: string): void {
    this.killedWith = signal
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }
}

/** Comfortably under the drain windows below, so ordering is never in doubt. */
const QUIET_MS = 25
const MAX_DRAIN_MS = 150

async function spawnFake(
  options: Partial<NodePtyTerminalHostOptions> = {},
): Promise<{ host: NodePtyTerminalHost; pty: FakePty; session: PtySession }> {
  const root = await makeRoot()
  const pty = new FakePty()
  const host = new NodePtyTerminalHost({
    notesRoot: root,
    exitDrainQuietMs: QUIET_MS,
    exitDrainMaxMs: MAX_DRAIN_MS,
    // A fake pty's `kill` cannot make a child die, so the teardown in `afterEach`
    // always has to wait this out. Keeping it short means a test that forgets to
    // emit an exit is a fast failure rather than a slow suite.
    killGraceMs: 50,
    spawnPty: () => pty,
    ...options,
  })
  hosts.push(host)

  return { host, pty, session: await host.spawn({ cols: 80, rows: 24 }) }
}

describe('exit and the drain that follows it', () => {
  it('delivers output that arrives after the child has been reaped', async () => {
    const { pty, session } = await spawnFake()
    const output = collect(session)

    pty.emitData(Buffer.from('before the exit\n', 'utf8'))
    pty.emitExit(0)

    // The whole bug, in one line: the process is gone and the last thing it
    // wrote has not been read yet. A session that treats the reap as the end of
    // the stream drops this, and in production it is the final redraw.
    pty.emitData(Buffer.from('after the exit\n', 'utf8'))

    const exit = await session.waitForExit()

    expect(exit).toEqual({ code: 0, signal: undefined })
    expect(output.text()).toBe('before the exit\nafter the exit\n')
    expect(output.bytes().toString('utf8')).toBe('before the exit\nafter the exit\n')
  })

  it('does not report the exit until the output has stopped', async () => {
    const { session, pty } = await spawnFake()
    const output = collect(session)

    let settled = false
    const exited = session.waitForExit().then((exit) => {
      settled = true
      return exit
    })

    pty.emitExit(0)

    // A trickle, each chunk landing inside the quiet window. Exit stays pending
    // for as long as the stream keeps producing, because a caller awaiting it
    // means "let me see what it printed" and it has not finished printing.
    for (let i = 0; i < 4; i++) {
      await delay(QUIET_MS / 2)
      expect(settled).toBe(false)
      expect(session.exit).toBeNull()
      pty.emitData(Buffer.from(`chunk ${i}\n`, 'utf8'))
    }

    await exited
    expect(output.text()).toBe('chunk 0\nchunk 1\nchunk 2\nchunk 3\n')
  })

  it('holds a multibyte character split across the exit', async () => {
    const { session, pty } = await spawnFake()
    const output = collect(session)

    // U+1F600, cut between its third and fourth byte by the child dying. This is
    // the boundary case the StringDecoder exists for, and the one place where
    // ending the decoder a moment early is visible as a replacement character
    // rather than as missing bytes.
    const emoji = Buffer.from('😀', 'utf8')
    pty.emitData(emoji.subarray(0, 3))
    pty.emitExit(0)
    pty.emitData(emoji.subarray(3))

    await session.waitForExit()

    expect(output.bytes().equals(emoji)).toBe(true)
    expect(output.text()).toBe('😀')
    expect(output.text()).not.toContain('�')
  })

  it('stops waiting once the drain has had its cap', async () => {
    const { session, pty } = await spawnFake()
    const output = collect(session)

    pty.emitExit(0)

    // A stream that never goes quiet must not hold the exit open forever: a
    // session that cannot settle is one the reaper cannot collect and shutdown
    // cannot finish. The bytes still get through right up to the cap.
    const noisy = setInterval(() => pty.emitData(Buffer.from('.', 'utf8')), QUIET_MS / 5)

    try {
      const started = Date.now()
      await session.waitForExit()
      const waited = Date.now() - started

      expect(waited).toBeGreaterThanOrEqual(MAX_DRAIN_MS - QUIET_MS)
      expect(waited).toBeLessThan(MAX_DRAIN_MS * 4)
      expect(output.bytes().length).toBeGreaterThan(0)
    } finally {
      clearInterval(noisy)
    }
  })

  it('settles immediately when the drain window is turned off', async () => {
    const { session, pty } = await spawnFake({ exitDrainQuietMs: 0 })

    pty.emitExit(7, 15)
    expect(session.exit).toEqual({ code: 7, signal: 15 })
    await expect(session.waitForExit()).resolves.toEqual({ code: 7, signal: 15 })
  })

  it('lets go of a flow-control pause when the child dies', async () => {
    const { session, pty } = await spawnFake()
    const output = collect(session)

    session.pause()
    session.pause()
    expect(pty.paused).toBe(true)

    // node-pty destroys the pty master 200ms after the child is reaped whether
    // or not anyone has read what is left in it, so a session still paused at
    // that moment loses its tail outright. Back pressure against a dead child
    // buys nothing and costs exactly the output that matters most.
    pty.emitExit(0)
    expect(pty.paused).toBe(false)

    session.pause()
    expect(pty.paused).toBe(false)

    pty.emitData(Buffer.from('drained anyway\n', 'utf8'))
    await session.waitForExit()

    expect(output.text()).toBe('drained anyway\n')
  })

  it('stops writing to and signalling a child that is already gone', async () => {
    const { session, pty } = await spawnFake()

    pty.emitExit(0)

    // Still draining, so the session has not settled -- but the fd on the other
    // end has nothing reading it, and SIGHUP has nobody to reach.
    expect(session.exit).toBeNull()
    session.write('ignored')
    session.resize(120, 40)
    session.nudgeRedraw()

    expect(pty.writes).toHaveLength(0)
    expect(pty.resizes).toHaveLength(0)
    expect(session.cols).toBe(80)

    await session.waitForExit()
  })

  it('still serves its scrollback to an exit listener, and releases it after', async () => {
    const { session, pty } = await spawnFake()

    const servedOnExit: Buffer[] = []
    session.onExit(() => servedOnExit.push(session.scrollbackSince(null).bytes))

    pty.emitData(Buffer.from('the last screenful', 'utf8'))
    pty.emitExit(0)
    await session.waitForExit()

    // Load-bearing ordering, not housekeeping. A consumer is allowed to be
    // behind the stream on purpose -- the WebSocket transport falls behind when
    // a client cannot keep up, and catches up from here -- so releasing the ring
    // before the exit listeners run would destroy the only copy of exactly the
    // bytes an exiting session's listener came to collect.
    expect(servedOnExit.map((bytes) => bytes.toString('utf8'))).toEqual(['the last screenful'])
    expect(session.scrollbackSince(null).bytes).toHaveLength(0)
  })

  it('keeps the session listed and its scrollback intact until the exit settles', async () => {
    const { host, session, pty } = await spawnFake()

    pty.emitData(Buffer.from('hello', 'utf8'))
    pty.emitExit(0)
    pty.emitData(Buffer.from(' there', 'utf8'))

    // A client reconnecting inside the drain window still gets served: the ring
    // is released on the settled exit, not on the reap.
    expect(host.get(session.id)).toBe(session)
    expect(session.scrollbackSince(null).bytes.toString('utf8')).toBe('hello there')
    expect(session.bytesProduced).toBe(11)

    await session.waitForExit()
    await waitFor(() => host.get(session.id) === null)
  })
})
