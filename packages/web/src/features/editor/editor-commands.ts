import { Facet } from '@codemirror/state'

export interface EditorCommands {
  save: () => void
  close: () => void
}

export const NO_COMMANDS: EditorCommands = { save: () => {}, close: () => {} }

/**
 * Reachable from a vim ex handler, which is handed a CodeMirror 5 shim rather
 * than anything of ours. A facet keeps the callbacks attached to the editor
 * state instead of a module-level variable that a second editor would trample.
 *
 * Its own module so that the vim chunk can import it without pulling
 * `create-editor` -- and therefore all of CodeMirror -- back into itself.
 */
export const editorCommands = Facet.define<EditorCommands, EditorCommands>({
  combine: (values) => values[0] ?? NO_COMMANDS,
})
