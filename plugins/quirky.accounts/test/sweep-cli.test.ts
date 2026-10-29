import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountState, PendingLogin } from '../src/types'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { cleanupAll, startAccounts, waitForAsync, type AccountsHarness } from './support/index'

afterEach(cleanupAll)

const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

async function runJson<T>(home: string, args: string[]): Promise<T> {
  const result = await runCli([...args, '--json'], { home })
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as T
}

describe('generated accounts CLI dispatch', () => {
  test('reads and cancels a pending native login without changing selection or saved auth bytes', async () => {
    const h = await startAccounts()
    h.setLoginMode('complete', 'saved@example.test')
    const savedLogin = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider: 'codex' })
    const saved = await waitForAsync(async () => {
      const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: savedLogin.id })
      return current.status === 'complete' ? current : undefined
    })
    expect(saved.result).not.toBeNull()
    const savedAccountId = saved.result?.id
    if (savedAccountId === undefined) throw new Error('completed fixture login did not produce an account')

    await call(h, 'quirky.accounts/select', { provider: 'codex', accountId: savedAccountId })
    const selectedBefore = await call<AccountState>(h, 'quirky.accounts/list')
    expect(selectedBefore.active.codex).toBe(savedAccountId)
    const savedAuthPath = join(h.managedHome('codex', savedAccountId), 'auth.json')
    const savedAuthBefore = readFileSync(savedAuthPath)

    h.setLoginMode('pending', 'pending@example.test')
    const pending = await runJson<PendingLogin>(h.home, ['accounts', 'add', '--provider', 'codex'])
    expect(pending).toMatchObject({ provider: 'codex', status: 'pending' })
    if (pending.accountId === null) throw new Error('new fixture login did not receive a private account ID')
    const pendingHome = h.managedHome('codex', pending.accountId)

    const status = await runJson<PendingLogin>(h.home, ['accounts', 'login-status', '--id', pending.id])
    expect(status).toMatchObject({ id: pending.id, provider: 'codex', status: 'pending', accountId: pending.accountId })

    const cancelled = await runJson<PendingLogin>(h.home, ['accounts', 'cancel-login', '--id', pending.id])
    expect(cancelled).toMatchObject({ id: pending.id, status: 'cancelled' })
    expect((await call<AccountState>(h, 'quirky.accounts/list')).active.codex).toBe(savedAccountId)
    expect(readFileSync(savedAuthPath)).toEqual(savedAuthBefore)
    expect(existsSync(pendingHome)).toBe(false)
  })
})
