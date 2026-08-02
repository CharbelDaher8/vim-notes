import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { Config } from './config'
import {
  describePreflightIssue,
  evaluatePreflight,
  inspectRoot,
  isFatal,
  logPreflight,
  preflight,
  requiredBinaries,
  resolveBinary,
  type BinaryStatus,
  type PreflightProbes,
  type RemoteStatus,
  type RootStatus,
} from './preflight'

const execFileAsync = promisify(execFile)

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-preflight-'))
  temporaryDirectories.push(directory)
  return fs.realpath(directory)
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

/** Only the fields preflight reads; the rest of Config is irrelevant here. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return { NOTES_ROOT: '/notes', TERMINAL_COMMAND: 'nvim', ...overrides } as Config
}

/** A root that passes every check, for tests that care about one thing. */
function healthyRoot(overrides: Partial<RootStatus> = {}): RootStatus {
  return {
    root: '/notes',
    realPath: '/notes',
    exists: true,
    isDirectory: true,
    writable: true,
    gitToplevel: '/notes',
    ...overrides,
  }
}

/** A remote that is configured and answering. */
function healthyRemote(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    name: 'origin',
    url: 'git@github.com:me/notes.git',
    reachable: true,
    detail: null,
    ...overrides,
  }
}

function binary(command: string, severity: 'required' | 'optional', found: boolean): BinaryStatus {
  return {
    command,
    provides: `${command} things`,
    severity,
    resolved: found ? { path: `/usr/bin/${command}`, version: `${command} 1.0` } : null,
  }
}

const allPresent = [
  binary('git', 'required', true),
  binary('rg', 'optional', true),
  binary('nvim', 'optional', true),
]

describe('evaluatePreflight', () => {
  it('passes when everything is present and the root is its own repository', () => {
    const report = evaluatePreflight(allPresent, healthyRoot(), healthyRemote())
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
  })

  it('refuses to start without git', () => {
    // Auto-commit is not optional: notes ARE a git repository, so a server that
    // cannot commit is one that silently stops preserving history.
    const report = evaluatePreflight(
      [binary('git', 'required', false), binary('rg', 'optional', true)],
      healthyRoot(),
      healthyRemote(),
    )

    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: 'binary-missing', command: 'git' }),
    )
  })

  it('starts without ripgrep or nvim, but says so', () => {
    const report = evaluatePreflight(
      [
        binary('git', 'required', true),
        binary('rg', 'optional', false),
        binary('nvim', 'optional', false),
      ],
      healthyRoot(),
      healthyRemote(),
    )

    expect(report.ok).toBe(true)
    expect(report.issues).toHaveLength(2)
    expect(report.issues.every((issue) => !isFatal(issue))).toBe(true)
  })

  it.each([
    [
      'root-missing',
      healthyRoot({ exists: false, isDirectory: false, realPath: null, gitToplevel: null }),
    ],
    ['root-not-a-directory', healthyRoot({ isDirectory: false, gitToplevel: null })],
    ['root-not-writable', healthyRoot({ writable: false })],
    ['root-not-a-repository', healthyRoot({ gitToplevel: null })],
    ['root-inside-another-repository', healthyRoot({ gitToplevel: '/somewhere/else' })],
  ])('treats %s as fatal', (kind, root) => {
    const report = evaluatePreflight(allPresent, root, healthyRemote())

    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.kind)).toContain(kind)
  })

  it('reports every problem at once rather than only the first', () => {
    // Restarting five times to find five problems is how people learn to stop
    // reading boot output.
    const report = evaluatePreflight(
      [
        binary('git', 'required', false),
        binary('rg', 'optional', false),
        binary('nvim', 'optional', false),
      ],
      healthyRoot({ writable: false, gitToplevel: null }),
      healthyRemote(),
    )

    expect(report.issues.map((issue) => issue.kind).sort()).toEqual([
      'binary-missing',
      'binary-missing',
      'binary-missing',
      'root-not-a-repository',
      'root-not-writable',
    ])
  })

  it('stops after root-missing rather than piling on derived complaints', () => {
    // "does not exist" and "is not a repository" about the same absent path is
    // noise; the second is implied by the first.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot({
        exists: false,
        isDirectory: false,
        realPath: null,
        writable: false,
        gitToplevel: null,
      }),
      healthyRemote(),
    )

    expect(report.issues).toEqual([{ kind: 'root-missing', root: '/notes' }])
  })

  it('reports both paths of a nested repository in the same form', () => {
    // A symlinked notes root -- /var on macOS -- resolves to a toplevel under
    // /private/var. Reporting the configured path alongside the resolved one
    // makes a message claiming containment look self-contradictory.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot({
        root: '/var/data/notes',
        realPath: '/private/var/data/notes',
        gitToplevel: '/private/var/data',
      }),
      healthyRemote(),
    )

    expect(report.issues).toEqual([
      {
        kind: 'root-inside-another-repository',
        root: '/private/var/data/notes',
        toplevel: '/private/var/data',
      },
    ])
  })

  it('describes the nested-repository case with the command that fixes it', () => {
    const message = describePreflightIssue({
      kind: 'root-inside-another-repository',
      root: '/work/repo/notes-dev',
      toplevel: '/work/repo',
    })

    expect(message).toContain('/work/repo')
    expect(message).toContain('git init /work/repo/notes-dev')
  })
})

describe('the remote', () => {
  it('warns when nothing is configured, without refusing to start', () => {
    // No remote means no offsite copy, which matters -- but notes and local
    // history still work, and a box that will not boot without GitHub would
    // undo the trade §2 made.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot(),
      healthyRemote({ url: null, reachable: null }),
    )

    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([{ kind: 'remote-missing', name: 'origin' }])
  })

  it('warns when the remote does not answer', () => {
    // This is the state of every box while GitHub is down. Refusing to serve
    // notes over it would be absurd.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot(),
      healthyRemote({ reachable: false, detail: 'Permission denied (publickey).' }),
    )

    expect(report.ok).toBe(true)
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: 'remote-unreachable',
        detail: 'Permission denied (publickey).',
      }),
    )
  })

  it('notices origin disagreeing with the configured URL', () => {
    // bootstrap.sh only clones when the directory is absent, so editing
    // GIT_REMOTE_URL later silently does nothing.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot(),
      healthyRemote({ url: 'git@github.com:me/old-notes.git' }),
      'git@github.com:me/new-notes.git',
    )

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: 'remote-url-mismatch',
        actual: 'git@github.com:me/old-notes.git',
      }),
    )
  })

  it.each([
    ['git@github.com:me/notes.git', 'ssh://git@github.com/me/notes'],
    ['git@github.com:me/notes.git', 'git@github.com:me/notes'],
    ['https://github.com/me/notes.git', 'https://github.com/me/notes/'],
    ['git@github.com:Me/Notes.git', 'git@github.com:me/notes.git'],
  ])('does not cry drift over %s vs %s', (configured, actual) => {
    // The same repository written several ways. A false alarm here teaches
    // people to ignore the real one.
    const report = evaluatePreflight(
      allPresent,
      healthyRoot(),
      healthyRemote({ url: actual }),
      configured,
    )

    expect(report.issues).toEqual([])
  })
})

describe('requiredBinaries', () => {
  it('checks the configured terminal command, not a hardcoded nvim', () => {
    // TERMINAL_COMMAND is overridable, so hardcoding would both invent a
    // problem that does not exist and miss the one that does.
    const commands = requiredBinaries(makeConfig({ TERMINAL_COMMAND: 'helix' })).map(
      (entry) => entry.command,
    )

    expect(commands).toContain('helix')
    expect(commands).not.toContain('nvim')
  })

  it('treats git as required and the rest as optional', () => {
    const wanted = requiredBinaries(makeConfig())
    const required = wanted.filter((entry) => entry.severity === 'required').map((e) => e.command)

    expect(required).toEqual(['git'])
  })
})

describe('preflight', () => {
  it('asks about exactly the configured binaries and the configured root', async () => {
    const asked: string[] = []
    const probes: PreflightProbes = {
      probeBinary: async (command) => {
        asked.push(command)
        return { path: `/fake/${command}`, version: null }
      },
      probeRoot: async (root) => healthyRoot({ root, realPath: root, gitToplevel: root }),
      probeRemote: async (_root, name) => healthyRemote({ name }),
    }

    const report = await preflight(
      makeConfig({ NOTES_ROOT: '/srv/notes', TERMINAL_COMMAND: 'nvim' }),
      probes,
    )

    expect(asked.sort()).toEqual(['git', 'nvim', 'rg'])
    expect(report.root.root).toBe('/srv/notes')
    expect(report.ok).toBe(true)
  })
})

describe('resolveBinary', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('finds a binary on PATH and reads its version', async () => {
    // A binary made for the test rather than one that happens to be installed:
    // the entire subject here is machines differing from each other.
    const directory = await makeTemporaryDirectory()
    const tool = nodePath.join(directory, 'vim-notes-fake-tool')
    await fs.writeFile(tool, '#!/bin/sh\necho "fake-tool 9.9.9"\n', { mode: 0o755 })

    process.env.PATH = `${directory}${nodePath.delimiter}${originalPath ?? ''}`

    const resolved = await resolveBinary('vim-notes-fake-tool')
    expect(resolved?.path).toBe(tool)
    expect(resolved?.version).toBe('fake-tool 9.9.9')
  })

  it('returns null for a command that is not there', async () => {
    expect(await resolveBinary('vim-notes-definitely-absent')).toBeNull()
  })

  it('still resolves a binary that refuses --version', async () => {
    const directory = await makeTemporaryDirectory()
    const tool = nodePath.join(directory, 'vim-notes-silent-tool')
    await fs.writeFile(tool, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    process.env.PATH = `${directory}${nodePath.delimiter}${originalPath ?? ''}`

    const resolved = await resolveBinary('vim-notes-silent-tool')
    expect(resolved).not.toBeNull()
    expect(resolved?.version).toBeNull()
  })

  it('does not mistake a directory on PATH for a binary', async () => {
    const directory = await makeTemporaryDirectory()
    await fs.mkdir(nodePath.join(directory, 'vim-notes-fake-dir'), { recursive: true })

    process.env.PATH = `${directory}${nodePath.delimiter}${originalPath ?? ''}`

    expect(await resolveBinary('vim-notes-fake-dir')).toBeNull()
  })

  it('accepts an absolute path without consulting PATH', async () => {
    const directory = await makeTemporaryDirectory()
    const tool = nodePath.join(directory, 'pinned-tool')
    await fs.writeFile(tool, '#!/bin/sh\necho pinned 1.0\n', { mode: 0o755 })

    expect((await resolveBinary(tool))?.path).toBe(tool)
  })
})

describe('inspectRoot', () => {
  it('reports a repository root as its own toplevel', async () => {
    const root = await makeTemporaryDirectory()
    await git(root, ['init', '--quiet', '-b', 'main', '.'])

    const status = await inspectRoot(root)
    expect(status).toMatchObject({ exists: true, isDirectory: true, writable: true })
    expect(status.gitToplevel).toBe(status.realPath)
  })

  it('reports a plain directory as not being in a repository', async () => {
    const root = await makeTemporaryDirectory()
    expect((await inspectRoot(root)).gitToplevel).toBeNull()
  })

  it('reports a missing path', async () => {
    const parent = await makeTemporaryDirectory()
    const status = await inspectRoot(nodePath.join(parent, 'nope'))
    expect(status).toMatchObject({ exists: false, isDirectory: false, gitToplevel: null })
  })

  it('reports a file as not a directory', async () => {
    const parent = await makeTemporaryDirectory()
    const file = nodePath.join(parent, 'a-file')
    await fs.writeFile(file, 'not a notes root')

    expect(await inspectRoot(file)).toMatchObject({ exists: true, isDirectory: false })
  })

  it('sees through a gitignored subdirectory of another repository', async () => {
    // The case this whole check exists for, and the reason it uses
    // --show-toplevel rather than --is-inside-work-tree.
    //
    // `NOTES_ROOT` defaults to ./notes-dev, and this repository gitignores
    // notes-dev/ -- so the development default lands exactly here. From inside
    // it, `git add -A` exits 0 and stages nothing, commit() returns null, and
    // null is the ordinary "nothing to commit" answer a debounced auto-committer
    // gets all day. The server runs perfectly and records no history at all.
    const outer = await makeTemporaryDirectory()
    await git(outer, ['init', '--quiet', '-b', 'main', '.'])
    await fs.writeFile(nodePath.join(outer, '.gitignore'), 'notes-dev/\n')

    const nested = nodePath.join(outer, 'notes-dev')
    await fs.mkdir(nested)

    const status = await inspectRoot(nested)

    expect(status.exists).toBe(true)
    // --is-inside-work-tree would have said "yes, this is fine" here.
    expect(status.gitToplevel).toBe(outer)
    expect(status.gitToplevel).not.toBe(status.realPath)

    const report = evaluatePreflight(allPresent, status, healthyRemote())
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: 'root-inside-another-repository', toplevel: outer }),
    )
  })

  it('also catches a non-ignored subdirectory of another repository', async () => {
    // The inverse failure, and the worse one: `git add -A` from a subdirectory
    // stages the whole outer work tree, so auto-commit starts committing
    // unrelated files into somebody else's repository.
    const outer = await makeTemporaryDirectory()
    await git(outer, ['init', '--quiet', '-b', 'main', '.'])

    const nested = nodePath.join(outer, 'notes')
    await fs.mkdir(nested)

    expect((await inspectRoot(nested)).gitToplevel).toBe(outer)
  })
})

describe('logPreflight', () => {
  it('logs resolved paths and versions even when everything is fine', async () => {
    // "which nvim is this" is the first question anyone asks when the terminal
    // misbehaves; the answer should already be in the log.
    const lines: string[] = []
    const logger = {
      info: (message: string) => lines.push(`info ${message}`),
      warn: (message: string) => lines.push(`warn ${message}`),
      error: (message: string) => lines.push(`error ${message}`),
    }

    logPreflight(evaluatePreflight(allPresent, healthyRoot(), healthyRemote()), logger)

    expect(lines.some((line) => line.includes('/usr/bin/nvim') && line.includes('nvim 1.0'))).toBe(
      true,
    )
    expect(lines.every((line) => line.startsWith('info'))).toBe(true)
  })

  it('logs a missing optional binary as a warning and a fatal one as an error', () => {
    const lines: string[] = []
    const logger = {
      info: () => {},
      warn: (message: string) => lines.push(`warn ${message}`),
      error: (message: string) => lines.push(`error ${message}`),
    }

    logPreflight(
      evaluatePreflight(
        [binary('git', 'required', false), binary('rg', 'optional', false)],
        healthyRoot(),
        healthyRemote(),
      ),
      logger,
    )

    expect(lines.filter((line) => line.startsWith('error'))).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith('warn'))).toHaveLength(1)
  })
})
