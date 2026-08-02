/**
 * NoteStore backed by a directory on disk -- the production implementation.
 *
 * Two things drive the shape of this file, and both come from the fact that
 * nvim is a second writer to the same directory (DECISIONS.md §3):
 *
 *   1. Every write is atomic. nvim may be reading a note at the instant the API
 *      writes it, so contents are written to a temporary file in the same
 *      directory and moved into place with rename(2). A reader sees either the
 *      old file or the new one, never a half-written buffer.
 *   2. Every write is checked against the hash the client based its edit on.
 *      The decision itself belongs to core; this adapter only supplies what is
 *      on disk right now and reports the refusal.
 *
 * Containment is checked here even though NotePath has already validated the
 * path, because the two checks catch different things -- see `resolve` below.
 */
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

import {
  decideWriteOrForce,
  notePathContains,
  notePathJoin,
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
import { resolveContained } from './path-containment'
import type { WriteObserver } from './write-journal'

export interface FsNoteStoreOptions {
  /**
   * Told about every change this store makes, so the file watcher can recognise
   * the events it is about to see as ours rather than nvim's. Optional: the
   * store is perfectly usable without a watcher attached.
   */
  observer?: WriteObserver
}

export class FsNoteStore implements NoteStore {
  private readonly root: string
  private readonly observer: WriteObserver | undefined

  constructor(rootDirectory: string, options: FsNoteStoreOptions = {}) {
    if (!nodePath.isAbsolute(rootDirectory)) {
      throw new NoteStoreError(
        `notes root must be an absolute path, got ${JSON.stringify(rootDirectory)}`,
      )
    }
    this.root = nodePath.resolve(rootDirectory)
    this.observer = options.observer
  }

  async tree(): Promise<TreeEntry[]> {
    return this.readDirectory(this.root, null)
  }

  async read(path: NotePath): Promise<NoteDocument | null> {
    const absolute = await this.resolve(path)
    const file = await readFile(absolute)
    if (file === null) return null

    return {
      path,
      hash: hashContent(file.bytes),
      size: file.bytes.byteLength,
      modifiedAt: file.modifiedAt,
      content: file.bytes.toString('utf8'),
    }
  }

  /**
   * Not a cheap call: NoteMetadata carries a hash, and the only way to produce
   * one is to read the whole file. If this ever shows up in a profile the fix is
   * a cache keyed on (inode, size, mtime), not a weaker hash.
   */
  async stat(path: NotePath): Promise<NoteMetadata | null> {
    const absolute = await this.resolve(path)
    return statResolved(absolute, path)
  }

  async write(
    path: NotePath,
    content: string,
    expected: ExpectedVersion | ForceWrite,
  ): Promise<WriteOutcome> {
    const absolute = await this.resolve(path)
    const directory = nodePath.dirname(absolute)

    const existing = await lstatOrNull(absolute)
    if (existing?.isDirectory()) {
      throw new PathOccupiedError(`${path} is a directory`)
    }

    // A create that is about to be refused can leave an empty directory behind.
    // Harmless, and preferable to doing the conflict check earlier: see below.
    await makeDirectory(directory, path)

    const bytes = Buffer.from(content, 'utf8')
    const temporary = nodePath.join(directory, temporaryFileName(nodePath.basename(absolute)))
    let renamed = false

    try {
      await fs.writeFile(temporary, bytes)

      // rename() replaces the inode, so anything deliberate about the old file's
      // permissions would silently revert to the default without this.
      if (existing !== null) await fs.chmod(temporary, existing.mode & 0o777)

      // The conflict check is the last thing before the rename on purpose: the
      // expensive part of the write is already done, so the window between
      // observing the file and replacing it is as small as it can be made.
      //
      // It is not zero. nvim can still write between this read and the rename
      // below, and that write would be lost with no conflict reported. Closing
      // the window properly needs a lock both writers take, and nvim takes none
      // -- so this is a narrowed race, not an eliminated one. In practice it is
      // sub-millisecond and both writers are one person.
      const actual = await statResolved(absolute, path)
      const decision = decideWriteOrForce(expected, actual?.hash ?? null)
      if (!decision.ok) {
        return { ok: false, conflict: decision.conflict, actual }
      }

      await fs.rename(temporary, absolute)
      renamed = true

      const hash = hashContent(bytes)
      // Claimed before returning, so the claim is already in place by the time
      // the watcher gets round to the event this rename just produced.
      this.observer?.recordContent(path, hash)

      return {
        ok: true,
        metadata: {
          path,
          hash,
          size: bytes.byteLength,
          modifiedAt: await modifiedAtOrNow(absolute),
        },
      }
    } finally {
      // Covers both the refused write and a throw partway through. `force`
      // makes it a no-op when the rename already consumed the temporary.
      if (!renamed) await fs.rm(temporary, { force: true })
    }
  }

  async move(from: NotePath, to: NotePath): Promise<void> {
    const source = await this.resolve(from)
    const destination = await this.resolve(to)

    if ((await lstatOrNull(source)) === null) {
      throw new NotFoundError(`${from} does not exist`)
    }
    if (notePathContains(from, to)) {
      throw new NoteStoreError(`cannot move ${from} into itself`)
    }
    if ((await lstatOrNull(destination)) !== null) {
      throw new PathOccupiedError(`${to} already exists`)
    }

    await makeDirectory(nodePath.dirname(destination), to)

    // A move has no content to claim with -- and for a directory it produces one
    // event per note under it -- so both ends are claimed by subtree.
    this.observer?.recordSubtree(from)
    this.observer?.recordSubtree(to)

    // rename() overwrites its destination silently and there is no portable
    // no-clobber variant, so the check above is the whole guard. A file that
    // appears at `to` in the microseconds since would be overwritten.
    await fs.rename(source, destination)
  }

  async remove(path: NotePath): Promise<void> {
    const absolute = await this.resolve(path)

    if ((await lstatOrNull(absolute)) === null) {
      throw new NotFoundError(`${path} does not exist`)
    }

    this.observer?.recordSubtree(path)

    // `force` only covers the path vanishing between the check and here; the
    // "was never there" case is reported above rather than passed over.
    await fs.rm(absolute, { recursive: true, force: true })
  }

  async createDirectory(path: NotePath): Promise<void> {
    const absolute = await this.resolve(path)

    const existing = await lstatOrNull(absolute)
    if (existing !== null && !existing.isDirectory()) {
      throw new PathOccupiedError(`${path} already exists and is not a directory`)
    }

    // Idempotent, like `mkdir -p`: asking for a directory that is already there
    // is not an error worth propagating to a file tree UI.
    await makeDirectory(absolute, path)
  }

  /** Absolute path for a note, proven to be inside the notes root. */
  private async resolve(path: NotePath): Promise<string> {
    return resolveContained(this.root, path)
  }

  private async readDirectory(absolute: string, parent: NotePath | null): Promise<TreeEntry[]> {
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      // A notes root that does not exist yet is empty rather than broken; the
      // first write creates it.
      if (parent === null && isAbsent(error)) return []
      throw error
    }

    const entries: TreeEntry[] = []

    for (const dirent of dirents) {
      // Skipped before anything else so we never walk the object store. Core
      // would refuse to mint a NotePath for it anyway; this is about not
      // spending several seconds proving that.
      if (dirent.name === '.git') continue

      // Symlinks are neither followed nor listed. Following one is the escape
      // `resolve` exists to prevent, and listing an entry that read() would then
      // refuse to open is worse than omitting it. isDirectory/isFile come from
      // the dirent, which reflects lstat, so a symlink is neither.
      if (!dirent.isDirectory() && !dirent.isFile()) continue

      // A name core refuses -- `aux.md`, or one containing a backslash -- can
      // exist on disk because nvim can create it, but it has no NotePath, so no
      // client could address it. Listing it would only produce a broken row.
      const joined = notePathJoin(parent, dirent.name)
      if (!joined.ok) continue

      const path = joined.value
      const child = nodePath.join(absolute, dirent.name)

      if (dirent.isDirectory()) {
        entries.push({
          kind: 'directory',
          path,
          name: dirent.name,
          children: await this.readDirectory(child, path),
        })
        continue
      }

      // nvim may have deleted it since the readdir; a file that is gone is
      // simply not in the tree.
      const stat = await lstatOrNull(child)
      if (stat === null) continue

      entries.push({
        kind: 'file',
        path,
        name: dirent.name,
        size: stat.size,
        modifiedAt: toEpochMillis(stat.mtimeMs),
      })
    }

    return entries.sort(compareTreeEntries)
  }
}

/**
 * Name for the scratch file an atomic write renames from.
 *
 * Exported with its matcher because the file watcher has to recognise these and
 * stay silent about them: every save would otherwise emit a spurious created +
 * deleted pair for a file no client has ever heard of. Two independent guesses
 * at the same naming scheme would drift, and the drift would be invisible until
 * the tree started flickering.
 *
 * Leading dot to keep it out of the way, UUID so two concurrent writes to one
 * note cannot collide, `.tmp` so it is obvious what it is when a crash leaves
 * one behind.
 */
export function temporaryFileName(basename: string): string {
  return `.${basename}.${randomUUID()}.tmp`
}

const TEMPORARY_NAME = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i

/**
 * Deliberately matches the UUID rather than just `*.tmp`: a note legitimately
 * called `.draft.tmp` is a note, and hiding it from the tree would be a bug.
 */
export function isTemporaryFileName(name: string): boolean {
  return TEMPORARY_NAME.test(name)
}

async function statResolved(absolute: string, path: NotePath): Promise<NoteMetadata | null> {
  const file = await readFile(absolute)
  if (file === null) return null

  return {
    path,
    hash: hashContent(file.bytes),
    size: file.bytes.byteLength,
    modifiedAt: file.modifiedAt,
  }
}

/**
 * Contents and mtime of one file, or null if there is no file there.
 *
 * Read through a single handle so the stat and the bytes describe the same
 * inode: doing `stat()` then `readFile()` by path can straddle a replacement
 * and report the mtime of a file whose contents you never saw.
 */
async function readFile(absolute: string): Promise<{ bytes: Buffer; modifiedAt: number } | null> {
  const handle = await openForReading(absolute)
  if (handle === null) return null

  try {
    const stat = await handle.stat()
    // Directories open fine on Linux and only fail at read(). A directory is not
    // a note, and "not a note" is null, not an exception.
    if (!stat.isFile()) return null

    return { bytes: await handle.readFile(), modifiedAt: toEpochMillis(stat.mtimeMs) }
  } finally {
    await handle.close()
  }
}

async function openForReading(absolute: string): Promise<fs.FileHandle | null> {
  try {
    return await fs.open(absolute, 'r')
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

async function lstatOrNull(absolute: string) {
  try {
    return await fs.lstat(absolute)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

async function modifiedAtOrNow(absolute: string): Promise<number> {
  const stat = await lstatOrNull(absolute)
  // Only null if the note was deleted in the microseconds since the rename. The
  // bytes are still what we wrote; the timestamp is the only unknowable field.
  return stat === null ? Date.now() : toEpochMillis(stat.mtimeMs)
}

/**
 * APFS and ext4 report sub-millisecond precision, so `mtimeMs` is a float.
 * InMemoryNoteStore's clock is Date.now(), which is not -- and two stores that
 * disagree about the shape of a field are not interchangeable, which defeats
 * the point of having an in-memory twin. Round here rather than loosening the
 * contract tests.
 */
function toEpochMillis(mtimeMs: number): number {
  return Math.round(mtimeMs)
}

async function makeDirectory(absolute: string, path: NotePath): Promise<void> {
  try {
    await fs.mkdir(absolute, { recursive: true })
  } catch (error) {
    // A file sitting where a directory needs to be: `notes.md` exists and
    // something asks for `notes.md/child.md`.
    const code = errorCode(error)
    if (code === 'ENOTDIR' || code === 'EEXIST') {
      throw new PathOccupiedError(`a file is in the way of ${path}`)
    }
    throw error
  }
}

/**
 * "There is nothing readable here." ENOTDIR is included because a path whose
 * ancestor is a file is just as absent as one whose ancestor is missing, and
 * EISDIR because platforms disagree about whether opening a directory fails at
 * open() or at read().
 */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
