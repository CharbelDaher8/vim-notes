import { annotationsInput, backlinksInput, outboundLinksInput, spendsInput } from '@vim-notes/core'

import { procedure, router } from '../trpc'

/**
 * Read-only by construction: everything here is derived from the markdown, so
 * there is nothing to mutate. Ticking a todo is a write to the note, which is
 * `notes.write` -- routing it through here would create a second way to change a
 * file and put the index in the business of owning state it must not own.
 */
export const notesIndexRouter = router({
  annotations: procedure
    .input(annotationsInput)
    .query(({ ctx, input }) => ctx.index.annotations(input)),

  spends: procedure.input(spendsInput).query(({ ctx, input }) => ctx.index.spends(input)),

  budgetDeclarations: procedure.query(({ ctx }) => ctx.index.budgetDeclarations()),

  backlinks: procedure
    .input(backlinksInput)
    .query(({ ctx, input }) => ctx.index.backlinks(input.path)),

  outboundLinks: procedure
    .input(outboundLinksInput)
    .query(({ ctx, input }) => ctx.index.outboundLinks(input.path)),

  graph: procedure.query(({ ctx }) => ctx.index.graph()),
})
