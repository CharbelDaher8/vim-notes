/**
 * Ticking a checkbox, expressed as an edit to the markdown.
 *
 * There is no task record anywhere to flip a boolean on -- the line in the file
 * is the task (DECISIONS.md §1) -- so "done" is a text edit, and the panel is
 * an editor with a very small keyboard. Three states have to be handled, and
 * the third is the interesting one:
 *
 *   `- [x] TODO ship it`   done      -> rewrite the box to `[ ]`
 *   `- [ ] TODO ship it`   open      -> rewrite the box to `[x]`
 *   `TODO ship it`         not asked -> there is no box; one has to be *inserted*
 *
 * The last case is not a rewrite at all. A bare `TODO` was never offered the
 * question, so ticking it has to add the checkbox, and add a list marker with
 * it when the line has none -- `[x] TODO x` parses here but renders as literal
 * brackets in every other markdown tool, and the file has to stay good markdown
 * for the copy that gets read in nvim.
 *
 * Pure, and it re-parses the content it was handed rather than trusting the
 * line number it was given, because the panel's line numbers came from an index
 * built before nvim's last write.
 */
import { parseNoteMarkup } from '@vim-notes/core'

export type AnnotationEdit =
  | { ok: true; content: string }
  /** The line is gone, or is no longer the task the panel was showing. */
  | { ok: false; reason: 'moved' }

/**
 * Mirrors the prefix of core's annotation pattern exactly: indentation, an
 * optional list marker, an optional checkbox. Kept in step with
 * `note-markup.ts` by construction -- step 1 below guarantees the line already
 * matched there, so anything this fails to match is a bug in one of the two.
 */
const PREFIX = /^(\s*)((?:[-*+]|\d+[.)])\s+)?(\[[ xX]\]\s+)?/

export function setAnnotationDone(
  content: string,
  line: number,
  text: string,
  done: boolean,
): AnnotationEdit {
  // 1. Is this still the task the user tapped? The full parse rather than a
  //    look at the one line, because a fence opened above it would mean the
  //    line is a code sample now and not a task at all.
  const annotation = parseNoteMarkup(content).annotations.find(
    (candidate) => candidate.line === line,
  )
  if (annotation === undefined || annotation.text !== text) return { ok: false, reason: 'moved' }

  const lines = content.split('\n')
  const raw = lines[line - 1]
  if (raw === undefined) return { ok: false, reason: 'moved' }

  const match = PREFIX.exec(raw)
  if (match === null) return { ok: false, reason: 'moved' }

  const [prefix, indent = '', marker = '', checkbox] = match
  const box = done ? '[x]' : '[ ]'
  const rest = raw.slice(prefix.length)

  lines[line - 1] =
    checkbox === undefined
      ? // Nothing to flip. A line with no list marker gets one, so the result
        // is a task item every markdown renderer agrees about.
        `${indent}${marker === '' ? '- ' : marker}${box} ${rest}`
      : // Flip in place, keeping whatever spacing followed the box so the file
        // does not pick up a whitespace diff nobody asked for.
        `${indent}${marker}${box}${checkbox.slice(3)}${rest}`

  return { ok: true, content: lines.join('\n') }
}

export function describeAnnotationEdit(path: string): string {
  return `${path} changed since this list was built. It has been refreshed — try again.`
}
