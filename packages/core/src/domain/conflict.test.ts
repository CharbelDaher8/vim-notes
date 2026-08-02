import { describe, expect, it } from 'vitest'

import { asContentHash, decideWrite, decideWriteOrForce, FORCE_WRITE } from './conflict'

const A = asContentHash('hash-a')
const B = asContentHash('hash-b')

describe('decideWrite', () => {
  describe('creating (expected === null)', () => {
    it('succeeds when nothing is there', () => {
      expect(decideWrite(null, null)).toEqual({ ok: true })
    })

    it('refuses when a note already exists', () => {
      expect(decideWrite(null, A)).toEqual({
        ok: false,
        conflict: { kind: 'already-exists', actual: A },
      })
    })
  })

  describe('updating', () => {
    it('succeeds when the file is unchanged', () => {
      expect(decideWrite(A, A)).toEqual({ ok: true })
    })

    it('refuses a stale write', () => {
      // The case this whole mechanism exists for: phone opened the note at
      // version A, nvim wrote B in between, phone tries to save over it.
      expect(decideWrite(A, B)).toEqual({
        ok: false,
        conflict: { kind: 'stale', expected: A, actual: B },
      })
    })

    it('refuses when the file vanished underneath', () => {
      expect(decideWrite(A, null)).toEqual({
        ok: false,
        conflict: { kind: 'deleted-underneath', expected: A },
      })
    })
  })
})

describe('decideWriteOrForce', () => {
  it('bypasses every conflict', () => {
    expect(decideWriteOrForce(FORCE_WRITE, null)).toEqual({ ok: true })
    expect(decideWriteOrForce(FORCE_WRITE, A)).toEqual({ ok: true })
    expect(decideWriteOrForce(FORCE_WRITE, B)).toEqual({ ok: true })
  })

  it('otherwise defers to decideWrite', () => {
    expect(decideWriteOrForce(A, B)).toEqual(decideWrite(A, B))
    expect(decideWriteOrForce(null, null)).toEqual(decideWrite(null, null))
  })
})
