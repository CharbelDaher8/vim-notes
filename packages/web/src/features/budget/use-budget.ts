/**
 * The budget's two queries, and the write that logging a spend performs.
 *
 * Both queries are unfiltered, for the reason `use-annotations.ts` gives: the
 * range and category controls are things people flick between while looking at
 * the panel, and a round trip per flick feels broken. Everything narrower is a
 * `useMemo` over the same array.
 *
 * They are separate queries rather than one because they invalidate together
 * but are wanted apart -- a derived chart block needs the spends and has no use
 * for the declarations, and react-query will dedupe the shared one across every
 * caller on the page.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import {
  assertNotePath,
  describeWriteConflict,
  journalPathFor,
  type BudgetDeclarationRecord,
  type NotePath,
  type SpendRecord,
  type TreeEntry,
} from '@vim-notes/core'
import { useEffect } from 'react'

import { usePlatform } from '../../platform'
import { announceLocalWrite } from '../editor/local-writes'
import { appendSpendLine, type SpendDraft } from './spend-capture'

export const SPENDS_QUERY_KEY = ['spends'] as const
export const BUDGET_DECLARATIONS_QUERY_KEY = ['budget-declarations'] as const

/**
 * Invalidates both budget queries whenever any note changes.
 *
 * Every note is a potential budget note -- that is the point of §12 -- so there
 * is nothing to filter on. Called by both hooks below; react-query makes the
 * duplicate subscription free, and the alternative is a provider that exists to
 * hold one `useEffect`.
 */
function useBudgetInvalidation(): void {
  const platform = usePlatform()
  const client = useQueryClient()

  useEffect(
    () =>
      platform.subscribeToChanges(() => {
        void client.invalidateQueries({ queryKey: SPENDS_QUERY_KEY })
        void client.invalidateQueries({ queryKey: BUDGET_DECLARATIONS_QUERY_KEY })
      }),
    [client, platform],
  )
}

/**
 * `enabled` exists for the chart provider, which must not fetch until a note
 * containing a derived block is actually open. The pane never passes it.
 */
export interface BudgetQueryOptions {
  enabled?: boolean
}

export function useSpends(options: BudgetQueryOptions = {}) {
  const platform = usePlatform()
  useBudgetInvalidation()

  return useQuery<SpendRecord[]>({
    queryKey: SPENDS_QUERY_KEY,
    queryFn: () => platform.spends(),
    staleTime: 10_000,
    enabled: options.enabled ?? true,
  })
}

export function useBudgetDeclarations(options: BudgetQueryOptions = {}) {
  const platform = usePlatform()
  useBudgetInvalidation()

  return useQuery<BudgetDeclarationRecord[]>({
    queryKey: BUDGET_DECLARATIONS_QUERY_KEY,
    queryFn: () => platform.budgetDeclarations(),
    staleTime: 10_000,
    enabled: options.enabled ?? true,
  })
}

export interface LoggedSpend {
  path: NotePath
  created: boolean
}

/**
 * Logging a spend from anywhere: a write to today's journal.
 *
 * There is nowhere else to put it. A spend is a line of markdown (§12), so
 * "record this" means "append this line to a file", and the file that means
 * *today* is the daily. `journalPathFor` picks the name, matching whatever
 * convention the existing journal already uses rather than imposing one.
 *
 * Not optimistic, unlike ticking a todo. A checkbox has to move under the
 * finger because the user is looking straight at it; a capture command closes
 * the moment it is submitted, and inventing a `SpendRecord` with a guessed
 * line number to show for a few hundred milliseconds would mean maintaining a
 * fake alongside the real parse. The invalidation below is fast enough.
 */
export function useLogSpend(): UseMutationResult<LoggedSpend, Error, SpendDraft> {
  const platform = usePlatform()
  const client = useQueryClient()

  return useMutation<LoggedSpend, Error, SpendDraft>({
    mutationFn: async (draft) => {
      const tree = await platform.tree()
      const path = assertNotePath(journalPathFor(draft.date, collectPaths(tree)))

      const document = await platform.read(path)
      const content = appendSpendLine(document?.content ?? null, draft)

      // A missing note writes against a null version, which is how this store
      // spells "I expect this not to exist" -- so two devices capturing at the
      // same moment on a day with no journal yet is a refused write rather than
      // one silently overwriting the other.
      const outcome = await platform.write(path, content, document?.hash ?? null)
      if (!outcome.ok) throw new Error(describeWriteConflict(outcome.conflict))

      announceLocalWrite(path)

      return { path, created: document === null }
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: SPENDS_QUERY_KEY })
      void client.invalidateQueries({ queryKey: BUDGET_DECLARATIONS_QUERY_KEY })
    },
  })
}

/**
 * Flattens the tree, which `journalPathFor` needs to see so a new daily lands
 * beside the existing ones rather than starting a second parallel journal.
 */
export function collectPaths(entries: readonly TreeEntry[]): NotePath[] {
  const paths: NotePath[] = []

  const walk = (nodes: readonly TreeEntry[]) => {
    for (const node of nodes) {
      paths.push(node.path)
      if (node.kind === 'directory') walk(node.children)
    }
  }

  walk(entries)

  return paths
}
