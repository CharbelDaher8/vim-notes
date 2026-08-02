import { notePathBasename, notePathParent } from '@vim-notes/core'
import { useMemo, useState } from 'react'

import { FileIcon, SearchIcon } from '../../shared/ui/icons'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { useTree } from '../tree/use-tree'
import { groupHits, highlightPreview, matchFilenames } from './search-model'
import { useDebounced, useSearch } from './use-search'

import './search.css'

export function SearchPane() {
  const [pattern, setPattern] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)

  const debounced = useDebounced(pattern)
  const options = { pattern: debounced, regex, caseSensitive }

  const { data: hits, isFetching, error } = useSearch(options)
  const { data: tree } = useTree()

  const groups = useMemo(() => groupHits(hits ?? []), [hits])
  const names = useMemo(() => matchFilenames(tree ?? [], debounced), [tree, debounced])

  return (
    <div className="search">
      <div className="search__form">
        <label className="search__field">
          <SearchIcon size={15} />
          <input
            className="field"
            type="search"
            value={pattern}
            placeholder="Search notes"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Search notes"
            onChange={(event) => setPattern(event.target.value)}
          />
        </label>

        <div className="search__toggles">
          <button
            type="button"
            className="icon-button search__toggle"
            aria-pressed={caseSensitive}
            title="Match case"
            onClick={() => setCaseSensitive((value) => !value)}
          >
            Aa
          </button>
          <button
            type="button"
            className="icon-button search__toggle"
            aria-pressed={regex}
            title="Regular expression"
            onClick={() => setRegex((value) => !value)}
          >
            .*
          </button>
        </div>
      </div>

      <div className="search__results">
        {error !== null ? (
          <p className="search__message" role="alert">
            {error.message}
          </p>
        ) : debounced.trim() === '' ? (
          <p className="search__message">Search the contents of every note.</p>
        ) : (
          <>
            {names.length === 0 ? null : (
              <section className="search__section">
                <h3 className="search__heading">Names</h3>
                {names.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="search__name"
                    onClick={() => void useWorkspaceStore.getState().openNote(path)}
                  >
                    <FileIcon size={14} />
                    <span className="search__name-text">{notePathBasename(path)}</span>
                    <span className="search__name-dir">{notePathParent(path) ?? ''}</span>
                  </button>
                ))}
              </section>
            )}

            <section className="search__section">
              <h3 className="search__heading">
                Contents
                {isFetching ? <span className="search__spinner" aria-label="Searching" /> : null}
              </h3>

              {groups.length === 0 && !isFetching ? (
                <p className="search__message">No matches.</p>
              ) : (
                groups.map((group) => (
                  <div key={group.path} className="search__group">
                    <p className="search__path">{group.path}</p>

                    {group.hits.map((match) => (
                      <button
                        key={`${match.line}:${match.column}`}
                        type="button"
                        className="search__hit"
                        onClick={() =>
                          void useWorkspaceStore
                            .getState()
                            .openNote(match.path, { line: match.line, column: match.column })
                        }
                      >
                        <span className="search__line">{match.line}</span>
                        <span className="search__preview">
                          {highlightPreview(match.preview, debounced, options).map(
                            (segment, index) =>
                              segment.match ? (
                                <mark key={index}>{segment.text}</mark>
                              ) : (
                                <span key={index}>{segment.text}</span>
                              ),
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
