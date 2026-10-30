import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { Root } from 'react-dom/client'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports follow registration.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ToolPanelFrame } = await import('@quirky/ui')
const { mountHistoryPanel } = await import('../src/window/HistoryPanel')

type CallRecord = { method: string; params: Record<string, unknown> }
const view = {
  disabledAgents: [], browseSort: 'updated', searchSort: 'relevance', group: 'project', hideEmptySessions: false,
  sessionLimit: 250, host: 'local', scope: 'all', query: '', selectedId: null, expandedIds: [], focusedSearch: false
}
const cleanups: Array<() => void | Promise<void>> = []

function makeContext() {
  const calls: CallRecord[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.vault/getView') return view
      throw new Error(`Unexpected UI call ${method}`)
    },
    subscribe: () => () => {},
    onLayout: () => () => {},
    getLayout: () => ({}),
    setPanelBadge: () => {},
    toast: () => {}
  } as unknown as UiPluginContext
  return { context, calls }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve() })
}

async function mountPanel(context: UiPluginContext, hosted: boolean): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let slot: HTMLElement = container
  if (hosted) {
    const hostRoot: Root = createRoot(container)
    await act(async () => hostRoot.render(createElement(ToolPanelFrame, { title: 'Agent Session History', children: createElement('div', { 'data-slot': '' }) })))
    slot = container.querySelector<HTMLElement>('[data-slot]')!
    cleanups.push(async () => { await act(async () => hostRoot.unmount()) })
  }
  let unmount: () => void = () => {}
  await act(async () => { unmount = mountHistoryPanel(context, slot, {}) })
  cleanups.push(async () => { await act(async () => unmount()) })
  cleanups.push(() => container.remove())
  await settle()
  return container
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const leavesTexted = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('*')].filter((element) => element.children.length === 0 && element.textContent?.trim() === text)

test('inside a host frame the panel draws no second title and puts tabs and tools in the frame', async () => {
  const { context } = makeContext()
  const container = await mountPanel(context, true)
  const frame = container.querySelector<HTMLElement>('[data-ui-tool-panel-frame]')!

  expect(container.querySelectorAll('[data-ui-tool-panel-frame]').length).toBe(1)
  expect(leavesTexted(container, 'Agent Session History').length).toBe(1)
  expect(leavesTexted(container, 'Agents').length).toBe(0)
  expect(container.querySelector('.qvh-header')).toBeNull()

  const tablist = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__header .ui-tool-panel-frame__tabs [role="tablist"][aria-label="History scope"]')
  expect(tablist).not.toBeNull()
  expect([...tablist!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Workspace', 'Project', 'All'])

  const rail = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__rail')!
  expect(rail.querySelector('[aria-label="View options"]')).not.toBeNull()
  expect(rail.querySelector('[aria-label="Refresh Session History"]')).not.toBeNull()
  const body = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__body')!
  expect(body.querySelector('[aria-label="View options"]')).toBeNull()
  expect(body.querySelector('[aria-label="History host"]')).not.toBeNull()
  expect(body.querySelector('[data-vault-search]')).not.toBeNull()
})

test('the rail buttons still open view options and refresh the list', async () => {
  const { context, calls } = makeContext()
  const container = await mountPanel(context, true)
  const rail = container.querySelector<HTMLElement>('.ui-tool-panel-frame__rail')!

  expect(container.querySelector('[data-vault-view-options]')).toBeNull()
  await act(async () => rail.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click())
  expect(container.querySelector('[data-vault-view-options]')).not.toBeNull()
  expect(rail.querySelector('[aria-label="View options"]')!.getAttribute('aria-expanded')).toBe('true')

  const before = calls.filter((call) => call.method === 'quirky.vault/list').length
  const refresh = rail.querySelector<HTMLButtonElement>('[aria-label="Refresh Session History"]')!
  await settle()
  await act(async () => refresh.click())
  await settle()
  const lists = calls.filter((call) => call.method === 'quirky.vault/list')
  expect(lists.length).toBeGreaterThan(before)
  expect(lists.at(-1)?.params.force).toBe(true)
})

test('mounted with no host frame the panel brings its own and keeps every control', async () => {
  const { context } = makeContext()
  const container = await mountPanel(context, false)
  const frame = container.querySelector<HTMLElement>('[data-ui-tool-panel-frame]')!

  expect(frame).not.toBeNull()
  expect(frame.querySelector('h2')?.textContent).toBe('Agent Session History')
  expect(leavesTexted(container, 'Agent Session History').length).toBe(1)
  expect(frame.querySelector('.ui-tool-panel-frame__tabs [role="tablist"][aria-label="History scope"]')).not.toBeNull()
  const rail = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__rail')!
  expect(rail.querySelector('[aria-label="View options"]')).not.toBeNull()
  expect(rail.querySelector('[aria-label="Refresh Session History"]')).not.toBeNull()

  await act(async () => rail.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click())
  expect(container.querySelector('[data-vault-view-options]')).not.toBeNull()
})
