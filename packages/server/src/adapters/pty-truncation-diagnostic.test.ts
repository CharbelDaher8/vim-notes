/**
 * A pty must deliver every byte a program wrote before it exited.
 *
 * This began as a temporary diagnostic. Linux CI was losing the tail of a
 * 200KB burst -- "truncated: an exact prefix, 3397 of 200000 trailing bytes
 * never arrived" -- while macOS delivered all of it, and the question was which
 * of two mechanisms below the adapter was discarding the end of the stream:
 *
 *   A. node-pty destroys the pty master 200ms after reaping the child, taking
 *      whatever is still queued. Predicts a shortfall that varies run to run
 *      and grows with payload size.
 *   B. One discarded read at teardown, Linux returning EIO where macOS gets a
 *      clean EOF. A single read from a Linux pty master was believed capped at
 *      N_TTY_BUF_SIZE (4096), and 3397 is under that. Predicts a stable
 *      shortfall under 4096 at every size.
 *
 * **B is refuted.** `maxChunkSeen` on Linux is 36545 -- nine times the 4096 the
 * inference rested on -- so "3397 bytes is one discarded read" never followed.
 * Recorded so nobody re-derives it.
 *
 * **A is not refuted, and is not confirmed either.** Linux now reports zero loss
 * at every size, and it is tempting to read that as fixed. Be careful: nothing
 * that changed between the failing run and the green one can explain it.
 *
 *   - It is not the transport pausing the pty. That was a real bug, separately
 *     measured at 0 of 700 bytes recovered, and worth removing -- but no test in
 *     this file or in `node-pty-terminal-host.test.ts` constructs a socket or
 *     calls `pause`, so it cannot have destroyed bytes here.
 *   - It is not the scrollback default rising to 4MB. The payload that failed
 *     was 200000 bytes against a 262144-byte ring: nothing was evicted either
 *     way, and these tests read from `onBytes` rather than the ring regardless.
 *   - It is not the drain window, which was already in place for the run that
 *     lost 3397 bytes.
 *
 * What is left is that the failure is *intermittent*, which is exactly what A
 * predicts: a race against an event loop stalled past node-pty's 200ms socket
 * destroy fires on a loaded runner and not on an idle one. One green run cannot
 * show the absence of an intermittent fault.
 *
 * And A explains the platform split without needing anything exotic. What can be
 * lost is bounded by what a child can leave unread when it is reaped, which is
 * the pty's write capacity. Measured here: a child writing to a pty nobody reads
 * finishes and exits at 1024 bytes and blocks at 2048, so macOS holds on the
 * order of one kilobyte. Linux holds 64KB. The 3397 bytes that went missing are
 * impossible on macOS and unremarkable on Linux.
 *
 * A corollary, so nobody repeats the experiment: A cannot be reproduced on macOS
 * by stalling the event loop, and failing to reproduce it there says nothing.
 * Tried, with every gap between reads blocked past 200ms -- zero loss in eleven
 * runs, because there is never more than a kilobyte outstanding to lose and it
 * drains in a single read. Demonstrating A needs that experiment on Linux.
 *
 * So this asserts rather than reports, and the assertion is the point. If it
 * goes red again on Linux with a shortfall that varies between runs, that is not
 * a regression to hunt in this repository -- it is A, confirmed, and unfixable
 * from here because node-pty destroys the bytes before the adapter is told
 * anything. Read the table before assuming anyone broke something.
 *
 * Two things to leave alone:
 *
 *   - `process.stdout.write`, not `console.log`. Vitest's default reporter --
 *     what `pnpm test` and CI use -- captures console output from a *passing*
 *     test and discards it. Tidying this back produces a silent empty log,
 *     which is worse than no output because it reads as a result.
 *   - `maxChunk` is reported even when everything passes. It is the direct
 *     measurement of read granularity, and it is what refuted B; a future
 *     failure is only interpretable next to it.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import { NodePtyTerminalHost } from './node-pty-terminal-host'

const SIZES = [50 * 1024, 200 * 1024, 1024 * 1024]
const REPEATS = 2

interface Measurement {
  size: number
  run: number
  received: number
  shortfall: number
  exactPrefix: boolean
  chunks: number
  maxChunk: number
  elapsedMs: number
}

async function measure(size: number, run: number): Promise<Measurement> {
  const root = nodePath.join(await fs.realpath(tmpdir()), `pty-diag-${randomUUID()}`)
  await fs.mkdir(root, { recursive: true })

  // A repeating pattern rather than a constant byte, so that a shortfall in the
  // middle of the stream would show up as a divergence rather than hiding.
  const pattern = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const content = pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size)
  const file = nodePath.join(root, 'payload.txt')
  await fs.writeFile(file, content, 'utf8')

  const host = new NodePtyTerminalHost({ notesRoot: root, command: '/bin/cat', args: [file] })

  try {
    const session = await host.spawn({ cols: 80, rows: 24 })
    const chunks: Buffer[] = []
    session.onBytes((chunk) => chunks.push(chunk))

    const started = Date.now()
    await session.waitForExit()
    const elapsedMs = Date.now() - started

    const got = Buffer.concat(chunks)
    const expected = Buffer.from(content, 'utf8')

    return {
      size,
      run,
      received: got.length,
      shortfall: expected.length - got.length,
      exactPrefix: got.equals(expected.subarray(0, got.length)),
      chunks: chunks.length,
      maxChunk: chunks.reduce((widest, chunk) => Math.max(widest, chunk.length), 0),
      elapsedMs,
    }
  } finally {
    await host.killAll()
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe('pty delivery under load', () => {
  it('delivers every byte at three payload sizes', async () => {
    const measurements: Measurement[] = []

    for (const size of SIZES) {
      for (let run = 1; run <= REPEATS; run++) {
        measurements.push(await measure(size, run))
      }
    }

    for (const m of measurements) {
      report(
        `PTY-DIAG platform=${process.platform} size=${m.size} run=${m.run} ` +
          `received=${m.received} shortfall=${m.shortfall} exactPrefix=${m.exactPrefix} ` +
          `chunks=${m.chunks} maxChunk=${m.maxChunk} elapsedMs=${m.elapsedMs}`,
      )
    }

    // Per size, because a single worst-case number cannot show whether a
    // shortfall scales with the payload -- which is the first thing worth
    // knowing about any future regression, and was the first thing worth
    // knowing about this one.
    for (const size of SIZES) {
      const runs = measurements.filter((m) => m.size === size)
      const lossy = runs.filter((m) => m.shortfall > 0)
      report(
        `PTY-DIAG-BY-SIZE size=${size} lossyRuns=${lossy.length}/${runs.length} ` +
          `worst=${Math.max(...runs.map((m) => m.shortfall))} ` +
          `mean=${Math.round(runs.reduce((total, m) => total + m.shortfall, 0) / runs.length)}`,
      )
    }

    report(
      `PTY-DIAG-SUMMARY platform=${process.platform} ` +
        `lossyRuns=${measurements.filter((m) => m.shortfall > 0).length}/${measurements.length} ` +
        `worstShortfall=${Math.max(...measurements.map((m) => m.shortfall))} ` +
        `everyLossIsAPrefix=${measurements.every((m) => m.exactPrefix)} ` +
        `maxChunkSeen=${Math.max(...measurements.map((m) => m.maxChunk))}`,
    )

    expect(measurements).toHaveLength(SIZES.length * REPEATS)

    // Asserted after every measurement is reported, not inside the loop. A
    // failure here is only interpretable next to the whole table -- whether the
    // shortfall grows with payload size, and what `maxChunk` was when it
    // happened, are what distinguish the mechanisms. Failing at the first size
    // would throw that away and leave whoever reads the log guessing.
    const lossy = measurements.filter((m) => m.shortfall > 0)

    expect(
      lossy.map((m) => `size=${m.size} run=${m.run} lost=${m.shortfall}`),
      'a pty dropped bytes a program had already written; see the reported table above',
    ).toEqual([])
  }, 120_000)
})

/**
 * `process.stdout.write` and not `console.log`, which is the difference between
 * this file working and this file being an empty CI log.
 *
 * Vitest's default reporter -- the one `pnpm test` and therefore CI use --
 * captures `console.log` from a passing test and never prints it. It does not
 * intercept direct stream writes. Verified both ways before relying on it. Do
 * not "tidy" this back into `console.log`: the failure is silent, and a
 * diagnostic that reports nothing is worse than no diagnostic, because it looks
 * like an answer.
 */
function report(line: string): void {
  process.stdout.write(`${line}\n`)
}
