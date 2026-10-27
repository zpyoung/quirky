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
  test('SC-20: text output keeps v1 tables and records', async () => {
    const added = await ok(['repo', 'add', apiDir])
    expect(added).toMatch(new RegExp(`^id: repo_[0-9a-f]+\\nname: api\\npath: ${apiDir}\\n$`))

    const repos = (await ok(['repo', 'list'])).split('\n')
    expect(repos[0]).toMatch(/^ID\s+NAME\s+PATH$/)
    expect(repos[1]).toMatch(new RegExp(`^repo_[0-9a-f]+\\s+api\\s+${apiDir}$`))

    const created = await ok(['wt', 'create', 'api', 'feature-x', '--base', 'main'])
    expect(created).toMatch(
      new RegExp(`^id: wt_[0-9a-f]+\\nname: feature-x\\nbranch: feature-x\\npath: ${join(worktreesRoot, 'api', 'feature-x')}\\n`)
    )
    expect(git.calls.find((call) => call.fn === 'addWorktree')?.args[3]).toBe('refs/heads/main')

    const worktrees = (await ok(['wt', 'list', '--repo', 'api'])).split('\n')
    expect(worktrees[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATUS\s+PATH$/)
    expect(worktrees.slice(1, 3).map((line) => line.split(/\s+/).slice(1, 3))).toEqual([
      ['main', 'main'],
      ['feature-x', 'feature-x']
    ])

    const record = await ok(['session', 'new', '--agent', 'shell'])
    const sessionId = /^id: (\S+)$/m.exec(record)?.[1] as string
    expect(record).toMatch(new RegExp(`^id: ${sessionId}\\nagent: shell\\nkind: terminal\\nstatus: running\\nworktree: wt_[0-9a-f]+\\nprompt: none\\n$`))

    const sessions = (await ok(['session', 'list'])).split('\n')
    expect(sessions[0]).toMatch(/^ID\s+AGENT\s+KIND\s+STATUS\s+WORKTREE\s+TITLE$/)
    expect(sessions[1]).toMatch(new RegExp(`^${sessionId}\\s+shell\\s+terminal\\s+running\\s+wt_[0-9a-f]+\\s+`))

    expect(await ok(['term', 'send', sessionId, 'echo hi', '--enter'])).toBe(`sent to ${sessionId}\n`)
    await waitFor(() => h.pty.inputs.length === 1)
    expect(h.pty.inputs[0]).toEqual({ sessionId, text: 'echo hi\r' })

    expect(await ok(['term', 'read', sessionId, '--lines', '5'])).toBe('one\ntwo\nthree\n')
    expect(h.pty.requests.filter((request) => request.type === 'read').at(-1)).toMatchObject({ sessionId, lines: 5 })

    expect(await ok(['session', 'close', sessionId])).toBe(`closed ${sessionId}\n`)
    expect(await ok(['wt', 'rm', 'feature-x', '--yes'])).toBe('removed feature-x\n')
    expect(await ok(['repo', 'rm', 'api'])).toBe('removed api\n')
    expect(await ok(['repo', 'list'])).toBe('no repos\n')
  })

  test('SC-20: --json output keeps v1 shapes', async () => {
    const repo = await json<Repo>(['repo', 'add', apiDir])
    expect(repo).toMatchObject({ name: 'api', path: apiDir })
    expect(await json<Repo[]>(['repo', 'list'])).toEqual([repo])

    const { worktree } = await json<WorktreeCreateResult>(['wt', 'create', 'api', 'feature-x', '--base', 'main'])
    expect(worktree).toMatchObject({ repoId: repo.id, name: 'feature-x', branch: 'feature-x', isMain: false })
    const listed = await json<Worktree[]>(['wt', 'list', '--repo', 'api'])
    expect(listed.map((wt) => wt.name)).toEqual(['main', 'feature-x'])

    const session = await json<Session>(['session', 'new', '--agent', 'shell'])
    expect(session).toMatchObject({ agent: 'shell', kind: 'terminal', status: 'running', worktreeId: listed[0].id })
    expect(await json<Session[]>(['session', 'list'])).toEqual([session])

    expect(await json<object>(['term', 'send', session.id, 'echo hi', '--enter'])).toEqual({ ok: true })
    expect(await json<object>(['term', 'read', session.id, '--lines', '5'])).toEqual({
      lines: ['one', 'two', 'three'],
      cols: 80,
      rows: 24,
      alt: false
    })
    expect(await json<object>(['session', 'close', session.id])).toEqual({ ok: true })
    expect(await json<object>(['wt', 'rm', 'feature-x', '--yes'])).toEqual({ ok: true, removed: [worktree.id] })
    expect(await json<object>(['repo', 'rm', 'api'])).toEqual({ ok: true })
    expect(await json<Repo[]>(['repo', 'list'])).toEqual([])
  })

  test('SC-20: worktree, terminal and the short words are the same commands', async () => {
    await ok(['repo', 'add', apiDir])
    expect(await ok(['worktree', 'list'])).toBe(await ok(['wt', 'list']))
    const { id } = await json<Session>(['session', 'new', '--agent', 'shell'])
    expect(await ok(['terminal', 'read', id, '--lines', '2'])).toBe(await ok(['term', 'read', id, '--lines', '2']))
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
    expect(await ok(['wt', 'rm', created.id, '--yes'])).toBe(`removed ${created.name}\n`)
    expect(await ok(['repo', 'rm', repo.id])).toBe(`removed ${repo.id}\n`)
  })

  test('SC-20: usage errors keep v1 wording', async () => {
    await ok(['repo', 'add', apiDir])
    const noPrompt = await run(['session', 'new', '--agent', 'claude', '--background'])
    expect(noPrompt.code).toBe(2)
    expect(noPrompt.stderr).toContain('--background requires --prompt')
    const noSession = await run(['term', 'read'])
    expect(noSession.code).toBe(2)
    expect(noSession.stderr).toContain('no session id; pass <sessionId> or set QUIRKY_SESSION_ID')
    const missing = await run(['repo', 'rm'])
    expect(missing.code).toBe(2)
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
