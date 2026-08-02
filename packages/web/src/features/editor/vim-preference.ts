/**
 * Whether vim keybindings should be on. See DECISIONS.md §4.
 *
 * Kept as pure functions rather than living inside the hook, because the whole
 * point of the rule is the precedence between an explicit choice and a detected
 * one, and precedence rules are exactly the thing that should be tested rather
 * than eyeballed on a phone.
 */

export type VimOverride = 'on' | 'off' | null

export interface PointerCapabilities {
  /** `(pointer: coarse)` -- the primary pointer is a finger. */
  coarsePointer: boolean
  /** `(hover: none)` -- the primary pointer cannot hover. */
  noHover: boolean
}

export const POINTER_COARSE_QUERY = '(pointer: coarse)'
export const NO_HOVER_QUERY = '(hover: none)'

/**
 * Either signal alone is enough.
 *
 * On a phone both are true, so the common case is not interesting. The cases
 * that decide the operator are the odd ones: a stylus tablet reports a fine
 * pointer that cannot hover, and neither of those devices has an Esc key. Both
 * signals point at the same underlying question -- is there a real keyboard --
 * and answering "no" wrongly is recoverable in one tap, while answering "yes"
 * wrongly leaves someone stuck in normal mode with no way to type.
 */
export function looksLikeTouchDevice(capabilities: PointerCapabilities): boolean {
  return capabilities.coarsePointer || capabilities.noHover
}

export function vimDefaultFor(capabilities: PointerCapabilities): boolean {
  return !looksLikeTouchDevice(capabilities)
}

/**
 * The manual toggle always wins. A Bluetooth keyboard paired to a phone and a
 * touchscreen laptop both defeat the detection, and in both directions.
 */
export function resolveVimEnabled(
  override: VimOverride,
  capabilities: PointerCapabilities,
): boolean {
  if (override !== null) return override === 'on'
  return vimDefaultFor(capabilities)
}

export function parseVimOverride(stored: string | null): VimOverride {
  return stored === 'on' || stored === 'off' ? stored : null
}

/**
 * Toggling sets an explicit override rather than clearing back to detection.
 * "I turned it off" should survive rotating the device, docking, or pairing a
 * keyboard -- all of which change what detection would say.
 */
export function toggleVimOverride(current: boolean): VimOverride {
  return current ? 'off' : 'on'
}
