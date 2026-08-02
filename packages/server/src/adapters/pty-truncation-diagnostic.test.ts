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
 * Neither. The loss was the transport pausing the pty for back pressure, and it
 * disappeared when that pause was removed -- see the terminal socket. The drain
 * window added alongside it is what made the failure legible enough to diagnose
 * in the first place, but the pause is what destroyed the bytes.
 *
 * Hypothesis B is also refuted on its own terms, which is worth recording so
 * nobody re-derives it: `maxChunkSeen` on Linux is 36545, nine times the 4096
 * the inference rested on, so "3397 is one discarded read" never followed.
 *
 * It now asserts rather than reports, because a test that only prints cannot
 * catch this coming back -- and coming back is plausible, since anything that
 * reintroduces flow control on the pty reintroduces the bug.
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

    // Per size, because "the shortfall grows with the payload" is one of the two
    // predictions and a single worst-case number cannot show it either way.
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
        `maxChunkSeen=${Math.max(...measurements.map((m) => m.maxChunk))} ` +
        `verdict=${verdict(measurements)}`,
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

/**
 * Which hypothesis the numbers fit, including "neither".
 *
 * *How often* loss happens matters as much as how big it is, and reading only
 * the size would get this backwards. A discarded read at teardown is structural:
 * it should happen on essentially every run, bounded by one buffer, and not care
 * how much was sent. The 200ms destroy is a race against a stalled event loop:
 * it should be intermittent, and take more when more was in flight. So a run
 * that loses 3397 bytes twice out of nine is evidence *against* the structural
 * explanation, even though every number involved is under 4096.
 *
 * Returning 'inconclusive' is a real answer here. Two candidates were enumerated
 * from what was known at the time and there is no reason the truth has to be one
 * of them; forcing a binary would launder a guess into a finding.
 */
function verdict(measurements: Measurement[]): string {
  const lossy = measurements.filter((m) => m.shortfall > 0)
  if (lossy.length === 0) return 'no-loss-here'
  if (!measurements.every((m) => m.exactPrefix)) return 'inconclusive-not-a-clean-truncation'

  const losses = lossy.map((m) => m.shortfall)
  const everyRunLost = lossy.length === measurements.length
  const withinOneRead = Math.max(...losses) < 4096
  const clustered = Math.max(...losses) - Math.min(...losses) < 1024

  if (everyRunLost && withinOneRead && clustered) return 'consistent-with-one-discarded-read'

  // Intermittent, or larger than a buffer, or wandering: all three are what a
  // race against a 200ms timer looks like and none is what a fixed cap does.
  if (!everyRunLost || !withinOneRead) return 'consistent-with-the-200ms-destroy'

  return 'inconclusive-loss-is-bounded-but-uneven'
}
