import { describe, expect, it } from 'vitest'

import { shouldRegisterServiceWorker } from './register-service-worker'

describe('shouldRegisterServiceWorker', () => {
  const deployed = { production: true, supported: true, tauri: false }

  it('registers for a deployed browser build', () => {
    expect(shouldRegisterServiceWorker(deployed)).toBe(true)
  })

  it('does not register in dev, where a stale worker would outlive the dev server', () => {
    expect(shouldRegisterServiceWorker({ ...deployed, production: false })).toBe(false)
  })

  // Reaching the app over plain http on a tailnet IP, which is a supported way
  // to use it -- no worker available, and the app has to carry on regardless.
  it('does not register where the browser withholds the API', () => {
    expect(shouldRegisterServiceWorker({ ...deployed, supported: false })).toBe(false)
  })

  it('does not register in the desktop shell, which has nothing to install', () => {
    expect(shouldRegisterServiceWorker({ ...deployed, tauri: true })).toBe(false)
  })
})
