/**
 * Answering a data block's query: spends in, table cells out.
 *
 * The result is deliberately the *same shape* a literal block's rows have --
 * a header and strings, not a bespoke structure. Everything downstream
 * (`buildSpec`, the geometry, the disclosure table, `format: currency`) is then
 * the code that already existed, so a derived pie and a hand-written one are
 * built by one path and cannot drift apart.
 *
 * Values are emitted as plain major-unit decimals with no symbol or separator,
 * because that is what `buildSpec` reads back as a number. How they are
 * *displayed* is `format:`'s business, exactly as for a literal block.
 */
import { MINOR_UNITS_PER_MAJOR, type SpendRecord } from '@vim-notes/core'

import { formatMonth, totalsByCategory, totalsByMonth } from '../budget/budget-model'
import type { ChartQuery, ResolvedRows } from './chart-block'

export function resolveChartQuery(
  query: ChartQuery,
  spends: readonly SpendRecord[],
  currency: string,
): ResolvedRows {
  const scoped = spends.filter((spend) => matches(query, spend))

  if (query.group === 'month') {
    return {
      columns: ['month', 'spent'],
      rows: totalsByMonth(scoped, currency).map((entry) => [
        formatMonth(entry.month),
        toMajorUnits(entry.totalMinor),
      ]),
    }
  }

  return {
    columns: ['category', 'spent'],
    rows: totalsByCategory(scoped, currency).map((entry) => [
      entry.category,
      toMajorUnits(entry.totalMinor),
    ]),
  }
}

function matches(query: ChartQuery, spend: SpendRecord): boolean {
  if (query.category !== null && spend.category !== query.category) return false

  // Bounded queries exclude undated spends, matching `SpendFilter` on the port:
  // asking about August cannot sensibly return money that belongs to no month.
  if (query.since === null && query.until === null) return true
  if (spend.on === null) return false

  if (query.since !== null && spend.on < query.since) return false
  if (query.until !== null && spend.on > query.until) return false

  return true
}

/**
 * Minor units to the decimal string `buildSpec` will parse back.
 *
 * Fixed to two places rather than trimmed, so a column of amounts is a column
 * of amounts rather than `1200` next to `42.5`.
 */
function toMajorUnits(minor: number): string {
  return (minor / MINOR_UNITS_PER_MAJOR).toFixed(2)
}
