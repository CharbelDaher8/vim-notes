/**
 * The balance, computed rather than stored.
 *
 *     balance = opening + accrued income − spending
 *
 * This is the whole feature. There is no number kept anywhere that this
 * disagrees with, because there is no number kept anywhere: `Balance:` and
 * `Income:` are lines in a note, every `Spent` is a line in a note, and this
 * folds them together on every render. Editing a spend from three weeks ago in
 * nvim moves the balance, and deleting the index costs nothing (DECISIONS.md
 * §1, §12).
 *
 * Pure, and it takes `today` as an argument, so accrual boundaries are testable
 * without waiting for the first of the month -- the same reason `tasks-model.ts`
 * takes one.
 *
 * **What it refuses to do.** It will not convert currencies. A rate is a fact
 * about the world on a particular day that this application does not have and
 * cannot invent, so spends declared in a currency the account is not in are
 * left out of the total and reported as a caveat instead. Adding 50 EUR to 50
 * USD to make 100 of something would be the same mistake §14 avoids when a pie
 * refuses a negative slice: a confident picture of a false fact.
 */
import type { BudgetDeclarationRecord, SpendRecord } from '@vim-notes/core'
import { MINOR_UNITS_PER_MAJOR } from '@vim-notes/core'

/** The last resort when nothing in the notes says what currency this is. */
const FALLBACK_CURRENCY = 'USD'

export type BudgetCaveat =
  /** No `Balance:` line anywhere, so there is nothing to count down from. */
  | { kind: 'no-opening-balance' }
  /** A `Balance:` with no date: income cannot accrue from an unknown moment. */
  | { kind: 'undated-opening-balance' }
  | { kind: 'no-income' }
  | { kind: 'foreign-currency'; count: number; currencies: string[] }

export interface BudgetSummary {
  currency: string
  openingMinor: number
  /** Null when the opening balance is undated or missing. */
  openingAsOf: string | null
  incomePerMonthMinor: number
  /** Whole months from `openingAsOf` to `today`. */
  monthsAccrued: number
  accruedIncomeMinor: number
  spentMinor: number
  /**
   * What is left. Always a number, even when the caveats say it is a partial
   * answer -- a pane that shows nothing while a `Balance:` line is missing is
   * useless to somebody who only wants to know what they spent this month.
   */
  balanceMinor: number
  /** Counted separately because they cannot be converted; see the header. */
  foreign: SpendRecord[]
  caveats: BudgetCaveat[]
}

export interface CategoryTotal {
  category: string
  totalMinor: number
  count: number
  /** Share of the total, 0–1. Zero when the total is zero. */
  share: number
}

export interface MonthTotal {
  /** `YYYY-MM`. */
  month: string
  totalMinor: number
  count: number
}

/**
 * Which currency the account is in.
 *
 * The declarations get the first say because they are the deliberate statement
 * -- somebody wrote `Balance: 5000 USD` on purpose -- and a spend's currency is
 * usually absent.
 *
 * Failing that, a currency has to win an **outright majority of every spend**,
 * not merely of the ones that named a currency. Counting only the named ones
 * looks equivalent and is not: a spend that names nothing is a positive
 * statement that it is in the account's own currency, so a single `Spent 90 EUR
 * wine` among ten unmarked entries would otherwise redenominate the entire
 * budget -- which is exactly what it did the first time this ran, quietly
 * turning a dollar balance into euros and hiding the very caveat that exists to
 * report unconvertible money.
 */
export function accountCurrency(
  declarations: readonly BudgetDeclarationRecord[],
  spends: readonly SpendRecord[],
): string {
  for (const declaration of declarations) {
    if (declaration.currency !== null) return declaration.currency
  }

  const counts = new Map<string, number>()
  for (const spend of spends) {
    if (spend.currency === null) continue
    counts.set(spend.currency, (counts.get(spend.currency) ?? 0) + 1)
  }

  let best: string | null = null
  let bestCount = 0
  for (const [currency, count] of counts) {
    // `>` not `>=`, so a tie keeps the first seen and the answer is stable.
    if (count > bestCount) {
      best = currency
      bestCount = count
    }
  }

  return best !== null && bestCount * 2 > spends.length ? best : FALLBACK_CURRENCY
}

/**
 * The `Balance:` line that is currently true.
 *
 * The latest `asOf` not in the future wins, which is what makes updating your
 * balance an *append* rather than an edit:
 *
 *     Balance: 5000 as of 2026-01-01
 *     Balance: 7200 as of 2026-08-01
 *
 * The old line stays as a record of what was true then, and the note reads as
 * a history instead of being overwritten -- which is the same instinct as the
 * rest of this app, where the file is the state and git holds the past.
 *
 * A future-dated balance is ignored rather than used: it is a plan, and folding
 * it in would report money that has not arrived.
 */
export function currentOpening(
  declarations: readonly BudgetDeclarationRecord[],
  today: string,
): BudgetDeclarationRecord | null {
  const balances = declarations.filter((entry) => entry.kind === 'balance')
  if (balances.length === 0) return null

  let best: BudgetDeclarationRecord | null = null

  for (const entry of balances) {
    if (entry.asOf === null || entry.asOf > today) continue
    // `>=` so that two lines with the same date resolve to the later one in the
    // document, which is the one someone just typed.
    if (best === null || best.asOf === null || entry.asOf >= best.asOf) best = entry
  }
  if (best !== null) return best

  // An undated line is better than no figure at all; it just cannot anchor
  // accrual, and `summariseBudget` says so in a caveat.
  const undated = balances.filter((entry) => entry.asOf === null).at(-1)
  if (undated !== undefined) return undated

  // Everything left is future-dated -- a projection rather than a statement.
  // Returned anyway, because a pane showing nothing is worse than one showing a
  // figure whose date is visible right next to it.
  return balances.at(-1) ?? null
}

/** The last `Income:` line wins, for the same reason the latest balance does. */
export function currentIncome(
  declarations: readonly BudgetDeclarationRecord[],
): BudgetDeclarationRecord | null {
  return declarations.filter((entry) => entry.kind === 'income').at(-1) ?? null
}

export function summariseBudget(
  declarations: readonly BudgetDeclarationRecord[],
  spends: readonly SpendRecord[],
  today: string,
): BudgetSummary {
  const currency = accountCurrency(declarations, spends)
  const opening = currentOpening(declarations, today)
  const income = currentIncome(declarations)

  const caveats: BudgetCaveat[] = []
  if (opening === null) caveats.push({ kind: 'no-opening-balance' })
  else if (opening.asOf === null) caveats.push({ kind: 'undated-opening-balance' })
  if (income === null) caveats.push({ kind: 'no-income' })

  const openingAsOf = opening?.asOf ?? null
  const openingMinor = opening?.amountMinor ?? 0
  const incomePerMonthMinor = income?.amountMinor ?? 0

  // No anchor means no accrual. Guessing a start date would invent income.
  const monthsAccrued = openingAsOf === null ? 0 : wholeMonthsBetween(openingAsOf, today)
  const accruedIncomeMinor = incomePerMonthMinor * monthsAccrued

  const { counted, foreign } = partitionByCurrency(spends, currency)

  /**
   * Only spends the opening balance does not already account for.
   *
   * A balance stated as of the first of the month has last month's spending
   * baked into it already; subtracting those entries again would double-count
   * every one of them, and the balance would drift further from the truth the
   * longer the notes went back.
   *
   * An undated spend is counted, which is a judgement rather than a rule
   * falling out of the arithmetic: it cannot be placed against the anchor, so
   * it is either always counted or never. Counting it treats money as spent
   * unless proven otherwise, and being told you have slightly less than you do
   * is the safer of the two ways to be wrong.
   */
  const deductible = counted.filter(
    (spend) => openingAsOf === null || spend.on === null || spend.on >= openingAsOf,
  )

  const spentMinor = deductible.reduce((sum, spend) => sum + spend.amountMinor, 0)

  if (foreign.length > 0) {
    caveats.push({
      kind: 'foreign-currency',
      count: foreign.length,
      currencies: [...new Set(foreign.map((spend) => spend.currency ?? ''))].sort(),
    })
  }

  return {
    currency,
    openingMinor,
    openingAsOf,
    incomePerMonthMinor,
    monthsAccrued,
    accruedIncomeMinor,
    spentMinor,
    balanceMinor: openingMinor + accruedIncomeMinor - spentMinor,
    foreign,
    caveats,
  }
}

/**
 * Spends this fold can add up, and the ones it cannot.
 *
 * A null currency means "the account's", which is the common case and the
 * reason the parser reports absence rather than defaulting.
 */
export function partitionByCurrency(
  spends: readonly SpendRecord[],
  currency: string,
): { counted: SpendRecord[]; foreign: SpendRecord[] } {
  const counted: SpendRecord[] = []
  const foreign: SpendRecord[] = []

  for (const spend of spends) {
    if (spend.currency === null || spend.currency === currency) counted.push(spend)
    else foreign.push(spend)
  }

  return { counted, foreign }
}

/**
 * Largest first, which is the order that answers "where is it going".
 *
 * Only same-currency spends are totalled, for the reason in the header. Callers
 * that want the excluded ones should read `BudgetSummary.foreign`.
 */
export function totalsByCategory(
  spends: readonly SpendRecord[],
  currency: string,
): CategoryTotal[] {
  const { counted } = partitionByCurrency(spends, currency)
  const totals = new Map<string, { totalMinor: number; count: number }>()

  for (const spend of counted) {
    const existing = totals.get(spend.category) ?? { totalMinor: 0, count: 0 }
    existing.totalMinor += spend.amountMinor
    existing.count += 1
    totals.set(spend.category, existing)
  }

  const grand = counted.reduce((sum, spend) => sum + spend.amountMinor, 0)

  return [...totals.entries()]
    .map(([category, { totalMinor, count }]) => ({
      category,
      totalMinor,
      count,
      share: grand === 0 ? 0 : totalMinor / grand,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.category.localeCompare(b.category))
}

/** Oldest month first, so it reads left to right as a trend. */
export function totalsByMonth(spends: readonly SpendRecord[], currency: string): MonthTotal[] {
  const { counted } = partitionByCurrency(spends, currency)
  const totals = new Map<string, { totalMinor: number; count: number }>()

  for (const spend of counted) {
    // Undated spends belong to no month and are left out rather than dropped
    // into the current one, which would make a chart of the last six months
    // move whenever an undated note was edited.
    if (spend.on === null) continue

    const month = spend.on.slice(0, 7)
    const existing = totals.get(month) ?? { totalMinor: 0, count: 0 }
    existing.totalMinor += spend.amountMinor
    existing.count += 1
    totals.set(month, existing)
  }

  return [...totals.entries()]
    .map(([month, { totalMinor, count }]) => ({ month, totalMinor, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * Whole months from one ISO day to another, never negative.
 *
 * Whole rather than pro-rata because that is what a salary does: it arrives on
 * a day, in full. Paying out 3/31ths of a month's income because it is the
 * third would make the balance drift upward every morning and be wrong all
 * month except at the end of it.
 */
export function wholeMonthsBetween(from: string, to: string): number {
  const start = {
    year: Number(from.slice(0, 4)),
    month: Number(from.slice(5, 7)),
    day: Number(from.slice(8, 10)),
  }
  const end = {
    year: Number(to.slice(0, 4)),
    month: Number(to.slice(5, 7)),
    day: Number(to.slice(8, 10)),
  }

  if (!Number.isFinite(start.year) || !Number.isFinite(end.year)) return 0

  let months = (end.year - start.year) * 12 + (end.month - start.month)
  // The day of the month has not come round yet, so the latest one has not
  // been paid: 15 Jan to 6 Aug is six arrivals, not seven.
  if (end.day < start.day) months -= 1

  return Math.max(0, months)
}

/** The first and last day of the calendar month an ISO day falls in. */
export function monthBounds(iso: string): { since: string; until: string } {
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  // Day zero of the next month is the last day of this one, which sidesteps
  // knowing which months have 31 days and whether February has 29.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return {
    since: `${iso.slice(0, 7)}-01`,
    until: `${iso.slice(0, 7)}-${`${lastDay}`.padStart(2, '0')}`,
  }
}

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** `2026-08` to "August 2026". */
export function formatMonth(month: string): string {
  // Noon on the first, for the reason `formatDay` gives: a UTC midnight lands
  // on the previous day for everyone west of Greenwich.
  const date = new Date(`${month}-01T12:00:00`)
  return Number.isNaN(date.getTime()) ? month : MONTH_LABEL.format(date)
}

/**
 * Minor units to something a person reads.
 *
 * `Intl.NumberFormat` is given the major-unit number, which is the one place
 * the fixed exponent from `MINOR_UNITS_PER_MAJOR` is undone -- and it is undone
 * exactly where it was applied, so a currency with no minor unit is displayed
 * consistently with how it was parsed even though neither is strictly correct.
 */
export function formatMoney(
  minor: number,
  currency: string,
  options: { sign?: boolean } = {},
): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    signDisplay: options.sign === true ? 'exceptZero' : 'auto',
  })

  try {
    return formatter.format(minor / MINOR_UNITS_PER_MAJOR)
  } catch {
    // An unknown code -- somebody typed `Spent 5 XYZ` -- throws rather than
    // degrading, and a budget pane that crashes on a typo is worse than one
    // that shows the code verbatim.
    return `${(minor / MINOR_UNITS_PER_MAJOR).toFixed(2)} ${currency}`
  }
}

/** Rounded to whole major units, for axis ticks and chart labels. */
export function formatMoneyCompact(minor: number, currency: string): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  })

  try {
    return formatter.format(minor / MINOR_UNITS_PER_MAJOR)
  } catch {
    return `${Math.round(minor / MINOR_UNITS_PER_MAJOR)} ${currency}`
  }
}
