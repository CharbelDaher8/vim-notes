/**
 * Git as the VersionControl port.
 *
 * The notes directory is an ordinary working copy whose remote is a bare hub
 * (DECISIONS §2), and a laptop clone pushes to that same hub. Two independent
 * writers over one history means divergence and conflicts are a normal operating
 * condition here, not an exceptional one -- so `sync` reports them as data and
 * only genuine faults (git missing, a corrupt repo, a broken invariant) throw.
 *
 * Everything runs through `execFile` with an argument array. Never `exec`: note
 * paths and commit messages both originate from client input, and a shell in
 * that position is a command injection vector. `--` separates paths from flags
 * so a note called `-f` stays a path, and `--end-of-options` does the same for
 * refs. NotePath has already rejected the truly hostile inputs, but this layer
 * does not rely on that -- neither side trusts the other.
 *
 * Errors are classified by matching git's own messages, which is why the child
 * environment pins `LC_ALL=C`: a translated stderr would silently reclassify a
 * conflict as an unknown failure on a box with a non-English locale.
 */

import { execFile, type ExecFileException } from 'node:child_process'

import {
  parseNotePath,
  type CommitEntry,
  type CommitRef,
  type NotePath,
  type RepoStatus,
  type SyncOutcome,
  type VersionControl,
} from '@vim-notes/core'

export interface GitIdentity {
  name: string
  email: string
}

export interface GitVersionControlOptions {
  /** Remote that stands for the hub. */
  remote?: string
  /** Used only when the repository resolves no `user.name` / `user.email`. */
  defaultAuthor?: GitIdentity
  /** Overridable so a test or a container can point at a specific binary. */
  gitPath?: string
  /** Per-command wall clock limit. Network commands are the reason it exists. */
  timeoutMs?: number
  /** Cap on a single command's stdout. A long `log` or `diff` is the risk. */
  maxBuffer?: number
  /**
   * Extra environment for every git child process. The real use is transport
   * credentials -- `GIT_SSH_COMMAND` with the deploy key for the hub -- which
   * belongs in configuration rather than in this file.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Run the repository's own hooks on commit. Off by default: auto-commit fires
   * every couple of seconds, so a slow or failing `pre-commit` hook would stall
   * or silently halt the note history, which is a much worse failure than
   * skipping a hook nobody installed on purpose.
   */
  runHooks?: boolean
}

/** A git command exited non-zero in a way that is not a modelled outcome. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} failed (exit ${exitCode}): ${summarizeStderr(stderr) || '<no output>'}`,
    )
    this.name = 'GitError'
  }
}

const DEFAULT_IDENTITY: GitIdentity = { name: 'vim-notes', email: 'vim-notes@localhost' }

/**
 * `%B` is the raw message, so it contains newlines and is the reason a
 * line-oriented parse is not an option. Fields are NUL-separated and records are
 * introduced by NUL + RS: a commit message may contain any byte except NUL, so
 * that two-byte sequence cannot occur inside one. `--name-only -z` then appends
 * the changed paths as further NUL-terminated fields.
 */
const LOG_FORMAT = '%x00%x1e%H%x00%at%x00%B'
const LOG_RECORD_DELIMITER = '\u0000\u001e'

/**
 * Token index of the path within an unmerged `git status --porcelain=v2` entry:
 * `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`. Unmerged entries
 * carry three stage hashes where an ordinary entry carries two, so the column
 * count is not shared -- and getting it wrong silently shifts the path.
 */
const UNMERGED_ENTRY_PATH_TOKEN = 10

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** What `status --porcelain=v2` says, before it is narrowed to the port's shape. */
export interface RawStatus {
  branch: string
  ahead: number
  behind: number
  /** Any difference from HEAD at all, including untracked files. */
  changed: boolean
  /** Changes to tracked files. These, and only these, block a rebase. */
  trackedChanged: boolean
  /** Raw paths of unmerged entries, before NotePath parsing drops any. */
  unmerged: string[]
}

export class GitVersionControl implements VersionControl {
  private readonly remote: string
  private readonly defaultAuthor: GitIdentity
  private readonly gitPath: string
  private readonly timeoutMs: number
  private readonly maxBuffer: number
  private readonly runHooks: boolean
  private readonly env: NodeJS.ProcessEnv

  /**
   * Commits and syncs are serialised against each other. They are not
   * independent: `commit`'s `git add -A` running halfway through a rebase would
   * stage conflict markers, and two overlapping commits would each pick up the
   * other's staged files. Reads need no such protection and stay off the queue.
   */
  private mutations: Promise<unknown> = Promise.resolve()

  private identityArgs: Promise<string[]> | null = null

  constructor(
    private readonly root: string,
    options: GitVersionControlOptions = {},
  ) {
    this.remote = options.remote ?? 'origin'
    this.defaultAuthor = options.defaultAuthor ?? DEFAULT_IDENTITY
    this.gitPath = options.gitPath ?? 'git'
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024
    this.runHooks = options.runHooks ?? false
    this.env = {
      ...process.env,
      // See the module comment: stderr is parsed, so the locale is pinned.
      LC_ALL: 'C',
      // Never sit at a credential prompt with nobody at the keyboard; an
      // unauthenticated fetch has to fail fast instead of hanging the sync.
      GIT_TERMINAL_PROMPT: '0',
      ...options.env,
    }
  }

  // --- Port surface ----------------------------------------------------------

  async commit(message: string, paths?: NotePath[]): Promise<CommitRef | null> {
    return this.serialize(() => this.commitNow(message, paths))
  }

  async log(options?: { path?: NotePath; limit?: number }): Promise<CommitEntry[]> {
    const args = ['log', '--no-show-signature', `--format=${LOG_FORMAT}`, '--name-only', '-z']

    if (options?.limit !== undefined) {
      args.push(`--max-count=${Math.max(0, Math.floor(options.limit))}`)
    }
    if (options?.path !== undefined) args.push('--', options.path)

    const result = await this.run(args)

    if (result.code !== 0) {
      // A branch with no commits yet is empty history, not a failure -- a fresh
      // notes directory is in exactly this state until the first save.
      if (!(await this.hasCommits())) return []
      throw new GitError(args, result.code, result.stderr)
    }

    return parseLog(result.stdout)
  }

  async diff(ref: CommitRef, path?: NotePath): Promise<string> {
    const args = ['show', '--no-show-signature', '--patch', '--no-color', '--format=']
    args.push('--end-of-options', ref.sha)
    if (path !== undefined) args.push('--', path)

    const { stdout } = await this.runOrThrow(args)

    // An empty `--format=` header can leave a blank line ahead of the patch.
    return stdout.startsWith('\n') ? stdout.slice(1) : stdout
  }

  async restore(path: NotePath, ref: CommitRef): Promise<string> {
    // Deliberately just reads the blob. Writing it back is NoteStore's job, so
    // that a restore goes through the same conflict check as any other write.
    const args = ['show', '--no-show-signature', '--end-of-options', `${ref.sha}:${path}`]
    const { stdout } = await this.runOrThrow(args)
    return stdout
  }

  async status(): Promise<RepoStatus> {
    const raw = await this.readStatus()
    return {
      branch: raw.branch,
      dirty: raw.changed,
      ahead: raw.ahead,
      behind: raw.behind,
      conflicted: toNotePaths(raw.unmerged),
    }
  }

  async sync(): Promise<SyncOutcome> {
    return this.serialize(() => this.syncNow(true))
  }

  // --- Commit ----------------------------------------------------------------

  private async commitNow(message: string, paths?: NotePath[]): Promise<CommitRef | null> {
    const before = await this.readStatus()

    // Git refuses to commit unmerged paths on its own, but `git add -A` below
    // would resolve them first and turn conflict markers into history. Refusing
    // is the whole point: the markers are on disk waiting for a human.
    if (before.unmerged.length > 0) {
      throw new Error(
        `refusing to commit: ${before.unmerged.length} unmerged path(s) in ${this.root}; ` +
          'resolve the conflict first',
      )
    }

    // The common case under a debounced auto-committer is that the previous
    // commit already took everything, so bail out before spawning `git add`.
    if (!before.changed) return null

    if (paths === undefined) {
      await this.runOrThrow(['add', '-A', '--'])
    } else {
      // `git add` is all-or-nothing: one pathspec matching nothing makes it exit
      // 128 having staged none of the others, so a note the client thinks it
      // deleted twice would quietly cost the whole commit. Resolving the
      // pathspecs to entries git already knows about avoids that, and an empty
      // result is simply nothing to commit.
      const matched = await this.matchingPaths(paths)
      if (matched.length === 0) return null
      await this.runOrThrow(['add', '-A', '--', ...matched])
    }

    // `--quiet` here means "exit 0 when there is no difference", which is how a
    // path-scoped commit that matched nothing is told apart from a real one.
    const staged = await this.run(['diff', '--cached', '--quiet'])
    if (staged.code === 0) return null
    if (staged.code > 1)
      throw new GitError(['diff', '--cached', '--quiet'], staged.code, staged.stderr)

    const args = [...(await this.identity()), 'commit', '--quiet', '-m', message]
    if (!this.runHooks) args.push('--no-verify')
    await this.runOrThrow(args)

    const head = await this.runOrThrow(['rev-parse', 'HEAD'])
    return { sha: head.stdout.trim() }
  }

  /**
   * `-c user.name=... -c user.email=...` for whichever half the repository does
   * not configure. Without this, a fresh container with no gitconfig either
   * fails outright ("unable to auto-detect email address") or invents an
   * identity from the hostname, and both outcomes surface as a mystery at the
   * first auto-commit rather than at deploy time.
   */
  private async identity(): Promise<string[]> {
    this.identityArgs ??= (async () => {
      const [name, email] = await Promise.all([
        this.configValue('user.name'),
        this.configValue('user.email'),
      ])

      const args: string[] = []
      if (name === null) args.push('-c', `user.name=${this.defaultAuthor.name}`)
      if (email === null) args.push('-c', `user.email=${this.defaultAuthor.email}`)
      return args
    })()

    return this.identityArgs
  }

  /**
   * The given paths narrowed to what git can actually stage: tracked entries
   * (including ones deleted from the working tree) and untracked files that are
   * not ignored.
   */
  private async matchingPaths(paths: readonly NotePath[]): Promise<string[]> {
    if (paths.length === 0) return []

    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]
    const { stdout } = await this.runOrThrow(args)

    return [...new Set(stdout.split('\0').filter((entry) => entry !== ''))]
  }

  private async configValue(key: string): Promise<string | null> {
    const result = await this.run(['config', '--get', key])
    if (result.code !== 0) return null
    const value = result.stdout.trim()
    return value === '' ? null : value
  }

  // --- Sync ------------------------------------------------------------------

  /**
   * `pull --rebase` then `push`, decomposed into fetch / rebase / push.
   *
   * The decomposition is the point: `git pull --rebase` collapses transport
   * failures, a dirty working tree and merge conflicts into one exit code, and
   * it checks them in an order that misreports (a dirty tree with no remote at
   * all is reported as a dirty tree). Run separately, each failure belongs to
   * exactly one command and the SyncOutcome reason follows from which one it
   * was.
   */
  private async syncNow(mayRetry: boolean): Promise<SyncOutcome> {
    if ((await this.run(['remote', 'get-url', this.remote])).code !== 0) {
      return {
        ok: false,
        reason: 'no-remote',
        message: `no git remote named '${this.remote}' is configured in ${this.root}`,
      }
    }

    const head = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (head.code !== 0) {
      // Detached HEAD is not a state this app ever produces, and there is no
      // sane branch to sync. Genuinely exceptional, so it throws.
      throw new Error(`cannot sync ${this.root}: HEAD is detached, expected a branch`)
    }
    const branch = head.stdout.trim()

    const fetch = await this.run(['fetch', this.remote])
    if (fetch.code !== 0) {
      // Everything that stops a fetch of an already-configured remote is a
      // transport or access problem. Only the credential half is separable, and
      // only heuristically, so anything unrecognised stays 'network'.
      const failure = classifyTransportFailure(fetch.stderr)
      return { ok: false, reason: failure.reason, message: failure.message }
    }

    const remoteRef = `refs/remotes/${this.remote}/${branch}`
    const remoteExists =
      (await this.run(['rev-parse', '--verify', '--quiet', remoteRef])).code === 0
    const localExists = await this.hasCommits()

    let pulled = 0

    if (remoteExists) {
      pulled = localExists
        ? await this.countCommits(`HEAD..${remoteRef}`)
        : await this.countCommits(remoteRef)

      if (pulled > 0) {
        const outcome = localExists
          ? await this.rebaseOnto(remoteRef)
          : await this.adoptRemote(remoteRef)
        if (outcome !== null) return outcome
      }
    }

    // A branch with no commits has nothing to count and nothing to push: a
    // notes directory that has been set up but never written to is exactly
    // this, and `rev-list HEAD` would fail rather than answer zero.
    const pushed = !localExists
      ? 0
      : remoteExists
        ? await this.countCommits(`${remoteRef}..HEAD`)
        : await this.countCommits('HEAD')

    if (pushed > 0) {
      // `--set-upstream` on every push is idempotent and keeps status()'s
      // ahead/behind meaningful even when the working copy was made with
      // `git init` + `git remote add` rather than cloned from the hub.
      const push = await this.run(['push', '--set-upstream', this.remote, branch])

      if (push.code !== 0) {
        // Credentials are checked before refusal. A push that never reached the
        // hub cannot have been rejected by it, and reporting 'rejected' for a
        // bad key would send the caller into a retry loop that cannot succeed.
        const failure = classifyTransportFailure(push.stderr)
        if (failure.reason === 'auth') {
          return { ok: false, reason: 'auth', message: failure.message }
        }

        if (isPushRejected(push.stderr)) {
          // The hub moved between our fetch and our push -- precisely the race
          // this topology invites. One retry usually settles it.
          if (mayRetry) return this.syncNow(false)

          // Still refused after a fresh fetch and rebase. Nothing on disk needs
          // a human, so this is 'rejected' rather than 'conflict'.
          return { ok: false, reason: 'rejected', message: summarizeStderr(push.stderr) }
        }

        return { ok: false, reason: 'network', message: failure.message }
      }
    }

    return { ok: true, pulled, pushed }
  }

  /** Returns null on success, or the outcome that ended the sync. */
  private async rebaseOnto(remoteRef: string): Promise<SyncOutcome | null> {
    // Checked up front rather than left to git, so that a working tree nvim is
    // midway through writing never gets a rebase started on top of it.
    const before = await this.readStatus()
    if (before.trackedChanged) {
      return {
        ok: false,
        reason: 'dirty',
        message: 'working tree has uncommitted changes; commit or discard them before syncing',
      }
    }

    const rebase = await this.run(['rebase', remoteRef])
    if (rebase.code === 0) return null

    const after = await this.readStatus()
    const conflicted = toNotePaths(after.unmerged)
    const unmergedCount = after.unmerged.length

    // Abort rather than leaving the rebase in progress. Leaving it would put the
    // repository on a detached HEAD with conflict markers on disk, and the
    // auto-committer two seconds later would happily commit those markers as
    // the new content of the note. The conflicting paths are returned instead so
    // the UI can say which notes clash.
    await this.run(['rebase', '--abort'])

    if (unmergedCount > 0) return { ok: false, reason: 'conflict', conflicted }

    // Untracked files that the incoming commits would overwrite land here: the
    // tracked-changes check above cannot see them, and git only complains once
    // it tries to move HEAD.
    if (isDirtyRefusal(rebase.stderr)) {
      return { ok: false, reason: 'dirty', message: summarizeStderr(rebase.stderr) }
    }

    throw new GitError(['rebase', remoteRef], rebase.code, rebase.stderr)
  }

  /**
   * Fast-forward an unborn branch onto the hub. `git rebase` cannot resolve a
   * HEAD with no commits behind it, and this is a real state: a working copy
   * cloned while the hub was still empty, which the laptop has since pushed to.
   */
  private async adoptRemote(remoteRef: string): Promise<SyncOutcome | null> {
    const merge = await this.run(['merge', '--ff-only', remoteRef])
    if (merge.code === 0) return null

    if (isDirtyRefusal(merge.stderr)) {
      return { ok: false, reason: 'dirty', message: summarizeStderr(merge.stderr) }
    }

    throw new GitError(['merge', '--ff-only', remoteRef], merge.code, merge.stderr)
  }

  private async countCommits(range: string): Promise<number> {
    const result = await this.runOrThrow(['rev-list', '--count', range])
    const count = Number.parseInt(result.stdout.trim(), 10)
    return Number.isFinite(count) ? count : 0
  }

  private async hasCommits(): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0
  }

  // --- Status ----------------------------------------------------------------

  private async readStatus(): Promise<RawStatus> {
    // `--no-optional-locks` keeps a status read from taking the index lock, so
    // polling this cannot make a concurrent nvim write fail.
    const args = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']
    const { stdout } = await this.runOrThrow(args)
    return parseStatus(stdout)
  }

  // --- Process plumbing ------------------------------------------------------

  /**
   * Runs `operation` after every previously queued mutation, whether those
   * succeeded or failed, and keeps the chain alive across rejections.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private run(args: readonly string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        [...args],
        {
          cwd: this.root,
          encoding: 'utf8',
          maxBuffer: this.maxBuffer,
          timeout: this.timeoutMs,
          env: this.env,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr })
            return
          }

          // A numeric code means git ran and had something to say. Anything else
          // -- ENOENT because git is not installed, a signal because the timeout
          // killed it -- is not a git outcome and must not be classified as one.
          const code = (error as ExecFileException).code
          if (typeof code !== 'number') {
            reject(
              new Error(`git ${args.join(' ')} could not run: ${error.message}`, { cause: error }),
            )
            return
          }

          resolve({ code, stdout, stderr })
        },
      )
    })
  }

  private async runOrThrow(args: readonly string[]): Promise<GitResult> {
    const result = await this.run(args)
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr)
    return result
  }
}

// --- Parsing -----------------------------------------------------------------

export function parseStatus(stdout: string): RawStatus {
  const status: RawStatus = {
    branch: '',
    ahead: 0,
    behind: 0,
    changed: false,
    trackedChanged: false,
    unmerged: [],
  }

  const fields = stdout.split('\0')

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (field === undefined || field === '') continue

    if (field.startsWith('# branch.head ')) {
      // Reports `(detached)` mid-rebase or mid-bisect. Passed through verbatim:
      // inventing a branch name would hide a state the operator needs to see.
      status.branch = field.slice('# branch.head '.length)
      continue
    }

    if (field.startsWith('# branch.ab ')) {
      const [ahead, behind] = field.slice('# branch.ab '.length).split(' ')
      status.ahead = Math.abs(Number.parseInt(ahead ?? '0', 10)) || 0
      status.behind = Math.abs(Number.parseInt(behind ?? '0', 10)) || 0
      continue
    }

    if (field.startsWith('# ')) continue

    if (field.startsWith('1 ')) {
      status.changed = true
      status.trackedChanged = true
      continue
    }

    if (field.startsWith('2 ')) {
      status.changed = true
      status.trackedChanged = true
      // A rename carries its original path in the following NUL-terminated
      // field. Skipping it is what stops that path being read as a new entry.
      index++
      continue
    }

    if (field.startsWith('u ')) {
      status.changed = true
      status.trackedChanged = true
      const path = entryPath(field, UNMERGED_ENTRY_PATH_TOKEN)
      if (path !== null) status.unmerged.push(path)
      continue
    }

    if (field.startsWith('? ')) {
      // Untracked counts as dirty (a new note nobody has committed yet) but not
      // as a tracked change: untracked files do not block a rebase.
      status.changed = true
    }
  }

  return status
}

/** The path of a porcelain-v2 entry, which is everything after `skip` tokens. */
function entryPath(entry: string, skip: number): string | null {
  let cursor = 0
  for (let token = 0; token < skip; token++) {
    const next = entry.indexOf(' ', cursor)
    if (next === -1) return null
    cursor = next + 1
  }
  const path = entry.slice(cursor)
  return path === '' ? null : path
}

export function parseLog(stdout: string): CommitEntry[] {
  const entries: CommitEntry[] = []

  for (const record of stdout.split(LOG_RECORD_DELIMITER)) {
    if (record === '') continue

    const fields = record.split('\0')
    const sha = fields[0]
    const authoredAt = fields[1]
    const message = fields[2]
    if (sha === undefined || authoredAt === undefined || message === undefined) continue

    const seconds = Number.parseInt(authoredAt, 10)
    if (!Number.isFinite(seconds)) continue

    const paths: NotePath[] = []
    for (const field of fields.slice(3)) {
      // The first path is preceded by the newline git puts between the format
      // output and the diff.
      const candidate = field.startsWith('\n') ? field.slice(1) : field
      if (candidate === '') continue

      // A file that is not a valid note -- a stray `aux.md`, something with a
      // control character -- is dropped rather than allowed to fail the whole
      // history read. History is a view; one unrepresentable path must not blank
      // the page.
      const parsed = parseNotePath(candidate)
      if (parsed.ok) paths.push(parsed.value)
    }

    entries.push({
      sha,
      // `%at` is epoch seconds; the port is explicit that this is milliseconds.
      authoredAt: seconds * 1000,
      // Git normalises a trailing newline onto every message; it is not content.
      message: message.replace(/\n+$/, ''),
      paths,
    })
  }

  return entries
}

function toNotePaths(raw: readonly string[]): NotePath[] {
  const paths: NotePath[] = []
  for (const candidate of raw) {
    const parsed = parseNotePath(candidate)
    if (parsed.ok) paths.push(parsed.value)
  }
  return paths
}

/** The line of git's stderr worth showing a user, rather than the first one. */
function summarizeStderr(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trimEnd())
  const meaningful = lines.filter((line) => line.trim() !== '')
  const diagnostic = meaningful.find((line) => /^(fatal:|error:|remote:|\s*!\s)/.test(line))
  return (diagnostic ?? meaningful[0] ?? '').trim()
}

function isPushRejected(stderr: string): boolean {
  return /\[(remote )?rejected\]|non-fast-forward|fetch first|stale info|failed to push/i.test(
    stderr,
  )
}

function isDirtyRefusal(stderr: string): boolean {
  return /unstaged changes|uncommitted changes|would be overwritten|local changes|Please commit or stash/i.test(
    stderr,
  )
}
