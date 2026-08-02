/**
 * NoteStore backed by a Map. Not a mock: this is what the API layer's tests run
 * against, so its observable behaviour has to match FsNoteStore exactly -- same
 * conflicts, same errors, same tree ordering, same leftovers. Both are held to
 * one shared suite in `note-store-contract.ts`, which is the only thing keeping
 * the two honest as they change.
 *
 * Directories are tracked explicitly rather than derived from the file paths
 * beneath them, because a filesystem tracks them explicitly: deleting the last
 * note in a folder leaves the folder there. Deriving them would quietly make it
 * vanish, and the file tree UI would then behave differently in tests than in
 * production.
 *
 * Containment is not re-checked here, unlike in FsNoteStore. There is nothing
 * to escape from -- a Map key that traverses is just a key that is never found
 * -- and NotePath has already rejected the input either way.
 */
import {
  assertNotePath,
  decideWriteOrForce,
  FORCE_WRITE,
  notePathContains,
  notePathParent,
  type ExpectedVersion,
  type ForceWrite,
  type NoteDocument,
  type NoteMetadata,
  type NotePath,
  type NoteStore,
  type TreeEntry,
  type WriteOutcome,
} from '@vim-notes/core'

import { hashContent } from './content-hash'
import {
  compareTreeEntries,
  NotFoundError,
  NoteStoreError,
  PathOccupiedError,
} from './note-store-common'

interface MemoryFile {
  content: string
  modifiedAt: number
}

export interface InMemoryNoteStoreOptions {
  /** Injectable so tests can assert on modifiedAt without sleeping. */
  now?: () => number
}

export class InMemoryNoteStore implements NoteStore {
  private readonly files = new Map<NotePath, MemoryFile>()
  private readonly directories = new Set<NotePath>()
  private readonly now: () => number

  constructor(options: InMemoryNoteStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async tree(): Promise<TreeEntry[]> {
    return this.buildTree(null)
  }

  async read(path: NotePath): Promise<NoteDocument | null> {
    const file = this.files.get(path)
    if (file === undefined) return null

    return { ...metadataOf(path, file), content: file.content }
  }

  async stat(path: NotePath): Promise<NoteMetadata | null> {
    const file = this.files.get(path)
    return file === undefined ? null : metadataOf(path, file)
  }

  async write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome> {
    if (this.directories.has(path)) throw new PathOccupiedError(`${path} is a directory`)
    this.assertNoFileAncestor(path)

    // Before the conflict check, matching FsNoteStore -- which has to create
    // them before it can write its temporary file. Both stores therefore leave
    // an empty directory behind if the write is then refused, which is worth
    // being identical about even though it is a wart in both.
    this.addAncestorDirectories(path)

    const existing = this.files.get(path)
    const actual = existing === undefined ? null : metadataOf(path, existing)

    const decision = decideWriteOrForce(expected, actual?.hash ?? null)
    if (!decision.ok) return { ok: false, conflict: decision.conflict, actual }

    const file: MemoryFile = { content, modifiedAt: this.now() }
    this.files.set(path, file)

    return { ok: true, metadata: metadataOf(path, file) }
  }

  async move(from: NotePath, to: NotePath): Promise<void> {
    const file = this.files.get(from)
    const isDirectory = this.directories.has(from)
    if (file === undefined && !isDirectory) throw new NotFoundError(`${from} does not exist`)

    if (notePathContains(from, to)) throw new NoteStoreError(`cannot move ${from} into itself`)
    if (this.files.has(to) || this.directories.has(to)) {
      throw new PathOccupiedError(`${to} already exists`)
    }
    this.assertNoFileAncestor(to)

    this.addAncestorDirectories(to)

    if (file !== undefined) {
      this.files.delete(from)
      this.files.set(to, file)
      return
    }

    for (const [key, value] of [...this.files]) {
      if (!notePathContains(from, key)) continue
      this.files.delete(key)
      this.files.set(rebase(from, to, key), value)
    }

    for (const key of [...this.directories]) {
      if (key !== from && !notePathContains(from, key)) continue
      this.directories.delete(key)
      this.directories.add(key === from ? to : rebase(from, to, key))
    }
  }

  async remove(path: NotePath): Promise<void> {
    if (this.files.delete(path)) return

    if (!this.directories.delete(path)) throw new NotFoundError(`${path} does not exist`)

    for (const key of [...this.files.keys()]) {
      if (notePathContains(path, key)) this.files.delete(key)
    }
    for (const key of [...this.directories]) {
      if (notePathContains(path, key)) this.directories.delete(key)
    }
  }

  async createDirectory(path: NotePath): Promise<void> {
    if (this.files.has(path)) {
      throw new PathOccupiedError(`${path} already exists and is not a directory`)
    }
    this.assertNoFileAncestor(path)

    // Idempotent, like `mkdir -p`.
    this.addAncestorDirectories(path)
    this.directories.add(path)
  }

  /** Test convenience: fill the store without going through the conflict check. */
  async seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await this.write(assertNotePath(path), content, FORCE_WRITE)
    }
  }

  private buildTree(parent: NotePath | null): TreeEntry[] {
    const prefix = parent === null ? '' : `${parent}/`
    const entries: TreeEntry[] = []

    for (const key of this.directories) {
      const name = immediateChild(prefix, key)
      if (name === null) continue

      entries.push({ kind: 'directory', path: key, name, children: this.buildTree(key) })
    }

    for (const [key, file] of this.files) {
      const name = immediateChild(prefix, key)
      if (name === null) continue

      entries.push({
        kind: 'file',
        path: key,
        name,
        size: byteLength(file.content),
        modifiedAt: file.modifiedAt,
      })
    }

    return entries.sort(compareTreeEntries)
  }

  private addAncestorDirectories(path: NotePath): void {
    for (let parent = notePathParent(path); parent !== null; parent = notePathParent(parent)) {
      this.directories.add(parent)
    }
  }

  /** The in-memory equivalent of ENOTDIR: `a.md` exists, something wants `a.md/b.md`. */
  private assertNoFileAncestor(path: NotePath): void {
    for (let parent = notePathParent(path); parent !== null; parent = notePathParent(parent)) {
      if (this.files.has(parent)) throw new PathOccupiedError(`a file is in the way of ${path}`)
    }
  }
}

/**
 * Hashed on every call rather than cached beside the content, so this store pays
 * the same "stat costs a read" price as the filesystem one. Caching here would
 * hide that cost from exactly the tests that ought to feel it.
 */
function metadataOf(path: NotePath, file: MemoryFile): NoteMetadata {
  return {
    path,
    hash: hashContent(file.content),
    size: byteLength(file.content),
    modifiedAt: file.modifiedAt,
  }
}

/** Bytes, not characters -- the port says so, and it is what lands on disk. */
function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8')
}

/** The name of `key` if it sits directly under `prefix`, else null. */
function immediateChild(prefix: string, key: NotePath): string | null {
  if (!key.startsWith(prefix)) return null

  const rest = key.slice(prefix.length)
  return rest === '' || rest.includes('/') ? null : rest
}

/** Re-root `key` from under `from` to under `to`, for a directory move. */
function rebase(from: NotePath, to: NotePath, key: NotePath): NotePath {
  return assertNotePath(`${to}${key.slice(from.length)}`)
}
