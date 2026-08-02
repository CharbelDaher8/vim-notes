/**
 * Where the desktop app is told which server to talk to.
 *
 * Rendered only when the host reports `kind === 'tauri'`. The browser build is
 * served by the same proxy that fronts the API, so an origin field there could
 * only ever break a working app -- there is nothing it could usefully be set to
 * that the page does not already know.
 *
 * All the logic lives in platform/server-origin.ts, which is plain TypeScript
 * and tested; this file is the form around it. That split is not incidental:
 * this package's tests run without a DOM, so anything worth asserting has to
 * sit outside the component.
 */
import { useState, type FormEvent } from 'react'

import {
  clearStoredOrigin,
  currentServerOrigin,
  describeOriginError,
  parseServerOrigin,
  readStoredOrigin,
  usePlatform,
  writeStoredOrigin,
} from '../platform'

export interface ServerSettingsProps {
  /**
   * `panel` is the first-run screen, where this is the only thing that matters.
   * `disclosure` is the collapsed version that lives in the header afterwards,
   * for the once-a-year case of the address changing.
   */
  variant?: 'panel' | 'disclosure'
}

export function ServerSettings({ variant = 'disclosure' }: ServerSettingsProps) {
  const platform = usePlatform()

  // The browser build never shows this. See the note above.
  if (platform.host.kind !== 'tauri') return null

  if (variant === 'panel') return <ServerOriginForm />

  return (
    <details className="server-settings__disclosure">
      <summary className="server-settings__summary">Server</summary>
      <ServerOriginForm />
    </details>
  )
}

function ServerOriginForm() {
  const [draft, setDraft] = useState(() => readStoredOrigin() ?? '')
  const [error, setError] = useState<string | null>(null)

  const resolved = currentServerOrigin()

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = draft.trim()

    // Clearing is deliberate rather than an accident of an empty field: it
    // falls back to the compiled-in default, which is how you undo a typo
    // without knowing what the default was.
    if (trimmed === '') {
      clearStoredOrigin()
      reload()
      return
    }

    const parsed = parseServerOrigin(trimmed)
    if (!parsed.ok) {
      // Refused before it is stored, so a typo cannot produce a client that
      // fails every call with a message about JSON.
      setError(describeOriginError(parsed.error))
      return
    }

    writeStoredOrigin(parsed.origin)
    reload()
  }

  return (
    <form className="server-settings" onSubmit={onSubmit}>
      <label className="server-settings__label" htmlFor="server-origin">
        Server address
      </label>

      <input
        id="server-origin"
        className="server-settings__input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        placeholder="http://100.64.0.1:8080"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-describedby="server-origin-status"
        aria-invalid={error !== null}
      />

      <button type="submit" className="server-settings__save">
        Save
      </button>

      <p
        id="server-origin-status"
        className={`server-settings__status${error === null ? '' : ' server-settings__status--error'}`}
        role="status"
      >
        {error ?? describeResolved(resolved)}
      </p>
    </form>
  )
}

function describeResolved(resolved: ReturnType<typeof currentServerOrigin>): string {
  if (!resolved.ok) return 'No server configured yet.'
  return resolved.source === 'stored'
    ? `Using ${resolved.origin}`
    : `Using ${resolved.origin} (built-in default)`
}

/**
 * The transport is built once at startup, so changing the address means
 * rebuilding it. Reloading is the honest way: the alternative is re-plumbing a
 * live tRPC client and an open WebSocket, which is a lot of machinery for
 * something done roughly once per machine.
 */
function reload(): void {
  window.location.reload()
}
