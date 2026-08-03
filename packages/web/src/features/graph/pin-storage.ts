/**
 * Where a person put a node, remembered across reloads.
 *
 * In localStorage rather than in the notes, on purpose. An arrangement is a
 * property of how *you* like to look at the graph on *this* screen -- a phone
 * and a desktop want different ones -- and DECISIONS §1 is that the repo holds
 * markdown a person wrote. A coordinate is not that.
 *
 * Every read is defensive. This is the only state in the app that a previous
 * version of the app wrote, so it is the only place where "the shape changed
 * between releases" is a real event rather than a hypothetical, and the answer
 * to junk is always to drop it: a lost arrangement is a shrug, a graph that
 * throws on load is not.
 */
import { readSetting, SETTING_KEYS, writeSetting } from '../../shared/local-storage'
import type { Vec } from './force-layout'

/**
 * Enough to arrange a picture by hand, not enough to fill the quota with
 * coordinates for notes that were deleted years ago. Pins for ids the graph no
 * longer has are dropped on load anyway, but only for the graph that is loaded
 * -- nothing here ever sees a note that stopped existing.
 */
const MAX_PINS = 250

export function readPins(): Map<string, Vec> {
  const raw = readSetting(SETTING_KEYS.graphPins)
  if (raw === null) return new Map()

  try {
    return parsePins(JSON.parse(raw))
  } catch {
    return new Map()
  }
}

export function writePins(pins: ReadonlyMap<string, Vec>): void {
  if (pins.size === 0) {
    writeSetting(SETTING_KEYS.graphPins, null)
    return
  }

  const stored: Record<string, [number, number]> = {}
  // Rounded to whole units: this is a position on a screen, and the extra
  // fifteen digits of a double are pure quota.
  for (const [id, point] of [...pins].slice(0, MAX_PINS)) {
    stored[id] = [Math.round(point.x), Math.round(point.y)]
  }

  writeSetting(SETTING_KEYS.graphPins, JSON.stringify(stored))
}

/**
 * Exported for the test, and taking parsed JSON rather than a string, so the
 * shapes a stale release could have left behind can be handed to it directly.
 */
export function parsePins(value: unknown): Map<string, Vec> {
  const pins = new Map<string, Vec>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return pins

  for (const [id, point] of Object.entries(value)) {
    if (!Array.isArray(point) || point.length !== 2) continue

    const [x, y] = point
    // Finite rather than merely numeric: a NaN reaching the SVG transform
    // blanks the entire graph, and it does it silently.
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    pins.set(id, { x, y })
    if (pins.size >= MAX_PINS) break
  }

  return pins
}
