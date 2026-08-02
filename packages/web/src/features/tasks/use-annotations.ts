/**
 * The task list, and the write that ticking one performs.
 *
 * Two things here are worth defending:
 *
 * The whole list is fetched unfiltered and filtered in the component. The
 * filters are three chips people flick between while looking at the panel, and
 * a round trip per flick would make them feel broken; the payload is a few
 * hundred short strings. If a vault ever gets big enough for that to hurt, the
 * `AnnotationFilter` the port already takes is where the fix goes.
 *
 * A tick is optimistic. The checkbox has to move under the finger -- on a phone
 * over a tailnet the write is not instant -- but it is rolled back if the write
 * is refused, and a refusal is shown rather than swallowed. The version check
 * (DECISIONS.md §5) is the point of the whole app; a checkbox that quietly
 * clobbered what nvim wrote would be the worst possible place to lose it.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { describeWriteConflict, type AnnotationRecord } from '@vim-notes/core'
import { useEffect } from 'react'

import { usePlatform } from '../../platform'
import { announceLocalWrite } from '../editor/local-writes'
import { describeAnnotationEdit, setAnnotationDone } from './annotation-edit'
import { isSameAnnotation } from './tasks-model'

export const ANNOTATIONS_QUERY_KEY = ['annotations'] as const

export function useAnnotations() {
  const platform = usePlatform()
  const client = useQueryClient()

  // Anything that writes a note can change this list, including this client's
  // own writes -- unlike the editor, an echo of our own tick is the update we
  // are waiting for, not a cursor-jumping nuisance.
  useEffect(
    () =>
      platform.subscribeToChanges(() => {
        void client.invalidateQueries({ queryKey: ANNOTATIONS_QUERY_KEY })
      }),
    [client, platform],
  )

  return useQuery<AnnotationRecord[]>({
    queryKey: ANNOTATIONS_QUERY_KEY,
    queryFn: () => platform.annotations(),
    staleTime: 10_000,
  })
}

export interface ToggleAnnotation {
  record: AnnotationRecord
  done: boolean
}

interface Rollback {
  previous: AnnotationRecord[] | undefined
}

export function useToggleAnnotation(): UseMutationResult<void, Error, ToggleAnnotation, Rollback> {
  const platform = usePlatform()
  const client = useQueryClient()

  return useMutation<void, Error, ToggleAnnotation, Rollback>({
    mutationFn: async ({ record, done }) => {
      // Read first, and rewrite *that* text. The line number in the panel came
      // from an index that may predate nvim's last write, so the file itself
      // has the only trustworthy answer to "which line is this task on".
      const document = await platform.read(record.path)
      if (document === null) throw new Error(`${record.path} no longer exists.`)

      const edit = setAnnotationDone(document.content, record.line, record.text, done)
      if (!edit.ok) throw new Error(describeAnnotationEdit(record.path))

      // The hash we just read is the expected version, so a `:w` landing in
      // the gap between the read and the write is refused rather than lost.
      const outcome = await platform.write(record.path, edit.content, document.hash)
      if (!outcome.ok) throw new Error(describeWriteConflict(outcome.conflict))

      announceLocalWrite(record.path)
    },

    onMutate: async ({ record, done }) => {
      await client.cancelQueries({ queryKey: ANNOTATIONS_QUERY_KEY })
      const previous = client.getQueryData<AnnotationRecord[]>(ANNOTATIONS_QUERY_KEY)

      client.setQueryData<AnnotationRecord[]>(ANNOTATIONS_QUERY_KEY, (current) =>
        current?.map((candidate) =>
          isSameAnnotation(candidate, record) ? { ...candidate, done } : candidate,
        ),
      )

      return { previous }
    },

    onError: (_error, _variables, context) => {
      if (context?.previous === undefined) return
      client.setQueryData(ANNOTATIONS_QUERY_KEY, context.previous)
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: ANNOTATIONS_QUERY_KEY })
    },
  })
}
