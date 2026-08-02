import { notesRouter } from './routers/notes'
import { repoRouter } from './routers/repo'
import { searchRouter } from './routers/search'
import { router } from './trpc'

export const appRouter = router({
  notes: notesRouter,
  repo: repoRouter,
  search: searchRouter,
})

/**
 * The web client imports this type to get a fully typed client with no codegen
 * step. It is the reason both sides are TypeScript.
 */
export type AppRouter = typeof appRouter
