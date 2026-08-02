import { createHash } from 'node:crypto'

import { asContentHash, type ContentHash } from '@vim-notes/core'

/**
 * sha256, hex.
 *
 * This lives in the server package rather than next to `decideWrite` because
 * core ships to the browser and may not import `node:crypto`. Core owns the
 * comparison, adapters own the digest.
 *
 * Strings are hashed as UTF-8, which is exactly the encoding the stores write,
 * so read -> edit -> write round-trips agree. The filesystem adapter hashes the
 * raw bytes it read rather than the decoded string: the hash answers "did the
 * file on disk change", and a file containing invalid UTF-8 would otherwise
 * hash the replacement characters instead of its actual contents.
 */
export function hashContent(content: string | Uint8Array): ContentHash {
  return asContentHash(createHash('sha256').update(content).digest('hex'))
}
