/**
 * Turning "i spent 500 on groceries" into a line in today's journal.
 *
 * The command box is allowed to be forgiving in a way the note parser is not.
 * `parseSpendLine` anchors its keyword to the start of a line and refuses a
 * leading "I", because in a note an unanchored match would claim every sentence
 * that mentions spending (DECISIONS.md §12). Here there is no such risk -- the
 * whole input is the command -- so the phrasings people actually type are
 * accepted and **normalised to the canonical form before being written**.
 *
 * That normalisation is what keeps the two grammars from drifting: whatever is
 * typed, the file gets `Spent 500 on groceries`, and the file is the only thing
 * anything reads back. The preview shown before committing is likewise produced
 * by running the real parser over the line that is about to be written, so what
 * the user is shown and what the index will later find cannot disagree.
 */
import { parseSpendLine, type SpendEntry } from '@vim-notes/core'

export interface SpendDraft {
  /** The exact markdown line to append. Always canonical. */
  line: string
  /** The ISO day whose journal it belongs in. */
  date: string
  /**
   * The parse of `line`, for previewing.
   *
   * Produced by the same function the index uses, deliberately -- a preview
   * computed a second way is a preview that can lie.
   */
  entry: SpendEntry
}

/**
 * Openings that mean "this is a spend", stripped before canonicalising.
 *
 * `spent` and `spend` cover the keyword itself; the optional `i` in front is
 * the phrasing this feature was actually asked for. Anything else -- including
 * a bare number -- falls through and is treated as an amount, so `500
 * groceries` works with no keyword at all.
 */
const OPENING = /^\s*(?:i\s+)?(?:spent|spend|spending)\s*:?\s*/i

/**
 * A capture input, or null when there is nothing spendable in it.
 *
 * `today` is passed rather than read, both so the caller owns what timezone
 * "today" means and so this stays testable without mocking the clock.
 */
export function parseSpendCommand(input: string, today: string): SpendDraft | null {
  const body = input.replace(OPENING, '').trim()
  if (body === '') return null

  const line = `Spent ${body}`
  const entry = parseSpendLine(line, 1)
  if (entry === null) return null

  // A date written into the command wins over today, so "spent 25 books
  // 2026-07-15" files under July even though it is being typed in August. The
  // line still goes in today's journal -- the note is where it was written,
  // `on` is when it happened, and the index already keeps those apart.
  return { line, date: today, entry }
}

/** Does this input look like it is meant to be a spend? Used to route a command. */
export function looksLikeSpend(input: string): boolean {
  return OPENING.test(input)
}

/**
 * Append a spend to a note, or start one.
 *
 * Appends rather than inserting anywhere clever: a journal is written top to
 * bottom, and a capture command that reordered somebody's note to keep its
 * spends together would be rearranging prose it did not write.
 */
export function appendSpendLine(content: string | null, draft: SpendDraft): string {
  if (content === null || content.trim() === '') return `${draft.line}\n`

  // Exactly one newline between the last line and this one, whether or not the
  // file ended with a break. A note that gains a blank line every time
  // something is captured drifts steadily apart.
  const trimmed = content.replace(/\n+$/, '')

  return `${trimmed}\n${draft.line}\n`
}
