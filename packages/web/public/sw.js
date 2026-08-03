/**
 * The smallest service worker that makes the app installable.
 *
 * Chrome will not offer "Install app" without a registered worker that has a
 * fetch handler, so one has to exist. That is the entire reason this file is
 * here, and the reason it does as little as it does.
 *
 * What it must not do is cache notes. The notes are a live filesystem that vim,
 * git and the file watcher all write to behind the app's back, and the whole
 * conflict-detection design (DECISIONS.md, and the baseHash checks in the
 * store) exists to stop the client acting on a stale copy. A cached `/trpc`
 * response is exactly that stale copy, arriving with no hash and no way for the
 * app to know it is old. So `/trpc` is not merely uncached -- it is routed
 * around entirely, before any cache is opened.
 *
 * What is left is the shell: index.html and the hashed bundles. Those are safe
 * to cache for opposite reasons, and are handled differently below.
 */

/**
 * Bump to evict every cached shell.
 *
 * The hashed assets below accumulate across deploys -- old filenames are never
 * requested again, so nothing removes them. This is the eviction: change it and
 * `activate` drops the previous cache wholesale. Worth doing when the bundle
 * shape changes enough that carrying the old entries is just waste.
 */
const CACHE = 'vim-notes-shell-v1'

/**
 * The one entry index.html is stored under.
 *
 * Every client route -- `/`, `/graph`, `/term` -- is served the same
 * index.html by the SPA fallback (Caddy's `try_files`, and fastify's
 * `setNotFoundHandler`), so keying by request URL would store N identical
 * copies and let them drift apart. One key, one shell.
 */
const SHELL = '/'

/** Routed around, never cached: live data and the pty socket's origin path. */
const NETWORK_ONLY = ['/trpc', '/term/ws']

self.addEventListener('install', (event) => {
  // Just the shell. The hashed assets are not known here -- their filenames are
  // decided at build time and this file is static -- so they are cached on
  // first use instead. The practical effect is that offline works after one
  // online visit, not immediately after install.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)))

  // Take over rather than waiting for every tab to close. Safe here only
  // because nothing below serves a *mutable* URL from cache: navigations go to
  // the network first, and the cache-first path is content-hashed filenames,
  // which cannot change meaning under a running page.
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Same-origin GETs only. Cross-origin is not ours to reason about, and a
  // non-GET is a mutation -- caching one would be a category error.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (NETWORK_ONLY.some((prefix) => url.pathname.startsWith(prefix))) return

  // index.html, under whichever route was typed. Network-first, because this is
  // the file that names the hashed bundles: serving yesterday's copy from cache
  // would pin someone to yesterday's build for as long as the cache survives.
  // The cached copy is strictly an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }

  // Vite's output: `assets/index-B7xK2p.js` and friends. Content-hashed, so a
  // given URL's bytes can never change -- cache-first is safe by construction,
  // and a deploy simply asks for different filenames.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request))
  }

  // Everything else (icons, the manifest, the SVG) falls through to the
  // network untouched. They are small, they change rarely, and the HTTP cache
  // already handles them without this file needing an opinion.
})

async function networkFirstShell(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE)
      await cache.put(SHELL, response.clone())
    }
    return response
  } catch {
    // Offline. An unmatched shell is better reported by the app's own error
    // states than by the browser's dinosaur, but if even the shell is missing
    // there is nothing to render and the rejection is the honest answer.
    const cached = await caches.match(SHELL)
    if (cached !== undefined) return cached
    throw new Error('offline and no cached shell')
  }
}

async function cacheFirstAsset(request) {
  const cached = await caches.match(request)
  if (cached !== undefined) return cached

  const response = await fetch(request)

  // The trap: both servers answer a missing file with index.html at status 200
  // rather than a 404, so a stale lazy chunk requested after a deploy comes
  // back as HTML that *looks* like a hit. Cached under a .js URL that entry
  // would be poison, and permanent -- every later load would be handed HTML
  // where it expected a module. Serve it, so the failure is loud, but never
  // store it.
  const isSpaFallback = response.headers.get('content-type')?.includes('text/html') === true
  if (response.ok && !isSpaFallback) {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }

  return response
}
