import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { NativeBrowserOptions, NativeBrowserRequest, NativeBrowserState, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { PaneState, PaneTab } from '../src/pane-contract'
import { PANE_UI_CONTROL_COMMAND, browserPaneControlInstance, dispatchPaneUiControl } from '../src/ui-control'
import { dispatchPreferencesControl, PREFERENCES_CONTROL_COMMAND } from '../src/preferences-window/shared'
import { BrowserPaneWindow } from '../src/window/BrowserPaneWindow'

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let paneState: PaneState
let mounted: NativeBrowserOptions | null
const calls: { method: string; params?: Record<string, unknown> }[] = []
const requests: NativeBrowserRequest[] = []
const commandCalls: { id: string; args: unknown }[] = []
const logs: string[] = []
const provided = new Map<string, unknown>()
let executeCommandFailure: Error | null = null
let paneStateFailure: Error | null = null
let paneStateFailures = 0
let paneStateNeverResolves = false
let paneStateCalls = 0
let nativeMountFailure: Error | null = null
let nativeMountCalls = 0
let importHintHidden = true
let activate: (context: UiPluginContext) => void
let deactivate: () => void
let publicViewCleanups: (() => void)[] = []
let publicViewElements: HTMLElement[] = []

const PAGE_VIEW = 'view:quirky.browser/page'

const PREFERENCES_STATE = {
  profiles: [
    { profile: { id: 'default', label: 'Default', scope: 'default' as const }, active: true },
    { profile: { id: 'review', label: 'Review', scope: 'isolated' as const }, active: false }
  ],
  identity: { selected: 'clean' as const, active: 'clean' as const, restartRequired: false, nativeSupported: false as const },
  imports: { available: true as const, destination: 'managed-chrome' as const, nativeSupported: false as const, reason: 'Cookie imports are stored in managed Chrome, not Native.' },
  localhostLabels: { available: true as const, enabled: false, reason: 'Loopback links get worktree labels.', labels: [] }
}
const PANE = PANE_UI_CONTROL_COMMAND
const PREFS = PREFERENCES_CONTROL_COMMAND
const FAILED_URL = 'http://127.0.0.1:9/closed'
let profileSetError: string | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  // ReactDOM detects input-event support at module load, so establish the test DOM before importing it.
  ;({ createRoot } = await import('react-dom/client'))
  // ui imports ReactDOM and must load only after the test DOM registers.
  ;({ activate, deactivate } = await import('../src/ui'))
  
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  listeners = []
  calls.length = 0
  requests.length = 0
  commandCalls.length = 0
  logs.length = 0
  provided.clear()
  executeCommandFailure = null
  paneStateFailure = null
  paneStateFailures = 0
  paneStateNeverResolves = false
  paneStateCalls = 0
  nativeMountFailure = null
  nativeMountCalls = 0
  importHintHidden = true
  publicViewCleanups = []
  publicViewElements = []
  mounted = null
  paneState = stateOf(pane())
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => {
    for (const cleanup of publicViewCleanups) cleanup()
    publicViewCleanups = []
    await root?.unmount()
  })
  root = null
  for (const element of publicViewElements) element.remove()
  publicViewElements = []
  container.remove()
  deactivate()
})

function pane(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: 'pane-1',
    worktreeId: 'worktree-1',
    profileId: 'default',
    partition: 'persist:quirky-browser-default',
    mode: 'native',
    page: null,
    url: 'https://example.test/page',
    title: 'Example',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    zoom: 0,
    viewport: 'default',
    command: null,
    find: { text: '', current: 0, total: 0 },
    prompts: [],
    downloads: [],
    ...overrides
  }
}

function stateOf(...tabs: PaneTab[]): PaneState {
  return { tabs, active: tabs[0]?.id ?? null, history: [{ url: 'https://example.test/seen', title: 'Seen', visitedAt: 1 }] }
}

function nativeState(overrides: Partial<NativeBrowserState> = {}): NativeBrowserState {
  return {
    id: 'pane-1', url: 'https://example.test/page', title: 'Example', loading: false, canGoBack: false, canGoForward: false,
    zoom: 0, error: null, findCurrent: 0, findTotal: 0, hardReloadAvailable: false, ...overrides
  }
}

function makeContext(): UiPluginContext {
  let context: UiPluginContext
  context = {
    nativeBrowser: {
      available: true,
      clearPartitionAvailable: false,
      previewAvailable: false,
      mount: (_element, options) => {
        nativeMountCalls++
        if (nativeMountFailure) {
          const failure = nativeMountFailure
          nativeMountFailure = null
          throw failure
        }
        mounted = options
        return {
          request: async (request) => {
            requests.push(request)
            return nativeState({ hardReloadAvailable: true })
          },
          evaluate: async (script) => script.includes('return { installed: true, action }') ? { installed: true, action: null } : true,
          dispose: () => {}
        }
      },
      clearPartition: async () => { throw new Error('Native storage is unavailable in this DOM fixture.') },
      defaultUserAgent: async () => null
    },
    pluginId: 'quirky.browser',
    nativeDropPaths: async () => null,
    log: (message) => { logs.push(message) },
    readClipboardText: async () => '',
    provide: (id, implementation) => { provided.set(id, implementation) },
    call: async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) })
      if (method === 'quirky.browser/paneState') {
        paneStateCalls++
        if (paneStateNeverResolves) return await new Promise<PaneState>(() => {})
        if (paneStateFailures > 0) {
          paneStateFailures--
          throw paneStateFailure ?? new Error('Pane state offline')
        }
        return paneState
      }
      if (method === 'quirky.browser/preferencesState') return PREFERENCES_STATE
      if (method === 'quirky.browser/profileSet' && profileSetError) throw new Error(profileSetError)
      if (method === 'quirky.browser/identityGet') return { active: 'native' }
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
      return undefined
    },
    subscribe: (listener) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((current) => current !== listener) }
    },
    getSetting: (name) => name === 'setting:quirky.browser/browserImportHintHidden' ? importHintHidden : undefined,
    executeCommand: async (id, args) => {
      commandCalls.push({ id, args })
      if (executeCommandFailure) throw executeCommandFailure
      if (id === PANE) dispatchPaneUiControl(context, args)
      if (id === PREFS) dispatchPreferencesControl(context, args)
    },
    createCommandDrag: () => 'drag-token',
    consumeCommandDrag: () => null,
    cancelCommandDrag: () => {},
    openView: () => {},
    closeView: () => {},
    togglePanel: () => {},
    setPalette: () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => false,
    toast: () => {},
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
  return context
}

async function settleUI(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

async function mountWindow(options: { expectNativeMount?: boolean } = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={makeContext()} input={{ pane: 'pane-1' }} />)
    await settleUI()
  })
  if (options.expectNativeMount !== false && !mounted) throw new Error('the pane window did not mount its native view')
}

async function reportNative(state: NativeBrowserState): Promise<void> {
  await act(async () => {
    mounted?.onState(state)
    await settleUI()
  })
}

async function emitPaneChanged(next: PaneState): Promise<void> {
  paneState = next
  await act(async () => {
    const event = { type: 'quirky.browser/paneChanged', data: next } as QuirkyEvent
    for (const listener of [...listeners]) await listener(event)
    await settleUI()
  })
}

function detailsFor(summaryLabel: string, scope: ParentNode = container): HTMLDetailsElement {
  const summary = scope.querySelector(`summary[aria-label="${summaryLabel}"]`)
  const details = summary?.parentElement
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`no menu for ${summaryLabel}`)
  return details
}

function menuButton(label: string, scope: ParentNode = container): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.startsWith(label))
  if (!button) throw new Error(`no menu item ${label}`)
  return button
}

async function press(element: Element, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => {
    element.dispatchEvent(event)
    await settleUI()
  })
  return event
}


test('the Browser menu closes after a one-shot choice and returns focus to its trigger', async () => {
  await mountWindow()
  await reportNative(nativeState({ hardReloadAvailable: true }))
  const details = detailsFor('Browser menu')
  details.open = true
  await act(async () => { menuButton('Hard Reload').click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneControl', params: { pane: 'pane-1', action: 'hardReload' } })
  expect(commandCalls).toContainEqual({ id: PANE, args: { action: 'close-browser-menu', pane: 'pane-1' } })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(details.querySelector('summary'))
})

test('the Browser menu stays open for repeatable zoom steps', async () => {
  await mountWindow()
  const details = detailsFor('Browser menu')
  details.open = true
  await act(async () => { menuButton('Zoom In').click(); await settleUI() })
  expect(commandCalls).toEqual([])
  expect(details.open).toBe(true)
  await act(async () => { menuButton('Zoom Out').click(); await settleUI() })
  expect(details.open).toBe(true)
  await act(async () => { menuButton('Reset Zoom').click(); await settleUI() })
  expect(details.open).toBe(false)
})

test('choosing a history entry closes only the History popover through the pane command', async () => {
  await mountWindow()
  const browserMenu = detailsFor('Browser menu')
  const historyMenu = detailsFor('Browser history')
  browserMenu.open = true
  historyMenu.open = true
  await act(async () => { menuButton('Seen').click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: 'https://example.test/seen' } })
  expect(commandCalls).toEqual([{ id: PANE, args: { action: 'close-history-menu', pane: 'pane-1' } }])
  expect(historyMenu.open).toBe(false)
  expect(browserMenu.open).toBe(true)
})

test('Escape closes either popover through its pane command and focuses its trigger', async () => {
  await mountWindow()
  for (const [label, action] of [['Browser menu', 'close-browser-menu'], ['Browser history', 'close-history-menu']] as const) {
    const details = detailsFor(label)
    details.open = true
    const event = await press(menuButton(label === 'Browser menu' ? 'Zoom In' : 'Seen'), 'Escape')
    expect(event.defaultPrevented).toBe(true)
    expect(commandCalls).toContainEqual({ id: PANE, args: { action, pane: 'pane-1' } })
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(details.querySelector('summary'))
  }
})

test('a press outside an open popover closes it', async () => {
  await mountWindow()
  const details = detailsFor('Browser history')
  details.open = true
  await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await settleUI() })
  expect(details.open).toBe(false)
})

test('popovers override the menu list min-width: 100% so they cannot outgrow the toolbar', async () => {
  await mountWindow()
  for (const label of ['Browser menu', 'Browser history']) {
    const popover = detailsFor(label).querySelector<HTMLElement>(':scope > .ui-menu__list')
    expect(['0', '0px']).toContain(popover?.style.minWidth ?? '')
  }
})

async function pickProfile(label: string): Promise<HTMLDetailsElement> {
  await mountWindow()
  const details = detailsFor('Browser menu')
  details.open = true
  const radio = container.querySelector<HTMLInputElement>(`input[aria-label="Use ${label} profile"]`)
  if (!radio) throw new Error(`no ${label} profile choice`)
  await act(async () => { radio.closest('label')!.click(); await settleUI() })
  return details
}

test('the Browser menu closes after a profile is picked', async () => {
  profileSetError = null
  const details = await pickProfile('Review')
  expect(calls).toContainEqual({ method: 'quirky.browser/profileSet', params: { pane: 'pane-1', profile: 'review' } })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(details.querySelector('summary'))
})

test('a failed profile switch is reported outside the closed Browser menu', async () => {
  profileSetError = 'The browser for that profile could not be started.'
  try {
    const details = await pickProfile('Review')
    expect(details.open).toBe(false)
    const alerts = [...container.querySelectorAll('[role="alert"]')].filter((node) => node.textContent?.includes('could not be started'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.classList.contains('ui-inline-error')).toBe(true)
    expect(details.contains(alerts[0]!)).toBe(false)
    const dismiss = alerts[0]?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
    if (!dismiss) throw new Error('the profile-switch error has no Dismiss button')
    await act(async () => { dismiss.click(); await settleUI() })
    expect(commandCalls).toContainEqual({ id: PANE, args: { action: 'dismiss-message', pane: 'pane-1' } })
    expect(container.querySelector('.ui-inline-error')).toBeNull()
  } finally {
    profileSetError = null
  }
})

test('a failed menu-close command is logged and still closes the menu', async () => {
  executeCommandFailure = new Error(`No command: ${PANE}`)
  await mountWindow()
  await reportNative(nativeState({ hardReloadAvailable: true }))
  const details = detailsFor('Browser menu')
  details.open = true
  await act(async () => { menuButton('Hard Reload').click(); await settleUI() })
  expect(logs).toContain(`browser: menu close failed: No command: ${PANE}`)
  expect(details.open).toBe(false)
})

test('pane state loading shows a NoticeLine while the first state request is pending', async () => {
  paneStateNeverResolves = true
  await mountWindow({ expectNativeMount: false })
  const status = container.querySelector('[role="status"] .ui-notice-line')
  expect(status?.textContent).toBe('Loading browser pane…')
})

test('pane state failure can be retried after the first request rejects', async () => {
  paneStateFailure = new Error('Pane state offline')
  paneStateFailures = 1
  await mountWindow({ expectNativeMount: false })
  const error = container.querySelector('.ui-inline-error')
  expect(error?.textContent).toContain('Pane state offline')
  const retry = error?.querySelector<HTMLButtonElement>('button')
  if (!retry) throw new Error('the pane-state error has no Retry button')
  await act(async () => { retry.click(); await settleUI() })
  expect(paneStateCalls).toBe(2)
  expect([...container.querySelectorAll('.ui-inline-error')].map(node => node.textContent)).toEqual([])
})

test('a closed pane shows the empty state instead of an error', async () => {
  paneState = { tabs: [], active: null, history: [] }
  await mountWindow({ expectNativeMount: false })
  expect([...container.querySelectorAll('.ui-empty-state')].some(node => node.textContent?.includes('This browser tab is no longer open.'))).toBe(true)
  expect(container.querySelector('.ui-inline-error')).toBeNull()
})

test('a native page error is dismissible through the pane command', async () => {
  await mountWindow()
  await reportNative(nativeState({ error: 'net::ERR_NAME_NOT_RESOLVED' }))
  const card = container.querySelector('[aria-label="Page could not load"]')
  expect(card?.querySelector('.ui-inline-error')?.textContent).toContain('net::ERR_NAME_NOT_RESOLVED')
  const dismiss = card?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
  if (!dismiss) throw new Error('the native page error has no Dismiss button')
  await act(async () => { dismiss.click(); await settleUI() })
  expect(commandCalls).toContainEqual({ id: PANE, args: { action: 'dismiss-page-error', pane: 'pane-1' } })
  expect(container.querySelector('[aria-label="Page could not load"]')).toBeNull()
})

test('a failed native mount can be retried through the pane command', async () => {
  nativeMountFailure = new Error('Native view refused')
  await mountWindow({ expectNativeMount: false })
  const card = container.querySelector('[aria-label="Native browser could not start"]')
  expect(card?.querySelector('.ui-inline-error')?.textContent).toContain('Native view refused')
  const retry = [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.includes('Retry Native Browser'))
  if (!retry) throw new Error('the native-browser error has no Retry Native Browser button')
  await act(async () => { retry.click(); await settleUI() })
  expect(commandCalls).toContainEqual({ id: PANE, args: { action: 'retry-native', pane: 'pane-1' } })
  expect(nativeMountCalls).toBe(2)
  expect(container.querySelector('[aria-label="Native browser could not start"]')).toBeNull()
})

test('a download error uses InlineError and dismisses through paneDownload', async () => {
  const download = {
    id: 'd1',
    name: 'a.zip',
    state: 'interrupted',
    received: 0,
    error: 'Disk full'
  } as unknown as PaneTab['downloads'][number]
  paneState = stateOf(pane({ downloads: [download] }))
  await mountWindow()
  expect(container.querySelector('.qbp-shelf .ui-inline-error')?.textContent).toContain('Disk full')
  const row = container.querySelector('[data-download="d1"]')
  const dismiss = row?.querySelector<HTMLButtonElement>('button')
  if (!dismiss) throw new Error('the failed download has no Dismiss button')
  await act(async () => { dismiss.click(); await settleUI() })
  expect(calls).toContainEqual({
    method: 'quirky.browser/paneDownload',
    params: { pane: 'pane-1', download: 'd1', action: 'dismiss' }
  })
})

test('public pane and preference commands address only their mounted pane targets', async () => {
  importHintHidden = false
  paneState = stateOf(pane(), pane({ id: 'pane-2' }))
  const context = makeContext()
  activate(context)
  const publicState = await context.call('quirky.browser/paneState', {}) as PaneState
  const [pane1, pane2] = publicState.tabs.map((tab) => tab.id)
  if (!pane1 || !pane2) throw new Error('paneState did not provide both pane ids')

  const pageView = provided.get(PAGE_VIEW)
  if (typeof pageView !== 'function') throw new Error('the Browser page view was not provided')
  const mountPage = pageView as (element: HTMLElement, props: { input?: unknown }) => () => void
  const pane1Element = document.createElement('div')
  const pane2Element = document.createElement('div')
  publicViewElements.push(pane1Element, pane2Element)
  document.body.append(pane1Element, pane2Element)
  let unmountPane1!: () => void
  let unmountPane2!: () => void
  await act(async () => {
    unmountPane1 = mountPage(pane1Element, { input: { pane: pane1 } })
    unmountPane2 = mountPage(pane2Element, { input: { pane: pane2 } })
    await settleUI()
  })
  publicViewCleanups.push(unmountPane1, unmountPane2)

  const run = provided.get(PANE)
  const prefs = provided.get(PREFS)
  if (typeof run !== 'function') throw new Error('the pane UI command was not provided')
  if (typeof prefs !== 'function') throw new Error('the preferences control command was not provided')

  let result: unknown
  await act(async () => {
    result = await run({ action: 'open-find', pane: pane2 })
    await settleUI()
  })
  expect(result).toEqual({ pane: pane2, action: 'open-find', delivered: 1 })
  expect(pane2Element.querySelector('[role="search"]')).not.toBeNull()
  expect(pane1Element.querySelector('[role="search"]')).toBeNull()

  const browserMenu1 = detailsFor('Browser menu', pane1Element)
  const browserMenu2 = detailsFor('Browser menu', pane2Element)
  browserMenu1.open = true
  browserMenu2.open = true
  await act(async () => {
    result = await run({ action: 'close-browser-menu', pane: pane1 })
    await settleUI()
  })
  expect(result).toEqual({ pane: pane1, action: 'close-browser-menu', delivered: 1 })
  expect(browserMenu1.open).toBe(false)
  expect(browserMenu2.open).toBe(true)

  await act(async () => {
    result = await prefs({
      action: 'toggle-import-hint',
      instance: browserPaneControlInstance(pane2, 'import-hint')
    })
    await settleUI()
  })
  expect(result).toEqual({
    instance: `browser-pane:${pane2}:import-hint`,
    action: 'toggle-import-hint',
    delivered: 1
  })
  const hint1 = pane1Element.querySelector('[aria-label="Import browser data hint"] button[aria-expanded]')
  const hint2 = pane2Element.querySelector<HTMLButtonElement>('[aria-label="Import browser data hint"] button[aria-expanded]')
  expect(hint1?.getAttribute('aria-expanded')).toBe('false')
  expect(hint2?.getAttribute('aria-expanded')).toBe('true')

  await act(async () => {
    result = await run({ action: 'open-find', pane: 'pane-9' })
    await settleUI()
  })
  expect(result).toEqual({ pane: 'pane-9', action: 'open-find', delivered: 0 })
  await act(async () => {
    result = await prefs({ action: 'toggle-profile-menu', instance: browserPaneControlInstance('pane-9', 'profile-menu') })
    await settleUI()
  })
  expect(result).toEqual({ instance: 'browser-pane:pane-9:profile-menu', action: 'toggle-profile-menu', delivered: 0 })

  await act(async () => {
    unmountPane2()
    await settleUI()
  })
  publicViewCleanups = publicViewCleanups.filter((cleanup) => cleanup !== unmountPane2)
  await act(async () => {
    result = await run({ action: 'open-find', pane: pane2 })
    await settleUI()
  })
  expect(result).toEqual({ pane: pane2, action: 'open-find', delivered: 0 })
  expect(pane1Element.querySelector('[role="search"]')).toBeNull()
})

test('an informational message dismisses through the pane command', async () => {
  await mountWindow()
  await act(async () => {
    mounted?.onPopup('https://example.test/popup', true)
    await settleUI()
  })
  const message = container.querySelector('[role="status"].qbp-message')
  expect(message?.textContent).toContain('A native popup was observed')
  const dismiss = message?.querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')
  if (!dismiss) throw new Error('the informational message has no dismiss button')
  await act(async () => { dismiss.click(); await settleUI() })
  expect(commandCalls).toContainEqual({ id: PANE, args: { action: 'dismiss-message', pane: 'pane-1' } })
  expect(container.querySelector('[role="status"].qbp-message')).toBeNull()
})
