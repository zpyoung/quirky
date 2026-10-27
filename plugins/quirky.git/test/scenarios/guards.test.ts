import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createErrors } from '../../src/daemon/errors'
import { createLock } from '../../src/daemon/lock'
import { OpenedConflicts } from '../../src/daemon/opened'
import { containedPath, OutsideWorktreeError } from '../../src/daemon/paths'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qg-paths-')))
  roots.push(root)
  const worktree = join(root, 'wt')
  const outside = join(root, 'outside')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(worktree, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(outside, 'secret.txt'), 's\n')
  symlinkSync(outside, join(worktree, 'out'))
  symlinkSync(join(outside, 'secret.txt'), join(worktree, 'link.txt'))
  symlinkSync(join(root, 'missing'), join(worktree, 'dangling'))
  return { root, worktree, outside }
}

const fakeContext = { error: (kind: string, message: string) => Object.assign(new Error(message), { kind, code: -1 }) }

describe('containedPath', () => {
  test('accepts files, folders that do not exist yet, and a leaf symlink without following it', async () => {
    const { worktree } = tree()
    expect(await containedPath(worktree, 'src/a.ts')).toMatchObject({ rel: 'src/a.ts', absolute: join(worktree, 'src/a.ts') })
    expect((await containedPath(worktree, 'src/a.ts')).leaf?.isFile()).toBe(true)
    expect((await containedPath(worktree, 'src/gone/deeper/x.ts')).leaf).toBeNull()
    expect((await containedPath(worktree, 'src/')).rel).toBe('src')
    expect((await containedPath(worktree, 'src/../src/a.ts')).rel).toBe('src/a.ts')
    expect((await containedPath(worktree, 'link.txt')).leaf?.isSymbolicLink()).toBe(true)
  })

  test('rejects absolute paths, parent segments, empty paths, NUL, and anything resolving outside through a symlink', async () => {
    const { worktree } = tree()
    for (const bad of [join(worktree, 'src/a.ts'), '/etc/passwd', '../x', 'src/../../x', '..', '', '.', 'a\0b', 'out/x.txt', 'out/deeper/x.txt', 'dangling/x.txt']) {
      await expect(containedPath(worktree, bad), JSON.stringify(bad)).rejects.toBeInstanceOf(OutsideWorktreeError)
    }
  })
})

describe('createLock', () => {
  const errors = createErrors(fakeContext as never)

  test('a second call is refused at once, naming the held operation, and the lock frees on success and on failure', async () => {
    const lock = createLock(errors)
    let release!: () => void
    const held = lock.withLock('wt1', 'force-push', () => new Promise<void>((resolve) => (release = resolve)))
    expect(lock.heldBy('wt1')).toBe('force-push')
    expect(lock.heldBy('wt2')).toBeNull()
    await expect(lock.withLock('wt1', 'fetch', async () => 1)).rejects.toMatchObject({
      message: 'A force push is already running in this worktree.',
      data: { reason: 'busy' }
    })
    expect(await lock.withLock('wt2', 'fetch', async () => 'other worktree')).toBe('other worktree')
    release()
    await held
    expect(lock.heldBy('wt1')).toBeNull()
    await expect(lock.withLock('wt1', 'pull', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await lock.withLock('wt1', 'fast-forward', async () => 'free')).toBe('free')
  })

  test('labels every operation', async () => {
    const labels: Record<string, string> = {
      push: 'push', 'force-push': 'force push', pull: 'pull', 'fast-forward': 'fast-forward', fetch: 'fetch', sync: 'sync',
      rebase: 'rebase', continue: 'continue', abort: 'abort'
    }
    for (const [op, label] of Object.entries(labels)) {
      const lock = createLock(errors)
      void lock.withLock('wt', op as never, () => new Promise(() => {}))
      await expect(lock.withLock('wt', 'push', async () => 0)).rejects.toMatchObject({
        message: `A ${label} is already running in this worktree.`
      })
    }
  })
})

describe('OpenedConflicts', () => {
  test('keeps a path for its operation and drops it for another operation or head', () => {
    const opened = new OpenedConflicts()
    opened.record('wt', 'merge', 'h1', { path: 'a.ts', kind: 'both_modified' })
    opened.record('wt', 'merge', 'h1', { path: 'b.ts', kind: 'both_added' })
    expect(opened.list('wt', 'merge', 'h1')).toEqual([
      { path: 'a.ts', kind: 'both_modified' },
      { path: 'b.ts', kind: 'both_added' }
    ])
    expect(opened.list('other', 'merge', 'h1')).toEqual([])
    expect(opened.list('wt', 'merge', 'h2')).toEqual([])
    expect(opened.list('wt', 'merge', 'h1')).toEqual([])

    opened.record('wt', 'rebase', 'h3', { path: 'c.ts', kind: 'deleted_by_us' })
    opened.record('wt', 'rebase', 'h4', { path: 'd.ts', kind: 'deleted_by_us' })
    expect(opened.list('wt', 'rebase', 'h4')).toEqual([{ path: 'd.ts', kind: 'deleted_by_us' }])
    opened.clear('wt')
    expect(opened.list('wt', 'rebase', 'h4')).toEqual([])
  })
})

describe('createErrors', () => {
  test('redacts credentials in the message and in every data string', () => {
    const errors = createErrors(fakeContext as never)
    const error = errors.reasoned('conflict', 'failed', 'push to https://user:secret@host/repo failed', {
      output: ['remote: https://token@host/x'],
      nested: { url: 'ssh://deploy:pw@host/y' }
    }) as Error & { data: unknown }
    expect(error.message).toBe('push to https://***@host/repo failed')
    expect(error.data).toEqual({ reason: 'failed', output: ['remote: https://***@host/x'], nested: { url: 'ssh://***@host/y' } })
  })
})
