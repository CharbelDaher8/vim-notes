/**
 * Turning `[[a wikilink]]` into a note, in the browser.
 *
 * This is a second implementation of a rule that already exists on the server,
 * in `MemoryNoteIndex.resolveNow`, and that is a real risk worth naming: two
 * implementations of one rule can drift, and when they do a link is coloured
 * one way in the editor and resolved another way in the graph and the backlinks
 * panel. The functions below are written to match that one step for step, and
 * the tests spell out each step so a change on either side has somewhere to
 * fail.
 *
 * It is duplicated anyway because the editor needs the answer *synchronously*,
 * once per visible link, while building CodeMirror decorations -- an async
 * round trip per link would either flicker or block the paint. The input is the
 * file tree the client already has, so it also costs no request and works
 * against the in-memory platform with no server at all.
 *
 * The order is deliberately conservative:
 *
 *   1. an exact path, case-sensitively   `[[journal/2026-08-01.md]]`
 *   2. that path plus `.md`              `[[journal/2026-08-01]]`
 *   3. a *unique* basename or stem, case-insensitively  `[[architecture]]`
 *   4. anything ambiguous resolves to nothing
 *
 * Two notes named `roadmap.md` in different folders resolve to neither. Picking
 * one would send someone to the wrong note and look like a bug in their own
 * filing rather than in ours.
 */
import {
  notePathBasename,
  notePathExtension,
  notePathParent,
  parseNotePath,
  type NotePath,
  type TreeEntry,
} from '@vim-notes/core'

/**
 * Matches `INDEXED_EXTENSIONS` in the server's index. Only markdown is a link
 * target there, so `[[diagram.png]]` resolves to nothing -- and it has to look
 * that way here too, or the editor would draw a link the graph calls missing.
 */
const LINKABLE_EXTENSIONS = new Set(['md', 'markdown'])

/** Every linkable file in the tree. Directories cannot be link targets. */
export function collectNotePaths(entries: readonly TreeEntry[]): NotePath[] {
  const paths: NotePath[] = []

  const walk = (list: readonly TreeEntry[]) => {
    for (const entry of list) {
      if (entry.kind === 'directory') walk(entry.children)
      else if (LINKABLE_EXTENSIONS.has(notePathExtension(entry.path))) paths.push(entry.path)
    }
  }

  walk(entries)
  return paths
}

export function resolveWikiTarget(paths: readonly NotePath[], target: string): NotePath | null {
  const cleaned = cleanTarget(target)
  if (cleaned === '') return null

  // An exact path wins outright, and case-sensitively: on the filesystem this
  // deploys to, `Roadmap.md` and `roadmap.md` are two different notes.
  // `parseNotePath` is what stops `[[../../.ssh/id_rsa]]` naming anything.
  const direct = parseNotePath(cleaned)

  if (direct.ok) {
    if (paths.includes(direct.value)) return direct.value

    // `[[projects/roadmap]]` is how a path link is written by hand; the
    // extension is implied.
    const completed = parseNotePath(`${cleaned}.md`)
    if (completed.ok && paths.includes(completed.value)) return completed.value
  }

  // Then a unique basename or stem, matched case-insensitively -- nobody
  // capitalises a wikilink the same way they named the file.
  const wanted = cleaned.toLowerCase()
  let found: NotePath | null = null

  for (const path of paths) {
    const basename = notePathBasename(path).toLowerCase()
    if (basename !== wanted && stemOf(basename) !== wanted) continue

    // A second, different note answering to the name makes it ambiguous, and
    // ambiguous resolves to nothing.
    if (found !== null && found !== path) return null
    found = path
  }

  return found
}

/**
 * Where following a link to a note that does not exist should offer to put it.
 *
 * A target with a slash is read as a path from the notes root, because that is
 * what someone typing one means. A bare name lands beside the note that linked
 * to it -- in a wiki you write the link where the thought is, and the thought's
 * neighbours are usually the right neighbours for the new note.
 */
export function suggestNotePath(target: string, from: NotePath | null): string {
  const cleaned = cleanTarget(target)
  if (cleaned === '') return ''

  const named = hasExtension(cleaned) ? cleaned : `${cleaned}.md`
  if (cleaned.includes('/')) return named

  const parent = from === null ? null : notePathParent(from)
  return parent === null ? named : `${parent}/${named}`
}

/** Trimmed and tidied, but not case-folded: the exact-path lookup needs the case. */
function cleanTarget(target: string): string {
  return target
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // `dot <= 0` leaves a dotfile alone: `.gitignore` has no extension to strip.
  return dot <= 0 ? name : name.slice(0, dot)
}

/** Tested on the last segment, so `refs.old/roadmap` is not read as extended. */
function hasExtension(value: string): boolean {
  const basename = value.slice(value.lastIndexOf('/') + 1)
  return stemOf(basename) !== basename
}
