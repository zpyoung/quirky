import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactNode } from 'react'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import { createMobileRuntime } from '../src/native/runtime'
import type { MobileRuntimeDependencies, MobileRuntimeInstance } from '../src/native/runtime'
import type { MobilePreferences } from '../src/contracts'
import { makeTestPeer } from './transport-peer'
import { dispatchTerminalLink } from '../src/pages/terminal-links'

type NativeProps = { children?: ReactNode; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void }

function mockView(props: NativeProps) {
  return createElement('div', null, props.children)
}

function mockText(props: NativeProps) {
  return createElement('span', null, props.children)
}

function mockTextInput() {
  return createElement('input')
}


function mockPressable(props: NativeProps) {
  return createElement('button', {
    type: 'button',
    'aria-label': props.accessibilityLabel,
    disabled: props.disabled,
    onClick: props.onPress
  }, props.children)
}

mock.module('react-native', () => ({
  ScrollView: mockView,
  Text: mockText,
  TextInput: mockTextInput,
  View: mockView,
  Pressable: mockPressable,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))

// SettingsScreen imports native primitives; register the DOM adapter before loading that module.
const { SettingsScreen } = await import('../src/native/SettingsScreen')

let container: HTMLDivElement | null = null
let root: Root | null = null
let createRoot: typeof ReactCreateRoot
let testRuntime: MobileRuntimeInstance | null = null
let pendingPreferenceUpdate: Promise<MobilePreferences> | null = null


beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  testRuntime?.dispose()
  testRuntime = null
  pendingPreferenceUpdate = null
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

class MemoryStorage {
  values = new Map<string, string>()
  failNextSet = false
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('storage refused the preference update')
    }
    this.values.set(key, value)
  }
  async remove(key: string) { this.values.delete(key) }
}
function createSettingsRuntime(storage: MemoryStorage, WebSocket: MobileRuntimeDependencies['WebSocket']) {
  return createMobileRuntime({
    storage,
    secrets: {
      async read() { return { kind: 'missing' as const } },
      async write() {},
      async remove() {}
    },
    native: {
      async clipboardRead() { return '' },
      async clipboardWrite() {},
      async openExternal() {},
      async haptic() {},
      async notificationPermission() { return 'unavailable' as const },
      async openSystemSettings() {}
    },
    WebSocket,
    randomBytes: (length) => new Uint8Array(length).fill(1)
  })
}


function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === name)
  if (!button) throw new Error(`No button named ${name}`)
  return button
}

async function waitForButton(name: string): Promise<HTMLButtonElement> {
  const until = Date.now() + 2000
  while (Date.now() < until) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === name)
    if (button) return button
    await act(async () => { await Bun.sleep(5) })
  }
  throw new Error(`No button named ${name}`)
}

async function press(name: string): Promise<void> {
  await act(async () => {
    buttonNamed(name).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    while (!pendingPreferenceUpdate) await Promise.resolve()
    try { await pendingPreferenceUpdate } catch { /* The screen preserves the previous selected value. */ }
    pendingPreferenceUpdate = null
    await Promise.resolve()
  })
}

test('terminal link settings persist selected modes and keep the prior runtime value after a failed save', async () => {
  const peer = makeTestPeer()
  const storage = new MemoryStorage()
  const runtime = createSettingsRuntime(storage, peer.WebSocket)
  testRuntime = runtime
  const screenRuntime: MobileRuntimeInstance = {
    ...runtime,
    async updatePreferences(patch) {
      const update = runtime.updatePreferences(patch)
      pendingPreferenceUpdate = update
      return update
    }
  }

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SettingsScreen, {
      runtime: screenRuntime,
      hosts: [],
      onBack() {},
      onDiagnostics() {},
      onOpenNotifications() {}
    }))
    await Promise.resolve()
  })

  await waitForButton('Open on phone')
  await waitForButton('Chrome Watch on desktop')

  await press('Chrome Watch on desktop')
  const restarted = createSettingsRuntime(storage, peer.WebSocket)
  try {
    expect((await restarted.preferences()).terminalLinkMode).toBe('desktop')
  } finally {
    restarted.dispose()
  }

  await press('Open on phone')
  expect((await runtime.preferences()).terminalLinkMode).toBe('phone')

  storage.failNextSet = true
  await press('Chrome Watch on desktop')
  expect((await runtime.preferences()).terminalLinkMode).toBe('phone')
})
test('Chrome Watch failure does not fall back to the phone browser', async () => {
  const external: string[] = []

  await expect(dispatchTerminalLink('https://example.test/fail', 'desktop', {
    openExternal: async (url) => { external.push(url) },
    openChromeWatch: async () => { throw new Error('Chrome Watch refused the page') }
  })).rejects.toThrow()

  expect(external).toEqual([])
})

test('terminal links reject non-web and credential-bearing URLs before launch', async () => {
  const launched: string[] = []
  const launch = {
    openExternal: async (url: string) => { launched.push(url) },
    openChromeWatch: async (url: string) => { launched.push(url) }
  }

  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.test/']) {
    await expect(dispatchTerminalLink(value, 'phone', launch)).rejects.toThrow(/http\(s\)/i)
    await expect(dispatchTerminalLink(value, 'desktop', launch)).rejects.toThrow(/http\(s\)/i)
  }

  expect(launched).toEqual([])
})
