/**
 * What you have, and where it went.
 *
 * Every number on this panel is folded from the markdown on render -- there is
 * no stored balance for it to disagree with. The rows are therefore also links:
 * a category is a set of lines in notes, and clicking one of them opens the
 * line that says so, which is the only place the fact actually lives.
 *
 * The caveats are shown rather than hidden. A balance computed without an
 * opening figure, or with three spends in a currency nothing can convert, is
 * still worth showing -- but it has to say what it left out, or it is a
 * confident number that is quietly wrong.
 */
import { useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../shared/workspace-store'
import { todayIso } from '../tasks/tasks-model'
import {
  formatMoney,
  formatMonth,
  monthBounds,
  summariseBudget,
  totalsByCategory,
  totalsByMonth,
  type BudgetCaveat,
} from './budget-model'
import { useBudgetDeclarations, useSpends } from './use-budget'

import './budget.css'

type Range = 'month' | 'all'

const RANGES: { value: Range; label: string }[] = [
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
]

export function BudgetPane() {
  const spends = useSpends()
  const declarations = useBudgetDeclarations()

  const [range, setRange] = useState<Range>('month')

  // Read per render rather than frozen at mount, for the reason the tasks pane
  // gives: a phone left open past midnight should not spend the morning
  // insisting yesterday is today.
  const today = todayIso()

  const all = useMemo(() => spends.data ?? [], [spends.data])

  /**
   * The balance always folds the whole history, whatever the range chips say.
   *
   * The chips scope *spending*, which is a question about a period. "What do I
   * have" is not -- an August-only balance would silently ignore every earlier
   * spend and report money that is gone.
   */
  const summary = useMemo(
    () => summariseBudget(declarations.data ?? [], all, today),
    [declarations.data, all, today],
  )

  const scoped = useMemo(() => {
    if (range === 'all') return all
    const { since, until } = monthBounds(today)
    return all.filter((spend) => spend.on !== null && spend.on >= since && spend.on <= until)
  }, [all, range, today])

  const categories = useMemo(
    () => totalsByCategory(scoped, summary.currency),
    [scoped, summary.currency],
  )

  const months = useMemo(
    () => totalsByMonth(all, summary.currency).slice(-6),
    [all, summary.currency],
  )

  const scopedTotal = categories.reduce((sum, entry) => sum + entry.totalMinor, 0)
  // Sorted descending, so the head is the largest. Guarded against zero
  // because a category can legitimately total nothing.
  const largest = Math.max(1, categories[0]?.totalMinor ?? 1)
  const error = spends.error ?? declarations.error

  if (error !== null) {
    return (
      <div className="budget">
        <p className="budget__message" role="alert">
          {error.message}
        </p>
      </div>
    )
  }

  return (
    <div className="budget">
      <section className="budget__balance" aria-label="Balance">
        <p className="budget__balance-label">Balance</p>
        <p className="budget__balance-value" data-negative={summary.balanceMinor < 0 || undefined}>
          {spends.isPending ? '—' : formatMoney(summary.balanceMinor, summary.currency)}
        </p>

        <dl className="budget__breakdown">
          <div>
            <dt>Opening</dt>
            <dd>{formatMoney(summary.openingMinor, summary.currency)}</dd>
          </div>
          {summary.monthsAccrued > 0 ? (
            <div>
              <dt>
                Income <span className="budget__months">× {summary.monthsAccrued}</span>
              </dt>
              <dd>{formatMoney(summary.accruedIncomeMinor, summary.currency, { sign: true })}</dd>
            </div>
          ) : null}
          <div>
            <dt>Spent</dt>
            <dd>{formatMoney(-summary.spentMinor, summary.currency, { sign: true })}</dd>
          </div>
        </dl>
      </section>

      {summary.caveats.map((caveat) => (
        <p key={caveat.kind} className="budget__caveat">
          {describeCaveat(caveat)}
        </p>
      ))}

      <div className="budget__toolbar" role="group" aria-label="Range">
        {RANGES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="budget__chip"
            aria-pressed={range === option.value}
            onClick={() => setRange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="budget__list">
        {categories.length === 0 ? (
          <p className="budget__message">
            {spends.isPending
              ? 'Loading…'
              : range === 'month'
                ? 'Nothing spent this month.'
                : 'No spending logged yet. Write “Spent 12 coffee” in any note.'}
          </p>
        ) : (
          <>
            <p className="budget__total">
              {formatMoney(scopedTotal, summary.currency)}
              <span className="budget__total-label">
                {range === 'month' ? formatMonth(today.slice(0, 7)) : 'all time'}
              </span>
            </p>

            <ul className="budget__categories">
              {categories.map((entry) => (
                <li key={entry.category} className="budget__category">
                  <span className="budget__category-name">{entry.category}</span>
                  <span
                    className="budget__bar"
                    // Relative to the largest, not to the total: at eight
                    // categories every bar would otherwise be a stub, and the
                    // share is already stated as a percentage beside it.
                    style={
                      {
                        '--fill': `${(entry.totalMinor / largest) * 100}%`,
                      } as React.CSSProperties
                    }
                    aria-hidden="true"
                  />
                  <span className="budget__category-amount">
                    {formatMoney(entry.totalMinor, summary.currency)}
                    <span className="budget__share">{Math.round(entry.share * 100)}%</span>
                  </span>
                </li>
              ))}
            </ul>

            {months.length > 1 ? (
              <section className="budget__months-list" aria-label="Recent months">
                {months.map((month) => (
                  <div key={month.month} className="budget__month">
                    <span>{formatMonth(month.month)}</span>
                    <span>{formatMoney(month.totalMinor, summary.currency)}</span>
                  </div>
                ))}
              </section>
            ) : null}

            <section className="budget__recent" aria-label="Recent entries">
              <h3 className="budget__heading">Recent</h3>
              <ul>
                {scoped.slice(0, 12).map((spend) => (
                  <li key={`${spend.path}:${spend.line}`}>
                    <button
                      type="button"
                      className="budget__entry"
                      onClick={() =>
                        void useWorkspaceStore.getState().openNote(spend.path, { line: spend.line })
                      }
                      title={`${spend.path}:${spend.line}`}
                    >
                      <span className="budget__entry-text">{spend.text || spend.category}</span>
                      <span className="budget__entry-amount">
                        {formatMoney(spend.amountMinor, spend.currency ?? summary.currency)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function describeCaveat(caveat: BudgetCaveat): string {
  switch (caveat.kind) {
    case 'no-opening-balance':
      return 'No opening balance. Write “Balance: 5000 as of 2026-08-01” in any note.'
    case 'undated-opening-balance':
      return 'The opening balance has no date, so income is not being counted. Add “as of <date>”.'
    case 'no-income':
      return 'No monthly income. Write “Income: 3000/month” in any note.'
    case 'foreign-currency':
      return `${caveat.count} ${caveat.count === 1 ? 'entry is' : 'entries are'} in ${caveat.currencies.join(', ')} and cannot be converted, so ${caveat.count === 1 ? 'it is' : 'they are'} left out.`
  }
}
