/**
 * The markdown characters a phone keyboard hides.
 *
 * `#`, `*`, `[`, `` ` `` and `>` all live behind the symbol layer on iOS and
 * Android, which makes writing markdown on a phone a game of keyboard
 * switching. With vim off there is no `ciw` to lean on either, so a small bar
 * of toggles above the keyboard is the difference between "usable one-handed"
 * and "technically possible".
 *
 * These are transaction specs over `EditorState` rather than commands over
 * `EditorView`, which keeps them pure and testable without a DOM.
 */
import { EditorSelection, type ChangeSpec, type EditorState, type Line } from '@codemirror/state'

/** Wraps each selection, or unwraps it when the markers are already there. */
export function wrapSelection(state: EditorState, before: string, after = before) {
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)

    const outerFrom = range.from - before.length
    const outerTo = range.to + after.length
    const wrappedOutside =
      outerFrom >= 0 &&
      outerTo <= state.doc.length &&
      state.sliceDoc(outerFrom, range.from) === before &&
      state.sliceDoc(range.to, outerTo) === after

    if (wrappedOutside) {
      return {
        changes: [
          { from: outerFrom, to: range.from },
          { from: range.to, to: outerTo },
        ],
        range: EditorSelection.range(outerFrom, outerFrom + selected.length),
      }
    }

    const wrappedInside =
      selected.length >= before.length + after.length &&
      selected.startsWith(before) &&
      selected.endsWith(after)

    if (wrappedInside) {
      return {
        changes: [
          { from: range.from, to: range.from + before.length },
          { from: range.to - after.length, to: range.to },
        ],
        range: EditorSelection.range(range.from, range.to - before.length - after.length),
      }
    }

    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    }
  })
}

/** Adds `prefix` to every selected line, or removes it if every line has it. */
export function toggleLinePrefix(state: EditorState, prefix: string): { changes: ChangeSpec } {
  const lines = selectedLines(state)
  const present = (line: Line) => line.text.trimStart().startsWith(prefix)
  const removing = lines.every(present)
  const changes: ChangeSpec[] = []

  for (const line of lines) {
    const indent = line.text.length - line.text.trimStart().length

    if (removing) changes.push({ from: line.from + indent, to: line.from + indent + prefix.length })
    else if (!present(line)) changes.push({ from: line.from + indent, insert: prefix })
  }

  return { changes }
}

const HEADING = /^(#{1,6})\s+/

/**
 * Cycles none -> H1 -> H2 -> H3 -> none. Stops at three because a toolbar
 * button that needs six taps to get back to plain text is a worse affordance
 * than typing the hashes.
 */
export function cycleHeading(state: EditorState): { changes: ChangeSpec } {
  const changes: ChangeSpec[] = []

  for (const line of selectedLines(state)) {
    const match = HEADING.exec(line.text)
    const level = match === null ? 0 : (match[1] ?? '').length
    const next = level >= 3 ? 0 : level + 1

    changes.push({
      from: line.from,
      to: line.from + (match?.[0].length ?? 0),
      insert: next === 0 ? '' : `${'#'.repeat(next)} `,
    })
  }

  return { changes }
}

/** `[selected](url)` with the cursor parked on `url`, ready to paste. */
export function insertLink(state: EditorState) {
  return state.changeByRange((range) => {
    const label = state.sliceDoc(range.from, range.to)
    const insert = `[${label}](url)`
    const urlStart = range.from + label.length + 3

    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    }
  })
}

function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = []
  const seen = new Set<number>()

  for (const range of state.selection.ranges) {
    let position = range.from

    for (;;) {
      const line = state.doc.lineAt(position)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        lines.push(line)
      }
      if (line.to >= range.to) break
      position = line.to + 1
    }
  }

  return lines.sort((a, b) => a.from - b.from)
}
