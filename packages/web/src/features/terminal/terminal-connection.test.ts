/**
 * These assert the wire format against the server's, which is the thing that
 * was wrong before: this file used to check that the client encoded input as
 * `{"type":"input","data":...}` and it did, faithfully, forever, against a
 * server that has never accepted that. A test can only confirm that a guess is
 * self-consistent. The pairing is checked in `terminal-sink.test.ts`, which
 * drives real frames through the real client.
 */
import { describe, expect, it } from 'vitest'

import { parseServerFrame, reconnectDelayMs, resumeUrl, TERMINAL_WIRE } from './terminal-connection'

describe('TERMINAL_WIRE', () => {
  it('sends input as raw bytes, not as JSON', () => {
    // The server reads the frame's own binary bit and writes the payload
    // straight to the pty. Anything else arrives at nvim as literal JSON.
    expect(TERMINAL_WIRE.input('ls\r')).toEqual(new TextEncoder().encode('ls\r'))
  })

  it('survives control bytes, which is most of what a terminal sends', () => {
    const escape = '\u001B[2J\u0000\u0007'
    expect(TERMINAL_WIRE.input(escape)).toEqual(new TextEncoder().encode(escape))
  })

  it('encodes a multibyte paste without mangling it', () => {
    expect(TERMINAL_WIRE.input('─😀')).toEqual(new TextEncoder().encode('─😀'))
  })

  it('sends control frames as JSON text', () => {
    expect(JSON.parse(TERMINAL_WIRE.resize(80, 24))).toEqual({ type: 'resize', cols: 80, rows: 24 })
    expect(JSON.parse(TERMINAL_WIRE.kill())).toEqual({ type: 'kill' })
  })
})

describe('parseServerFrame', () => {
  it('reads a ready frame', () => {
    const raw = JSON.stringify({
      type: 'ready',
      sessionId: 'abc',
      resumed: true,
      reset: false,
      offset: 91234,
      cols: 120,
      rows: 40,
    })

    expect(parseServerFrame(raw)).toEqual({
      type: 'ready',
      sessionId: 'abc',
      resumed: true,
      reset: false,
      offset: 91234,
      cols: 120,
      rows: 40,
    })
  })

  it('reads a mid-stream reset, with the count of what was dropped', () => {
    expect(parseServerFrame('{"type":"reset","offset":240128,"dropped":8192}')).toEqual({
      type: 'reset',
      offset: 240128,
      dropped: 8192,
    })
  })

  it('reads an exit frame, with and without a signal', () => {
    expect(parseServerFrame('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 })
    expect(parseServerFrame('{"type":"exit","code":1,"signal":9}')).toEqual({
      type: 'exit',
      code: 1,
      signal: 9,
    })
  })

  it('reads error and pong', () => {
    expect(parseServerFrame('{"type":"error","message":"nope"}')).toEqual({
      type: 'error',
      message: 'nope',
    })
    expect(parseServerFrame('{"type":"pong"}')).toEqual({ type: 'pong' })
  })

  it('ignores a frame it does not understand rather than throwing', () => {
    // An older tab must not break when the server grows a new message type --
    // which is exactly how the `reset` frame could be added at all.
    expect(parseServerFrame('{"type":"something-new","x":1}')).toBeNull()
    expect(parseServerFrame('null')).toBeNull()
    expect(parseServerFrame('{"type":"exit"}')).toBeNull()
    expect(parseServerFrame('{"type":"reset","offset":1}')).toBeNull()
    expect(parseServerFrame('{"type":"ready","sessionId":"a"}')).toBeNull()
  })

  it('refuses to treat a non-frame text message as terminal output', () => {
    // It used to, as a hedge against a server that piped the pty through as
    // text. Against the real server that hedge renders a malformed control
    // frame into the user's screen as though the program had printed it.
    expect(parseServerFrame('[32mgreen[0m')).toBeNull()
    expect(parseServerFrame('')).toBeNull()
  })
})

describe('resumeUrl', () => {
  it('asks for a new session when there is nothing to resume', () => {
    expect(
      resumeUrl('ws://host/term/ws', { session: null, after: null, cols: null, rows: null }),
    ).toBe('ws://host/term/ws')
  })

  it('names the session and the offset it reached', () => {
    const url = resumeUrl('ws://host/term/ws', {
      session: 'abc',
      after: 91234,
      cols: 120,
      rows: 40,
    })

    expect(url).toBe('ws://host/term/ws?session=abc&after=91234&cols=120&rows=40')
  })

  it('sends offset zero rather than omitting it', () => {
    // Omitting `after` means "replay everything"; zero means "I have consumed
    // nothing", and the two ask the server for different things.
    const url = resumeUrl('ws://host/term/ws', { session: 'a', after: 0, cols: null, rows: null })
    expect(url).toBe('ws://host/term/ws?session=a&after=0')
  })
})

describe('reconnectDelayMs', () => {
  it('retries quickly at first', () => {
    expect(reconnectDelayMs(1)).toBe(500)
    expect(reconnectDelayMs(2)).toBe(1_000)
    expect(reconnectDelayMs(3)).toBe(2_000)
  })

  it('backs off but stays bounded, so a long outage still recovers', () => {
    expect(reconnectDelayMs(20)).toBe(15_000)
    expect(reconnectDelayMs(1_000)).toBe(15_000)
  })

  it('is safe at the edges', () => {
    expect(reconnectDelayMs(0)).toBe(500)
    expect(reconnectDelayMs(-5)).toBe(500)
  })
})
