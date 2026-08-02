/**
 * A line diff, hand-rolled because "view both" needs one and a diff library is
 * not worth a dependency for ~80 lines.
 *
 * Plain LCS, with the common prefix and suffix stripped first. That last part
 * is what makes it practical: the diffs this app shows are almost always "nvim
 * changed three lines in the middle of a note I also edited", which after
 * trimming is a handful of lines through the quadratic part.
 */

export type DiffRow =
  | { kind: 'same'; text: string; mineLine: number; theirsLine: number }
  | { kind: 'removed'; text: string; mineLine: number }
  | { kind: 'added'; text: string; theirsLine: number }

/**
 * Above this the DP table stops being free. Two notes that share no lines at
 * all and are both a thousand lines long are not a diff anyone reads, so the
 * fallback -- whole file replaced -- is the honest rendering anyway.
 */
const MAX_CELLS = 4_000_000

export function diffLines(mineText: string, theirsText: string): DiffRow[] {
  const mine = mineText.split('\n')
  const theirs = theirsText.split('\n')

  let start = 0
  while (start < mine.length && start < theirs.length && mine[start] === theirs[start]) {
    start += 1
  }

  let mineEnd = mine.length
  let theirsEnd = theirs.length
  while (mineEnd > start && theirsEnd > start && mine[mineEnd - 1] === theirs[theirsEnd - 1]) {
    mineEnd -= 1
    theirsEnd -= 1
  }

  const rows: DiffRow[] = []

  for (let i = 0; i < start; i += 1) {
    rows.push({ kind: 'same', text: mine[i] ?? '', mineLine: i + 1, theirsLine: i + 1 })
  }

  rows.push(...diffMiddle(mine.slice(start, mineEnd), theirs.slice(start, theirsEnd), start))

  for (let offset = 0; mineEnd + offset < mine.length; offset += 1) {
    rows.push({
      kind: 'same',
      text: mine[mineEnd + offset] ?? '',
      mineLine: mineEnd + offset + 1,
      theirsLine: theirsEnd + offset + 1,
    })
  }

  return rows
}

function diffMiddle(mine: string[], theirs: string[], offset: number): DiffRow[] {
  const rows: DiffRow[] = []

  const removeAll = () => {
    mine.forEach((text, i) => rows.push({ kind: 'removed', text, mineLine: offset + i + 1 }))
    theirs.forEach((text, j) => rows.push({ kind: 'added', text, theirsLine: offset + j + 1 }))
  }

  if (mine.length === 0 || theirs.length === 0 || mine.length * theirs.length > MAX_CELLS) {
    removeAll()
    return rows
  }

  const width = theirs.length + 1
  const table = new Uint32Array((mine.length + 1) * width)
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0

  for (let i = mine.length - 1; i >= 0; i -= 1) {
    for (let j = theirs.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        mine[i] === theirs[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }

  let i = 0
  let j = 0

  while (i < mine.length && j < theirs.length) {
    const left = mine[i] ?? ''
    const right = theirs[j] ?? ''

    if (left === right) {
      rows.push({ kind: 'same', text: left, mineLine: offset + i + 1, theirsLine: offset + j + 1 })
      i += 1
      j += 1
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      rows.push({ kind: 'removed', text: left, mineLine: offset + i + 1 })
      i += 1
    } else {
      rows.push({ kind: 'added', text: right, theirsLine: offset + j + 1 })
      j += 1
    }
  }

  while (i < mine.length) {
    rows.push({ kind: 'removed', text: mine[i] ?? '', mineLine: offset + i + 1 })
    i += 1
  }

  while (j < theirs.length) {
    rows.push({ kind: 'added', text: theirs[j] ?? '', theirsLine: offset + j + 1 })
    j += 1
  }

  return rows
}

export type DiffChunk = DiffRow | { kind: 'gap'; lines: number }

/**
 * Folds long unchanged runs so the dialog shows the disagreement rather than
 * the whole note. `context` lines survive on each side of a change.
 */
export function collapseUnchanged(rows: DiffRow[], context = 3): DiffChunk[] {
  const keep = new Array<boolean>(rows.length).fill(false)

  rows.forEach((row, index) => {
    if (row.kind === 'same') return
    for (let i = index - context; i <= index + context; i += 1) {
      if (i >= 0 && i < rows.length) keep[i] = true
    }
  })

  const chunks: DiffChunk[] = []
  let hidden = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined) continue

    if (keep[index] === true) {
      if (hidden > 0) {
        chunks.push({ kind: 'gap', lines: hidden })
        hidden = 0
      }
      chunks.push(row)
    } else {
      hidden += 1
    }
  }

  if (hidden > 0) chunks.push({ kind: 'gap', lines: hidden })

  return chunks
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const row of rows) {
    if (row.kind === 'added') added += 1
    else if (row.kind === 'removed') removed += 1
  }

  return { added, removed }
}
