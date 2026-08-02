/**
 * What a NoteStore is allowed to throw.
 *
 * This lives in core rather than beside the adapters because the set of
 * failures a port can produce is as much part of its contract as its return
 * types. Putting it here is what lets the API layer map a failure to a status
 * code without importing an adapter, which would invert the dependency
 * direction the whole hexagon exists to protect.
 *
 * Write conflicts are deliberately NOT in this hierarchy. They are returned as
 * data, because losing a race to nvim is a normal outcome rather than a
 * failure. See domain/conflict.ts.
 */

export class NoteStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * A resolved path landed outside the notes root.
 *
 * Unreachable through a genuine NotePath, which is exactly why it is worth
 * shouting about: reaching it means either a forged branded string or a symlink
 * pointing out of the notes tree. The API layer maps this to a generic 500
 * rather than telling the caller what happened, and it deserves a log line at
 * alarm level.
 */
export class PathEscapeError extends NoteStoreError {}

/** Nothing exists at the path, for operations that require something to. */
export class NotFoundError extends NoteStoreError {}

/** Something already occupies the path, or an ancestor that must be a directory. */
export class PathOccupiedError extends NoteStoreError {}

/** A search could not be completed. */
export class SearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The search backend is missing rather than broken -- ripgrep is an external
 * binary that may simply not be installed on a given box.
 *
 * Worth distinguishing because the two need different responses: a failed
 * search is worth retrying, an absent binary is a deployment problem that will
 * fail identically forever, and the UI should say so rather than showing an
 * empty result set that looks like "no matches".
 */
export class SearchUnavailableError extends SearchError {}
