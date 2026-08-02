import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { RefObject } from 'react'

import type { EditorHandle } from './create-editor'
import { cycleHeading, insertLink, toggleLinePrefix, wrapSelection } from './markup-actions'

type MarkupAction = (state: EditorState) => TransactionSpec

/**
 * Shown only with vim off. With vim on there is a real keyboard and `ciw`, and
 * a row of buttons would be taking height from the buffer for no reason.
 */
const ACTIONS: { label: string; title: string; apply: MarkupAction }[] = [
  { label: 'H', title: 'Heading', apply: cycleHeading },
  { label: 'B', title: 'Bold', apply: (state) => wrapSelection(state, '**') },
  { label: 'I', title: 'Italic', apply: (state) => wrapSelection(state, '*') },
  { label: '`', title: 'Code', apply: (state) => wrapSelection(state, '`') },
  { label: '•', title: 'Bullet list', apply: (state) => toggleLinePrefix(state, '- ') },
  { label: '☐', title: 'Task', apply: (state) => toggleLinePrefix(state, '- [ ] ') },
  { label: '❝', title: 'Quote', apply: (state) => toggleLinePrefix(state, '> ') },
  { label: '↗', title: 'Link', apply: insertLink },
]

export function MarkupBar({ handleRef }: { handleRef: RefObject<EditorHandle | null> }) {
  const run = (apply: MarkupAction) => {
    const handle = handleRef.current
    if (handle === null) return

    handle.view.dispatch(apply(handle.view.state))
    handle.view.focus()
  }

  return (
    <div className="markup-bar" role="toolbar" aria-label="Markdown formatting">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          className="markup-bar__key"
          title={action.title}
          aria-label={action.title}
          // Without this the button steals focus, the keyboard closes, the bar
          // slides down and the tap lands somewhere else entirely.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(action.apply)}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
