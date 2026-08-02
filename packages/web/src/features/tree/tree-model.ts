/**
 * Turning the nested `TreeEntry[]` the platform returns into the flat list a
 * keyboard-navigable tree actually needs.
 *
 * The nesting is right for the wire and wrong for the UI: arrow keys move
 * between *visible rows*, which cut across the hierarchy, and a rendered tree
 * that recurses in JSX makes "the row below this one" an awkward question.
 * Flattening once, here, makes it an array index.
 */
import { notePathBasename, notePathSegments, type NotePath, type TreeEntry } from '@vim-notes/core'

export interface FlatNode {
  entry: TreeEntry
  depth: number
  expanded: boolean
  isDirectory: boolean
}

export function flattenTree(entries: TreeEntry[], expanded: ReadonlySet<string>): FlatNode[] {
  const rows: FlatNode[] = []

  const walk = (list: TreeEntry[], depth: number) => {
    for (const entry of list) {
      const isDirectory = entry.kind === 'directory'
      const open = isDirectory && expanded.has(entry.path)

      rows.push({ entry, depth, expanded: open, isDirectory })

      if (entry.kind === 'directory' && open) walk(entry.children, depth + 1)
    }
  }

  walk(entries, 0)
  return rows
}

/** `a/b/c.md` -> `['a', 'a/b']`. Used to reveal the open note on load. */
export function ancestorsOf(path: NotePath): NotePath[] {
  const segments = notePathSegments(path)
  const ancestors: NotePath[] = []

  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/') as NotePath)
  }

  return ancestors
}

export function findEntry(entries: TreeEntry[], path: NotePath): TreeEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.kind !== 'directory') continue

    const found = findEntry(entry.children, path)
    if (found !== null) return found
  }

  return null
}

/**
 * Where a "new note" action should put the file: inside the selected
 * directory, or beside the selected file. Null means the notes root.
 */
export function parentForNewEntry(
  entries: TreeEntry[],
  selected: NotePath | null,
): NotePath | null {
  if (selected === null) return null

  const entry = findEntry(entries, selected)
  if (entry === null) return null
  if (entry.kind === 'directory') return entry.path

  const segments = notePathSegments(entry.path)
  return segments.length <= 1 ? null : (segments.slice(0, -1).join('/') as NotePath)
}

/** `.md` unless the user typed some other extension themselves. */
export function withMarkdownExtension(name: string): string {
  return name.includes('.') ? name : `${name}.md`
}

/** Strips the extension for the rename field, so `.md` is not in the way. */
export function editableName(path: NotePath, isDirectory: boolean): string {
  const base = notePathBasename(path)
  if (isDirectory) return base

  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}
