/**
 * Which note the address bar is pointing at.
 *
 * The workspace kept the open note in a store and nowhere else, which is fine
 * until something outside the workspace wants to say which note to open --
 * `/graph` is exactly that, and a plain link to `/` arrives with the store as
 * empty as a cold start. So the note goes in the URL, where a page load can
 * still read it.
 *
 * That it also survives a refresh, and can be sent to someone, and can be
 * bookmarked, is the part everybody notices. It was not the reason.
 *
 * `parseNotePath` is what makes reading one safe: a query string is user input
 * arriving from anywhere, and `?note=../../.ssh/id_rsa` has to name nothing.
 */
import { parseNotePath, type NotePath } from '@vim-notes/core'

import type { RevealTarget } from '../shared/workspace-store'

export interface NoteLocation {
  path: NotePath
  /** Absent unless the URL named a line, which is how the graph opens a todo. */
  reveal?: RevealTarget
}

export function noteFromSearch(search: string): NoteLocation | null {
  const params = new URLSearchParams(search)

  const named = params.get('note')
  if (named === null) return null

  const path = parseNotePath(named)
  if (!path.ok) return null

  // A line that is not a positive integer is dropped rather than rejected: the
  // note is still the note, and opening it at the top beats refusing to open it
  // because something mangled the fragment.
  const line = Number(params.get('line'))
  if (!Number.isInteger(line) || line < 1) return { path: path.value }

  return { path: path.value, reveal: { line } }
}

/** The address of the workspace with `path` open. */
export function noteHref(path: NotePath, reveal?: RevealTarget | null): string {
  const params = new URLSearchParams({ note: path })
  if (reveal != null) params.set('line', String(reveal.line))

  return `/?${params.toString()}`
}

/** The address the workspace should be showing, given what is open in it. */
export function workspaceHref(path: NotePath | null): string {
  return path === null ? '/' : noteHref(path)
}
