/**
 * Startup checks for the things this server shells out to.
 *
 * The server is not self-contained: it runs `git` for every commit and sync,
 * `rg` for search, and nvim in a pty for the terminal. Those live on the host,
 * not in the dependency tree, so nothing in the build can tell you they are
 * missing -- and each one fails at a different moment, long after boot, in a
 * way that looks like the feature is broken rather than absent.
 *
 * The expensive version of that is a fresh box where everything looks fine
 * until someone opens /term and the pty exits instantly. So the check runs once
 * at startup, before a single request is served, and says plainly what will not
 * work.
 *
 * Two design notes:
 *
 * - **Every problem is reported, not just the first.** Restarting five times to
 *   discover five missing things is the sort of thing that makes people stop
 *   reading boot output.
 * - **The decision is pure.** `evaluatePreflight` takes observations and
 *   returns a verdict; the probing lives behind `PreflightProbes`. The whole
 *   point of this file is machines differing from each other, so its tests must
 *   not depend on what happens to be installed on the machine running them.
 */

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

import type { Config } from './config'

/** How badly the server is affected by a binary being absent. */
export type BinarySeverity = 'required' | 'optional'

export interface RequiredBinary {
  command: string
  /** What stops working without it, phrased for a boot log. */
  provides: string
  severity: BinarySeverity
}

export interface ResolvedBinary {
  path: string
  /** First line of `--version`, or null when it did not report one. */
  version: string | null
}

export interface BinaryStatus extends RequiredBinary {
  resolved: ResolvedBinary | null
}

export interface RootStatus {
  /** As configured. */
  root: string
  /** Symlinks resolved. Null when nothing is there. */
  realPath: string | null
  exists: boolean
  isDirectory: boolean
  writable: boolean
  /**
   * Root of the git work tree containing the notes root, symlinks resolved, or
   * null when it is not inside one at all.
   *
   * Deliberately the *toplevel* rather than a yes/no "is this a repo". See
   * `root-inside-another-repository` below for why that distinction is the
   * whole reason this field exists.
   */
  gitToplevel: string | null
}

export type PreflightIssue =
  | { kind: 'binary-missing'; command: string; provides: string; severity: BinarySeverity }
  | { kind: 'root-missing'; root: string }
  | { kind: 'root-not-a-directory'; root: string }
  | { kind: 'root-not-writable'; root: string }
  | { kind: 'root-not-a-repository'; root: string }
  /**
   * The notes root is a subdirectory of some *other* repository rather than the
   * root of its own.
   *
   * This is the one worth catching, because nothing downstream reports it. If
   * the directory is ignored by the outer repository -- which is exactly what
   * the development default `./notes-dev` is -- then `git add -A` exits 0 and
   * stages nothing, `commit()` returns null, and null is the documented normal
   * case for a debounced auto-committer. So the server runs perfectly, saves
   * files happily, and records no history at all, with nothing in any log.
   *
   * If it is *not* ignored, the failure inverts and gets worse: `git add -A`
   * from a subdirectory stages the whole outer work tree, so auto-commit starts
   * committing unrelated files into somebody else's repository.
   */
  | { kind: 'root-inside-another-repository'; root: string; toplevel: string }

export interface PreflightReport {
  /** False when anything fatal was found. */
  ok: boolean
  binaries: BinaryStatus[]
  root: RootStatus
  issues: PreflightIssue[]
}

/**
 * The binaries the runtime host has to provide.
 *
 * This list is the canonical one. Three other places have to agree with it, and
 * they are not checked by anything -- when this changes, change them too:
 *
 *   - `deploy/Dockerfile`      apt-get in the `server` stage
 *   - `.github/workflows/ci.yml`  the ripgrep install before `pnpm verify`
 *   - `deploy/README.md`       the note about what a custom nvim config may need
 *
 * CI drifting from the Dockerfile is not hypothetical: the search adapter's
 * tests failed on a runner that had no ripgrep, because the image installed it
 * and the workflow did not.
 */
export function requiredBinaries(config: Config): RequiredBinary[] {
  return [
    {
      // Not optional at any level. Notes *are* a git repository (DECISIONS §1);
      // without git the server still serves files, but every auto-commit fails
      // and the history that is supposed to outlive this app never exists.
      command: 'git',
      provides: 'auto-commit, history, and sync with the hub',
      severity: 'required',
    },
    {
      // Hardcoded because RipgrepSearch is constructed without an override in
      // composition.ts. If a SEARCH_BINARY setting is ever added, this has to
      // read it, or preflight will check a binary the server does not use.
      command: 'rg',
      provides: 'search',
      severity: 'optional',
    },
    {
      // The configured command, not a hardcoded `nvim`: TERMINAL_COMMAND is
      // overridable, and checking for nvim when the server is set to run
      // something else would report a problem that does not exist and miss one
      // that does.
      command: config.TERMINAL_COMMAND,
      provides: 'the /term editor',
      severity: 'optional',
    },
  ]
}

// --- The decision, which is pure ---------------------------------------------

export function evaluatePreflight(binaries: BinaryStatus[], root: RootStatus): PreflightReport {
  const issues: PreflightIssue[] = []

  for (const binary of binaries) {
    if (binary.resolved !== null) continue
    issues.push({
      kind: 'binary-missing',
      command: binary.command,
      provides: binary.provides,
      severity: binary.severity,
    })
  }

  issues.push(...evaluateRoot(root))

  return { ok: !issues.some(isFatal), binaries, root, issues }
}

function evaluateRoot(root: RootStatus): PreflightIssue[] {
  if (!root.exists) return [{ kind: 'root-missing', root: root.root }]
  if (!root.isDirectory) return [{ kind: 'root-not-a-directory', root: root.root }]

  const issues: PreflightIssue[] = []

  // Not an early return: a read-only root and a missing repository are
  // independent problems and an operator should learn about both at once.
  if (!root.writable) issues.push({ kind: 'root-not-writable', root: root.root })

  if (root.gitToplevel === null) {
    issues.push({ kind: 'root-not-a-repository', root: root.root })
  } else if (root.realPath !== null && root.gitToplevel !== root.realPath) {
    issues.push({
      kind: 'root-inside-another-repository',
      // The resolved path, not the configured one, so both halves of the
      // message are in the same form. On macOS a notes root under /var has a
      // toplevel under /private/var, and a sentence claiming one contains the
      // other while spelling them differently reads as a bug in the checker.
      root: root.realPath,
      toplevel: root.gitToplevel,
    })
  }

  return issues
}

export function isFatal(issue: PreflightIssue): boolean {
  // Everything about the notes root is fatal: each of these makes writing or
  // committing fail for every request, forever, and none of them get better on
  // their own. A missing optional binary is the only degradable case.
  return issue.kind !== 'binary-missing' || issue.severity === 'required'
}

export function describePreflightIssue(issue: PreflightIssue): string {
  switch (issue.kind) {
    case 'binary-missing':
      return issue.severity === 'required'
        ? `${issue.command} is not on PATH, and it provides ${issue.provides}`
        : `${issue.command} is not on PATH, so ${issue.provides} will not work`
    case 'root-missing':
      return `notes root ${issue.root} does not exist`
    case 'root-not-a-directory':
      return `notes root ${issue.root} is not a directory`
    case 'root-not-writable':
      return `notes root ${issue.root} is not writable by this process`
    case 'root-not-a-repository':
      return `notes root ${issue.root} is not a git repository; run: git init ${issue.root}`
    case 'root-inside-another-repository':
      return (
        `notes root ${issue.root} is inside the git repository at ${issue.toplevel} ` +
        'rather than being one itself, so auto-commit would either record nothing ' +
        `or commit into that repository; run: git init ${issue.root}`
      )
  }
}

// --- The probing, which is not ------------------------------------------------

export interface PreflightProbes {
  probeBinary: (command: string) => Promise<ResolvedBinary | null>
  probeRoot: (root: string) => Promise<RootStatus>
}

export const systemProbes: PreflightProbes = {
  probeBinary: resolveBinary,
  probeRoot: inspectRoot,
}

export async function preflight(
  config: Config,
  probes: PreflightProbes = systemProbes,
): Promise<PreflightReport> {
  const wanted = requiredBinaries(config)

  const [binaries, root] = await Promise.all([
    Promise.all(
      wanted.map(async (binary) => ({
        ...binary,
        resolved: await probes.probeBinary(binary.command),
      })),
    ),
    probes.probeRoot(config.NOTES_ROOT),
  ])

  return evaluatePreflight(binaries, root)
}

/**
 * Finds a command on PATH without shelling out to `which`.
 *
 * Resolving it ourselves keeps this on the same footing as the rest of the
 * server -- no shell anywhere -- and it reports the *path*, which is the part
 * that makes "the wrong nvim is first on PATH" a five-second diagnosis instead
 * of a long afternoon.
 */
export async function resolveBinary(command: string): Promise<ResolvedBinary | null> {
  const candidates = command.includes(nodePath.sep)
    ? [nodePath.resolve(command)]
    : (process.env.PATH ?? '')
        .split(nodePath.delimiter)
        .filter((entry) => entry !== '')
        .map((directory) => nodePath.join(directory, command))

  for (const candidate of candidates) {
    if (!(await isExecutableFile(candidate))) continue
    return { path: candidate, version: await readVersion(candidate) }
  }

  return null
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  // stat before access: X_OK succeeds on a directory, so a directory named `rg`
  // on PATH would otherwise resolve as the binary.
  const stats = await fs.stat(candidate).catch(() => null)
  if (stats === null || !stats.isFile()) return false
  return fs.access(candidate, fsConstants.X_OK).then(
    () => true,
    () => false,
  )
}

function readVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ['--version'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
      (error, stdout, stderr) => {
        // A binary that refuses `--version` is still a binary. The version is
        // for the log, so failing to get one must not fail the check.
        if (error !== null && stdout === '' && stderr === '') {
          resolve(null)
          return
        }
        // Some tools report their version on stderr.
        resolve(firstLine(stdout) ?? firstLine(stderr))
      },
    )
  })
}

function firstLine(output: string): string | null {
  const line = output.split('\n').find((candidate) => candidate.trim() !== '')
  return line === undefined ? null : line.trim()
}

export async function inspectRoot(root: string): Promise<RootStatus> {
  const absent: RootStatus = {
    root,
    realPath: null,
    exists: false,
    isDirectory: false,
    writable: false,
    gitToplevel: null,
  }

  const stats = await fs.stat(root).catch(() => null)
  if (stats === null) return absent
  if (!stats.isDirectory()) return { ...absent, exists: true }

  const realPath = await fs.realpath(root).catch(() => root)

  const [writable, gitToplevel] = await Promise.all([
    fs.access(root, fsConstants.W_OK).then(
      () => true,
      () => false,
    ),
    findGitToplevel(root),
  ])

  return { root, realPath, exists: true, isDirectory: true, writable, gitToplevel }
}

/**
 * The work tree root containing `directory`, with symlinks resolved so it can
 * be compared against a realpath'd notes root.
 *
 * `--show-toplevel` rather than `--is-inside-work-tree`: the latter answers
 * "yes" from a gitignored subdirectory of an unrelated repository, which is the
 * exact case this whole check exists to catch.
 */
function findGitToplevel(directory: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        // Matching GitVersionControl: messages are read, so pin the locale.
        env: { ...process.env, LC_ALL: 'C' },
      },
      async (error, stdout) => {
        if (error !== null) {
          resolve(null)
          return
        }
        const toplevel = stdout.trim()
        if (toplevel === '') {
          resolve(null)
          return
        }
        resolve(await fs.realpath(toplevel).catch(() => toplevel))
      },
    )
  })
}

// --- Reporting ---------------------------------------------------------------

export interface PreflightLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/**
 * Writes the report to the boot log.
 *
 * Resolved paths and versions are logged even when everything is fine. That is
 * the point of it: "which nvim is this" and "which git is this" are the first
 * two questions anyone asks when the terminal misbehaves, and the answer should
 * already be in the log rather than needing a shell on the box.
 */
export function logPreflight(report: PreflightReport, logger: PreflightLogger): void {
  for (const binary of report.binaries) {
    if (binary.resolved === null) continue
    const version = binary.resolved.version ?? 'version unknown'
    logger.info(`preflight: ${binary.command} -> ${binary.resolved.path} (${version})`)
  }

  if (report.root.gitToplevel !== null && report.root.gitToplevel === report.root.realPath) {
    logger.info(`preflight: notes root ${report.root.root} is a git repository`)
  }

  for (const issue of report.issues) {
    const message = `preflight: ${describePreflightIssue(issue)}`
    if (isFatal(issue)) logger.error(message)
    else logger.warn(message)
  }
}
