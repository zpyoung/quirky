import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DARK_THEME, DEFAULT_THEME, LIGHT_THEME, THEME_TOKENS, type ThemeInfo, type UiModel } from '@quirky/protocol'
import { AppContext, type AppContextValue } from '../../src/context'
import type { HostState, WindowPluginHost } from '../../src/plugins/host'
import { useThemeVariables } from '../../src/plugins/useThemeVariables'

const DARK_QUERY = '(prefers-color-scheme: dark)'
type TestMediaQuery = MediaQueryList & {
  setMatches(matches: boolean): void
  listenerCount(): number
  readonly addCount: number
  readonly removeCount: number
}
type Listener = EventListenerOrEventListenerObject

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLElement | null = null
let originalMatchMedia: PropertyDescriptor | undefined

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ReactDOM captures the test DOM at initialization, so load it only after happy-dom is registered.
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(() => GlobalRegistrator.unregister())

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.cssText = ''
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
  originalMatchMedia = undefined
})

function mediaQuery(matches: boolean): TestMediaQuery {
  let current = matches
  let added = 0
  let removed = 0
  const listeners = new Set<Listener>()
  const query = {
    media: DARK_QUERY,
    onchange: null,
    get matches() {
      return current
    },
    get addCount() {
      return added
    },
    get removeCount() {
      return removed
    },
    addEventListener(type: string, listener: Listener | null) {
      if (type === 'change' && listener) {
        added += 1
        listeners.add(listener)
      }
    },
    removeEventListener(type: string, listener: Listener | null) {
      if (type === 'change' && listener && listeners.delete(listener)) removed += 1
    },
    listenerCount() {
      return listeners.size
    },
    setMatches(next: boolean) {
      current = next
      const event = { matches: current, media: DARK_QUERY } as MediaQueryListEvent
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    }
  }
  return query as TestMediaQuery
}

function installMedia(matches: boolean): TestMediaQuery {
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  const query = mediaQuery(matches)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => query })
  return query
}

function model(active: string, chosen = active, extra?: ThemeInfo): UiModel {
  return {
    themes: [DEFAULT_THEME, DARK_THEME, LIGHT_THEME, ...(extra ? [extra] : [])],
    theme: { chosen, active },
    modules: {}
  } as UiModel
}

function variables(theme: ThemeInfo): Record<string, string> {
  return Object.fromEntries(THEME_TOKENS.map((token) => [`--${token}`, theme.colors[token]]))
}

function Harness() {
  useThemeVariables()
  return null
}

async function mount(themeModel: UiModel, themeVariables: Record<string, string>) {
  let current = { model: themeModel, themeVariables } as HostState
  const listeners = new Set<() => void>()
  const plugins = {
    getState: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as WindowPluginHost
  const value = { store: {}, connection: {}, plugins } as unknown as AppContextValue
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AppContext.Provider, { value }, createElement(Harness)))
  })
  return {
    async update(nextModel: UiModel, nextVariables: Record<string, string>) {
      current = { ...current, model: nextModel, themeVariables: nextVariables }
      await act(async () => {
        for (const listener of listeners) listener()
      })
    },
    async unmount() {
      if (root) await act(async () => root?.unmount())
      root = null
      container?.remove()
      container = null
    }
  }
}

test('the follow-system theme applies the local appearance and updates when it changes', async () => {
  const media = installMedia(false)
  await mount(model('default'), variables(DEFAULT_THEME))

  const rootStyle = document.documentElement.style
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(rootStyle.colorScheme).toBe('light')
  const lightBackground = rootStyle.getPropertyValue('--bg')
  expect(lightBackground).not.toBe('')
  for (const token of THEME_TOKENS) expect(rootStyle.getPropertyValue(`--${token}`)).not.toBe('')
  for (const [alias, token] of Object.entries({ rail: 'bg', surface: 'bg-raised', selected: 'bg-active', border: 'border', text: 'text', muted: 'muted', accent: 'accent', working: 'green', 'needs-you': 'amber', failing: 'danger' })) {
    expect(rootStyle.getPropertyValue(`--ui-${alias}`)).toBe(rootStyle.getPropertyValue(`--${token}`))
  }

  media.setMatches(true)
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(rootStyle.colorScheme).toBe('dark')
  expect(rootStyle.getPropertyValue('--bg')).not.toBe(lightBackground)
  expect(rootStyle.getPropertyValue('--ui-rail')).toBe(rootStyle.getPropertyValue('--bg'))
  for (const token of THEME_TOKENS) expect(rootStyle.getPropertyValue(`--${token}`)).not.toBe('')
})

test('explicit dark and light app themes ignore system appearance changes', async () => {
  const media = installMedia(false)
  const mounted = await mount(model('dark'), variables(DARK_THEME))
  const darkBackground = document.documentElement.style.getPropertyValue('--bg')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(darkBackground).not.toBe('')
  expect(media.listenerCount()).toBe(0)

  media.setMatches(true)
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe(darkBackground)

  await mounted.update(model('light'), variables(LIGHT_THEME))
  const lightBackground = document.documentElement.style.getPropertyValue('--bg')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(lightBackground).not.toBe('')
  media.setMatches(false)
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe(lightBackground)
  expect(media.listenerCount()).toBe(0)
})

test('plugin appearance and colors remain fixed when system appearance changes', async () => {
  const media = installMedia(true)
  const custom: ThemeInfo = {
    id: 'theme:acme.custom/soft',
    plugin: 'acme.custom',
    title: 'Soft',
    appearance: 'light',
    colors: { ...DEFAULT_THEME.colors, bg: '#fefefe', text: '#202020' }
  }
  await mount(model(custom.id, custom.id, custom), variables(custom))

  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.colorScheme).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#fefefe')
  expect(document.documentElement.style.getPropertyValue('--ui-text')).toBe('#202020')
  expect(media.listenerCount()).toBe(0)
  media.setMatches(false)
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#fefefe')
})

test('an unavailable chosen theme falls back to the follow-system appearance', async () => {
  installMedia(false)
  await mount(model('default', 'theme:acme.missing/gone'), variables(DEFAULT_THEME))

  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--bg')).not.toBe('')
})

test('the system appearance listener is removed when the hook is torn down', async () => {
  const media = installMedia(false)
  const mounted = await mount(model('default'), variables(DEFAULT_THEME))
  expect(media.listenerCount()).toBe(1)
  expect(media.addCount).toBe(1)

  await mounted.unmount()
  expect(media.listenerCount()).toBe(0)
  expect(media.removeCount).toBe(1)
})

test('the frame color is #0c0d0f in dark and #eef0f3 in light, written to --ui-rail from the theme background', async () => {
  const media = installMedia(false)
  await mount(model('default'), variables(DEFAULT_THEME))
  const style = document.documentElement.style
  expect(style.getPropertyValue('--ui-rail')).toBe('#eef0f3')
  expect(style.getPropertyValue('--ui-rail')).toBe(style.getPropertyValue('--bg'))
  media.setMatches(true)
  expect(style.getPropertyValue('--ui-rail')).toBe('#0c0d0f')
  expect(style.getPropertyValue('--ui-rail')).toBe(style.getPropertyValue('--bg'))
  expect(DEFAULT_THEME.colors.bg).toBe('#0c0d0f')
  expect(DARK_THEME.colors.bg).toBe('#0c0d0f')
  expect(LIGHT_THEME.colors.bg).toBe('#eef0f3')
})
