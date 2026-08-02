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
