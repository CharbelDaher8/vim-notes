/**
 * Cmd/Ctrl+K. Type, arrow, Enter, gone.
 *
 * The sidebar already has a search panel, and this is not a replacement for it:
 * the panel is for reading a result set with a pointer, this is for getting to a
 * note without one. That is why it has no regex or case toggles -- reaching for
 * an option in a palette means the palette has already failed at being fast.
 *
 * Built on native `<dialog>` for the focus trap, the inert background, the top
 * layer and Escape. The shared `Dialog` wrapper is not used because its titled
 * header and footer are exactly the chrome a palette should not have.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { FileIcon, SearchIcon } from '../../shared/ui/icons'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { useTree } from '../tree/use-tree'
import { buildPaletteResults, moveSelection, selectedItem, type PaletteItem } from './palette-model'
import { highlightPreview, matchFilenames } from './search-model'
import { useDebounced, useSearch } from './use-search'

import './palette.css'

const LISTBOX_ID = 'palette-listbox'

export function CommandPalette() {
  const open = useWorkspaceStore((state) => state.paletteOpen)

  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * Last real pointer position, so hover cannot steal the keyboard's selection.
   *
   * The palette opens under wherever the cursor happens to be resting, and the
   * browser dispatches a move as the dialog lands beneath it. Acting on that
   * drags the selection off the first result -- so someone who types a filename
   * and presses Enter opens whatever the mouse was sitting over instead. Only a
   * move with an actual change in coordinates counts as the user pointing at
   * something.
   */
  const pointerAt = useRef<{ x: number; y: number } | null>(null)

  const debounced = useDebounced(query)
  const options = { pattern: debounced, regex: false, caseSensitive: false }

  const { data: hits, isFetching, error } = useSearch(options)
  const { data: tree } = useTree()

  const names = useMemo(() => matchFilenames(tree ?? [], debounced), [tree, debounced])
  const results = useMemo(() => buildPaletteResults({ names, hits: hits ?? [] }), [names, hits])

  const active = selectedItem(results.items, selection)

  useEffect(() => {
    const element = dialogRef.current
    if (element === null) return

    if (!open) {
      if (element.open) element.close()

      // Cleared on close rather than on open, for two reasons. A palette that
      // remembers is one you have to clear before you can use it; and this
      // component stays mounted, so a query left in state would keep the search
      // hook enabled and re-run ripgrep on every window focus for results
      // nobody is looking at.
      setQuery('')
      setSelection(null)
      return
    }

    if (!element.open) element.showModal()
    // showModal puts focus on the dialog; the input is what should have it.
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    // `nearest` so paging down scrolls by a row rather than yanking the
    // selection to the middle of the list on every step.
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selection, results.items])

  const close = () => useWorkspaceStore.getState().setPaletteOpen(false)

  const openItem = (item: PaletteItem) => {
    close()

    const workspace = useWorkspaceStore.getState()
    if (item.kind === 'hit') {
      void workspace.openNote(item.path, { line: item.line, column: item.column })
    } else {
      void workspace.openNote(item.path)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+N and Ctrl+P alongside the arrows. The premise of this whole app is
    // that the person using it has vim in their fingers, and on a laptop
    // keyboard those two are considerably closer than the arrow keys.
    const down = event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
    const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')

    if (down || up) {
      event.preventDefault()
      setSelection(moveSelection(results.items, selection, down ? 1 : -1))
      return
    }

    if (event.key === 'Enter' && active !== null) {
      event.preventDefault()
      openItem(active)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label="Search notes"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        // `<dialog>` reports backdrop clicks as clicks on itself.
        if (event.target === dialogRef.current) close()
      }}
    >
      <div className="palette__field">
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          className="palette__input"
          // Not type="search": Escape in a search input clears it in Safari
          // instead of closing the dialog, which puts the two in a fight.
          type="text"
          role="combobox"
          aria-expanded={results.items.length > 0}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={active === null ? undefined : optionId(active)}
          aria-label="Search notes"
          placeholder="Go to a note, or search its contents"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            // New results, so the old selection means nothing. The model falls
            // back to the top anyway; this just makes it explicit.
            setSelection(null)
          }}
          onKeyDown={onKeyDown}
        />
        {isFetching ? <span className="palette__spinner" aria-label="Searching" /> : null}
      </div>

      <div className="palette__results" ref={listRef}>
        {error !== null ? (
          // Distinct from "no matches" on purpose: a missing ripgrep fails
          // identically forever, and an empty list would read as "nothing here".
          <p className="palette__message" role="alert">
            {error.message}
          </p>
        ) : debounced.trim() === '' ? (
          <p className="palette__message">Type to find a note by name, or a phrase inside one.</p>
        ) : results.items.length === 0 ? (
          isFetching ? null : (
            <p className="palette__message">No matches.</p>
          )
        ) : (
          <div id={LISTBOX_ID} role="listbox" aria-label="Results" className="palette__list">
            {results.sections.map((section) => (
              <div key={section.id} className="palette__section" role="presentation">
                <p className="palette__heading" role="presentation">
                  {section.heading}
                </p>

                {section.items.map((item) =>
                  item.kind === 'note'
                    ? renderNote(item)
                    : renderHit(item, debounced, options.caseSensitive),
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="palette__footer">
        <span className="palette__hints">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>move</span>
          <kbd>↵</kbd>
          <span>open</span>
          <kbd>esc</kbd>
          <span>close</span>
        </span>

        {results.totalHits > results.shownHits ? (
          <span className="palette__count">
            first {results.shownHits} of {results.totalHits} matches
          </span>
        ) : null}
      </footer>
    </dialog>
  )

  function renderNote(item: Extract<PaletteItem, { kind: 'note' }>) {
    return (
      <div key={item.key} {...optionProps(item)} className="palette__option palette__option--note">
        <FileIcon size={14} />
        <span className="palette__name">{item.name}</span>
        {item.directory === null ? null : <span className="palette__dir">{item.directory}</span>}
      </div>
    )
  }

  function renderHit(
    item: Extract<PaletteItem, { kind: 'hit' }>,
    pattern: string,
    caseSensitive: boolean,
  ) {
    return (
      <div key={item.key} role="presentation">
        {item.startsGroup ? (
          <p className="palette__path" role="presentation">
            {item.path}
          </p>
        ) : null}

        <div
          {...optionProps(item)}
          className="palette__option"
          // The path above is presentational, so each row has to name its own
          // file for anyone who is hearing this rather than seeing it.
          aria-label={`${item.path}, line ${item.line}: ${item.preview}`}
        >
          <span className="palette__line">{item.line}</span>
          <span className="palette__preview">
            {highlightPreview(item.preview, pattern, { caseSensitive }).map((segment, index) =>
              segment.match ? (
                <mark key={index}>{segment.text}</mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </span>
        </div>
      </div>
    )
  }

  function optionProps(item: PaletteItem) {
    const selected = active?.key === item.key

    return {
      id: optionId(item),
      role: 'option',
      'aria-selected': selected,
      'data-selected': selected || undefined,
      // Pointer *move* rather than enter: scrolling the list under a stationary
      // cursor fires enter, which would drag the selection back to wherever the
      // mouse happens to be resting.
      //
      // The coordinate check is the other half of that. Opening the dialog and
      // scrolling the list both deliver a move event without the user having
      // moved anything, and honouring those hands the selection to the mouse
      // while someone is typing.
      onPointerMove: (event: ReactPointerEvent) => {
        const previous = pointerAt.current
        const moved =
          previous === null || previous.x !== event.clientX || previous.y !== event.clientY
        pointerAt.current = { x: event.clientX, y: event.clientY }

        if (moved && previous !== null && !selected) setSelection(item.key)
      },
      onClick: () => openItem(item),
    } as const
  }
}

function optionId(item: PaletteItem): string {
  return `palette-option-${item.key}`
}
