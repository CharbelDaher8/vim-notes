/**
 * The command palette's list, and the arithmetic of moving through it.
 *
 * Kept apart from the component for the reason the other models here are: the
 * interesting behaviour is what happens to the selection when the results
 * change underneath it, and that is a question about arrays rather than about
 * React. This package has no jsdom, so logic that lives in a component is logic
 * that cannot be tested.
 *
 * Two sections, names before contents. A filename match is almost always the
 * one you meant -- you remember the note is called "watering" long before you
 * remember a phrase inside it -- and since the first item starts selected, that
 * ordering means Enter opens the right note without touching an arrow key.
 */
import { notePathBasename, notePathParent, type NotePath, type SearchHit } from '@vim-notes/core'

import { groupHits } from './search-model'

export type PaletteItem =
  /**
   * Something to *do* rather than somewhere to go.
   *
   * Commands sort above every result and the first one starts selected, so
   * typing "spent 12 coffee" and pressing Enter records it without an arrow
   * key. That ordering is the whole reason a command belongs in this list
   * rather than in a mode of its own: a palette you have to put into the right
   * mode first is slower than the note it was meant to save you opening.
   */
  | {
      kind: 'command'
      key: string
      label: string
      /** Shown dimmed beside the label -- what will actually happen. */
      detail: string
    }
  | {
      kind: 'note'
      key: string
      path: NotePath
      name: string
      directory: NotePath | null
    }
  | {
      kind: 'hit'
      key: string
      path: NotePath
      line: number
      column: number
      preview: string
      /** First hit in its file, so the component knows where to put the path. */
      startsGroup: boolean
    }

export interface PaletteSection {
  id: 'commands' | 'names' | 'contents'
  heading: string
  items: PaletteItem[]
}

export interface PaletteResults {
  sections: PaletteSection[]
  /** Every item in visual order. This is the order the arrow keys walk. */
  items: PaletteItem[]
  /** Hits the server returned, before the palette's own cap. */
  totalHits: number
  /** Hits actually listed, so the footer can be honest about the difference. */
  shownHits: number
}

/**
 * Far more than fits on screen, few enough that holding an arrow key gets you to
 * the bottom. Anyone with more matches than this wants a narrower query, not a
 * longer list, and the count below the results says so.
 */
export const DEFAULT_HIT_LIMIT = 40

export function buildPaletteResults(input: {
  names: NotePath[]
  hits: SearchHit[]
  /** Actions offered for this query, already decided by the caller. */
  commands?: Extract<PaletteItem, { kind: 'command' }>[]
  hitLimit?: number
}): PaletteResults {
  const limit = input.hitLimit ?? DEFAULT_HIT_LIMIT
  const commandItems = input.commands ?? []

  const noteItems: PaletteItem[] = input.names.map((path) => ({
    kind: 'note',
    key: `note:${path}`,
    path,
    name: notePathBasename(path),
    directory: notePathParent(path),
  }))

  const hitItems: PaletteItem[] = []

  for (const group of groupHits(input.hits)) {
    for (const [index, hit] of group.hits.entries()) {
      if (hitItems.length >= limit) break

      hitItems.push({
        kind: 'hit',
        // Unique because the adapter reports at most one hit per line per file.
        key: `hit:${hit.path}:${hit.line}`,
        path: hit.path,
        line: hit.line,
        column: hit.column,
        preview: hit.preview,
        startsGroup: index === 0,
      })
    }
  }

  const sections: PaletteSection[] = []
  if (commandItems.length > 0) {
    sections.push({ id: 'commands', heading: 'Actions', items: commandItems })
  }
  if (noteItems.length > 0) sections.push({ id: 'names', heading: 'Notes', items: noteItems })
  if (hitItems.length > 0) sections.push({ id: 'contents', heading: 'Contents', items: hitItems })

  return {
    sections,
    items: [...commandItems, ...noteItems, ...hitItems],
    totalHits: input.hits.length,
    shownHits: hitItems.length,
  }
}

/**
 * Where the highlight sits.
 *
 * A key that is no longer in the list resolves to the top rather than to
 * nothing: results are replaced on every keystroke, and a palette whose
 * selection kept vanishing would make Enter unpredictable at exactly the moment
 * someone is about to press it.
 */
export function selectionIndex(items: PaletteItem[], key: string | null): number {
  if (items.length === 0) return -1
  if (key === null) return 0

  const found = items.findIndex((item) => item.key === key)
  return found === -1 ? 0 : found
}

export function selectedItem(items: PaletteItem[], key: string | null): PaletteItem | null {
  const index = selectionIndex(items, key)
  return index === -1 ? null : (items[index] ?? null)
}

/**
 * The key `delta` steps away, wrapping at both ends.
 *
 * Wrapping because the list is short and the alternative is a dead key press at
 * the boundary; in a palette that reads as the app having stopped responding.
 */
export function moveSelection(
  items: PaletteItem[],
  key: string | null,
  delta: number,
): string | null {
  if (items.length === 0) return null

  const from = selectionIndex(items, key)
  const next = (((from + delta) % items.length) + items.length) % items.length

  return items[next]?.key ?? null
}
