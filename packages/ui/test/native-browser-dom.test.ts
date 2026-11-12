import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'
import { NATIVE_BROWSER_DEFAULT_MASKS, createElectrobunNativeBrowserAdapter, createNativeBrowserCapability, type NativeBrowserShellBridge } from '../src/native-browser'

type RequiredShell = 'claimNativeBrowserView' | 'setNativeBrowserZoom' | 'releaseNativeBrowserView'

/** Fills the shell members a case doesn't exercise, so each case names only what it's about. */
function adapterFor(bridge: Partial<NativeBrowserShellBridge> & Pick<NativeBrowserShellBridge, RequiredShell>) {
  return createElectrobunNativeBrowserAdapter({
    routeNativeBrowserLabels: async () => ({ routed: true }),
    nativeBrowserDefaultUserAgent: async () => ({ userAgent: null }),
    ...bridge
  })
}

type GuestView = HTMLElement & {
  emitState(detail: unknown): void
  emitEvent(name: string, detail: unknown): void
  onExecute?: (script: string) => void
  lastExecution?: string
  listeners: Map<string, Set<(event: CustomEvent) => void>>
  syncCalls: boolean[]
  onSyncDimensions?: (force?: boolean) => void
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
    syncCalls: boolean[] = []
    onSyncDimensions?: (force?: boolean) => void
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
    syncDimensions(force?: boolean) { this.syncCalls.push(force === true); this.onSyncDimensions?.(force) }
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

async function mountGuest(claimGate?: Promise<void>, userAgent?: string, masks?: string[]) {
  const claims: Array<{ userAgent: string | null }> = []
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const claimStarted = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  announceGuest = mounted.resolve
  const capability = createNativeBrowserCapability(adapterFor({
    async claimNativeBrowserView(params) {
      claims.push({ userAgent: params.userAgent })
      claimStarted.resolve()
      if (claimGate) await claimGate
      return { zoomFactor: 1 }
    },
    async nativeBrowserDefaultUserAgent() { return { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)' } },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } },
    async routeNativeBrowserLabels() { return { routed: true } }
  }))
  const handle = capability.mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {},
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(masks === undefined ? {} : { masks })
  })
  const guest = await mounted.promise
  const preload = guest?.getAttribute('preload')
  if (!guest || !preload) throw new Error('native adapter did not attach its real guest program')
  ;(window as Window & { __electrobunSendToHost?: (detail: unknown) => void }).__electrobunSendToHost = (detail) => guest.emitState(detail)
  window.eval(preload)
  return {
    handle, guest, claims, claimStarted: claimStarted.promise, capability,
    released: released.promise,
    async cleanup() { handle.dispose(); await released.promise; element.remove() }
  }
}

type FixtureMotion = { playState: AnimationPlayState; effect: { target: Element | null } }

/** Controls only host-DOM scheduling; actual fixture mutations still create native DOM records. */
function installMaskFixture() {
  const undo: Array<() => void> = []
  const intervals = new Map<number, { callback: () => void; every: number; next: number; active: boolean }>()
  const frames = new Map<number, FrameRequestCallback>()
  const mutationObservers = new Set<ControlledMutationObserver>()
  const resizeObservers = new Set<ControlledResizeObserver>()
  const rects = new WeakMap<Element, DOMRect>()
  const motions = new WeakMap<Element, FixtureMotion[]>()
  const listeners = new Set<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; capture: boolean }>()
  const watchedEvents = new Set([
    'scroll', 'load', 'resize', 'input', 'change', 'focus', 'blur', 'focusin', 'focusout',
    'pointerover', 'pointerout', 'pointerdown', 'pointerup', 'pointercancel', 'click', 'toggle',
    'transitionrun', 'transitionstart', 'transitionend', 'transitioncancel',
    'animationstart', 'animationiteration', 'animationend', 'animationcancel'
  ])
  const NativeMutationObserver = globalThis.MutationObserver
  let intervalCalls = 0
  let frameCalls = 0
  let cancelCalls = 0
  let queryCalls = 0
  let rectCalls = 0
  let clock = 0
  let nextInterval = 0
  let nextFrame = 0
  const suffix = ':not(details:not([open]) *)'

  function replace(target: object, name: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    Object.defineProperty(target, name, { configurable: true, writable: true, value })
    undo.push(() => descriptor ? Object.defineProperty(target, name, descriptor) : Reflect.deleteProperty(target, name))
  }

  class ControlledMutationObserver implements MutationObserver {
    private readonly native: MutationObserver
    private pending: MutationRecord[] = []
    observesHostDocument = false
    constructor(private readonly callback: MutationCallback) {
      this.native = new NativeMutationObserver((records) => this.pending.push(...records))
      mutationObservers.add(this)
    }
    observe(target: Node, options?: MutationObserverInit) {
      this.native.observe(target, options)
      if (target === document || target === document.documentElement || target === document.body) this.observesHostDocument = true
    }
    disconnect() { this.native.disconnect(); this.pending = []; mutationObservers.delete(this) }
    takeRecords() {
      this.pending.push(...this.native.takeRecords())
      const records = this.pending
      this.pending = []
      return records
    }
    deliver() {
      const records = this.takeRecords()
      if (records.length) this.callback(records, this)
    }
  }

  class ControlledResizeObserver implements ResizeObserver {
    private readonly targets = new Set<Element>()
    private active = true
    constructor(private readonly callback: ResizeObserverCallback) { resizeObservers.add(this) }
    observe(target: Element) { if (this.active) this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); this.active = false; resizeObservers.delete(this) }
    notify(target: Element) {
      if (!this.active || !this.targets.has(target)) return
      const rect = rects.get(target) ?? new DOMRect()
      this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this)
    }
  }

  const originalQuery = document.querySelectorAll
  replace(document, 'querySelectorAll', function (this: Document, selector: string) {
    queryCalls += 1
    if (!selector.endsWith(suffix)) return originalQuery.call(this, selector)
    // happy-dom lacks this WebKit selector; emulate only its closed-details exclusion.
    const matches = originalQuery.call(this, selector.slice(0, -suffix.length))
    return Array.from(matches).filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.localName === 'details' && !parent.hasAttribute('open')) return false
      }
      return true
    }) as unknown as NodeListOf<Element>
  })
  const originalRect = Element.prototype.getBoundingClientRect
  replace(Element.prototype, 'getBoundingClientRect', function (this: Element) {
    rectCalls += 1
    return rects.get(this) ?? originalRect.call(this)
  })
  replace(Element.prototype, 'getAnimations', function (this: Element) {
    return (motions.get(this) ?? []).filter((animation) => animation.effect?.target === this) as unknown as Animation[]
  })
  replace(globalThis, 'MutationObserver', ControlledMutationObserver)
  replace(globalThis, 'ResizeObserver', ControlledResizeObserver)
  replace(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frameCalls += 1
    frames.set(id, callback)
    return id
  })
  replace(globalThis, 'cancelAnimationFrame', ((id: number) => { cancelCalls += 1; frames.delete(id) }) as typeof cancelAnimationFrame)
  replace(globalThis, 'setInterval', ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = ++nextInterval
    const every = Math.max(1, Number(delay) || 1)
    intervalCalls += 1
    intervals.set(id, { callback: () => {
      if (typeof callback === 'function') callback(...args)
    }, every, next: clock + every, active: true })
    return id
  }) as typeof setInterval)
  replace(globalThis, 'clearInterval', ((id: number) => {
    const interval = intervals.get(Number(id))
    if (interval) interval.active = false
  }) as typeof clearInterval)

  for (const target of [document, window]) {
    const originalAdd = target.addEventListener
    const originalRemove = target.removeEventListener
    replace(target, 'addEventListener', function (
      this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions
    ) {
      if (listener) originalAdd.call(this, type, listener, options)
      if (listener && watchedEvents.has(type)) {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        // the guest preload shares this fixture's window; only the host watcher uses capture.
        if (capture) listeners.add({ target: this, type, listener, capture })
      }
    })
    replace(target, 'removeEventListener', function (
      this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions
    ) {
      if (listener) originalRemove.call(this, type, listener, options)
      if (listener) {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        for (const entry of listeners) {
          if (entry.target === this && entry.type === type && entry.listener === listener && entry.capture === capture) listeners.delete(entry)
        }
      }
    })
  }

  function flushMutations() { for (const observer of [...mutationObservers]) observer.deliver() }
  function flushFrame() {
    const scheduled = [...frames.values()]
    frames.clear()
    for (const callback of scheduled) callback(clock)
    return scheduled.length
  }
  function advanceBy(ms: number) {
    const deadline = clock + ms
    for (;;) {
      const due = [...intervals.values()].filter((interval) => interval.active && interval.next <= deadline).sort((a, b) => a.next - b.next)[0]
      if (!due) break
      clock = due.next
      due.callback()
      due.next += due.every
    }
    clock = deadline
  }
  function setRect(element: Element, x: number, y: number, width: number, height: number) {
    rects.set(element, new DOMRect(x, y, width, height))
  }
  function addMotion(target: Element, playState: AnimationPlayState = 'running') {
    const motion = { playState, effect: { target } } as FixtureMotion
    motions.set(target, [...(motions.get(target) ?? []), motion])
    return motion
  }
  function notifyResize(target: Element) { for (const observer of [...resizeObservers]) observer.notify(target) }
  function dispatch(target: EventTarget, name: string, bubbles = true) { target.dispatchEvent(new Event(name, { bubbles })) }
  function restore() {
    for (const observer of [...mutationObservers]) observer.disconnect()
    for (const observer of [...resizeObservers]) observer.disconnect()
    for (const { target, type, listener, capture } of listeners) target.removeEventListener(type, listener, capture)
    frames.clear()
    intervals.clear()
    for (const undoProperty of undo.reverse()) undoProperty()
  }

  return {
    flushMutations, flushFrame, advanceBy, setRect, addMotion, notifyResize, dispatch, restore,
    get intervalCalls() { return intervalCalls },
    get frameCalls() { return frameCalls },
    get cancelCalls() { return cancelCalls },
    get pendingFrames() { return frames.size },
    get queryCalls() { return queryCalls },
    get rectCalls() { return rectCalls },
    get activeObservers() { return [...mutationObservers].filter((observer) => observer.observesHostDocument).length + resizeObservers.size },
    get activeListeners() { return listeners.size }
  }
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
    const capability = createNativeBrowserCapability(adapterFor({
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

test('a navigation that overtakes a slow label route stays current and the label request still settles', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const released = Promise.withResolvers<void>()
  const route = Promise.withResolvers<{ routed: boolean }>()
  const routing = Promise.withResolvers<void>()
  const loads: string[] = []
  announceGuest = mounted.resolve
  const capability = createNativeBrowserCapability(adapterFor({
    async claimNativeBrowserView() { return { zoomFactor: 1 } },
    async setNativeBrowserZoom() { return { zoomFactor: 1 } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } },
    routeNativeBrowserLabels() { routing.resolve(); return route.promise }
  }))
  const handle = capability.mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`, onState() {}
  })
  const guest = await mounted.promise
  Object.assign(guest, { loadURL: (url: string) => { loads.push(url) } })
  try {
    await handle.request({ action: 'zoom', level: 0 })
    const label = handle.request({ action: 'navigate', url: 'http://feature-a.quirky.localhost:4100/app' })
    await routing.promise
    handle.request({ action: 'navigate', url: 'https://example.test/' }).catch(() => undefined)
    for (let attempt = 0; attempt < 50 && loads.length === 0; attempt += 1) await Bun.sleep(5)
    route.resolve({ routed: true })
    await label
    expect(loads).toEqual(['https://example.test/'])
  } finally {
    handle.dispose()
    await released.promise
    element.remove()
  }
})

test('every native mask excludes closed details and fits the comma-separated masks attribute', () => {
  // happy-dom can't evaluate this nested :not(), so the shape is asserted here; WebKit runs it in the app
  expect(NATIVE_BROWSER_DEFAULT_MASKS.length).toBeGreaterThan(0)
  for (const selector of NATIVE_BROWSER_DEFAULT_MASKS) {
    expect(selector).toEndWith(':not(details:not([open]) *)')
    expect(selector).not.toContain(',')
  }
})

async function readyForMaskTests(guest: Awaited<ReturnType<typeof mountGuest>>) {
  await guest.handle.request({ action: 'zoom', level: 0 })
  guest.guest.syncCalls.length = 0
}

function flushMaskFrame(fixture: ReturnType<typeof installMaskFixture>) {
  fixture.flushMutations()
  expect(fixture.pendingFrames).toBe(1)
  expect(fixture.flushFrame()).toBe(1)
}

test('static native masks do no periodic DOM work while idle', async () => {
  const fixture = installMaskFixture()
  let guest: Awaited<ReturnType<typeof mountGuest>> | undefined
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  fixture.setRect(overlay, 10, 20, 300, 200)
  try {
    guest = await mountGuest()
    await readyForMaskTests(guest)
    const initialQueries = fixture.queryCalls
    const initialRects = fixture.rectCalls
    const initialFrames = fixture.frameCalls
    fixture.advanceBy(1000)
    expect(fixture.intervalCalls).toBe(0)
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.frameCalls).toBe(initialFrames)
    expect(fixture.queryCalls).toBe(initialQueries)
    expect(fixture.rectCalls).toBe(initialRects)
    expect(guest.guest.syncCalls).toHaveLength(0)

    document.body.append(overlay)
    flushMaskFrame(fixture)
    expect(guest.guest.syncCalls).toHaveLength(1)
    const settledQueries = fixture.queryCalls
    const settledRects = fixture.rectCalls
    const settledFrames = fixture.frameCalls
    fixture.advanceBy(1000)
    expect(fixture.intervalCalls).toBe(0)
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.frameCalls).toBe(settledFrames)
    expect(fixture.queryCalls).toBe(settledQueries)
    expect(fixture.rectCalls).toBe(settledRects)
    expect(guest.guest.syncCalls).toHaveLength(1)
  } finally {
    overlay.remove()
    await guest?.cleanup()
    fixture.restore()
  }
})

test('mask notifications coalesce and sample valid selectors, state, layout and event changes', async () => {
  const fixture = installMaskFixture()
  let guest: Awaited<ReturnType<typeof mountGuest>> | undefined
  const layout = document.createElement('section')
  const candidate = document.createElement('div')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  const button = document.createElement('button')
  layout.append(candidate, checkbox, button)
  const details = document.createElement('details')
  const nestedDialog = document.createElement('div')
  nestedDialog.setAttribute('role', 'dialog')
  details.append(nestedDialog)
  document.body.append(layout, details)
  fixture.setRect(candidate, 1, 2, 30, 40)
  fixture.setRect(checkbox, 3, 4, 10, 10)
  fixture.setRect(button, 5, 6, 20, 20)
  fixture.setRect(nestedDialog, 7, 8, 50, 50)
  try {
    guest = await mountGuest(undefined, undefined, ['[', '.custom-mask', 'input:checked', 'button:focus'])
    await readyForMaskTests(guest)
    let expectedSyncs = 0
    const changed = () => {
      flushMaskFrame(fixture)
      expectedSyncs += 1
      expect(guest?.guest.syncCalls).toHaveLength(expectedSyncs)
    }
    const unchanged = () => {
      flushMaskFrame(fixture)
      expect(guest?.guest.syncCalls).toHaveLength(expectedSyncs)
    }

    candidate.setAttribute('role', 'dialog')
    changed()
    candidate.removeAttribute('role')
    changed()
    candidate.classList.add('custom-mask')
    changed()
    candidate.style.position = 'fixed'
    fixture.setRect(candidate, 2, 2, 30, 40)
    changed()
    const label = document.createTextNode('before')
    layout.append(label)
    unchanged()
    fixture.setRect(candidate, 2, 2, 31, 40)
    label.data = 'after'
    changed()

    fixture.setRect(candidate, 3, 2, 30, 40)
    fixture.notifyResize(candidate)
    changed()
    fixture.setRect(candidate, 4, 2, 30, 40)
    fixture.notifyResize(layout)
    changed()

    fixture.setRect(candidate, 5, 2, 30, 40)
    fixture.dispatch(candidate, 'scroll', false)
    changed()
    fixture.setRect(candidate, 6, 2, 30, 40)
    fixture.dispatch(candidate, 'load', false)
    changed()
    fixture.setRect(candidate, 7, 2, 30, 40)
    fixture.dispatch(window, 'resize')
    changed()

    checkbox.checked = true
    fixture.dispatch(checkbox, 'input', false)
    changed()
    checkbox.checked = false
    fixture.dispatch(checkbox, 'change', false)
    changed()
    fixture.setRect(candidate, 8, 2, 30, 40)
    button.focus()
    fixture.dispatch(button, 'focusin', false)
    changed()
    fixture.setRect(candidate, 9, 2, 30, 40)
    fixture.dispatch(candidate, 'pointerdown', false)
    changed()

    details.open = true
    changed()
    details.open = false
    changed()

    fixture.setRect(candidate, 10, 2, 30, 40)
    fixture.setRect(candidate, 11, 2, 30, 40)
    fixture.notifyResize(candidate)
    fixture.dispatch(window, 'resize')
    fixture.dispatch(candidate, 'scroll', false)
    expect(fixture.pendingFrames).toBe(1)
    changed()
    fixture.dispatch(candidate, 'scroll', false)
    unchanged()

    let feedbackAdded = false
    guest.guest.onSyncDimensions = () => {
      if (feedbackAdded) return
      feedbackAdded = true
      const feedback = document.createElement('span')
      feedback.textContent = 'sync feedback'
      layout.append(feedback)
    }
    fixture.setRect(candidate, 12, 2, 30, 40)
    fixture.dispatch(window, 'resize')
    changed()
    fixture.flushMutations()
    expect(fixture.pendingFrames).toBe(1)
    expect(fixture.flushFrame()).toBe(1)
    expect(guest.guest.syncCalls).toHaveLength(expectedSyncs)
    expect(fixture.pendingFrames).toBe(0)
    guest.guest.onSyncDimensions = undefined
  } finally {
    await guest?.cleanup()
    layout.remove()
    details.remove()
    fixture.restore()
  }
})

test('only active mask and ancestor motion samples frames and stops at settled states', async () => {
  const fixture = installMaskFixture()
  let guest: Awaited<ReturnType<typeof mountGuest>> | undefined
  const layout = document.createElement('section')
  const mask = document.createElement('div')
  mask.setAttribute('role', 'dialog')
  const spinner = document.createElement('span')
  layout.append(mask)
  mask.append(spinner)
  document.body.append(layout)
  fixture.setRect(mask, 0, 0, 40, 40)
  const maskMotion = fixture.addMotion(mask)
  const transition = fixture.addMotion(layout)
  fixture.addMotion(spinner)
  try {
    guest = await mountGuest()
    await readyForMaskTests(guest)
    expect(fixture.pendingFrames).toBe(1)
    expect(fixture.flushFrame()).toBe(1)
    fixture.setRect(mask, 10, 0, 40, 40)
    fixture.setRect(mask, 20, 0, 40, 40)
    expect(fixture.flushFrame()).toBe(1)
    expect(guest.guest.syncCalls).toHaveLength(1)
    fixture.setRect(mask, 40, 0, 40, 40)
    expect(fixture.flushFrame()).toBe(1)
    expect(guest.guest.syncCalls).toHaveLength(2)

    maskMotion.playState = 'paused'
    transition.playState = 'paused'
    expect(fixture.flushFrame()).toBe(1)
    expect(fixture.pendingFrames).toBe(0)
    fixture.dispatch(spinner, 'animationstart')
    expect(fixture.pendingFrames).toBe(0)

    maskMotion.playState = 'running'
    transition.playState = 'running'
    fixture.dispatch(mask, 'animationstart')
    fixture.dispatch(layout, 'transitionrun')
    expect(fixture.pendingFrames).toBe(1)
    expect(fixture.flushFrame()).toBe(1)
    fixture.setRect(mask, 60, 0, 40, 40)
    maskMotion.playState = 'finished'
    transition.playState = 'idle'
    fixture.dispatch(mask, 'animationend')
    fixture.dispatch(layout, 'transitioncancel')
    expect(fixture.flushFrame()).toBe(1)
    expect(guest.guest.syncCalls).toHaveLength(3)
    expect(fixture.pendingFrames).toBe(0)

    maskMotion.playState = 'running'
    fixture.dispatch(mask, 'animationstart')
    expect(fixture.flushFrame()).toBe(1)
    expect(fixture.pendingFrames).toBe(1)
    layout.remove()
    fixture.flushMutations()
    expect(fixture.flushFrame()).toBe(1)
    expect(guest.guest.syncCalls).toHaveLength(4)
    expect(fixture.pendingFrames).toBe(0)
  } finally {
    await guest?.cleanup()
    layout.remove()
    fixture.restore()
  }
})

test('mask disposal cancels queued frames and detaches observers and event listeners', async () => {
  const fixture = installMaskFixture()
  let guest: Awaited<ReturnType<typeof mountGuest>> | undefined
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  fixture.setRect(overlay, 1, 1, 20, 20)
  try {
    guest = await mountGuest()
    await readyForMaskTests(guest)
    expect(fixture.activeObservers).toBeGreaterThan(0)
    expect(fixture.activeListeners).toBeGreaterThan(0)
    document.body.append(overlay)
    fixture.flushMutations()
    expect(fixture.pendingFrames).toBe(1)
    const cancelCalls = fixture.cancelCalls
    await guest.handle.dispose()
    expect(fixture.cancelCalls).toBeGreaterThan(cancelCalls)
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.activeObservers).toBe(0)
    expect(fixture.activeListeners).toBe(0)
    const calls = guest.guest.syncCalls.length
    const queries = fixture.queryCalls
    const rects = fixture.rectCalls
    overlay.remove()
    document.body.append(overlay)
    fixture.notifyResize(overlay)
    fixture.dispatch(overlay, 'scroll', false)
    fixture.dispatch(overlay, 'transitionrun')
    fixture.flushMutations()
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.queryCalls).toBe(queries)
    expect(fixture.rectCalls).toBe(rects)
    expect(guest.guest.syncCalls).toHaveLength(calls)
  } finally {
    overlay.remove()
    await guest?.cleanup()
    fixture.restore()
  }
})

test('disposing during a pending native claim cancels mask work and detaches watchers', async () => {
  const fixture = installMaskFixture()
  const claim = Promise.withResolvers<void>()
  let guest: Awaited<ReturnType<typeof mountGuest>> | undefined
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  try {
    guest = await mountGuest(claim.promise)
    await guest.claimStarted
    document.body.append(overlay)
    fixture.flushMutations()
    expect(fixture.pendingFrames).toBe(1)
    expect(fixture.activeObservers).toBeGreaterThan(0)
    expect(fixture.activeListeners).toBeGreaterThan(0)
    const calls = guest.guest.syncCalls.length
    const queries = fixture.queryCalls
    const rects = fixture.rectCalls
    const disposing = guest.handle.dispose()
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.activeObservers).toBe(0)
    expect(fixture.activeListeners).toBe(0)
    overlay.remove()
    document.body.append(overlay)
    fixture.notifyResize(overlay)
    fixture.dispatch(overlay, 'scroll', false)
    fixture.dispatch(overlay, 'animationstart')
    fixture.flushMutations()
    expect(fixture.pendingFrames).toBe(0)
    expect(fixture.queryCalls).toBe(queries)
    expect(fixture.rectCalls).toBe(rects)
    expect(guest.guest.syncCalls).toHaveLength(calls)
    claim.resolve()
    await disposing
    await guest.released
  } finally {
    claim.resolve()
    overlay.remove()
    await guest?.cleanup()
    fixture.restore()
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
})

test('page requests route to the owning mount, answer through the claim, and stop after dispose', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  announceGuest = mounted.resolve
  const listeners = new Set<(viewId: number, event: import('../src/native-browser').NativeBrowserPageEvent) => void>()
  const answers: Array<{ viewId: number; owner: string; id: string; accept: boolean }> = []
  const owners = new Set<string>()
  const released = Promise.withResolvers<void>()
  const capability = createNativeBrowserCapability(adapterFor({
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
  const handle = createNativeBrowserCapability(adapterFor({
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

test('the profile store is assigned before the guest view exists', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const partition = `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`
  const events: string[] = []
  const mounted = Promise.withResolvers<GuestView>()
  const released = Promise.withResolvers<void>()
  announceGuest = (guest) => { events.push('guest'); mounted.resolve(guest) }
  const capability = createNativeBrowserCapability(adapterFor({
    async prepareNativeBrowserPartition(params) {
      events.push(`prepare:${params.partition}:${element.querySelector('electrobun-webview') ? 'late' : 'first'}`)
      return { storageIdentifier: '9B0C5E52-8F3A-4C1D-9E7B-2A6F4D8C1E35' }
    },
    async claimNativeBrowserView() { events.push('claim'); return { zoomFactor: 1 } },
    async setNativeBrowserZoom({ level }) { return { zoomFactor: Math.pow(1.2, level) } },
    async releaseNativeBrowserView() { released.resolve(); return { released: true } }
  }))
  const handle = capability.mount(element, { id: crypto.randomUUID(), url: 'about:blank', zoom: 0, partition, onState() {} })
  try {
    const guest = await mounted.promise
    expect(guest.getAttribute('partition')).toBe(partition)
    await Bun.sleep(0)
    expect(events).toEqual([`prepare:${partition}:first`, 'guest', 'claim'])
  } finally {
    handle.dispose()
    await released.promise
    element.remove()
  }
})

test('an isolated preview mount asks the SDK for a preview view and claims it with its grant', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const claimed = Promise.withResolvers<Record<string, unknown>>()
  const released = Promise.withResolvers<void>()
  announceGuest = mounted.resolve
  const grant = { id: 'a'.repeat(32), root: '/work/report', entry: 'index.html', entryOnly: false }
  const prepared: string[] = []
  const capability = createNativeBrowserCapability(adapterFor({
    previewAvailable: true,
    async prepareNativeBrowserPartition({ partition }) { prepared.push(partition); return { storageIdentifier: null } },
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
    expect(prepared).toEqual([])
  } finally {
    handle.dispose()
    await released.promise
    element.remove()
  }
})

test('a failed store assignment never creates a guest view', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  let claims = 0
  const states: Array<string | null> = []
  const capability = createNativeBrowserCapability(adapterFor({
    async prepareNativeBrowserPartition() { throw new Error('native browser profile storage could not be assigned') },
    async claimNativeBrowserView() { claims += 1; return { zoomFactor: 1 } },
    async setNativeBrowserZoom() { return { zoomFactor: 1 } },
    async releaseNativeBrowserView() { return { released: true } }
  }))
  const handle = capability.mount(element, {
    id: crypto.randomUUID(), url: 'about:blank', zoom: 0,
    partition: `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`,
    onState: (state) => states.push(state.error)
  })
  try {
    await Bun.sleep(10)
    expect(element.querySelector('electrobun-webview')).toBeNull()
    expect(claims).toBe(0)
    expect(states).toContain('native browser profile storage could not be assigned')
  } finally {
    handle.dispose()
    element.remove()
  }
})

test('the trusted claim carries the requested user agent, or null to keep the engine default', async () => {
  const cleaned = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const withAgent = await mountGuest(undefined, cleaned)
  try {
    await withAgent.handle.request({ action: 'zoom', level: 0 })
    expect(withAgent.claims).toEqual([{ userAgent: cleaned }])
    expect(await withAgent.capability.defaultUserAgent()).toBe(cleaned)
  } finally {
    await withAgent.cleanup()
  }
  const engineDefault = await mountGuest()
  try {
    await engineDefault.handle.request({ action: 'zoom', level: 0 })
    expect(engineDefault.claims).toEqual([{ userAgent: null }])
  } finally {
    await engineDefault.cleanup()
  }
})
