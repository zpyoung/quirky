import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

const scratch = mkdtempSync(join(tmpdir(), 'qd-wt-'))
const savedEnv: Record<string, string | undefined> = {}
let t: PluginHarness
let client: QuirkyClient
let repoDir: string
let repo: Repo
let counter = 0

beforeAll(() => {
  for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function makeRepo(): string {
  const dir = join(scratch, `repo-${counter++}`)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return realpathSync(dir)
}

const call = (method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

/** Creates a worktree and returns its record (the create result's `worktree`). */
const createWt = async (params: Record<string, unknown>) => ((await call('quirky.worktree/create', params)) as WorktreeCreateResult).worktree

async function errorOf(promise: Promise<unknown>): Promise<{ code: number | null; message: string }> {
  try {
    await promise
    return { code: null, message: '' }
  } catch (error) {
    return { code: (error as RpcError).code, message: (error as Error).message }
  }
}

beforeEach(async () => {
  t = await startPluginHarness({ realGit: true })
  client = t.client
  repoDir = makeRepo()
  repo = (await call('quirky.repo/add', { path: repoDir })) as Repo
  await call('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(scratch, `wts-${counter++}`) })
})
afterEach(() => t.cleanup())

describe('quirky.worktree/remove with real git', () => {
  test('a dirty worktree is refused with Conflict and its sessions survive', async () => {
    const worktree = await createWt({ repo: repo.id, name: 'dirty' })
    const session = (await call('quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    writeFileSync(join(worktree.path, 'untracked.txt'), 'x')

    const failure = await errorOf(call('quirky.worktree/remove', { worktree: worktree.id, yes: true }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toBe('Worktree has uncommitted or untracked changes.')
    expect(existsSync(worktree.path)).toBe(true)
    expect(t.sessions.sessions).toHaveLength(1)
    expect(t.sessions.closed).toEqual([])

    await call('quirky.worktree/remove', { worktree: worktree.id, force: true, yes: true })
    expect(existsSync(worktree.path)).toBe(false)
    expect(t.sessions.sessions).toEqual([])
    expect(t.sessions.closed).toEqual([session.id])
  })

  test('a clean worktree is removed and its sessions are closed', async () => {
    const worktree = await createWt({ repo: repo.id, name: 'clean' })
    await call('quirky.session/create', { worktree: worktree.id, agent: 'shell' })
    await call('quirky.worktree/remove', { worktree: worktree.id, yes: true })
    expect(existsSync(worktree.path)).toBe(false)
    expect(t.sessions.sessions).toEqual([])
  })
})

describe('quirky.worktree/create with an existing branch', () => {
  test('checks the branch out when nothing else has it, and keeps it on delete', async () => {
    git(repoDir, 'branch', 'feat-old')
    // D13: reusing a branch is asked for with `branch`; a plain name always makes a new prefixed branch
    const worktree = await createWt({ repo: repo.id, branch: 'feat-old' })
    expect(worktree).toMatchObject({ branch: 'feat-old', isMain: false, keepBranch: true })
    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat-old')
  })

  test('a name whose branch outlived its worktree takes the next free suffix', async () => {
    const first = await createWt({ repo: repo.id, name: 'feat-rm' })
    git(repoDir, 'worktree', 'remove', first.path)
    // D12: the branch is still there, so the same name is not handed out again
    const second = await createWt({ repo: repo.id, name: 'feat-rm' })
    expect(first.branch).toBe('Test/feat-rm')
    expect(second).toMatchObject({ branch: 'Test/feat-rm-2', name: 'feat-rm-2' })
  })

  test('a branch checked out elsewhere is a Conflict', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'busy')
    const failure = await errorOf(call('quirky.worktree/create', { repo: repo.id, branch: 'busy' }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toContain('busy')
    expect(failure.message).toContain(basename(repoDir))
    expect(failure.message.toLowerCase()).toContain('workspace')
    expect(failure.message.toLowerCase()).toContain('open')
    expect(failure.message.toLowerCase()).toContain('choose another branch')
    expect(failure.message).not.toContain(repoDir)
  })
})

describe('a symlinked worktrees root', () => {
  test('the id from create is the id list and remove use', async () => {
    const real = join(scratch, `real-root-${counter++}`)
    const link = join(scratch, `link-root-${counter++}`)
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    await call('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(link, 'nested') })

    const created = await createWt({ repo: repo.id, name: 'sym' })
    expect(created.path.startsWith(realpathSync(real))).toBe(true)
    const listed = (await call('quirky.worktree/list', { repo: repo.id })) as Worktree[]
    expect(listed.find((w) => w.id === created.id)).toMatchObject({ path: created.path, branch: 'Test/sym' })

    await call('quirky.worktree/remove', { worktree: created.id, yes: true })
    expect(existsSync(created.path)).toBe(false)
  })

  test('a repo added through a symlinked path is stored by its real path', async () => {
    const link = join(scratch, `link-repo-${counter++}`)
    symlinkSync(repoDir, link)
    const again = (await call('quirky.repo/add', { path: link })) as Repo
    expect(again.id).toBe(repo.id)
    expect(again.path).toBe(repoDir)
  })
})

describe('quirky.repo/add validation', () => {
  test('a missing directory is InvalidParams naming the path', async () => {
    const missing = join(scratch, 'does-not-exist')
    expect(await errorOf(call('quirky.repo/add', { path: missing }))).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: `no such directory: ${missing}`
    })
  })

  test('a plain directory is InvalidParams "not a git repository"', async () => {
    const plain = join(scratch, `plain-${counter++}`)
    mkdirSync(plain)
    expect(await errorOf(call('quirky.repo/add', { path: plain }))).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: `not a git repository: ${plain}; pass --folder to add it as a folder project`
    })
  })

  test('a file path is not a directory', async () => {
    const file = join(repoDir, 'a.txt')
    expect(await errorOf(call('quirky.repo/add', { path: file }))).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: `no such directory: ${file}`
    })
  })

  test('a leading ~ expands to the home directory', async () => {
    const name = `quirky-test-missing-${process.pid}-${counter++}`
    expect(await errorOf(call('quirky.repo/add', { path: `~/${name}` }))).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: `no such directory: ${join(homedir(), name)}`
    })
  })
})
