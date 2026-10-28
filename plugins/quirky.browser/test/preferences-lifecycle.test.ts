import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import { ProfileLifecycle } from '../src/preferences-lifecycle'
import { BrowserStore } from '../src/profiles/store'
import { BrowserRuntime } from '../src/runtime/driver'

test('profile clear cannot begin while an admitted pane operation is awaiting its public dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-admission-'))
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const nativeUnavailable = new Error('owned native boundary unavailable')
  let nativeCalls = 0
  // The lifecycle under test uses only these public error/command ports; no daemon or native Session is started.
  const context = {
    error: (_kind: string, message: string) => new Error(message),
    call: async () => { nativeCalls += 1; throw nativeUnavailable }
  } as PluginContext
  const store = new BrowserStore(root)
  const runtime = new BrowserRuntime(store, {} as never, () => {})
  const lifecycle = new ProfileLifecycle(context, store, runtime, () => [])
  let admission: Promise<void> | undefined
  try {
    const profile = store.createProfile('Review')
    admission = lifecycle.withProfileAdmission(profile.id, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    await expect(lifecycle.clearProfile(profile.id, true)).rejects.toThrow()
    expect(nativeCalls).toBe(0)
    expect(store.getProfile(profile.id).label).toBe('Review')
    release.resolve()
    await admission
    await expect(lifecycle.clearProfile(profile.id, true)).rejects.toBe(nativeUnavailable)
    expect(nativeCalls).toBe(1)
    expect(store.getProfile(profile.id).label).toBe('Review')
  } finally {
    release.resolve()
    await admission
    lifecycle.deactivate()
    await runtime.stopAll()
    rmSync(root, { recursive: true, force: true })
  }
})
