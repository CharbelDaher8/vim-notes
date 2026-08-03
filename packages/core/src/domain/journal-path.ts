/**
 * Where today's note goes, decided from where the other days already are.
 *
 * The inverse of `journalDateOf`, and it inherits that function's premise: a
 * note is a day because it is *named* like one, not because it sits under
 * `journal/`. Reading works fine that way -- a name is enough to recognise.
 * Writing needs an answer to a question reading never asks, which is which
 * folder a new one belongs in.
 *
 * Hardcoding `journal/` would be the easy answer and would quietly be wrong for
 * anyone who files days under `daily/`, or flat, or by year: the first item they
 * saved would create a second, parallel place for days to live, and the graph
 * would show two runs of dailies that never join up.
 *
 * So the folder is inferred from the days that exist. The most-used parent
 * wins, ties break toward the shallower path, and a vault with no day notes at
 * all falls back to `journal/` -- which is a real decision rather than a guess,
 * because at that point there is nothing to be consistent with.
 *
 * Pure, and takes the paths rather than a store, so every case here is a test
 * rather than a fixture directory.
 */
import { journalDateOf } from './note-markup'
import type { NotePath } from './note-path'

/** Used only when nothing in the vault suggests otherwise. */
export const DEFAULT_JOURNAL_DIRECTORY = 'journal'

/**
 * The path today's note should have, whether or not it exists yet.
 *
 * `date` is an ISO `YYYY-MM-DD`; the caller decides what "today" means, because
 * a timezone is not something this file can be right about.
 */
export function journalPathFor(date: string, existing: readonly NotePath[]): string {
  const counts = new Map<string, number>()

  for (const path of existing) {
    if (journalDateOf(path) === null) continue

    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? '' : path.slice(0, slash)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }

  if (counts.size === 0) return `${DEFAULT_JOURNAL_DIRECTORY}/${date}.md`

  let best = ''
  let bestCount = -1

  for (const [parent, count] of counts) {
    if (count > bestCount || (count === bestCount && shallower(parent, best))) {
      best = parent
      bestCount = count
    }
  }

  return best === '' ? `${date}.md` : `${best}/${date}.md`
}

/**
 * Tie-break: fewer segments first, then alphabetically.
 *
 * Alphabetical order is not meaningful here -- it is only there so the answer
 * does not depend on the order the tree happened to be walked in, which is what
 * would make this untestable and make the destination wander between saves.
 */
function shallower(candidate: string, incumbent: string): boolean {
  const a = candidate === '' ? 0 : candidate.split('/').length
  const b = incumbent === '' ? 0 : incumbent.split('/').length

  if (a !== b) return a < b
  return candidate < incumbent
}
