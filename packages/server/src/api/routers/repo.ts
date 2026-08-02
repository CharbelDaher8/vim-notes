import { historyInput, restoreInput } from '@vim-notes/core'
import { TRPCError } from '@trpc/server'

import { procedure, router } from '../trpc'

/**
 * Git, surfaced to the UI.
 *
 * `status` exists because this app is not the only writer to the repository --
 * a laptop clone pushes to the same hub. Divergence that is invisible is
 * divergence you discover three days later, so the client shows ahead/behind
 * and conflict state rather than pretending the working copy is always clean.
 */
export const repoRouter = router({
  status: procedure.query(({ ctx }) => ctx.vcs.status()),

  history: procedure
    .input(historyInput)
    .query(({ ctx, input }) =>
      ctx.vcs.log({ ...(input.path ? { path: input.path } : {}), limit: input.limit }),
    ),

  /** Returns the historical content without writing it; restoring is a write. */
  contentAt: procedure.input(restoreInput).query(async ({ ctx, input }) => {
    try {
      return { content: await ctx.vcs.restore(input.path, { sha: input.sha }) }
    } catch {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'no such revision for that path' })
    }
  }),

  sync: procedure.mutation(({ ctx }) => ctx.vcs.sync()),
})
