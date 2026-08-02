import type { AnnotationKind } from '@vim-notes/core'
import { useMemo, useState } from 'react'

import { Check } from '../../shared/ui/icons'
import { groupAnnotations, annotationKey, todayIso } from './tasks-model'
import { TaskRow } from './task-row'
import { useAnnotations, useToggleAnnotation } from './use-annotations'

import './tasks.css'

const KINDS: { value: AnnotationKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'todo', label: 'Todos' },
  { value: 'reminder', label: 'Reminders' },
]

export function TasksPane() {
  const { data, isPending, error } = useAnnotations()
  const toggle = useToggleAnnotation()

  const [kind, setKind] = useState<AnnotationKind | 'all'>('all')
  const [includeDone, setIncludeDone] = useState(false)

  // Read per render rather than frozen at mount, so a phone left open past
  // midnight does not spend the morning insisting yesterday is today.
  const today = todayIso()

  const groups = useMemo(
    () => groupAnnotations(data ?? [], today, { kind, includeDone }),
    [data, today, kind, includeDone],
  )

  return (
    <div className="tasks">
      <div className="tasks__toolbar">
        <div className="tasks__filters" role="group" aria-label="Filter tasks">
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="tasks__chip"
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="icon-button tasks__toggle"
          aria-pressed={includeDone}
          title="Show completed"
          aria-label="Show completed"
          onClick={() => setIncludeDone((value) => !value)}
        >
          <Check size={15} />
        </button>
      </div>

      {toggle.error === null ? null : (
        <p className="tasks__message tasks__message--error" role="alert">
          {toggle.error.message}
        </p>
      )}

      <div className="tasks__list">
        {error !== null ? (
          <p className="tasks__message" role="alert">
            Could not read the notes. {error.message}
          </p>
        ) : isPending ? (
          <p className="tasks__message">Reading…</p>
        ) : groups.length === 0 ? (
          // Three different nothings, and they mean different things: no tasks
          // anywhere, none left to do, or a filter hiding the ones there are.
          (data ?? []).length === 0 ? (
            <p className="tasks__message">
              Nothing here yet. A line starting <code>TODO</code> or <code>Reminder</code> in any
              note turns up in this panel.
            </p>
          ) : kind !== 'all' ? (
            <p className="tasks__message">Nothing matches this filter.</p>
          ) : (
            <p className="tasks__message">Nothing outstanding.</p>
          )
        ) : (
          groups.map((group) => (
            <section key={group.id} className="tasks__group">
              <h3 className="tasks__heading" data-bucket={group.bucket}>
                {group.label}
                <span className="tasks__count">{group.items.length}</span>
              </h3>

              {group.items.map((record) => (
                <TaskRow
                  key={annotationKey(record)}
                  record={record}
                  today={today}
                  onToggle={(done) => toggle.mutate({ record, done })}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
