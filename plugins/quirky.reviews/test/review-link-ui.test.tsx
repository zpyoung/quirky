import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CHORD_PLATFORM, type QuirkyEvent, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import type { ReviewsState } from '../src/contracts'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { ReviewPage } from '../src/detail/ReviewPage'
import { activate } from '../src/ui'
import { isRecord } from '../src/checks/data'
import { bootReviews } from './support'
import { checksFixtureState, checksGhSource, checksReview } from './checks-fixture'
import { detailGhSource, detailSeedState } from './detail-fixture'
import type { HostingTest } from '../../quirky.hosting/test/helpers'

const APP_SETTING = 'setting:quirky.browser/openLinksInApp'
const INVERT_SETTING = 'setting:quirky.browser/openLinksInAppModifierInverts'
const PULL_REQUEST = 'https://github.com/test-owner/test-repo/pull/'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Set<() => void> = new Set()
type ManagedHost = { host: HostingTest; externalRoot: string; priorOpenLog: string | undefined }
const hosts: ManagedHost[] = []

afterEach(async () => {
  await act(async () => {
    for (const unmount of [...mounted]) unmount()
  })
  for (const managed of hosts.splice(0).reverse()) {
    try {
      await managed.host.cleanup()
    } finally {
      if (managed.priorOpenLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
      else process.env.QUIRKY_TEST_OPEN_LOG = managed.priorOpenLog
      rmSync(managed.externalRoot, { recursive: true, force: true })
    }
  }
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

type ExternalOpen = { target: string; reveal: boolean }
type BrowserPane = { id: string; worktreeId: string; mode: string; page: string | null; url: string; tabId?: string }
type UiHarness = {
  context: UiPluginContext
  settings: Map<string, unknown>
  toasts: { title: string; body: string }[]
  setBrowserSetting(name: 'openLinksInApp' | 'openLinksInAppModifierInverts', value: boolean): Promise<void>
  forgetSetting(id: string): void
  flushCalls(): Promise<void>
}
type SurfaceMount = { element: HTMLElement; render(state: ReviewsState): void; unmount(): void }


function externalOpens(path: string): ExternalOpen[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ExternalOpen)
  } catch {
    return []
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 5)
    await delay.promise
  }
  expect(predicate()).toBe(true)
}

async function makeUiHarness(host: HostingTest): Promise<UiHarness> {
  await host.client.callAny('quirky.browser/preferencesState', {})
  const window = await host.connect('ui')
  const provided = new Map<string, (input?: unknown) => unknown>()
  const settings = new Map<string, unknown>()
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const toasts: UiHarness['toasts'] = []
  const pendingCalls: Promise<unknown>[] = []
  const layout: UiLayout = {
    view: { id: 'view:quirky.session/worktree', input: { worktree: host.worktree } },
    panel: null,
    sidebar: true,
    focus: 'view'
  }

  for (const id of [APP_SETTING, INVERT_SETTING]) {
    const setting = await window.callAny('setting.get', { id }) as { value?: unknown }
    settings.set(id, setting.value)
  }

  const context = {
    pluginId: 'quirky.reviews',
    nativeBrowser: {} as UiPluginContext['nativeBrowser'],
    log() {},
    provide(id: string, implementation: unknown) {
      if (typeof implementation === 'function') provided.set(id, implementation as (input?: unknown) => unknown)
    },
    call(method: string, params: Record<string, unknown> = {}) {
      const operation = window.callAny(method, params)
      pendingCalls.push(operation)
      return operation
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    getSetting(name: string) { return settings.get(name) },
    async executeCommand() {},
    createCommandDrag() { throw new Error('command dragging is unavailable in this test') },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    getLayout: () => layout,
    onLayout() { return () => {} },
    onStream() { return () => {} },
    onConnection() { return () => {} },
    confirm: async () => true,
    toast(title: string, body: string) { toasts.push({ title, body }) },
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  } as unknown as UiPluginContext

  activate(context)
  window.onEvent((event) => {
    if (event.type === 'setting.changed') settings.set(event.id, event.value)
    for (const listener of [...eventListeners]) void listener(event)
    if (event.type !== 'ui.command.request') return
    const handler = provided.get(event.id)
    void (async () => {
      try {
        if (!handler) throw new Error(`No registered UI command for ${event.id}.`)
        const result = await handler(event.args)
        await window.call('ui.command.reply', { requestId: event.requestId, result })
      } catch (error) {
        await window.call('ui.command.reply', {
          requestId: event.requestId,
          error: { message: error instanceof Error ? error.message : String(error) }
        })
      }
    })().catch(() => {})
  })
  await window.call('events.subscribe', {})

  return {
    context,
    settings,
    toasts,
    async setBrowserSetting(name, value) {
      const id = name === 'openLinksInApp' ? APP_SETTING : INVERT_SETTING
      await act(async () => {
        await host.client.callAny('setting.set', { id, value })
        await waitUntil(() => settings.get(id) === value)
      })
    },
    forgetSetting(id) { settings.delete(id) },
    async flushCalls() {
      while (pendingCalls.length > 0) {
        const batch = pendingCalls.splice(0)
        await Promise.allSettled(batch)
      }
    }
  }
}

async function bootUi(source: string, options: { branch?: string; remote?: string } = {}) {
  const externalRoot = mkdtempSync(join(tmpdir(), 'quirky-review-link-ui-'))
  const externalLog = join(externalRoot, 'external.jsonl')
  const priorOpenLog = process.env.QUIRKY_TEST_OPEN_LOG
  process.env.QUIRKY_TEST_OPEN_LOG = externalLog
  try {
    const host = await bootReviews(source, {
      ...options,
      extraBuiltins: ['quirky.browser', 'quirky.editor']
    })
    hosts.push({ host, externalRoot, priorOpenLog })
    const ui = await makeUiHarness(host)
    return { host, ui, externalLog }
  } catch (error) {
    if (priorOpenLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
    else process.env.QUIRKY_TEST_OPEN_LOG = priorOpenLog
    rmSync(externalRoot, { recursive: true, force: true })
    throw error
  }
}

function mountChecks(ui: UiHarness, state: ReviewsState): SurfaceMount {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root: Root = createRoot(element)
  let mountedRoot = true
  const refresh = async () => {}
  const render = (next: ReviewsState) => act(() => root.render(<ChecksPanel context={ui.context} state={next} refresh={refresh} />))
  const unmount = () => {
    if (!mountedRoot) return
    mountedRoot = false
    mounted.delete(unmount)
    root.unmount()
  }
  mounted.add(unmount)
  render(state)
  return { element, render, unmount }
}

function mountDetail(ui: UiHarness, state: ReviewsState): SurfaceMount {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root: Root = createRoot(element)
  let mountedRoot = true
  const refresh = async () => {}
  const render = (next: ReviewsState) => act(() => root.render(<ReviewPage context={ui.context} state={next} refresh={refresh} />))
  const unmount = () => {
    if (!mountedRoot) return
    mountedRoot = false
    mounted.delete(unmount)
    root.unmount()
  }
  mounted.add(unmount)
  render(state)
  return { element, render, unmount }
}

function button(root: ParentNode, predicate: (candidate: HTMLButtonElement) => boolean, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(predicate)
  if (!found) throw new Error(`Could not find ${name} button.`)
  return found
}

function routeButton(mount: SurfaceMount, surface: 'checks-header' | 'checks-stack' | 'detail'): HTMLButtonElement {
  if (surface === 'checks-header') return button(mount.element, (candidate) => candidate.textContent?.trim() === '#12', 'Checks PR header')
  if (surface === 'checks-stack') return button(mount.element, (candidate) => candidate.textContent?.trim().startsWith('#7 ·') === true, 'stack PR #7 member')
  return button(mount.element, (candidate) => candidate.textContent?.trim() === 'Open on host', 'detail Open on host')
}

function withChecksLink(state: ReviewsState, url: string, stackUrl?: string): ReviewsState {
  const copy = structuredClone(state)
  if (copy.checks.review) copy.checks.review.url = url
  if (stackUrl && copy.checks.review && isRecord(copy.checks.review.stack) && Array.isArray(copy.checks.review.stack.entries)) {
    const member = copy.checks.review.stack.entries.find((entry) => isRecord(entry) && entry.number === 7)
    if (isRecord(member)) member.url = stackUrl
  }
  return copy
}

function withDetailLink(state: ReviewsState, url: string, worktree?: string): ReviewsState {
  const copy = structuredClone(state)
  if (copy.detail.review) copy.detail.review.url = url
  if (worktree && copy.detail.target) copy.detail.target.worktree = worktree
  return copy
}

function withStack(state: ReviewsState): ReviewsState {
  const copy = structuredClone(state)
  if (copy.checks.review) {
    copy.checks.review.stack = {
      available: true,
      number: 42,
      position: 2,
      size: 2,
      entries: [
        { number: 7, title: 'Fixture member seven', url: `${PULL_REQUEST}7` },
        { number: 12, title: 'Fixture member twelve', url: `${PULL_REQUEST}12` }
      ],
      truncated: false
    }
  }
  return copy
}

function eventModifiers(alternate: boolean): { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean } {
  if (!alternate) return { shiftKey: false }
  return CHORD_PLATFORM === 'darwin' ? { shiftKey: true, metaKey: true } : { shiftKey: true, ctrlKey: true }
}

async function dispatchClick(ui: UiHarness, target: HTMLButtonElement, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; detail?: number } = {}) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: modifiers.detail ?? 1,
      shiftKey: modifiers.shiftKey ?? false,
      metaKey: modifiers.metaKey ?? false,
      ctrlKey: modifiers.ctrlKey ?? false
    }))
    await ui.flushCalls()
  })
}
async function settleUi(ui: UiHarness): Promise<void> {
  await act(async () => {
    await ui.flushCalls()
  })
}

async function assertRoute(
  host: HostingTest,
  externalLog: string,
  ui: UiHarness,
  target: HTMLButtonElement,
  url: string,
  worktree: string,
  openInApp: boolean,
  modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}
) {
  const previousExternal = externalOpens(externalLog)
  await dispatchClick(ui, target, modifiers)
  const panes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
  const currentExternal = externalOpens(externalLog)
  if (openInApp) {
    const pane = panes.tabs.find((entry) => entry.url === url)
    expect(pane).toMatchObject({ worktreeId: worktree, mode: 'native', page: null, url })
    expect(pane?.tabId).toEqual(expect.any(String))
    expect(currentExternal).toEqual(previousExternal)
    const uiState = await host.client.call('ui.state', {}) as { layout: { view: { id: string; input: { worktree: string } } } }
    expect(uiState.layout.view).toMatchObject({
      id: 'view:quirky.session/worktree',
      input: { worktree: `id:${worktree}` }
    })
  } else {
    expect(currentExternal.slice(previousExternal.length)).toContainEqual({ target: url, reveal: false })
    expect(panes.tabs.some((entry) => entry.url === url)).toBe(false)
  }
}

async function checksState(host: HostingTest): Promise<ReviewsState> {
  const state = await host.client.callAny('quirky.reviews/state', {})
  return state as ReviewsState
}

async function detailState(host: HostingTest): Promise<ReviewsState> {
  await host.client.callAny('quirky.reviews/open', { worktree: host.worktree, number: 12 })
  await host.client.callAny('quirky.reviews/detailRefresh', { surface: 'detail', worktree: host.worktree, number: 12 })
  const state = await host.client.callAny('quirky.reviews/state', {})
  return state as ReviewsState
}
function detailSurfaceFromChecks(state: ReviewsState): ReviewsState {
  const copy = structuredClone(state)
  const review = copy.checks.review
  const worktree = copy.checks.worktree
  if (review === null || worktree === null) throw new Error('Checks did not provide a review workspace for the detail surface.')
  copy.detail.target = { worktree, number: review.number, tab: 'conversation' }
  copy.detail.review = review
  copy.detail.loading = false
  copy.detail.error = null
  copy.detail.fetchedAt = Date.now()
  return copy
}

test('mounted Checks and detail controls honor Browser routing settings for normal and alternate clicks', async () => {
  const { host, ui, externalLog } = await bootUi(checksGhSource, { branch: 'feature' })
  host.writeState(checksFixtureState([checksReview(12), checksReview(7, 'stack-member')]))
  await host.call('checksLink', { worktree: host.worktree, number: 12 })
  await host.call('checksRefresh', { worktree: host.worktree, force: true })
  const checks = withStack(await checksState(host))
  const detail = detailSurfaceFromChecks(checks)
  const checksMount = mountChecks(ui, checks)
  const detailMount = mountDetail(ui, detail)
  await settleUi(ui)

  let routeIndex = 0
  const controls: ('checks-header' | 'checks-stack' | 'detail')[] = ['checks-header', 'checks-stack', 'detail']
  const combinations = [
    { openInApp: false, inversion: false },
    { openInApp: false, inversion: true },
    { openInApp: true, inversion: false },
    { openInApp: true, inversion: true }
  ]
  const priorPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: CHORD_PLATFORM === 'darwin' ? 'Win32' : 'MacIntel' })
  try {
    for (const combination of combinations) {
      await ui.setBrowserSetting('openLinksInApp', combination.openInApp)
      await ui.setBrowserSetting('openLinksInAppModifierInverts', combination.inversion)
      for (const surface of controls) {
        for (const alternate of [false, true]) {
          routeIndex += 1
          const number = surface === 'checks-stack' ? 7 : 12
          const url = `${PULL_REQUEST}${number}?fixture=matrix-${routeIndex}`
          if (surface === 'checks-header') checksMount.render(withChecksLink(checks, url))
          else if (surface === 'checks-stack') checksMount.render(withChecksLink(checks, checks.checks.review?.url ?? url, url))
          else detailMount.render(withDetailLink(detail, url))
          const surfaceMount = surface === 'detail' ? detailMount : checksMount
          const alternateDestination = combination.inversion ? !combination.openInApp : false
          const expectedApp = alternate ? alternateDestination : combination.openInApp
          await assertRoute(host, externalLog, ui, routeButton(surfaceMount, surface), url, host.worktree, expectedApp, eventModifiers(alternate))
        }
      }
      const openSetting = await host.client.callAny('setting.get', { id: APP_SETTING }) as { value: unknown }
      const inversionSetting = await host.client.callAny('setting.get', { id: INVERT_SETTING }) as { value: unknown }
      expect(openSetting.value).toBe(combination.openInApp)
      expect(inversionSetting.value).toBe(combination.inversion)
    }
  } finally {
    if (priorPlatform) Object.defineProperty(navigator, 'platform', priorPlatform)
    else Reflect.deleteProperty(navigator, 'platform')
  }
}, 90_000)

test('only Shift plus the CHORD_PLATFORM modifier selects the alternate route', async () => {
  const { host, ui, externalLog } = await bootUi(checksGhSource, { branch: 'feature' })
  host.writeState(checksFixtureState([checksReview(12), checksReview(7, 'stack-member')]))
  await host.call('checksLink', { worktree: host.worktree, number: 12 })
  await host.call('checksRefresh', { worktree: host.worktree, force: true })
  const checks = withStack(await checksState(host))
  const detail = detailSurfaceFromChecks(checks)
  const checksMount = mountChecks(ui, checks)
  const detailMount = mountDetail(ui, detail)
  await settleUi(ui)
  await ui.setBrowserSetting('openLinksInApp', true)
  await ui.setBrowserSetting('openLinksInAppModifierInverts', true)

  const priorPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: CHORD_PLATFORM === 'darwin' ? 'Win32' : 'MacIntel' })
  try {
    const decoys = [
      { surface: 'checks-header' as const, modifiers: { shiftKey: true, ctrlKey: true } },
      { surface: 'checks-stack' as const, modifiers: { shiftKey: true } },
      { surface: 'detail' as const, modifiers: { metaKey: true } }
    ]
    let index = 0
    for (const { surface, modifiers } of decoys) {
      index += 1
      const number = surface === 'checks-stack' ? 7 : 12
      const url = `${PULL_REQUEST}${number}?fixture=modifier-decoy-${index}`
      if (surface === 'checks-header') checksMount.render(withChecksLink(checks, url))
      else if (surface === 'checks-stack') checksMount.render(withChecksLink(checks, checks.checks.review?.url ?? url, url))
      else detailMount.render(withDetailLink(detail, url))
      await assertRoute(host, externalLog, ui, routeButton(surface === 'detail' ? detailMount : checksMount, surface), url, host.worktree, true, modifiers)
    }

    const keyboardUrl = `${PULL_REQUEST}12?fixture=keyboard-enter`
    detailMount.render(withDetailLink(detail, keyboardUrl))
    const keyboardButton = routeButton(detailMount, 'detail')
    await act(async () => {
      keyboardButton.focus()
      keyboardButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      keyboardButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
      await ui.flushCalls()
    })
    const panes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(panes.tabs.find((entry) => entry.url === keyboardUrl)).toMatchObject({ worktreeId: host.worktree, url: keyboardUrl })
    expect(externalOpens(externalLog)).not.toContainEqual({ target: keyboardUrl, reveal: false })
  } finally {
    if (priorPlatform) Object.defineProperty(navigator, 'platform', priorPlatform)
    else Reflect.deleteProperty(navigator, 'platform')
  }
}, 60_000)

test('mounted link hints follow public Browser settings without opening a destination', async () => {
  const { host, ui, externalLog } = await bootUi(checksGhSource, { branch: 'feature' })
  host.writeState(checksFixtureState([checksReview(12), checksReview(7, 'stack-member')]))
  await host.call('checksLink', { worktree: host.worktree, number: 12 })
  await host.call('checksRefresh', { worktree: host.worktree, force: true })
  const checks = withStack(await checksState(host))
  const detail = detailSurfaceFromChecks(checks)
  await ui.setBrowserSetting('openLinksInApp', true)
  await ui.setBrowserSetting('openLinksInAppModifierInverts', false)
  const beforePanes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
  const beforeExternal = externalOpens(externalLog)
  const checksMount = mountChecks(ui, checks)
  const detailMount = mountDetail(ui, detail)
  await settleUi(ui)

  const hintButtons = () => [
    routeButton(checksMount, 'checks-header'),
    routeButton(checksMount, 'checks-stack'),
    routeButton(detailMount, 'detail')
  ]
  for (const candidate of hintButtons()) {
    expect(candidate.title).toContain('Shift+Cmd-click')
    expect(candidate.title).toContain('Quirky Browser')
    expect(candidate.title).toContain('system browser')
  }
  const previousHints = hintButtons().map((candidate) => candidate.title)

  await ui.setBrowserSetting('openLinksInApp', false)
  await ui.setBrowserSetting('openLinksInAppModifierInverts', true)
  for (const [index, candidate] of hintButtons().entries()) {
    expect(candidate.title).not.toBe(previousHints[index])
    expect(candidate.title).toContain('system browser')
    expect(candidate.title).toContain('Quirky Browser')
    expect(candidate.title).toContain('Shift+Cmd-click')
  }
  const afterPanes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
  expect(afterPanes.tabs).toEqual(beforePanes.tabs)
  expect(externalOpens(externalLog)).toEqual(beforeExternal)
}, 30_000)

test('unavailable routing settings never promise a destination in mounted tooltips', async () => {
  const { host, ui } = await bootUi(checksGhSource, { branch: 'feature' })
  host.writeState(checksFixtureState([checksReview(12), checksReview(7, 'stack-member')]))
  await host.call('checksLink', { worktree: host.worktree, number: 12 })
  await host.call('checksRefresh', { worktree: host.worktree, force: true })
  const checks = withStack(await checksState(host))
  const detail = detailSurfaceFromChecks(checks)
  ui.forgetSetting(APP_SETTING)
  ui.forgetSetting(INVERT_SETTING)
  const checksMount = mountChecks(ui, checks)
  const detailMount = mountDetail(ui, detail)
  await settleUi(ui)

  for (const candidate of [
    routeButton(checksMount, 'checks-header'),
    routeButton(checksMount, 'checks-stack'),
    routeButton(detailMount, 'detail')
  ]) {
    expect(candidate.title).toContain('Shift+Cmd-click')
    expect(candidate.title).not.toContain('Quirky Browser')
    expect(candidate.title).not.toContain('system browser')
  }
}, 30_000)

test('a refused detail route remains visible and never falls back to the system browser', async () => {
  const { host, ui, externalLog } = await bootUi(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
  host.writeState(detailSeedState())
  const detail = await detailState(host)
  const missing = withDetailLink(detail, 'https://github.com/source-owner/source-repo/pull/12?fixture=missing-worktree', 'id:missing-review-worktree')
  const detailMount = mountDetail(ui, missing)
  await settleUi(ui)
  await ui.setBrowserSetting('openLinksInApp', true)
  await ui.setBrowserSetting('openLinksInAppModifierInverts', false)
  const previousExternal = externalOpens(externalLog)
  const previousPanes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
  const previousLayout = await host.client.call('ui.state', {})

  await act(async () => {
    routeButton(detailMount, 'detail').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await ui.flushCalls()
  })

  expect(ui.toasts).toContainEqual(expect.objectContaining({ title: 'Could not open pull request link' }))
  expect(ui.toasts.some((toast) => toast.body.trim() !== '')).toBe(true)
  expect(externalOpens(externalLog)).toEqual(previousExternal)
  const currentPanes = await host.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
  expect(currentPanes.tabs).toEqual(previousPanes.tabs)
  const currentLayout = await host.client.call('ui.state', {})
  expect(currentLayout).toEqual(previousLayout)
}, 30_000)
