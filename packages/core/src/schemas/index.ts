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
import { parseIsoDate, type AnnotationKind } from '../domain/note-markup'
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

/**
 * Kept in step with the domain type by `satisfies` rather than by hope: renaming
 * a kind in note-markup.ts becomes a compile error here instead of an API that
 * silently rejects every value of the renamed kind.
 */
const ANNOTATION_KINDS = ['todo', 'reminder'] as const satisfies readonly AnnotationKind[]

export const annotationKindSchema = z.enum(ANNOTATION_KINDS)

/**
 * A calendar day, `YYYY-MM-DD`.
 *
 * Compared against the whole string rather than merely scanned: `parseIsoDate`
 * finds a date anywhere in its input, which is what a task line needs and the
 * opposite of what a filter needs. It also rejects `2026-02-31`, which matches
 * the pattern and is not a day -- a filter for it would otherwise return
 * nothing forever and look like missing data.
 */
export const isoDaySchema = z
  .string()
  .refine((value) => parseIsoDate(value) === value, 'expected a calendar day as YYYY-MM-DD')

export const annotationsInput = z.object({
  kind: annotationKindSchema.optional(),
  /** Omit for everything; false hides ticked items. See the NoteIndex port. */
  includeDone: z.boolean().optional(),
  day: isoDaySchema.optional(),
  /**
   * Optional, as on the port. Records come back newest day first, so a client
   * asking for a panelful gets the useful end of the list rather than whatever
   * the walk happened to reach first.
   */
  limit: z.number().int().min(1).max(1000).optional(),
})

export const backlinksInput = z.object({
  path: notePathSchema,
})

export const outboundLinksInput = z.object({
  path: notePathSchema,
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
export type AnnotationsInput = z.infer<typeof annotationsInput>
export type BacklinksInput = z.infer<typeof backlinksInput>
export type OutboundLinksInput = z.infer<typeof outboundLinksInput>

/** Convenience for call sites that have a plain string and want a NotePath. */
export function toNotePath(value: string): NotePath {
  return notePathSchema.parse(value)
}

export function toContentHash(value: string): ContentHash {
  return contentHashSchema.parse(value)
}
