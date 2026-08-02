import { describe, expect, it } from 'vitest'

import { isSafeExternalUrl } from './external-url'

describe('isSafeExternalUrl', () => {
  it('allows ordinary web links', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://192.168.1.4:8080/path?q=1#x')).toBe(true)
  })

  it('refuses schemes that can execute or read local state', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeExternalUrl('vbscript:msgbox(1)')).toBe(false)
  })

  it('refuses custom schemes registered by other applications', () => {
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false)
    expect(isSafeExternalUrl('slack://channel?id=1')).toBe(false)
  })

  it('is not fooled by case or leading whitespace', () => {
    expect(isSafeExternalUrl('JavaScript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('  javascript:alert(1)')).toBe(false)
  })

  it('refuses anything that is not an absolute url', () => {
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl('example.com')).toBe(false)
    expect(isSafeExternalUrl('/notes/inbox.md')).toBe(false)
  })
})
