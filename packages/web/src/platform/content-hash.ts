import { asContentHash, type ContentHash } from '@vim-notes/core'

/**
 * FNV-1a over the UTF-16 code units, tagged with the length.
 *
 * Only `InMemoryPlatform` uses this. The real hashes come from the server,
 * which uses a proper digest; the client only ever compares opaque strings, so
 * a fake that is cheap and synchronous keeps tests free of async ceremony and
 * WebCrypto stubs. It is not, and does not need to be, collision resistant
 * against an adversary -- the only thing it has to distinguish is "did someone
 * else edit this file while I was typing".
 */
export function hashContent(content: string): ContentHash {
  let hash = 0x811c9dc5

  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    // The usual FNV multiply, kept in 32-bit range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return asContentHash(`${content.length.toString(36)}-${hash.toString(36)}`)
}

/** Bytes, not characters -- `NoteMetadata.size` is what is on disk. */
export function byteLength(content: string): number {
  return new TextEncoder().encode(content).length
}
