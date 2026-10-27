import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode, type RpcError, type Session } from '@quirky/protocol'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { resetFakeAgents } from './fakes/quirky.agents/main'
import { call, SESSION_PLUGINS, startPluginHarness } from './support'
import { cleanupAll as cleanupAccounts, startAccounts, waitForAsync } from '../../quirky.accounts/test/support/index'

let h: Harness
let client: QuirkyClient
let targetWorktree: string
let sourceCwd: string

beforeEach(async () => {
  resetFakeAgents()
  targetWorktree = makeTempDir('qs-ext-target-')
  sourceCwd = join(makeTempDir('qs-ext-source-'), "project with an apostrophe's name")
  mkdirSync(sourceCwd, { recursive: true })
  process.env.QUIRKY_TEST_REAL_WORKTREE = targetWorktree
  h = await startPluginHarness(SESSION_PLUGINS)
  client = await h.connect('cli')
})

afterEach(async () => {
  delete process.env.QUIRKY_TEST_REAL_WORKTREE
  client.close()
  await h.cleanup()
  await cleanupAccounts()
  removeTempDirs()
})

const resumeExternal = (params: Record<string, unknown>) => call<Session>(client, 'quirky.session/resumeExternal', params)

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected a failure')
}

const spawned = (sessionId: string) => {
  const request = h.pty.requests.find((item) => item.type === 'create' && item.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request
}

const accountSessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']

async function selectedClaudeAccount() {
  const accounts = await startAccounts({ plugins: accountSessionPlugins })
  const pending = await call<{ id: string }>(accounts.client, 'quirky.accounts/beginLogin', { provider: 'claude' })
  const completed = await waitForAsync(async () => {
    const current = await call<{ status: string; result?: { id?: string } }>(accounts.client, 'quirky.accounts/loginStatus', {
      id: pending.id
    })
    return current.status === 'pending' ? undefined : current
  })
  const accountId = completed.result?.id
  if (!accountId) throw new Error('Claude fixture login did not produce an account')
  await call(accounts.client, 'quirky.accounts/select', { provider: 'claude', accountId })
  return { accounts, accountId }
}

const spawnedFrom = (harness: Harness, sessionId: string) => {
  const request = harness.pty.requests.find((item) => item.type === 'create' && item.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request
}

describe('quirky.session/resumeExternal', () => {
  test('starts a real new session with original cwd and destination ownership via prepareResume', async () => {
    const record = { command: 'claude', args: '--model configured-model', env: { VAULT_PROVIDER_TOKEN: 'literal-secret' } }
    const providerSession = { id: 'source-session-17', transcriptPath: '/private/source transcript.jsonl' }

    const session = await resumeExternal({
      agent: 'claude',
      cwd: sourceCwd,
      providerSession,
      worktree: 'id:wt_real',
      record
    })

    expect(session).toMatchObject({
      kind: 'terminal',
      agent: 'claude',
      worktreeId: 'wt_real',
      cwd: sourceCwd,
      resumedFrom: null,
      providerSession
    })
    const request = spawned(session.id)
    expect(request.cwd).toBe(sourceCwd)
    expect(request.argv[3]).toContain('--model configured-model')
    expect(request.argv[3]).toContain('--resume source-session-17')
    expect(request.env).toMatchObject({ VAULT_PROVIDER_TOKEN: 'literal-secret' })
  })

  test('an unmanaged source cwd without an explicit destination uses floating ownership', async () => {
    const session = await resumeExternal({
      agent: 'claude',
      cwd: sourceCwd,
      providerSession: { id: 'unmanaged-session', transcriptPath: null }
    })

    expect(session).toMatchObject({ worktreeId: 'floating', cwd: sourceCwd })
    expect(spawned(session.id).cwd).toBe(sourceCwd)
  })

  test('missing cwd, invalid provider identity, unsupported resume and unsupported fork refuse before spawning', async () => {
    const before = h.pty.requests.filter((request) => request.type === 'create').length
    const invalidCwd = await failure(resumeExternal({
      agent: 'claude', cwd: join(sourceCwd, 'missing'), providerSession: { id: 'valid', transcriptPath: null }
    }))
    expect(invalidCwd.code).toBe(RpcErrorCode.InvalidParams)

    const invalidId = await failure(resumeExternal({
      agent: 'claude', cwd: sourceCwd, providerSession: { id: '-invalid', transcriptPath: null }
    }))
    expect(invalidId.code).toBe(RpcErrorCode.InvalidParams)

    const nonresumable = await failure(resumeExternal({
      agent: 'aider', cwd: sourceCwd, providerSession: { id: 'aider-session', transcriptPath: null }
    }))
    expect(nonresumable.code).toBe(RpcErrorCode.Conflict)

    const noFork = await failure(resumeExternal({
      agent: 'opencode', cwd: sourceCwd, providerSession: { id: 'opencode-session', transcriptPath: null }, fork: true
    }))
    expect(noFork.code).toBe(RpcErrorCode.Conflict)
    expect(h.pty.requests.filter((request) => request.type === 'create')).toHaveLength(before)
  })
  test('a selected managed Claude home reaches the external resume PTY without entering the user launch record', async () => {
    const { accounts, accountId } = await selectedClaudeAccount()
    const session = await call<Session>(accounts.client, 'quirky.session/resumeExternal', {
      agent: 'claude',
      cwd: sourceCwd,
      providerSession: { id: 'external-managed-session', transcriptPath: null }
    })

    const managedHome = accounts.managedHome('claude', accountId)
    const request = spawnedFrom(accounts.harness, session.id)
    expect(request.cwd).toBe(sourceCwd)
    expect(request.env.CLAUDE_CONFIG_DIR).toBe(managedHome)
    expect(session.launch?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  test('an explicit external record home reaches the PTY and stays the recorded user home', async () => {
    const { accounts } = await selectedClaudeAccount()
    const explicitHome = join(accounts.home, 'explicit-claude')
    mkdirSync(explicitHome, { recursive: true, mode: 0o700 })
    const record = {
      command: 'claude',
      args: '--model configured-model',
      env: { CLAUDE_CONFIG_DIR: explicitHome, VAULT_PROVIDER_TOKEN: 'user-value' }
    }
    const session = await call<Session>(accounts.client, 'quirky.session/resumeExternal', {
      agent: 'claude',
      cwd: sourceCwd,
      providerSession: { id: 'external-explicit-session', transcriptPath: null },
      record
    })

    const request = spawnedFrom(accounts.harness, session.id)
    expect(request.cwd).toBe(sourceCwd)
    expect(request.env.CLAUDE_CONFIG_DIR).toBe(explicitHome)
    expect(session.launch?.env).toEqual(record.env)
  })

  test('a required account preparation failure rejects external resume without a PTY spawn', async () => {
    const { accounts, accountId } = await selectedClaudeAccount()
    rmSync(join(accounts.managedHome('claude', accountId), '.credentials.json'), { force: true })

    const spawnCount = accounts.harness.pty.requests.filter((request) => request.type === 'create').length
    const error = await failure(
      call<Session>(accounts.client, 'quirky.session/resumeExternal', {
        agent: 'claude',
        cwd: sourceCwd,
        providerSession: { id: 'external-session-18', transcriptPath: null }
      })
    )

    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(accounts.harness.pty.requests.filter((request) => request.type === 'create')).toHaveLength(spawnCount)
    expect(await call<Session[]>(accounts.client, 'quirky.session/list')).toEqual([])
  })

})
