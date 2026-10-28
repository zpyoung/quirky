import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginCaller } from '@quirky/protocol'
import { registerPreferences } from '../src/preferences/controller'
import type { PreferencesAdapters } from '../src/preferences/contract'
import { BrowserStore, type BrowserProfile } from '../src/profiles/store'
import { BrowserRuntime } from '../src/runtime/driver'

type Handler = (params: Record<string, unknown>, caller: PluginCaller) => unknown

function preferenceHarness(options: {
  profiles?: BrowserProfile[]
  panes?: Array<{ id: string; profileId: string }>
  pages?: string[]
  settings?: Record<string, unknown>
  clearProfile?: (profile: string, remove: boolean) => Promise<void>
} = {}) {
  const profile: BrowserProfile = { id: 'profile_0123456789abcdef0123456789abcdef', label: 'Review', scope: 'isolated' }
  const handlers = new Map<string, Handler>()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const emitted: Array<{ event: string; data?: unknown }> = []
  const settings: Record<string, unknown> = { identityMode: 'clean', openLinksInApp: false, openLinksInAppModifierInverts: false, ...options.settings }
  const adapters: PreferencesAdapters = {
    listProfiles: () => options.profiles ?? [{ id: 'default', label: 'Default', scope: 'default' }, profile],
    listPanes: () => (options.panes ?? []).map((pane) => pane as never),
    listPageProfiles: () => options.pages ?? [],
    setPaneProfile: async (pane, selected) => {
      calls.push({ method: 'setPaneProfile', params: { pane, profile: selected } })
      return { id: pane, profileId: selected }
    },
    clearProfile: options.clearProfile ?? (async (selected, remove) => { calls.push({ method: 'clearProfile', params: { profile: selected, remove } }) })
  }
  const context = {
    dataDir: '',
    provide(id: string, implementation: unknown) {
      const method = id.replace(/^method:/, '')
      handlers.set(method, implementation as Handler)
    },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.browser/paneOpen') return { id: 'pane-created' }
      return { opened: true }
    },
    getSetting(name: string) { return settings[name.replace(/^quirky\.browser\//, '')] },
    emit(event: string, data?: unknown) { emitted.push({ event, data }); return true },
    error(_kind: string, message: string) { return new Error(message) }
  } as unknown as PluginContext
  const controller = registerPreferences(context, adapters)
  const invoke = (name: string, params: Record<string, unknown> = {}) => {
    const handler = handlers.get(`quirky.browser/${name}`)
    if (!handler) throw new Error(`missing preference method ${name}`)
    return handler(params, { role: 'cli' })
  }
  return { invoke, settings, calls, emitted, controller }
}

function withStore(run: (store: BrowserStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'quirky-browser-preferences-'))
  try { run(new BrowserStore(root)) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('preferencesState reports profile activity and selected versus active identity', async () => {
  const harness = preferenceHarness({ panes: [{ id: 'pane-1', profileId: 'profile_0123456789abcdef0123456789abcdef' }] })
  const activeState = await harness.invoke('preferencesState') as {
    profiles: Array<{ profile: BrowserProfile; active: boolean }>
    identity: { selected: string; active: string; restartRequired: boolean; nativeSupported: boolean }
    imports: { available: false; reason: string }
    localhostLabels: { available: false; reason: string }
  }
  expect(activeState.profiles.find((item) => item.profile.id.startsWith('profile_'))?.active).toBe(true)
  expect(activeState.identity).toEqual({ selected: 'clean', active: 'clean', restartRequired: false, nativeSupported: false })
  expect(activeState.imports.available).toBe(false)
  expect(activeState.imports.reason).not.toBe('')
  expect(activeState.localhostLabels.available).toBe(false)
  expect(activeState.localhostLabels.reason).not.toBe('')

  harness.settings.identityMode = 'native'
  const selectedState = await harness.invoke('preferencesState') as typeof activeState
  expect(selectedState.identity).toEqual({ selected: 'native', active: 'clean', restartRequired: true, nativeSupported: false })
})

test('profileSet validates the target before delegating pane selection', async () => {
  const harness = preferenceHarness()
  await expect(harness.invoke('profileSet', { pane: 'pane-1', profile: 'profile_deadbeef' })).rejects.toThrow()
  expect(harness.calls).toHaveLength(0)

  const result = await harness.invoke('profileSet', { pane: 'pane-1', profile: 'profile_0123456789abcdef0123456789abcdef' })
  expect(result).toEqual({ pane: { id: 'pane-1', profileId: 'profile_0123456789abcdef0123456789abcdef' } })
  expect(harness.calls[0]).toEqual({ method: 'setPaneProfile', params: { pane: 'pane-1', profile: 'profile_0123456789abcdef0123456789abcdef' } })
  expect(harness.emitted).toEqual([{ event: 'preferencesChanged', data: {} }])
})

test('profileClear refuses active panes and managed pages before adapter work', async () => {
  const pane = preferenceHarness({ panes: [{ id: 'pane-1', profileId: 'profile_0123456789abcdef0123456789abcdef' }] })
  await expect(pane.invoke('profileClear', { profile: 'profile_0123456789abcdef0123456789abcdef' })).rejects.toThrow()
  expect(pane.calls).toHaveLength(0)

  const page = preferenceHarness({ pages: ['profile_0123456789abcdef0123456789abcdef'] })
  await expect(page.invoke('profileClear', { profile: 'profile_0123456789abcdef0123456789abcdef' })).rejects.toThrow()
  expect(page.calls).toHaveLength(0)
})

test('profileClear and profileDelete delegate the selected lifecycle operation', async () => {
  const clear = preferenceHarness()
  expect(await clear.invoke('profileClear', { profile: 'profile_0123456789abcdef0123456789abcdef' })).toEqual({ cleared: true })
  expect(clear.calls[0]).toEqual({ method: 'clearProfile', params: { profile: 'profile_0123456789abcdef0123456789abcdef', remove: false } })
  expect(clear.emitted).toEqual([{ event: 'preferencesChanged', data: {} }])

  const remove = preferenceHarness()
  expect(await remove.invoke('profileDelete', { profile: 'profile_0123456789abcdef0123456789abcdef' })).toEqual({ deleted: true })
  expect(remove.calls[0]).toEqual({ method: 'clearProfile', params: { profile: 'profile_0123456789abcdef0123456789abcdef', remove: true } })
  expect(remove.emitted).toEqual([{ event: 'preferencesChanged', data: {} }])

  const defaultClear = preferenceHarness()
  expect(await defaultClear.invoke('profileClear', { profile: 'default' })).toEqual({ cleared: true })
  expect(defaultClear.calls[0]).toEqual({ method: 'clearProfile', params: { profile: 'default', remove: false } })
})
test('profileDelete refuses Default and active profiles without invoking the clearer', async () => {
  const harness = preferenceHarness({ panes: [{ id: 'pane-1', profileId: 'profile_0123456789abcdef0123456789abcdef' }] })
  await expect(harness.invoke('profileDelete', { profile: 'default' })).rejects.toThrow()
  await expect(harness.invoke('profileDelete', { profile: 'profile_0123456789abcdef0123456789abcdef' })).rejects.toThrow()
  const page = preferenceHarness({ pages: ['profile_0123456789abcdef0123456789abcdef'] })
  await expect(page.invoke('profileDelete', { profile: 'profile_0123456789abcdef0123456789abcdef' })).rejects.toThrow()
  expect(page.calls).toHaveLength(0)
  expect(harness.calls).toHaveLength(0)
})

test('native clear failure preserves profile metadata and private data without reporting success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-browser-preferences-'))
  try {
    const store = new BrowserStore(root)
    const profile = store.createProfile('Review')
    const marker = join(store.profilePath(profile.id), 'Cookies')
    writeFileSync(marker, 'private')
    let attempts = 0
    const harness = preferenceHarness({
      profiles: store.listProfiles(),
      clearProfile: async () => { attempts++; throw new Error('native session storage clear unavailable') }
    })
    await expect(harness.invoke('profileClear', { profile: profile.id })).rejects.toThrow('native session storage clear unavailable')
    await expect(harness.invoke('profileDelete', { profile: profile.id })).rejects.toThrow('native session storage clear unavailable')
    expect(attempts).toBe(2)
    expect(store.listProfiles().some((entry) => entry.id === profile.id)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('private')
    expect(harness.emitted).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('profile removal clears only its bounded directory and never follows profile symlinks', () => {
  withStore((store) => {
    const profile = store.createProfile('Review')
    const profileDirectory = store.profilePath(profile.id)
    const retained = join(profileDirectory, 'Cookies')
    writeFileSync(retained, 'private')
    const outside = mkdtempSync(join(tmpdir(), 'quirky-browser-outside-'))
    const outsideFile = join(outside, 'keep')
    writeFileSync(outsideFile, 'untouched')
    try {
      symlinkSync(outside, join(profileDirectory, 'linked-outside'))
      const page = store.addPage({ worktreeId: null, profileId: profile.id, url: 'about:blank', title: '' })
      expect(() => store.clearProfileDirectory(profile.id)).toThrow()
      expect(readFileSync(retained, 'utf8')).toBe('private')
      store.removePage(page.browserPageId)

      expect(() => store.clearProfileDirectory(profile.id)).not.toThrow()
      expect(readFileSync(outsideFile, 'utf8')).toBe('untouched')
      expect(store.listProfiles().some((entry) => entry.id === profile.id)).toBe(true)
      expect(store.profilePath(profile.id)).toBe(profileDirectory)
      expect(() => readFileSync(retained, 'utf8')).toThrow()
      expect(() => store.clearProfileDirectory('../outside')).toThrow()

      expect(() => store.deleteProfile(profile.id)).not.toThrow()
      expect(store.listProfiles().some((entry) => entry.id === profile.id)).toBe(false)
      expect(() => store.deleteProfile('default')).toThrow()
      expect(store.listProfiles().some((entry) => entry.id === 'default')).toBe(true)
      expect(readFileSync(outsideFile, 'utf8')).toBe('untouched')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

test('profile storage rejects a symlinked profile root without touching its target', () => {
  withStore((store) => {
    const profile = store.createProfile('Linked')
    const profileDirectory = store.profilePath(profile.id)
    const outside = mkdtempSync(join(tmpdir(), 'quirky-browser-linked-profile-'))
    const marker = join(outside, 'Cookies')
    writeFileSync(marker, 'outside')
    try {
      rmSync(profileDirectory, { recursive: true, force: true })
      symlinkSync(outside, profileDirectory)
      expect(() => store.clearProfileDirectory(profile.id)).toThrow()
      expect(() => store.deleteProfile(profile.id)).toThrow()
      expect(store.listProfiles().some((entry) => entry.id === profile.id)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toBe('outside')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

test('clearing Default keeps its profile metadata', () => {
  withStore((store) => {
    const marker = join(store.profilePath('default'), 'Cookies')
    writeFileSync(marker, 'private')
    store.clearProfileDirectory('default')
    expect(store.listProfiles().some((entry) => entry.id === 'default')).toBe(true)
    expect(() => readFileSync(marker, 'utf8')).toThrow()
  })
})

test('openLink accepts only absolute HTTP(S), requires worktree, and applies modifier routing', async () => {
  const harness = preferenceHarness({ settings: { openLinksInApp: true, openLinksInAppModifierInverts: false } })
  await expect(harness.invoke('openLink', { url: 'javascript:alert(1)', worktree: 'worktree-1', modifier: true })).rejects.toThrow()
  await expect(harness.invoke('openLink', { url: 'https://example.test' })).rejects.toThrow()

  expect(await harness.invoke('openLink', { url: 'https://example.test/path', worktree: 'worktree-1', modifier: true })).toEqual({ route: 'app', pane: 'pane-created' })
  expect(harness.calls.at(-1)).toEqual({ method: 'quirky.browser/paneOpen', params: { worktree: 'worktree-1', url: 'https://example.test/path', mode: 'native' } })

  expect(await harness.invoke('openLink', { url: 'https://example.test/', worktree: 'worktree-1', modifier: true, shift: true })).toEqual({ route: 'external' })
  expect(harness.calls.at(-1)).toEqual({ method: 'quirky.terminal/openExternal', params: { target: 'https://example.test/' } })

  harness.settings.openLinksInAppModifierInverts = true
  const inverted = preferenceHarness({ settings: { openLinksInApp: false, openLinksInAppModifierInverts: true } })
  expect(await inverted.invoke('openLink', { url: 'http://example.test/', worktree: 'worktree-2', modifier: true, shift: true })).toEqual({ route: 'app', pane: 'pane-created' })
  expect(await harness.invoke('openLink', { url: 'https://example.test/', worktree: 'worktree-1', modifier: true, shift: true })).toEqual({ route: 'external' })
})

test('profile maintenance drains and blocks only the maintained profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-browser-maintenance-'))
  try {
    const store = new BrowserStore(root)
    const profile = store.createProfile('Maintenance')
    const other = store.createProfile('Other')
    const runtime = new BrowserRuntime(store, {} as never, () => {})
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const currentWork = runtime.withProfileLock(profile.id, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    let maintenanceRan = false
    const maintenance = runtime.withProfileMaintenance(profile.id, async () => {
      maintenanceRan = true
      await expect(runtime.withProfileLock(profile.id, async () => {})).rejects.toThrow()
    })
    await Promise.resolve()
    expect(maintenanceRan).toBe(false)
    await expect(runtime.withProfileLock(profile.id, async () => {})).rejects.toThrow()
    expect(await runtime.withProfileLock(other.id, async () => 'unrelated')).toBe('unrelated')

    release.resolve()
    await currentWork
    await maintenance
    expect(maintenanceRan).toBe(true)
    await runtime.withProfileLock(profile.id, async () => {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('profile storage rejects a replaced data-root symlink', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'quirky-browser-data-root-'))
  const dataDir = join(temporary, 'plugin-data')
  mkdirSync(dataDir)
  const store = new BrowserStore(dataDir)
  const profile = store.createProfile('Review')
  const parkedDataDir = join(temporary, 'parked-data')
  const outside = mkdtempSync(join(tmpdir(), 'quirky-browser-data-outside-'))
  const outsideProfile = join(outside, 'profiles', profile.id)
  mkdirSync(outsideProfile, { recursive: true })
  const marker = join(outsideProfile, 'Cookies')
  writeFileSync(marker, 'outside')
  try {
    renameSync(dataDir, parkedDataDir)
    symlinkSync(outside, dataDir)
    expect(() => store.clearProfileDirectory(profile.id)).toThrow()
    expect(() => store.deleteProfile(profile.id)).toThrow()
    expect(store.listProfiles().some((entry) => entry.id === profile.id)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('outside')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(parkedDataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(temporary, { recursive: true, force: true })
  }
})
