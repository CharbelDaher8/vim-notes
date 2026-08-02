/**
 * NotePath -- a relative path that is guaranteed to stay inside the notes root.
 *
 * Every path in this system originates from something untrusted: a URL segment,
 * a tRPC payload, a drag-and-drop in the file tree. Handing those straight to
 * `fs` is how you get `../../.ssh/id_rsa` read out of your notes API, so paths
 * are parsed exactly once at the boundary into a branded type, and every port
 * accepts only that type. If it typechecks, it has been validated.
 *
 * This module deliberately hand-rolls its POSIX path handling instead of using
 * `node:path`. Two reasons: core ships to the browser as well as the server, and
 * this is the one piece of logic in the codebase where a polyfill's edge-case
 * behaviour would be a security bug rather than an inconvenience. It is ~100
 * lines and fully covered by tests.
 *
 * Note that `..` is rejected outright rather than resolved. `a/../b` is harmless
 * in principle, but no legitimate client produces it -- paths come from the tree
 * UI -- and refusing to normalise at all removes an entire category of
 * traversal bug. The filesystem adapter performs an independent containment
 * check on the resolved path as a second layer; neither trusts the other.
 */

declare const notePathBrand: unique symbol

export type NotePath = string & { readonly [notePathBrand]: true }

export const MAX_PATH_LENGTH = 1024
export const MAX_SEGMENT_LENGTH = 255

export type NotePathError =
  | { kind: 'empty' }
  | { kind: 'too-long'; length: number; max: number }
  | { kind: 'absolute' }
  | { kind: 'traversal-segment' }
  | { kind: 'nul-byte' }
  | { kind: 'control-character' }
  | { kind: 'backslash' }
  | { kind: 'segment-too-long'; segment: string }
  | { kind: 'reserved-segment'; segment: string }
  | { kind: 'trailing-space-or-dot'; segment: string }
  | { kind: 'blank-segment' }

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: NotePathError }

/**
 * Windows refuses to create files with these names regardless of extension.
 * The server is Linux, but the desktop app syncs to Windows machines, so a note
 * called `aux.md` would be a file that simply cannot be checked out there.
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * `.git` is blocked at any depth. The notes directory *is* a git repository, so
 * a write into `.git/hooks/post-commit` would be arbitrary code execution on the
 * next save. This is the single most important line in the file.
 */
const BLOCKED_SEGMENTS = new Set(['.git'])

const WINDOWS_DRIVE = /^[A-Za-z]:/

export function parseNotePath(input: string): ParseResult<NotePath> {
  if (input.length === 0) return { ok: false, error: { kind: 'empty' } }

  if (input.length > MAX_PATH_LENGTH) {
    return { ok: false, error: { kind: 'too-long', length: input.length, max: MAX_PATH_LENGTH } }
  }

  if (input.includes('\0')) return { ok: false, error: { kind: 'nul-byte' } }

  // Backslashes are rejected rather than translated. They are legal in POSIX
  // filenames, so translating would silently rewrite a valid (if odd) name, and
  // accepting them raw invites Windows-style traversal past a naive check.
  if (input.includes('\\')) return { ok: false, error: { kind: 'backslash' } }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(input)) {
    return { ok: false, error: { kind: 'control-character' } }
  }

  if (input.startsWith('/') || WINDOWS_DRIVE.test(input)) {
    return { ok: false, error: { kind: 'absolute' } }
  }

  const segments: string[] = []

  for (const raw of input.split('/')) {
    // Collapse `//` and drop a trailing slash; both are just sloppy input.
    if (raw === '' || raw === '.') continue

    if (raw === '..') return { ok: false, error: { kind: 'traversal-segment' } }

    if (raw.trim() === '') return { ok: false, error: { kind: 'blank-segment' } }

    if (raw.length > MAX_SEGMENT_LENGTH) {
      return { ok: false, error: { kind: 'segment-too-long', segment: raw } }
    }

    const lower = raw.toLowerCase()

    if (BLOCKED_SEGMENTS.has(lower)) {
      return { ok: false, error: { kind: 'reserved-segment', segment: raw } }
    }

    // `aux.md` is as unusable on Windows as bare `aux`, so compare the stem.
    const stem = lower.split('.')[0] ?? ''
    if (WINDOWS_RESERVED.has(stem)) {
      return { ok: false, error: { kind: 'reserved-segment', segment: raw } }
    }

    if (raw.endsWith(' ') || raw.endsWith('.')) {
      return { ok: false, error: { kind: 'trailing-space-or-dot', segment: raw } }
    }

    segments.push(raw)
  }

  if (segments.length === 0) return { ok: false, error: { kind: 'empty' } }

  return { ok: true, value: segments.join('/') as NotePath }
}

/** Throwing variant, for tests and for call sites that already validated. */
export function assertNotePath(input: string): NotePath {
  const result = parseNotePath(input)
  if (!result.ok) {
    throw new Error(
      `invalid note path ${JSON.stringify(input)}: ${describeNotePathError(result.error)}`,
    )
  }
  return result.value
}

export function isNotePath(input: string): input is NotePath {
  return parseNotePath(input).ok
}

export function describeNotePathError(error: NotePathError): string {
  switch (error.kind) {
    case 'empty':
      return 'path is empty'
    case 'too-long':
      return `path is ${error.length} characters, maximum is ${error.max}`
    case 'absolute':
      return 'path must be relative to the notes root'
    case 'traversal-segment':
      return "path may not contain a '..' segment"
    case 'nul-byte':
      return 'path contains a NUL byte'
    case 'control-character':
      return 'path contains a control character'
    case 'backslash':
      return 'path contains a backslash; use forward slashes'
    case 'segment-too-long':
      return `path segment ${JSON.stringify(error.segment)} exceeds ${MAX_SEGMENT_LENGTH} characters`
    case 'reserved-segment':
      return `path segment ${JSON.stringify(error.segment)} is reserved`
    case 'trailing-space-or-dot':
      return `path segment ${JSON.stringify(error.segment)} may not end with a space or dot`
    case 'blank-segment':
      return 'path contains a blank segment'
  }
}

// --- Derived accessors -------------------------------------------------------
// These operate on an already-validated NotePath, so they cannot fail.

export function notePathSegments(path: NotePath): string[] {
  return path.split('/')
}

export function notePathBasename(path: NotePath): string {
  const segments = notePathSegments(path)
  return segments[segments.length - 1] ?? ''
}

export function notePathExtension(path: NotePath): string {
  const base = notePathBasename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Parent directory, or null when the path is already at the root. */
export function notePathParent(path: NotePath): NotePath | null {
  const segments = notePathSegments(path)
  if (segments.length <= 1) return null
  return segments.slice(0, -1).join('/') as NotePath
}

export function notePathJoin(parent: NotePath | null, child: string): ParseResult<NotePath> {
  return parseNotePath(parent === null ? child : `${parent}/${child}`)
}

/** True when `ancestor` is a proper prefix directory of `descendant`. */
export function notePathContains(ancestor: NotePath, descendant: NotePath): boolean {
  return descendant.startsWith(`${ancestor}/`)
}
