import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { BrowserProfile } from '../src/profiles/store'
import type { BrowserPreferencesProps, PreferencesState } from '../src/preferences/contract'
import { BrowserImportHint, BrowserProfileMenu } from '../src/preferences-window/BrowserProfileMenu'
import { BrowserSettings } from '../src/preferences-window/BrowserSettings'

const DEFAULT_PROFILE: BrowserProfile = { id: 'default', label: 'Default', scope: 'default' }
const REVIEW_PROFILE_ID = 'profile_0123456789abcdef0123456789abcdef'
const REVIEW_PROFILE: BrowserProfile = { id: REVIEW_PROFILE_ID, label: 'Review', scope: 'isolated' }
const settingIds = {
  homePage: 'setting:quirky.browser/defaultHomePage',
  searchEngine: 'setting:quirky.browser/defaultSearchEngine',
  zoom: 'setting:quirky.browser/defaultZoom',
  identity: 'setting:quirky.browser/identityMode',
  routeInApp: 'setting:quirky.browser/openLinksInApp',
  invertModifier: 'setting:quirky.browser/openLinksInAppModifierInverts',
  importHintHidden: 'setting:quirky.browser/browserImportHintHidden',
  agentBrowser: 'setting:quirky.browser/agentBrowserUseEnabled',
  terminalClick: 'setting:quirky.terminal/link-click',
  terminalMiddleClick: 'setting:quirky.terminal/link-middle-click'
} as const

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let calls: { method: string; params?: Record<string, unknown> }[]
let commands: string[]
let errors: string[]
let state: PreferencesState
let settings: Record<string, unknown>
let confirmResult: boolean
let profileSetHandler: (() => Promise<void>) | null
let settingFailure: Error | null

beforeAll(async () => {
  GlobalRegistrator.register()
  // ReactDOM detects input-event support at module load; establish the test DOM first.
  ;({ createRoot } = await import('react-dom/client'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  listeners = []
  calls = []
  commands = []
  errors = []
  settingFailure = null
  profileSetHandler = null
  state = {
    profiles: [{ profile: DEFAULT_PROFILE, active: true }],
    identity: { selected: 'clean', active: 'clean', restartRequired: false, nativeSupported: false },
    imports: { available: false, reason: 'The browser cookie import engine is not installed.' },
    localhostLabels: { available: false, reason: 'A reachable worktree host mapping is not configured.' }
  }
  settings = {
    [settingIds.homePage]: '',
    [settingIds.searchEngine]: 'google',
    [settingIds.zoom]: 0,
    [settingIds.identity]: 'clean',
    [settingIds.routeInApp]: false,
    [settingIds.invertModifier]: false,
    [settingIds.importHintHidden]: false,
    [settingIds.agentBrowser]: false,
    [settingIds.terminalClick]: 'actions',
    [settingIds.terminalMiddleClick]: 'open'
  }
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

function makeContext(): UiPluginContext {
  const context: UiPluginContext = {
    pluginId: 'quirky.browser',
    log: () => {},
    provide: () => {},
    call: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params })
      if (method === 'quirky.browser/preferencesState') return structuredClone(state)
      if (method === 'quirky.browser/profileCreate') {
        const name = String(params?.name ?? '').trim()
        if (state.profiles.some(({ profile }) => profile.label.toLowerCase() === name.toLowerCase())) throw new Error('A profile with that name already exists.')
        const profile = { id: REVIEW_PROFILE_ID, label: name, scope: 'isolated' as const }
        state = { ...state, profiles: [...state.profiles, { profile, active: false }] }
        return { profile }
      }
      if (method === 'quirky.browser/profileSet') {
        await profileSetHandler?.()
        return { pane: { id: params?.pane, profileId: params?.profile } }
      }
      if (method === 'quirky.browser/profileClear') throw new Error('Native partition clearing is unavailable in this runtime.')
      if (method === 'quirky.browser/profileDelete') throw new Error('Native partition clearing is unavailable in this runtime.')
      if (method === 'setting.set') {
        if (settingFailure) throw settingFailure
        const id = String(params?.id ?? '')
        settings[id] = params?.value
        const value = params?.value
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
          for (const listener of listeners) await listener({ type: 'setting.changed', id, value })
        }
        return { id, value }
      }
      return undefined
    },
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((current) => current !== listener) }
    },
    getSetting: (name: string) => settings[name],
    executeCommand: async (id: string) => { commands.push(id) },
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
    confirm: async () => confirmResult,
    toast: () => {},
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
  return context
}

function pane(): NonNullable<BrowserPreferencesProps['pane']> {
  return {
    id: 'pane-1', worktreeId: '/worktree', profileId: 'default', partition: 'persist:quirky-browser-default', mode: 'native', page: null, url: 'https://example.test/', title: 'Example',
    loading: false, error: null, canGoBack: false, canGoForward: false, zoom: 0, viewport: 'default', command: null,
    find: { text: '', current: 0, total: 0 }, prompts: [], downloads: []
  }
}


async function mount(element: ReactNode): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(element)
    await settleUI()
  })
}

async function settleUI(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  return act(async () => {
    button.click()
    await settleUI()
  })
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  return act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    await settleUI()
  })
}

function props(context: UiPluginContext, currentPane?: BrowserPreferencesProps['pane']): BrowserPreferencesProps {
  return { context, pane: currentPane, onError: (message) => errors.push(message) }
}

test('profile menu marks the pane profile and switches only after the profile API succeeds', async () => {
  state = { ...state, profiles: [{ profile: DEFAULT_PROFILE, active: true }, { profile: REVIEW_PROFILE, active: false }] }
  const context = makeContext()
  await mount(<BrowserProfileMenu {...props(context, pane())} />)
  await clickButton('Profile: Default')

  const defaultRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Default profile"]')
  const reviewRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')
  expect(defaultRadio?.checked).toBe(true)
  expect(reviewRadio?.checked).toBe(false)

  await act(async () => { reviewRadio?.click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/profileSet', params: { pane: 'pane-1', profile: REVIEW_PROFILE_ID } })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')?.checked).toBe(true)
  expect(errors).toEqual([])
})
test('profile switching prevents overlapping requests while the selected profile is pending', async () => {
  state = { ...state, profiles: [{ profile: DEFAULT_PROFILE, active: true }, { profile: REVIEW_PROFILE, active: false }] }
  const switchGate = Promise.withResolvers<void>()
  profileSetHandler = () => switchGate.promise
  const context = makeContext()
  await mount(<BrowserProfileMenu {...props(context, pane())} />)
  await clickButton('Profile: Default')
  const defaultRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Default profile"]')
  const reviewRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')
  if (!defaultRadio || !reviewRadio) throw new Error('Missing profile selection controls')

  await act(async () => { reviewRadio.click(); await settleUI() })
  await act(async () => {
    root?.render(<BrowserProfileMenu {...props(context, { ...pane(), title: 'Fresh page telemetry' })} />)
    await settleUI()
  })
  expect(defaultRadio.disabled).toBe(true)
  expect(reviewRadio.disabled).toBe(true)
  expect(calls.filter(({ method }) => method === 'quirky.browser/profileSet')).toHaveLength(1)
  expect(defaultRadio.checked).toBe(true)
  expect(reviewRadio.checked).toBe(false)

  await act(async () => { defaultRadio.click(); await settleUI() })
  expect(calls.filter(({ method }) => method === 'quirky.browser/profileSet')).toHaveLength(1)

  await act(async () => { switchGate.resolve(); await settleUI() })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Use Default profile"]')?.checked).toBe(false)
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')?.checked).toBe(true)
})

test('failed profile switching clears pending state without changing the checkmark', async () => {
  state = { ...state, profiles: [{ profile: DEFAULT_PROFILE, active: true }, { profile: REVIEW_PROFILE, active: false }] }
  profileSetHandler = async () => { throw new Error('Profile switch failed.') }
  const context = makeContext()
  await mount(<BrowserProfileMenu {...props(context, pane())} />)
  await clickButton('Profile: Default')
  const defaultRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Default profile"]')
  const reviewRadio = container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')
  if (!defaultRadio || !reviewRadio) throw new Error('Missing profile selection controls')

  await act(async () => { reviewRadio.click(); await settleUI() })

  expect(defaultRadio.checked).toBe(true)
  expect(reviewRadio.checked).toBe(false)
  expect(defaultRadio.disabled).toBe(false)
  expect(reviewRadio.disabled).toBe(false)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Profile switch failed.')
  expect(errors).toEqual(['Profile switch failed.'])
})
test('creating a profile refreshes the menu with the persisted profile row', async () => {
  const context = makeContext()
  await mount(<BrowserProfileMenu {...props(context, pane())} />)
  await clickButton('Profile: Default')
  await clickButton('New Profile')
  const name = container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')
  if (!name) throw new Error('Missing profile name field')
  await changeValue(name, 'Review')
  await clickButton('Create Profile')

  expect(container.querySelector('[role="dialog"][aria-label="New Browser Profile"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Use Review profile"]')).not.toBeNull()
  expect(container.textContent).toContain('Profile "Review" created.')
  expect(calls.filter(({ method }) => method === 'quirky.browser/preferencesState')).toHaveLength(2)
})


test('failed duplicate profile submission keeps the labelled dialog open with an actionable error', async () => {
  state = { ...state, profiles: [{ profile: DEFAULT_PROFILE, active: true }, { profile: REVIEW_PROFILE, active: false }] }
  const context = makeContext()
  await mount(<BrowserProfileMenu {...props(context, pane())} />)
  await clickButton('Profile: Default')
  await clickButton('New Profile')
  const name = container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')
  if (!name) throw new Error('Missing profile name field')
  await clickButton('Create Profile')
  expect(container.querySelector('[role="dialog"][aria-label="New Browser Profile"]')).not.toBeNull()
  expect(container.textContent).toContain('Enter a profile name before creating it.')
  expect(calls.filter(({ method }) => method === 'quirky.browser/profileCreate')).toHaveLength(0)

  await changeValue(name, 'Review')
  await clickButton('Create Profile')
  expect(container.querySelector('[role="dialog"][aria-label="New Browser Profile"]')).not.toBeNull()
  expect(container.textContent).toContain('A profile with that name already exists.')
  expect(calls.filter(({ method }) => method === 'quirky.browser/profileCreate')).toHaveLength(1)
})


test('browser settings save search and terminal routing defaults through setting.set', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const searchEngine = container.querySelector<HTMLSelectElement>('select[aria-label="Default search engine"]')
  const terminalClick = container.querySelector<HTMLSelectElement>('select[aria-label="Terminal URL clicks"]')
  if (!searchEngine || !terminalClick) throw new Error('Missing browser settings controls')

  await changeValue(searchEngine, 'duckduckgo')
  await changeValue(terminalClick, 'terminal')

  expect(searchEngine.value).toBe('duckduckgo')
  expect(terminalClick.value).toBe('terminal')
  expect(calls.filter(({ method }) => method === 'setting.set').map(({ params }) => params?.id)).toEqual([
    settingIds.searchEngine, settingIds.terminalClick
  ])
})

test('default zoom shows percentage labels and persists half-step levels', async () => {
  delete settings[settingIds.zoom]
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const zoom = container.querySelector<HTMLSelectElement>('select[aria-label="Default zoom"]')
  if (!zoom) throw new Error('Missing default zoom selector')
  expect(zoom.value).toBe('0')

  expect([...zoom.options].find(({ value }) => value === '-3')?.textContent).toBe('58%')
  expect([...zoom.options].find(({ value }) => value === '5')?.textContent).toBe('249%')

  await changeValue(zoom, '1.5')

  expect(zoom.value).toBe('1.5')
  expect(zoom.selectedOptions[0]?.textContent).toBe('131%')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.zoom, value: 1.5 } })
})

test('home page edits remain drafts until saved and external changes do not replace a draft', async () => {
  settings[settingIds.homePage] = 'https://existing.example.test'
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const homePage = container.querySelector<HTMLInputElement>('input[aria-label="Default home page"]')
  if (!homePage) throw new Error('Missing browser home page field')

  await act(async () => {
    settings[settingIds.homePage] = 'https://remote.example.test'
    for (const listener of listeners) await listener({ type: 'setting.changed', id: settingIds.homePage, value: settings[settingIds.homePage] })
    await settleUI()
  })
  expect(homePage.value).toBe('https://remote.example.test')

  await changeValue(homePage, 'https://start.example.test')
  expect(settings[settingIds.homePage]).toBe('https://remote.example.test')
  expect(homePage.disabled).toBe(false)
  expect(calls.filter(({ method, params }) => method === 'setting.set' && params?.id === settingIds.homePage)).toHaveLength(0)

  await act(async () => {
    settings[settingIds.homePage] = 'https://later.example.test'
    for (const listener of listeners) await listener({ type: 'setting.changed', id: settingIds.homePage, value: settings[settingIds.homePage] })
    await settleUI()
  })
  expect(homePage.value).toBe('https://start.example.test')

  await clickButton('Save')
  expect(settings[settingIds.homePage]).toBe('https://start.example.test')
  expect(homePage.value).toBe('https://start.example.test')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.homePage, value: 'https://start.example.test' } })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Default home page saved.')
})
test('pressing Enter saves the home page draft', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const homePage = container.querySelector<HTMLInputElement>('input[aria-label="Default home page"]')
  if (!homePage) throw new Error('Missing browser home page field')

  await changeValue(homePage, 'https://enter.example.test')
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    homePage.dispatchEvent(event)
    await settleUI()
    expect(event.defaultPrevented).toBe(true)
  })

  expect(settings[settingIds.homePage]).toBe('https://enter.example.test')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.homePage, value: 'https://enter.example.test' } })
})

test('failed home page save keeps the editable draft and shows the error', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const homePage = container.querySelector<HTMLInputElement>('input[aria-label="Default home page"]')
  if (!homePage) throw new Error('Missing browser home page field')
  settingFailure = new Error('Settings are unavailable.')

  await changeValue(homePage, 'https://draft.example.test')
  await clickButton('Save')

  expect(settings[settingIds.homePage]).toBe('')
  expect(homePage.value).toBe('https://draft.example.test')
  expect(homePage.disabled).toBe(false)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Settings are unavailable.')
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(errors).toEqual(['Settings are unavailable.'])
})

test('saving a blank home page keeps new-tab behavior', async () => {
  settings[settingIds.homePage] = 'https://start.example.test'
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const homePage = container.querySelector<HTMLInputElement>('input[aria-label="Default home page"]')
  if (!homePage) throw new Error('Missing browser home page field')

  await changeValue(homePage, '')
  await clickButton('Save')

  expect(settings[settingIds.homePage]).toBe('')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.homePage, value: '' } })
})

test('selecting Native identity reports selected, active, and restart-required state', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)
  const identity = container.querySelector<HTMLSelectElement>('select[aria-label="Owned Chrome identity"]')
  if (!identity) throw new Error('Missing owned Chrome identity selector')

  await changeValue(identity, 'native')

  expect(identity.value).toBe('native')
  const status = container.querySelector('[aria-live="polite"]')
  expect(status?.textContent).toContain('Restart required:')
  expect(status?.textContent).toContain('Cleaned identity is active now')
  expect(status?.textContent).toContain('Native will apply')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.identity, value: 'native' } })
  expect(container.textContent).toContain('System webview identity cannot be changed')
})

test('Agent Browser guidance and Shift inversion react to persisted settings', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)

  const agentBrowser = container.querySelector<HTMLInputElement>('input[aria-label="Use Agent Browser"]')
  const invertModifier = container.querySelector<HTMLInputElement>('input[aria-label="Invert link routing modifier"]')
  const linkRouting = container.querySelector<HTMLInputElement>('input[aria-label="Open links in Quirky"]')
  if (!agentBrowser || !invertModifier || !linkRouting) throw new Error('Missing Browser usage and routing controls')
  expect(container.textContent).toContain('Link Routing is Off.')

  await act(async () => { agentBrowser.click(); await settleUI() })
  expect(container.textContent).toContain('Agent Browser setup checklist')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.agentBrowser, value: true } })

  await act(async () => { invertModifier.click(); await settleUI() })
  expect(container.textContent).toContain('Shift+modifier-click switches the configured route to Quirky.')
  await act(async () => { linkRouting.click(); await settleUI() })
  expect(container.textContent).toContain('Link Routing is On.')
  expect(container.textContent).toContain('Shift+modifier-click switches the configured route to the system browser.')
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.invertModifier, value: true } })
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.routeInApp, value: true } })
})

test('import affordances explain unavailable cookies, exclude Google logins, open settings, and persist hiding the hint', async () => {
  const context = makeContext()
  await mount(<><BrowserProfileMenu {...props(context, pane())} /><BrowserImportHint {...props(context)} /></>)

  await clickButton('Profile: Default')
  await clickButton('Import Cookies')
  expect(container.textContent).toContain('The browser cookie import engine is not installed.')
  expect(container.textContent).toContain('Google logins are not imported')
  expect(container.textContent).toContain('Sign in to Google directly in Quirky')

  await clickButton('Import Cookies')
  await clickButton('Import browser data')
  expect(container.textContent).toContain('The browser cookie import engine is not installed.')
  expect(container.textContent).toContain('Google logins are not imported')
  expect(container.textContent).toContain('Sign in to Google directly in Quirky')
  await clickButton('Browser Settings')
  expect(commands).toEqual(['command:quirky.browser/browserSettings'])
  await clickButton('Hide Hint')
  expect(container.querySelector('[aria-label="Import browser data hint"]')).toBeNull()
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.importHintHidden, value: true } })
  await act(async () => { root?.unmount() })
  root = null
  await mount(<BrowserSettings {...props(context)} />)
  const showHint = container.querySelector<HTMLInputElement>('input[aria-label="Show import browser data hint"]')
  expect(showHint?.checked).toBe(false)
  await act(async () => { showHint?.click(); await settleUI() })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Show import browser data hint"]')?.checked).toBe(true)
  expect(calls).toContainEqual({ method: 'setting.set', params: { id: settingIds.importHintHidden, value: false } })
  await act(async () => { root?.unmount() })
  root = null
  await mount(<BrowserImportHint {...props(context)} />)
  expect(container.querySelector('[aria-label="Import browser data hint"]')).not.toBeNull()
})

test('Session & Cookies reports unsupported native clearing without claiming data removal', async () => {
  state = { ...state, profiles: [{ profile: DEFAULT_PROFILE, active: true }, { profile: REVIEW_PROFILE, active: false }] }
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} />)

  expect(container.textContent).toContain('Active')
  expect(container.textContent).toContain('native session-clear completion capability')
  confirmResult = false
  await clickButton('Clear cookies & site data')
  expect(calls.filter(({ method }) => method === 'quirky.browser/profileClear')).toHaveLength(0)

  confirmResult = true
  await clickButton('Clear cookies & site data')
  expect(calls).toContainEqual({ method: 'quirky.browser/profileClear', params: { profile: 'default', yes: true } })
  expect(container.textContent).toContain('Native partition clearing is unavailable in this runtime.')

  await clickButton('Remove')
  expect(calls).toContainEqual({ method: 'quirky.browser/profileDelete', params: { profile: REVIEW_PROFILE_ID, yes: true } })
  expect(container.textContent).toContain('Review')
  expect(container.textContent).toContain('Native partition clearing is unavailable in this runtime.')
})

test('embedded settings subscribe to shared setting changes without duplicating generic controls and clean up listeners', async () => {
  const context = makeContext()
  await mount(<BrowserSettings {...props(context)} embedded />)

  expect(container.querySelector('input[aria-label="Default home page"]')).toBeNull()
  expect(container.querySelector('select[aria-label="Owned Chrome identity"]')).toBeNull()
  expect(container.querySelector('input[aria-label="Open links in Quirky"]')).toBeNull()
  expect(container.querySelector('input[aria-label="Show import browser data hint"]')).toBeNull()
  expect(container.querySelector('input[aria-label="Use Agent Browser"]')).toBeNull()
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Save')).toBe(false)

  await act(async () => {
    settings[settingIds.agentBrowser] = true
    for (const listener of listeners) await listener({ type: 'setting.changed', id: settingIds.agentBrowser, value: true })
    await settleUI()
  })
  expect(container.textContent).toContain('Agent Browser setup checklist')

  await act(async () => { root?.unmount() })
  root = null
  expect(listeners).toHaveLength(0)
})
