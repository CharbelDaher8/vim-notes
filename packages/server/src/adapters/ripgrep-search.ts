/**
 * Search over the notes directory, delegated to ripgrep.
 *
 * Shelling out beats anything hand-rolled here: `rg` walks the tree, respects
 * encodings, skips binaries and matches with a linear-time regex engine, which
 * between them are more work than the rest of this server. It is an external
 * binary, so absence is handled explicitly rather than surfacing as a confusing
 * ENOENT.
 *
 * Two decisions worth knowing about:
 *
 * **The pattern comes from a URL.** It reaches an argument array via `spawn` and
 * never a shell, so quoting, `;`, `$(...)` and backticks are inert. `--`
 * precedes the pattern so one starting with `-` is a pattern rather than a flag.
 *
 * **`under` is containment-checked before it becomes an argument.** ripgrep does
 * not follow symlinks while walking a directory, but it *does* follow one handed
 * to it as an explicit path -- and it then reports the results under the
 * symlink's name, so `link/secret.md` comes back looking like an ordinary note
 * path that `parseNotePath` accepts. Search would be a way to read any file on
 * the box. `resolveContained` is what closes that.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

import {
  parseNotePath,
  SearchError,
  SearchUnavailableError,
  type NotePath,
  type Search,
  type SearchHit,
  type SearchQuery,
} from '@vim-notes/core'

import { resolveContained } from './path-containment'

// Defined in core alongside the note-store taxonomy: what a port can throw is
// part of its contract, and the API layer must be able to map these without
// importing an adapter. Re-exported so this module stays the one import site
// for anything ripgrep-related.
export { SearchError, SearchUnavailableError } from '@vim-notes/core'

export interface RipgrepSearchOptions {
  /** Overridable for tests and for a pinned binary in the container image. */
  binary?: string
  /** Upper bound on one search. rg is linear-time, so this is a backstop. */
  timeoutMs?: number
  /** Longest preview line handed back; a minified file should not be shipped. */
  maxPreviewLength?: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PREVIEW = 200
const MAX_STDERR = 8 * 1024

export class RipgrepSearch implements Search {
  private readonly root: string
  private readonly binary: string
  private readonly timeoutMs: number
  private readonly maxPreviewLength: number

  constructor(rootDirectory: string, options: RipgrepSearchOptions = {}) {
    if (!nodePath.isAbsolute(rootDirectory)) {
      throw new SearchError(
        `notes root must be an absolute path, got ${JSON.stringify(rootDirectory)}`,
      )
    }

    this.root = nodePath.resolve(rootDirectory)
    this.binary = options.binary ?? 'rg'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxPreviewLength = options.maxPreviewLength ?? DEFAULT_MAX_PREVIEW
  }

  async query(query: SearchQuery): Promise<SearchHit[]> {
    // The wire schema forbids this, but an empty pattern with --fixed-strings
    // matches every line of every note, so it is not something to find out
    // about later.
    if (query.pattern.length === 0) return []

    const searchPath = await this.searchPath(query.under)
    if (searchPath === null) return []

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

    return this.run(this.argumentsFor(query, searchPath, limit), limit)
  }

  /** The path to hand ripgrep, or null when there is nothing there to search. */
  private async searchPath(under: NotePath | undefined): Promise<string | null> {
    if (under === undefined) return '.'

    // Throws PathEscapeError if `under` leaves the root through a symlink. See
    // the note at the top of the file: this is the check that stops search
    // being a file-read primitive.
    const absolute = await resolveContained(this.root, under)

    try {
      await fs.stat(absolute)
    } catch {
      // A subtree that does not exist has no hits; it is not an error.
      return null
    }

    // Relative, because the child runs with cwd set to the notes root -- which
    // is also why the paths coming back are already relative to it.
    return under
  }

  private argumentsFor(query: SearchQuery, searchPath: string, limit: number): string[] {
    const args = [
      '--json',
      // Deterministic order, so a capped result set is the first N by path
      // rather than whichever N the thread pool finished first. It costs
      // parallelism; a personal notes directory is nowhere near big enough for
      // that to be the wrong trade.
      '--sort=path',
      // The store treats dotfiles as ordinary notes, so search has to see them.
      // .git is excluded by name rather than by being hidden.
      '--hidden',
      '--glob=!.git/',
      // Search exactly what the file tree shows. Honouring .gitignore would make
      // a note that is plainly visible in the tree silently unsearchable.
      '--no-ignore',
      // Per file, not overall -- rg has no global cap. It stops one enormous
      // note from consuming the whole budget; the overall limit is enforced here.
      `--max-count=${limit}`,
      query.caseSensitive === true ? '--case-sensitive' : '--ignore-case',
    ]

    if (query.regex !== true) args.push('--fixed-strings')

    // Everything after `--` is positional, so a pattern like `-i` is a pattern.
    args.push('--', query.pattern, searchPath)

    return args
  }

  private run(args: string[], limit: number): Promise<SearchHit[]> {
    return new Promise<SearchHit[]>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A user's ripgreprc could add --follow, which would walk straight out
        // of the notes directory through a symlink, or change case handling
        // under us. Searches should not depend on the operator's dotfiles.
        env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
      })

      const hits: SearchHit[] = []
      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        outcome()
      }

      const timer = setTimeout(() => {
        finish(() => {
          child.kill('SIGKILL')
          reject(new SearchError(`search timed out after ${this.timeoutMs}ms`))
        })
      }, this.timeoutMs)
      timer.unref()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (settled) return

        stdout += chunk
        const lines = stdout.split('\n')
        // The last piece is whatever arrived without its newline yet.
        stdout = lines.pop() ?? ''

        for (const line of lines) {
          const hit = this.parseHit(line)
          if (hit !== null) hits.push(hit)

          if (hits.length >= limit) {
            // Stop rg rather than reading and discarding the rest: a common word
            // in a large repository is a lot of JSON to parse for nothing.
            finish(() => {
              child.kill()
              resolve(hits.slice(0, limit))
            })
            return
          }
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() => {
          if (error.code === 'ENOENT') {
            reject(this.describeMissingBinary())
            return
          }
          reject(new SearchError(`could not run ${this.binary}: ${error.message}`))
        })
      })

      child.on('close', (code) => {
        finish(() => {
          // 0 is "matches found", 1 is "none found". Only 2 is a real failure.
          if (code === 0 || code === 1) {
            resolve(hits)
            return
          }
          reject(new SearchError(`${this.binary} exited with ${code}: ${stderr.trim()}`))
        })
      })
    })
  }

  /** Spawn reports a missing cwd and a missing binary identically. */
  private describeMissingBinary(): SearchError {
    return new SearchUnavailableError(
      `ripgrep (${this.binary}) is not installed or not on PATH, and search needs it`,
    )
  }

  private parseHit(line: string): SearchHit | null {
    if (line === '') return null

    let event: RipgrepEvent
    try {
      event = JSON.parse(line) as RipgrepEvent
    } catch {
      // begin/end/summary records and anything unrecognised are not hits.
      return null
    }

    if (event.type !== 'match') return null

    const text = event.data?.path?.text
    const lineText = event.data?.lines?.text
    const lineNumber = event.data?.line_number
    // `text` is absent when the path or the line is not valid UTF-8, in which
    // case rg sends bytes instead. Neither is addressable as a note.
    if (text === undefined || lineText === undefined || lineNumber === undefined) return null

    const parsed = parseNotePath(text)
    if (!parsed.ok) return null

    return {
      path: parsed.value,
      line: lineNumber,
      column: columnOf(lineText, event.data?.submatches?.[0]?.start ?? 0),
      preview: preview(lineText, this.maxPreviewLength),
    }
  }
}

interface RipgrepEvent {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: { start?: number }[]
  }
}

/**
 * ripgrep counts in bytes; editors count in characters.
 *
 * A hit after an emoji would otherwise be reported three columns further right
 * than where CodeMirror puts the cursor. Decoding the prefix converts to UTF-16
 * units, which is what a JavaScript string index actually is.
 */
function columnOf(lineText: string, byteOffset: number): number {
  const prefix = Buffer.from(lineText, 'utf8').subarray(0, byteOffset).toString('utf8')
  return prefix.length + 1
}

/**
 * Note that `column` indexes the line as it is in the file, not this preview:
 * they are separate fields and the preview has had its indentation removed.
 */
function preview(lineText: string, maxLength: number): string {
  const trimmed = lineText.replace(/\r?\n$/, '').trim()
  if (trimmed.length <= maxLength) return trimmed

  // Sliced by code point so a truncation cannot land inside a surrogate pair and
  // produce a lone half of an emoji.
  return `${[...trimmed].slice(0, maxLength).join('')}…`
}
