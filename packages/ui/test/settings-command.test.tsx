import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { UiModel } from '@quirky/protocol'
import type { Connection } from '../src/connection'
import type { HostState, WindowPluginHost } from '../src/plugins/host'
import type { Store } from '../src/store'

type Component = typeof import('../src/components/SettingsDialog')
let component: Component
let act: typeof import('react').act
let reactRuntime: typeof import('react')
let clientRuntime: typeof import('react-dom/client')
let contextRuntime: typeof import('../src/context')
let root: Root | null = null
let container: HTMLDivElement
let commandCalls: string[]
let closed = false

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Browser-facing modules load after Happy DOM so ReactDOM observes the installed document.
  const [react, client, context, settings] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../src/context'),
    import('../src/components/SettingsDialog')
  ])
  reactRuntime = react
  clientRuntime = client
  contextRuntime = context
  component = settings
  act = react.act
})

beforeEach(async () => {
  const react = reactRuntime
  const client = clientRuntime
  const context = contextRuntime
  commandCalls = []
  closed = false
  container = document.createElement('div')
  document.body.append(container)
  root = client.createRoot(container)
  const model = {
    commands: [{ id: 'command:quirky.mobile/open-settings', plugin: 'quirky.mobile', title: 'Mobile settings', module: '/mobile.js' }],
    themes: [],
    theme: { chosen: 'default', active: 'default' }
  } as unknown as UiModel
  const state = {
    model,
    settings: [],
    plugins: {},
    slots: {},
    layout: { view: null, panel: null, sidebar: true, focus: null },
    openView: null,
    openPanel: null,
    badges: {},
    badgeTitles: {},
    themeVariables: {}
  } satisfies HostState
  const plugins = {
    subscribe: () => () => {},
    getState: () => state,
    async runCommandForResult(id: string) {
      commandCalls.push(id)
      return { opened: id }
    },
    async saveSettings() {
      return { errors: {} }
    }
  } as unknown as WindowPluginHost
  const value = { store: {} as Store, connection: {} as Connection, plugins }
  await act(async () => {
    root!.render(react.createElement(context.AppContext.Provider, { value }, react.createElement(component.SettingsDialog, { onClose: () => { closed = true } })))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('Settings runs each plugin open-settings command from the current contribution model', async () => {
  const action = container.querySelector<HTMLButtonElement>('[data-settings-command="command:quirky.mobile/open-settings"]')
  expect(action?.textContent).toContain('Mobile settings')
  await act(async () => action?.click())
  expect(commandCalls).toEqual(['command:quirky.mobile/open-settings'])
  expect(closed).toBe(true)
})
