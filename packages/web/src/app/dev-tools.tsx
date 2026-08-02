import { useState } from 'react'

import { InMemoryPlatform, usePlatform } from '../platform'
import { useWorkspaceStore } from '../shared/workspace-store'

/**
 * Stands in for nvim writing to the notes directory.
 *
 * Without it the conflict and reconcile paths -- the two most important things
 * in this client and the two with no happy-path trigger -- can only be reached
 * by running the whole stack and alt-tabbing to a terminal. Only ever rendered
 * against `InMemoryPlatform`.
 */
export function DevTools() {
  const platform = usePlatform()
  const openPath = useWorkspaceStore((state) => state.openPath)
  const [open, setOpen] = useState(false)

  if (!(platform instanceof InMemoryPlatform)) return null

  const disabled = openPath === null

  return (
    <div className="devtools">
      <button
        type="button"
        className="devtools__trigger"
        aria-expanded={open}
        title="Pretend something else wrote to the notes directory"
        onClick={() => setOpen((value) => !value)}
      >
        demo
      </button>

      {!open ? null : (
        <div className="devtools__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              if (openPath === null) return
              platform.simulateExternalWrite(
                openPath,
                `# Written by nvim\n\nAt ${new Date().toLocaleTimeString()}.\n`,
                'terminal',
              )
              setOpen(false)
            }}
          >
            nvim writes this note
          </button>

          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              if (openPath === null) return
              platform.simulateExternalDelete(openPath)
              setOpen(false)
            }}
          >
            nvim deletes this note
          </button>

          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              if (openPath === null) return
              platform.simulateExternalWrite(
                openPath,
                '# Pulled\n\nA commit landed from the hub.\n',
                'git',
              )
              setOpen(false)
            }}
          >
            a git pull lands
          </button>
        </div>
      )}
    </div>
  )
}
