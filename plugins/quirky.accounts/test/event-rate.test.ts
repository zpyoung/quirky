import { afterEach, describe, expect, test } from 'bun:test'
import { isDeepStrictEqual } from 'node:util'
import type { PluginEvent } from '@quirky/protocol'
import type { AccountState, PendingLogin } from '../src/types'
import type { UsageState } from '../src/usage/types'
import { restoreProviderFetchFixtures } from './acceptance-fixtures'
import { cleanupAll, startAccounts, waitForAsync, type AccountsHarness } from './support/index'

afterEach(async () => {
  await cleanupAll()
  await restoreProviderFetchFixtures()
})

const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

async function finishLogin(h: AccountsHarness, pending: PendingLogin): Promise<PendingLogin> {
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return current.status === 'pending' ? undefined : current
  })
}

async function addClaudeAccount(h: AccountsHarness, email: string): Promise<PendingLogin> {
  h.setLoginMode('complete', email)
  const pending = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider: 'claude' })
  return finishLogin(h, pending)
}

describe('quirky.accounts event rates', () => {
  test('account switches retain the first and latest changed and usage events', async () => {
    const h = await startAccounts()
    const loginA = await addClaudeAccount(h, 'rate-a@example.test')
    const loginB = await addClaudeAccount(h, 'rate-b@example.test')
    const accountAId = loginA.result?.id
    const accountBId = loginB.result?.id
    if (!accountAId || !accountBId) throw new Error('Completed Claude logins did not return account IDs')

    await Bun.sleep(600)
    const before = await call<AccountState>(h, 'quirky.accounts/list')
    const mark = h.events.length
    const firstAccountId = before.active.claude === accountAId ? accountBId : accountAId
    const secondAccountId = firstAccountId === accountAId ? accountBId : accountAId
    const startedAt = performance.now()
    let lastSelection: AccountState | undefined

    for (let index = 0; index < 24; index++) {
      const accountId = index % 2 === 0 ? firstAccountId : secondAccountId
      lastSelection = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId })
    }

    expect(lastSelection?.revision).toBe(before.revision + 24)
    await waitForAsync(async () => {
      const usage = await call<UsageState>(h, 'quirky.accounts/usage')
      const latestUsageEvent = h.events
        .slice(mark)
        .filter((event): event is PluginEvent => event.type === 'quirky.accounts/usageChanged')
        .at(-1)
      return latestUsageEvent && isDeepStrictEqual(latestUsageEvent.data, usage) ? usage : undefined
    }, 5000)
    await Bun.sleep(600)

    const usageSnapshot = await call<UsageState>(h, 'quirky.accounts/usage')
    const elapsed = performance.now() - startedAt
    const limit = 3 + Math.floor(elapsed / 250)
    const received = h.events.slice(mark)
    const changedEvents = received.filter((event): event is PluginEvent => event.type === 'quirky.accounts/changed')
    const usageEvents = received.filter((event): event is PluginEvent => event.type === 'quirky.accounts/usageChanged')
    const revisions = changedEvents.map((event) => {
      const data = event.data
      if (typeof data !== 'object' || data === null || !('revision' in data) || typeof data.revision !== 'number') {
        throw new Error('Changed event omitted a numeric revision')
      }
      return data.revision
    })

    console.info(
      `accounts switch burst: changed=${changedEvents.length}, usageChanged=${usageEvents.length}, elapsed=${elapsed.toFixed(1)}ms, limit=${limit}`
    )

    expect(changedEvents.length).toBeGreaterThanOrEqual(2)
    expect(changedEvents.length).toBeLessThanOrEqual(limit)
    expect(changedEvents.at(-1)?.data).toEqual({ revision: before.revision + 24 })
    expect(revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1])).toBe(true)
    expect(usageEvents.length).toBeGreaterThanOrEqual(2)
    expect(usageEvents.length).toBeLessThanOrEqual(limit)
    expect(usageEvents.at(-1)?.data).toEqual(usageSnapshot)
  }, 30_000)

  test('catalog declares only the two coalesced accounts events and API floor', async () => {
    const h = await startAccounts()
    const catalog = await call<{
      events: { name: string; plugin: string | null; coalesce?: string[]; worktree?: string }[]
    }>(h, 'api.describe')
    const accountEvents = catalog.events.filter((event) => event.plugin === 'quirky.accounts')
    const expectedNames = ['quirky.accounts/changed', 'quirky.accounts/usageChanged']

    expect(accountEvents.map((event) => event.name).sort()).toEqual(expectedNames)
    for (const name of expectedNames) {
      const event = accountEvents.find((candidate) => candidate.name === name)
      expect(event?.coalesce).toEqual([])
      expect(event).not.toHaveProperty('worktree')
    }

    const plugins = await call<{ id: string; apiVersion?: string }[]>(h, 'plugin.list')
    expect(plugins.find((plugin) => plugin.id === 'quirky.accounts')?.apiVersion).toBe('1.3.0')
  })
})
