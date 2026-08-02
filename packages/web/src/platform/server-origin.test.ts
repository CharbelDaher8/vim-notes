import { describe, expect, it } from 'vitest'

import {
  apiUrl,
  clearStoredOrigin,
  describeOriginError,
  isUsablePageOrigin,
  parseServerOrigin,
  readStoredOrigin,
  resolveServerOrigin,
  SERVER_ORIGIN_STORAGE_KEY,
  socketUrl,
  writeStoredOrigin,
  type OriginStorage,
} from './server-origin'

function fakeStorage(
  initial: Record<string, string> = {},
): OriginStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

function expectOrigin(input: string): string {
  const parsed = parseServerOrigin(input)
  if (!parsed.ok) throw new Error(`expected ${input} to parse, got ${parsed.error.kind}`)
  return parsed.origin
}

describe('parseServerOrigin', () => {
  it.each([
    ['http://100.64.0.1:8080', 'http://100.64.0.1:8080'],
    ['https://notes.example.ts.net', 'https://notes.example.ts.net'],
    // A trailing slash is what a browser address bar gives you when you copy.
    ['http://100.64.0.1:8080/', 'http://100.64.0.1:8080'],
    ['  http://100.64.0.1:8080  ', 'http://100.64.0.1:8080'],
    // Bare host:port is what people actually type.
    ['100.64.0.1:8080', 'http://100.64.0.1:8080'],
    ['notes.example.ts.net', 'http://notes.example.ts.net'],
  ])('accepts %s', (input, expected) => {
    expect(expectOrigin(input)).toBe(expected)
  })

  it('rejects an empty value', () => {
    expect(parseServerOrigin('   ')).toEqual({ ok: false, error: { kind: 'empty' } })
  })

  it.each(['file:///etc/passwd', 'tauri://localhost', 'ws://100.64.0.1:8080'])(
    'refuses the scheme in %s',
    (input) => {
      const parsed = parseServerOrigin(input)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error.kind).toBe('unsupported-scheme')
    },
  )

  it('refuses the address the desktop bundle is served from', () => {
    // http://tauri.localhost passes a scheme check perfectly well. Accepting it
    // would produce a client that fetches the bundle and fails on a JSON parse.
    const parsed = parseServerOrigin('http://tauri.localhost')
    expect(parsed.ok).toBe(false)
  })

  it('refuses a path rather than silently dropping it', () => {
    const parsed = parseServerOrigin('http://100.64.0.1:8080/notes')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.kind).toBe('has-path')
      expect(describeOriginError(parsed.error)).toContain('/notes')
    }
  })

  it.each(['http://', 'not a url at all', '://missing-scheme'])('rejects %s', (input) => {
    expect(parseServerOrigin(input).ok).toBe(false)
  })

  it('explains every refusal in terms of what to do', () => {
    for (const input of ['', 'file:///x', 'http://1.2.3.4/sub', '://bad']) {
      const parsed = parseServerOrigin(input)
      if (parsed.ok) continue
      const message = describeOriginError(parsed.error)
      expect(message.length).toBeGreaterThan(10)
      expect(message).not.toContain('undefined')
    }
  })
})

describe('isUsablePageOrigin', () => {
  it('accepts an ordinary browser origin', () => {
    expect(isUsablePageOrigin('http://100.64.0.1:8080')).toBe(true)
  })

  it.each(['tauri://localhost', 'http://tauri.localhost', 'null', '', null, undefined])(
    'rejects %s',
    (origin) => {
      expect(isUsablePageOrigin(origin)).toBe(false)
    },
  )
})

describe('resolveServerOrigin', () => {
  it('prefers what the user stored over the compiled-in default', () => {
    // A rebuild must not silently override an address someone set by hand.
    const resolved = resolveServerOrigin({
      stored: 'http://100.64.0.9:8080',
      buildDefault: 'http://100.64.0.1:8080',
      pageOrigin: 'http://localhost:5173',
    })

    expect(resolved).toEqual({ ok: true, origin: 'http://100.64.0.9:8080', source: 'stored' })
  })

  it('falls back to the compiled-in default', () => {
    const resolved = resolveServerOrigin({
      buildDefault: 'http://100.64.0.1:8080',
      pageOrigin: 'tauri://localhost',
    })

    expect(resolved).toEqual({
      ok: true,
      origin: 'http://100.64.0.1:8080',
      source: 'build-default',
    })
  })

  it('uses the page origin in a browser, so the web build needs no configuration', () => {
    const resolved = resolveServerOrigin({ pageOrigin: 'https://notes.example.ts.net' })

    expect(resolved).toEqual({
      ok: true,
      origin: 'https://notes.example.ts.net',
      source: 'page',
    })
  })

  it('reports unconfigured inside the desktop bundle with nothing set', () => {
    // First run of the desktop app. Returning a resolution rather than a broken
    // origin lets the UI say what to do instead of failing every request.
    expect(resolveServerOrigin({ pageOrigin: 'tauri://localhost' })).toEqual({
      ok: false,
      reason: 'unconfigured',
    })
  })

  it('falls through a stored value that no longer parses', () => {
    // A value left by an older version must degrade to the next option rather
    // than bricking the app with no way to reach the settings that would fix it.
    const resolved = resolveServerOrigin({
      stored: 'file:///nonsense',
      buildDefault: 'http://100.64.0.1:8080',
      pageOrigin: 'tauri://localhost',
    })

    expect(resolved).toEqual({
      ok: true,
      origin: 'http://100.64.0.1:8080',
      source: 'build-default',
    })
  })

  it('normalises whatever it resolves', () => {
    const resolved = resolveServerOrigin({ stored: '  100.64.0.1:8080/  ' })
    expect(resolved).toEqual({ ok: true, origin: 'http://100.64.0.1:8080', source: 'stored' })
  })
})

describe('URL building', () => {
  it('builds an API URL', () => {
    expect(apiUrl('http://100.64.0.1:8080', '/trpc')).toBe('http://100.64.0.1:8080/trpc')
    expect(apiUrl('http://100.64.0.1:8080', 'trpc')).toBe('http://100.64.0.1:8080/trpc')
  })

  it.each([
    ['http://100.64.0.1:8080', 'ws://100.64.0.1:8080/term/ws'],
    ['https://notes.example.ts.net', 'wss://notes.example.ts.net/term/ws'],
  ])('turns %s into a socket URL', (origin, expected) => {
    expect(socketUrl(origin, '/term/ws')).toBe(expected)
  })

  it('never produces a socket URL pointing at the bundle', () => {
    // The original bug: deriving the socket from window.location under tauri://
    // produced ws://tauri.localhost/term/ws, which cannot connect to anything.
    expect(socketUrl('http://100.64.0.1:8080', '/term/ws')).not.toContain('tauri')
  })
})

describe('storage', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage()
    writeStoredOrigin('http://100.64.0.1:8080', storage)

    expect(storage.data.get(SERVER_ORIGIN_STORAGE_KEY)).toBe('http://100.64.0.1:8080')
    expect(readStoredOrigin(storage)).toBe('http://100.64.0.1:8080')

    clearStoredOrigin(storage)
    expect(readStoredOrigin(storage)).toBeNull()
  })

  it('treats absent storage as nothing configured', () => {
    // Safari private mode throws on access, and this package's tests have no DOM.
    expect(readStoredOrigin(null)).toBeNull()
    expect(() => writeStoredOrigin('http://x.example', null)).not.toThrow()
    expect(() => clearStoredOrigin(null)).not.toThrow()
  })

  it('survives storage that throws', () => {
    const hostile: OriginStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }

    expect(readStoredOrigin(hostile)).toBeNull()
    expect(() => writeStoredOrigin('http://x.example', hostile)).not.toThrow()
    expect(() => clearStoredOrigin(hostile)).not.toThrow()
  })
})
