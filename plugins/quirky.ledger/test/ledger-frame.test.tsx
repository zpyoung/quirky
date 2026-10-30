import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'

type LedgerModule = typeof import('../src/ui/LedgerApp')
type UiModule = typeof import('@quirky/ui')
let createRoot: typeof CreateRoot
let LedgerApp: LedgerModule['LedgerApp']
let ToolPanelFrame: UiModule['ToolPanelFrame']

const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
const roots: Root[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  LedgerApp = (await import('../src/ui/LedgerApp')).LedgerApp
  ToolPanelFrame = (await import('@quirky/ui')).ToolPanelFrame
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const RUNTIME = { runtimeId: 'runtime-1', profileId: 'profile-1' }
const projectSummary = { ledgerId: 'ledger-project', tier: 'project', owner: { tier: 'project', id: 'repo-1' }, revision: 4, entryCount: 3, nextSequence: 4, staleAfterDays: 30, name: 'quirky', ownerName: 'quirky' }
const entry = {
  id: 'BUG-1', type: 'bug', sequence: 1, revision: 1, content: { title: 'Frame record' }, state: 'open', reviewed: false,
  origin: { workspaceId: 'wt-1' }, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', history: []
}

function fakeContext(calls: Array<{ method: string; params: Record<string, unknown> }>, opened: string[] = []): UiPluginContext {
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'quirky.repo/list') return [{ id: 'repo-1', name: 'quirky', kind: 'git' }]
    if (method === 'quirky.repo/groupList') return []
    if (method === 'quirky.worktree/list') return [{ id: 'wt-1', repoId: 'repo-1', name: 'main', kind: 'git' }]
    if (method !== 'quirky.ledger/request') return []
    const base = { schemaVersion: 1, runtime: RUNTIME }
    if (params.operation === 'catalog') return { ...base, ledger: null, ledgers: [projectSummary], owners: [] }
    return { ...base, ledger: projectSummary, entries: [entry] }
  }
  return {
    call,
    getLayout: () => ({ worktree: 'wt-1' }),
    onLayout: () => () => {},
    subscribe: () => () => {},
    openView: (id: string) => { opened.push(id) }
  } as unknown as UiPluginContext
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
const listCalls = (calls: Array<{ method: string; params: Record<string, unknown> }>) => calls.filter((item) => item.params.operation === 'list').length

/** Mounts the plugin in its own root under the host frame, the way a tool slot does. */
async function mountPanel(context: UiPluginContext): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const hostRoot = createRoot(host)
  roots.push(hostRoot)
  await act(async () => hostRoot.render(<ToolPanelFrame title="Ledger"><div data-plugin /></ToolPanelFrame>))
  const pluginRoot = createRoot(host.querySelector<HTMLElement>('[data-plugin]')!)
  roots.push(pluginRoot)
  await act(async () => pluginRoot.render(<LedgerApp context={context} mode="panel" />))
  await settle()
  await settle()
  return host
}

async function mountPage(context: UiPluginContext, input?: unknown): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LedgerApp context={context} mode="page" input={input} />))
  await settle()
  await settle()
  return host
}

const rail = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-ui-tool-panel-rail-target]')!
const tabs = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-ui-tool-panel-tabs-target]')!
const headerActions = (host: HTMLElement) => host.querySelector<HTMLElement>('.ui-tool-panel-frame__actions')!
const railButton = (host: HTMLElement, name: string) => rail(host).querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const textButton = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)

test('panel mode draws no second title and puts its tabs in the frame header', async () => {
  const host = await mountPanel(fakeContext([]))
  expect(host.querySelectorAll('h1, h2')).toHaveLength(1)
  expect(host.querySelector('h2')?.textContent).toBe('Ledger')
  expect(host.querySelector('.ledger-header, .ledger-panel-header, .ledger-scope-tabs')).toBeNull()
  const tablist = tabs(host).querySelector('[role="tablist"]')
  expect(tablist).not.toBeNull()
  const tabNames = [...tabs(host).querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabNames).toEqual(['Worktree', 'Project3'])
  const project = [...tabs(host).querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Project'))!
  expect(project.querySelector('.ui-tabs__count')?.textContent).toBe('3')
  expect(tabs(host).querySelector('[role="tab"]')?.querySelector('.ui-tabs__count')).toBeNull()
  expect(host.querySelector('.ui-tool-panel-frame__body [role="tablist"]')).toBeNull()
})

test('panel mode keeps refresh, triage and new on the rail, and refresh reloads the entries', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const host = await mountPanel(fakeContext(calls))
  const refresh = railButton(host, 'Refresh ledger')!
  expect(refresh.querySelector('svg.ui-control-icon')).not.toBeNull()
  expect(textButton(rail(host), 'Triage')).toBeDefined()
  expect(railButton(host, 'New')).not.toBeNull()
  expect(host.querySelector('.ui-tool-panel-frame__body button[aria-label="Refresh ledger"]')).toBeNull()
  const before = listCalls(calls)
  await act(async () => { refresh.click() })
  await settle()
  expect(listCalls(calls)).toBe(before + 1)
  expect(host.querySelector('.ui-tool-panel-frame__body')?.textContent).toContain('Frame record')
  expect(host.querySelector('.ui-tool-panel-frame__body [aria-label="Ledger filters"]')).not.toBeNull()
})

test('page mode wraps itself in a frame that carries its refresh, triage, new and header actions', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const opened: string[] = []
  const host = await mountPage(fakeContext(calls, opened), { target: { owner: { tier: 'project', id: 'repo-1' } } })
  expect(host.querySelectorAll('h1, h2')).toHaveLength(1)
  expect(host.querySelector('h2')?.textContent).toBe('quirky')
  expect(host.querySelector('.ledger-header')).toBeNull()
  const refresh = railButton(host, 'Refresh ledger')!
  expect(refresh).not.toBeNull()
  expect(railButton(host, 'New entry')).not.toBeNull()
  expect(textButton(rail(host), 'Triage')).toBeDefined()
  expect(textButton(headerActions(host), 'Ledger settings')).toBeDefined()
  expect(textButton(headerActions(host), 'Delete ledger')).toBeDefined()
  expect(tabs(host).childNodes).toHaveLength(0)
  expect(host.querySelector('.ui-tool-panel-frame__body [aria-label="Ledger filters"]')).not.toBeNull()
  const before = listCalls(calls)
  await act(async () => { refresh.click() })
  await settle()
  expect(listCalls(calls)).toBe(before + 1)
  await act(async () => { textButton(headerActions(host), 'Ledger settings')!.click() })
  expect(opened).toEqual(['view:quirky.ledger/settings'])
})

test('chooser mode keeps its catalog refresh on the rail under its own frame title', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const host = await mountPage(fakeContext(calls))
  expect(host.querySelectorAll('h1, h2')).toHaveLength(1)
  expect(host.querySelector('h2')?.textContent).toBe('Open ledger')
  const refresh = railButton(host, 'Refresh ledger catalog')!
  expect(refresh).not.toBeNull()
  const before = calls.filter((item) => item.params.operation === 'catalog').length
  await act(async () => { refresh.click() })
  await settle()
  expect(calls.filter((item) => item.params.operation === 'catalog').length).toBe(before + 1)
  expect(host.querySelector('.ui-tool-panel-frame__body')?.textContent).toContain('quirky')
})
