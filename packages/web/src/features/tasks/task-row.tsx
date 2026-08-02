import { notePathBasename, type AnnotationRecord } from '@vim-notes/core'

import { Bell, Check } from '../../shared/ui/icons'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { dueChip } from './tasks-model'

/**
 * Two buttons side by side rather than one button inside another, which is
 * invalid HTML and unreachable by keyboard: the box ticks, the rest opens the
 * note at the line the task is written on.
 */
export function TaskRow({
  record,
  today,
  onToggle,
}: {
  record: AnnotationRecord
  today: string
  onToggle: (done: boolean) => void
}) {
  // `done: null` means the line has no checkbox at all. Drawn as unticked --
  // for a list of things to do, "never asked" and "not done" look the same.
  // Ticking it is what differs, and that is annotation-edit.ts's problem.
  const done = record.done === true
  const chip = dueChip(record, today)

  return (
    <div className="task" data-done={done || undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        className="task__check"
        onClick={() => onToggle(!done)}
      >
        <span className="task__box">{done ? <Check size={12} /> : null}</span>
        <span className="visually-hidden">{record.text}</span>
      </button>

      <button
        type="button"
        className="task__open"
        onClick={() =>
          void useWorkspaceStore.getState().openNote(record.path, { line: record.line })
        }
      >
        <span className="task__text">
          {record.kind === 'reminder' ? <Bell size={12} className="task__kind" /> : null}
          {record.text}
        </span>

        <span className="task__meta">
          <span className="task__note">{notePathBasename(record.path)}</span>
          {chip === null ? null : (
            <span className="task__due" data-bucket={chip.bucket} title={chip.description}>
              <span className="visually-hidden">{chip.description}</span>
              <span aria-hidden="true">{chip.text}</span>
            </span>
          )}
        </span>
      </button>
    </div>
  )
}
