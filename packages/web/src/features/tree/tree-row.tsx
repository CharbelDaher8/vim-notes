import { ChevronDown, ChevronRight, FileIcon, FolderIcon } from '../../shared/ui/icons'
import type { FlatNode } from './tree-model'

export function TreeRow({
  node,
  index,
  selected,
  open,
  onSelect,
  onActivate,
  onToggle,
  onContextMenu,
  rowRef,
}: {
  node: FlatNode
  index: number
  selected: boolean
  open: boolean
  onSelect: () => void
  onActivate: () => void
  onToggle: () => void
  onContextMenu: (event: React.MouseEvent) => void
  rowRef: (element: HTMLDivElement | null) => void
}) {
  const { entry, depth, expanded, isDirectory } = node

  return (
    <div
      ref={rowRef}
      className="tree__row"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={isDirectory ? expanded : undefined}
      aria-current={open ? 'true' : undefined}
      data-open={open || undefined}
      data-kind={entry.kind}
      // Roving tabindex: one stop for the whole tree, arrows move within it.
      tabIndex={selected ? 0 : -1}
      // 0.65rem per level, plus room for the twisty on files so names line up.
      style={{ paddingInlineStart: `calc(0.4rem + ${depth} * 0.75rem)` }}
      onClick={() => {
        onSelect()
        onActivate()
      }}
      onContextMenu={onContextMenu}
      data-index={index}
    >
      {isDirectory ? (
        <button
          type="button"
          className="tree__twisty"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : (
        <span className="tree__twisty tree__twisty--empty" aria-hidden="true" />
      )}

      <span className="tree__icon" aria-hidden="true">
        {isDirectory ? <FolderIcon open={expanded} size={15} /> : <FileIcon size={15} />}
      </span>

      <span className="tree__name">{entry.name}</span>
    </div>
  )
}
