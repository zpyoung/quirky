import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type Session } from '@quirky/protocol'
import type { AccountState, ManagedProvider } from '../src/types'
import type { UsageState } from '../src/usage/types'
import type { AccountsHarness } from './support/index'
import { cleanupAll, startAccounts, waitForAsync } from './support/index'
import { interceptProviderFetch, restoreProviderFetchFixtures } from './acceptance-fixtures'
import { addManagedAccount, call, createClaudeSession, restartAndExit, sessionPlugins } from './remaining-support'

afterEach(async () => {
  await cleanupAll()
  await restoreProviderFetchFixtures()
})

type ConfirmationError = { code?: number; data?: { askId?: string } }

async function requireConfirmation(
  h: AccountsHarness,
  provider: ManagedProvider,
  accountId: string
): Promise<string> {
  const error = await h.client.callAny('quirky.accounts/remove', { provider, accountId }).then(
    () => null,
    (reason: unknown) => reason as ConfirmationError
  )
  expect(error?.code).toBe(RpcErrorCode.ConfirmationRequired)
  const askId = error?.data?.askId
  if (!askId) throw new Error('Account removal did not include a confirmation ask ID')
  return askId
}

function usageFor(state: UsageState, provider: string) {
  const snapshot = state.providers.find((item) => item.provider === provider)
  if (!snapshot) throw new Error(`Missing ${provider} usage snapshot`)
  return snapshot
}

describe('quirky.accounts remaining flow acceptance', () => {
  test('declining account removal preserves the selected profile and its auth bytes', async () => {
    const h = await startAccounts()
    const added = await addManagedAccount(h, 'claude', 'decline-remove@fixture.test')
    const accountId = added.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId })
    const accountHome = h.managedHome('claude', accountId)
    const authPath = join(accountHome, '.credentials.json')
    const authBefore = readFileSync(authPath)
    const askId = await requireConfirmation(h, 'claude', accountId)

    await call(h, 'quirky.ask/answer', {
      askId,
      answers: { confirm: { value: false, source: 'input' } }
    })
    const after = await call<AccountState>(h, 'quirky.accounts/list')
    expect(after.accounts).toContainEqual(expect.objectContaining({ id: accountId, provider: 'claude' }))
    expect(after.active.claude).toBe(accountId)
    expect(existsSync(accountHome)).toBe(true)
    expect(readFileSync(authPath)).toEqual(authBefore)
  })

  test('declining reset-credit confirmation leaves the offer available without provider redemption', async () => {
    const h = await startAccounts()
    const added = await addManagedAccount(h, 'codex', 'decline-reset@fixture.test')
    const accountId = added.id
    const resetAt = Math.floor((Date.now() + 60 * 60_000) / 1000)
    let redemptionCount = 0
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') {
        return Response.json({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: resetAt },
            secondary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_at: resetAt }
          }
        })
      }
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits') {
        return Response.json({ available_count: 1, total_earned_count: 2, credits: [{ status: 'available', expires_at: resetAt, granted_at: resetAt - 100 }] })
      }
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume' && init?.method === 'POST') {
        redemptionCount += 1
        return Response.json({ code: 'reset' })
      }
      return null
    })

    try {
      const before = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
      const expectedScope = usageFor(before, 'codex').rateLimitResetCredits?.expectedScope
      expect(expectedScope).toEqual({ accountId, accountRevision: expect.any(Number), offerRevision: expect.any(String) })
      if (!expectedScope) throw new Error('Codex usage did not include a scoped reset offer')

      const refused = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-remaining-declined-reset',
        expectedScope
      }).then(
        () => null,
        (error: unknown) => error as ConfirmationError
      )
      expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
      const askId = refused?.data?.askId
      if (!askId) throw new Error('Reset confirmation did not include its ask ID')
      await call(h, 'quirky.ask/answer', {
        askId,
        answers: { confirm: { value: false, source: 'input' } }
      })

      const after = await call<UsageState>(h, 'quirky.accounts/usage')
      expect(usageFor(after, 'codex').rateLimitResetCredits).toMatchObject({
        availableCount: 1,
        expectedScope
      })
      expect(redemptionCount).toBe(0)
    } finally {
      await fixture.restore()
    }
  })

  test('Ask keeps or explicitly restarts each stale Claude process without relabeling the kept process', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const accountA = await addManagedAccount(h, 'claude', 'ask-a@fixture.test')
    const accountB = await addManagedAccount(h, 'claude', 'ask-b@fixture.test')
    const idA = accountA.id
    const idB = accountB.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const kept = await createClaudeSession(h)
    const restarted = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: kept.id, status: 'working' })
    await call(h, 'quirky.session/setStatus', { session: restarted.id, status: 'waiting' })

    const selected = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    expect(selected.staleSessions.map((item) => item.sessionId)).toEqual(expect.arrayContaining([kept.id, restarted.id]))
    expect(h.harness.pty.requests.some((request) => request.type === 'kill' && [kept.id, restarted.id].includes(request.sessionId))).toBe(false)

    const keptState = await call<AccountState>(h, 'quirky.accounts/keep', { sessions: [kept.id], selectionRevision: selected.revision })
    expect(keptState.staleSessions).toContainEqual(expect.objectContaining({ sessionId: kept.id, accountId: idA, selectedId: idB, kept: true }))
    const restartedState = await restartAndExit(h, restarted.id, selected.revision)
    const sessions = await call<Session[]>(h, 'quirky.session/list')
    const resumed = sessions.find((session) => session.resumedFrom === restarted.id)
    expect(resumed).toMatchObject({
      agent: 'claude',
      cwd: restarted.cwd,
      providerSession: { id: restarted.providerSession?.id }
    })
    expect(h.harness.pty.sessions.get(kept.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idA))
    expect(resumed ? h.harness.pty.sessions.get(resumed.id)?.env.CLAUDE_CONFIG_DIR : undefined).toBe(h.managedHome('claude', idB))
    expect(restartedState.staleSessions.some((item) => item.sessionId === restarted.id)).toBe(false)
    expect(h.harness.pty.requests.some((request) => request.type === 'kill' && request.sessionId === kept.id)).toBe(false)
  })

  test('Always restarts an idle Claude session on selection while Never leaves running state to future launches', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const accountA = await addManagedAccount(h, 'claude', 'policy-a@fixture.test')
    const accountB = await addManagedAccount(h, 'claude', 'policy-b@fixture.test')
    const accountC = await addManagedAccount(h, 'claude', 'policy-c@fixture.test')
    const idA = accountA.id
    const idB = accountB.id
    const idC = accountC.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const automatic = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: automatic.id, status: 'waiting' })
    await call(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'always' })

    const selectingB = call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    await waitForAsync(async () => h.harness.pty.requests.some(
      (request) => request.type === 'kill' && request.sessionId === automatic.id
    ) || undefined)
    h.harness.pty.exit(automatic.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    const selectedB = await selectingB
    const sessionsAfterAlways = await call<Session[]>(h, 'quirky.session/list')
    const resumedB = sessionsAfterAlways.find((session) => session.resumedFrom === automatic.id)
    expect(resumedB).toBeTruthy()
    expect(resumedB?.providerSession?.id).toBe(automatic.providerSession?.id)
    expect(resumedB ? h.harness.pty.sessions.get(resumedB.id)?.env.CLAUDE_CONFIG_DIR : undefined).toBe(h.managedHome('claude', idB))

    const retained = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: retained.id, status: 'waiting' })
    await call(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'never' })
    const killsBeforeNever = h.harness.pty.requests.filter((request) => request.type === 'kill').length
    const selectedC = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idC })

    expect(selectedC.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: retained.id,
      accountId: idB,
      selectedId: idC,
      queued: false,
      kept: false
    }))
    expect(h.harness.pty.requests.filter((request) => request.type === 'kill')).toHaveLength(killsBeforeNever)
    expect(h.harness.pty.sessions.get(retained.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idB))
    const future = await createClaudeSession(h)
    expect(h.harness.pty.sessions.get(future.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idC))
  })
})
