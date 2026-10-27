import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { commands } from '../cli'
import type { AccountState, ManagedProvider, PendingLogin } from '../src/types'
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
})
