import { homedir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from './config'

describe('loadConfig', () => {
  it('defaults HOST to loopback, never 0.0.0.0', () => {
    // This process pipes nvim to a WebSocket. A default that binds every
    // interface is one misconfigured firewall away from a public shell, so the
    // safe default is worth asserting rather than assuming.
    expect(loadConfig({}).HOST).toBe('127.0.0.1')
  })

  it('expands a leading tilde', () => {
    // Docker passes env values without shell expansion, so an unexpanded tilde
    // would silently create a literal ./~ directory.
    expect(loadConfig({ NOTES_ROOT: '~/notes' }).NOTES_ROOT).toBe(path.join(homedir(), 'notes'))
    expect(loadConfig({ NOTES_ROOT: '~' }).NOTES_ROOT).toBe(homedir())
  })

  it('makes NOTES_ROOT absolute', () => {
    expect(path.isAbsolute(loadConfig({ NOTES_ROOT: './relative' }).NOTES_ROOT)).toBe(true)
  })

  it('leaves an already-absolute NOTES_ROOT alone', () => {
    expect(loadConfig({ NOTES_ROOT: '/srv/notes' }).NOTES_ROOT).toBe('/srv/notes')
  })

  it('coerces numeric env vars, which always arrive as strings', () => {
    const config = loadConfig({ PORT: '8080', AUTOCOMMIT_DEBOUNCE_MS: '500' })
    expect(config.PORT).toBe(8080)
    expect(config.AUTOCOMMIT_DEBOUNCE_MS).toBe(500)
  })

  it('rejects an out-of-range port rather than falling back silently', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrowError(/PORT/)
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrowError(/PORT/)
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/)
  })

  it('supplies a git identity, since a fresh VPS has no global gitconfig', () => {
    const config = loadConfig({})
    expect(config.GIT_AUTHOR_NAME).not.toBe('')
    expect(config.GIT_AUTHOR_EMAIL).not.toBe('')
  })
})
