/**
 * Registering the service worker, and -- mostly -- deciding not to.
 *
 * The worker exists so the app is installable (see public/sw.js). Installable
 * is a property of the deployed site, so this is one of the few places where
 * the right behaviour genuinely differs between builds rather than being
 * configurable.
 */

/** What the decision depends on, named so it can be supplied in a test. */
export interface ServiceWorkerEnvironment {
  /** `import.meta.env.PROD` -- a literal by the time it ships. */
  production: boolean
  /** Whether `navigator.serviceWorker` exists at all. */
  supported: boolean
  /** The desktop shell, which is not served over http. */
  tauri: boolean
}

/**
 * Three ways to answer no, and they are all load-bearing.
 *
 * `production`: in dev the worker and Vite's HMR are two things claiming the
 * same responses, and worse, a worker registered while hacking on the app
 * outlives the dev server -- it stays installed against localhost and serves a
 * cached shell to whatever runs on that port next. Nobody connects the next
 * project's inexplicable stale page to this one.
 *
 * `supported`: absent over plain http on a non-localhost host. That is the
 * tailnet case exactly (DECISIONS.md §11), so it is a normal condition here,
 * not a defensive check -- reaching the app by IP means no worker and no
 * install prompt, and the app must simply carry on.
 *
 * `tauri`: the desktop build loads from a custom scheme with no origin a
 * worker could scope to, and it has a native window already. Nothing to
 * install.
 */
export function shouldRegisterServiceWorker(environment: ServiceWorkerEnvironment): boolean {
  return environment.production && environment.supported && !environment.tauri
}

/**
 * Register, after the page has loaded.
 *
 * Deliberately not awaited and deliberately after `load`: the worker is not on
 * the path to first paint, and fetching it earlier only takes bandwidth from
 * the bundle that is. A failure is logged and otherwise ignored -- an app that
 * cannot be installed still works, and there is nothing the user could do.
 */
export function registerServiceWorker(environment: ServiceWorkerEnvironment): void {
  if (!shouldRegisterServiceWorker(environment)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('service worker registration failed; the app is not installable', error)
    })
  })
}
