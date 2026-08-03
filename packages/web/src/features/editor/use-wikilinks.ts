/**
 * What a `[[link]]` in the buffer is wired to.
 *
 * Resolution runs against the file tree the client already holds rather than
 * asking the server per link: the decoration builder needs the answer
 * synchronously while painting, and the tree is already kept current by the
 * watcher. See the note at the top of shared/wikilinks.ts about the one real
 * cost of that -- a second implementation of a rule core also states.
 */
import { useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../shared/workspace-store'
import { collectNotePaths, resolveWikiTarget } from '../../shared/wikilinks'
import { useTree } from '../tree/use-tree'
import type { WikiLinkContext } from './wikilink-extension'

export interface WikiLinks {
  /** Null until the tree has loaded; links stay unstyled-as-missing until then. */
  context: WikiLinkContext | null
  /** The target of a followed link that resolved to nothing, if any. */
  creating: string | null
  cancelCreate: () => void
}

export function useWikiLinks(): WikiLinks {
  const { data: tree } = useTree()
  const [creating, setCreating] = useState<string | null>(null)

  const paths = useMemo(() => (tree === undefined ? null : collectNotePaths(tree)), [tree])

  const context = useMemo<WikiLinkContext | null>(() => {
    if (paths === null) return null

    return {
      paths,
      resolve: (target) => resolveWikiTarget(paths, target),
      follow: (link) => {
        // Following a link to a note that does not exist is how a note gets
        // created in a wiki, so it offers rather than refusing. It offers
        // rather than just creating, because a typo would otherwise leave a
        // stray empty note behind every time.
        if (link.resolved === null) setCreating(link.target)
        else void useWorkspaceStore.getState().openNote(link.resolved)
      },
    }
  }, [paths])

  return { context, creating, cancelCreate: () => setCreating(null) }
}
