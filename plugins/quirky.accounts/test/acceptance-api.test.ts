import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_PATH_PREFIX, HOOK_TOKEN_HEADER, RpcErrorCode } from '@quirky/protocol'
import type { AccountPrepareResult, AccountState, AccountUiState, ManagedProvider, PendingLogin } from '../src/types'
import type { ProviderSnapshot, ResetCreditExpectedScope, UsageState } from '../src/usage/types'
import type { AccountsHarness } from './support/index'
import { commands } from '../cli'
import { cleanupAll, defaultHome, startAccounts, testCli, waitForAsync } from './support/index'
import {
  interceptProviderFetch,
  restartAccounts,
  restoreProviderFetchFixtures,
  writeAntigravityCli,
  writeCursorCliCredential,
  writePrivateJson,
  type RestartedAccounts
} from './acceptance-fixtures'

const nativeDateNow = Date.now
const originalAppData = process.env.APPDATA
afterEach(async () => {
  Date.now = nativeDateNow
  await cleanupAll()
  await restoreProviderFetchFixtures()
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
})

const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

function snapshot(state: UsageState, provider: string): ProviderSnapshot {
  const result = state.providers.find((item) => item.provider === provider)
  if (!result) throw new Error(`Usage API omitted provider ${provider}`)
  return result
}

async function finishLogin(h: AccountsHarness, pending: PendingLogin): Promise<PendingLogin> {
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

async function add(h: AccountsHarness, provider: ManagedProvider, email: string): Promise<PendingLogin> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider })
  return finishLogin(h, pending)
}

const sessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']


function jwt(subject: string, expirySeconds: number): string {
  return `header.${Buffer.from(JSON.stringify({ sub: subject, exp: expirySeconds })).toString('base64url')}.signature`
}

describe('quirky.accounts daemon API acceptance', () => {
  test('empty usage becomes configured provider state with durable presentation and transient UI state', async () => {
    const h = await startAccounts()
    if (process.platform === 'win32') process.env.APPDATA = join(h.userHome, 'AppData', 'Roaming')
    const initial = await call<AccountState>(h, 'quirky.accounts/list')
    expect(initial).toMatchObject({ accounts: [], active: { claude: null, codex: null }, preferences: { mode: 'compact', direction: 'used', hidden: false } })

    const empty = await call<UsageState>(h, 'quirky.accounts/refresh', { force: true })
    expect(empty.providers).toHaveLength(10)
    for (const item of empty.providers) {
      expect(item.status).not.toBe('ok')
      expect(item.session).toBeNull()
      expect(item.weekly).toBeNull()
    }
    expect(await h.client.callAny('setting.get', { id: 'setting:quirky.accounts/gemini-cli-oauth-enabled' })).toMatchObject({ value: false })
    const codexHome = defaultHome(h.home, 'codex')
    process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-api-key-secret'
    writePrivateJson(join(codexHome, 'auth.json'), { auth_mode: 'apikey', api_key: 'fixture-codex-api-key-secret' })
    const claudeApiKeyOnly = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
    const codexApiKeyOnly = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
    expect(snapshot(claudeApiKeyOnly, 'claude')).toMatchObject({ status: 'unavailable', session: null, error: 'No subscription plan — API key billing' })
    expect(snapshot(codexApiKeyOnly, 'codex')).toMatchObject({ status: 'unavailable', session: null, weekly: null })

    const preferences = await call<AccountState>(h, 'quirky.accounts/setPreferences', {
      mode: 'detailed',
      direction: 'remaining',
      hidden: true,
      visibleProviders: ['claude', 'codex', 'minimax', 'opencode-go', 'zcode'],
      density: 'icons'
    })
    expect(preferences.preferences).toMatchObject({
      mode: 'detailed',
      direction: 'remaining',
      hidden: true,
      visibleProviders: ['claude', 'codex', 'minimax', 'opencode-go', 'zcode'],
      density: 'icons'
    })
    expect(await call<AccountUiState>(h, 'quirky.accounts/setUiState', { open: true, provider: 'minimax', expanded: 'claude', settingsSection: 'accounts' }))
      .toEqual({ open: true, provider: 'minimax', expanded: 'claude', settingsSection: 'accounts' })

    const claudeHome = defaultHome(h.home, 'claude')
    writePrivateJson(join(claudeHome, '.credentials.json'), { claudeAiOauth: { accessToken: 'fixture-claude-api-secret', refreshToken: 'fixture-claude-refresh-secret' } })
    writePrivateJson(join(claudeHome, '.claude.json'), { oauthAccount: { emailAddress: 'usage@example.test' } })
    writePrivateJson(join(codexHome, 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-codex-api-secret', account_id: 'usage-workspace' }
    })
    writePrivateJson(join(h.userHome, '.gemini', 'oauth_creds.json'), {
      access_token: 'fixture-gemini-api-secret',
      refresh_token: 'fixture-gemini-refresh-secret',
      expiry_date: Date.now() + 60 * 60_000
    })
    writeAntigravityCli(h.fakeBin)
    writePrivateJson(join(h.userHome, '.kimi-code', 'credentials', 'kimi-code.json'), {
      access_token: 'fixture-kimi-api-secret',
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60
    })
    const grokHome = join(h.home, 'fixture-grok')
    process.env.GROK_HOME = grokHome
    writePrivateJson(join(grokHome, 'auth.json'), {
      'https://auth.x.ai': { key: 'fixture-grok-api-secret', user_id: 'fixture-user', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }
    })
    const cursorToken = jwt('auth0|cursor-acceptance', Math.floor(Date.now() / 1000) + 60 * 60)
    writeCursorCliCredential(h.userHome, cursorToken)

    await h.client.callAny('setting.set', { id: 'setting:quirky.accounts/gemini-cli-oauth-enabled', value: true })
    const configuredCredentials = [
      ['minimax', 'api-key', 'fixture-minimax-api-secret'],
      ['opencode-go', 'api-key', 'fixture-opencode-go-api-secret'],
      ['zcode', 'api-key', 'fixture-zcode-api-secret'],
      ['zcode', 'base-url', 'https://api.z.ai']
    ] as const
    const credentialResults: unknown[] = []
    for (const [provider, kind, value] of configuredCredentials) {
      credentialResults.push(await h.client.callAny('quirky.accounts/setCredential', { provider, kind, value }))
    }

    const externalRequests = new Map<string, number>()
    const recordRequest = (url: URL): void => {
      const key = `${url.hostname}${url.pathname}`
      externalRequests.set(key, (externalRequests.get(key) ?? 0) + 1)
    }
    const now = Date.now()
    const resetAt = new Date(now + 60 * 60_000).toISOString()
    const resetSeconds = Math.floor(Date.parse(resetAt) / 1000)
    const fetchFixture = interceptProviderFetch((url) => {
      recordRequest(url)
      if (url.hostname === 'api.anthropic.com' && url.pathname === '/api/oauth/usage') {
        return Response.json({
          five_hour: { utilization: 39, resets_at: resetAt },
          seven_day: { utilization: 26, resets_at: resetAt },
          limits: [{ kind: 'weekly_scoped', percent: 0, resets_at: resetAt, scope: { model: { display_name: 'Fable' } } }]
        })
      }
      if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/wham/usage') {
        return Response.json({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 43, limit_window_seconds: 18_000, reset_at: resetSeconds },
            secondary_window: { used_percent: 1, limit_window_seconds: 604_800, reset_at: resetSeconds }
          }
        })
      }
      if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/wham/rate-limit-reset-credits') {
        return Response.json({ available_count: 1, total_earned_count: 3, credits: [{ status: 'available', expires_at: resetSeconds, granted_at: resetSeconds - 100 }] })
      }
      if (url.hostname === 'api.z.ai' && url.pathname === '/api/monitor/usage/quota/limit') {
        return Response.json({
          success: true,
          code: 200,
          data: {
            level: 'GLM Coding Plan',
            limits: [
              { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 100, currentValue: 27, nextResetTime: now + 60 * 60_000 },
              { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 50, nextResetTime: now + 30 * 86_400_000 }
            ]
          }
        })
      }
      return null
    })
    let restarted: RestartedAccounts | undefined
    try {
      const refreshed = await call<UsageState>(h, 'quirky.accounts/refresh', { force: true })
      expect(refreshed.providers.map((item) => item.provider)).toEqual([
        'claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'
      ])
      expect(snapshot(refreshed, 'claude')).toMatchObject({
        status: 'ok',
        session: { usedPercent: 39, windowMinutes: 300 },
        weekly: { usedPercent: 26, windowMinutes: 10_080 },
        fableWeekly: { usedPercent: 0 },
        usageMetadata: { source: 'oauth', credentialSource: 'credentials-file' }
      })
      expect(snapshot(refreshed, 'codex')).toMatchObject({
        status: 'ok',
        session: { usedPercent: 43, windowMinutes: 300 },
        weekly: { usedPercent: 1, windowMinutes: 10_080 },
        planType: 'plus',
        rateLimitResetCredits: { availableCount: 1 },
        usageMetadata: { source: 'cli' }
      })
      expect(snapshot(refreshed, 'gemini')).toMatchObject({ status: 'ok', session: { usedPercent: 25 }, buckets: [expect.objectContaining({ name: 'Pro', usedPercent: 25 })] })
      expect(snapshot(refreshed, 'antigravity')).toMatchObject({ status: 'ok', session: { usedPercent: 25 }, weekly: { usedPercent: 60 }, usageMetadata: { credentialSource: 'antigravity-cli' } })
      expect(snapshot(refreshed, 'opencode-go')).toMatchObject({ status: 'ok', session: { usedPercent: 20 }, weekly: { usedPercent: 10 }, usageMetadata: { credentialSource: 'settings' } })
      expect(snapshot(refreshed, 'kimi')).toMatchObject({ status: 'ok', weekly: { usedPercent: 25 }, usageMetadata: { credentialSource: 'kimi-cli' } })
      expect(snapshot(refreshed, 'minimax')).toMatchObject({ status: 'ok', session: { usedPercent: 25 }, weekly: { usedPercent: 40 }, usageMetadata: { credentialSource: 'api-key' } })
      expect(snapshot(refreshed, 'grok')).toMatchObject({ status: 'ok', weekly: { usedPercent: 25 }, usageMetadata: { credentialSource: 'grok-cli' } })
      const grokUsageUrl = 'cli-chat-proxy.grok.com/v1/billing'
      const grokRequests = externalRequests.get(grokUsageUrl) ?? 0
      writePrivateJson(join(grokHome, 'auth.json'), {
        'https://auth.x.ai': { key: 'fixture-grok-api-secret', user_id: 'fixture-user', expires_at: new Date(Date.now() - 60 * 60_000).toISOString() }
      })
      const expiredGrok = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'grok', force: true })
      expect(snapshot(expiredGrok, 'grok')).toMatchObject({ status: 'error', weekly: { usedPercent: 25 }, usageMetadata: { failureKind: 'delegated-refresh-required' } })
      expect(externalRequests.get(grokUsageUrl) ?? 0).toBe(grokRequests)
      expect(snapshot(refreshed, 'cursor')).toMatchObject({ status: 'ok', session: null, weekly: null, planType: 'fixture' })
      expect(snapshot(refreshed, 'zcode')).toMatchObject({ status: 'ok', weekly: { usedPercent: 27 }, monthly: { usedPercent: 50 }, planType: 'GLM Coding Plan', usageMetadata: { credentialSource: 'settings' } })

      const credentialState = await call<{ provider: string; kind: string; configured: boolean; readable: boolean }[]>(h, 'quirky.accounts/credentialStatus')
      expect(credentialState).toContainEqual({ provider: 'minimax', kind: 'api-key', configured: true, readable: true })
      expect(credentialState).toContainEqual({ provider: 'opencode-go', kind: 'api-key', configured: true, readable: true })
      expect(credentialState).toContainEqual({ provider: 'zcode', kind: 'api-key', configured: true, readable: true })
      const secretValues = [
        ...configuredCredentials.map(([, , value]) => value),
        'fixture-claude-api-secret', 'fixture-claude-refresh-secret', 'fixture-codex-api-secret',
        'fixture-anthropic-api-key-secret', 'fixture-codex-api-key-secret',
        'fixture-gemini-api-secret', 'fixture-gemini-refresh-secret', 'fixture-kimi-api-secret',
        'fixture-grok-api-secret', cursorToken
      ]
      const apiAndEventOutput = JSON.stringify({
        credentialResults,
        credentialState,
        preferences: (await call<AccountState>(h, 'quirky.accounts/list')).preferences,
        refreshed,
        current: await call<UsageState>(h, 'quirky.accounts/usage'),
        events: h.events,
        catalog: await h.client.callAny('api.describe', {})
      })
      for (const secret of secretValues) expect(apiAndEventOutput).not.toContain(secret)
      const snapshotPath = join(h.home, 'plugin-data', 'quirky.accounts', 'usage-snapshots.json')
      const persistedSnapshots = readFileSync(snapshotPath, 'utf8')
      for (const secret of secretValues) expect(persistedSnapshots).not.toContain(secret)
      const daemonLogPath = join(h.home, 'logs', 'daemon.log')
      const daemonLog = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : ''
      for (const secret of secretValues) expect(daemonLog).not.toContain(secret)

      const beforeClear = new Map(externalRequests)
      const requestsBeforeClear = [...externalRequests.values()].reduce((total, count) => total + count, 0)
      for (const [provider, kind] of [['minimax', 'api-key'], ['opencode-go', 'api-key'], ['zcode', 'api-key']] as const) {
        await h.client.callAny('quirky.accounts/clearCredential', { provider, kind })
        const state = await call<UsageState>(h, 'quirky.accounts/refresh', { provider, force: true })
        expect(snapshot(state, provider)).toMatchObject({ status: 'unavailable', session: null, weekly: null })
      }
      for (const [url, count] of beforeClear) expect(externalRequests.get(url)).toBe(count)
      expect([...externalRequests.values()].reduce((total, count) => total + count, 0)).toBe(requestsBeforeClear)
      const clearedOutput = JSON.stringify({ events: h.events, credentials: await call(h, 'quirky.accounts/credentialStatus'), state: await call(h, 'quirky.accounts/usage') })
      for (const secret of secretValues) expect(clearedOutput).not.toContain(secret)

      restarted = await restartAccounts(h)
      expect(await restarted.client.callAny('quirky.accounts/list', {})).toMatchObject({
        preferences: {
          mode: 'detailed', direction: 'remaining', hidden: true,
          visibleProviders: ['claude', 'codex', 'minimax', 'opencode-go', 'zcode'], density: 'icons'
        }
      })
      expect(await restarted.client.callAny('quirky.accounts/uiState', {})).toEqual({ open: false, provider: null, expanded: null, settingsSection: null })
      const restartedState = JSON.stringify({ list: await restarted.client.callAny('quirky.accounts/list', {}), usage: await restarted.client.callAny('quirky.accounts/usage', {}) })
      for (const secret of secretValues) expect(restartedState).not.toContain(secret)
    } finally {
      await fetchFixture.restore()
      await restarted?.close()
    }
  })

  test('usage API keeps stale readings within policy, honors both Retry-After formats and fences late account responses', async () => {
    const h = await startAccounts()
    const managed = await add(h, 'claude', 'generation@example.test')
    const managedId = managed.result?.id ?? ''
    const defaultClaude = defaultHome(h.home, 'claude')
    writePrivateJson(join(defaultClaude, '.credentials.json'), { claudeAiOauth: { accessToken: 'fixture-default-claude-token' } })

    let now = nativeDateNow()
    Date.now = () => now
    let requestNumber = 0
    let deferNext = false
    let returnManagedReading = false
    let lateResponseResolved = false
    const lateResponse = Promise.withResolvers<Response>()
    const lateRequestStarted = Promise.withResolvers<void>()
    const retryDate = (): Response => {
      const date = new Date(now + 60_000).toUTCString()
      return new Response('', { status: 429, headers: { 'Retry-After': date } })
    }
    const fetchFixture = interceptProviderFetch((url) => {
      if (url.hostname !== 'api.anthropic.com' || url.pathname !== '/api/oauth/usage') return null
      requestNumber += 1
      if (deferNext) {
        deferNext = false
        lateRequestStarted.resolve()
        return lateResponse.promise
      }
      if (requestNumber === 1) {
        return Response.json({
          five_hour: { utilization: 75, resets_at: new Date(now + 60 * 60_000).toISOString() },
          seven_day: { utilization: 26, resets_at: new Date(now + 7 * 86_400_000).toISOString() }
        })
      }
      if (requestNumber === 2 || requestNumber === 3) throw new Error('fixture network failure')
      if (requestNumber === 4) return new Response('', { status: 429, headers: { 'Retry-After': '120' } })
      if (requestNumber === 5) return retryDate()
      if (returnManagedReading) {
        return Response.json({ five_hour: { utilization: 42, resets_at: new Date(now + 60 * 60_000).toISOString() }, seven_day: { utilization: 15, resets_at: new Date(now + 7 * 86_400_000).toISOString() } })
      }
      return Response.json({ five_hour: { utilization: 91, resets_at: new Date(now + 60 * 60_000).toISOString() }, seven_day: { utilization: 17, resets_at: new Date(now + 7 * 86_400_000).toISOString() } })
    })
    let lateRefresh: Promise<UsageState> | undefined
    try {
      let usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'ok', session: { usedPercent: 75 } })
      usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude' })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'ok', session: { usedPercent: 75 } })
      expect(requestNumber).toBe(1)

      now += 1_000
      usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'error', session: { usedPercent: 75 }, usageMetadata: { failureKind: 'network' } })

      now += 30 * 60_000 + 1
      usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'error', session: null, weekly: null })

      now += 1_000
      usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'error', session: { usedPercent: 75 }, usageMetadata: { failureKind: 'rate-limited', retryAtMs: now + 120_000 } })
      const beforeRetry = requestNumber
      await call(h, 'quirky.accounts/refresh', { provider: 'claude' })
      expect(requestNumber).toBe(beforeRetry)

      now += 1_000
      const expectedDateRetry = Date.parse(new Date(now + 60_000).toUTCString())
      usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(usage, 'claude')).toMatchObject({ status: 'error', session: { usedPercent: 75 }, usageMetadata: { failureKind: 'rate-limited', retryAtMs: expectedDateRetry } })
      await call(h, 'quirky.accounts/refresh', { provider: 'claude' })
      expect(requestNumber).toBe(5)

      deferNext = true
      lateRefresh = call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      await lateRequestStarted.promise
      returnManagedReading = true
      const selected = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: managedId })
      expect(selected.active.claude).toBe(managedId)
      const freshForManaged = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
      expect(snapshot(freshForManaged, 'claude')).toMatchObject({ accountId: managedId, status: 'ok', session: { usedPercent: 42 } })
      lateResponseResolved = true
      lateResponse.resolve(Response.json({
        five_hour: { utilization: 91, resets_at: new Date(now + 60 * 60_000).toISOString() },
        seven_day: { utilization: 17, resets_at: new Date(now + 7 * 86_400_000).toISOString() }
      }))
      await lateRefresh
      returnManagedReading = false
      usage = await call<UsageState>(h, 'quirky.accounts/usage')
      expect(snapshot(usage, 'claude')).toMatchObject({ accountId: managedId, status: 'ok', session: { usedPercent: 42 } })
      expect(JSON.stringify(usage)).not.toContain('fixture-default-claude-token')
    } finally {
      if (lateRefresh && !lateResponseResolved) {
        lateResponseResolved = true
        lateResponse.resolve(new Response('', { status: 500 }))
      }
      if (lateRefresh) await lateRefresh.catch(() => undefined)
      await fetchFixture.restore()
      Date.now = nativeDateNow
    }
  })

  test('focus refresh resumes after a skipped startup run and debounces while manual refresh bypasses it', async () => {
    const h = await startAccounts()
    await h.client.callAny('quirky.accounts/setCredential', { provider: 'opencode-go', kind: 'api-key', value: 'fixture-opencode-focus-secret' })
    const actualNow = Date.now
    let offset = 0
    let usedPercent = 20
    let usageRequests = 0
    Date.now = () => actualNow() + offset
    const fetchFixture = interceptProviderFetch((url) => {
      if (url.hostname !== 'opencode.ai' || url.pathname !== '/zen/go/v1/usage') return null
      usageRequests += 1
      const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString()
      return Response.json({ usage: { rolling: { percent: usedPercent, resetsAt }, weekly: { percent: 10, resetsAt } } })
    })
    const currentUsed = async () => snapshot(await call<UsageState>(h, 'quirky.accounts/usage'), 'opencode-go').session?.usedPercent
    try {
      await h.client.callAny('job.run', { id: 'job:quirky.accounts/usage-refresh' })
      expect(usageRequests).toBe(0)

      const ui = await h.harness.connect('ui', 'accounts-focused-window')
      await ui.call('ui.window.focused', { focused: true })
      await ui.call('ui.window.activity', {})
      await waitForAsync(async () => await currentUsed() === 20 || undefined)
      expect(usageRequests).toBe(1)

      await call(h, 'quirky.accounts/refresh', { provider: 'opencode-go', force: true })
      expect(usageRequests).toBe(2)
      await h.client.callAny('job.run', { id: 'job:quirky.accounts/usage-refresh' })
      expect(usageRequests).toBe(2)

      await ui.call('ui.window.focused', { focused: false })
      offset = 6 * 60_000
      usedPercent = 44
      await ui.call('ui.window.focused', { focused: true })
      await ui.call('ui.window.activity', {})
      await waitForAsync(async () => await currentUsed() === 44 || undefined)
      expect(usageRequests).toBe(3)
      await ui.call('ui.window.focused', { focused: false })
      await ui.call('ui.window.focused', { focused: true })
      await h.client.callAny('job.run', { id: 'job:quirky.accounts/usage-refresh' })
      expect(usageRequests).toBe(3)
    } finally {
      await fetchFixture.restore()
      Date.now = actualNow
    }
  })

  test('authenticated session-info Claude hook updates only the account identity recorded by prepare', async () => {
    const h = await startAccounts()
    const accountA = await add(h, 'claude', 'hook-a@example.test')
    const accountB = await add(h, 'claude', 'hook-b@example.test')
    const idA = accountA.result?.id
    const idB = accountB.result?.id
    if (!idA || !idB) throw new Error('Completed Claude logins did not return account IDs')
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
    const sessionId = 'session-info-acceptance'
    const prepared = await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', {
      agent: 'claude', sessionId, worktreeId: 'worktree-acceptance', cwd: h.userHome,
      homeOverrides: { claude: { value: null, source: 'absent' }, codex: { value: null, source: 'absent' } }
    })
    expect(prepared.account).toEqual({ provider: 'claude', id: idA, label: 'hook-a@example.test', source: 'managed', authKind: 'oauth' })
    const configDir = prepared.env.CLAUDE_CONFIG_DIR
    expect(configDir).toBe(h.managedHome('claude', idA))
    const payload = {
      rate_limits: {
        five_hour: { utilization: 33, resets_at: new Date(Date.now() + 60 * 60_000).toISOString() },
        seven_day: { utilization: 12, resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString() }
      }
    }
    const url = `http://127.0.0.1:${h.harness.runtime.port}${HOOK_PATH_PREFIX}session-info-claude?session=${encodeURIComponent(sessionId)}`
    const postStatusline = () => fetch(url, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: h.harness.runtime.hookToken, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const posted = await postStatusline()
    expect(posted.status).toBe(200)
    const live = await waitForAsync(async () => {
      const state = await call<UsageState>(h, 'quirky.accounts/usage')
      const current = snapshot(state, 'claude')
      return current.usageMetadata?.source === 'live-session' ? current : undefined
    })
    expect(live).toMatchObject({ accountId: idA, session: { usedPercent: 33 }, weekly: { usedPercent: 12 }, usageMetadata: { source: 'live-session' } })

    const eventCount = h.events.filter((event) => event.type === 'quirky.accounts/usageChanged').length
    expect((await postStatusline()).status).toBe(200)
    await call<UsageState>(h, 'quirky.accounts/usage')
    expect(h.events.filter((event) => event.type === 'quirky.accounts/usageChanged').length).toBe(eventCount)

    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    const refreshedB = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'claude', force: true })
    expect(snapshot(refreshedB, 'claude')).toMatchObject({ accountId: idB, status: 'ok' })
    expect((await postStatusline()).status).toBe(200)
    await call<UsageState>(h, 'quirky.accounts/usage')
    const afterSelection = snapshot(await call<UsageState>(h, 'quirky.accounts/usage'), 'claude')
    expect(afterSelection).toMatchObject({ accountId: idB, status: 'ok' })
    expect(afterSelection.session?.usedPercent).not.toBe(33)
    expect(configDir).not.toContain('fixture-claude-token')
  })

  test('Codex reset confirmation rejects stale account scope and binds a request ID against retry migration', async () => {
    const h = await startAccounts()
    writePrivateJson(join(defaultHome(h.home, 'codex'), 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-default-codex-secret', account_id: 'default-workspace' }
    })
    const managed = await add(h, 'codex', 'reset-account-a@example.test')
    const idA = managed.result?.id ?? ''
    const firstState = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
    const offerA = snapshot(firstState, 'codex').rateLimitResetCredits
    expect(offerA?.expectedScope).toEqual({ accountId: idA, accountRevision: expect.any(Number), offerRevision: expect.any(String) })
    const scopeA = offerA?.expectedScope as ResetCreditExpectedScope
    const idempotencyKey = 'accounts-acceptance-reset-request'
    const requested = await h.client.callAny('quirky.accounts/consumeResetCredit', { idempotencyKey, expectedScope: scopeA })
      .then(() => null, (error: unknown) => error as { code?: number; data?: { askId?: string } })
    expect(requested).toMatchObject({ code: RpcErrorCode.ConfirmationRequired })
    const askId = requested?.data?.askId
    expect(askId).toBeTruthy()
    await h.client.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })

    await call(h, 'quirky.accounts/select', { provider: 'codex', accountId: null })
    const secondState = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
    const scopeB = snapshot(secondState, 'codex').rateLimitResetCredits?.expectedScope
    expect(scopeB).toMatchObject({ accountId: null, accountRevision: expect.any(Number), offerRevision: expect.any(String) })
    const consumeRequests: string[] = []
    const fetchFixture = interceptProviderFetch((url, init) => {
      if (url.hostname === 'chatgpt.com' && url.pathname.endsWith('/rate-limit-reset-credits/consume')) {
        consumeRequests.push(new Headers(init?.headers).get('Authorization') ?? '')
      }
      return null
    })
    try {
      const staleSubmission = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey, expectedScope: scopeA, confirmation: askId
      }).then((result: unknown) => ({ result }), (error: unknown) => ({ error }))
      expect('error' in staleSubmission).toBe(true)

      const migratedRetry = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey, expectedScope: scopeB, yes: true
      }).then((result: unknown) => ({ result }), (error: unknown) => ({ error }))
      expect('error' in migratedRetry).toBe(true)
      expect(consumeRequests).toEqual([])
    } finally {
      await fetchFixture.restore()
    }
  })

  test('API catalog, plugin disablement and a public prepare override expose effective daemon state', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    type Catalog = {
      methods: { name: string; plugin: string | null }[]
      cli: { groups: { plugin: string; words: string }[]; commands: { plugin: string; words: string; methods: string[] }[] }
    }
    const initial = await call<Catalog>(h, 'api.describe')
    expect(initial.methods.map((method) => method.name)).toEqual(expect.arrayContaining([
      'quirky.accounts/list', 'quirky.accounts/usage', 'quirky.accounts/setPreferences', 'quirky.accounts/uiState',
      'quirky.accounts/prepare', 'quirky.accounts/refresh', 'quirky.accounts/consumeResetCredit', 'quirky.accounts/setCredential'
    ]))
    expect(initial.cli.groups).toContainEqual(expect.objectContaining({ plugin: 'quirky.accounts', words: 'accounts' }))
    expect(initial.cli.commands).toContainEqual(expect.objectContaining({ plugin: 'quirky.accounts', words: 'accounts refresh' }))
    const initialUi = await call<{ statusBars: { id: string }[] }>(h, 'ui.contributions')
    expect(initialUi.statusBars.map((entry) => entry.id)).toContain('status-bar:quirky.accounts/usage')
    const managed = await add(h, 'claude', 'disabled-routing@example.test')
    const managedId = managed.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: managedId })
    const managedPrepare = await call<{ env: Record<string, string | null> }>(h, 'quirky.accounts/prepare', {
      agent: 'claude', sessionId: 'enabled-accounts-prepare', worktreeId: 'worktree-acceptance', cwd: h.userHome,
      homeOverrides: { claude: { value: null, source: 'absent' }, codex: { value: null, source: 'absent' } }
    })
    expect(managedPrepare.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', managedId))

    await h.client.callAny('plugin.disable', { id: 'quirky.accounts' })
    const disabledPlugin = (await h.client.callAny('plugin.list', {}) as { id: string; state: string }[]).find((plugin) => plugin.id === 'quirky.accounts')
    expect(disabledPlugin?.state).toBe('disabled')
    const disabledCatalog = await call<Catalog>(h, 'api.describe')
    expect(disabledCatalog.methods.some((method) => method.name.startsWith('quirky.accounts/'))).toBe(false)
    expect(disabledCatalog.cli.groups.some((group) => group.plugin === 'quirky.accounts')).toBe(false)
    expect((await call<{ statusBars: { id: string }[] }>(h, 'ui.contributions')).statusBars.map((entry) => entry.id)).not.toContain('status-bar:quirky.accounts/usage')
    const disabledPrepare = await h.client.callAny('quirky.accounts/prepare', {}).then(() => null, (error: unknown) => error as { code?: number })
    expect(disabledPrepare?.code).toBe(RpcErrorCode.MethodNotFound)
    const unmanagedSession = await call<{ id: string }>(h, 'quirky.session/create', { agent: 'claude', worktree: 'floating', cwd: h.userHome })
    expect(h.harness.pty.sessions.get(unmanagedSession.id)?.env.CLAUDE_CONFIG_DIR).toBeUndefined()

    await h.client.callAny('plugin.enable', { id: 'quirky.accounts' })
    const source = join(h.home, 'prepare-override-source')
    mkdirSync(source, { recursive: true, mode: 0o700 })
    writeFileSync(join(source, 'quirky-plugin.json'), JSON.stringify({
      id: 'acme.accounts-prepare',
      apiVersion: '1.0.0',
      name: 'Accounts prepare replacement',
      version: '1.0.0',
      main: 'main.ts',
      activation: 'startup',
      contributes: { 'status-bar': [{ id: 'replacement-usage', title: 'Usage', order: 30 }] },
      overrides: [{
        id: 'method:quirky.accounts/prepare',
        description: 'Returns a third-party preparation identity.',
        params: { type: 'object', additionalProperties: true },
        result: { type: 'object', additionalProperties: true }
      }]
    }))
    writeFileSync(join(source, 'main.ts'), `export function activate(context) {
  context.provide('method:quirky.accounts/prepare', (params) => {
    const provider = params.agent === 'codex' ? 'codex' : 'claude'
    const homeVariable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
    return {
      env: { [homeVariable]: '/third-party/' + provider },
      shellInit: null,
      account: { provider, id: null, label: 'Third-party preparation', source: 'custom' }
    }
  })
}
`)
    await h.client.callAny('plugin.install', { path: source, yes: true })
    const replacedUi = await call<{ statusBars: { id: string }[] }>(h, 'ui.contributions')
    expect(replacedUi.statusBars.map((entry) => entry.id)).toContain('status-bar:acme.accounts-prepare/replacement-usage')
    const replacedCatalog = await call<Catalog>(h, 'api.describe')
    expect(replacedCatalog.methods.find((method) => method.name === 'quirky.accounts/prepare')?.plugin).toBe('acme.accounts-prepare')
    const prepared = await call<{ env: Record<string, string | null>; shellInit: string | null; account: { provider: string; id: string | null; label: string; source: string } }>(h, 'quirky.accounts/prepare', {
      agent: 'claude', sessionId: 'third-party-prepare', worktreeId: 'worktree-acceptance', cwd: h.userHome,
      homeOverrides: { claude: { value: null, source: 'absent' }, codex: { value: null, source: 'absent' } }
    })
    expect(prepared).toEqual({
      env: { CLAUDE_CONFIG_DIR: '/third-party/claude' },
      shellInit: null,
      account: { provider: 'claude', id: null, label: 'Third-party preparation', source: 'custom' }
    })
    const codexPrepared = await call<typeof prepared>(h, 'quirky.accounts/prepare', {
      agent: 'codex', sessionId: 'third-party-codex-prepare', worktreeId: 'worktree-acceptance', cwd: h.userHome,
      homeOverrides: { claude: { value: null, source: 'absent' }, codex: { value: null, source: 'absent' } }
    })
    expect(codexPrepared).toEqual({
      env: { CODEX_HOME: '/third-party/codex' },
      shellInit: null,
      account: { provider: 'codex', id: null, label: 'Third-party preparation', source: 'custom' }
    })
  })

  test('prepare exposes exact optional resume metadata and the CLI forwards its JSON flag', async () => {
    const h = await startAccounts()
    type Manifest = {
      contributes: {
        method: { id: string; params?: { properties?: Record<string, unknown> }; result?: { properties?: Record<string, unknown>; required?: string[] } }[]
        'cli-command': { id: string; flags?: Record<string, unknown> }[]
      }
    }
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../quirky-plugin.json'), 'utf8')) as Manifest
    const prepareMethod = manifest.contributes.method.find((method) => method.id === 'prepare')
    const resumeSchema = prepareMethod?.params?.properties?.resume as {
      type?: string
      required?: string[]
      additionalProperties?: boolean
      properties?: Record<string, unknown>
    } | undefined
    expect(resumeSchema).toMatchObject({
      type: 'object',
      required: ['sourceSessionId', 'providerSession'],
      additionalProperties: false
    })
    const providerSessionSchema = resumeSchema?.properties?.providerSession as {
      type?: string
      required?: string[]
      additionalProperties?: boolean
      properties?: Record<string, unknown>
    } | undefined
    expect(providerSessionSchema).toMatchObject({
      type: 'object',
      required: ['id', 'transcriptPath'],
      additionalProperties: false
    })
    const resultSchema = prepareMethod?.result
    expect(resultSchema?.properties?.resumeTranscriptPath).toMatchObject({
      type: 'string',
      description: expect.any(String)
    })
    expect(resultSchema?.required).not.toContain('resumeTranscriptPath')
    const prepareCommand = manifest.contributes['cli-command'].find((command) => command.id === 'prepare')
    expect(prepareCommand?.flags?.resume).toMatchObject({
      type: 'json',
      description: expect.any(String)
    })

    const resume = {
      sourceSessionId: 'source-session-cli',
      providerSession: { id: 'claude-provider-session', transcriptPath: null }
    }
    const cli = testCli(h.client)
    const forwarded: Record<string, unknown>[] = []
    const context = {
      ...cli.ctx,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'quirky.accounts/prepare') forwarded.push(params)
        return cli.ctx.call(method, params)
      }
    }
    await commands.prepare({
      positionals: [],
      flags: {
        agent: 'claude',
        'session-id': 'cli-prepare-resume',
        'worktree-id': 'worktree-cli',
        cwd: h.userHome,
        'home-overrides': {
          claude: { value: null, source: 'absent' },
          codex: { value: null, source: 'absent' }
        },
        resume
      }
    }, context)
    expect(forwarded[0]?.resume).toEqual(resume)
    const codexProviderSessionId = 'f17c7d25-34d0-42a9-9f3e-5406fcae83da'
    const codexHome = defaultHome(h.home, 'codex')
    const codexTranscriptPath = join(
      codexHome,
      'sessions',
      '2026',
      '10',
      '27',
      `rollout-2026-10-27T13-15-00-${codexProviderSessionId}.jsonl`
    )
    mkdirSync(join(codexHome, 'sessions', '2026', '10', '27'), { recursive: true })
    writeFileSync(codexTranscriptPath, '{"type":"session_meta","payload":{"id":"f17c7d25-34d0-42a9-9f3e-5406fcae83da"}}\n')
    const codexCli = testCli(h.client)
    await commands.prepare({
      positionals: [],
      flags: {
        agent: 'codex',
        'session-id': 'cli-codex-prepare-resume',
        'worktree-id': 'worktree-cli',
        cwd: h.userHome,
        'home-overrides': {
          claude: { value: null, source: 'absent' },
          codex: { value: null, source: 'absent' }
        },
        resume: {
          sourceSessionId: 'source-session-cli-codex',
          providerSession: { id: codexProviderSessionId, transcriptPath: codexTranscriptPath }
        }
      }
    }, codexCli.ctx)
    expect(codexCli.lines[0]).toMatchObject({ resumeTranscriptPath: codexTranscriptPath })
  })
})
