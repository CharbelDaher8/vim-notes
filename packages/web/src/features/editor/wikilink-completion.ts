/**
 * What to offer, and what to write down, when someone types `[[`.
 *
 * No CodeMirror in here on purpose. Both interesting questions -- "is the
 * cursor inside an unclosed wiki link?" and "what is the shortest way to write
 * this note's name that still resolves to it?" -- are about strings, and
 * answering them by typing into an editor and looking is slow and forgettable.
 * The CodeMirror side is in wikilink-autocomplete.ts and is barely a page.
 *
 * The second question is the one worth being careful about. `resolveWikiTarget`
 * accepts a bare name only when exactly one note answers to it, so completing
 * `[[roadmap]]` in a vault with two roadmaps would insert a link that resolves
 * to nothing and is drawn as missing -- an autocomplete whose suggestions do
 * not work. So the label is the shortest form that still resolves: the stem
 * when it is unique, and the path when it is not.
 */
import { notePathBasename, type NotePath } from '@vim-notes/core'

export interface WikiCompletion {
  /**
   * What goes between the brackets. The shortest form that resolves back to
   * `path`, which is what somebody would have typed by hand.
   */
  insert: string
  /** The whole path, shown alongside, so an ambiguous stem is still legible. */
  path: NotePath
}

/**
 * The unclosed `[[` the cursor sits in, or null.
 *
 * `text` is the document up to the cursor -- the caller passes a slice, because
 * scanning a whole note per keystroke to find two brackets is work nobody
 * needs. Returns what has been typed since the brackets, which is both the
 * query and, by its length, where the completion should start replacing.
 */
export function wikiQueryBefore(text: string): string | null {
  const open = text.lastIndexOf('[[')
  if (open === -1) return null

  const typed = text.slice(open + 2)

  // A closing bracket means the link is already finished and the cursor is
  // past it; a newline means the `[[` above was a different, abandoned one.
  // Neither is a link being written here.
  if (/[\]\n]/.test(typed)) return null

  return typed
}

/**
 * Every note, as something writable between brackets.
 *
 * Sorted by path so the list is stable between keystrokes and between
 * sessions: CodeMirror reorders by how well each one matches what has been
 * typed, and an unstable input to that would make the popup jump around for
 * reasons nobody could see.
 */
export function wikiCompletions(paths: readonly NotePath[]): WikiCompletion[] {
  const counts = new Map<string, number>()

  for (const path of paths) {
    const stem = stemOf(notePathBasename(path)).toLowerCase()
    counts.set(stem, (counts.get(stem) ?? 0) + 1)
  }

  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const basename = notePathBasename(path)
      const stem = stemOf(basename)

      // Unique by stem: `[[architecture]]` is how anyone would write it, and it
      // resolves. Otherwise the path, which resolves exactly -- with the
      // extension left off, since `resolveWikiTarget` adds `.md` back.
      const insert = counts.get(stem.toLowerCase()) === 1 ? stem : stemOf(path)

      return { insert, path }
    })
}

/**
 * Where the closing brackets are, if they are already there.
 *
 * Typing `[[` by hand leaves nothing to close; arriving inside a `[[]]` that
 * was pasted or typed in full leaves two brackets the completion must step over
 * rather than duplicate. `after` is the document from the cursor onwards.
 */
export function closingAfter(after: string): number {
  return after.startsWith(']]') ? 2 : 0
}

function stemOf(value: string): string {
  const dot = value.lastIndexOf('.')
  const slash = value.lastIndexOf('/')

  // `dot <= slash + 1` leaves both a dotfile and a directory with a dot in it
  // alone: neither `.gitignore` nor `refs.old/roadmap` has an extension here.
  return dot <= slash + 1 ? value : value.slice(0, dot)
}
