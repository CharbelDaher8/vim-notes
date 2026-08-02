/**
 * Debounced autosave, used only when vim is off.
 *
 * With vim on, `:w` is the save and this scheduler is never armed -- an
 * autosave firing mid-`ciw` would produce commits nobody asked for and would
 * fight the muscle memory the vim mode exists to serve.
 *
 * The max delay is the part that matters. A plain debounce means someone who
 * types steadily for four minutes has saved nothing, and a phone that gets
 * backgrounded loses all of it.
 */

export interface AutosaveScheduler {
  /** Called on every document change. Resets the quiet period. */
  schedule: () => void
  /** Runs a pending save immediately. No-op when nothing is pending. */
  flush: () => void
  cancel: () => void
  isPending: () => boolean
}

export interface AutosaveOptions {
  save: () => void
  /** Quiet period after the last keystroke. */
  delayMs?: number
  /** Longest a continuously typing user may go unsaved. */
  maxDelayMs?: number
  now?: () => number
}

export function createAutosaveScheduler({
  save,
  delayMs = 900,
  maxDelayMs = 5_000,
  now = () => Date.now(),
}: AutosaveOptions): AutosaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let armedAt: number | null = null

  const disarm = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    armedAt = null
  }

  const fire = () => {
    disarm()
    save()
  }

  return {
    schedule: () => {
      const at = now()
      armedAt ??= at

      if (timer !== null) clearTimeout(timer)

      const untilDeadline = maxDelayMs - (at - armedAt)
      timer = setTimeout(fire, Math.max(0, Math.min(delayMs, untilDeadline)))
    },

    flush: () => {
      if (timer === null) return
      fire()
    },

    cancel: disarm,

    isPending: () => timer !== null,
  }
}
