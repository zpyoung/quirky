import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'
import { createElectrobunNativeBrowserAdapter, createNativeBrowserCapability } from '../src/native-browser'

type GuestView = HTMLElement & { emitState(detail: unknown): void }
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
    executeJavascript(script: string) { window.eval(script) }
    emitState(detail: unknown) {
      for (const listener of this.listeners.get('host-message') ?? []) listener(new CustomEvent('host-message', { detail }))
    }
  }
  customElements.define('electrobun-webview', GuestElement)
})
afterAll(() => GlobalRegistrator.unregister())

async function mountGuest() {
  const element = document.createElement('div')
  document.body.append(element)
  const mounted = Promise.withResolvers<GuestView>()
  const released = Promise.withResolvers<void>()
  announceGuest = mounted.resolve
  const capability = createNativeBrowserCapability(createElectrobunNativeBrowserAdapter({
    async claimNativeBrowserView() { return { zoomFactor: 1 } },
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
  return { handle, async cleanup() { handle.dispose(); await released.promise; element.remove() } }
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
