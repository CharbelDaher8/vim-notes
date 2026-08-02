import { describe, expect, it } from 'vitest'

import {
  parseVimOverride,
  resolveVimEnabled,
  toggleVimOverride,
  vimDefaultFor,
} from './vim-preference'

const phone = { coarsePointer: true, noHover: true }
const laptop = { coarsePointer: false, noHover: false }
const touchscreenLaptop = { coarsePointer: false, noHover: false }
const stylusTablet = { coarsePointer: false, noHover: true }

describe('vimDefaultFor', () => {
  it('is off on a phone', () => {
    expect(vimDefaultFor(phone)).toBe(false)
  })

  it('is on with a mouse and a keyboard', () => {
    expect(vimDefaultFor(laptop)).toBe(true)
  })

  it('is off when the primary pointer cannot hover, even if it is fine', () => {
    expect(vimDefaultFor(stylusTablet)).toBe(false)
  })

  it('is on for a touchscreen laptop, whose primary pointer is still a mouse', () => {
    expect(vimDefaultFor(touchscreenLaptop)).toBe(true)
  })
})

describe('resolveVimEnabled', () => {
  it('falls back to detection with no stored override', () => {
    expect(resolveVimEnabled(null, phone)).toBe(false)
    expect(resolveVimEnabled(null, laptop)).toBe(true)
  })

  it('lets an explicit on beat touch detection, for a paired keyboard', () => {
    expect(resolveVimEnabled('on', phone)).toBe(true)
  })

  it('lets an explicit off beat desktop detection', () => {
    expect(resolveVimEnabled('off', laptop)).toBe(false)
  })
})

describe('parseVimOverride', () => {
  it('treats anything unrecognised as no override', () => {
    expect(parseVimOverride(null)).toBeNull()
    expect(parseVimOverride('')).toBeNull()
    expect(parseVimOverride('true')).toBeNull()
    expect(parseVimOverride('on')).toBe('on')
    expect(parseVimOverride('off')).toBe('off')
  })
})

describe('toggleVimOverride', () => {
  it('always produces an explicit choice, never a return to detection', () => {
    expect(toggleVimOverride(true)).toBe('off')
    expect(toggleVimOverride(false)).toBe('on')
  })
})
