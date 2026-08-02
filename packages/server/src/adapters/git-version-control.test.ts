import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'

import { assertNotePath as notePath, type CommitRef, type SyncOutcome } from '@vim-notes/core'
import { afterAll, describe, expect, it } from 'vitest'

import { GitVersionControl, parseLog, parseStatus } from './git-version-control'

const execFileAsync = promisify(execFile)

/**
 * The developer's own `~/.gitconfig` must not reach these tests. A global
 * `commit.gpgsign`, `pull.rebase` or `init.defaultBranch` would otherwise change
 * what they observe, and the identity fallback can only be exercised in a
 * repository where no identity is configured anywhere.
 */
const HERMETIC_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const AUTHOR = { name: 'vim-notes test', email: 'notes@example.test' }

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_ENV, LC_ALL: 'C' },
  })
  return stdout
}

/** For setup steps that are supposed to fail, like provoking a merge conflict. */
async function gitExpectingFailure(cwd: string, args: string[]): Promise<void> {
  await git(cwd, args).catch(() => undefined)
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-git-'))
  temporaryDirectories.push(directory)
  // macOS puts these under /var, which is a symlink to /private/var. Resolving
  // it keeps the paths in assertions comparable with what git reports.
  return fs.realpath(directory)
}

/** A working copy with a configured identity, like a normal developer box. */
async function makeRepo(): Promise<string> {
  const root = await makeTemporaryDirectory()
  await git(root, ['init', '--quiet', '-b', 'main', '.'])
  await git(root, ['config', 'user.name', 'Repo Identity'])
  await git(root, ['config', 'user.email', 'repo@example.test'])
  return root
}

/** The bare hub of DECISIONS §2. */
async function makeHub(): Promise<string> {
  const hub = await makeTemporaryDirectory()
  await git(hub, ['init', '--quiet', '--bare', '-b', 'main', '.'])
  return hub
}

async function makeClone(hub: string): Promise<string> {
  const parent = await makeTemporaryDirectory()
  const root = nodePath.join(parent, 'notes')
  await git(parent, ['clone', '--quiet', hub, root])
  // Cloning an empty hub leaves HEAD pointing at whatever the local git calls
  // the default branch; pin it so the tests do not depend on that.
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(root, ['config', 'user.name', 'Clone Identity'])
  await git(root, ['config', 'user.email', 'clone@example.test'])
  return root
}

function makeVcs(root: string): GitVersionControl {
  return new GitVersionControl(root, { defaultAuthor: AUTHOR, env: HERMETIC_ENV })
}

async function write(root: string, name: string, content: string): Promise<void> {
  const target = nodePath.join(root, name)
  await fs.mkdir(nodePath.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

function read(root: string, name: string): Promise<string> {
  return fs.readFile(nodePath.join(root, name), 'utf8')
}

function expectCommitted(ref: CommitRef | null): CommitRef {
  if (ref === null) throw new Error('expected a commit, but nothing was committed')
  return ref
}

function expectSyncFailed(outcome: SyncOutcome) {
  if (outcome.ok) throw new Error('expected the sync to fail')
  return outcome
}

describe('GitVersionControl.commit', () => {
  it('returns null when there is nothing to commit', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    expect(await vcs.commit('nothing changed')).toBeNull()
  })

  it('returns null when a second commit follows with no further changes', async () => {
    // The debounced auto-committer produces exactly this: a timer fires after a
    // commit already swept the change up. It has to be an ordinary outcome.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'first')
    expect(await vcs.commit('save')).not.toBeNull()
    expect(await vcs.commit('save again')).toBeNull()
  })

  it('commits new, modified and deleted notes', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'keep.md', 'one')
    await write(root, 'remove.md', 'two')
    await vcs.commit('initial')

    await write(root, 'keep.md', 'one changed')
    await fs.rm(nodePath.join(root, 'remove.md'))
    await write(root, 'nested/new.md', 'three')

    const ref = expectCommitted(await vcs.commit('second'))
    expect(ref.sha).toMatch(/^[0-9a-f]{40}$/)

    const [entry] = await vcs.log({ limit: 1 })
    expect(entry?.sha).toBe(ref.sha)
    expect(entry?.paths).toEqual([
      notePath('keep.md'),
      notePath('nested/new.md'),
      notePath('remove.md'),
    ])
  })

  it('commits only the given paths', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'a.md', 'a')
    await write(root, 'b.md', 'b')

    await vcs.commit('only a', [notePath('a.md')])
    const [scoped] = await vcs.log({ limit: 1 })
    expect(scoped?.paths).toEqual([notePath('a.md')])

    // b.md is still uncommitted, so the next commit must pick it up.
    expectCommitted(await vcs.commit('then b'))
    expect((await vcs.status()).dirty).toBe(false)
  })

  it('returns null when the given paths match nothing changed', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'a.md', 'a')
    await vcs.commit('initial')

    await write(root, 'a.md', 'changed')
    expect(await vcs.commit('scoped elsewhere', [notePath('b.md')])).toBeNull()
  })

  it('still commits the paths that exist when one of them does not', async () => {
    // `git add` stages nothing at all if any pathspec matches nothing, so a
    // stale path in the list must not take the rest of the commit down with it.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'a.md', 'a')
    await vcs.commit('scoped', [notePath('a.md'), notePath('gone.md')])

    expect((await vcs.log())[0]?.paths).toEqual([notePath('a.md')])
  })

  it('falls back to the configured author when the repository has no identity', async () => {
    // A fresh container has no gitconfig at all. Git would either refuse or
    // invent an identity from the hostname; neither is acceptable silently.
    const root = await makeTemporaryDirectory()
    await git(root, ['init', '--quiet', '-b', 'main', '.'])
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('first')

    expect((await git(root, ['log', '-1', '--format=%an <%ae>'])).trim()).toBe(
      `${AUTHOR.name} <${AUTHOR.email}>`,
    )
  })

  it('prefers the identity the repository configures', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('first')

    expect((await git(root, ['log', '-1', '--format=%an <%ae>'])).trim()).toBe(
      'Repo Identity <repo@example.test>',
    )
  })

  it('refuses to commit while paths are unmerged', async () => {
    // `git commit` refuses this on its own, but `git add -A` would resolve the
    // conflict first and commit the markers as the note's new content.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'base\n')
    await vcs.commit('base')

    await git(root, ['checkout', '--quiet', '-b', 'other'])
    await write(root, 'note.md', 'from other\n')
    await vcs.commit('other')

    await git(root, ['checkout', '--quiet', 'main'])
    await write(root, 'note.md', 'from main\n')
    await vcs.commit('main')

    await gitExpectingFailure(root, ['merge', 'other'])

    const status = await vcs.status()
    expect(status.conflicted).toEqual([notePath('note.md')])

    await expect(vcs.commit('should not happen')).rejects.toThrow(/unmerged/)
    expect(await read(root, 'note.md')).toContain('<<<<<<<')
  })
})

describe('GitVersionControl.log', () => {
  it('is empty on a branch with no commits', async () => {
    const root = await makeRepo()
    expect(await makeVcs(root).log()).toEqual([])
  })

  it('preserves multi-line commit messages', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    const message = 'Update 2 notes\n\ninbox/a.md\ninbox/b.md'
    await write(root, 'inbox/a.md', 'a')
    await write(root, 'inbox/b.md', 'b')
    await vcs.commit(message)

    const entries = await vcs.log()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe(message)
    expect(entries[0]?.paths).toEqual([notePath('inbox/a.md'), notePath('inbox/b.md')])
  })

  it('survives a record separator inside a commit message', async () => {
    // The delimiter is NUL + RS precisely because a message can contain a bare
    // RS but never a NUL. A lone RS must not split the record.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    const message = `weird\u001eseparator\n\nbody\u001etoo`
    await write(root, 'note.md', 'content')
    await vcs.commit(message)

    const entries = await vcs.log()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe(message)
  })

  it('reports authoredAt in epoch milliseconds', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    const before = Date.now()
    await write(root, 'note.md', 'content')
    await vcs.commit('now')

    const entry = (await vcs.log())[0]
    expect(entry).toBeDefined()
    // Git stores whole seconds, so allow for the truncation in both directions.
    expect(entry?.authoredAt).toBeGreaterThanOrEqual(before - 1_000)
    expect(entry?.authoredAt).toBeLessThanOrEqual(Date.now() + 1_000)
    expect((entry?.authoredAt ?? 0) % 1000).toBe(0)
  })

  it('honours limit and path scoping, newest first', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'a.md', 'a1')
    await vcs.commit('first')
    await write(root, 'b.md', 'b1')
    await vcs.commit('second')
    await write(root, 'a.md', 'a2')
    await vcs.commit('third')

    expect((await vcs.log()).map((entry) => entry.message)).toEqual(['third', 'second', 'first'])
    expect((await vcs.log({ limit: 2 })).map((entry) => entry.message)).toEqual(['third', 'second'])
    expect((await vcs.log({ path: notePath('a.md') })).map((entry) => entry.message)).toEqual([
      'third',
      'first',
    ])
  })

  it('drops paths that are not valid notes rather than failing the read', async () => {
    // `aux.md` is unusable on Windows, so NotePath rejects it -- but nothing
    // stops rsync or a stray script from putting one in the notes directory.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'aux.md', 'reserved on windows')
    await write(root, 'fine.md', 'ordinary')
    await vcs.commit('mixed')

    expect((await vcs.log())[0]?.paths).toEqual([notePath('fine.md')])
  })
})

describe('GitVersionControl.diff and restore', () => {
  it('diffs a commit against its parent', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'first\n')
    await vcs.commit('one')
    await write(root, 'note.md', 'second\n')
    const ref = expectCommitted(await vcs.commit('two'))

    const patch = await vcs.diff(ref)
    expect(patch).toContain('-first')
    expect(patch).toContain('+second')
    expect(patch.startsWith('diff --git')).toBe(true)
  })

  it('scopes a diff to one path', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'a.md', 'a1\n')
    await write(root, 'b.md', 'b1\n')
    await vcs.commit('one')

    await write(root, 'a.md', 'a2\n')
    await write(root, 'b.md', 'b2\n')
    const ref = expectCommitted(await vcs.commit('two'))

    const patch = await vcs.diff(ref, notePath('a.md'))
    expect(patch).toContain('+a2')
    expect(patch).not.toContain('+b2')
  })

  it('restores content at a ref without writing it', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'version one\n')
    const first = expectCommitted(await vcs.commit('one'))
    await write(root, 'note.md', 'version two\n')
    await vcs.commit('two')

    expect(await vcs.restore(notePath('note.md'), first)).toBe('version one\n')
    // Writing is NoteStore's job, so the file on disk must be untouched.
    expect(await read(root, 'note.md')).toBe('version two\n')
  })

  it('throws when the path does not exist at that ref', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    const ref = expectCommitted(await vcs.commit('one'))

    await expect(vcs.restore(notePath('missing.md'), ref)).rejects.toThrow(/does not exist/)
  })
})

describe('GitVersionControl.status', () => {
  it('reports the branch and a clean tree', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('one')

    expect(await vcs.status()).toEqual({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      conflicted: [],
    })
  })

  it('counts an untracked note as dirty', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'committed.md', 'content')
    await vcs.commit('one')
    await write(root, 'new.md', 'unsaved')

    expect((await vcs.status()).dirty).toBe(true)
  })

  it('parses a rename without misreading the following entry', async () => {
    // A rename entry carries a second path field; skipping it wrong would make
    // the original path look like a new entry.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'old.md', 'content')
    await vcs.commit('one')
    await git(root, ['mv', 'old.md', 'new.md'])
    await write(root, 'untracked.md', 'later')

    const status = await vcs.status()
    expect(status).toMatchObject({ branch: 'main', dirty: true, conflicted: [] })
  })

  it('ignores a conflicted path that is not a valid note', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'aux.md', 'base\n')
    await vcs.commit('base')

    await git(root, ['checkout', '--quiet', '-b', 'other'])
    await write(root, 'aux.md', 'other\n')
    await vcs.commit('other')
    await git(root, ['checkout', '--quiet', 'main'])
    await write(root, 'aux.md', 'main\n')
    await vcs.commit('main')
    await gitExpectingFailure(root, ['merge', 'other'])

    const status = await vcs.status()
    expect(status.conflicted).toEqual([])
    expect(status.dirty).toBe(true)
  })
})

describe('GitVersionControl.sync', () => {
  it('reports no-remote when nothing is configured', async () => {
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('one')

    const outcome = expectSyncFailed(await vcs.sync())
    expect(outcome.reason).toBe('no-remote')
  })

  it('reports no-remote even when the working tree is dirty', async () => {
    // `git pull --rebase` checks the working tree before the remote and would
    // call this one dirty, which sends the caller after the wrong problem.
    const root = await makeRepo()
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('one')
    await write(root, 'note.md', 'uncommitted')

    expect(expectSyncFailed(await vcs.sync()).reason).toBe('no-remote')
  })

  it('reports network failure when the hub is unreachable', async () => {
    const root = await makeRepo()
    await git(root, ['remote', 'add', 'origin', nodePath.join(root, 'nowhere.git')])
    const vcs = makeVcs(root)

    await write(root, 'note.md', 'content')
    await vcs.commit('one')

    const outcome = expectSyncFailed(await vcs.sync())
    expect(outcome.reason).toBe('network')
    expect(outcome).toHaveProperty(
      'message',
      expect.stringContaining('does not appear to be a git repository'),
    )
  })

  it('pushes to the hub and pulls into a second clone', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)
    const server = await makeClone(hub)

    await write(laptop, 'note.md', 'from the laptop\n')
    await makeVcs(laptop).commit('one')
    await write(laptop, 'second.md', 'more\n')
    await makeVcs(laptop).commit('two')

    expect(await makeVcs(laptop).sync()).toEqual({ ok: true, pulled: 0, pushed: 2 })

    // The server clone was made while the hub was empty, so its branch has no
    // commits behind it at all -- the case `git rebase` cannot handle.
    expect(await makeVcs(server).sync()).toEqual({ ok: true, pulled: 2, pushed: 0 })
    expect(await read(server, 'note.md')).toBe('from the laptop\n')

    expect(await makeVcs(server).status()).toEqual({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      conflicted: [],
    })
  }, 30_000)

  it('rebases local commits on top of the hub', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)
    const server = await makeClone(hub)

    await write(laptop, 'shared.md', 'base\n')
    await makeVcs(laptop).commit('base')
    await makeVcs(laptop).sync()
    await makeVcs(server).sync()

    await write(laptop, 'laptop.md', 'from the laptop\n')
    await makeVcs(laptop).commit('laptop')
    await makeVcs(laptop).sync()

    await write(server, 'server.md', 'from the server\n')
    await makeVcs(server).commit('server')
    expect((await makeVcs(server).status()).ahead).toBe(1)

    expect(await makeVcs(server).sync()).toEqual({ ok: true, pulled: 1, pushed: 1 })
    expect(await read(server, 'laptop.md')).toBe('from the laptop\n')

    // The hub now holds both, which is the whole point of the topology.
    await makeVcs(laptop).sync()
    expect(await read(laptop, 'server.md')).toBe('from the server\n')
  }, 30_000)

  it('returns the conflicting notes and leaves no rebase in progress', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)
    const server = await makeClone(hub)

    await write(laptop, 'shared.md', 'base\n')
    await makeVcs(laptop).commit('base')
    await makeVcs(laptop).sync()
    await makeVcs(server).sync()

    await write(laptop, 'shared.md', 'edited on the laptop\n')
    await makeVcs(laptop).commit('laptop edit')
    await makeVcs(laptop).sync()

    await write(server, 'shared.md', 'edited on the server\n')
    await makeVcs(server).commit('server edit')

    const outcome = await makeVcs(server).sync()
    expect(outcome).toEqual({ ok: false, reason: 'conflict', conflicted: [notePath('shared.md')] })

    // Aborted, not left half-done: a rebase in progress detaches HEAD and
    // leaves conflict markers that the auto-committer would commit as content.
    const status = await makeVcs(server).status()
    expect(status.branch).toBe('main')
    expect(status.conflicted).toEqual([])
    expect(await read(server, 'shared.md')).toBe('edited on the server\n')
    await expect(fs.access(nodePath.join(server, '.git', 'rebase-merge'))).rejects.toThrow()
  }, 30_000)

  it('refuses to rebase over uncommitted work', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)
    const server = await makeClone(hub)

    await write(laptop, 'shared.md', 'base\n')
    await makeVcs(laptop).commit('base')
    await makeVcs(laptop).sync()
    await makeVcs(server).sync()

    await write(laptop, 'shared.md', 'edited on the laptop\n')
    await makeVcs(laptop).commit('laptop edit')
    await makeVcs(laptop).sync()

    // nvim is midway through a write on the server: changed, not yet committed.
    await write(server, 'shared.md', 'half-typed\n')

    const outcome = expectSyncFailed(await makeVcs(server).sync())
    expect(outcome.reason).toBe('dirty')
    expect(await read(server, 'shared.md')).toBe('half-typed\n')

    // The fetch still happened, so status can now say how far behind we are.
    expect(await makeVcs(server).status()).toMatchObject({ dirty: true, behind: 1, ahead: 0 })
  }, 30_000)

  it('reports a conflict when the hub rejects the push outright', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)

    const hook = nodePath.join(hub, 'hooks', 'pre-receive')
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    await write(laptop, 'note.md', 'content\n')
    await makeVcs(laptop).commit('one')

    const outcome = await makeVcs(laptop).sync()
    expect(outcome).toEqual({ ok: false, reason: 'conflict', conflicted: [] })
  }, 30_000)

  it('is a no-op when neither side has any commits yet', async () => {
    // A notes directory that has been provisioned but never written to.
    const hub = await makeHub()
    const server = await makeClone(hub)

    expect(await makeVcs(server).sync()).toEqual({ ok: true, pulled: 0, pushed: 0 })
  }, 30_000)

  it('is a no-op when the hub is already up to date', async () => {
    const hub = await makeHub()
    const laptop = await makeClone(hub)

    await write(laptop, 'note.md', 'content\n')
    await makeVcs(laptop).commit('one')
    await makeVcs(laptop).sync()

    expect(await makeVcs(laptop).sync()).toEqual({ ok: true, pulled: 0, pushed: 0 })
  }, 30_000)
})

describe('parsers', () => {
  it('reads porcelain v2 branch headers', () => {
    const status = parseStatus(
      ['# branch.oid abc123', '# branch.head main', '# branch.ab +3 -2', ''].join('\0'),
    )
    expect(status).toMatchObject({ branch: 'main', ahead: 3, behind: 2, changed: false })
  })

  it('treats a detached head verbatim rather than inventing a branch', () => {
    expect(parseStatus('# branch.head (detached)\0').branch).toBe('(detached)')
  })

  it('reads the path out of an unmerged entry', () => {
    const entry = 'u UU N... 100644 100644 100644 100644 aaa bbb ccc notes/conflict.md'
    expect(parseStatus(`${entry}\0`).unmerged).toEqual(['notes/conflict.md'])
  })

  it('skips the original path of a rename', () => {
    const rename = '2 R. N... 100644 100644 100644 aaa bbb R100 new.md'
    const status = parseStatus(`${rename}\0old.md\0? untracked.md\0`)
    expect(status).toMatchObject({ changed: true, trackedChanged: true, unmerged: [] })
  })

  it('treats untracked files as dirty but not as tracked changes', () => {
    expect(parseStatus('? new.md\0')).toMatchObject({ changed: true, trackedChanged: false })
  })

  it('ignores a truncated record rather than throwing', () => {
    expect(parseLog('\u0000\u001eabc123')).toEqual([])
    expect(parseLog('')).toEqual([])
  })
})
