import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { PaneTab } from '../src/pane-contract'
import { ProfileLifecycle } from '../src/preferences-lifecycle'
import { BrowserStore } from '../src/profiles/store'
import { BrowserRuntime } from '../src/runtime/driver'

const markerName = '.no-native-pane'
const nativeUnavailable = new Error('owned native boundary unavailable')

type ClaimHandler = (params: Record<string, unknown>, caller: PluginCaller) => unknown
type NativeCommand = (params: unknown, claim: (request: string) => unknown) => Promise<unknown>
type TestHarness = { store: BrowserStore; runtime: BrowserRuntime; lifecycle: ProfileLifecycle; readonly nativeCalls: number }

function nativeClearRequest(params: unknown): string {
  if (!params || typeof params !== 'object' || !('args' in params)) throw new Error('native clear request is missing')
  const args = params.args
  if (!args || typeof args !== 'object' || !('request' in args) || typeof args.request !== 'string') {
    throw new Error('native clear request is invalid')
  }
  return args.request
}

function makeHarness(
  root: string,
  listPanes: () => PaneTab[] = () => [],
  nativeCommand: NativeCommand = async () => { throw nativeUnavailable }
): TestHarness {
  let nativeCalls = 0
  let claimHandler: ClaimHandler | undefined
  const context: Pick<PluginContext, 'provide' | 'error' | 'call'> = {
    provide: (_method, handler) => { claimHandler = handler as ClaimHandler },
    error: (_kind, message) => new Error(message),
    call: async (_method, params) => {
      nativeCalls += 1
      return nativeCommand(params, (request) => {
        if (!claimHandler) throw new Error('native clear claim handler was not provided')
        return claimHandler({ request }, { role: 'ui' } as PluginCaller)
      })
    }
  }
  const store = new BrowserStore(root)
  const runtime = new BrowserRuntime(store, {} as never, () => {})
  const lifecycle = new ProfileLifecycle(context, store, runtime, listPanes)
  return { store, runtime, lifecycle, get nativeCalls() { return nativeCalls } }
}

function paneTab(profileId: string, mode: 'native' | 'watch'): PaneTab {
  return {
    id: `${mode}-pane`,
    worktreeId: 'worktree',
    profileId,
    partition: `persist:quirky-browser-${profileId}`,
    mode,
    page: null,
    url: 'about:blank',
    title: 'Example',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    viewport: 'default',
    command: null,
    find: { text: '', current: 0, total: 0 },
    prompts: [],
    downloads: []
  }
}

function markerPath(store: BrowserStore, profileId: string): string {
  return join(store.profilePath(profileId), markerName)
}

async function disposeHarness(harness: TestHarness): Promise<void> {
  harness.lifecycle.deactivate()
  await harness.runtime.stopAll()
}

test('profile marker helpers accept only regular non-symlink evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-markers-'))
  const store = new BrowserStore(root)
  try {
    const profile = store.createProfile('Marker')
    const marker = markerPath(store, profile.id)
    expect(existsSync(marker)).toBe(true)
    expect(store.hasNoNativeUse(profile.id)).toBe(true)

    store.clearNoNativeUse(profile.id)
    expect(existsSync(marker)).toBe(false)
    expect(store.hasNoNativeUse(profile.id)).toBe(false)
    store.markNoNativeUse(profile.id)
    expect(store.hasNoNativeUse(profile.id)).toBe(true)
    store.markNoNativeUse(profile.id)

    const symlinkProfile = store.createProfile('Symlink marker')
    const symlinkMarker = markerPath(store, symlinkProfile.id)
    const target = join(root, 'outside-marker')
    writeFileSync(target, '')
    rmSync(symlinkMarker)
    symlinkSync(target, symlinkMarker)
    expect(store.hasNoNativeUse(symlinkProfile.id)).toBe(false)
    expect(() => store.markNoNativeUse(symlinkProfile.id)).toThrow('profile native marker is not a safe file')

    const directoryProfile = store.createProfile('Directory marker')
    const directoryMarker = markerPath(store, directoryProfile.id)
    rmSync(directoryMarker)
    mkdirSync(directoryMarker)
    expect(store.hasNoNativeUse(directoryProfile.id)).toBe(false)
    expect(() => store.markNoNativeUse(directoryProfile.id)).toThrow('profile native marker is not a safe file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native pane results remove the marker before an admitted operation releases its profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-admission-'))
  const harness = makeHarness(root)
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let admission: Promise<PaneTab> | undefined
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Review')
    const marker = markerPath(harness.store, profile.id)
    const pane = paneTab(profile.id, 'native')
    admission = harness.lifecycle.withProfileAdmission(profile.id, async () => {
      entered.resolve()
      await release.promise
      return pane
    })
    await entered.promise

    await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toThrow("Close this profile's panes and pages before clearing it.")
    expect(harness.nativeCalls).toBe(0)
    expect(existsSync(marker)).toBe(true)

    release.resolve()
    await expect(admission).resolves.toBe(pane)
    expect(existsSync(marker)).toBe(false)
    await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
    expect(harness.nativeCalls).toBe(1)
    expect(harness.store.getProfile(profile.id).label).toBe('Review')
  } finally {
    release.resolve()
    await admission?.catch(() => {})
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('Native panes found at admission start are recorded even after they close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-admission-start-'))
  const panes: PaneTab[] = []
  const harness = makeHarness(root, () => panes)
  try {
    const profile = harness.store.createProfile('Admission start')
    const marker = markerPath(harness.store, profile.id)
    harness.lifecycle.activate()
    panes.push(paneTab(profile.id, 'native'))

    let markerPresentDuringOperation: boolean | undefined
    await harness.lifecycle.withProfileAdmission(profile.id, async () => {
      markerPresentDuringOperation = existsSync(marker)
      panes.splice(0)
      return 'admitted'
    })

    expect(markerPresentDuringOperation).toBe(false)
    await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
    expect(harness.nativeCalls).toBe(1)
    expect(harness.store.getProfile(profile.id).label).toBe('Admission start')
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('Native panes that appear during admission are recorded before admission closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-admission-finally-'))
  const panes: PaneTab[] = []
  const harness = makeHarness(root, () => panes)
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let admission: Promise<{ completed: true }> | undefined
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Admission finally')
    const marker = markerPath(harness.store, profile.id)
    admission = harness.lifecycle.withProfileAdmission(profile.id, async () => {
      entered.resolve()
      await release.promise
      return { completed: true }
    })
    await entered.promise

    panes.push(paneTab(profile.id, 'native'))
    release.resolve()
    await admission
    expect(existsSync(marker)).toBe(false)

    panes.splice(0)
    await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
    expect(harness.nativeCalls).toBe(1)
    expect(harness.store.getProfile(profile.id).label).toBe('Admission finally')
  } finally {
    release.resolve()
    await admission?.catch(() => {})
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('markerless legacy profiles require desktop Native-clear acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-legacy-profile-'))
  const profileId = 'profile_0123456789abcdef0123456789abcdef'
  const profileDirectory = join(root, 'profiles', profileId)
  mkdirSync(profileDirectory, { recursive: true })
  writeFileSync(join(root, 'browser-state.json'), `${JSON.stringify({
    profiles: [{ id: profileId, label: 'Legacy', scope: 'isolated' }],
    pages: []
  })}\n`)
  const harness = makeHarness(root)
  try {
    harness.lifecycle.activate()
    expect(existsSync(join(profileDirectory, markerName))).toBe(false)
    await expect(harness.lifecycle.clearProfile(profileId, true)).rejects.toBe(nativeUnavailable)
    expect(harness.nativeCalls).toBe(1)
    expect(existsSync(profileDirectory)).toBe(true)
    expect(harness.store.getProfile(profileId).label).toBe('Legacy')
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsafe marker symlinks and directories require Native-clear acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-unsafe-marker-'))
  const harness = makeHarness(root)
  try {
    harness.lifecycle.activate()
    const symlinkProfile = harness.store.createProfile('Symlink')
    const symlinkMarker = markerPath(harness.store, symlinkProfile.id)
    const target = join(root, 'outside-marker')
    writeFileSync(target, '')
    rmSync(symlinkMarker)
    symlinkSync(target, symlinkMarker)

    const directoryProfile = harness.store.createProfile('Directory')
    const directoryMarker = markerPath(harness.store, directoryProfile.id)
    rmSync(directoryMarker)
    mkdirSync(directoryMarker)

    for (const profile of [symlinkProfile, directoryProfile]) {
      expect(harness.store.hasNoNativeUse(profile.id)).toBe(false)
      await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
      expect(existsSync(harness.store.profilePath(profile.id))).toBe(true)
      expect(harness.store.getProfile(profile.id).label).toBe(profile.label)
    }
    expect(harness.nativeCalls).toBe(2)
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed and Watch admissions preserve the marker across a daemon restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-restart-profile-'))
  let first: TestHarness | undefined
  let restarted: TestHarness | undefined
  try {
    const initial = makeHarness(root)
    first = initial
    initial.lifecycle.activate()
    const profile = initial.store.createProfile('Managed and Watch')
    const directory = initial.store.profilePath(profile.id)
    const marker = markerPath(initial.store, profile.id)
    expect(existsSync(marker)).toBe(true)

    const page = await initial.lifecycle.withProfileAdmission(profile.id, async () =>
      initial.store.addPage({ worktreeId: null, profileId: profile.id, url: 'https://example.test', title: 'Example' })
    )
    initial.store.removePage(page.browserPageId)
    await initial.lifecycle.withProfileAdmission(profile.id, async () => paneTab(profile.id, 'watch'))
    expect(existsSync(marker)).toBe(true)

    await disposeHarness(first)
    first = undefined
    restarted = makeHarness(root)
    restarted.lifecycle.activate()
    await expect(restarted.lifecycle.clearProfile(profile.id, true)).resolves.toBeUndefined()
    expect(restarted.nativeCalls).toBe(0)
    expect(existsSync(directory)).toBe(false)
    expect(restarted.store.listProfiles().some((item) => item.id === profile.id)).toBe(false)
  } finally {
    if (restarted) await disposeHarness(restarted)
    if (first) await disposeHarness(first)
    rmSync(root, { recursive: true, force: true })
  }
})

test('restored Native panes remove the marker during activation and block later headless deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-restored-native-'))
  let original: TestHarness | undefined
  let restarted: TestHarness | undefined
  try {
    original = makeHarness(root)
    const profile = original.store.createProfile('Restored Native')
    const directory = original.store.profilePath(profile.id)
    const marker = markerPath(original.store, profile.id)
    const pane = paneTab(profile.id, 'native')
    await disposeHarness(original)
    original = undefined

    let panes: PaneTab[] = [pane]
    restarted = makeHarness(root, () => panes)
    restarted.lifecycle.activate()
    expect(existsSync(marker)).toBe(false)

    panes = []
    await expect(restarted.lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
    expect(restarted.nativeCalls).toBe(1)
    expect(existsSync(directory)).toBe(true)
    expect(restarted.store.getProfile(profile.id).label).toBe('Restored Native')
  } finally {
    if (restarted) await disposeHarness(restarted)
    if (original) await disposeHarness(original)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a confirmed Native clear restores the marker and enables later headless deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-confirmed-clear-'))
  const confirmsNativeClear: NativeCommand = async (params, claim) => {
    const request = nativeClearRequest(params)
    claim(request)
    return { result: { cleared: true } }
  }
  const harness = makeHarness(root, () => [], confirmsNativeClear)
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Confirmed clear')
    const directory = harness.store.profilePath(profile.id)
    const marker = markerPath(harness.store, profile.id)
    await harness.lifecycle.withProfileAdmission(profile.id, async () => paneTab(profile.id, 'native'))
    expect(existsSync(marker)).toBe(false)

    await harness.lifecycle.clearProfile(profile.id, false)
    expect(harness.nativeCalls).toBe(1)
    expect(existsSync(marker)).toBe(true)

    await expect(harness.lifecycle.clearProfile(profile.id, true)).resolves.toBeUndefined()
    expect(harness.nativeCalls).toBe(1)
    expect(existsSync(directory)).toBe(false)
    expect(harness.store.listProfiles().some((item) => item.id === profile.id)).toBe(false)
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a claimed Native clear with uncertain completion locks the profile until restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-uncertain-clear-'))
  const claimsThenFails: NativeCommand = async (params, claim) => {
    const request = nativeClearRequest(params)
    claim(request)
    throw nativeUnavailable
  }
  const harness = makeHarness(root, () => [], claimsThenFails)
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Uncertain clear')
    const directory = harness.store.profilePath(profile.id)

    await expect(harness.lifecycle.clearProfile(profile.id, false)).rejects.toThrow('Native clear completion is uncertain; this profile stays unavailable until daemon restart.')
    expect(() => harness.lifecycle.assertAvailable(profile.id)).toThrow('This profile is clearing or awaiting a known native-clear result')
    let admissionRan = false
    await expect(harness.lifecycle.withProfileAdmission(profile.id, async () => { admissionRan = true })).rejects.toThrow('This profile is clearing or awaiting a known native-clear result')
    await expect(harness.lifecycle.clearProfile(profile.id, true)).rejects.toThrow('This profile is clearing or awaiting a known native-clear result')
    expect(admissionRan).toBe(false)
    expect(harness.nativeCalls).toBe(1)
    expect(existsSync(directory)).toBe(true)
    expect(harness.store.getProfile(profile.id).label).toBe('Uncertain clear')
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('deactivation releases a claimed clear that returns an uncertain result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-deactivated-clear-'))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const claimsThenWaits: NativeCommand = async (params, claim) => {
    const request = nativeClearRequest(params)
    claim(request)
    entered.resolve()
    await release.promise
    throw nativeUnavailable
  }
  const harness = makeHarness(root, () => [], claimsThenWaits)
  let clear: Promise<void> | undefined
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Deactivated clear')
    clear = harness.lifecycle.clearProfile(profile.id, false)
    await entered.promise
    harness.lifecycle.deactivate()
    release.resolve()

    await expect(clear).rejects.toBe(nativeUnavailable)
    expect(() => harness.lifecycle.assertAvailable(profile.id)).not.toThrow()
    expect(harness.store.getProfile(profile.id).label).toBe('Deactivated clear')
  } finally {
    release.resolve()
    await clear?.catch(() => {})
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unclaimed Native clear failure releases profile maintenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-unclaimed-clear-'))
  const harness = makeHarness(root)
  try {
    harness.lifecycle.activate()
    const profile = harness.store.createProfile('Unclaimed clear')
    await expect(harness.lifecycle.clearProfile(profile.id, false)).rejects.toBe(nativeUnavailable)
    await expect(harness.lifecycle.withProfileAdmission(profile.id, async () => 'available')).resolves.toBe('available')
    expect(harness.nativeCalls).toBe(1)
  } finally {
    await disposeHarness(harness)
    rmSync(root, { recursive: true, force: true })
  }
})
