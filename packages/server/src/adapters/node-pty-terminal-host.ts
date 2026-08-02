/**
 * TerminalHost backed by node-pty -- real nvim in a real pty, which is the whole
 * point of the `/term` client (DECISIONS.md §3). Not an emulation: the user's
 * own init.lua, their plugins, their NERDTree.
 *
 * Three things drive the shape of this file.
 *
 *   1. Sessions outlive connections. The port says so, and it is the behaviour
 *      that matters most here: a phone that drops off wifi mid-edit has to come
 *      back to the same nvim, not to a fresh one with the unsaved buffer gone.
 *      So the registry is keyed by session id, a closed socket only detaches,
 *      and the only three things that end a pty are the process exiting, an
 *      explicit kill, and the idle reaper.
 *   2. The data path is bytes from end to end. The pty is opened with
 *      `encoding: null` so node-pty hands back Buffers, the scrollback ring
 *      stores Buffers, and the WebSocket sends them verbatim. A UTF-8 sequence
 *      or a CSI escape split across a read boundary is the normal case rather
 *      than an edge case, and anything that decodes chunk-at-a-time corrupts box
 *      drawing and emoji the first time a redraw lands on the wrong byte. The
 *      port's string-shaped `onData` is a decoded *view* over that byte stream;
 *      see the StringDecoder note on `onData` below.
 *   3. The child process is never described by the client. Command, args, cwd
 *      and environment all come from this adapter's construction, and a caller
 *      that supplies them is refused rather than quietly overridden -- the same
 *      reflex as NotePath rejecting `..` instead of resolving it.
 *
 * What this is *not* is a sandbox, and it would be dishonest to imply otherwise.
 * nvim in a pty can `:e /etc/passwd` and `:!sh` no matter what cwd it was given,
 * so forcing cwd buys predictability, not containment. The real boundary is
 * DECISIONS.md §11 -- the server binds to the tailnet and is never exposed --
 * plus running as an unprivileged user. Anything that can open this socket has a
 * shell, and the deployment is what has to be true, not this file.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  TerminalExit,
  TerminalHost,
  TerminalSession,
  TerminalSpawnOptions,
  Unsubscribe,
} from '@vim-notes/core'
import { spawn as spawnPty, type IPty } from 'node-pty'

/**
 * Belongs in core's error taxonomy next to NoteStoreError, on the same argument
 * made there -- what a port can throw is part of its contract. Left here until
 * core is open for edits; moving it is a re-export, not a rewrite.
 */
export class TerminalHostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

const DEFAULT_COMMAND = 'nvim'

/**
 * xterm.js advertises 256 colours and true colour, and nvim decides what to emit
 * from $TERM alone. Leaving the server's own $TERM to leak through would give a
 * monochrome editor under systemd (`TERM=dumb`) with no obvious cause.
 */
const DEFAULT_TERM = 'xterm-256color'

// Matches `spawnTerminalInput` in core/src/schemas: the API validates client
// dimensions against those bounds, and a port called from anywhere else should
// not be able to widen them.
const MIN_DIMENSION = 1
const MAX_DIMENSION = 1000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * A few screens of a full-colour nvim redraw. Enough that a reconnect lands on
 * something recognisable, small enough that eight abandoned sessions holding
 * their rings is a couple of megabytes rather than a leak.
 */
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024

/**
 * Long enough to survive a commute, a meeting, or a laptop lid; short enough
 * that a forgotten tab does not hold an nvim forever. Sessions are reaped with
 * SIGHUP, which nvim handles by running `:preserve` before exiting, so the swap
 * file survives and the work is recoverable with `:recover` even here.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_REAP_INTERVAL_MS = 60_000

/** A bound on how much a single user can spend by reloading the tab. */
const DEFAULT_MAX_SESSIONS = 8

/** How long a SIGHUP gets to work before shutdown escalates to SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 2_000

export interface NodePtyTerminalHostOptions {
  /** Absolute path. Forced as every session's cwd; never taken from a client. */
  notesRoot: string
  /** Defaults to `nvim`. Operator configuration, not a client-supplied value. */
  command?: string
  args?: string[]
  /** Merged over the inherited environment. `TERM` is always ours. */
  env?: Record<string, string>
  term?: string
  scrollbackBytes?: number
  idleTimeoutMs?: number
  reapIntervalMs?: number
  maxSessions?: number
  killGraceMs?: number
  /**
   * Where a reaped or failed session goes to be noticed. There is nobody to
   * return these to -- the reaper runs on a timer, and a pty that dies has no
   * pending request -- so without a sink they vanish.
   */
  onError?: (error: unknown) => void
}

/**
 * What a session hands back when a client asks to resume from a byte offset.
 *
 * `reset` is the interesting field: it means the ring could not serve the exact
 * continuation the client asked for, so the bytes below start somewhere the
 * client has not seen a prefix of and its terminal grid has to be cleared first.
 * See `scrollbackSince`.
 */
export interface ScrollbackReplay {
  bytes: Buffer
  /**
   * Stream offset of the first byte of `bytes`, so a client can count forward
   * from it. Deliberately the *start* rather than the end: the client cannot
   * tell a replayed frame from a live one, so an end offset would leave it
   * unable to say whether the next chunk it receives was already counted.
   */
  offset: number
  reset: boolean
}

/**
 * TerminalSession plus the byte-level and attachment machinery the WebSocket
 * transport needs. The port stays string-shaped because that is what a caller
 * outside this package can reasonably want; the transport is inside the hexagon
 * wall with us and gets the untranslated stream.
 */
export interface PtySession extends TerminalSession {
  readonly cols: number
  readonly rows: number
  /** Non-null once the child has exited. */
  readonly exit: TerminalExit | null
  /** How many connections are currently attached. */
  readonly attachments: number
  /** Total bytes the pty has produced since it started. Monotonic. */
  readonly bytesProduced: number

  /** Raw pty output. Nothing is decoded, so nothing can be corrupted. */
  onBytes(listener: (chunk: Buffer) => void): Unsubscribe
  writeBytes(data: Buffer): void

  scrollbackSince(offset: number | null): ScrollbackReplay

  /**
   * Mark a connection as attached; the returned function detaches it. Purely
   * bookkeeping for the reaper -- it does not subscribe to anything.
   */
  attach(): Unsubscribe

  /** Reference-counted flow control, for a socket that cannot keep up. */
  pause(): void
  resume(): void

  /** Settles with the exit that has already happened, if it already has. */
  waitForExit(): Promise<TerminalExit>

  /**
   * Provoke a full repaint from whatever is running. Costs one SIGWINCH.
   */
  nudgeRedraw(): void
}

export class NodePtyTerminalHost implements TerminalHost {
  private readonly notesRoot: string
  private readonly command: string
  private readonly args: string[]
  private readonly env: Record<string, string>
  private readonly term: string
  private readonly scrollbackBytes: number
  private readonly idleTimeoutMs: number
  private readonly reapIntervalMs: number
  private readonly maxSessions: number
  private readonly killGraceMs: number
  private readonly onError: (error: unknown) => void

  private readonly sessions = new Map<string, NodePtySession>()
  private reaper: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(options: NodePtyTerminalHostOptions) {
    if (!nodePath.isAbsolute(options.notesRoot)) {
      throw new TerminalHostError(
        `notes root must be an absolute path, got ${JSON.stringify(options.notesRoot)}`,
      )
    }

    this.notesRoot = nodePath.resolve(options.notesRoot)
    this.command = options.command ?? DEFAULT_COMMAND
    this.args = [...(options.args ?? [])]
    this.env = { ...(options.env ?? {}) }
    this.term = options.term ?? DEFAULT_TERM
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.onError = options.onError ?? (() => {})
  }

  async spawn(options: TerminalSpawnOptions): Promise<PtySession> {
    if (this.stopped) throw new TerminalHostError('terminal host is shut down')

    assertNotClientShaped(options)

    if (this.sessions.size >= this.maxSessions) {
      throw new TerminalHostError(
        `too many terminal sessions (${this.sessions.size}); close one before opening another`,
      )
    }

    // A pty whose cwd does not exist fails inside posix_spawn with a message
    // that names neither the directory nor the reason. On a fresh install the
    // notes root legitimately has not been created yet -- FsNoteStore treats a
    // missing root as empty for the same reason -- so create it rather than
    // making the first terminal the thing that reports it.
    await fs.mkdir(this.notesRoot, { recursive: true })

    const cols = clampDimension(options.cols, DEFAULT_COLS)
    const rows = clampDimension(options.rows, DEFAULT_ROWS)

    const pty = spawnPty(this.command, this.args, {
      name: this.term,
      cols,
      rows,
      cwd: this.notesRoot,
      env: this.childEnvironment(),
      // The reason the whole data path can stay byte-exact. See the file header.
      encoding: null,
    })

    const session = new NodePtySession(pty, {
      cols,
      rows,
      scrollbackBytes: this.scrollbackBytes,
      onError: this.onError,
    })

    this.sessions.set(session.id, session)
    session.onExit(() => {
      this.sessions.delete(session.id)
    })
    this.startReaper()

    return session
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id) ?? null
  }

  /** Live sessions, newest last. For a status endpoint. */
  list(): PtySession[] {
    return [...this.sessions.values()]
  }

  async killAll(): Promise<void> {
    this.stopped = true
    this.stopReaper()

    const sessions = [...this.sessions.values()]
    this.sessions.clear()

    await Promise.all(sessions.map((session) => this.terminate(session)))
  }

  /**
   * SIGHUP, then SIGKILL if it is ignored, then give up waiting either way.
   *
   * Shutdown must not be able to hang: a pty whose child has stopped responding
   * to signals would otherwise keep the process alive past the point where
   * anything useful is happening. The escalation is worth the wait though --
   * nvim preserves its swap files on SIGHUP and does not get the chance on
   * SIGKILL.
   */
  private async terminate(session: NodePtySession): Promise<void> {
    if (session.exit !== null) return

    const exited = session.waitForExit()
    session.kill('SIGHUP')

    if (await raceTimeout(exited, this.killGraceMs)) return

    session.kill('SIGKILL')
    await raceTimeout(exited, this.killGraceMs)
  }

  /**
   * The environment nvim starts in.
   *
   * Inherited wholesale, like VS Code's terminal does, because half of what a
   * plugin manager needs lives there -- PATH, HOME, XDG_CONFIG_HOME, the locale
   * that decides whether nvim renders UTF-8 at all. Two deliberate exceptions:
   * TERM is ours because the client is xterm.js and not whatever the server was
   * started under, and NODE_OPTIONS is dropped because in dev it carries the tsx
   * loader, which would then be inherited by every node process nvim spawns and
   * break language servers in a way nobody would connect back to here.
   */
  private childEnvironment(): Record<string, string> {
    const inherited: Record<string, string> = {}

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (key === 'NODE_OPTIONS') continue
      inherited[key] = value
    }

    return {
      ...inherited,
      ...this.env,
      TERM: this.term,
      COLORTERM: 'truecolor',
    }
  }

  private startReaper(): void {
    if (this.reaper !== null) return

    this.reaper = setInterval(() => this.reap(), this.reapIntervalMs)
    // Never the reason the process stays up: an idle timer holding the event
    // loop open would turn a clean `killAll()` into a hang.
    this.reaper.unref()
  }

  private stopReaper(): void {
    if (this.reaper === null) return
    clearInterval(this.reaper)
    this.reaper = null
  }

  /**
   * Collect sessions nobody has been attached to for a while.
   *
   * Without this, every reload that abandons a session leaks an nvim until the
   * server restarts, and `maxSessions` turns into a wall the user hits for
   * reasons they cannot see. A session that has never been attached counts as
   * idle from the moment it was created, which is what catches a spawn whose
   * WebSocket upgrade then failed.
   */
  private reap(): void {
    const now = Date.now()

    for (const session of this.sessions.values()) {
      if (!session.isIdleSince(now, this.idleTimeoutMs)) continue

      try {
        session.kill('SIGHUP')
      } catch (error) {
        this.onError(error)
      }
    }

    // Nothing left to watch. The reaper restarts with the next spawn; leaving it
    // running would be harmless but this keeps an idle server genuinely idle.
    if (this.sessions.size === 0) this.stopReaper()
  }
}

/**
 * Refuse anything that would let a caller describe the child process.
 *
 * The port's options carry `command`, `args`, `cwd` and `env` because some
 * TerminalHost implementation might reasonably honour them -- a local pty in the
 * desktop app, say. This one is reachable from a tRPC procedure, so honouring
 * them would be arbitrary code execution behind a notes API.
 *
 * Refusing rather than ignoring is the same reflex as NotePath rejecting `..`
 * instead of resolving it: silently doing something other than what was asked is
 * how a caller ends up believing a confinement exists that does not. Our own
 * transport never sets these, so nothing legitimate can trip it.
 */
function assertNotClientShaped(options: TerminalSpawnOptions): void {
  const supplied = (['command', 'args', 'cwd', 'env'] as const).filter(
    (key) => options[key] !== undefined,
  )

  if (supplied.length > 0) {
    throw new TerminalHostError(
      `terminal ${supplied.join(', ')} may not be chosen by the caller; ` +
        'the command and notes root are fixed when the host is constructed',
    )
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.trunc(value)))
}

interface SessionOptions {
  cols: number
  rows: number
  scrollbackBytes: number
  onError: (error: unknown) => void
}

class NodePtySession implements PtySession {
  readonly id = randomUUID()

  private readonly scrollback: ScrollbackRing
  private readonly onErrorSink: (error: unknown) => void

  private readonly byteListeners = new Set<(chunk: Buffer) => void>()
  private readonly textListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(exit: TerminalExit) => void>()

  /**
   * Created on the first string listener and dropped with the last, so the byte
   * path never pays for a decode nobody asked for.
   *
   * The cost of starting late is bounded and worth stating: a listener that
   * subscribes exactly between the halves of a multi-byte character sees one
   * replacement character, because the leading bytes were delivered before it
   * existed and belong to a stream it was not watching. Every subsequent
   * boundary is held correctly, which is the property that actually matters.
   */
  private decoder: StringDecoder | null = null

  private currentCols: number
  private currentRows: number
  private attached = 0
  private pauseCount = 0
  private idleSince = Date.now()
  private exitState: TerminalExit | null = null

  constructor(
    private readonly pty: IPty,
    options: SessionOptions,
  ) {
    this.currentCols = options.cols
    this.currentRows = options.rows
    this.scrollback = new ScrollbackRing(options.scrollbackBytes)
    this.onErrorSink = options.onError

    // node-pty types `onData` as IEvent<string> unconditionally, but with
    // `encoding: null` the underlying tty stream is never given an encoding and
    // delivers Buffers. The cast is where that gap in the typings is absorbed;
    // it is asserted by the tests, which check `Buffer.isBuffer` on real output.
    this.pty.onData((chunk) => this.handleData(chunk as unknown as Buffer))
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal))
  }

  get cols(): number {
    return this.currentCols
  }

  get rows(): number {
    return this.currentRows
  }

  get exit(): TerminalExit | null {
    return this.exitState
  }

  get attachments(): number {
    return this.attached
  }

  get bytesProduced(): number {
    return this.scrollback.endOffset
  }

  write(data: string): void {
    this.writeBytes(Buffer.from(data, 'utf8'))
  }

  writeBytes(data: Buffer): void {
    if (this.exitState !== null) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exitState !== null) return

    const nextCols = clampDimension(cols, this.currentCols)
    const nextRows = clampDimension(rows, this.currentRows)
    if (nextCols === this.currentCols && nextRows === this.currentRows) return

    this.currentCols = nextCols
    this.currentRows = nextRows

    try {
      this.pty.resize(nextCols, nextRows)
    } catch (error) {
      // Racing the child's exit: the fd is gone but onExit has not landed yet.
      // Not worth propagating to whoever dragged the window.
      this.onErrorSink(error)
    }
  }

  /**
   * Resize away and back so the child repaints from scratch.
   *
   * Needed after a replay that could not be a perfect continuation: the client's
   * grid was rebuilt from a stream that started mid-history, so it may be
   * missing the escape that entered the alternate screen or set the current
   * colours. Replaying bytes gets the pixels approximately right; only the
   * application redrawing gets them actually right, and SIGWINCH is the one
   * lever that makes a full-screen application do that on demand.
   */
  nudgeRedraw(): void {
    if (this.exitState !== null) return

    const cols = this.currentCols
    const rows = this.currentRows
    const nudged = cols > MIN_DIMENSION ? cols - 1 : cols + 1

    this.resize(nudged, rows)
    this.resize(cols, rows)
  }

  onData(listener: (chunk: string) => void): Unsubscribe {
    this.decoder ??= new StringDecoder('utf8')
    this.textListeners.add(listener)

    let released = false
    return () => {
      if (released) return
      released = true
      this.textListeners.delete(listener)
      if (this.textListeners.size === 0) this.decoder = null
    }
  }

  onBytes(listener: (chunk: Buffer) => void): Unsubscribe {
    this.byteListeners.add(listener)

    let released = false
    return () => {
      if (released) return
      released = true
      this.byteListeners.delete(listener)
    }
  }

  onExit(listener: (exit: TerminalExit) => void): Unsubscribe {
    // A session that has already exited still has to tell a late subscriber, or
    // a socket that attached in the same tick as the child dying waits forever
    // for an event that has been and gone.
    if (this.exitState !== null) {
      const exit = this.exitState
      queueMicrotask(() => listener(exit))
      return () => {}
    }

    this.exitListeners.add(listener)

    let released = false
    return () => {
      if (released) return
      released = true
      this.exitListeners.delete(listener)
    }
  }

  /**
   * Everything the pty has produced since `offset`, or as much of it as is left.
   *
   * The offset is what makes reconnect cheap in the common case. A client that
   * kept its terminal across a dropped socket -- a phone whose wifi blinked --
   * asks for the bytes it has not seen and gets exactly those, with no duplicate
   * output and no reset. A client that reloaded the page passes null, gets the
   * whole ring, and is told to clear its grid first.
   *
   * `reset` also covers the case where the ring has already evicted the bytes
   * the client is asking to continue from: what is left is not a suffix of
   * anything the client has, so applying it to an existing grid would splice two
   * unrelated streams together.
   */
  scrollbackSince(offset: number | null): ScrollbackReplay {
    return this.scrollback.since(offset)
  }

  attach(): Unsubscribe {
    this.attached += 1

    let released = false
    return () => {
      if (released) return
      released = true
      this.attached -= 1

      if (this.attached > 0) return

      this.idleSince = Date.now()

      // Nobody is reading, so nothing should be blocked. A socket that paused
      // the pty and then died would otherwise leave it stopped forever, and the
      // next client to attach would find an nvim that never draws.
      this.pauseCount = 0
      this.safely(() => this.pty.resume())
    }
  }

  pause(): void {
    this.pauseCount += 1
    if (this.pauseCount === 1) this.safely(() => this.pty.pause())
  }

  resume(): void {
    if (this.pauseCount === 0) return
    this.pauseCount -= 1
    if (this.pauseCount === 0) this.safely(() => this.pty.resume())
  }

  kill(signal?: string): void {
    if (this.exitState !== null) return
    this.pty.kill(signal)
  }

  isIdleSince(now: number, timeoutMs: number): boolean {
    if (this.attached > 0) return false
    return now - this.idleSince >= timeoutMs
  }

  waitForExit(): Promise<TerminalExit> {
    if (this.exitState !== null) return Promise.resolve(this.exitState)
    return new Promise((resolve) => {
      this.onExit(resolve)
    })
  }

  private handleData(chunk: Buffer): void {
    this.scrollback.push(chunk)

    for (const listener of this.byteListeners) {
      this.safely(() => listener(chunk))
    }

    if (this.decoder === null) return

    const text = this.decoder.write(chunk)
    if (text === '') return

    for (const listener of this.textListeners) {
      this.safely(() => listener(text))
    }
  }

  private handleExit(exitCode: number, signal: number | undefined): void {
    if (this.exitState !== null) return

    // node-pty reports 0 for "no signal"; the port models that absence as
    // undefined so a caller cannot mistake it for signal number zero.
    const exit: TerminalExit = { code: exitCode, signal: signal === 0 ? undefined : signal }
    this.exitState = exit

    const tail = this.decoder?.end() ?? ''
    if (tail !== '') {
      for (const listener of this.textListeners) this.safely(() => listener(tail))
    }

    const listeners = [...this.exitListeners]
    this.exitListeners.clear()
    this.byteListeners.clear()
    this.textListeners.clear()
    this.decoder = null

    // The bytes are already at whoever was attached, and a dead session is not
    // resumable, so holding a quarter megabyte per corpse buys nothing.
    this.scrollback.clear()

    for (const listener of listeners) this.safely(() => listener(exit))
  }

  /**
   * A listener that throws must not take the pty's data handler down with it,
   * and a pty operation that loses a race with the child's exit must not become
   * an unhandled rejection somewhere unrelated.
   */
  private safely(run: () => void): void {
    try {
      run()
    } catch (error) {
      this.onErrorSink(error)
    }
  }
}

/**
 * Bounded scrollback, kept so that a reconnecting client sees something other
 * than a blank screen with a stale cursor on it.
 *
 * Eviction drops whole chunks. The only cut points that are not arbitrary are
 * the ones the pty already produced, and slicing mid-escape-sequence hands
 * xterm.js a fragment it renders as literal garbage. A single chunk larger than
 * the entire budget is the one case that has to be sliced, and its tail is kept:
 * memory is a hard bound, so something has to give.
 *
 * Serving a *suffix* to a resuming client is different and safe -- the cut is at
 * an offset the client has already consumed, so it is a boundary by definition.
 *
 * The alternative worth knowing about: keep a headless terminal emulator per
 * session and serialise its grid on attach, which is what tmux and ttyd do and
 * what makes their reattach exact. That trades a byte ring for a dependency and
 * a per-session emulator; the ring plus a forced redraw gets most of the way for
 * a fraction of the cost. Revisit if replay fidelity ever actually bites.
 */
class ScrollbackRing {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  /** Offset of the first byte still retained. Rises as chunks are evicted. */
  private startOffset = 0
  /** Offset one past the last byte ever produced. Only ever rises. */
  private produced = 0

  constructor(private readonly limit: number) {}

  get endOffset(): number {
    return this.produced
  }

  get byteLength(): number {
    return this.bytes
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return

    this.chunks.push(chunk)
    this.bytes += chunk.length
    this.produced += chunk.length

    while (this.bytes > this.limit && this.chunks.length > 1) {
      const evicted = this.chunks.shift()
      if (evicted === undefined) break
      this.bytes -= evicted.length
      this.startOffset += evicted.length
    }

    // One chunk, still over budget: `cat` of something large arriving as a
    // single read. Keeping the tail is what a scrollback is for.
    const only = this.chunks[0]
    if (only !== undefined && this.bytes > this.limit) {
      const kept = only.subarray(only.length - this.limit)
      this.chunks[0] = kept
      this.startOffset += only.length - kept.length
      this.bytes = kept.length
    }
  }

  since(offset: number | null): ScrollbackReplay {
    // Asking for more than has ever been produced means the client is resuming
    // against a different session's counter, or a bug. Either way its idea of
    // the stream is not ours, so start it over.
    if (offset === null || offset < this.startOffset || offset > this.produced) {
      return { bytes: Buffer.concat(this.chunks), offset: this.startOffset, reset: true }
    }

    let skip = offset - this.startOffset
    const parts: Buffer[] = []

    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length
        continue
      }
      parts.push(skip === 0 ? chunk : chunk.subarray(skip))
      skip = 0
    }

    return { bytes: Buffer.concat(parts), offset, reset: false }
  }

  clear(): void {
    this.chunks.length = 0
    this.bytes = 0
    this.startOffset = this.produced
  }
}

/** True if the promise settled first, false if the timeout won. */
async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref()
  })

  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
