import type { NotePath } from '../domain/note-path'

export interface SearchQuery {
  pattern: string
  /** Treat `pattern` as a regex rather than a literal. */
  regex?: boolean
  caseSensitive?: boolean
  /** Restrict to a subtree. */
  under?: NotePath
  limit?: number
}

export interface SearchHit {
  path: NotePath
  /** 1-indexed, matching what editors display. */
  line: number
  column: number
  /** The matching line, trimmed for display. */
  preview: string
}

export interface Search {
  query(query: SearchQuery): Promise<SearchHit[]>
}
