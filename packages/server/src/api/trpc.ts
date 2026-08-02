import type { FileWatcher, NoteStore, Search, TerminalHost, VersionControl } from '@vim-notes/core'
import {
  NotFoundError,
  PathEscapeError,
  PathOccupiedError,
  SearchError,
  SearchUnavailableError,
} from '@vim-notes/core'
import { initTRPC, TRPCError } from '@trpc/server'

/**
 * The ports, handed to procedures through tRPC's context.
 *
 * This is the whole of our dependency injection. Procedures depend on the
 * interfaces from core and never import an adapter, which is what lets the API
 * tests run against InMemoryNoteStore with no disk or git involved. Wiring the
 * real implementations happens once, in composition.ts.
 */
export interface AppContext {
  notes: NoteStore
  vcs: VersionControl
  search: Search
  watcher: FileWatcher
  terminals: TerminalHost
}

const t = initTRPC.context<AppContext>().create()

/**
 * Translate the port error taxonomy into status codes.
 *
 * Without this every store failure reaches the client as an opaque 500, and
 * "that note is gone" becomes indistinguishable from "the server is broken" --
 * which the UI has to tell apart to decide between showing a message and
 * retrying.
 *
 * PathEscapeError is deliberately NOT reported accurately. It is unreachable
 * through a genuine NotePath, so hitting it means a forged branded string or a
 * symlink pointing out of the notes tree. The caller learns nothing; the log
 * gets a loud line.
 */
function mapPortError(cause: unknown): TRPCError | null {
  if (cause instanceof NotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause })
  }

  if (cause instanceof PathOccupiedError) {
    return new TRPCError({ code: 'CONFLICT', message: cause.message, cause })
  }

  if (cause instanceof PathEscapeError) {
    console.error('[security] path escape attempt:', cause.message)
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'request refused', cause })
  }

  // A missing ripgrep is a deployment problem, not a failed query, and it will
  // fail identically forever. Reporting it distinctly stops the UI rendering an
  // empty result set that reads as "no matches".
  if (cause instanceof SearchUnavailableError) {
    return new TRPCError({ code: 'NOT_IMPLEMENTED', message: cause.message, cause })
  }

  if (cause instanceof SearchError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: cause.message, cause })
  }

  return null
}

const withMappedErrors = t.middleware(async ({ next }) => {
  const result = await next()

  if (!result.ok) {
    const mapped = mapPortError(result.error.cause ?? result.error)
    if (mapped !== null) throw mapped
  }

  return result
})

export const router = t.router
export const procedure = t.procedure.use(withMappedErrors)
export const createCallerFactory = t.createCallerFactory
