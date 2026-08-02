/**
 * TEMPORARY. Delete this file once the numbers have been read.
 *
 * It exists to settle one question on Linux CI, where
 * `node-pty-terminal-host.test.ts` loses the tail of a 200KB burst through a
 * pty. That run reported `truncated: an exact prefix, 3397 of 200000 trailing
 * bytes never arrived` -- an exact prefix, so nothing is corrupting bytes;
 * something below the adapter is discarding the end of the stream.
 *
 * Two candidates, and they predict different numbers:
 *
 *   A. node-pty's `DESTROY_SOCKET_TIMEOUT_MS`. 200ms after the child is reaped
 *      it calls `_socket.destroy()` on the pty master whether or not anything
 *      has read what is left in it. That takes *whatever happens to be queued*,
 *      which on Linux can be up to the 64KB tty buffer, and only fires when the
 *      event loop has stalled past 200ms. Prediction: the shortfall varies
 *      run to run, and grows with payload size as more is in flight.
 *
 *   B. One discarded read at teardown. Linux returns EIO from a pty master once
 *      the slave closes, Node turns that into `stream.destroy(err)`, and a
 *      destroyed Readable drops whatever is still in its buffer -- where macOS
 *      gets a clean EOF that drains first. A single read from a Linux pty
 *      master is capped at `N_TTY_BUF_SIZE`, which is 4096. Prediction: the
 *      shortfall stays under 4096 at every size, and is roughly stable.
 *
 * 3397 is under 4096, which is what makes B worth testing. `maxChunk` below is
 * the direct check on the premise: if Linux reads cap at 4096 and macOS at
 * 1024, that is the read granularity the whole inference rests on.
 *
 * Reports rather than asserts, on purpose. The point is to read numbers off a
 * CI log, and a failing assertion would stop the run before later sizes were
 * measured. Neither mechanism is fixable from this repository -- both destroy
 * the bytes before the adapter is told anything -- so this decides what the
 * skip comment on the real test should honestly say, not whether to ship.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import { NodePtyTerminalHost } from './node-pty-terminal-host'

const SIZES = [50 * 1024, 200 * 1024, 1024 * 1024]
const REPEATS = 3

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

describe('pty truncation diagnostic', () => {
  it('reports the shortfall at three payload sizes', async () => {
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

    // The reading, stated so the log says what it means without anyone having
    // to come back to this file.
    const shortfalls = measurements.map((m) => m.shortfall)
    const worst = Math.max(...shortfalls)
    const anyLoss = worst > 0
    const allUnderOneRead = worst < 4096
    const everyLossIsAPrefix = measurements.every((m) => m.exactPrefix)

    report(
      `PTY-DIAG-SUMMARY platform=${process.platform} ` +
        `worstShortfall=${worst} allUnderOneRead=${allUnderOneRead} ` +
        `everyLossIsAPrefix=${everyLossIsAPrefix} ` +
        `maxChunkSeen=${Math.max(...measurements.map((m) => m.maxChunk))} ` +
        `verdict=${verdict(anyLoss, allUnderOneRead, shortfalls)}`,
    )

    // The only assertion: that the diagnostic ran. Anything stronger would
    // stop the run at the first size and lose the comparison that is the
    // entire purpose.
    expect(measurements).toHaveLength(SIZES.length * REPEATS)
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

function verdict(anyLoss: boolean, allUnderOneRead: boolean, shortfalls: number[]): string {
  if (!anyLoss) return 'no-loss-here'

  // A single discarded read is bounded by the buffer size and does not care how
  // much was sent; a timeout takes whatever was queued, so it grows and wanders.
  const spread = Math.max(...shortfalls) - Math.min(...shortfalls.filter((n) => n > 0))
  if (allUnderOneRead && spread < 4096) return 'consistent-with-one-discarded-read'
  return 'consistent-with-the-200ms-destroy'
}
