import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { commands } from '../cli'
import type { AccountPrepareResult, AccountState, AccountSummary, ManagedProvider, PendingLogin, SessionHomeResult } from '../src/types'
import type { AccountsHarness } from './support/index'
import { cleanupAll, defaultHome, startAccounts, testCli, waitForAsync } from './support/index'

afterEach(cleanupAll)

const call = <T>(client: AccountsHarness['client'], method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params) as Promise<T>

async function finishLogin(h: AccountsHarness, pending: PendingLogin): Promise<PendingLogin> {
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h.client, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

async function add(h: AccountsHarness, provider: ManagedProvider, label?: string): Promise<PendingLogin> {
  const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', {
    provider,
    ...(label === undefined ? {} : { label })
  })
  return finishLogin(h, pending)
}

async function addCodex(h: AccountsHarness, email: string): Promise<AccountSummary> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'codex' })
  const completed = await finishLogin(h, pending)
  if (completed.status !== 'complete' || !completed.result) {
    throw new Error(`Codex login for ${email} did not complete with an account`)
  }
  return completed.result
}

const CODEX_PROVIDER_SESSION_ID = '8db472c0-f25c-49de-8c13-40e5f21b5740'
const CODEX_OTHER_SESSION_ID = 'a6e3e4dd-79bb-4a9d-8b77-8ce098320bc1'

function codexRolloutPath(home: string, id = CODEX_PROVIDER_SESSION_ID): string {
  return join(home, 'sessions', '2026', '10', '27', `rollout-2026-10-27T13-15-00-${id}.jsonl`)
}

function codexPrepareArgs(
  h: AccountsHarness,
  sessionId: string,
  resume?: { sourceSessionId: string; providerSession: { id: string; transcriptPath: string | null } }
) {
  return {
    agent: 'codex',
    sessionId,
    worktreeId: 'worktree-codex-resume',
    cwd: h.userHome,
    homeOverrides: {
      claude: { value: null, source: 'absent' },
      codex: { value: null, source: 'absent' }
    },
    ...(resume === undefined ? {} : { resume })
  }
}

describe('quirky.accounts lifecycle API and CLI', () => {
  test('lists System default without exposing auth paths or credentials', async () => {
    const h = await startAccounts()
    const claudeHome = defaultHome(h.home, 'claude')
    const codexHome = defaultHome(h.home, 'codex')
    mkdirSync(claudeHome, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'default@example.test' } }))
    writeFileSync(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-default-secret' } }))
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-default-secret' } }))

    const state = await call<AccountState>(h.client, 'quirky.accounts/list')
    expect(state).toMatchObject({
      accounts: [],
      active: { claude: null, codex: null },
      systemDefault: {
        claude: { label: 'System default', email: 'default@example.test', hasAuth: true, authKind: 'oauth' },
        codex: { label: 'System default', hasAuth: true, authKind: 'oauth' }
      },
      pendingLogin: null,
      preferences: { mode: 'compact', direction: 'used', hidden: false }
    })
    expect(JSON.stringify(state)).not.toContain('fixture-default-secret')
    expect(JSON.stringify(state)).not.toContain(claudeHome)
    expect(JSON.stringify(state)).not.toContain(codexHome)

    const cli = testCli(h.client)
    await commands.list({ positionals: [], flags: {} }, cli.ctx)
    expect(cli.lines).toHaveLength(1)
    expect(cli.lines[0]).toMatchObject({ active: { claude: null, codex: null } })
  })

  test('session-home returns the prepared effective home through the RPC and CLI', async () => {
    const h = await startAccounts()
    const sessionId = 'prepared-source-home'
    const home = join(h.userHome, 'custom-codex-home')
    await call(h.client, 'quirky.accounts/prepare', {
      agent: 'codex',
      sessionId,
      worktreeId: 'worktree-source-home',
      cwd: h.userHome,
      homeOverrides: {
        claude: { value: null, source: 'absent' },
        codex: { value: home, source: 'explicit' }
      }
    })

    const expected: SessionHomeResult = { provider: 'codex', home }
    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: sessionId })).toEqual(expected)
    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: 'unknown-session' })).toEqual({
      provider: null,
      home: null
    })

    const cli = testCli(h.client)
    await commands.sessionHome({ positionals: [], flags: { session: sessionId } }, cli.ctx)
    expect(cli.lines).toEqual([expected])
  })
  test('prepareProviderEnv resolves the selected Codex home without creating a session identity', async () => {
    const h = await startAccounts()
    const selected = await addCodex(h, 'probe@example.test')
    const homeOverrides = {
      claude: { value: null, source: 'absent' },
      codex: { value: null, source: 'absent' }
    }
    const prepared = await call<AccountPrepareResult>(h.client, 'quirky.accounts/prepareProviderEnv', {
      agent: 'codex',
      cwd: h.userHome,
      homeOverrides
    })
    expect(prepared).toEqual({
      env: { CODEX_HOME: h.managedHome('codex', selected.id) },
      shellInit: null,
      account: { provider: 'codex', id: selected.id, label: selected.label, source: 'managed' }
    })
    const systemDefault = await call<AccountPrepareResult>(h.client, 'quirky.accounts/prepareProviderEnv', {
      agent: 'codex',
      cwd: h.userHome,
      homeOverrides: {
        claude: { value: null, source: 'absent' },
        codex: { value: null, source: 'explicit' }
      }
    })
    expect(systemDefault).toMatchObject({
      env: { CODEX_HOME: null },
      shellInit: null,
      account: { provider: 'codex', id: null, source: 'default' }
    })
    const customHome = await call<AccountPrepareResult>(h.client, 'quirky.accounts/prepareProviderEnv', {
      agent: 'codex',
      cwd: h.userHome,
      homeOverrides: {
        claude: { value: null, source: 'absent' },
        codex: { value: join(h.userHome, 'custom-codex-home'), source: 'explicit' }
      }
    })
    expect(customHome).toMatchObject({
      env: {},
      shellInit: null,
      account: { provider: 'codex', id: null, source: 'custom' }
    })
    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: 'codex-model-probe' }))
      .toEqual({ provider: null, home: null })

    const cli = testCli(h.client)
    await commands.prepareProviderEnv({
      positionals: [],
      flags: { agent: 'codex', cwd: h.userHome, 'home-overrides': homeOverrides }
    }, cli.ctx)
    expect(cli.lines[0]).toEqual({
      account: prepared.account,
      shellInit: false,
      environmentKeys: ['CODEX_HOME']
    })
    for (const extra of [{ sessionId: 'fake-session' }, { worktreeId: 'fake-worktree' }, { resume: {} }]) {
      await expect(h.client.callAny('quirky.accounts/prepareProviderEnv', {
        agent: 'codex', cwd: h.userHome, homeOverrides, ...extra
      })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })

  test('Codex app-server discovery uses the selected account, and failures preserve its model snapshot', async () => {
    const h = await startAccounts({ plugins: ['quirky.agents'] })
    const selected = await addCodex(h, 'probe@example.test')
    const codexHome = h.managedHome('codex', selected.id)
    const modelsPath = join(codexHome, 'models.json')
    const requestLog = join(h.userHome, 'codex-app-server.jsonl')
    const probeEnvironment = join(h.userHome, 'probe-environment.json')
    writeFileSync(modelsPath, JSON.stringify({
      data: [{ id: 'account-owned-model', displayName: 'Account owned model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] }],
      nextCursor: null
    }))
    writeFileSync(join(h.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  for (;;) {
    const end = input.indexOf('\\n')
    if (end < 0) break
    const line = input.slice(0, end)
    input = input.slice(end + 1)
    if (!line) continue
    const request = JSON.parse(line)
    fs.appendFileSync(path.join(process.env.HOME, 'codex-app-server.jsonl'), JSON.stringify(request) + '\\n')
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n')
    } else if (request.method === 'model/list') {
      if (fs.existsSync(path.join(process.env.HOME, 'codex-app-server-fail'))) process.exit(9)
      const source = fs.readFileSync(path.join(process.env.CODEX_HOME, 'models.json'), 'utf8')
      const models = source === 'malformed' ? { data: null, nextCursor: null } : JSON.parse(source)
      fs.writeFileSync(path.join(process.env.HOME, 'probe-environment.json'), JSON.stringify({ codexHome: process.env.CODEX_HOME ?? null, args: process.argv.slice(2) }))
      process.stdout.write(JSON.stringify({ id: request.id, result: models }) + '\\n')
    }
  }
})
`)
    const discover = () => call<any>(h.client, 'quirky.agents/discoverModels', { agent: 'codex', host: 'local' })
    const listedModels = async () => (await call<any>(h.client, 'quirky.agents/options', { agent: 'codex', host: 'local' })).models.map(
      (model: { id: string }) => model.id
    )
    const discovered = await discover()
    expect(discovered).toMatchObject({
      agent: 'codex',
      host: 'local',
      authoritative: true,
      models: [{ id: 'account-owned-model', label: 'Account owned model', options: [{ id: 'effort', choices: ['low'] }] }]
    })
    expect(JSON.parse(readFileSync(probeEnvironment, 'utf8'))).toEqual({
      codexHome,
      args: ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server']
    })
    expect(readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method))
      .toEqual(['initialize', 'initialized', 'model/list'])
    expect(await listedModels()).toEqual(['account-owned-model'])
    expect(await call<any>(h.client, 'quirky.agents/resolveLaunch', {
      agent: 'codex', host: 'local', model: 'account-owned-model', options: { effort: 'low' }
    })).toMatchObject({ structured: { model: 'account-owned-model', effort: 'low' } })

    writeFileSync(modelsPath, JSON.stringify({ data: [], nextCursor: null }))
    expect(await discover()).toMatchObject({ status: 'available', authoritative: false, models: [] })
    expect(await listedModels()).toEqual(['account-owned-model'])

    writeFileSync(modelsPath, 'malformed')
    expect(await discover()).toMatchObject({ status: 'unavailable', authoritative: false, models: [] })
    expect(await listedModels()).toEqual(['account-owned-model'])

    writeFileSync(join(h.userHome, 'codex-app-server-fail'), 'fail')
    expect(await discover()).toMatchObject({ status: 'unavailable', authoritative: false, models: [] })
    expect(await listedModels()).toEqual(['account-owned-model'])

    rmSync(join(codexHome, 'auth.json'), { force: true })
    expect(await discover()).toMatchObject({ status: 'unavailable', authoritative: false, models: [] })
    expect(await listedModels()).toEqual(['account-owned-model'])
    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: 'codex-model-probe' }))
      .toEqual({ provider: null, home: null })
  }, 30_000)


  test('Claude add remains unselected, duplicate identity is rejected, and default auth/config stay byte-identical', async () => {
    const h = await startAccounts()
    const claudeHome = defaultHome(h.home, 'claude')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{"theme":"fixture"}\n')
    writeFileSync(join(claudeHome, '.claude.json'), '{"oauthAccount":{"emailAddress":"system@example.test"}}\n')
    writeFileSync(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fixture-default-secret"}}\n')
    const before = ['settings.json', '.claude.json', '.credentials.json'].map((name) => readFileSync(join(claudeHome, name)))

    const first = await add(h, 'claude', 'Work')
    expect(first).toMatchObject({ status: 'complete', provider: 'claude', result: { label: 'Work', email: 'claude@example.test', active: false } })
    expect((await call<AccountState>(h.client, 'quirky.accounts/list')).active.claude).toBeNull()

    h.setLoginMode('complete', 'claude@example.test')
    const duplicate = await add(h, 'claude', 'Duplicate')
    expect(duplicate.status).toBe('error')
    expect(duplicate.error).toMatch(/already added/i)
    expect(duplicate.accountId).not.toBeNull()
    expect(readFileSync(join(claudeHome, 'settings.json'))).toEqual(before[0])
    expect(readFileSync(join(claudeHome, '.claude.json'))).toEqual(before[1])
    expect(readFileSync(join(claudeHome, '.credentials.json'))).toEqual(before[2])
    expect(JSON.stringify(duplicate)).not.toContain('fixture-claude-token')
  })

  test('Codex add selects the private account, duplicate workspace identity does not remove it, and custom providers refuse OAuth', async () => {
    const h = await startAccounts()
    const codexHome = defaultHome(h.home, 'codex')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-default-secret"}}\n')
    const before = ['config.toml', 'auth.json'].map((name) => readFileSync(join(codexHome, name)))

    const first = await add(h, 'codex', 'Personal')
    expect(first).toMatchObject({ status: 'complete', result: { provider: 'codex', email: 'codex@example.test', active: true } })
    const savedId = first.result?.id
    if (!savedId) throw new Error('Completed Codex login did not return an account ID')
    const state = await call<AccountState>(h.client, 'quirky.accounts/list')
    expect(state.active.codex).toBe(savedId)

    h.setLoginMode('complete', 'codex@example.test')
    const duplicate = await add(h, 'codex', 'Duplicate')
    expect(duplicate.status).toBe('error')
    expect(duplicate.error).toMatch(/already added/i)
    expect((await call<AccountState>(h.client, 'quirky.accounts/list')).accounts.filter((account) => account.provider === 'codex')).toHaveLength(1)
    expect(readFileSync(join(codexHome, 'config.toml'))).toEqual(before[0])
    expect(readFileSync(join(codexHome, 'auth.json'))).toEqual(before[1])

    h.setLoginMode('complete')
    writeFileSync(join(codexHome, 'config.toml'), 'model_provider = "custom"\n')
    const configBeforeRefusal = readFileSync(join(codexHome, 'config.toml'))
    const authBeforeRefusal = readFileSync(join(codexHome, 'auth.json'))
    const refused = await h.client.callAny('quirky.accounts/beginLogin', { provider: 'codex' })
      .then(() => null, (error: unknown) => error as { message?: string })
    expect(refused?.message).toMatch(/custom provider/i)
    expect(readFileSync(join(codexHome, 'config.toml'))).toEqual(configBeforeRefusal)
    expect(readFileSync(join(codexHome, 'auth.json'))).toEqual(authBeforeRefusal)
  })

  test('login link is restricted to the provider authorize host and cancellation removes only its owned pending profile', async () => {
    const h = await startAccounts()
    h.setLoginMode('pending')
    const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'claude', copyLink: true })
    const withUrl = await waitForAsync(async () => {
      const state = await call<PendingLogin>(h.client, 'quirky.accounts/loginStatus', { id: pending.id })
      return state.url ? state : undefined
    })
    expect(withUrl.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/)
    expect(withUrl.url).toContain('redirect_uri=http%3A%2F%2Flocalhost')
    const cancelled = await call<PendingLogin>(h.client, 'quirky.accounts/cancelLogin', { id: pending.id })
    expect(cancelled.status).toBe('cancelled')
    expect(pending.accountId).toBeTruthy()
    expect(existsSync(h.managedHome('claude', pending.accountId ?? ''))).toBe(false)
    expect(JSON.stringify(cancelled)).not.toContain('fixture-claude-token')
  })

  test('a newer account selection supersedes a pending sign-in without losing the saved account', async () => {
    const h = await startAccounts()
    const saved = await add(h, 'claude', 'saved@example.test')
    const savedId = saved.result?.id ?? ''
    h.setLoginMode('pending', 'pending@example.test')
    const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'claude' })
    const pendingHome = h.managedHome('claude', pending.accountId ?? '')

    const selected = await call<AccountState>(h.client, 'quirky.accounts/select', { provider: 'claude', accountId: savedId })
    const login = await call<PendingLogin>(h.client, 'quirky.accounts/loginStatus', { id: pending.id })
    const state = await call<AccountState>(h.client, 'quirky.accounts/list')
    expect(login.status).toBe('cancelled')
    expect(existsSync(pendingHome)).toBe(false)
    expect(selected.active.claude).toBe(savedId)
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]?.id).toBe(savedId)
  })

  test('simultaneous beginLogin calls leave only the newer pending request and no orphaned profile', async () => {
    const h = await startAccounts()
    h.setLoginMode('pending', 'concurrent@example.test')
    const [first, second] = await Promise.all([
      call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'claude', label: 'First' }),
      call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'claude', label: 'Second' })
    ])
    const [firstStatus, secondStatus, state] = await Promise.all([
      call<PendingLogin>(h.client, 'quirky.accounts/loginStatus', { id: first.id }),
      call<PendingLogin>(h.client, 'quirky.accounts/loginStatus', { id: second.id }),
      call<AccountState>(h.client, 'quirky.accounts/list')
    ])

    expect(firstStatus.status).toBe('cancelled')
    expect(secondStatus.status).toBe('pending')
    expect(state.pendingLogin?.id).toBe(second.id)
    expect(state.accounts).toHaveLength(0)
    expect(existsSync(h.managedHome('claude', first.accountId ?? ''))).toBe(false)
    expect(existsSync(h.managedHome('claude', second.accountId ?? ''))).toBe(true)
    expect((await call<PendingLogin>(h.client, 'quirky.accounts/cancelLogin', { id: second.id })).status).toBe('cancelled')
    expect(existsSync(h.managedHome('claude', second.accountId ?? ''))).toBe(false)
  })

  test('a completed Codex auth write wins a racing cancel and is saved rather than rolled back', async () => {
    const h = await startAccounts()
    h.setLoginMode('auth-written-await')
    const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'codex' })
    const home = h.managedHome('codex', pending.accountId ?? '')
    await waitForAsync(async () => existsSync(join(home, 'auth.json')) || undefined)

    const cancelled = await call<PendingLogin>(h.client, 'quirky.accounts/cancelLogin', { id: pending.id })
    expect(['pending', 'complete']).toContain(cancelled.status)
    h.releaseLogin('codex', pending.accountId ?? '')
    const completed = await finishLogin(h, pending)
    expect(completed.status).toBe('complete')
    expect(completed.result?.active).toBe(true)
    expect(existsSync(join(home, 'auth.json'))).toBe(true)
    expect((await call<AccountState>(h.client, 'quirky.accounts/list')).active.codex).toBe(pending.accountId)
  })

  test('failed reauthentication leaves the saved account and its private auth files intact', async () => {
    const h = await startAccounts()
    const added = await add(h, 'claude', 'Reauthenticate')
    const id = added.result?.id ?? ''
    const home = h.managedHome('claude', id)
    const authBefore = readFileSync(join(home, '.credentials.json'))
    h.setLoginMode('failure')
    const pending = await call<PendingLogin>(h.client, 'quirky.accounts/beginLogin', { provider: 'claude', accountId: id })
    const failed = await finishLogin(h, pending)

    expect(failed.status).toBe('error')
    expect(readFileSync(join(home, '.credentials.json'))).toEqual(authBefore)
    expect((await call<AccountState>(h.client, 'quirky.accounts/list')).accounts).toContainEqual(
      expect.objectContaining({ id, provider: 'claude', needsSignIn: false })
    )
  })

  test('remove uses the destructive confirmation convention and explicit yes removes only the managed credential name', async () => {
    const h = await startAccounts()
    const added = await add(h, 'claude', 'Remove me')
    const id = added.result?.id
    expect(id).toBeTruthy()
    const refused = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: id })
      .then(() => null, (error: unknown) => error as { code?: number; data?: { askId?: string; action?: string } })
    expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(refused?.data?.action).toMatch(/Claude/i)
    const askId = refused?.data?.askId
    expect(askId).toBeTruthy()
    await h.client.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    const result = await call<AccountState>(h.client, 'quirky.accounts/remove', { provider: 'claude', accountId: id, confirmation: askId })
    expect(result.accounts).toHaveLength(0)
    expect(result.active.claude).toBeNull()
    const securityLog = readFileSync(join(h.home, 'security.log'), 'utf8')
    expect(securityLog).toContain('delete-generic-password')
    expect(securityLog).not.toContain('Claude Code-credentials\n')
    expect(securityLog).not.toContain('fixture-claude-token')
  })

  test('Codex resume finds a pathless conversation from its recorded source session and copies its rollout', async () => {
    const h = await startAccounts()
    const first = await addCodex(h, 'source@example.test')
    const second = await addCodex(h, 'target@example.test')
    const sourceId = first.id
    const targetId = second.id
    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: sourceId })
    await call(h.client, 'quirky.accounts/prepare', codexPrepareArgs(h, 'recorded-source-session'))

    const sourceHome = h.managedHome('codex', sourceId)

    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: 'recorded-source-session' })).toEqual({
      provider: 'codex',
      home: sourceHome
    })
    const sourcePath = codexRolloutPath(sourceHome)
    const conversation = [
      JSON.stringify({ type: 'session_meta', payload: { id: CODEX_PROVIDER_SESSION_ID } }),
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"recorded source conversation"}]}}'
    ].join('\n') + '\n'
    mkdirSync(join(sourceHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(sourcePath, conversation)

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: targetId })
    expect(await call<SessionHomeResult>(h.client, 'quirky.accounts/sessionHome', { session: 'recorded-source-session' })).toEqual({
      provider: 'codex',
      home: sourceHome
    })
    const prepared = await call<AccountPrepareResult>(
      h.client,
      'quirky.accounts/prepare',
      codexPrepareArgs(h, 'resumed-session', {
        sourceSessionId: 'recorded-source-session',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: null }
      })
    )

    expect(prepared.env.CODEX_HOME).toBe(h.managedHome('codex', targetId))
    expect(prepared.resumeTranscriptPath).toBe(codexRolloutPath(h.managedHome('codex', targetId)))
    expect(readFileSync(codexRolloutPath(h.managedHome('codex', targetId)), 'utf8')).toBe(conversation)
  })

  test('Codex resume targets the real System default when an injected CODEX_HOME is cleared', async () => {
    const h = await startAccounts()
    const injectedHome = join(h.userHome, 'injected-codex-home')
    process.env.CODEX_HOME = injectedHome
    const systemHome = defaultHome(h.home, 'codex')
    const sourcePath = codexRolloutPath(systemHome)
    const conversation = 'System default Codex rollout\n'
    mkdirSync(join(systemHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(sourcePath, conversation)

    const prepared = await call<AccountPrepareResult>(h.client, 'quirky.accounts/prepare', {
      ...codexPrepareArgs(h, 'system-default-resume', {
        sourceSessionId: 'untracked-system-session',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: sourcePath }
      }),
      homeOverrides: {
        claude: { value: null, source: 'absent' },
        codex: { value: null, source: 'injected' }
      }
    })

    expect(prepared.env.CODEX_HOME).toBeNull()
    expect(prepared.resumeTranscriptPath).toBe(sourcePath)
    expect(existsSync(join(injectedHome, 'sessions'))).toBe(false)
    expect(readFileSync(sourcePath, 'utf8')).toBe(conversation)
  })
  test('Codex resume passes an unchanged System default native transcript through', async () => {
    const h = await startAccounts()
    const sourceSessionId = 'native-default-source'
    const fixtureDir = join(h.userHome, 'provider-fixtures')
    const transcriptPath = join(fixtureDir, 'native-thread.transcript')
    const transcript = 'native Codex transcript fixture\n'
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(transcriptPath, transcript)

    await call(h.client, 'quirky.accounts/prepare', codexPrepareArgs(h, sourceSessionId))
    const prepared = await call<AccountPrepareResult>(
      h.client,
      'quirky.accounts/prepare',
      codexPrepareArgs(h, 'native-default-resume', {
        sourceSessionId,
        providerSession: { id: 'thread-1', transcriptPath }
      })
    )

    expect(prepared.account).toMatchObject({ id: null, source: 'default' })
    expect(prepared.resumeTranscriptPath).toBe(transcriptPath)
    expect(readFileSync(transcriptPath, 'utf8')).toBe(transcript)
    expect(existsSync(join(defaultHome(h.home, 'codex'), 'sessions'))).toBe(false)
  })


  test('Codex resume continues from the prepared target after the original profile is removed', async () => {
    const h = await startAccounts()
    const first = await addCodex(h, 'source@example.test')
    const second = await addCodex(h, 'middle@example.test')
    const third = await addCodex(h, 'next@example.test')
    const sourceId = first.id
    const middleId = second.id
    const nextId = third.id

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: sourceId })
    await call(h.client, 'quirky.accounts/prepare', codexPrepareArgs(h, 'source-session-a'))
    const sourceHome = h.managedHome('codex', sourceId)
    const sourcePath = codexRolloutPath(sourceHome)
    const conversation = [
      JSON.stringify({ type: 'session_meta', payload: { id: CODEX_PROVIDER_SESSION_ID } }),
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"conversation continues after the original profile is removed"}]}}'
    ].join('\n') + '\n'
    mkdirSync(join(sourceHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(sourcePath, conversation)

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: middleId })
    const resumedB = await call<AccountPrepareResult>(
      h.client,
      'quirky.accounts/prepare',
      codexPrepareArgs(h, 'resumed-session-b', {
        sourceSessionId: 'source-session-a',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: sourcePath }
      })
    )
    const pathB = resumedB.resumeTranscriptPath
    if (!pathB) throw new Error('Codex resume did not return its prepared target transcript path')
    expect(readFileSync(pathB, 'utf8')).toBe(conversation)

    const refused = await h.client.callAny('quirky.accounts/remove', { provider: 'codex', accountId: sourceId })
      .then(() => null, (error: unknown) => error as { data?: { askId?: string } })
    const askId = refused?.data?.askId
    if (!askId) throw new Error('Codex account removal did not request confirmation')
    await h.client.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    await h.client.callAny('quirky.accounts/remove', { provider: 'codex', accountId: sourceId, confirmation: askId })
    expect(existsSync(sourcePath)).toBe(false)

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: nextId })
    const resumedC = await call<AccountPrepareResult>(
      h.client,
      'quirky.accounts/prepare',
      codexPrepareArgs(h, 'resumed-session-c', {
        sourceSessionId: 'resumed-session-b',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: pathB }
      })
    )
    const pathC = resumedC.resumeTranscriptPath
    if (!pathC) throw new Error('Codex resume did not return the next target transcript path')
    expect(pathC).toBe(codexRolloutPath(h.managedHome('codex', nextId)))
    expect(readFileSync(pathC, 'utf8')).toBe(conversation)
  })

  test('Codex resume rejects missing, untrusted, traversing, symlinked, non-rollout, and mismatched transcripts without falling back', async () => {
    const h = await startAccounts()
    const first = await addCodex(h, 'source@example.test')
    const second = await addCodex(h, 'target@example.test')
    const sourceId = first.id
    const targetId = second.id
    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: sourceId })
    await call(h.client, 'quirky.accounts/prepare', codexPrepareArgs(h, 'recorded-source-session'))

    const sourceHome = h.managedHome('codex', sourceId)
    const targetHome = h.managedHome('codex', targetId)
    const sourceDir = join(sourceHome, 'sessions', '2026', '10', '27')
    const targetPath = codexRolloutPath(targetHome)
    const decoy = 'target-only conversation; must not be resumed\n'
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(join(h.userHome, 'sessions', '2026', '10', '27'), { recursive: true })
    mkdirSync(join(targetHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(targetPath, decoy)

    const validSource = codexRolloutPath(sourceHome)
    const otherSource = codexRolloutPath(sourceHome, CODEX_OTHER_SESSION_ID)
    writeFileSync(otherSource, 'a different provider session\n')
    symlinkSync(otherSource, validSource)
    const nonRollout = join(sourceDir, 'not-a-rollout.jsonl')
    writeFileSync(nonRollout, 'not a Codex rollout\n')
    const untrusted = codexRolloutPath(h.userHome)
    writeFileSync(untrusted, 'valid-looking rollout outside trusted homes\n')
    const traversal = `${sourceHome}/sessions/2026/10/27/../27/${validSource.split(/[\\/]/).pop()}`
    const missing = join(sourceDir, `rollout-2026-10-27T14-00-00-${CODEX_PROVIDER_SESSION_ID}.jsonl`)

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: targetId })
    for (const transcriptPath of [missing, untrusted, traversal, validSource, nonRollout, otherSource]) {
      const rejected = await h.client.callAny('quirky.accounts/prepare', codexPrepareArgs(h, 'rejected-resume', {
        sourceSessionId: 'recorded-source-session',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath }
      })).then(() => null, (error: unknown) => error as { message?: string })
      expect(rejected?.message).toMatch(/Codex conversation|Codex rollout/i)
      expect(readFileSync(targetPath, 'utf8')).toBe(decoy)
    }
    expect((await call<AccountState>(h.client, 'quirky.accounts/list')).active.codex).toBe(targetId)
  })

  test('Codex resume preserves a conflicting target rollout instead of overwriting it', async () => {
    const h = await startAccounts()
    const first = await addCodex(h, 'source@example.test')
    const second = await addCodex(h, 'target@example.test')
    const sourceId = first.id
    const targetId = second.id
    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: sourceId })
    await call(h.client, 'quirky.accounts/prepare', codexPrepareArgs(h, 'recorded-source-session'))

    const sourceHome = h.managedHome('codex', sourceId)
    const targetHome = h.managedHome('codex', targetId)
    const sourcePath = codexRolloutPath(sourceHome)
    const targetPath = codexRolloutPath(targetHome)
    const sourceContent = 'source Codex conversation\n'
    const conflictingContent = 'a different target rollout must remain untouched\n'
    mkdirSync(join(sourceHome, 'sessions', '2026', '10', '27'), { recursive: true })
    mkdirSync(join(targetHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(sourcePath, sourceContent)
    writeFileSync(targetPath, conflictingContent)

    await call(h.client, 'quirky.accounts/select', { provider: 'codex', accountId: targetId })
    const rejected = await h.client.callAny('quirky.accounts/prepare', codexPrepareArgs(h, 'conflicting-resume', {
      sourceSessionId: 'recorded-source-session',
      providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: sourcePath }
    })).then(() => null, (error: unknown) => error as { message?: string })

    expect(rejected?.message).toMatch(/Codex conversation|Codex rollout/i)
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceContent)
    expect(readFileSync(targetPath, 'utf8')).toBe(conflictingContent)
  })

  test('prepare rejects unknown keys in the optional resume metadata', async () => {
    const h = await startAccounts()
    const result = await h.client.callAny('quirky.accounts/prepare', {
      ...codexPrepareArgs(h, 'malformed-resume'),
      resume: {
        sourceSessionId: 'old-session',
        providerSession: { id: CODEX_PROVIDER_SESSION_ID, transcriptPath: null, extra: true }
      }
    }).then(() => null, (error: unknown) => error as { code?: number; message?: string })

    expect(result).not.toBeNull()
    expect(result?.code).toBe(RpcErrorCode.InvalidParams)
  })
})
