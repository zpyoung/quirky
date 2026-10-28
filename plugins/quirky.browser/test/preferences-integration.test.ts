import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneTab } from '../src/pane-contract'
import type { PreferencesState } from '../src/preferences/contract'

const call = (h: BrowserTestHarness, method: string, params: Record<string, unknown> = {}) => h.client.callAny(`quirky.browser/${method}`, params)

async function profile(h: BrowserTestHarness, name = 'Review') {
  const created = await call(h, 'profileCreate', { name }) as { profile: { id: string } }
  return created.profile.id
}

async function cli(h: BrowserTestHarness, argv: string[]) {
  const client = await h.daemon.connect('cli')
  let stdout = ''
  let stderr = ''
  const code = await run({ argv, env: { QUIRKY_HOME: h.home }, cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used by Browser preferences' }) })
  return { code, stdout, stderr }
}

test('profile menus API persists creation and switches only the requested hosted pane without starting Chrome', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('ProfileMenus')
    const created = await cli(h, ['browser', 'tab', 'profile', 'create', '--label', 'Review', '--json'])
    expect(created.code).toBe(0)
    const first = await call(h, 'paneOpen', { worktree, mode: 'native', url: 'https://example.test/first' }) as PaneTab
    const createdProfile = JSON.parse(created.stdout) as { profile: { id: string } }
    const id = createdProfile.profile.id
    const other = await call(h, 'paneOpen', { worktree, mode: 'native', url: 'https://example.test/other' }) as PaneTab
    const switched = await cli(h, ['browser', 'tab', 'profile', 'set', '--pane', first.id, '--profile', id, '--json'])
    expect(switched.code).toBe(0)
    expect(JSON.parse(switched.stdout)).toEqual({ pane: expect.objectContaining({ id: first.id, tabId: first.tabId, url: first.url, profileId: id, partition: `persist:quirky-browser-${id}` }) })
    const state = await call(h, 'paneState') as { tabs: PaneTab[] }
    expect(state.tabs.find((pane) => pane.id === other.id)?.profileId).toBe('default')
    await expect(call(h, 'profileSet', { pane: first.id, profile: 'profile_missing' })).rejects.toThrow()
    await expect(call(h, 'profileDelete', { profile: id, yes: true })).rejects.toThrow()
    const preferences = await call(h, 'preferencesState') as PreferencesState
    expect(preferences.profiles.find((entry) => entry.profile.id === id)?.active).toBe(true)
    const afterFailure = await call(h, 'paneState') as { tabs: PaneTab[] }
    expect(afterFailure.tabs.find((pane) => pane.id === first.id)?.profileId).toBe(id)
    expect(h.spawnCount()).toBe(0)
  } finally { await h.cleanup() }
})

test('destructive profile API requires confirmation; absent native window preserves metadata and Chrome data', async () => {
  const h = await startBrowserHarness()
  try {
    const id = await profile(h)
    const directory = join(h.home, 'plugin-data', 'quirky.browser', 'profiles', id)
    mkdirSync(directory, { recursive: true })
    const sentinel = join(directory, 'owned-site-data')
    writeFileSync(sentinel, 'preserve until native clear succeeds')
    await expect(call(h, 'profileDelete', { profile: id })).rejects.toThrow()
    expect(existsSync(sentinel)).toBe(true)
    await expect(call(h, 'profileDelete', { profile: id, yes: true })).rejects.toThrow()
    expect(existsSync(sentinel)).toBe(true)
    const preferences = await call(h, 'preferencesState') as PreferencesState
    expect(preferences.profiles.some((entry) => entry.profile.id === id)).toBe(true)
    await expect(call(h, 'profileDelete', { profile: 'default', yes: true })).rejects.toThrow()
    await expect(call(h, 'profileClearNativeClaim', { request: 'forged' })).rejects.toThrow()
  } finally { await h.cleanup() }
})

test('one-use confirmed native clear claim guards profile reuse and deletion through real daemon routing', async () => {
  const h = await startBrowserHarness()
  const hold = Promise.withResolvers<void>()
  try {
    const worktree = await h.addFolderWorktree('ClearProfile')
    const id = await profile(h)
    const ui = await h.daemon.connect('ui', 'Owned native capability boundary')
    const requested = Promise.withResolvers<{ request: string; partition: string }>()
    const completed = Promise.withResolvers<void>()
    ui.onEvent((event) => {
      if (event.type !== 'ui.command.request' || event.id !== 'command:quirky.browser/profileClearNative') return
      void (async () => {
        try {
          const args = event.args as { request: string }
          const request = args.request
          const claim = await ui.callAny('quirky.browser/profileClearNativeClaim', { request }) as { partition: string }
          requested.resolve({ request, partition: claim.partition })
          await hold.promise
          await ui.call('ui.command.reply', { requestId: event.requestId, result: { cleared: true } })
          completed.resolve()
        } catch (error) { completed.reject(error) }
      })()
    })
    await ui.call('events.subscribe', {})
    const deleting = call(h, 'profileDelete', { profile: id, yes: true })
    const pending = await requested.promise
    expect(pending.partition).toBe(`persist:quirky-browser-${id}`)
    await expect(ui.callAny('quirky.browser/profileClearNativeClaim', { request: pending.request })).rejects.toThrow()
    await expect(call(h, 'paneOpen', { worktree, mode: 'native', profile: id })).rejects.toThrow()
    hold.resolve()
    await completed.promise
    expect(await deleting).toEqual({ deleted: true })
    const preferences = await call(h, 'preferencesState') as PreferencesState
    expect(preferences.profiles.some((entry) => entry.profile.id === id)).toBe(false)
    expect(existsSync(join(h.home, 'plugin-data', 'quirky.browser', 'profiles', id))).toBe(false)
    const defaultDirectory = join(h.home, 'plugin-data', 'quirky.browser', 'profiles', 'default')
    mkdirSync(defaultDirectory, { recursive: true })
    const defaultSentinel = join(defaultDirectory, 'owned-site-data')
    writeFileSync(defaultSentinel, 'owned')
    expect(await call(h, 'profileClear', { profile: 'default', yes: true })).toEqual({ cleared: true })
    expect(existsSync(defaultSentinel)).toBe(false)
    const afterClear = await call(h, 'preferencesState') as PreferencesState
    expect(afterClear.profiles.map((entry) => entry.profile.id)).toEqual(['default'])
    expect(h.spawnCount()).toBe(0)
  } finally { hold.resolve(); await h.cleanup() }
})

test('Browser routing CLI opens an actual worktree hosted pane and exposes truthful setup capabilities', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('BrowserLinks')
    await h.client.call('setting.set', { id: 'setting:quirky.browser/openLinksInApp', value: true })
    const result = await cli(h, ['browser', 'open-link', '--url', 'https://example.test/from-markdown', '--worktree', worktree, '--json'])
    expect(result.code).toBe(0)
    const opened = JSON.parse(result.stdout) as { route: string; pane: string }
    expect(opened.route).toBe('app')
    const state = await call(h, 'paneState') as { tabs: PaneTab[] }
    const pane = state.tabs.find((item) => item.id === opened.pane)
    expect(pane).toMatchObject({ worktreeId: worktree, url: 'https://example.test/from-markdown', mode: 'native', profileId: 'default' })
    expect(typeof pane?.tabId).toBe('string')
    await expect(call(h, 'openLink', { worktree, url: 'javascript:alert(1)' })).rejects.toThrow()
    const before = await call(h, 'preferencesState') as PreferencesState
    expect(before.imports.available).toBe(false)
    expect(before.localhostLabels.available).toBe(false)
    await h.client.call('setting.set', { id: 'setting:quirky.browser/identityMode', value: 'native' })
    const after = await call(h, 'preferencesState') as PreferencesState
    expect(after.identity).toMatchObject({ selected: 'native', active: 'clean', restartRequired: true, nativeSupported: false })
    expect(h.spawnCount()).toBe(0)
  } finally { await h.cleanup() }
})

test('a claimed native clear with unknown completion never admits a new pane into the same profile', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('UncertainClear')
    const id = await profile(h)
    const ui = await h.daemon.connect('ui', 'Owned interrupted native boundary')
    const completed = Promise.withResolvers<void>()
    ui.onEvent((event) => {
      if (event.type !== 'ui.command.request' || event.id !== 'command:quirky.browser/profileClearNative') return
      void (async () => {
        try {
          const args = event.args as { request: string }
          await ui.callAny('quirky.browser/profileClearNativeClaim', { request: args.request })
          await ui.call('ui.command.reply', { requestId: event.requestId, error: { message: 'native bridge completion unavailable' } })
          completed.resolve()
        } catch (error) { completed.reject(error) }
      })()
    })
    await ui.call('events.subscribe', {})
    await expect(call(h, 'profileClear', { profile: id, yes: true })).rejects.toThrow()
    await completed.promise
    await expect(call(h, 'paneOpen', { worktree, profile: id, mode: 'native' })).rejects.toThrow()
    const preferences = await call(h, 'preferencesState') as PreferencesState
    expect(preferences.profiles.some((entry) => entry.profile.id === id)).toBe(true)
    expect(h.spawnCount()).toBe(0)
  } finally { await h.cleanup() }
})
