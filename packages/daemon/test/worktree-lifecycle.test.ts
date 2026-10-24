import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type Repo } from '@quirky/protocol'
import * as realGit from '../src/git'
import { startHarness, type Harness } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'qd-wt-'))
const savedEnv: Record<string, string | undefined> = {}
let h: Harness
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

async function errorCode(promise: Promise<unknown>): Promise<{ code: number | null; message: string }> {
  try {
    await promise
    return { code: null, message: '' }
  } catch (error) {
    return { code: (error as RpcError).code, message: (error as Error).message }
  }
}

beforeEach(async () => {
  h = await startHarness({ git: realGit })
  client = await h.connect('cli')
  repoDir = makeRepo()
  repo = await client.call('repo.add', { path: repoDir })
  await client.call('settings.set', { worktreesRoot: join(scratch, `wts-${counter++}`) })
})
afterEach(() => h.cleanup())

describe('worktree.remove', () => {
  test('a dirty worktree is refused with Conflict and its sessions survive', async () => {
    const worktree = await client.call('worktree.create', { repoId: repo.id, name: 'dirty' })
    const session = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    writeFileSync(join(worktree.path, 'untracked.txt'), 'x')

    const failure = await errorCode(client.call('worktree.remove', { worktreeId: worktree.id }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toContain('untracked')
    expect(failure.message).toContain('force')
    expect(existsSync(worktree.path)).toBe(true)
    expect(await client.call('session.list', {})).toHaveLength(1)
    expect(h.pty.requests.some((r) => r.type === 'forget')).toBe(false)

    await client.call('worktree.remove', { worktreeId: worktree.id, force: true })
    expect(existsSync(worktree.path)).toBe(false)
    expect(await client.call('session.list', {})).toEqual([])
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
  })

  test('a clean worktree is removed and its sessions are closed afterwards', async () => {
    const worktree = await client.call('worktree.create', { repoId: repo.id, name: 'clean' })
    await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    await client.call('worktree.remove', { worktreeId: worktree.id })
    expect(existsSync(worktree.path)).toBe(false)
    expect(await client.call('session.list', {})).toEqual([])
  })
})

describe('worktree.create with an existing branch', () => {
  test('checks the branch out when nothing else has it', async () => {
    git(repoDir, 'branch', 'feat-old')
    const worktree = await client.call('worktree.create', { repoId: repo.id, name: 'feat-old' })
    expect(worktree).toMatchObject({ branch: 'feat-old', isMain: false })
    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat-old')
  })

  test('recreating a removed worktree name works because the branch is reused', async () => {
    const first = await client.call('worktree.create', { repoId: repo.id, name: 'feat-rm' })
    await client.call('worktree.remove', { worktreeId: first.id })
    const second = await client.call('worktree.create', { repoId: repo.id, name: 'feat-rm' })
    expect(second.branch).toBe('feat-rm')
  })

  test('a branch checked out elsewhere is a Conflict', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'busy')
    const failure = await errorCode(client.call('worktree.create', { repoId: repo.id, name: 'busy' }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toContain('busy')
  })
})

describe('symlinked worktreesRoot', () => {
  test('the id from create is the id list and remove use', async () => {
    const real = join(scratch, `real-root-${counter++}`)
    const link = join(scratch, `link-root-${counter++}`)
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    await client.call('settings.set', { worktreesRoot: join(link, 'nested') })

    const created = await client.call('worktree.create', { repoId: repo.id, name: 'sym' })
    expect(created.path.startsWith(realpathSync(real))).toBe(true)
    const listed = await client.call('worktree.list', { repoId: repo.id })
    expect(listed.find((w) => w.id === created.id)).toMatchObject({ path: created.path, branch: 'sym' })

    const session = await client.call('session.create', { worktreeId: created.id, agent: 'shell' })
    expect(session.cwd).toBe(created.path)
    await client.call('worktree.remove', { worktreeId: created.id })
    expect(existsSync(created.path)).toBe(false)
  })

  test('a repo added through a symlinked path is stored by its real path', async () => {
    const link = join(scratch, `link-repo-${counter++}`)
    symlinkSync(repoDir, link)
    const again = await client.call('repo.add', { path: link })
    expect(again.id).toBe(repo.id)
    expect(again.path).toBe(repoDir)
  })
})

describe('repo.add validation', () => {
  test('a missing directory is InvalidParams naming the path', async () => {
    const missing = join(scratch, 'does-not-exist')
    const failure = await errorCode(client.call('repo.add', { path: missing }))
    expect(failure).toEqual({ code: RpcErrorCode.InvalidParams, message: `no such directory: ${missing}` })
  })

  test('a plain directory is InvalidParams "not a git repository"', async () => {
    const plain = join(scratch, `plain-${counter++}`)
    mkdirSync(plain)
    const failure = await errorCode(client.call('repo.add', { path: plain }))
    expect(failure).toEqual({ code: RpcErrorCode.InvalidParams, message: `not a git repository: ${plain}` })
  })

  test('a file path is not a directory', async () => {
    const file = join(repoDir, 'a.txt')
    const failure = await errorCode(client.call('repo.add', { path: file }))
    expect(failure).toEqual({ code: RpcErrorCode.InvalidParams, message: `no such directory: ${file}` })
  })

  test('a leading ~ expands to the home directory', async () => {
    const name = `quirky-test-missing-${process.pid}-${counter++}`
    const failure = await errorCode(client.call('repo.add', { path: `~/${name}` }))
    expect(failure).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: `no such directory: ${join(homedir(), name)}`
    })
  })
})
