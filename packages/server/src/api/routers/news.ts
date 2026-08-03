/**
 * The news feed, and the one operation that makes it worth wiring in at all.
 *
 * Reading a feed in a notes app is a convenience. Turning an item into a note
 * -- a real markdown file, in the day it belongs to, searchable, linkable, in
 * the graph -- is the reason the two applications are worth joining.
 *
 * The direction of that is deliberate and one-way. Notes are the source of
 * truth (DECISIONS §1); the feed is a cache of somebody else's website that
 * happens to be ranked well. So `save` copies *out* of the feed and into the
 * notes, in plain markdown, and nothing ever reads it back. Delete the news
 * container tomorrow and every saved item is still exactly where you put it.
 */
import {
  assertNotePath,
  journalPathFor,
  parseNotePath,
  type NewsItem,
  type NotePath,
  type TreeEntry,
} from '@vim-notes/core'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import type { AppContext } from '../trpc'
import { procedure, router } from '../trpc'

const categories = z.enum(['ai', 'security', 'tech', 'repos'])

const listInput = z
  .object({
    category: categories.optional(),
    unreadOnly: z.boolean().optional(),
    savedOnly: z.boolean().optional(),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional()

export const newsRouter = router({
  /**
   * Asked on every page load, and answers even when nothing is deployed. See
   * the note on optionality in http-news-feed.ts.
   */
  status: procedure.query(({ ctx }) => ctx.news.status()),

  list: procedure.input(listInput).query(({ ctx, input }) => ctx.news.list(input ?? {})),

  setRead: procedure
    .input(z.object({ id: z.string().min(1), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.news.setRead(input.id, input.read)
      return { ok: true as const }
    }),

  toggleSaved: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => ({ saved: await ctx.news.toggleSaved(input.id) })),

  /**
   * Append an item to a note, creating the note if it is not there yet.
   *
   * `date` comes from the client because the server's idea of today is UTC on a
   * box in whichever region was cheapest, and the day a person is having is not
   * that. `path` is optional and overrides the inferred journal.
   */
  save: procedure
    .input(
      z.object({
        id: z.string().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        path: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Fetched from the feed rather than taken from the client: the client
      // would be sending back a title and a URL it was given, and trusting
      // those means anything that can call this can write arbitrary markdown
      // into a note through a field that looks like a lookup key.
      const items = await ctx.news.list({ limit: 500 })
      const item = items.find((candidate) => candidate.id === input.id)

      if (item === undefined) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'that item is no longer in the feed',
        })
      }

      const target = await resolveTarget(ctx.notes.tree(), input)
      const created = await appendBlock(ctx.notes, target, renderItem(item), input.date)

      // Marking it read here rather than making the client do it: saving
      // something is the strongest possible signal that you have read it, and
      // leaving it unread means it comes back tomorrow.
      await ctx.news.setRead(item.id, true).catch(() => {
        // Not fatal. The note is written, which is the part that matters, and
        // a failure here means the feed is down -- in which case nothing is
        // coming back tomorrow anyway.
      })

      return { path: target, created }
    }),
})

/**
 * Append to a note, or create it, against whatever is on disk right now.
 *
 * Retried rather than reported, and that is a property of *appending* rather
 * than a general policy: the operation is "add this block at the end", which is
 * still the right thing to do against content that changed underneath us. The
 * usual cause is nvim writing the same day note in the terminal a second
 * earlier -- DECISIONS §5 exists because two writers is the normal case here.
 *
 * Bounded at three attempts. A conflict that survives three reads is not a race
 * any more, and a loop that keeps trying is how a save turns into a hang.
 */
async function appendBlock(
  notes: AppContext['notes'],
  target: NotePath,
  block: string,
  date: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await notes.read(target)

    const content =
      existing === null
        ? `# ${date}\n\n${block}\n`
        : `${existing.content.replace(/\s*$/, '')}\n\n${block}\n`

    // `null` as the expectation means "this must not exist yet", which is what
    // makes two saves racing to create the same day note resolve into one file
    // with both items rather than one overwriting the other.
    const outcome = await notes.write(target, content, existing === null ? null : existing.hash)

    if (outcome.ok) return existing === null
  }

  throw new TRPCError({
    code: 'CONFLICT',
    message: `${target} kept changing while saving; try again`,
  })
}

async function resolveTarget(
  tree: Promise<TreeEntry[]>,
  input: { date: string; path?: string },
): Promise<NotePath> {
  if (input.path !== undefined) {
    const parsed = parseNotePath(input.path)
    if (!parsed.ok) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'that is not a note path' })
    }
    return parsed.value
  }

  const inferred = journalPathFor(input.date, flatten(await tree))
  // Built from a validated date and paths that were already NotePaths, so this
  // cannot fail -- but `assertNotePath` is what says so out loud rather than a
  // cast that would quietly survive a change to either.
  return assertNotePath(inferred)
}

function flatten(entries: readonly TreeEntry[]): NotePath[] {
  const paths: NotePath[] = []

  const walk = (list: readonly TreeEntry[]) => {
    for (const entry of list) {
      if (entry.kind === 'directory') walk(entry.children)
      else paths.push(entry.path)
    }
  }

  walk(entries)
  return paths
}

/**
 * One item as markdown.
 *
 * A bullet with the link, then the summary as a quote. Not a table and not
 * frontmatter: this has to read well in nvim, in the browser editor, and in
 * `git diff`, and it has to survive being edited by hand afterwards -- which is
 * the whole point of it being a note rather than a row somewhere.
 *
 * The `[[wikilink]]`-shaped thing is deliberately absent. A link to a page on
 * the internet is a URL; making it look like a note reference would put a node
 * in the graph for something that is not a note and can never be opened.
 */
function renderItem(item: NewsItem): string {
  const lines = [`- [${item.title}](${item.url}) — ${item.source}`]

  const facts = [
    item.score === null ? null : `score ${item.score}`,
    item.signalLabel === '' ? null : item.signalLabel,
    item.category,
  ].filter((fact): fact is string => fact !== null)

  lines.push(`  ${facts.join(' · ')}`)

  if (item.summary !== null && item.summary.trim() !== '') {
    // Indented under the bullet so it stays part of it in every markdown
    // renderer, and prefixed so it reads as quotation rather than as your own
    // note about the thing.
    lines.push(`  > ${item.summary.trim().replace(/\n+/g, ' ')}`)
  }

  return lines.join('\n')
}
