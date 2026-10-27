import { afterEach, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import type { AccountState, ManagedProvider, PendingLogin } from '../src/types'
import type { AccountsHarness } from './support/index'
import { cleanupAll, startAccounts, waitForAsync } from './support/index'

afterEach(cleanupAll)

const sessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']
const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) => h.client.callAny(method, params) as Promise<T>

async function add(h: AccountsHarness, provider: ManagedProvider, email: string): Promise<PendingLogin> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider })
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

async function createAgentSession(h: AccountsHarness, agent: 'claude' | 'codex'): Promise<Session> {
  const session = await call<Session>(h, 'quirky.session/create', {
    agent,
    worktree: 'floating',
    cwd: h.userHome
  })
  await call(h, 'quirky.session/setProviderSession', {
    session: session.id,
    id: `provider-conversation-${agent}-fixture`,
    transcriptPath: `${h.userHome}/conversation.jsonl`
  })
  return call<Session>(h, 'quirky.session/get', { session: session.id })
}
async function restartAndExit(h: AccountsHarness, sessionId: string, selectionRevision: number): Promise<AccountState> {
  const restarting = call<AccountState>(h, 'quirky.accounts/restart', { sessions: [sessionId], selectionRevision })
  await waitForAsync(async () => h.harness.pty.requests.some((request) => request.type === 'kill' && request.sessionId === sessionId) || undefined)
  h.harness.pty.exit(sessionId, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
  return restarting
}

describe('quirky.accounts running-session restart state machine', () => {
  test('Codex restarts through public session APIs with the same conversation and cwd under the newly selected home', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const first = await add(h, 'codex', 'first@example.test')
    const second = await add(h, 'codex', 'second@example.test')
    const firstId = first.result?.id ?? ''
    const secondId = second.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'codex', accountId: firstId })
    const old = await createAgentSession(h, 'codex')

    const selected = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'codex', accountId: secondId })
    expect(selected.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: old.id,
      provider: 'codex',
      accountId: firstId,
      accountLabel: 'first@example.test',
      selectedId: secondId,
      selectedLabel: 'second@example.test'
    }))
    const restarted = await restartAndExit(h, old.id, selected.revision)

    const sessions = await call<Session[]>(h, 'quirky.session/list')
    const resumed = sessions.find((session) => session.resumedFrom === old.id)
    expect(resumed).toMatchObject({
      agent: 'codex',
      cwd: old.cwd,
      providerSession: { id: 'provider-conversation-codex-fixture', transcriptPath: `${h.userHome}/conversation.jsonl` }
    })
    expect(sessions.some((session) => session.id === old.id)).toBe(false)
    expect(resumed).toBeTruthy()
    const pty = resumed ? h.harness.pty.sessions.get(resumed.id) : undefined
    expect(pty?.env.CODEX_HOME).toBe(h.managedHome('codex', secondId))
    expect(restarted.active.codex).toBe(secondId)
    expect(restarted.staleSessions.some((stale) => stale.sessionId === old.id)).toBe(false)
    expect(old.launch?.env.CODEX_HOME).toBeUndefined()
  })

  test('a busy Claude restart binds to its selection revision and is not silently retargeted A to B to C', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const a = await add(h, 'claude', 'a@example.test')
    const b = await add(h, 'claude', 'b@example.test')
    const c = await add(h, 'claude', 'c@example.test')
    const idA = a.result?.id ?? ''
    const idB = b.result?.id ?? ''
    const idC = c.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const old = await createAgentSession(h, 'claude')
    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'working' })

    const selectedB = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    const queued = await call<AccountState>(h, 'quirky.accounts/restart', {
      sessions: [old.id],
      selectionRevision: selectedB.revision
    })
    expect(queued.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: old.id,
      queued: true,
      selectedId: idB,
      selectionRevision: selectedB.revision
    }))

    const selectedC = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idC })
    expect(selectedC.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: old.id,
      queued: false,
      selectedId: idC,
      selectionRevision: selectedC.revision
    }))
    await call(h, 'quirky.session/setStatus', { session: old.id, status: 'waiting' })
    const sessionList = await call<Session[]>(h, 'quirky.session/list')
    expect(sessionList.some((session) => session.resumedFrom === old.id)).toBe(false)

    await restartAndExit(h, old.id, selectedC.revision)
    const afterExplicitChoice = await call<Session[]>(h, 'quirky.session/list')
    const resumed = afterExplicitChoice.find((session) => session.resumedFrom === old.id)
    expect(resumed).toMatchObject({ cwd: old.cwd, providerSession: { id: 'provider-conversation-claude-fixture' } })
    expect(resumed).toBeTruthy()
    const pty = resumed ? h.harness.pty.sessions.get(resumed.id) : undefined
    expect(pty?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idC))
  })
})
