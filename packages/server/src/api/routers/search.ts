import { searchQueryInput } from '@vim-notes/core'

import { procedure, router } from '../trpc'

export const searchRouter = router({
  query: procedure.input(searchQueryInput).query(({ ctx, input }) =>
    ctx.search.query({
      pattern: input.pattern,
      regex: input.regex,
      caseSensitive: input.caseSensitive,
      limit: input.limit,
      ...(input.under ? { under: input.under } : {}),
    }),
  ),
})
