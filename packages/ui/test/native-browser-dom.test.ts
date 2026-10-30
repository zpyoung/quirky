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
  listeners: Map<string, Set<(event: CustomEvent) => void>>
  loadURL(url: string): void
  reloadIgnoringCache?(): Promise<boolean>
  supportsReloadIgnoringCache?(): Promise<boolean>
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
    async releaseNativeBrowserView() { released.resolve(); return { released: true } },
    async routeNativeBrowserLabels() { return { routed: true } }
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

test('a label URL loads only after its partition routes label hosts to the label proxy', async () => {
  for (const routed of [true, false]) {
    const routes: number[] = []
    const loads: string[] = []
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = Promise.withResolvers<GuestView>()
    const released = Promise.withResolvers<void>()
    announceGuest = mounted.resolve
    const capability = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
      async claimNativeBrowserView() { return { zoomFactor: 1 } },
      async setNativeBrowserZoom() { return { zoomFactor: 1 } },
      async releaseNativeBrowserView() { released.resolve(); return { released: true } },
      async routeNativeBrowserLabels({ port }) { routes.push(port); return { routed } }
    }))
    const handle = capability.mount(element, {
      id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
      partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {}
    })
    const guest = await mounted.promise
    // record loads instead of navigating; the requests below never see a completed navigation
    Object.assign(guest, { loadURL: (url: string) => { loads.push(url) } })
    try {
      const label = handle.request({ action: 'navigate', url: 'http://feature-a.quirky.localhost:4100/app' })
      label.catch(() => undefined)
      if (routed) {
        for (let attempt = 0; attempt < 50 && loads.length === 0; attempt += 1) await Bun.sleep(5)
        expect(routes).toEqual([4100])
        expect(loads).toEqual(['http://feature-a.quirky.localhost:4100/app'])
      } else {
        await expect(label).rejects.toThrow('macOS 14')
        expect(routes).toEqual([4100])
        expect(loads).toEqual([])
        handle.request({ action: 'navigate', url: 'https://example.test/' }).catch(() => undefined)
        for (let attempt = 0; attempt < 50 && loads.length === 0; attempt += 1) await Bun.sleep(5)
        expect(routes).toEqual([4100])
        expect(loads).toEqual(['https://example.test/'])
      }
    } finally {
      handle.dispose()
      await released.promise
      element.remove()
    }
  }
})

const CLOSED_URL = 'http://127.0.0.1:9/closed'
const connectionFailure = (url: string) => ({
  url, domain: 'NSURLErrorDomain', code: -1004, description: 'Could not connect to the server.'
})

/** Mounts a guest whose tag reports `support` for cache-bypassing reload, as the patched SDK does. */
async function mountGuestWithHardReload(support: boolean | 'absent') {
  const claim = Promise.withResolvers<void>()
  const guest = await mountGuest(claim.promise)
  const reloads: string[] = []
  if (support !== 'absent') {
    guest.guest.supportsReloadIgnoringCache = async () => support
    guest.guest.reloadIgnoringCache = async () => {
      reloads.push('reloadIgnoringCache')
      return support
    }
  }
  claim.resolve()
  return { ...guest, reloads }
}

test('native hard reload bypasses the engine cache through the tag when the webview supports it', async () => {
  const guest = await mountGuestWithHardReload(true)
  try {
    const before = await guest.handle.request({ action: 'zoom', level: 0 })
    expect(before.hardReloadAvailable).toBe(true)
    guest.guest.reloadIgnoringCache = async () => {
      guest.reloads.push('reloadIgnoringCache')
      queueMicrotask(() => guest.guest.emitEvent('did-navigate', 'about:blank'))
      return true
    }
    const after = await guest.handle.request({ action: 'hardReload' })
    expect(guest.reloads).toEqual(['reloadIgnoringCache'])
    expect(after).toMatchObject({ url: 'about:blank', loading: false, error: null, hardReloadAvailable: true })
  } finally {
    await guest.cleanup()
  }
})

test('native hard reload stays unavailable, never an ordinary reload, when the webview cannot bypass its cache', async () => {
  for (const support of [false, 'absent'] as const) {
    const guest = await mountGuestWithHardReload(support)
    try {
      const before = await guest.handle.request({ action: 'zoom', level: 0 })
      expect(before.hardReloadAvailable).toBe(false)
      await expect(guest.handle.request({ action: 'hardReload' })).rejects.toThrow(/hard reload is unavailable/i)
      expect(guest.reloads).toEqual([])
    } finally {
      await guest.cleanup()
    }
  }
})

test('a native load failure keeps the requested URL, ends loading, and a retry navigation clears it', async () => {
  const guest = await mountGuest()
  try {
    guest.guest.loadURL = (url) => queueMicrotask(() => {
      guest.guest.emitEvent('will-navigate', JSON.stringify({ url, allowed: true }))
      guest.guest.emitEvent('load-failed', connectionFailure(url))
    })
    const failed = await guest.handle.request({ action: 'navigate', url: CLOSED_URL })
    expect(failed).toMatchObject({ url: CLOSED_URL, loading: false })
    expect(failed.error).toBe('Could not connect to the server. (NSURLErrorDomain -1004)')

    guest.guest.loadURL = (url) => queueMicrotask(() => {
      guest.guest.emitEvent('will-navigate', JSON.stringify({ url, allowed: true }))
      guest.guest.emitEvent('did-navigate', url)
    })
    const retried = await guest.handle.request({ action: 'navigate', url: failed.url })
    expect(retried).toMatchObject({ url: CLOSED_URL, loading: false, error: null })
  } finally {
    await guest.cleanup()
  }
})

test('a native failure after a redirect reports the redirect target the engine failed on', async () => {
  const guest = await mountGuest()
  const redirected = 'https://redirected.test/landing'
  try {
    guest.guest.loadURL = (url) => queueMicrotask(() => {
      guest.guest.emitEvent('will-navigate', JSON.stringify({ url, allowed: true }))
      guest.guest.emitEvent('will-navigate', JSON.stringify({ url: redirected, allowed: true }))
      guest.guest.emitEvent('load-failed', JSON.stringify({
        url: redirected, domain: 'NSURLErrorDomain', code: -1202, description: 'The certificate for this server is invalid.'
      }))
    })
    const failed = await guest.handle.request({ action: 'navigate', url: 'https://example.test/start' })
    expect(failed).toMatchObject({ url: redirected, loading: false, error: 'The certificate for this server is invalid. (NSURLErrorDomain -1202)' })
  } finally {
    await guest.cleanup()
  }
})

test('a late native failure from an earlier navigation cannot replace the current one', async () => {
  const guest = await mountGuest()
  const current = 'https://example.test/current'
  try {
    guest.guest.loadURL = (url) => queueMicrotask(() => guest.guest.emitEvent('will-navigate', JSON.stringify({ url, allowed: true })))
    const superseded = guest.handle.request({ action: 'navigate', url: CLOSED_URL })
    await Promise.resolve()
    guest.guest.loadURL = (url) => queueMicrotask(() => {
      guest.guest.emitEvent('will-navigate', JSON.stringify({ url, allowed: true }))
      guest.guest.emitEvent('did-navigate', url)
    })
    const loaded = await guest.handle.request({ action: 'navigate', url: current })
    await superseded
    guest.guest.emitEvent('load-failed', connectionFailure(CLOSED_URL))
    const state = await guest.handle.request({ action: 'zoom', level: 0 })
    expect(loaded).toMatchObject({ url: current, error: null })
    expect(state).toMatchObject({ url: current, loading: false, error: null })
  } finally {
    await guest.cleanup()
  }
})

test('a stopped or download-converted native navigation is not shown as a load error', async () => {
  const guest = await mountGuest()
  try {
    guest.guest.emitEvent('will-navigate', JSON.stringify({ url: CLOSED_URL, allowed: true }))
    guest.guest.emitEvent('load-failed', { ...connectionFailure(CLOSED_URL), code: -999, description: 'cancelled' })
    guest.guest.emitEvent('load-failed', { ...connectionFailure(CLOSED_URL), domain: 'WebKitErrorDomain', code: 102, description: 'Frame load interrupted' })
    const state = await guest.handle.request({ action: 'zoom', level: 0 })
    expect(state.error).toBeNull()
  } finally {
    await guest.cleanup()
  }
})

test('a disposed native view stops listening for load failures', async () => {
  const guest = await mountGuest()
  await guest.handle.request({ action: 'zoom', level: 0 })
  expect(guest.guest.listeners.get('load-failed')?.size).toBe(1)
  await guest.cleanup()
  expect(guest.guest.listeners.get('load-failed')?.size ?? 0).toBe(0)
test('page requests route to the owning mount, answer through the claim, and stop after dispose', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  announceGuest = mounted.resolve
  const listeners = new Set<(viewId: number, event: import('../src/native-browser').NativeBrowserPageEvent) => void>()
  const answers: Array<{ viewId: number; owner: string; id: string; accept: boolean }> = []
  const owners = new Set<string>()
  const released = Promise.withResolvers<void>()
  const capability = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
    async claimNativeBrowserView({ owner }) { owners.add(owner); return { zoomFactor: 1, pageRequests: true } },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } },
    async answerNativeBrowserRequest({ viewId, owner, id, answer }) {
      answers.push({ viewId, owner, id, accept: answer.accept })
      return { answered: true }
    },
    async cancelNativeBrowserDownload({ id }) { return { cancelled: id === 'download-1' } },
    onNativeBrowserPageEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }))
  expect(capability.pageRequestsAvailable).toBe(true)
  const seen: string[] = []
  const handle = capability.mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {},
    onPageRequest: (request) => seen.push(`request:${request.kind}:${request.id}`),
    onPageRequestExpired: (id) => seen.push(`expired:${id}`),
    onDownload: (update) => seen.push(`download:${update.id}:${update.state}`)
  })
  await mounted.promise
  for (let attempt = 0; attempt < 50 && listeners.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  const emit = (viewId: number, event: import('../src/native-browser').NativeBrowserPageEvent) => { for (const listener of listeners) listener(viewId, event) }

  emit(99, { type: 'request', request: { id: '1', kind: 'alert', origin: 'https://other.test', frameUrl: '', message: 'not mine' } })
  emit(7, { type: 'request', request: { id: '2', kind: 'confirm', origin: 'https://site.test', frameUrl: '', message: 'Sure?' } })
  emit(7, { type: 'expired', id: '2' })
  emit(7, { type: 'download', update: { id: 'download-1', state: 'started', path: '/tmp/a' } })
  expect(seen).toEqual(['request:confirm:2', 'expired:2', 'download:download-1:started'])

  expect(await handle.answer?.('2', { accept: true })).toBe(true)
  expect(answers).toEqual([{ viewId: 7, owner: [...owners][0]!, id: '2', accept: true }])
  expect(await handle.cancelDownload?.('download-1')).toBe(true)

  handle.dispose()
  await released.promise
  expect(listeners.size).toBe(0)
  expect(await handle.answer?.('3', { accept: true })).toBe(false)
  element.remove()
})

test('a mount without a page request listener declines requests instead of leaving the page paused', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  announceGuest = mounted.resolve
  const listeners = new Set<(viewId: number, event: import('../src/native-browser').NativeBrowserPageEvent) => void>()
  const answers: Array<{ id: string; accept: boolean }> = []
  const released = Promise.withResolvers<void>()
  const handle = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
    async claimNativeBrowserView() { return { zoomFactor: 1, pageRequests: true } },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } },
    async answerNativeBrowserRequest({ id, answer }) { answers.push({ id, accept: answer.accept }); return { answered: true } },
    onNativeBrowserPageEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  })).mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {}
  })
  await mounted.promise
  for (let attempt = 0; attempt < 50 && listeners.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  for (const listener of listeners) listener(7, { type: 'request', request: { id: '4', kind: 'popup', origin: 'https://site.test', url: 'https://x.test', method: 'GET', width: null, height: null } })
  for (let attempt = 0; attempt < 50 && answers.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(answers).toEqual([{ id: '4', accept: false }])
  handle.dispose()
  await released.promise
  element.remove()
})
