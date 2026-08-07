/**
 * Money written in a note, parsed back out of it.
 *
 * This follows DECISIONS.md §12 exactly as the todo list does: a spend is a
 * line of markdown and nothing else. There is no ledger table, no running
 * total stored anywhere, and no write-back. `Spent 12.40 coffee` typed into
 * nvim in the pty reaches the budget pane because the pane recomputes from the
 * files, not because anything told it.
 *
 * **The balance is a fold, never a field**, and that is the whole design. A
 * stored balance would be a second source of truth the moment a note is edited
 * outside the app or a `git pull` brings a spend in from the phone -- which is
 * precisely the thing §1 is built to avoid. So the opening figure and the
 * monthly income are themselves lines (`parseBudgetDeclaration` below), the
 * spends are lines, and "what do I have" is arithmetic over them, done fresh
 * every time. Deleting the index costs nothing. Correcting a typo in a spend
 * from three weeks ago corrects the balance.
 *
 * Everything here is pure and line-oriented so it can live in core and run
 * identically in the browser and on the server, like `parseNoteMarkup` around
 * it -- which is where these parsers are actually called from.
 */

/**
 * Amounts are integer **minor units** -- cents, pence, fils -- everywhere in
 * this module and everywhere downstream of it.
 *
 * Money in a float is a bug with a delay on it: `0.1 + 0.2` is famously not
 * `0.3`, and a budget is a long chain of additions where that error compounds
 * silently until a total is off by a cent and nothing in the code looks wrong.
 * Parsing is therefore string-based, never `parseFloat`.
 *
 * **The exponent is fixed at 2**, which is a real simplification rather than a
 * universal truth: JPY and KRW have no minor unit, and a few currencies use
 * three digits. Getting that right needs a table of ISO 4217 exponents, and
 * for a single-user budget written in one or two currencies it would be
 * scaffolding. The consequence to know is that a JPY amount is stored 100x
 * larger than its true minor units, which is invisible as long as formatting
 * divides by the same constant -- and it does.
 */
export const MINOR_UNITS_PER_MAJOR = 100

/** One logged expense. */
export interface SpendEntry {
  /** Integer minor units. Always positive -- see the note in the parser. */
  amountMinor: number
  /**
   * ISO 4217 code as written, or null when none was given.
   *
   * Null means "whatever the account is in" rather than a default baked in
   * here. The parser cannot know the account currency -- it sees one line --
   * so it reports absence and the fold resolves it.
   */
  currency: string | null
  /** Lowercased grouping key. Never empty; see `UNCATEGORISED`. */
  category: string
  /** Everything after the amount, exactly as written, for display. */
  text: string
  /** 1-indexed, matching what editors display. */
  line: number
  /**
   * An explicit ISO date found in the text, or null.
   *
   * Null is the common case and is not a missing value: the note's own day
   * stands in for it, the same way `AnnotationRecord.day` works. Typing a date
   * is for logging something you forgot at the time.
   */
  date: string | null
}

export type BudgetDeclarationKind = 'balance' | 'income'

/**
 * A `Balance:` or `Income:` line -- the two figures the fold cannot derive.
 *
 * These are declarations rather than events, which is why they are a separate
 * type from `SpendEntry`. Ten spends are ten facts that add up; ten `Balance:`
 * lines are nine stale ones and a current one, and the fold has to pick.
 */
export interface BudgetDeclaration {
  kind: BudgetDeclarationKind
  amountMinor: number
  currency: string | null
  /**
   * For `balance`, the date the figure was true, from `as of <date>` or a bare
   * ISO date on the line. Null when undated.
   *
   * This is load-bearing rather than decorative. Income accrues *from* this
   * date, so an undated opening balance makes "how much do I have" undefined
   * -- there is no answer to how many months of salary have landed since an
   * unknown moment. The fold's handling of null is where that surfaces.
   */
  asOf: string | null
  /**
   * The accrual period for `income`. Null for `balance`.
   *
   * Only `month` exists. Anything else -- weekly, fortnightly, "every fourth
   * Friday" -- needs syntax that survives round-tripping through plain
   * markdown, which is the same unsolved problem DECISIONS.md lists under
   * recurring reminders. One period that works beats four that half-work.
   */
  period: 'month' | null
  line: number
}

/** Where a spend with nothing to group it by ends up. */
export const UNCATEGORISED = 'uncategorised'

/**
 * Keyword anchored to the start of a line, case-insensitive, with an optional
 * list marker -- the same grammar `parseNoteMarkup` uses for TODO and Reminder,
 * for the same two reasons: it matches the gesture ("put Spent before a line"),
 * and an unanchored match would claim every sentence that mentions spending.
 *
 * No checkbox is accepted, and that is deliberate rather than an omission. A
 * spend has no open state to tick -- it happened.
 */
const SPEND = new RegExp(
  [
    '^',
    '\\s*', // indentation
    '(?:[-*+]\\s+|\\d+[.)]\\s+)?', // optional list marker
    'spent', // the keyword
    '(?:\\s*:|\\s+)', // a colon or whitespace, but not end of line
    '(.*)$',
  ].join(''),
  'i',
)

const DECLARATION = new RegExp(
  ['^', '\\s*', '(?:[-*+]\\s+)?', '(balance|income)', '\\s*:\\s*', '(.*)$'].join(''),
  'i',
)

/**
 * Symbols worth recognising, which is not the same as every symbol that exists.
 *
 * A symbol is unambiguous in a way a bare word is not, so these are safe on
 * either side of the number. The list is short on purpose: an unrecognised
 * symbol falls through to "no currency given", which the fold reads as the
 * account's own, and that is the right answer far more often than guessing.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₪': 'ILS',
}

const SYMBOL_CLASS = '[$€£¥₹₪]'

/**
 * A currency code is matched **only in upper case**, and that is a rule with a
 * reason rather than an oversight.
 *
 * `Spent 500 gas` and `Spent 500 CAD` are the same shape: a number followed by
 * three letters. Matching case-insensitively would read `gas` as a currency and
 * silently drop the category -- and `try`, `cad`, `sar` and `led` are all real
 * codes and real English words, so a known-code list does not save it either.
 * Requiring capitals costs `Spent 500 usd rent` and buys a parser that never
 * mistakes a category for a currency.
 */
const MONEY = new RegExp(
  [
    '^',
    `(${SYMBOL_CLASS})?`, // leading symbol
    '\\s*',
    '(\\d{1,3}(?:,\\d{3})+|\\d+)', // digits, optionally grouped
    '(?:\\.(\\d+))?', // fraction
    '\\s*',
    `(${SYMBOL_CLASS}|[A-Z]{3})?`, // trailing symbol or code
    '(?![\\w.])', // not mid-word, and not the start of a longer number
  ].join(''),
)

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/

/** `as of 2026-08-01`, the phrase that dates an opening balance. */
const AS_OF = /\bas\s+of\s+(\d{4}-\d{2}-\d{2})\b/i

/** `#groceries` -- an explicit category, for when the first word is not one. */
const CATEGORY_TAG = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/u

/**
 * Words that introduce the thing bought rather than naming it.
 *
 * Without this, `Spent 500 on groceries` files itself under "on", and after the
 * third such entry the pie chart is mostly a slice called "on". Stripping them
 * is what lets the sentence read naturally and still categorise.
 *
 * Repeated rather than matched once, because they stack: `for the car` has two
 * of them in front of the word that is actually the category.
 */
const LEADING_FILLER = /^(?:(?:on|for|at|to|in|the|a|an|my|some)\s+)+/i

export interface Money {
  amountMinor: number
  currency: string | null
  /** The text following the amount, trimmed. */
  rest: string
}

/**
 * Leading money in a string, or null.
 *
 * Returns the remainder as well as the value because every caller needs both
 * -- the amount and whatever was said about it -- and finding the end of the
 * number twice is how the two drift apart.
 */
export function parseMoney(text: string): Money | null {
  const trimmed = text.trim()
  const match = MONEY.exec(trimmed)
  if (match === null) return null

  const [whole = '', fraction] = [match[2], match[3]]

  const amountMinor = toMinorUnits(whole, fraction)
  if (amountMinor === null) return null

  const symbol = match[1] ?? match[4]
  const currency =
    symbol === undefined
      ? null
      : (CURRENCY_SYMBOLS[symbol] ?? (symbol.length === 3 ? symbol.toUpperCase() : null))

  return { amountMinor, currency, rest: trimmed.slice(match[0].length).trim() }
}

/**
 * Digits to minor units, by string surgery rather than arithmetic.
 *
 * More than two decimal places is refused rather than rounded. At this scale it
 * is a typo -- a stray keystroke in `12.400` -- far more often than it is a
 * genuine fraction of a cent, and a parser that quietly rounds a typo into a
 * plausible number is worse than one that says it cannot read the line.
 */
function toMinorUnits(whole: string, fraction: string | undefined): number | null {
  const digits = whole.replace(/,/g, '')
  if (!/^\d+$/.test(digits)) return null

  if (fraction !== undefined) {
    if (!/^\d+$/.test(fraction) || fraction.length > 2) return null
  }

  const value = Number(`${digits}${(fraction ?? '').padEnd(2, '0')}`)

  return Number.isSafeInteger(value) ? value : null
}

/**
 * One line to a spend, or null when it is not one.
 *
 * Negative amounts are not accepted, and the reason is downstream: a refund
 * written as `Spent -20` becomes a negative slice, and DECISIONS.md §14 has a
 * pie refuse those rather than draw a confident picture of a false fact. A
 * refund wants its own keyword and its own thinking; until it has one, the
 * minus sign simply fails to parse and the line stays prose.
 */
export function parseSpendLine(raw: string, line: number): SpendEntry | null {
  const match = SPEND.exec(raw)
  if (match === null) return null

  const body = (match[1] ?? '').trim()
  if (body === '') return null

  const money = parseMoney(body)
  if (money === null) return null

  return {
    amountMinor: money.amountMinor,
    currency: money.currency,
    category: categoryOf(money.rest),
    text: money.rest,
    line,
    date: parseIsoDateIn(money.rest),
  }
}

/**
 * What to file a spend under.
 *
 * An explicit `#tag` wins, because it is the only way to say a category that is
 * more than one word -- `#eating-out` cannot be inferred from "dinner with
 * sam". Otherwise it is the first word, which is what makes the common case
 * need no ceremony at all: `Spent 42 groceries` is already categorised.
 */
export function categoryOf(text: string): string {
  const tag = CATEGORY_TAG.exec(text)
  if (tag !== null) return (tag[1] ?? '').toLowerCase()

  const withoutFiller = text.replace(LEADING_FILLER, '')
  const word = /^[\p{L}\p{N}][\p{L}\p{N}_'-]*/u.exec(withoutFiller)
  if (word === null) return UNCATEGORISED

  return word[0].toLowerCase()
}

/** A `Balance:` or `Income:` line, or null. */
export function parseBudgetDeclaration(raw: string, line: number): BudgetDeclaration | null {
  const match = DECLARATION.exec(raw)
  if (match === null) return null

  const kind = (match[1] ?? '').toLowerCase() === 'income' ? 'income' : 'balance'
  const body = (match[2] ?? '').trim()

  const money = parseMoney(body)
  if (money === null) return null

  if (kind === 'income') {
    return {
      kind,
      amountMinor: money.amountMinor,
      currency: money.currency,
      asOf: null,
      // A bare `Income: 3000` means monthly, because monthly is the only period
      // there is. Writing `/month` is allowed so the note reads like a sentence.
      period: 'month',
      line,
    }
  }

  const asOf = AS_OF.exec(money.rest)?.[1] ?? parseIsoDateIn(money.rest)

  return {
    kind,
    amountMinor: money.amountMinor,
    currency: money.currency,
    asOf: asOf === undefined ? null : asOf,
    period: null,
    line,
  }
}

/**
 * Validated rather than merely shaped: `2026-02-31` matches the pattern and is
 * not a day. This duplicates `parseIsoDate` in `note-markup.ts` deliberately --
 * importing across two domain modules to save six lines would couple the spend
 * grammar to the todo grammar, and they are free to diverge.
 */
function parseIsoDateIn(text: string): string | null {
  const match = ISO_DATE.exec(text)
  if (match === null) return null

  const [, year = '', month = '', day = ''] = match
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`)

  if (Number.isNaN(date.getTime())) return null
  if (date.getUTCFullYear() !== Number(year)) return null
  if (date.getUTCMonth() + 1 !== Number(month)) return null
  if (date.getUTCDate() !== Number(day)) return null

  return `${year}-${month}-${day}`
}
