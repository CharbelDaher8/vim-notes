import {
  createDirectoryInput,
  FORCE_WRITE,
  moveNoteInput,
  readNoteInput,
  removeNoteInput,
  writeNoteInput,
} from '@vim-notes/core'
import { TRPCError } from '@trpc/server'

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
  write: procedure.input(writeNoteInput).mutation(({ ctx, input }) =>
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
})
