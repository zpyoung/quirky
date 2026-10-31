import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolPanelFrame } from '@quirky/ui'
import { initialUiState } from '../src/state'

type Mount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void
let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let cleanup: (() => void) | null = null
let cleanupHost: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterEach(async () => {
  await act(async () => cleanup?.())
  await act(async () => cleanupHost?.())
  cleanupHost = null
  cleanup = null
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('Automations root leaves panel dismissal to the host Minimize control', async () => {
  const provided = new Map<string, unknown>()
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string) {
      if (method === 'quirky.automations/uiState') return initialUiState()
      throw new Error('offline')
    },
    subscribe: () => () => {},
    getSetting: () => true,
    toast() {}
  } as unknown as UiPluginContext
  activate(context)
  const container = document.createElement('div')
  document.body.append(container)
  const host = createRoot(container)
  cleanupHost = () => host.unmount()
  await act(async () => host.render(createElement(ToolPanelFrame, {
    title: 'Automations',
    onMinimize() {},
    children: createElement('div', { id: 'automations-mount' })
  })))
  const element = container.querySelector<HTMLElement>('#automations-mount')!
  await act(async () => {
    cleanup = (provided.get('view:quirky.automations/automations') as Mount)(element, {})
  })

  const header = container.querySelector('.ui-tool-panel-frame__header')!
  expect(header.querySelector('button[aria-label="Close Automations"]')).toBeNull()
  expect(header.querySelector('button[aria-label="Minimize Automations"]')).not.toBeNull()
  expect(header.querySelector('button[title="Return to previous view"]')).toBeNull()
})
