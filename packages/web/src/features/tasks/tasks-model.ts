/**
 * Deciding what order a pile of TODOs should be read in.
 *
 * There are two dates on an annotation and they mean different things, which is
 * the whole design problem here:
 *
 *  - `due` is an ISO date somebody typed into the text. It is a promise.
 *  - `day` is the journal file the line lives in. It is when it was written.
 *
 * So a due date drives urgency and a journal day drives context, and the panel
 * puts urgency first: anything with a promised date that has passed is Overdue,
 * anything for today is Today, promised dates ahead are Upcoming. Everything
 * else falls back to the day it was written, most recent first, because a
 * dateless line from three weeks ago is a backlog item and not a late one --
 * calling it "overdue" would be the panel inventing a commitment nobody made,
 * and after the third false alarm nobody reads the red heading any more.
 *
 * Pure, and takes `today` as an argument, so the boundaries are testable
 * without waiting until midnight.
 */
import type { AnnotationKind, AnnotationRecord } from '@vim-notes/core'

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'earlier' | 'undated' | 'done'

export interface TaskGroup {
  id: string
  label: string
  bucket: TaskBucket
  items: AnnotationRecord[]
}

export interface TaskFilters {
  kind: AnnotationKind | 'all'
  /** Ticked items are hidden by default; they are a record, not a list. */
  includeDone: boolean
}

/** Local date, not UTC: "today" is the user's today, wherever they are. */
export function todayIso(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function groupAnnotations(
  records: readonly AnnotationRecord[],
  today: string,
  filters: TaskFilters,
): TaskGroup[] {
  const buckets = new Map<string, TaskGroup>()

  const push = (id: string, label: string, bucket: TaskBucket, record: AnnotationRecord) => {
    const group = buckets.get(id) ?? { id, label, bucket, items: [] }
    group.items.push(record)
    buckets.set(id, group)
  }

  for (const record of records) {
    if (filters.kind !== 'all' && record.kind !== filters.kind) continue

    if (record.done === true) {
      if (filters.includeDone) push('done', 'Done', 'done', record)
      continue
    }

    const bucket = bucketOf(record, today)

    switch (bucket) {
      case 'overdue':
        push('overdue', 'Overdue', 'overdue', record)
        break
      case 'today':
        push('today', 'Today', 'today', record)
        break
      case 'undated':
        push('undated', 'No date', 'undated', record)
        break
      default: {
        // One group per calendar day, so a heading is always a real date the
        // user can recognise rather than a vague "later".
        const date = effectiveDate(record) ?? today
        push(`${bucket}:${date}`, formatDay(date, today), bucket, record)
      }
    }
  }

  for (const group of buckets.values()) group.items.sort(compareItems)

  return [...buckets.values()].sort(compareGroups)
}

export function bucketOf(record: AnnotationRecord, today: string): TaskBucket {
  if (record.done === true) return 'done'

  if (record.due !== null) {
    if (record.due < today) return 'overdue'
    if (record.due === today) return 'today'
    return 'upcoming'
  }

  if (record.day === null) return 'undated'
  if (record.day === today) return 'today'
  return record.day > today ? 'upcoming' : 'earlier'
}

/** The date the item is filed under: the promise if there is one, else the day. */
export function effectiveDate(record: AnnotationRecord): string | null {
  return record.due ?? record.day
}

export interface DueChip {
  text: string
  bucket: TaskBucket
  /** Spelt out for screen readers, where a bare date says nothing. */
  description: string
}

/**
 * Only items with an explicit due date get a chip. Repeating the journal date
 * on every row would say nothing the heading has not already said.
 */
export function dueChip(record: AnnotationRecord, today: string): DueChip | null {
  if (record.due === null) return null

  const text = formatDay(record.due, today)

  if (record.due < today) return { text, bucket: 'overdue', description: `Overdue since ${text}` }
  if (record.due === today) return { text, bucket: 'today', description: 'Due today' }

  return { text, bucket: 'upcoming', description: `Due ${text}` }
}

const SAME_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

const OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * `Today`, `Tomorrow`, `Yesterday`, then a real date.
 *
 * The three words are worth the special case: they are the only labels most
 * people read without converting, and they are the three that matter most.
 */
export function formatDay(iso: string, today: string): string {
  if (iso === today) return 'Today'
  if (iso === addDays(today, 1)) return 'Tomorrow'
  if (iso === addDays(today, -1)) return 'Yesterday'

  // Noon, not midnight: a date rendered from a UTC midnight lands on the
  // previous day for everyone west of Greenwich.
  const date = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(date.getTime())) return iso

  return iso.slice(0, 4) === today.slice(0, 4) ? SAME_YEAR.format(date) : OTHER_YEAR.format(date)
}

/** Arithmetic in UTC so a daylight-saving boundary cannot swallow a day. */
export function addDays(iso: string, days: number): string {
  const time = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(time)) return iso

  return new Date(time + days * 86_400_000).toISOString().slice(0, 10)
}

export function isSameAnnotation(a: AnnotationRecord, b: AnnotationRecord): boolean {
  return a.path === b.path && a.line === b.line
}

/** Identity for React keys and for matching a row to a cached record. */
export function annotationKey(record: AnnotationRecord): string {
  return `${record.path}:${record.line}`
}

const GROUP_ORDER: Record<TaskBucket, number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  earlier: 3,
  undated: 4,
  done: 5,
}

function compareGroups(a: TaskGroup, b: TaskGroup): number {
  const order = GROUP_ORDER[a.bucket] - GROUP_ORDER[b.bucket]
  if (order !== 0) return order

  // Upcoming reads forwards from today; the backlog reads backwards from it.
  // Both put the day nearest to now closest to the top of the panel.
  return a.bucket === 'upcoming' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

function compareItems(a: AnnotationRecord, b: AnnotationRecord): number {
  const dateA = effectiveDate(a) ?? ''
  const dateB = effectiveDate(b) ?? ''
  if (dateA !== dateB) return dateA.localeCompare(dateB)

  // Otherwise file order, which is the order they were written in.
  if (a.path !== b.path) return a.path.localeCompare(b.path)
  return a.line - b.line
}
