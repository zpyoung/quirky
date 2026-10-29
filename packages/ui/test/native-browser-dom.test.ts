import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'
import { createElectrobunNativeBrowserAdapter, createNativeBrowserCapability } from '../src/native-browser'

type GuestView = HTMLElement & {
  emitState(detail: unknown): void
  emitEvent(name: string, detail: unknown): void
  onExecute?: (script: string) => void
  lastExecution?: string
}
let announceGuest: ((guest: GuestView) => void) | undefined
let createRoot: (element: HTMLElement) => Root
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ReactDOM captures the test DOM at initialization; intentionally load it only after the DOM boundary exists.
  createRoot = (await import('react-dom/client')).createRoot
  class GuestElement extends HTMLElement {
    webviewId = 7
    listeners = new Map<string, Set<(event: CustomEvent) => void>>()
    onExecute?: (script: string) => void
    lastExecution?: string
    connectedCallback() {
      const announce = announceGuest
      announceGuest = undefined
      announce?.(this)
    }
    on(name: string, listener: (event: CustomEvent) => void) {
      const listeners = this.listeners.get(name) ?? new Set()
      listeners.add(listener)
      this.listeners.set(name, listeners)
    }
    off(name: string, listener: (event: CustomEvent) => void) { this.listeners.get(name)?.delete(listener) }
    syncDimensions() {}
    canGoBack() { return Promise.resolve(false) }
    canGoForward() { return Promise.resolve(false) }
    loadURL() { throw new Error('DOM fixture cannot navigate off its owned page') }
    reload() { throw new Error('not exercised by this DOM fixture') }
    goBack() { throw new Error('not exercised by this DOM fixture') }
    goForward() { throw new Error('not exercised by this DOM fixture') }
    executeJavascript(script: string) {
      this.lastExecution = script
      this.onExecute?.(script)
      window.eval(script)
    }
    emitEvent(name: string, detail: unknown) {
      for (const listener of this.listeners.get(name) ?? []) listener(new CustomEvent(name, { detail }))
    }
    emitState(detail: unknown) { this.emitEvent('host-message', detail) }
  }
  customElements.define('electrobun-webview', GuestElement)
})
afterAll(() => GlobalRegistrator.unregister())

async function mountGuest(claimGate?: Promise<void>) {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const released = Promise.withResolvers<void>()
  announceGuest = mounted.resolve
  const capability = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
    async claimNativeBrowserView() {
      if (claimGate) await claimGate
      return { zoomFactor: 1 }
    },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } }
  }))
  const handle = capability.mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {}
  })
  const guest = await mounted.promise
  const preload = guest?.getAttribute('preload')
  if (!guest || !preload) throw new Error('native adapter did not attach its real guest program')
  ;(window as Window & { __electrobunSendToHost?: (detail: unknown) => void }).__electrobunSendToHost = (detail) => guest.emitState(detail)
  window.eval(preload)
  return { handle, guest, async cleanup() { handle.dispose(); await released.promise; element.remove() } }
}

test('finding text does not replace framework-owned nodes or break a later page update', async () => {
  let update: ((value: string) => void) | undefined
  function App() {
    const [value, setValue] = useState('original-value')
    update = setValue
    return createElement('main', null, createElement('span', { id: 'reactive-value' }, value, createElement('em', null, ' suffix')))
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(createElement(App)))
  const guest = await mountGuest()
  try {
    const found = await guest.handle.request({ action: 'find', text: 'original-value' })
    expect(found).toMatchObject({ findCurrent: 1, findTotal: 1 })
    expect(window.getSelection()?.toString()).toBe('original-value')
    await act(async () => update?.('updated-value'))
    expect(document.getElementById('reactive-value')?.textContent).toBe('updated-value suffix')
  } finally {
    await guest.cleanup()
    await act(async () => root.unmount())
    element.remove()
  }
})

test('real DOM find moves forward, wraps backward, and clears its selection', async () => {
  const paragraph = document.createElement('p')
  paragraph.textContent = 'needle one needle two needle'
  document.body.append(paragraph)
  const guest = await mountGuest()
  try {
    expect(await guest.handle.request({ action: 'find', text: 'needle', forward: true })).toMatchObject({ findCurrent: 1, findTotal: 3 })
    expect(window.getSelection()?.getRangeAt(0).startOffset).toBe(0)
    expect(await guest.handle.request({ action: 'find', text: 'needle', forward: true })).toMatchObject({ findCurrent: 2, findTotal: 3 })
    expect(window.getSelection()?.getRangeAt(0).startOffset).toBe(11)
    await guest.handle.request({ action: 'find', text: 'needle', forward: false })
    expect(await guest.handle.request({ action: 'find', text: 'needle', forward: false })).toMatchObject({ findCurrent: 3, findTotal: 3 })
    expect(window.getSelection()?.getRangeAt(0).startOffset).toBe(22)
    expect(await guest.handle.request({ action: 'find', text: '' })).toMatchObject({ findCurrent: 0, findTotal: 0 })
    expect(window.getSelection()?.toString()).toBe('')
  } finally {
    await guest.cleanup()
    paragraph.remove()
  }
})

test('native evaluation returns bounded JSON for synchronous and asynchronous guest results', async () => {
  const guest = await mountGuest()
  try {
    await expect(guest.handle.evaluate('({ answer: 42 })')).resolves.toEqual({ answer: 42 })
    await expect(guest.handle.evaluate('Promise.resolve({ source: "guest" })')).resolves.toEqual({ source: 'guest' })
    await expect(guest.handle.evaluate('throw new Error("guest failure")')).rejects.toThrow(/guest failure/)
    const nonAsciiError = 'é'.repeat(1024)
    await expect(guest.handle.evaluate(`throw new Error(${JSON.stringify(nonAsciiError)})`)).rejects.toThrow('é'.repeat(512))
    await expect(guest.handle.evaluate('x'.repeat(64 * 1024 + 1))).rejects.toThrow(/script.*limit/i)
    await expect(guest.handle.evaluate('JSON.stringify("x".repeat(300000))')).rejects.toThrow(/result.*limit/i)
  } finally {
    await guest.cleanup()
  }
})

test('native evaluation matches guest and request identity and rejects on navigation', async () => {
  const guest = await mountGuest()
  try {
    const dispatched = Promise.withResolvers<string>()
    guest.guest.onExecute = dispatched.resolve
    const pending = guest.handle.evaluate('new Promise(() => {})')
    const invocation = await dispatched.promise
    const requestId = invocation.match(/__quirkyNativeBrowserEvaluate\?\.\("([^"]+)"/)?.[1]
    expect(requestId).toBeTruthy()
    guest.guest.emitState({
      type: 'quirky-native-browser-evaluation-result', requestId: 'stale-request-id', ok: true, resultJson: '"forged"'
    })
    const impostor = document.createElement('electrobun-webview') as GuestView
    impostor.emitState({
      type: 'quirky-native-browser-evaluation-result', requestId, ok: true, resultJson: '"wrong guest"'
    })
    guest.guest.emitState({
      type: 'quirky-native-browser-evaluation-result', requestId, ok: true, resultJson: '"actual"'
    })
    await expect(pending).resolves.toBe('actual')

    const nextDispatch = Promise.withResolvers<string>()
    guest.guest.onExecute = nextDispatch.resolve
    const navigating = guest.handle.evaluate('new Promise(() => {})')
    const nextInvocation = await nextDispatch.promise
    const nextRequestId = nextInvocation.match(/__quirkyNativeBrowserEvaluate\?\.\("([^"]+)"/)?.[1]
    guest.guest.emitEvent('will-navigate', { url: 'https://example.test/next' })
    await expect(navigating).rejects.toThrow(/navigation/i)

    guest.guest.emitEvent('did-navigate', { url: 'https://example.test/next' })
    const freshDispatch = Promise.withResolvers<string>()
    guest.guest.onExecute = freshDispatch.resolve
    const fresh = guest.handle.evaluate('new Promise(() => {})')
    const freshInvocation = await freshDispatch.promise
    const freshRequestId = freshInvocation.match(/__quirkyNativeBrowserEvaluate\?\.\("([^"]+)"/)?.[1]
    guest.guest.emitState({
      type: 'quirky-native-browser-evaluation-result', requestId: nextRequestId, ok: true, resultJson: '\"late\"'
    })
    guest.guest.emitState({
      type: 'quirky-native-browser-evaluation-result', requestId: freshRequestId, ok: true, resultJson: '\"current\"'
    })
    await expect(fresh).resolves.toBe('current')
    const samePageDispatch = Promise.withResolvers<string>()
    guest.guest.onExecute = samePageDispatch.resolve
    const samePageEvaluation = guest.handle.evaluate('new Promise(() => {})')
    await samePageDispatch.promise
    guest.guest.emitEvent('did-navigate', { url: 'https://example.test/next' })
    await expect(samePageEvaluation).rejects.toThrow(/navigation/i)
  } finally {
    await guest.cleanup()
  }
})
test('guest loading state does not cancel evaluation while the adapter is becoming ready', async () => {
  const claim = Promise.withResolvers<void>()
  const guest = await mountGuest(claim.promise)
  try {
    const pending = guest.handle.evaluate('({ safe: true })')
    guest.guest.emitState({
      type: 'quirky-native-browser-state',
      url: 'about:blank',
      title: 'Current document',
      loading: true,
      findCurrent: 0,
      findTotal: 0
    })
    claim.resolve()
    await expect(pending).resolves.toEqual({ safe: true })
  } finally {
    claim.resolve()
    await guest.cleanup()
  }
})

test('native navigation while the adapter is becoming ready cannot dispatch a stale evaluation', async () => {
  const claim = Promise.withResolvers<void>()
  const guest = await mountGuest(claim.promise)
  let executed = false
  guest.guest.onExecute = () => { executed = true }
  const pending = guest.handle.evaluate('({ stale: true })')
  guest.guest.emitEvent('will-navigate', { url: 'https://example.test/next' })
  await expect(pending).rejects.toThrow(/navigation/i)
  guest.guest.emitState({
    type: 'quirky-native-browser-state',
    url: 'about:blank',
    title: 'Departing document',
    loading: false,
    findCurrent: 0,
    findTotal: 0
  })
  claim.resolve()
  await guest.handle.request({ action: 'zoom', level: 0 })
  expect(executed).toBe(false)
  await guest.cleanup()
})

test('native evaluation deadline includes guest readiness', async () => {
  const claim = Promise.withResolvers<void>()
  const guest = await mountGuest(claim.promise)
  try {
    const pending = guest.handle.evaluate('({ ready: true })')
    await expect(pending).rejects.toThrow(/timed out/i)
  } finally {
    claim.resolve()
    await guest.cleanup()
  }
}, 8000)


test('native evaluation rejects pending work when its browser view is disposed', async () => {
  const guest = await mountGuest()
  const dispatched = Promise.withResolvers<string>()
  guest.guest.onExecute = dispatched.resolve
  const pending = guest.handle.evaluate('new Promise(() => {})')
  const settled = pending.catch(() => undefined)
  await dispatched.promise
  await guest.cleanup()
  await expect(pending).rejects.toThrow(/disposed/i)
  await settled
})

test('native evaluation times out when guest work never settles', async () => {
  const guest = await mountGuest()
  try {
    const dispatched = Promise.withResolvers<string>()
    guest.guest.onExecute = dispatched.resolve
    const pending = guest.handle.evaluate('new Promise(() => {})')
    await dispatched.promise
    await expect(pending).rejects.toThrow(/timed out/i)
  } finally {
    await guest.cleanup()
  }
}, 8000)

test('an isolated preview mount asks the SDK for a preview view and claims it with its grant', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const claimed = Promise.withResolvers<Record<string, unknown>>()
  const released = Promise.withResolvers<void>()
  announceGuest = mounted.resolve
  const grant = { id: 'a'.repeat(32), root: '/work/report', entry: 'index.html', entryOnly: false }
  const capability = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
    previewAvailable: true,
    async claimNativeBrowserView(params) { claimed.resolve(params); return { zoomFactor: 1 } },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } }
  }))
  const handle = capability.mount(element, { id: 'preview-pane', url: 'about:blank', zoom: 0, partition: '', preview: grant, onState() {} })
  try {
    const guest = await mounted.promise
    expect(guest.getAttribute('isolated-preview')).toBe('quirky-preview')
    expect(guest.hasAttribute('partition')).toBe(false)
    expect(guest.hasAttribute('sandbox')).toBe(true)
    expect(JSON.parse(guest.getAttribute('navigation-rules') ?? '[]')).toEqual(['^*', 'quirky-preview://*', 'about:blank'])
    expect(await claimed.promise).toMatchObject({ viewId: 7, preview: grant })
  } finally {
    handle.dispose()
    await released.promise
    element.remove()
  }
})
