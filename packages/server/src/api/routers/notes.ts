import {
  createDirectoryInput,
  FORCE_WRITE,
  moveNoteInput,
  readNoteInput,
  removeNoteInput,
  writeNoteInput,
  type FileChangeEvent,
} from '@vim-notes/core'
import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'

import { procedure, router } from '../trpc'

export const notesRouter = router({
  tree: procedure.query(({ ctx }) => ctx.notes.tree()),

  read: procedure.input(readNoteInput).query(({ ctx, input }) => ctx.notes.read(input.path)),

  /**
   * Note that a write conflict is returned as data, not thrown.
   *
   * With nvim in a pty and the web client both writing the same directory,
   * losing a race is a normal outcome rather than an exceptional one, and the
   * client has to render a real choice for it. Throwing would collapse
   * "someone else edited this" into the same channel as "the disk is full",
   * and the UI could not tell them apart.
   */
  write: procedure
    .input(writeNoteInput)
    .mutation(({ ctx, input }) =>
      ctx.notes.write(input.path, input.content, input.force ? FORCE_WRITE : input.expected),
    ),

  move: procedure.input(moveNoteInput).mutation(async ({ ctx, input }) => {
    if (input.from === input.to) return { moved: false }

    // Moving a directory onto its own descendant would detach the subtree.
    if (input.to.startsWith(`${input.from}/`)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cannot move a directory into itself',
      })
    }

    await ctx.notes.move(input.from, input.to)
    return { moved: true }
  }),

  remove: procedure.input(removeNoteInput).mutation(async ({ ctx, input }) => {
    await ctx.notes.remove(input.path)
    return { removed: true }
  }),

  createDirectory: procedure.input(createDirectoryInput).mutation(async ({ ctx, input }) => {
    await ctx.notes.createDirectory(input.path)
    return { created: true }
  }),

  /**
   * The watcher, over the wire. This is what makes DECISIONS.md §3 true rather
   * than aspirational: nvim saves a note in the pty, and the phone holding that
   * note open finds out. Without it the web client is looking at a photograph.
   *
   * The event crosses **unchanged**, `origin` included, and that field is the
   * reason there is no filtering here. The obvious optimisation -- drop `api`
   * events, since the client that wrote the file already knows -- is wrong: a
   * second browser tab is also `api`, and to that tab the change is news. The
   * client decides; see `decideReconcile` on the web side.
   *
   * An observable rather than an async generator because the source is a
   * subscribe/unsubscribe callback and this is the shape that maps onto it with
   * no queue in between. The cost is that this stream is not resumable: tRPC's
   * `tracked()` needs event ids to replay from, and the watcher keeps no log to
   * replay out of. What that means for a dropped connection is written down at
   * the client end, in `WebPlatform.subscribeToChanges`, which is where the
   * reconnect actually happens.
   */
  changes: procedure.subscription(({ ctx }) =>
    observable<FileChangeEvent>((emit) => ctx.watcher.subscribe((event) => emit.next(event))),
  ),
})
