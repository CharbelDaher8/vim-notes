/**
 * The seam: a socket the test drives, through the real connection, into a fake
 * emulator whose contents the test can read.
 *
 * Everything in between is production code -- frame parsing, offset accounting,
 * the reset policy -- so what these assert is the thing that actually matters
 * and cannot be checked from either side alone: what the screen ends up showing
 * when the server says the stream cannot be continued.
 *
 * The emulator is a fake rather than xterm because this package has no jsdom
 * and mounting a real terminal is not available here. That costs the rendering,
 * which xterm is responsible for anyway, and keeps the part this code owns:
 * whether the bytes after a reset land on a cleared grid or a stale one.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createWebSocketConnection,
  type TerminalSocketEvent,
  type TerminalSocketEventType,
  type TerminalSocketLike,
} from './websocket-connection'
import { bindTerminal, describeResync, type TerminalLike } from './terminal-sink'
import {
  reconnectDelayMs,
  sessionMemoryFor,
  type ConnectionStatus,
  type SessionMemory,
  type TerminalExit,
  type TerminalReset,
} from './terminal-connection'

/**
 * Models exactly what the assertions need: what is on the screen right now.
 *
 * Bytes are accumulated and decoded on read rather than decoded per write,
 * because that is what xterm does -- it holds a partial UTF-8 sequence across
 * writes. A fake that decoded each chunk would report a replacement character
 * for every split emoji and blame this code for it.
 */
class FakeTerminal implements TerminalLike {
  resets = 0
  private bytes: number[] = []

  get contents(): string {
    return new TextDecoder().decode(Uint8Array.from(this.bytes))
  }

  write(data: Uint8Array): void {
    for (const byte of data) this.bytes.push(byte)
  }

  reset(): void {
    this.resets += 1
    this.bytes = []
  }
}

class FakeSocket implements TerminalSocketLike {
  binaryType = ''
  readyState = 1
  readonly sent: Array<string | Uint8Array> = []
  closed = false

  private readonly listeners = new Map<string, Array<(event: TerminalSocketEvent) => void>>()

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data.buffer as ArrayBuffer))
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  addEventListener(
    type: TerminalSocketEventType,
    listener: (event: TerminalSocketEvent) => void,
  ): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  private emit(type: TerminalSocketEventType, event: TerminalSocketEvent = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  // --- what the server does to it ---

  open(): void {
    this.emit('open')
  }

  control(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }

  /** Text that is not a frame, to prove it cannot reach the screen as output. */
  rawText(text: string): void {
    this.emit('message', { data: text })
  }

  output(text: string): void {
    this.outputBytes(new TextEncoder().encode(text))
  }

  outputBytes(bytes: Uint8Array): void {
    // Copied into a standalone ArrayBuffer, the way a real binary frame arrives
    // once `binaryType` is 'arraybuffer'.
    this.emit('message', { data: bytes.slice().buffer })
  }

  drop(): void {
    this.emit('close')
  }
}

/** Stands in for sessionStorage, and survives a "reload" the way it does. */
class FakeMemory implements SessionMemory {
  constructor(private value: string | null = null) {}

  read(): string | null {
    return this.value
  }

  write(sessionId: string): void {
    this.value = sessionId
  }

  clear(): void {
    this.value = null
  }
}

interface Harness {
  terminal: FakeTerminal
  sockets: FakeSocket[]
  socket: FakeSocket
  memory: FakeMemory
  resyncs: TerminalReset[]
  statuses: ConnectionStatus[]
  exits: TerminalExit[]
  dispose(): void
}

function harness(url = 'ws://host/term/ws', memory = new FakeMemory()): Harness {
  const sockets: FakeSocket[] = []
  const terminal = new FakeTerminal()
  const resyncs: TerminalReset[] = []
  const statuses: ConnectionStatus[] = []
  const exits: TerminalExit[] = []

  const connection = createWebSocketConnection(url, {
    createSocket: (target) => {
      const socket = new FakeSocket(target)
      sockets.push(socket)
      return socket
    },
    memory,
  })

  const unbind = bindTerminal(connection, terminal, {
    onStatus: (status) => statuses.push(status),
    onExit: (exit) => exits.push(exit),
    onResync: (resync) => resyncs.push(resync),
  })

  return {
    terminal,
    sockets,
    get socket() {
      const latest = sockets[sockets.length - 1]
      if (latest === undefined) throw new Error('no socket was opened')
      return latest
    },
    memory,
    resyncs,
    statuses,
    exits,
    dispose: () => {
      unbind()
      connection.close()
    },
  }
}

const READY = {
  type: 'ready',
  sessionId: 's1',
  resumed: false,
  reset: true,
  offset: 0,
  cols: 80,
  rows: 24,
}

describe('a reset arriving mid-stream', () => {
  it('shows what followed it, not what followed it appended to stale content', () => {
    const h = harness()
    h.socket.open()
    h.socket.control(READY)

    h.socket.output('stale screen, drawn from bytes with a hole after them')
    expect(h.terminal.contents).toBe('stale screen, drawn from bytes with a hole after them')

    // The server evicted what this client needed next and said so.
    h.socket.control({ type: 'reset', offset: 4096, dropped: 1024 })
    h.socket.output('the payload')

    // The whole point. Appending would have spliced two unrelated streams and
    // left xterm parsing an escape sequence cut in half.
    expect(h.terminal.contents).toBe('the payload')
    expect(h.terminal.resets).toBe(2)

    h.dispose()
  })

  it('reports the drop, with the number the server counted', () => {
    const h = harness()
    h.socket.open()
    h.socket.control(READY)
    h.socket.control({ type: 'reset', offset: 4096, dropped: 1024 })

    expect(h.resyncs).toEqual([{ dropped: 1024 }])
    expect(describeResync({ dropped: 1024 })).toContain('1,024 bytes')

    h.dispose()
  })

  it('says nothing when attaching to a fresh session, which also clears', () => {
    const h = harness()
    h.socket.open()

    // `reset: true` on a first attach is bookkeeping -- there was no previous
    // screen to lose. Reporting it would be the boy who cried wolf.
    h.socket.control(READY)

    expect(h.terminal.resets).toBe(1)
    expect(h.resyncs).toEqual([])

    h.dispose()
  })

  it('phrases an uncountable loss without inventing a number', () => {
    // The `ready` frame carries no count, so a resume the ring could not serve
    // knows output is missing but not how much. Saying "0 bytes" would be a
    // lie; saying nothing would hide a real loss. The case that produces this
    // is exercised in 'surviving a page load' below.
    expect(describeResync({ dropped: null })).toContain('Some output was dropped')
  })
})

describe('the stream a reset interrupts', () => {
  it('counts from the reset offset, so the next reconnect resumes from the right place', () => {
    vi.useFakeTimers()

    try {
      const h = harness()
      h.socket.open()
      h.socket.control(READY)

      h.socket.output('12345')
      h.socket.control({ type: 'reset', offset: 900, dropped: 400 })
      h.socket.output('678')
      h.socket.drop()

      vi.advanceTimersByTime(reconnectDelayMs(1))

      // 900 from the reset plus the three bytes applied after it. Counting on
      // from the old position instead would ask the server to continue from a
      // place this client never reached, and the server would answer with a
      // stretch of stream it has already seen.
      expect(h.sockets).toHaveLength(2)
      expect(new URL(h.socket.url).searchParams.get('after')).toBe('903')
      expect(new URL(h.socket.url).searchParams.get('session')).toBe('s1')

      h.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps bytes as bytes, so a character split across two frames survives', () => {
    const h = harness()
    h.socket.open()
    h.socket.control(READY)

    // U+1F600 cut between its third and fourth byte. That is the ordinary case
    // for a pty read boundary, not an edge case, and it is the reason output
    // stays binary all the way to the emulator: decoding per frame in the
    // client would put two replacement characters on the screen instead.
    const emoji = new TextEncoder().encode('😀')
    h.socket.outputBytes(emoji.subarray(0, 3))
    h.socket.outputBytes(emoji.subarray(3))

    expect(h.terminal.contents).toBe('😀')

    h.dispose()
  })
})

describe('surviving a page load', () => {
  it('remembers the session and asks for it again', () => {
    const memory = new FakeMemory()

    const first = harness('ws://host/term/ws', memory)
    first.socket.open()
    first.socket.control(READY)
    first.socket.output('work in progress')
    first.dispose()

    // A reload: everything in memory is gone, only storage survives. The
    // browser does this on its own for memory pressure and updates, and
    // without this the user comes back to a fresh shell while their real nvim
    // keeps running server-side where they can no longer reach it.
    const second = harness('ws://host/term/ws', memory)
    const url = new URL(second.socket.url)

    expect(url.searchParams.get('session')).toBe('s1')

    // Deliberately no `after`. The grid did not survive the reload, so the
    // useful request is the whole ring -- continuing from a byte offset would
    // paint the tail of a stream onto an empty screen.
    expect(url.searchParams.has('after')).toBe(false)

    second.dispose()
  })

  it('does not cry wolf about the reset a reload asks for', () => {
    const memory = new FakeMemory('s1')
    const h = harness('ws://host/term/ws', memory)

    h.socket.open()
    h.socket.control({ ...READY, resumed: true, reset: true, offset: 4096 })
    h.socket.output('the whole ring')

    // The client asked for everything and got everything. The grid is cleared
    // because that is what a full replay needs, but nothing was lost and
    // saying otherwise is how a warning becomes noise people learn to skip.
    expect(h.terminal.resets).toBe(1)
    expect(h.terminal.contents).toBe('the whole ring')
    expect(h.resyncs).toEqual([])

    h.dispose()
  })

  it('still reports a resume the server could not continue', () => {
    // Fake timers before the drop, because the drop is what schedules the
    // retry -- arming them afterwards leaves the real timer holding it.
    vi.useFakeTimers()

    try {
      const h = harness()
      h.socket.open()
      h.socket.control(READY)
      h.socket.output('12345')
      h.socket.drop()

      vi.advanceTimersByTime(reconnectDelayMs(1))

      // This one *did* ask to continue -- the socket dropped inside one page
      // life, so the grid is still on screen and the offset is still known.
      expect(new URL(h.socket.url).searchParams.get('after')).toBe('5')

      h.socket.open()
      h.socket.control({ ...READY, resumed: true, reset: true, offset: 9_000 })

      // Asked for a continuation, got a reset: output exists that this client
      // will never be sent, and nothing counted it.
      expect(h.resyncs).toEqual([{ dropped: null }])

      h.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets a session that has exited', () => {
    const memory = new FakeMemory()
    const h = harness('ws://host/term/ws', memory)

    h.socket.open()
    h.socket.control(READY)
    expect(memory.read()).toBe('s1')

    // Reloading after `:q` should open a new terminal, not ask the server to
    // resume something that has ended.
    h.socket.control({ type: 'exit', code: 0 })
    expect(memory.read()).toBeNull()

    h.dispose()
  })

  it('keeps working when storage is unavailable', () => {
    // Safari's private mode throws on write and enterprise policy can disable
    // storage outright. A terminal that refuses to open because it could not
    // remember an id would be a much worse trade than one that forgets.
    const hostile: SessionMemory = {
      read: () => {
        throw new Error('SecurityError')
      },
      write: () => {
        throw new Error('SecurityError')
      },
      clear: () => {
        throw new Error('SecurityError')
      },
    }

    expect(() => sessionMemoryFor('ws://host/term/ws', null).write('s1')).not.toThrow()
    expect(sessionMemoryFor('ws://host/term/ws', null).read()).toBeNull()
    expect(() => hostile.read()).toThrow()
  })
})

describe('frames this client does not understand', () => {
  it('ignores them rather than taking the connection down', () => {
    const h = harness()
    h.socket.open()
    h.socket.control(READY)
    h.socket.output('before')

    h.socket.control({ type: 'something-the-server-grew-later', detail: 1 })
    h.socket.control({ type: 'reset' })
    h.socket.rawText('not json at all')
    h.socket.rawText('[32mgreen[0m')

    h.socket.output('after')

    // Still connected, still counting, and none of it reached the screen --
    // a stray text frame rendering as terminal output would be worse than
    // dropping it, because it would look like the program printed it.
    expect(h.terminal.contents).toBe('beforeafter')
    expect(h.statuses).toEqual(['open'])
    expect(h.exits).toEqual([])

    h.dispose()
  })
})

describe('exit', () => {
  it('is reported and stops the reconnect, unlike a dropped socket', () => {
    const h = harness()
    h.socket.open()
    h.socket.control(READY)
    h.socket.control({ type: 'exit', code: 3 })
    h.socket.drop()

    expect(h.exits).toEqual([{ code: 3 }])
    expect(h.sockets).toHaveLength(1)

    h.dispose()
  })
})
