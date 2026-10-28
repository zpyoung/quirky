import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { AccountState, AccountSummary, ManagedProvider, PendingLogin } from '../src/types'
import type { AccountsHarness } from './support/index'
import { waitForAsync } from './support/index'

export const sessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']

export const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

export async function finishLogin(h: AccountsHarness, pending: PendingLogin): Promise<PendingLogin> {
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

export async function addManagedAccount(
  h: AccountsHarness,
  provider: ManagedProvider,
  email: string
): Promise<AccountSummary> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider })
  const completed = await finishLogin(h, pending)
  if (completed.status !== 'complete' || !completed.result) {
    throw new Error(`${provider} login for ${email} did not produce a saved account`)
  }
  return completed.result
}

export async function createClaudeSession(h: AccountsHarness): Promise<Session> {
  const session = await call<Session>(h, 'quirky.session/create', {
    agent: 'claude',
    worktree: 'floating',
    cwd: h.userHome
  })
  await call(h, 'quirky.session/setProviderSession', {
    session: session.id,
    id: `provider-conversation-claude-policy-${session.id}`,
    transcriptPath: join(h.userHome, 'conversation.jsonl')
  })
  return call<Session>(h, 'quirky.session/get', { session: session.id })
}

export async function restartAndExit(
  h: AccountsHarness,
  sessionId: string,
  selectionRevision: number
): Promise<AccountState> {
  const restarting = call<AccountState>(h, 'quirky.accounts/restart', { sessions: [sessionId], selectionRevision })
  await waitForAsync(async () => h.harness.pty.requests.some(
    (request) => request.type === 'kill' && request.sessionId === sessionId
  ) || undefined)
  h.harness.pty.exit(sessionId, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
  return restarting
}
