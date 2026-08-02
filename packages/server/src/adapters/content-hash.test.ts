import { describe, expect, it } from 'vitest'

import { hashContent } from './content-hash'

describe('hashContent', () => {
  it('is sha256 in hex', async () => {
    // Fixed vectors rather than a round-trip: the digest ends up in client
    // storage and in conflict payloads, so changing the algorithm has to be a
    // deliberate act that breaks a test, not a silent one.
    expect(hashContent('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hashContent('hello world')).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
  })

  it('treats a string as its UTF-8 bytes', async () => {
    // The filesystem store hashes raw bytes and the in-memory store hashes
    // strings; they have to agree or the two are not interchangeable.
    expect(hashContent('héllo 🚀')).toBe(hashContent(Buffer.from('héllo 🚀', 'utf8')))
  })

  it('distinguishes content that differs only in whitespace', async () => {
    expect(hashContent('a\n')).not.toBe(hashContent('a'))
    expect(hashContent('a\r\n')).not.toBe(hashContent('a\n'))
  })
})
