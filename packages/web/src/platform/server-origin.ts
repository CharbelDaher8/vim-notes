/**
 * Where the server is.
 *
 * In a browser this is a non-question: the client is served by the same Caddy
 * that proxies the API, so a relative `/trpc` and a socket built from
 * `window.location` both land in the right place.
 *
 * The desktop build breaks that assumption completely. Its pages load from the
 * bundle over `tauri://localhost` (`http://tauri.localhost` on Windows), so a
 * relative URL resolves *into the bundle* rather than to any server, and
 * `window.location.host` is a name that exists only inside the webview. The app
 * has to be told an absolute origin or it can reach nothing at all.
 *
 * Runtime rather than build-time, for a practical reason more than an
 * architectural one: the server lives on a tailnet and a tailnet address can
 * change. Baking it in at build time would mean rebuilding and reinstalling the
 * desktop app to move house.
 *
 * Deliberately no Tauri IPC and no Rust command for this. `localStorage` works
 * in the webview, and the desktop shell exposes no commands at all beyond
 * Tauri's defaults -- the right posture for something whose entire access story
 * is "not reachable off the tailnet" (DECISIONS §10, §11).
 */

/** Where a resolved origin came from. Only interesting for diagnostics. */
export type OriginSource = 'stored' | 'build-default' | 'page'

export type OriginError =
  | { kind: 'empty' }
  | { kind: 'unparseable'; input: string }
  | { kind: 'unsupported-scheme'; scheme: string }
  | { kind: 'has-path'; path: string }

export type OriginParseResult = { ok: true; origin: string } | { ok: false; error: OriginError }

export type OriginResolution =
  | { ok: true; origin: string; source: OriginSource }
  /** Nothing usable. The desktop build on first run is exactly this. */
  | { ok: false; reason: 'unconfigured' }

export const SERVER_ORIGIN_STORAGE_KEY = 'vim-notes:server-origin'

/**
 * Hostnames the Tauri webview serves the bundle from.
 *
 * Needed because the Windows variant is `http://tauri.localhost`, which passes
 * a scheme check perfectly well and would otherwise be accepted as a server
 * address -- producing a client that fetches itself and fails with a JSON parse
 * error rather than anything that names the real problem.
 */
const BUNDLE_HOSTS = new Set(['tauri.localhost'])

/**
 * Parses and normalises an origin the user typed or pasted.
 *
 * Returns the bare origin: scheme, host, port, no trailing slash. Strict about
 * a path because there is nowhere for one to go -- tRPC is mounted at `/trpc`
 * on the root and the socket at `/term/ws`, so silently discarding a `/notes`
 * someone deliberately typed would produce a client that 404s with no
 * explanation of which part was ignored.
 */
export function parseServerOrigin(input: string): OriginParseResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, error: { kind: 'empty' } }

  // Bare `host:port` is what people type. Assume http rather than rejecting it,
  // since https on a tailnet address is the unusual case.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, error: { kind: 'unparseable', input: trimmed } }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: { kind: 'unsupported-scheme', scheme: url.protocol } }
  }

  if (url.hostname === '' || BUNDLE_HOSTS.has(url.hostname)) {
    return { ok: false, error: { kind: 'unparseable', input: trimmed } }
  }

  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, error: { kind: 'has-path', path: url.pathname } }
  }

  return { ok: true, origin: url.origin }
}

export function describeOriginError(error: OriginError): string {
  switch (error.kind) {
    case 'empty':
      return 'enter a server address'
    case 'unparseable':
      return `${error.input} is not a server address`
    case 'unsupported-scheme':
      return `${error.scheme} is not a scheme this can talk to; use http:// or https://`
    case 'has-path':
      return `drop the ${error.path} part -- give just the host, like http://100.64.0.1:8080`
  }
}

/**
 * True when the page's own origin can serve as the server's.
 *
 * False inside the desktop bundle, which is the whole point: the browser build
 * should keep working with no configuration at all, and the desktop build must
 * not silently address itself.
 */
export function isUsablePageOrigin(origin: string | null | undefined): boolean {
  if (origin === null || origin === undefined || origin === '' || origin === 'null') return false

  const parsed = parseServerOrigin(origin)
  return parsed.ok
}

export interface ResolveOriginInput {
  /** What the user configured, if anything. */
  stored?: string | null
  /** Compiled-in fallback, from VITE_SERVER_ORIGIN. */
  buildDefault?: string | null | undefined
  /** `window.location.origin`, or null where there is no page. */
  pageOrigin?: string | null
}

/**
 * Resolves the origin once, in precedence order.
 *
 * A stored value wins over the compiled-in default so that a rebuild never
 * silently overrides what someone set by hand; the page's own origin comes last
 * and only when it is usable, which keeps the browser build zero-configuration
 * while forcing the desktop build to be told.
 *
 * Invalid values fall through rather than failing: a stored origin from an
 * older version, or a typo in a build argument, should degrade to the next
 * option instead of bricking the app with no way to reach the settings that
 * would fix it.
 */
export function resolveServerOrigin(input: ResolveOriginInput = {}): OriginResolution {
  const stored = parseOrNull(input.stored)
  if (stored !== null) return { ok: true, origin: stored, source: 'stored' }

  const compiled = parseOrNull(input.buildDefault)
  if (compiled !== null) return { ok: true, origin: compiled, source: 'build-default' }

  if (isUsablePageOrigin(input.pageOrigin)) {
    // Already known valid, so the parse cannot fail.
    const page = parseServerOrigin(input.pageOrigin ?? '')
    if (page.ok) return { ok: true, origin: page.origin, source: 'page' }
  }

  return { ok: false, reason: 'unconfigured' }
}

function parseOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const parsed = parseServerOrigin(value)
  return parsed.ok ? parsed.origin : null
}

// --- Building URLs -----------------------------------------------------------

export function apiUrl(origin: string, path: string): string {
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * The same address as a WebSocket URL.
 *
 * Derived from the resolved origin rather than from `window.location`, which is
 * the bug this module exists to fix: under `tauri://` the page protocol is not
 * http at all, so the usual `location.protocol === 'https:' ? 'wss:' : 'ws:'`
 * silently produced `ws://tauri.localhost/term/ws` and the terminal could never
 * connect.
 */
export function socketUrl(origin: string, path: string): string {
  const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:'
  const withoutScheme = origin.replace(/^https?:/, '')
  return `${scheme}${withoutScheme}${path.startsWith('/') ? path : `/${path}`}`
}

// --- Storage -----------------------------------------------------------------

/**
 * `localStorage` is not always there -- Safari private mode throws on access,
 * and the vitest environment for this package has no DOM at all. Every reader
 * here treats absence as "nothing configured" rather than as an error.
 */
export interface OriginStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function browserStorage(): OriginStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readStoredOrigin(storage: OriginStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(SERVER_ORIGIN_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function writeStoredOrigin(
  origin: string,
  storage: OriginStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(SERVER_ORIGIN_STORAGE_KEY, origin)
  } catch {
    // Nothing useful to do: the caller has already validated the value, and a
    // storage quota error must not lose the address the user just typed from
    // the running session.
  }
}

export function clearStoredOrigin(storage: OriginStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(SERVER_ORIGIN_STORAGE_KEY)
  } catch {
    // See above.
  }
}

/**
 * The origin this app should use, resolved from the running environment.
 *
 * Call it once at composition time and thread the result: the tRPC client and
 * the terminal socket must agree, and re-resolving per call would let them
 * disagree after a settings change.
 */
export function currentServerOrigin(): OriginResolution {
  return resolveServerOrigin({
    stored: readStoredOrigin(),
    buildDefault: buildTimeDefault(),
    pageOrigin: typeof window === 'undefined' ? null : window.location.origin,
  })
}

function buildTimeDefault(): string | undefined {
  const value: unknown = import.meta.env?.VITE_SERVER_ORIGIN
  return typeof value === 'string' ? value : undefined
}
