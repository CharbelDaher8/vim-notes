/**
 * Optimistic concurrency for note writes.
 *
 * This exists because the whole design has two writers pointed at one directory:
 * nvim running in a PTY on the server, and the web/mobile client. Without a
 * check, opening a note on your phone at 09:00, editing it at 17:00, and hitting
 * save silently destroys everything nvim wrote in between.
 *
 * The scheme is the usual one. Every read hands back a hash of the bytes the
 * client received. Every write submits the hash it was based on. If the file on
 * disk no longer hashes to that value, someone else got there first and the
 * write is refused rather than applied.
 *
 * Computing the hash is deliberately NOT done here -- that needs `node:crypto`
 * on the server and WebCrypto in the browser, and core stays free of both. Core
 * owns only the decision, which is pure and is the part worth testing.
 */

declare const contentHashBrand: unique symbol

/** Opaque digest of a note's bytes. Produced by adapters, compared only here. */
export type ContentHash = string & { readonly [contentHashBrand]: true }

export function asContentHash(value: string): ContentHash {
  return value as ContentHash
}

/**
 * What the client believed about the file when it started editing.
 *
 * `null` means "I believe this file does not exist and I am creating it", which
 * is a meaningfully different claim from "I am updating version abc123" and
 * fails in a different way.
 */
export type ExpectedVersion = ContentHash | null

export type WriteConflict =
  /** Client thought it was creating a new note, but something is already there. */
  | { kind: 'already-exists'; actual: ContentHash }
  /** Client was editing a note that has since been deleted or moved away. */
  | { kind: 'deleted-underneath'; expected: ContentHash }
  /** Client was editing a stale version; someone wrote in between. */
  | { kind: 'stale'; expected: ContentHash; actual: ContentHash }

export type WriteDecision = { ok: true } | { ok: false; conflict: WriteConflict }

/**
 * Decide whether a write may proceed.
 *
 * @param expected what the client based its edit on, or null for a create
 * @param actual   what is on disk right now, or null if nothing is there
 */
export function decideWrite(expected: ExpectedVersion, actual: ContentHash | null): WriteDecision {
  if (expected === null) {
    // Creating. Only valid if nothing is there.
    return actual === null ? { ok: true } : { ok: false, conflict: { kind: 'already-exists', actual } }
  }

  if (actual === null) {
    return { ok: false, conflict: { kind: 'deleted-underneath', expected } }
  }

  if (expected !== actual) {
    return { ok: false, conflict: { kind: 'stale', expected, actual } }
  }

  return { ok: true }
}

/**
 * Escape hatch for writes that intentionally clobber -- "keep mine" in a
 * conflict prompt, or a restore from history. Named so that it is obvious at the
 * call site that the safety check is being skipped on purpose.
 */
export const FORCE_WRITE = Symbol('force-write')
export type ForceWrite = typeof FORCE_WRITE

export function decideWriteOrForce(
  expected: ExpectedVersion | ForceWrite,
  actual: ContentHash | null,
): WriteDecision {
  return expected === FORCE_WRITE ? { ok: true } : decideWrite(expected, actual)
}

export function describeWriteConflict(conflict: WriteConflict): string {
  switch (conflict.kind) {
    case 'already-exists':
      return 'a note already exists at this path'
    case 'deleted-underneath':
      return 'this note was deleted or moved while you were editing it'
    case 'stale':
      return 'this note changed since you opened it'
  }
}
