import { useMemo } from 'react'

import { collapseUnchanged, diffLines, diffStats } from '../../shared/line-diff'

/**
 * Unified rather than side by side. Two columns of monospace text do not fit a
 * phone, and this dialog exists mostly to be read on one -- the desktop has
 * real nvim and a real diff tool.
 */
export function DiffView({ mine, theirs }: { mine: string; theirs: string }) {
  const { chunks, stats } = useMemo(() => {
    const rows = diffLines(mine, theirs)
    return { chunks: collapseUnchanged(rows), stats: diffStats(rows) }
  }, [mine, theirs])

  return (
    <div className="diff">
      <p className="diff__legend">
        <span className="diff__key diff__key--removed">−</span> only in yours
        <span className="diff__key diff__key--added">+</span> only on disk
        <span className="diff__summary">
          {stats.removed} removed, {stats.added} added
        </span>
      </p>

      <div className="diff__body" role="group" aria-label="Line by line comparison">
        {chunks.map((chunk, index) =>
          chunk.kind === 'gap' ? (
            <div key={index} className="diff__gap">
              {chunk.lines} unchanged {chunk.lines === 1 ? 'line' : 'lines'}
            </div>
          ) : (
            <div key={index} className="diff__row" data-kind={chunk.kind}>
              <span className="diff__gutter" aria-hidden="true">
                {chunk.kind === 'added' ? '+' : chunk.kind === 'removed' ? '−' : ' '}
              </span>
              <span className="diff__text">{chunk.text === '' ? ' ' : chunk.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
