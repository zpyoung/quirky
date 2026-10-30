import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'

type Mount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void
let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let cleanup: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterEach(async () => {
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('Automations keeps Close Automations in the frame header and draws one title', async () => {
  const provided = new Map<string, unknown>()
  const calls: string[] = []
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string) {
      calls.push(method)
      throw new Error('offline')
    },
    subscribe: () => () => {},
    getSetting: () => true,
    toast() {}
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => {
    cleanup = (provided.get('view:quirky.automations/automations') as Mount)(element, {})
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

  expect([...element.querySelectorAll('h2')].filter((heading) => heading.textContent === 'Automations')).toHaveLength(1)
  const close = element.querySelector<HTMLButtonElement>('button[aria-label="Close Automations"]')
  expect(close?.closest('.ui-tool-panel-frame__header .ui-tool-panel-frame__actions')).not.toBeNull()
  await act(async () => close!.click())
  expect(calls).toContain('quirky.automations/close')
})
