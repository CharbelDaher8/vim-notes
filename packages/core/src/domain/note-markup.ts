/**
 * Everything this app knows beyond "a note is text" is parsed back out of the
 * markdown, never stored beside it.
 *
 * That is the whole reason a TODO typed in nvim in the pty shows up in the
 * todo list without nvim knowing anything about this app, and the reason none
 * of it can drift out of sync with the file. It also means the derived data is
 * disposable: delete the index and it rebuilds, because the notes are the only
 * copy that matters (DECISIONS.md §1).
 *
 * Pure and line-oriented, so it lives in core and runs identically in the
 * browser for optimistic updates and on the server for the index.
 */

import type { NotePath } from './note-path'

export type AnnotationKind = 'todo' | 'reminder'

export interface Annotation {
  kind: AnnotationKind
  /** Everything after the keyword, trimmed. Never empty -- see the parser. */
  text: string
  /** 1-indexed, matching what editors display. */
  line: number
  /**
   * Checkbox state, or null when the line has no checkbox at all.
   *
   * Three states rather than a boolean: `- [ ] TODO x` is explicitly open,
   * `- [x] TODO x` is explicitly done, and a bare `TODO x` has not been asked.
   * Rendering "not asked" as "not done" is right for a todo list, but the
   * distinction matters for deciding whether ticking it should rewrite the line
   * or insert a checkbox.
   */
  done: boolean | null
  /** ISO date found in the text, or null. */
  due: string | null
}

export interface WikiLink {
  /** Target exactly as written inside the brackets, before resolution. */
  target: string
  /** What to display: the alias if one was given, otherwise the target. */
  label: string
  /** 1-indexed. */
  line: number
  /** Character offsets of the whole `[[...]]` within its line. */
  start: number
  end: number
}

export interface NoteMarkup {
  annotations: Annotation[]
  links: WikiLink[]
}

/**
 * Keywords are matched case-insensitively at the start of a line.
 *
 * Case-insensitive because nobody types consistently, and anchored to the line
 * start because that is the gesture -- "put TODO before a line" -- and because
 * an unanchored match would claim every sentence that mentions the word.
 */
const ANNOTATION = new RegExp(
  [
    '^',
    '\\s*', // indentation
    '(?:[-*+]\\s+|\\d+[.)]\\s+)?', // optional list marker
    '(?:\\[([ xX])\\]\\s+)?', // optional checkbox, captured
    '(todo|reminder)', // the keyword
    '(?:\\s*:|\\s+|$)', // a colon, whitespace, or end of line
    '(.*)$',
  ].join(''),
  'i',
)

/** `[[target]]` or `[[target|label]]`. Non-greedy so `[[a]] [[b]]` is two. */
const WIKILINK = /\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/

/** ``` or ~~~ opening or closing a fenced block. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

export function parseNoteMarkup(content: string): NoteMarkup {
  const annotations: Annotation[] = []
  const links: WikiLink[] = []

  let fence: string | null = null

  // Split on either ending, so a `\r` never survives into a line.
  //
  // This is not cosmetic. The annotation pattern ends `(.*)$`, and in JavaScript
  // `.` does not match `\r` while an unanchored `$` only matches the very end of
  // the string -- so a single trailing carriage return made the whole pattern
  // fail and silently dropped every task in the note. A repository checked out
  // on Windows with core.autocrlf on is exactly that case, and the symptom is an
  // empty todo panel rather than an error.
  content.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1

    // Code blocks are skipped entirely. A shell snippet containing `# TODO` is
    // a quotation, not a task, and pulling it into someone's todo list would
    // make the feature untrustworthy the first time it happened.
    const fenceMatch = FENCE.exec(raw)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? ''
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      return
    }
    if (fence !== null) return

    const annotation = parseAnnotation(raw, line)
    if (annotation !== null) annotations.push(annotation)

    links.push(...parseLinks(raw, line))
  })

  return { annotations, links }
}

function parseAnnotation(raw: string, line: number): Annotation | null {
  const match = ANNOTATION.exec(raw)
  if (match === null) return null

  const checkbox = match[1]
  const keyword = (match[2] ?? '').toLowerCase()
  const text = (match[3] ?? '').trim()

  // A bare `TODO` with nothing after it is somebody starting to type, not a
  // task. Listing it would put an empty row in the panel that cannot be acted
  // on and cannot be dismissed except by editing the note.
  if (text === '') return null

  return {
    kind: keyword === 'reminder' ? 'reminder' : 'todo',
    text,
    line,
    done: checkbox === undefined ? null : checkbox.toLowerCase() === 'x',
    due: parseIsoDate(text),
  }
}

function parseLinks(raw: string, line: number): WikiLink[] {
  const found: WikiLink[] = []

  WIKILINK.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = WIKILINK.exec(raw)) !== null) {
    const target = (match[1] ?? '').trim()
    if (target === '') continue

    const alias = match[2]?.trim()

    found.push({
      target,
      label: alias === undefined || alias === '' ? target : alias,
      line,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return found
}

/**
 * Validated rather than merely shaped: `2026-02-31` matches the pattern and is
 * not a day. A due date that silently rolls into March is worse than none.
 */
export function parseIsoDate(text: string): string | null {
  const match = ISO_DATE.exec(text)
  if (match === null) return null

  const [, year, month, day] = match
  const iso = `${year}-${month}-${day}`

  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null

  // Round-trip catches overflow, which the Date constructor performs silently.
  return date.toISOString().slice(0, 10) === iso ? iso : null
}

const JOURNAL_BASENAME = /^(\d{4}-\d{2}-\d{2})(?:\.md)?$/

/**
 * The day a note is about, from its filename.
 *
 * Matched on the basename rather than a fixed `journal/` prefix so that however
 * someone chooses to file their days -- `journal/`, `daily/`, one flat folder --
 * the dailies still join up in the graph. A note is a day if it is named like
 * one.
 */
export function journalDateOf(path: NotePath): string | null {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const match = JOURNAL_BASENAME.exec(basename)
  if (match === null) return null

  return parseIsoDate(match[1] ?? '')
}
