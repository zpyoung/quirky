import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type Session } from '@quirky/protocol'
import type { AccountState, ManagedProvider, PendingLogin } from '../src/types'
import type { ResetCreditExpectedScope, UsageState } from '../src/usage/types'
import { cleanupAll, defaultHome, startAccounts, waitForAsync, type AccountsHarness } from './support/index'
import { interceptProviderFetch, writePrivateJson } from './acceptance-fixtures'

afterEach(cleanupAll)

const sessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']
const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

async function add(h: AccountsHarness, provider: ManagedProvider, email: string): Promise<PendingLogin> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider })
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

function codexOffer(state: UsageState): NonNullable<UsageState['providers'][number]['rateLimitResetCredits']> {
  const offer = state.providers.find((snapshot) => snapshot.provider === 'codex')?.rateLimitResetCredits
  if (!offer) throw new Error('Codex usage omitted reset-credit state')
  return offer
}

async function createClaudeSession(h: AccountsHarness): Promise<Session> {
  const session = await call<Session>(h, 'quirky.session/create', {
    agent: 'claude',
    worktree: 'floating',
    cwd: h.userHome
  })
  await call(h, 'quirky.session/setProviderSession', {
    session: session.id,
    id: 'provider-conversation-claude-fixture',
    transcriptPath: join(h.userHome, 'conversation.jsonl')
  })
  return call<Session>(h, 'quirky.session/get', { session: session.id })
}

describe('remaining account authority', () => {
  test('saving reset opt-out preserves the displayed scope, while account selection still refuses an old unspent scope', async () => {
    const h = await startAccounts()
    writePrivateJson(join(defaultHome(h.home, 'codex'), 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-default-codex-secret', account_id: 'default-workspace' }
    })
    const usage = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
    const scope = codexOffer(usage).expectedScope as ResetCreditExpectedScope
    expect(scope.accountId).toBeNull()
    expect(typeof scope.accountRevision).toBe('number')
    expect(typeof scope.offerRevision).toBe('string')

    const preferences = await call<AccountState>(h, 'quirky.accounts/setPreferences', { skipCodexResetConfirm: true })
    expect(preferences.preferences.skipCodexResetConfirm).toBe(true)
    expect(preferences.revision).toBe(scope.accountRevision)

    let redemptions = 0
    const fixture = interceptProviderFetch((url) => {
      if (url.hostname === 'chatgpt.com' && url.pathname.endsWith('/rate-limit-reset-credits/consume')) redemptions += 1
      return null
    })
    try {
      const request = { idempotencyKey: 'preference-preserved-reset', expectedScope: scope }
      const first = await call(h, 'quirky.accounts/consumeResetCredit', request)
      const replay = await call(h, 'quirky.accounts/consumeResetCredit', request)
      expect(first).toBe('reset')
      expect(replay).toBe(first)
      expect(redemptions).toBe(1)

      const managed = await add(h, 'codex', 'authority-reset@example.test')
      const managedId = managed.result?.id
      if (!managedId) throw new Error('Completed Codex login did not return its account ID')
      const selected = await call<AccountState>(h, 'quirky.accounts/list')
      expect(selected.active.codex).toBe(managedId)
      const stale = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'old-unspent-reset-after-selection',
        expectedScope: scope
      }).then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
      expect('error' in stale).toBe(true)
      expect(redemptions).toBe(1)
    } finally {
      await fixture.restore()
    }
  })

  test('Always queues busy Claude work at the current target through preference saves and supersession, then restarts once at idle', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const a = await add(h, 'claude', 'authority-a@example.test')
    const b = await add(h, 'claude', 'authority-b@example.test')
    const c = await add(h, 'claude', 'authority-c@example.test')
    const idA = a.result?.id ?? ''
    const idB = b.result?.id ?? ''
    const idC = c.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const old = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'working' })

    const selectedB = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    const always = await call<AccountState>(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'always' })
    expect(always.revision).toBe(selectedB.revision)
    const queuedB = await call<AccountState>(h, 'quirky.accounts/restart', {
      sessions: [old.id],
      selectionRevision: selectedB.revision
    })
    expect(queuedB.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, queued: true, selectedId: idB }))

    const display = await call<AccountState>(h, 'quirky.accounts/setPreferences', { direction: 'remaining' })
    expect(display.revision).toBe(selectedB.revision)
    expect(display.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, queued: true, selectedId: idB }))
    const repeatedChoice = await call<AccountState>(h, 'quirky.accounts/restart', {
      sessions: [old.id],
      selectionRevision: selectedB.revision
    })
    expect(repeatedChoice.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, queued: true, selectedId: idB }))

    const selectedC = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idC })
    expect(selectedC.revision).toBeGreaterThan(selectedB.revision)
    expect(selectedC.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: old.id,
      queued: true,
      selectedId: idC,
      selectionRevision: selectedC.revision
    }))
    await expect(call(h, 'quirky.accounts/keep', { sessions: [old.id], selectionRevision: selectedB.revision }))
      .rejects.toMatchObject({ code: RpcErrorCode.Conflict })

    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'waiting' })
    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'waiting' })
    await waitForAsync(async () => h.harness.pty.requests.filter((request) => request.type === 'kill' && request.sessionId === old.id).length || undefined)
    expect(h.harness.pty.requests.filter((request) => request.type === 'kill' && request.sessionId === old.id)).toHaveLength(1)
    h.harness.pty.exit(old.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    const resumed = await waitForAsync(async () => {
      const session = (await call<Session[]>(h, 'quirky.session/list')).find((candidate) => candidate.resumedFrom === old.id)
      if (!session?.providerSession?.id || session.status === 'starting') return undefined
      const pty = h.harness.pty.sessions.get(session.id)
      if (!pty?.info.alive) return undefined
      return session
    })
    expect(resumed.cwd).toBe(old.cwd)
    expect(resumed.providerSession?.id).toBe('provider-conversation-claude-fixture')
    expect(h.harness.pty.sessions.get(resumed.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idC))
    expect((await call<Session[]>(h, 'quirky.session/list')).filter((session) => session.resumedFrom === old.id)).toHaveLength(1)
  })

  test('Never does not restart old work and Keep stays authorized across preference saves without duplicate effects', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const a = await add(h, 'claude', 'never-a@example.test')
    const b = await add(h, 'claude', 'never-b@example.test')
    const idA = a.result?.id ?? ''
    const idB = b.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const old = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'working' })
    const never = await call<AccountState>(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'never' })
    const selectedB = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    expect(selectedB.revision).toBe(never.revision + 1)
    expect(selectedB.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, queued: false, selectedId: idB }))

    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'waiting' })
    const saved = await call<AccountState>(h, 'quirky.accounts/setPreferences', { mode: 'detailed' })
    expect(saved.revision).toBe(selectedB.revision)
    const kept = await call<AccountState>(h, 'quirky.accounts/keep', { sessions: [old.id], selectionRevision: selectedB.revision })
    expect(kept.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, kept: true, selectedId: idB }))
    const repeatedKeep = await call<AccountState>(h, 'quirky.accounts/keep', { sessions: [old.id], selectionRevision: selectedB.revision })
    expect(repeatedKeep.staleSessions).toContainEqual(expect.objectContaining({ sessionId: old.id, kept: true, selectedId: idB }))
    expect(h.harness.pty.requests.some((request) => request.type === 'kill' && request.sessionId === old.id)).toBe(false)
    expect(h.harness.pty.sessions.has(old.id)).toBe(true)
    expect((await call<Session[]>(h, 'quirky.session/list')).some((session) => session.resumedFrom === old.id)).toBe(false)
  })
})
