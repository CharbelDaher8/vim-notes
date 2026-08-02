import { useEffect, useRef } from 'react'

import { usePlatform } from '../../platform'
import { decideReconcile } from './conflict-model'
import { useEditorStore } from './editor-store'

/**
 * Reacts to nvim, or a git pull, writing the note that is currently open.
 *
 * The decision itself is in `decideReconcile`, which is where the interesting
 * rule lives: never touch a dirty buffer, never react to our own echo.
 */
export function useExternalChanges(reload: () => Promise<void>): void {
  const platform = usePlatform()
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(
    () =>
      platform.subscribeToChanges((event) => {
        const store = useEditorStore.getState()

        const decision = decideReconcile(event, {
          openPath: store.path,
          baselineHash: store.baselineHash,
          dirty: store.dirty,
        })

        switch (decision.kind) {
          case 'ignore':
            return

          case 'reload':
            void reloadRef.current()
            return

          case 'gone':
            // The text stays on screen. The baseline is cleared, so saving now
            // means "create", which is exactly what recreating it should be.
            store.markMissing()
            store.setExternal({ reason: 'deleted', at: event.at })
            return

          case 'notify':
            store.setExternal({ reason: decision.reason, at: event.at })
            return
        }
      }),
    [platform],
  )
}
