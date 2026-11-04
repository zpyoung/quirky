import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_THEME, PLUGIN_API_VERSION, type UiModel, type UiSlotEntry } from '@quirky/protocol'

let createRoot: (container: HTMLElement) => Root
let AppContext: typeof import('../src/context').AppContext
let WindowBarNewTabs: typeof import('../src/shell/WindowBar').WindowBarNewTabs
let root: Root | null = null
let container: HTMLDivElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  AppContext = (await import('../src/context')).AppContext
  WindowBarNewTabs = (await import('../src/shell/WindowBar')).WindowBarNewTabs
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function item(name: string, order: number): UiSlotEntry {
  return { id: `window-bar-item:acme/${name}`, kind: 'window-bar-item', plugin: 'acme', title: name, order, module: '/plugins/acme/ui.js' }
}

function modelWith(windowBarItems: UiSlotEntry[] | undefined): UiModel {
  return {
    sidebarSections: [],
    statusBars: [],
    activityItems: [],
    panels: [],
    views: [],
    overlays: [],
    commands: [{ id: 'command:quirky.session/new-shell', plugin: 'quirky.session', title: 'New terminal', module: null }],
    keybindings: [],
    settings: [],
    settingsSections: [],
    menuItems: [],
    themes: [DEFAULT_THEME],
    theme: { chosen: 'default', active: 'default' },
    modules: { acme: { url: '/plugins/acme/ui.js', provides: [], apiVersion: PLUGIN_API_VERSION } },
    ...(windowBarItems ? { windowBarItems } : {})
  }
}

async function render(model: UiModel): Promise<void> {
  const state = { model, slots: {} }
  const plugins = { subscribe: () => () => {}, getState: () => state, mount: () => () => {} }
  const value = { store: {}, connection: {}, plugins } as never
  await act(async () => {
    root!.render(
      <AppContext.Provider value={value}>
        <WindowBarNewTabs />
      </AppContext.Provider>
    )
  })
}

const orderedChildren = () => [...container.querySelectorAll('button, [data-plugin-slot]')].map(
  (element) => element.getAttribute('data-plugin-slot') ?? element.getAttribute('aria-label')
)

describe('window-bar items', () => {
  test('each item renders as a plugin slot, in model order, after the new-tab buttons', async () => {
    await render(modelWith([item('first', 1), item('second', 2)]))
    expect(orderedChildren()).toEqual(['New terminal', 'window-bar-item:acme/first', 'window-bar-item:acme/second'])
  })

  test('a model without window-bar items renders only the buttons', async () => {
    await render(modelWith(undefined))
    expect(orderedChildren()).toEqual(['New terminal'])
  })
})
