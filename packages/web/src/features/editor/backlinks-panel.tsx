import type { NotePath } from '@vim-notes/core'
import { useState } from 'react'

import { readSetting, SETTING_KEYS, writeSetting } from '../../shared/local-storage'
import { ChevronDown, ChevronRight, LinkIcon } from '../../shared/ui/icons'
import { useWorkspaceStore } from '../../shared/workspace-store'
import { useBacklinks } from './use-backlinks'

/**
 * Who links here.
 *
 * Collapsed by default and absent entirely when there is nothing to say. Every
 * row of chrome under the editor is a row of note you cannot see -- the same
 * reason the status line hides when the keyboard is up -- and the header alone
 * already carries the useful headline, which is the count.
 */
export function BacklinksPanel({ path }: { path: NotePath }) {
  const { data } = useBacklinks(path)
  const [open, setOpen] = useState(() => readSetting(SETTING_KEYS.backlinks) === 'open')

  const links = data ?? []
  if (links.length === 0) return null

  const toggle = () => {
    setOpen((value) => {
      writeSetting(SETTING_KEYS.backlinks, value ? 'closed' : 'open')
      return !value
    })
  }

  return (
    <section className="backlinks" aria-label="Notes linking here">
      <button type="button" className="backlinks__header" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <LinkIcon size={13} />
        <span className="backlinks__title">Linked from</span>
        <span className="backlinks__count">{links.length}</span>
      </button>

      {!open ? null : (
        <ul className="backlinks__list">
          {links.map((link) => (
            <li key={`${link.from}:${link.line}`}>
              <button
                type="button"
                className="backlinks__link"
                onClick={() =>
                  void useWorkspaceStore.getState().openNote(link.from, { line: link.line })
                }
              >
                <span className="backlinks__from">{link.from}</span>
                <span className="backlinks__line">{link.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
