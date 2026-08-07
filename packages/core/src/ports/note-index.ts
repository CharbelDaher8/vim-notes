import type { BudgetDeclaration, SpendEntry } from '../domain/budget'
import type { Annotation, AnnotationKind } from '../domain/note-markup'
import type { NotePath } from '../domain/note-path'

/**
 * The derived view of the notes: tasks, reminders, links and the graph they
 * form.
 *
 * Everything here is recomputed from markdown and owns no state a user could
 * lose. Deleting the index and rebuilding it must be a no-op, which is what
 * lets a TODO typed in nvim in the pty appear in the panel without nvim
 * knowing this app exists.
 */

export interface AnnotationRecord extends Annotation {
  path: NotePath
  /**
   * The day this annotation belongs to, from the note's filename.
   *
   * Null for a note that is not a daily. A TODO in `projects/roadmap.md` is
   * still a task; it just has no day to hang off in the graph.
   */
  day: string | null
}

export interface SpendRecord extends SpendEntry {
  path: NotePath
  /** The journal day of the note it was found in, or null. */
  day: string | null
  /**
   * The date this spend actually counts on: the date written on the line if
   * there is one, otherwise the note's journal day, otherwise null.
   *
   * Resolved here rather than left to each caller because every caller needs
   * the same answer, and two of them working it out separately is two chances
   * to disagree about which date wins. Null is a real state -- a spend in
   * `projects/kitchen.md` with no date is money that left the account on a day
   * nobody recorded. It still counts toward a balance; it just cannot be put in
   * a month.
   */
  on: string | null
}

export interface BudgetDeclarationRecord extends BudgetDeclaration {
  path: NotePath
}

/**
 * All bounds are on `on`, and undated spends are only included when no bound is
 * given at all.
 *
 * That asymmetry is the honest reading of a range query: asking for August
 * cannot sensibly return money that belongs to no month, but asking for
 * everything must not silently lose it.
 */
export interface SpendFilter {
  /** Inclusive ISO lower bound. */
  since?: string
  /** Inclusive ISO upper bound. */
  until?: string
  category?: string
  limit?: number
}

export interface ResolvedLink {
  from: NotePath
  /** Null when the target names a note that does not exist, or is ambiguous. */
  to: NotePath | null
  /** Exactly as written between the brackets. */
  target: string
  label: string
  line: number
}

export type GraphNodeKind = 'note' | 'day' | 'todo' | 'reminder'

export interface GraphNode {
  /** Stable across rebuilds so the layout does not jump when a note changes. */
  id: string
  kind: GraphNodeKind
  label: string
  /** The note this node is, or the note an annotation was found in. */
  path: NotePath | null
  /**
   * Where an annotation node sits in its note, so clicking it in the graph can
   * open the note at the right line. Null for notes and days, which have no
   * single line to point at.
   *
   * Carried as its own field rather than being packed into `id` on purpose.
   * Ids are content-derived so that inserting a line above a TODO does not
   * change its identity and make the graph layout jump -- putting the line
   * number in the id would trade exactly the property the id exists for. It
   * cannot be recovered by matching on text either: the same task can appear
   * twice in one note, and then there is nothing to tell the two apart.
   */
  line: number | null
  /** Set for day nodes and for annotations that belong to one. */
  day: string | null
  done: boolean | null
}

export type GraphEdgeKind =
  /** A wikilink from one note to another. */
  | 'link'
  /** A note contains this annotation. */
  | 'contains'
  /** An annotation or note belongs to a day. */
  | 'day'
  /** A wikilink whose target does not resolve; kept so it is visibly missing. */
  | 'unresolved'

export interface GraphEdge {
  from: string
  to: string
  kind: GraphEdgeKind
}

export interface NoteGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface AnnotationFilter {
  kind?: AnnotationKind
  /** Omit to get everything; false hides ticked items. */
  includeDone?: boolean
  /** Restrict to annotations belonging to a single day. */
  day?: string
  limit?: number
}

export interface NoteIndex {
  annotations(filter?: AnnotationFilter): Promise<AnnotationRecord[]>

  /** Logged expenses, most recent first. */
  spends(filter?: SpendFilter): Promise<SpendRecord[]>

  /**
   * Every `Balance:` and `Income:` line in the notes, in document order.
   *
   * All of them, not the ones that win. Deciding which balance is current is a
   * fold over these and belongs with the rest of the arithmetic -- an index
   * that pre-decided would have to be asked again with different rules the
   * first time anyone wants the figure as of last month.
   */
  budgetDeclarations(): Promise<BudgetDeclarationRecord[]>

  /** Links pointing *at* this note, which is the useful direction. */
  backlinks(path: NotePath): Promise<ResolvedLink[]>

  outboundLinks(path: NotePath): Promise<ResolvedLink[]>

  graph(): Promise<NoteGraph>

  /**
   * Resolve a wikilink target to a note.
   *
   * Order matters and is deliberately conservative: an exact path wins, then a
   * unique basename match, and an ambiguous name resolves to nothing rather
   * than guessing. Picking one of two `roadmap.md` files would send someone to
   * the wrong note and look like a bug in their own filing.
   */
  resolve(target: string): Promise<NotePath | null>

  /** Rebuild from scratch. Cheap enough to be the recovery path for anything. */
  rebuild(): Promise<void>
}
