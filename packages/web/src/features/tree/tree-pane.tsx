import { notePathParent, type NotePath } from '@vim-notes/core'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { FolderIcon, Pencil, Plus, Trash } from '../../shared/ui/icons'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { TreeActionDialog } from './tree-action-dialog'
import { ancestorsOf, flattenTree, parentForNewEntry, type FlatNode } from './tree-model'
import { TreeRow } from './tree-row'
import { useTreeStore } from './tree-store'
import { useTree, useTreeActions, useTreeSync } from './use-tree'

import './tree.css'

export function TreePane() {
  const { data: tree, isPending, error } = useTree()
  const actions = useTreeActions()
  useTreeSync()

  const expanded = useTreeStore((state) => state.expanded)
  const selected = useTreeStore((state) => state.selected)
  const action = useTreeStore((state) => state.action)
  const openPath = useWorkspaceStore((state) => state.openPath)

  const [actionError, setActionError] = useState<string | null>(null)
  const rows = useMemo(() => flattenTree(tree ?? [], expanded), [tree, expanded])

  const rowElements = useRef(new Map<NotePath, HTMLDivElement>())
  const focusWanted = useRef(false)

  // Reveal whatever is open, including after a search jump into a folder that
  // was never expanded by hand.
  useEffect(() => {
    if (openPath === null) return
    useTreeStore.getState().expand(ancestorsOf(openPath))
  }, [openPath])

  useEffect(() => {
    if (!focusWanted.current || selected === null) return
    focusWanted.current = false
    rowElements.current.get(selected)?.focus()
  }, [selected, rows])

  const select = (path: NotePath | null, focus = false) => {
    focusWanted.current = focus
    useTreeStore.getState().select(path)
  }

  const activate = (node: FlatNode) => {
    if (node.isDirectory) useTreeStore.getState().toggle(node.entry.path)
    else void useWorkspaceStore.getState().openNote(node.entry.path)
  }

  const beginAction = (kind: 'create-file' | 'create-directory' | 'rename' | 'delete') => {
    setActionError(null)
    const store = useTreeStore.getState()
    const node = rows.find((row) => row.entry.path === selected)

    if (kind === 'create-file' || kind === 'create-directory') {
      store.setAction({ kind, parent: parentForNewEntry(tree ?? [], selected) })
      return
    }

    if (node === undefined) return
    store.setAction({ kind, target: node.entry.path, isDirectory: node.isDirectory })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.entry.path === selected)
    const node = index < 0 ? undefined : rows[index]

    const move = (delta: number) => {
      const next = rows[Math.min(Math.max(index + delta, 0), rows.length - 1)]
      if (next !== undefined) select(next.entry.path, true)
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        move(index < 0 ? 0 : 1)
        break

      case 'ArrowUp':
      case 'k':
        move(index < 0 ? 0 : -1)
        break

      case 'ArrowRight':
      case 'l':
        if (node === undefined) break
        if (node.isDirectory && !node.expanded) useTreeStore.getState().toggle(node.entry.path)
        else if (node.isDirectory) move(1)
        break

      case 'ArrowLeft':
      case 'h': {
        if (node === undefined) break
        if (node.isDirectory && node.expanded) {
          useTreeStore.getState().collapse(node.entry.path)
          break
        }
        // Otherwise step out to the containing folder, which is what `h` does
        // in NERDTree and what most people expect from a left arrow in a tree.
        const parent = notePathParent(node.entry.path)
        if (parent !== null) select(parent, true)
        break
      }

      case 'Enter':
      case 'o':
        if (node !== undefined) activate(node)
        break

      case 'Home':
        move(-rows.length)
        break

      case 'End':
        move(rows.length)
        break

      // NERDTree's own bindings, near enough to be muscle memory.
      case 'a':
        beginAction('create-file')
        break

      case 'A':
        beginAction('create-directory')
        break

      case 'r':
        beginAction('rename')
        break

      case 'd':
      case 'Delete':
        beginAction('delete')
        break

      default:
        return
    }

    event.preventDefault()
  }

  return (
    <div className="tree">
      <header className="tree__header">
        <h2 className="tree__title">Notes</h2>

        <div className="tree__tools">
          <button
            type="button"
            className="icon-button"
            title="New note (a)"
            aria-label="New note"
            onClick={() => beginAction('create-file')}
          >
            <Plus />
          </button>
          <button
            type="button"
            className="icon-button"
            title="New folder (A)"
            aria-label="New folder"
            onClick={() => beginAction('create-directory')}
          >
            <FolderIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Rename (r)"
            aria-label="Rename"
            disabled={selected === null}
            onClick={() => beginAction('rename')}
          >
            <Pencil />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Delete (d)"
            aria-label="Delete"
            disabled={selected === null}
            onClick={() => beginAction('delete')}
          >
            <Trash />
          </button>
        </div>
      </header>

      {error !== null ? (
        <p className="tree__message" role="alert">
          Could not read the notes directory. {error.message}
        </p>
      ) : isPending ? (
        <p className="tree__message">Reading…</p>
      ) : rows.length === 0 ? (
        <p className="tree__message">No notes yet. Press the plus to write the first one.</p>
      ) : (
        <div
          className="tree__list"
          role="tree"
          aria-label="Notes"
          tabIndex={selected === null ? 0 : -1}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            if (event.target !== event.currentTarget || selected !== null) return
            const first = rows[0]
            if (first !== undefined) select(first.entry.path, true)
          }}
        >
          {rows.map((node, index) => (
            <TreeRow
              key={node.entry.path}
              node={node}
              index={index}
              selected={selected === node.entry.path}
              open={openPath === node.entry.path}
              onSelect={() => select(node.entry.path)}
              onActivate={() => activate(node)}
              onToggle={() => useTreeStore.getState().toggle(node.entry.path)}
              onContextMenu={(event) => {
                event.preventDefault()
                select(node.entry.path)
              }}
              rowRef={(element) => {
                if (element === null) rowElements.current.delete(node.entry.path)
                else rowElements.current.set(node.entry.path, element)
              }}
            />
          ))}
        </div>
      )}

      {action === null ? null : (
        <TreeActionDialog
          action={action}
          busy={
            actions.createNote.isPending ||
            actions.createDirectory.isPending ||
            actions.rename.isPending ||
            actions.remove.isPending
          }
          error={actionError}
          onCancel={() => {
            setActionError(null)
            useTreeStore.getState().setAction(null)
          }}
          onCreateFile={(path) => {
            void run(actions.createNote.mutateAsync(path), (created) => {
              void useWorkspaceStore.getState().openNote(created)
            })
          }}
          onCreateDirectory={(path) => {
            void run(actions.createDirectory.mutateAsync(path), (created) => {
              useTreeStore.getState().expand([created])
              select(created)
            })
          }}
          onRename={(from, to) => {
            void run(actions.rename.mutateAsync({ from, to }), (renamed) => {
              select(renamed)
              // The open note moved out from under the editor. Re-point it
              // without the guard: the bytes are unchanged, only the path is.
              if (openPath === from) useWorkspaceStore.getState().forceOpen(renamed)
            })
          }}
          onDelete={(path) => {
            void run(actions.remove.mutateAsync(path), () => {
              if (selected === path) select(null)
              if (openPath === path || openPath?.startsWith(`${path}/`) === true) {
                useWorkspaceStore.getState().forceOpen(null)
              }
            })
          }}
        />
      )}
    </div>
  )

  async function run<T>(work: Promise<T>, onDone: (value: T) => void): Promise<void> {
    setActionError(null)

    try {
      onDone(await work)
      useTreeStore.getState().setAction(null)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
}
