/**
 * Wire schemas shared by the server (tRPC input validation) and the web client.
 *
 * Defining these once in core is what makes the API contract impossible to
 * drift: the server validates with the same schema the client builds against,
 * and `notePathSchema` is the single place an untrusted string becomes a
 * NotePath. There is no other legitimate way to mint one from user input.
 */
import { z } from 'zod'

import { asContentHash, type ContentHash } from '../domain/conflict'
import { describeNotePathError, parseNotePath, type NotePath } from '../domain/note-path'

export const notePathSchema = z
  .string()
  .superRefine((value, ctx) => {
    const result = parseNotePath(value)
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: describeNotePathError(result.error) })
    }
  })
  .transform((value) => value as NotePath)

export const contentHashSchema = z
  .string()
  .min(1)
  .transform((value) => asContentHash(value))

/** null means "I am creating this note"; see decideWrite. */
export const expectedVersionSchema = contentHashSchema.nullable()

export const readNoteInput = z.object({
  path: notePathSchema,
})

export const writeNoteInput = z.object({
  path: notePathSchema,
  content: z.string(),
  expected: expectedVersionSchema,
  /** Deliberate clobber, e.g. "keep mine" after a conflict prompt. */
  force: z.boolean().optional().default(false),
})

export const moveNoteInput = z.object({
  from: notePathSchema,
  to: notePathSchema,
})

export const removeNoteInput = z.object({
  path: notePathSchema,
})

export const createDirectoryInput = z.object({
  path: notePathSchema,
})

export const searchQueryInput = z.object({
  pattern: z.string().min(1).max(512),
  regex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  under: notePathSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
})

export const historyInput = z.object({
  path: notePathSchema.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
})

export const restoreInput = z.object({
  path: notePathSchema,
  sha: z.string().min(7).max(64),
})

export const spawnTerminalInput = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
})

export type ReadNoteInput = z.infer<typeof readNoteInput>
export type WriteNoteInput = z.infer<typeof writeNoteInput>
export type MoveNoteInput = z.infer<typeof moveNoteInput>
export type RemoveNoteInput = z.infer<typeof removeNoteInput>
export type CreateDirectoryInput = z.infer<typeof createDirectoryInput>
export type SearchQueryInput = z.infer<typeof searchQueryInput>
export type HistoryInput = z.infer<typeof historyInput>
export type RestoreInput = z.infer<typeof restoreInput>
export type SpawnTerminalInput = z.infer<typeof spawnTerminalInput>

/** Convenience for call sites that have a plain string and want a NotePath. */
export function toNotePath(value: string): NotePath {
  return notePathSchema.parse(value)
}

export function toContentHash(value: string): ContentHash {
  return contentHashSchema.parse(value)
}
