import { notePathBasename, type NotePath, type SearchHit, type TreeEntry } from '@vim-notes/core'

export interface SearchGroup {
  path: NotePath
  hits: SearchHit[]
}

/**
 * Hits arrive flat and in path order; the UI wants them per file so a note with
 * eleven matches reads as one result rather than eleven.
 */
export function groupHits(hits: SearchHit[]): SearchGroup[] {
  const groups: SearchGroup[] = []

  for (const hit of hits) {
    const last = groups.at(-1)
    if (last !== undefined && last.path === hit.path) last.hits.push(hit)
    else groups.push({ path: hit.path, hits: [hit] })
  }

  return groups
}

export interface PreviewSegment {
  text: string
  match: boolean
}

/**
 * Splits a preview line so the matching part can be marked.
 *
 * An invalid regex is an expected state, not an error -- someone typing `(fo`
 * is halfway through `(foo|bar)` -- so a pattern that will not compile just
 * yields an unhighlighted line.
 */
export function highlightPreview(
  text: string,
  pattern: string,
  options: { regex?: boolean; caseSensitive?: boolean } = {},
): PreviewSegment[] {
  if (pattern === '') return [{ text, match: false }]

  const flags = options.caseSensitive === true ? 'g' : 'gi'
  let expression: RegExp

  try {
    expression = new RegExp(options.regex === true ? pattern : escapeRegExp(pattern), flags)
  } catch {
    return [{ text, match: false }]
  }

  const segments: PreviewSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(expression)) {
    if (match.index === undefined) continue
    // A pattern that can match nothing (`a*`) would otherwise emit a segment
    // per character and never advance.
    if (match[0] === '') break

    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), match: false })
    segments.push({ text: match[0], match: true })
    cursor = match.index + match[0].length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })

  return segments.length === 0 ? [{ text, match: false }] : segments
}

/**
 * Filename matches, computed from the tree the client already has.
 *
 * The `Search` port is ripgrep over file *contents*, which is the right tool
 * and the wrong answer when you know the note is called "watering" and cannot
 * remember a word inside it. On a phone this is usually the search you wanted.
 */
export function matchFilenames(entries: TreeEntry[], query: string, limit = 8): NotePath[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const matches: { path: NotePath; score: number }[] = []

  const walk = (list: TreeEntry[]) => {
    for (const entry of list) {
      if (entry.kind === 'directory') {
        walk(entry.children)
        continue
      }

      const name = notePathBasename(entry.path).toLowerCase()
      const at = name.indexOf(needle)

      if (at >= 0) matches.push({ path: entry.path, score: at })
      else if (entry.path.toLowerCase().includes(needle)) {
        // A path-only match is weaker than a name match, so it sorts last.
        matches.push({ path: entry.path, score: 1_000 })
      }
    }
  }

  walk(entries)

  return matches
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((match) => match.path)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
