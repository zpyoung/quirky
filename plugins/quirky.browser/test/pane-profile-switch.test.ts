import { expect, test } from 'bun:test'
import type { QuirkyEvent } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneFrame, PaneTab } from '../src/pane-contract'

const call = (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${name}`, params)

function paneFrame(event: QuirkyEvent): PaneFrame | undefined {
  if (event.type !== 'quirky.browser/paneFrame' || !('data' in event)) return undefined
  return event.data as PaneFrame
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = read()
    if (value != null) return value
    await Bun.sleep(20)
  }
  throw new Error('condition did not become true')
}

test('switching a streaming Watch pane from Default to a new profile attaches to the new browser', async () => {
  const h = await startBrowserHarness()
  const events: QuirkyEvent[] = []
  try {
    const worktree = await h.addFolderWorktree('pane-profile-switch-default')
    await h.client.call('events.subscribe', {})
    const unsubscribe = h.client.onEvent((event) => events.push(event))
    try {
      const pane = await call(h, 'paneOpen', {
        worktree: `id:${worktree}`, mode: 'watch', url: `${h.fixtureUrl}events`
      }) as PaneTab
      const lease = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === lease.watchId))

      const created = (await call(h, 'profileCreate', { name: 'QA' }) as { profile: { id: string } }).profile.id
      const switched = (await call(h, 'profileSet', { pane: pane.id, profile: created }) as { pane: PaneTab }).pane
      expect(switched).toMatchObject({ id: pane.id, mode: 'watch', profileId: created, url: pane.url, error: null })
    } finally {
      unsubscribe()
    }
  } finally {
    await h.cleanup()
  }
}, 120_000)

test('a failed profile switch reports plain words and leaves the pane on its profile with its Watch running', async () => {
  let blockedProfile: string | undefined
  let harness: BrowserTestHarness | undefined
  const h = await startBrowserHarness({
    spawn(command, options) {
      const target = blockedProfile && command.some((part) => part.startsWith('--user-data-dir=') && part.includes(blockedProfile!))
      return harness!.scope.spawn(target ? ['/usr/bin/false'] : command, options)
    }
  })
  harness = h
  const events: QuirkyEvent[] = []
  try {
    const worktree = await h.addFolderWorktree('pane-profile-switch-failure')
    await h.client.call('events.subscribe', {})
    const unsubscribe = h.client.onEvent((event) => events.push(event))
    try {
      const pane = await call(h, 'paneOpen', {
        worktree: `id:${worktree}`, mode: 'watch', url: `${h.fixtureUrl}events`
      }) as PaneTab
      const lease = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      const frame = await waitFor(() => events.map(paneFrame).find((item) => item?.watchId === lease.watchId))

      blockedProfile = (await call(h, 'profileCreate', { name: 'QA' }) as { profile: { id: string } }).profile.id
      const failure = await call(h, 'profileSet', { pane: pane.id, profile: blockedProfile }).then(() => undefined, (error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure!.message).not.toMatch(/CDP|epoch|owned/i)

      const state = (await call(h, 'paneState') as { tabs: PaneTab[] }).tabs.find((tab) => tab.id === pane.id)!
      expect(state).toMatchObject({ profileId: 'default', page: pane.page, mode: 'watch' })
      expect(await call(h, 'paneFrameAck', { pane: pane.id, watchId: lease.watchId, sequence: frame.sequence })).toEqual({ acknowledged: true })
    } finally {
      unsubscribe()
    }
  } finally {
    await h.cleanup()
  }
}, 120_000)

test('a profile switch applies the pane viewport and zoom to the new page', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-profile-switch-view')
    const pane = await call(h, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', url: `${h.fixtureUrl}events`
    }) as PaneTab
    await call(h, 'paneControl', { pane: pane.id, action: 'viewport', preset: 'mobile-m' })
    await call(h, 'paneControl', { pane: pane.id, action: 'zoom', level: 1.5 })

    const created = (await call(h, 'profileCreate', { name: 'QA' }) as { profile: { id: string } }).profile.id
    const switched = (await call(h, 'profileSet', { pane: pane.id, profile: created }) as { pane: PaneTab }).pane
    expect(switched).toMatchObject({ profileId: created, viewport: 'mobile-m', zoom: 1.5 })
    expect(switched.page).not.toBe(pane.page)

    const applied = await call(h, 'eval', {
      page: switched.page,
      expression: '({ width: screen.width, zoom: document.documentElement.style.zoom })'
    }) as { value: { width: number; zoom: string } }
    expect(applied.value.width).toBe(375)
    expect(Number(applied.value.zoom)).toBeCloseTo(1.2 ** 1.5, 5)
  } finally {
    await h.cleanup()
  }
}, 120_000)
