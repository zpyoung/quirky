import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcErrorCode, type Session } from '@quirky/protocol'
import type { AccountState, PendingLogin, SessionHomeResult } from '../src/types'
import type { UsageState } from '../src/usage/types'
import type { StructuredRunnerFactory } from '../../quirky.structured/runner'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { cleanupAll, defaultHome, startAccounts, type AccountsHarness } from './support/index'
import { interceptProviderFetch, restoreProviderFetchFixtures } from './acceptance-fixtures'
import { addManagedAccount, call, createClaudeSession, finishLogin, sessionPlugins } from './remaining-support'

setDefaultTimeout(60_000)

const nativeDateNow = Date.now
const gitConfig = isolateGitConfig()
const structuredGlobals = globalThis as typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }
let releaseStructuredRunner: (() => void) | undefined

afterEach(async () => {
  releaseStructuredRunner?.()
  releaseStructuredRunner = undefined
  Date.now = nativeDateNow
  await cleanupAll()
  await restoreProviderFetchFixtures()
  delete structuredGlobals.__QUIRKY_TEST_STRUCTURED_RUNNER__
})

function codexUsageResponse(availableCount = 1): Response {
  const resetAt = Math.floor((Date.now() + 60 * 60_000) / 1000)
  return Response.json({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: resetAt },
      secondary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_at: resetAt }
    },
    rate_limit_reset_credits: {
      available_count: availableCount,
      total_earned_count: 1,
      credits: availableCount > 0
        ? [{ status: 'available', expires_at: resetAt, granted_at: resetAt - 3_600 }]
        : []
    }
  })
}

function codexSnapshot(state: UsageState) {
  const snapshot = state.providers.find((item) => item.provider === 'codex')
  if (!snapshot) throw new Error('Codex usage snapshot is missing')
  return snapshot
}

function managedCodexToken(h: AccountsHarness, accountId: string): string {
  const auth = JSON.parse(readFileSync(join(h.managedHome('codex', accountId), 'auth.json'), 'utf8')) as {
    tokens?: { access_token?: string }
  }
  const token = auth.tokens?.access_token
  if (!token) throw new Error(`Synthetic Codex auth is missing for ${accountId}`)
  return token
}

function codexPrepareArgs(h: AccountsHarness, sessionId: string) {
  return {
    agent: 'codex',
    sessionId,
    worktreeId: 'worktree-accounts-completion',
    cwd: h.userHome,
    homeOverrides: {
      claude: { value: null, source: 'absent' },
      codex: { value: null, source: 'absent' }
    }
  }
}

function nativeConversationFixture(provider: 'claude' | 'codex', home: string, cwd: string): { path: string; contents: string } {
  if (provider === 'claude') {
    const sessionId = 'a61103f9-879c-4bb6-b40a-9214dbe64733'
    const userId = `${sessionId}-user`
    const assistantId = `${sessionId}-assistant`
    const project = `-${cwd.split(/[\\/]/).filter(Boolean).join('-')}`
    const path = join(home, 'projects', project, `${sessionId}.jsonl`)
    const contents = [
      JSON.stringify({
        type: 'user',
        uuid: userId,
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '2.1.80',
        message: { role: 'user', content: 'The lantern repair notes are filed in the green ledger.' },
        timestamp: '2026-10-28T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: assistantId,
        parentUuid: userId,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '2.1.80',
        message: {
          id: assistantId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'I have recorded the maintenance note for later.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 42, output_tokens: 12 }
        },
        timestamp: '2026-10-28T10:00:01.000Z'
      })
    ].join('\n') + '\n'
    return { path, contents }
  }

  const sessionId = 'd3ff7c83-402b-4c05-9ebd-2f385c0db2dc'
  const path = join(home, 'sessions', '2026', '10', '28', `rollout-2026-10-28T10-00-00-${sessionId}.jsonl`)
  const contents = [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'The lantern repair notes are filed in the green ledger.' }]
      }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I have recorded the maintenance note for later.' }]
      }
    })
  ].join('\n') + '\n'
  return { path, contents }
}

async function assertReauthenticationPreservesConversation(provider: 'claude' | 'codex'): Promise<void> {
  const h = await startAccounts()
  const email = `reauth-${provider}@fixture.test`
  const account = await addManagedAccount(h, provider, email)
  const accountHome = h.managedHome(provider, account.id)
  await call(h, 'quirky.accounts/select', { provider, accountId: account.id })

  const sessionId = `reauth-identity-${provider}`
  await call(h, 'quirky.accounts/prepare', {
    agent: provider,
    sessionId,
    worktreeId: `worktree-reauth-${provider}`,
    cwd: h.userHome,
    homeOverrides: {
      claude: { value: null, source: 'absent' },
      codex: { value: null, source: 'absent' }
    }
  })
  const savedSessionHome = { provider, home: accountHome }
  expect(await call<SessionHomeResult>(h, 'quirky.accounts/sessionHome', { session: sessionId })).toEqual(savedSessionHome)

  const conversation = nativeConversationFixture(provider, accountHome, h.userHome)
  mkdirSync(dirname(conversation.path), { recursive: true })
  writeFileSync(conversation.path, conversation.contents)
  const conversationBytes = readFileSync(conversation.path)

  const authPath = join(accountHome, provider === 'claude' ? '.credentials.json' : 'auth.json')
  rmSync(authPath)
  await call(h, 'quirky.accounts/select', { provider, accountId: null })
  const refused = await h.client.callAny('quirky.accounts/select', { provider, accountId: account.id })
    .then(() => null, (error: unknown) => error as { code?: number })
  expect(refused).toMatchObject({ code: RpcErrorCode.Conflict })

  const identity = { id: account.id, provider, email: account.email, label: account.label }
  let state = await call<AccountState>(h, 'quirky.accounts/list')
  expect(state.accounts).toContainEqual(expect.objectContaining({ ...identity, needsSignIn: true }))

  h.setLoginMode('failure')
  const failedLogin = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider, accountId: account.id })
  expect((await finishLogin(h, failedLogin)).status).toBe('error')
  expect(readFileSync(conversation.path)).toEqual(conversationBytes)
  expect(h.managedHome(provider, account.id)).toBe(accountHome)
  expect(await call<SessionHomeResult>(h, 'quirky.accounts/sessionHome', { session: sessionId })).toEqual(savedSessionHome)
  state = await call<AccountState>(h, 'quirky.accounts/list')
  expect(state.accounts).toContainEqual(expect.objectContaining({ ...identity, needsSignIn: true }))

  h.setLoginMode('complete', email)
  const successfulLogin = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider, accountId: account.id })
  const recovered = await finishLogin(h, successfulLogin)
  expect(recovered.status).toBe('complete')
  expect(recovered.result).toMatchObject(identity)
  expect(readFileSync(conversation.path)).toEqual(conversationBytes)
  expect(h.managedHome(provider, account.id)).toBe(accountHome)
  expect(await call<SessionHomeResult>(h, 'quirky.accounts/sessionHome', { session: sessionId })).toEqual(savedSessionHome)
  state = await call<AccountState>(h, 'quirky.accounts/list')
  expect(state.accounts).toContainEqual(expect.objectContaining({ ...identity, needsSignIn: false }))
  expect((await call<AccountState>(h, 'quirky.accounts/select', { provider, accountId: account.id })).active[provider])
    .toBe(account.id)
}

describe('quirky.accounts completion API acceptance', () => {
  test('inactive Codex usage refresh is sequential and debounced for 60 seconds', async () => {
    const h = await startAccounts()
    await addManagedAccount(h, 'codex', 'inactive-a@fixture.test')
    await addManagedAccount(h, 'codex', 'inactive-b@fixture.test')
    const active = await addManagedAccount(h, 'codex', 'inactive-active@fixture.test')
    const accountState = await call<AccountState>(h, 'quirky.accounts/list')
    expect(accountState.active.codex).toBe(active.id)
    const inactiveIds = accountState.accounts
      .filter((account) => account.provider === 'codex' && account.id !== active.id)
      .map((account) => account.id)
    expect(inactiveIds).toHaveLength(2)
    const expectedTokens = inactiveIds.map((accountId) => managedCodexToken(h, accountId))

    let captureRequests = false
    const requests: string[] = []
    const firstResponse = Promise.withResolvers<Response>()
    const firstRequestStarted = Promise.withResolvers<void>()
    const secondRequestStarted = Promise.withResolvers<void>()
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com' || url.pathname !== '/backend-api/wham/usage') return null
      if (!captureRequests) return codexUsageResponse()
      const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? ''
      requests.push(token)
      if (requests.length === 1) {
        firstRequestStarted.resolve()
        return firstResponse.promise
      }
      if (requests.length === 2) secondRequestStarted.resolve()
      return codexUsageResponse()
    })
    let inactiveCall: Promise<UsageState> | undefined
    try {
      await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
      let now = nativeDateNow()
      Date.now = () => now
      captureRequests = true

      inactiveCall = call<UsageState>(h, 'quirky.accounts/inactiveUsage', { provider: 'codex' })
      await firstRequestStarted.promise
      expect(requests).toEqual([expectedTokens[0]])
      firstResponse.resolve(codexUsageResponse())
      await secondRequestStarted.promise
      expect(requests).toEqual(expectedTokens)
      await inactiveCall

      await call<UsageState>(h, 'quirky.accounts/inactiveUsage', { provider: 'codex' })
      expect(requests).toHaveLength(2)
      now += 59_999
      await call<UsageState>(h, 'quirky.accounts/inactiveUsage', { provider: 'codex' })
      expect(requests).toHaveLength(2)
      now += 1
      await call<UsageState>(h, 'quirky.accounts/inactiveUsage', { provider: 'codex' })
      expect(requests.slice(2)).toEqual(expectedTokens)
    } finally {
      firstResponse.resolve(codexUsageResponse())
      if (inactiveCall) await inactiveCall.catch(() => undefined)
      Date.now = nativeDateNow
      await fixture.restore()
    }
  })

  test('a stale Codex reset offer is rejected before provider redemption', async () => {
    const h = await startAccounts()
    await addManagedAccount(h, 'codex', 'stale-offer@fixture.test')
    await call(h, 'quirky.accounts/setPreferences', { skipCodexResetConfirm: true })
    let availableCount = 1
    const redemptionRequests: string[] = []
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') return codexUsageResponse(availableCount)
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume') {
        redemptionRequests.push(String(init?.body ?? ''))
        return Response.json({ code: 'reset' })
      }
      return null
    })
    try {
      const original = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const originalScope = original.rateLimitResetCredits?.expectedScope
      if (!originalScope) throw new Error('Codex usage did not include a reset offer scope')

      availableCount = 0
      const refreshed = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      expect(refreshed.rateLimitResetCredits?.expectedScope).not.toEqual(originalScope)

      const stale = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-completion-stale-offer',
        expectedScope: originalScope
      }).then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
      expect(stale).toMatchObject({ error: { message: expect.stringContaining('Codex reset offer changed') } })
      expect(redemptionRequests).toEqual([])
    } finally {
      await fixture.restore()
    }
  })
  test('stale Codex account and offer scopes return public conflicts without provider redemption', async () => {
    const h = await startAccounts()
    await addManagedAccount(h, 'codex', 'stale-account-a@fixture.test')
    await call(h, 'quirky.accounts/setPreferences', { skipCodexResetConfirm: true })
    let availableCount = 1
    const redemptionRequests: string[] = []
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') return codexUsageResponse(availableCount)
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume') {
        redemptionRequests.push(String(init?.body ?? ''))
        return Response.json({ code: 'reset' })
      }
      return null
    })
    try {
      const initial = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const originalScope = initial.rateLimitResetCredits?.expectedScope
      if (!originalScope) throw new Error('Codex usage did not include an original reset scope')

      const accountB = await addManagedAccount(h, 'codex', 'stale-account-b@fixture.test')
      expect((await call<AccountState>(h, 'quirky.accounts/list')).active.codex).toBe(accountB.id)
      const accountBUsage = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const accountBScope = accountBUsage.rateLimitResetCredits?.expectedScope
      if (!accountBScope) throw new Error('Codex usage did not include the selected account reset scope')
      expect(accountBScope.accountId).toBe(accountB.id)

      const staleAccount = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-completion-stale-account-conflict',
        expectedScope: originalScope
      }).then(() => null, (error: unknown) => error as { code?: number; message?: string })
      expect(staleAccount).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: 'Codex reset offer changed; refresh usage and confirm again'
      })

      const migratedRequest = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-completion-stale-account-conflict',
        expectedScope: accountBScope
      }).then(() => null, (error: unknown) => error as { code?: number; message?: string })
      expect(migratedRequest).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: 'Codex reset idempotency key is already bound to another offer'
      })

      availableCount = 0
      const changedOffer = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const changedOfferScope = changedOffer.rateLimitResetCredits?.expectedScope
      if (!changedOfferScope) throw new Error('Codex usage did not include the changed reset offer scope')
      expect(changedOfferScope.accountId).toBe(accountBScope.accountId)
      expect(changedOfferScope.accountRevision).toBe(accountBScope.accountRevision)
      expect(changedOfferScope.offerRevision).not.toBe(accountBScope.offerRevision)

      const staleOffer = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-completion-stale-offer-conflict',
        expectedScope: accountBScope
      }).then(() => null, (error: unknown) => error as { code?: number; message?: string })
      expect(staleOffer).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: 'Codex reset offer changed; refresh usage and confirm again'
      })
      expect(redemptionRequests).toEqual([])
    } finally {
      await fixture.restore()
    }
  })



  test('successful Codex reset completion and replay return the outcome with current usage state', async () => {
    const h = await startAccounts()
    const account = await addManagedAccount(h, 'codex', 'public-reset-result@fixture.test')
    await call(h, 'quirky.accounts/setPreferences', { skipCodexResetConfirm: true })
    const idempotencyKey = 'accounts-completion-public-reset-result'
    const redemptionIds: string[] = []
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') return codexUsageResponse()
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { redeem_request_id?: string }
        redemptionIds.push(body.redeem_request_id ?? '')
        return Response.json({ code: 'reset' })
      }
      return null
    })
    try {
      const offered = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const expectedScope = offered.rateLimitResetCredits?.expectedScope
      if (!expectedScope) throw new Error('Codex usage did not include a reset offer scope')
      const request = { idempotencyKey, expectedScope }

      const first = await call<{ outcome: string; state: UsageState }>(h, 'quirky.accounts/consumeResetCredit', request)
      const replay = await call<{ outcome: string; state: UsageState }>(h, 'quirky.accounts/consumeResetCredit', request)
      expect(first.outcome).toBe('reset')
      expect(codexSnapshot(first.state)).toMatchObject({
        accountId: account.id,
        status: 'ok',
        rateLimitResetCredits: expect.objectContaining({ expectedScope })
      })
      expect(replay).toEqual(first)
      expect(redemptionIds).toEqual([idempotencyKey])
    } finally {
      await fixture.restore()
    }
  })


  test('an unknown Codex reset outcome retries and replays the same redemption identity', async () => {
    const h = await startAccounts()
    await addManagedAccount(h, 'codex', 'unknown-reset@fixture.test')
    await call(h, 'quirky.accounts/setPreferences', { skipCodexResetConfirm: true })
    const idempotencyKey = 'accounts-completion-unknown-reset'
    const redemptionIds: string[] = []
    let redemptionCount = 0
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') return codexUsageResponse()
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { redeem_request_id?: string }
        redemptionIds.push(body.redeem_request_id ?? '')
        redemptionCount += 1
        return Response.json({ code: redemptionCount === 1 ? 'unknown_provider_outcome' : 'already_redeemed' })
      }
      return null
    })
    try {
      const snapshot = codexSnapshot(await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true }))
      const expectedScope = snapshot.rateLimitResetCredits?.expectedScope
      if (!expectedScope) throw new Error('Codex usage did not include a reset offer scope')
      const request = { idempotencyKey, expectedScope }

      const first = await h.client.callAny('quirky.accounts/consumeResetCredit', request)
        .then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
      expect(first).toMatchObject({ error: { message: expect.stringContaining('unknown reset outcome') } })
      expect(redemptionCount).toBe(1)

      const retry = await call<{ outcome: string; state: UsageState }>(h, 'quirky.accounts/consumeResetCredit', request)
      const replay = await call<{ outcome: string; state: UsageState }>(h, 'quirky.accounts/consumeResetCredit', request)
      expect(retry.outcome).toBe('alreadyRedeemed')
      expect(codexSnapshot(retry.state)).toMatchObject({
        accountId: expectedScope.accountId,
        status: 'ok',
        rateLimitResetCredits: expect.objectContaining({ expectedScope })
      })
      expect(replay).toEqual(retry)
      expect(redemptionIds).toEqual([idempotencyKey, idempotencyKey])
      expect(redemptionCount).toBe(2)
    } finally {
      await fixture.restore()
    }
  })

  test('restoring a valid Codex source config clears its Accounts warning on prepare', async () => {
    const h = await startAccounts()
    const sourceConfig = join(defaultHome(h.home, 'codex'), 'config.toml')
    mkdirSync(defaultHome(h.home, 'codex'), { recursive: true })
    writeFileSync(sourceConfig, 'model = "gpt-5.1"\nmodel_provider = "openai"\n')
    const account = await addManagedAccount(h, 'codex', 'restore-config@fixture.test')
    const managedConfig = join(h.managedHome('codex', account.id), 'config.toml')
    const lastGood = readFileSync(managedConfig, 'utf8')
    expect(lastGood).toContain('model = "gpt-5.1"')

    writeFileSync(sourceConfig, '')
    await call(h, 'quirky.accounts/prepare', codexPrepareArgs(h, 'codex-empty-source'))
    const warning = (await call<AccountState>(h, 'quirky.accounts/list')).configWarnings
      .find((item) => item.accountId === account.id)
    expect(warning?.kind).toBe('source-empty')
    expect(readFileSync(managedConfig, 'utf8')).toBe(lastGood)

    writeFileSync(sourceConfig, 'model = "gpt-5.2"\nmodel_provider = "openai"\n')
    await call(h, 'quirky.accounts/prepare', codexPrepareArgs(h, 'codex-restored-source'))
    const restoredState = await call<AccountState>(h, 'quirky.accounts/list')
    expect(restoredState.configWarnings.some((item) => item.accountId === account.id)).toBe(false)
    expect(readFileSync(managedConfig, 'utf8')).toContain('model = "gpt-5.2"')
  })

  test('Claude reauthentication failure and success preserve native conversation bytes and account identity', async () => {
    await assertReauthenticationPreservesConversation('claude')
  })

  test('Codex reauthentication failure and success preserve native conversation bytes and account identity', async () => {
    await assertReauthenticationPreservesConversation('codex')
  })

  test('structured sessions keep their recorded account and cannot be offered as terminal restarts', async () => {
    const runnerStarted = Promise.withResolvers<void>()
    const runnerGate = Promise.withResolvers<void>()
    releaseStructuredRunner = runnerGate.resolve
    let starts = 0
    let stops = 0
    structuredGlobals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context) => ({
      async start(session) {
        starts += 1
        await context.setProviderSession(session.id, { id: `structured-conversation-${session.id}`, transcriptPath: null })
        runnerStarted.resolve()
        await runnerGate.promise
      },
      async send() {},
      async stop() {
        stops += 1
        runnerGate.resolve()
      }
    })

    const h = await startAccounts({ plugins: [...sessionPlugins, 'quirky.structured'] })
    const accountA = await addManagedAccount(h, 'claude', 'structured-a@fixture.test')
    const accountB = await addManagedAccount(h, 'claude', 'structured-b@fixture.test')
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: accountA.id })
    const terminal = await createClaudeSession(h)
    expect(terminal.kind).toBe('terminal')

    const repo = await call<{ id: string }>(h, 'quirky.repo/add', { path: makeRepo(gitConfig.scratch()) })
    await h.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(h.home, 'worktrees') })
    const [worktree] = await call<{ id: string }[]>(h, 'quirky.worktree/list', { repo: repo.id })
    if (!worktree) throw new Error('Structured-session worktree fixture is missing')
    const structured = await call<Session>(h, 'quirky.structured/create', {
      worktree: worktree.id,
      agent: 'claude',
      prompt: 'keep this background runner alive',
      background: true
    })
    await runnerStarted.promise
    expect(await call<Session>(h, 'quirky.session/get', { session: structured.id })).toMatchObject({
      id: structured.id,
      kind: 'structured',
      agent: 'claude',
      background: true,
      providerSession: { id: `structured-conversation-${structured.id}` }
    })

    const accountHome = h.managedHome('claude', accountA.id)
    const before = await call<SessionHomeResult>(h, 'quirky.accounts/sessionHome', { session: structured.id })
    expect(before).toEqual({ provider: 'claude', home: accountHome })
    const selected = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: accountB.id })
    expect(selected.staleSessions.map((item) => item.sessionId)).toEqual([terminal.id])

    const killsBefore = h.harness.pty.requests.filter((request) => request.type === 'kill').length
    const rejected = await h.client.callAny('quirky.accounts/restart', {
      sessions: [structured.id],
      selectionRevision: selected.revision
    }).then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
    expect('error' in rejected).toBe(true)
    expect(h.harness.pty.requests.filter((request) => request.type === 'kill')).toHaveLength(killsBefore)
    expect(starts).toBe(1)
    expect(stops).toBe(0)
    expect(await call<Session>(h, 'quirky.session/get', { session: structured.id })).toMatchObject({
      id: structured.id,
      kind: 'structured',
      background: true,
      providerSession: { id: `structured-conversation-${structured.id}` }
    })
    expect(await call<SessionHomeResult>(h, 'quirky.accounts/sessionHome', { session: structured.id })).toEqual({
      provider: 'claude',
      home: accountHome
    })
  })
})
