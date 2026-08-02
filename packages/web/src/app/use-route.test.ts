import { describe, expect, it } from 'vitest'

import { routeFor } from './use-route'

describe('routeFor', () => {
  it('sends /term and anything under it to the terminal', () => {
    expect(routeFor('/term')).toBe('terminal')
    expect(routeFor('/term/')).toBe('terminal')
    expect(routeFor('/term/session-1')).toBe('terminal')
  })

  it('sends everything else to the notes workspace', () => {
    expect(routeFor('/')).toBe('notes')
    expect(routeFor('/notes/inbox.md')).toBe('notes')
  })

  it('does not match a path that merely starts with the same letters', () => {
    // A note directory called `terminal/` must not load a terminal.
    expect(routeFor('/terminal')).toBe('notes')
    expect(routeFor('/terms-of-use')).toBe('notes')
  })
})
