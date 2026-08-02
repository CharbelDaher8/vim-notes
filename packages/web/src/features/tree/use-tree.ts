import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { describeWriteConflict, type NotePath, type TreeEntry } from '@vim-notes/core'
import { useEffect } from 'react'

import { usePlatform } from '../../platform'
import { affectsTree } from '../editor/conflict-model'

export const TREE_QUERY_KEY = ['tree'] as const

export function useTree() {
  const platform = usePlatform()

  return useQuery<TreeEntry[]>({
    queryKey: TREE_QUERY_KEY,
    queryFn: () => platform.tree(),
    // The watcher pushes changes, so polling would only add load. This is the
    // backstop for a dropped subscription.
    staleTime: 30_000,
  })
}

/** Keeps the tree honest when nvim or a git pull adds or removes a file. */
export function useTreeSync(): void {
  const platform = usePlatform()
  const client = useQueryClient()

  useEffect(
    () =>
      platform.subscribeToChanges((event) => {
        // Unlike the editor, the tree cares about its own writes too: creating
        // a note has to make it appear. Only pure content edits are ignorable.
        if (!affectsTree(event)) return
        void client.invalidateQueries({ queryKey: TREE_QUERY_KEY })
      }),
    [client, platform],
  )
}

export interface TreeActions {
  createNote: UseMutationResult<NotePath, Error, NotePath>
  createDirectory: UseMutationResult<NotePath, Error, NotePath>
  rename: UseMutationResult<NotePath, Error, { from: NotePath; to: NotePath }>
  remove: UseMutationResult<void, Error, NotePath>
}

export function useTreeActions(): TreeActions {
  const platform = usePlatform()
  const client = useQueryClient()
  const invalidate = () => void client.invalidateQueries({ queryKey: TREE_QUERY_KEY })

  const createNote = useMutation<NotePath, Error, NotePath>({
    mutationFn: async (path) => {
      // `expected: null` is the claim "nothing is here". If a note already
      // exists the store refuses rather than truncating it -- the same rule
      // that protects a save, doing useful work at creation time.
      const outcome = await platform.write(path, '', null)
      if (!outcome.ok) throw new Error(describeWriteConflict(outcome.conflict))
      return path
    },
    onSuccess: invalidate,
  })

  const createDirectory = useMutation<NotePath, Error, NotePath>({
    mutationFn: async (path) => {
      await platform.createDirectory(path)
      return path
    },
    onSuccess: invalidate,
  })

  const rename = useMutation<NotePath, Error, { from: NotePath; to: NotePath }>({
    mutationFn: async ({ from, to }) => {
      await platform.move(from, to)
      return to
    },
    onSuccess: invalidate,
  })

  const remove = useMutation<void, Error, NotePath>({
    mutationFn: (path) => platform.remove(path),
    onSuccess: invalidate,
  })

  return { createNote, createDirectory, rename, remove }
}
