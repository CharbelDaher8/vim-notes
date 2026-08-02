import type { FileWatcher, NoteStore, Search, TerminalHost, VersionControl } from '@vim-notes/core'
import { initTRPC } from '@trpc/server'

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

export const router = t.router
export const procedure = t.procedure
export const createCallerFactory = t.createCallerFactory
