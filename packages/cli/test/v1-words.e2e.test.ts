import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Session, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import { startHarness, waitFor, type Harness } from '../../daemon/test/helpers'
import { fakeRegistrations } from '../../../plugins/quirky.worktree/test/fixtures/fake-git'
import { runCli } from './fixtures/fake-daemon'

const BUILTIN_PLUGINS = join(import.meta.dir, '../../../plugins')

let h: Harness
let git: FakeGit
let scratch: string
let apiDir: string
let worktreesRoot: string

beforeEach(async () => {
  process.env.QUIRKY_TEST_ENTER_DELAY_MS = '20'
  scratch = realpathSync(mkdtempSync('/tmp/qv-'))
  apiDir = join(scratch, 'api')
  worktreesRoot = join(scratch, 'trees')
  mkdirSync(apiDir)
  git = createFakeGit()
  fakeRegistrations(git)
  git.addRepo(apiDir)
  useTestGit(git)
  h = await startHarness({ builtinPluginsDir: BUILTIN_PLUGINS })
  const client = await h.connect('cli')
  await client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })
  h.pty.setReadResult({ lines: ['one', 'two', 'three'], cols: 80, rows: 24, alt: false })
})

afterEach(async () => {
  delete process.env.QUIRKY_TEST_ENTER_DELAY_MS
  useTestGit(null)
  await h.cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

const run = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
  runCli(args, { home: h.home, cwd: options.cwd ?? apiDir, env: options.env })

/** Runs `args` and returns stdout, failing the test with stderr when the exit code is not 0. */
async function ok(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const result = await run(args, options)
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
  expect(result.stderr).toBe('')
  return result.stdout
}

const json = async <T = unknown>(args: string[], options?: { cwd?: string; env?: Record<string, string> }) =>
  JSON.parse(await ok([...args, '--json'], options)) as T

describe('SC-20: v1 command lines run through the plugins', () => {
  test('SC-20: JSON lifecycle exercises plugins and terminal output', async () => {
    const repo = await json<Repo>(['repo', 'add', apiDir])
    expect(repo.id).toMatch(/^repo_[0-9a-f]+$/)
    expect(repo).toMatchObject({ name: 'api', path: apiDir })

    const [main] = await json<Worktree[]>(['wt', 'list', '--repo', repo.id])
    expect(main.repoId).toBe(repo.id)
    const { worktree } = await json<WorktreeCreateResult>(['wt', 'create', 'api', 'feature-x', '--base', 'main'])
    expect(worktree.id).toMatch(/^wt_[0-9a-f]+$/)
    expect(worktree).toMatchObject({ repoId: repo.id, name: 'feature-x', branch: 'feature-x' })

    const session = await json<Session>(['session', 'new', '--agent', 'shell'])
    expect(session).toMatchObject({ status: 'running', worktreeId: main.id })

    await ok(['term', 'send', session.id, 'echo hi', '--enter'])
    await waitFor(() => h.pty.inputs.length === 1)
    expect(h.pty.inputs[0]).toEqual({ sessionId: session.id, text: 'echo hi\r' })
    expect(await ok(['term', 'read', session.id, '--lines', '5'])).toBe('one\ntwo\nthree\n')

    await ok(['session', 'close', session.id])
    expect(await json<Session[]>(['session', 'list'])).toEqual([])

    await ok(['wt', 'rm', 'feature-x', '--yes'])
    expect((await json<Worktree[]>(['wt', 'list', '--repo', repo.id])).map((wt) => wt.id)).toEqual([main.id])
    await ok(['repo', 'rm', 'api'])
    expect(await json<Repo[]>(['repo', 'list'])).toEqual([])
  })

  test('SC-20: repo and worktree positionals take selectors and v1 plain IDs', async () => {
    const repo = await json<Repo>(['repo', 'add', apiDir])
    const [main] = await json<Worktree[]>(['wt', 'list', '--repo', repo.id])
    for (const selector of [repo.id, repo.name, `name:${repo.name}`, `id:${repo.id}`]) {
      const listed = await json<Worktree[]>(['wt', 'list', '--repo', selector])
      expect(listed.map((wt) => wt.id)).toContain(main.id)
    }
    const { worktree: created } = await json<WorktreeCreateResult>(['wt', 'create', repo.id, 'by-id'])
    expect(created.repoId).toBe(repo.id)

    await ok(['wt', 'rm', created.id, '--yes'])
    expect((await json<Worktree[]>(['wt', 'list', '--repo', repo.id])).map((wt) => wt.id)).toEqual([main.id])
    await ok(['repo', 'rm', repo.id])
    expect(await json<Repo[]>(['repo', 'list'])).toEqual([])
  })
})

describe('SC-21: session and terminal commands default from the session env', () => {
  test('SC-21: term read reads the env session and session new starts a shell in the env worktree', async () => {
    await ok(['repo', 'add', apiDir])
    const [main] = await json<Worktree[]>(['worktree', 'list'])
    const shell = await json<Session>(['session', 'new', '--agent', 'shell'])
    expect(shell.worktreeId).toBe(main.id)
    const env = { QUIRKY_SESSION_ID: shell.id, QUIRKY_WORKTREE_ID: main.id }

    expect(await ok(['term', 'read', '--lines', '3'], { cwd: scratch, env })).toBe('one\ntwo\nthree\n')
    expect(h.pty.requests.filter((request) => request.type === 'read').at(-1)).toMatchObject({ sessionId: shell.id, lines: 3 })

    const second = await json<Session>(['session', 'new', '--agent', 'shell'], { cwd: scratch, env })
    expect(second.worktreeId).toBe(main.id)
    expect(second.id).not.toBe(shell.id)
  })

  test('SC-21: without the env a cwd outside every worktree is refused', async () => {
    await ok(['repo', 'add', apiDir])
    const result = await run(['session', 'new', '--agent', 'shell'], { cwd: scratch })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
  })
})
