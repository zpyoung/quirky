import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { DesignWindow, setLiveDesignPageKeys } from '../src/design-window/DesignWindow'

const RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of nativeGlobals) {
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  setLiveDesignPageKeys([])
  GlobalRegistrator.unregister()
})

const unmounts: (() => void)[] = []
afterEach(async () => {
  await act(async () => { for (const unmount of unmounts.splice(0)) unmount() })
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Guest = { reloaded: boolean; installs: number; reinstallWorks: boolean }

async function mountNative(guest: Guest) {
  const messages: { text: string; kind: 'info' | 'error' }[] = []
  const handle = {
    evaluate: async (script: string) => {
      if (script.includes('const keydown')) {
        guest.installs++
        if (guest.reloaded && !guest.reinstallWorks) return false
        guest.reloaded = false
        return true
      }
      if (script.includes('installed: false')) return guest.reloaded ? { installed: false } : { installed: true, action: null }
      return true
    }
  }
  const root = createRoot(document.createElement('div'))
  unmounts.push(() => root.unmount())
  const pane = { id: 'pane-1', mode: 'native' as const, page: null, url: 'https://example.test/', title: 'Fixture', loading: false, error: null, worktreeId: 'wt-1' }
  await act(async () => root.render(<DesignWindow
    context={{ call: async () => ({}) } as unknown as UiPluginContext}
    pane={pane}
    nativeHandle={handle as never}
    pageHost={null}
    watchReady={false}
    focused
    onMessage={(text, kind) => { messages.push({ text, kind }) }}
  />))
  return messages
}

test('a reload that drops the shortcut bridge reinstalls it without an error', async () => {
  const guest: Guest = { reloaded: false, installs: 0, reinstallWorks: true }
  const messages = await mountNative(guest)
  await act(async () => { await sleep(50) })
  guest.reloaded = true
  await act(async () => { await sleep(300) })

  expect(guest.installs).toBeGreaterThan(1)
  expect(messages).toEqual([])
})

test('the toolbar in a web client shows no developer hints and points to Watch', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  unmounts.push(() => root.unmount())
  const pane = { id: 'pane-1', mode: 'native' as const, page: null, url: 'https://example.test/', title: 'Fixture', loading: false, error: null, worktreeId: 'wt-1' }
  await act(async () => root.render(<DesignWindow
    context={{ call: async () => ({}), nativeBrowser: { available: false, clearPartitionAvailable: false } } as unknown as UiPluginContext}
    pane={pane}
    nativeHandle={null}
    pageHost={null}
    watchReady={false}
    onMessage={() => {}}
  />))

  const text = container.textContent ?? ''
  expect(text).not.toMatch(/SDK|sandbox/i)
  for (const name of ['Grab', 'Annotate', 'Draw']) {
    const control = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim().startsWith(name))
    expect(control?.getAttribute('title') ?? '').toMatch(/Watch/)
  }
})

test('a document that refuses the shortcut bridge still reports it', async () => {
  const guest: Guest = { reloaded: false, installs: 0, reinstallWorks: false }
  const messages = await mountNative(guest)
  await act(async () => { await sleep(50) })
  guest.reloaded = true
  await act(async () => { await sleep(300) })

  expect(messages.some((message) => message.kind === 'error' && /shortcut/i.test(message.text))).toBe(true)
})
