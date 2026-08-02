/**
 * These drive real ptys. Mocking node-pty would leave every property worth
 * testing here untested -- chunk boundaries are decided by the kernel's tty
 * buffer, SIGWINCH is delivered by the OS, and a mock's idea of when a child
 * dies is not the one that matters. `sh` and `cat` stand in for nvim so the
 * suite stays fast and deterministic; nothing under test cares which program is
 * on the other end of the fd.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  NodePtyTerminalHost,
  TerminalHostError,
  type NodePtyTerminalHostOptions,
  type PtySession,
} from './node-pty-terminal-host'

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

  it('delivers output as bytes and holds multibyte characters across chunk boundaries', async () => {
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
    expect(output.bytes().equals(expected)).toBe(true)
    expect(output.text()).toBe(content)
    expect(output.text()).not.toContain('�')
  })

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
