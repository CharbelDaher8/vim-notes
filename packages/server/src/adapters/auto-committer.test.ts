import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'

import {
  assertNotePath as notePath,
  type CommitEntry,
  type CommitRef,
  type NotePath,
  type RepoStatus,
  type SyncOutcome,
  type VersionControl,
} from '@vim-notes/core'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutoCommitter, describeChange } from './auto-committer'
import { GitVersionControl } from './git-version-control'

const execFileAsync = promisify(execFile)

/**
 * Records what it was asked to commit. The debounce policy is the thing under
 * test here, and it has nothing to do with git -- driving a real repository
 * would only make the timing assertions slower and flakier.
 */
class FakeVersionControl implements VersionControl {
  readonly messages: string[] = []
  private sequence = 0

  handler: (message: string) => Promise<CommitRef | null> = async () => ({
    sha: `sha-${++this.sequence}`,
  })

  async commit(message: string): Promise<CommitRef | null> {
    this.messages.push(message)
    return this.handler(message)
  }

  log(): Promise<CommitEntry[]> {
    throw new Error('the auto-committer does not read history')
  }

  diff(): Promise<string> {
    throw new Error('the auto-committer does not diff')
  }

  restore(): Promise<string> {
    throw new Error('the auto-committer does not restore')
  }

  status(): Promise<RepoStatus> {
    throw new Error('the auto-committer does not read status')
  }

  sync(): Promise<SyncOutcome> {
    throw new Error('the auto-committer does not sync')
  }
}

/** Lets a chained promise settle without leaning on timer internals. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve()
}

const a = notePath('a.md')
const b = notePath('b.md')

describe('AutoCommitter', () => {
  let versionControl: FakeVersionControl

  beforeEach(() => {
    vi.useFakeTimers()
    versionControl = new FakeVersionControl()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid saves into a single commit', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    committer.recordSave(a)
    await vi.advanceTimersByTimeAsync(500)
    committer.recordSave(b)
    await vi.advanceTimersByTimeAsync(500)
    committer.recordSave(a)

    // Each save pushed the deadline back, so nothing has been committed yet.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(versionControl.messages).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(versionControl.messages).toHaveLength(1)
    expect(versionControl.messages[0]).toContain('a.md')
    expect(versionControl.messages[0]).toContain('b.md')
  })

  it('commits again for saves that arrive after the first commit', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    committer.recordSave(a)
    await vi.advanceTimersByTimeAsync(2_000)
    committer.recordSave(b)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(versionControl.messages).toEqual(['Update a.md', 'Update b.md'])
  })

  it('commits at the maximum delay when saves never stop', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000, maxDelayMs: 5_000 })

    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      committer.recordSave(a)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    // Without the cap the idle window would have been pushed back forever.
    expect(versionControl.messages).toHaveLength(1)
  })

  it('reports whether a commit is owed', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })
    expect(committer.hasPending).toBe(false)

    committer.recordSave(a)
    expect(committer.hasPending).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(committer.hasPending).toBe(false)
  })

  it('flush commits immediately and cancels the pending timer', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    committer.recordSave(a)
    expect(await committer.flush()).toEqual({ sha: 'sha-1' })
    expect(versionControl.messages).toEqual(['Update a.md'])

    // The debounce timer must not fire a second, redundant commit.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionControl.messages).toHaveLength(1)
  })

  it('flush commits even with nothing recorded', async () => {
    // At shutdown the tree may hold writes this process never saw -- nvim in the
    // pty writes straight to disk. commit() returning null makes this cheap.
    versionControl.handler = async () => null
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    expect(await committer.flush()).toBeNull()
    expect(versionControl.messages).toEqual(['Update notes'])
  })

  it('does not lose saves that arrive while a commit is running', async () => {
    let releaseFirst: (ref: CommitRef | null) => void = () => {}
    let calls = 0
    versionControl.handler = (): Promise<CommitRef | null> => {
      calls += 1
      if (calls > 1) return Promise.resolve({ sha: 'later' })
      return new Promise((resolve) => {
        releaseFirst = resolve
      })
    }

    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    committer.recordSave(a)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(versionControl.messages).toEqual(['Update a.md'])

    committer.recordSave(b)
    await vi.advanceTimersByTimeAsync(2_000)
    // The second commit waits for the first rather than interleaving with it.
    expect(versionControl.messages).toEqual(['Update a.md'])

    releaseFirst({ sha: 'first' })
    await settle()
    expect(versionControl.messages).toEqual(['Update a.md', 'Update b.md'])
  })

  it('reports a failing commit and keeps working afterwards', async () => {
    const errors: unknown[] = []
    versionControl.handler = async () => {
      throw new Error('index.lock exists')
    }
    const committer = new AutoCommitter(versionControl, {
      idleMs: 2_000,
      onError: (error) => errors.push(error),
    })

    committer.recordSave(a)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('index.lock exists')

    versionControl.handler = async () => ({ sha: 'recovered' })
    committer.recordSave(b)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(versionControl.messages).toHaveLength(2)
  })

  it('ignores saves after stop', async () => {
    const committer = new AutoCommitter(versionControl, { idleMs: 2_000 })

    committer.recordSave(a)
    await committer.stop()
    expect(versionControl.messages).toEqual(['Update a.md'])

    committer.recordSave(b)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionControl.messages).toHaveLength(1)
  })
})

describe('describeChange', () => {
  it('names a single note', () => {
    expect(describeChange([notePath('inbox/idea.md')])).toBe('Update inbox/idea.md')
  })

  it('lists several notes under a subject line', () => {
    expect(describeChange([a, b])).toBe('Update 2 notes\n\na.md\nb.md')
  })

  it('truncates a very large batch', () => {
    const paths: NotePath[] = Array.from({ length: 25 }, (_, index) =>
      notePath(`note-${String(index).padStart(2, '0')}.md`),
    )
    const message = describeChange(paths)

    expect(message.startsWith('Update 25 notes\n\n')).toBe(true)
    expect(message).toContain('...and 5 more')
    expect(message).not.toContain('note-20.md')
  })

  it('says something sensible with no paths at all', () => {
    expect(describeChange([])).toBe('Update notes')
  })
})

describe('AutoCommitter over a real repository', () => {
  const temporaryDirectories: string[] = []

  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    )
  })

  it('turns a burst of writes into one commit', async () => {
    const root = await fs.mkdtemp(nodePath.join(tmpdir(), 'vim-notes-auto-'))
    temporaryDirectories.push(root)

    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    await execFileAsync('git', ['init', '--quiet', '-b', 'main', '.'], { cwd: root, env })

    const versionControl = new GitVersionControl(root, {
      defaultAuthor: { name: 'vim-notes test', email: 'notes@example.test' },
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    const committer = new AutoCommitter(versionControl, { idleMs: 25 })

    await fs.writeFile(nodePath.join(root, 'one.md'), 'first', 'utf8')
    committer.recordSave(notePath('one.md'))
    await fs.writeFile(nodePath.join(root, 'two.md'), 'second', 'utf8')
    committer.recordSave(notePath('two.md'))

    const ref = await committer.flush()
    expect(ref).not.toBeNull()

    const history = await versionControl.log()
    expect(history).toHaveLength(1)
    expect(history[0]?.paths).toEqual([notePath('one.md'), notePath('two.md')])
    expect(history[0]?.message).toBe('Update 2 notes\n\none.md\ntwo.md')
    expect((await versionControl.status()).dirty).toBe(false)

    // Nothing left to do, so a shutdown flush is a no-op rather than an error.
    expect(await committer.stop()).toBeNull()
  }, 20_000)
})
