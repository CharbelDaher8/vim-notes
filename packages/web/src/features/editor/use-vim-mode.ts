import { useCallback, useEffect } from 'react'

import { useMediaQuery } from '../../shared/use-media-query'
import { useEditorStore } from './editor-store'
import {
  NO_HOVER_QUERY,
  POINTER_COARSE_QUERY,
  resolveVimEnabled,
  toggleVimOverride,
  type VimOverride,
} from './vim-preference'

/**
 * Both media queries are subscribed rather than sampled, so pairing a keyboard
 * or docking a tablet re-runs the decision. The stored override, if there is
 * one, wins either way -- it is the answer to a question the device cannot be
 * asked.
 */
export function useVimMode(): { enabled: boolean; override: VimOverride; toggle: () => void } {
  const coarsePointer = useMediaQuery(POINTER_COARSE_QUERY)
  const noHover = useMediaQuery(NO_HOVER_QUERY)

  const override = useEditorStore((state) => state.vimOverride)
  const setOverride = useEditorStore((state) => state.setVimOverride)
  const setEnabled = useEditorStore((state) => state.setVimEnabled)

  const enabled = resolveVimEnabled(override, { coarsePointer, noHover })

  useEffect(() => {
    setEnabled(enabled)
  }, [enabled, setEnabled])

  const toggle = useCallback(() => {
    setOverride(toggleVimOverride(enabled))
  }, [enabled, setOverride])

  return { enabled, override, toggle }
}
