import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import type { LedgerSettings as LedgerSettingsComponent } from '../src/ui/LedgerSettings'
import type { LedgerResponse } from '../src/ui/types'
type Call = { method: string; params: Record<string, unknown> }
type Listener = (event: { type: string }) => void
type Responder = (params: Record<string, unknown>) => Promise<LedgerResponse>
type SettingsContext = {
  context: UiPluginContext
  calls: Call[]
  emit(type: string): void
  subscriberCount(): number
}

const SETTINGS = 'plugins/quirky.ledger/src/ui/LedgerSettings.tsx'
const FRAGMENT = 'plugins/quirky.ledger/ui-scoreboard/ledger-settings.json'
const SURFACE = 'view:quirky.ledger/settings'
const PASS: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true
}
const RUNTIME = { runtimeId: 'runtime-1', profileId: 'profile-1' }
const roots: Root[] = []
const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
let createRoot: typeof CreateRoot
let LedgerSettings: typeof LedgerSettingsComponent

beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  // These modules inspect browser globals at import time, so load only after Happy DOM is installed.
  createRoot = (await import('react-dom/client')).createRoot
  LedgerSettings = (await import('../src/ui/LedgerSettings')).LedgerSettings
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

function settingsResponse(staleAfterDays = 90, hasLedger = true, revision = 4): LedgerResponse {
  return {
    schemaVersion: 1,
    runtime: RUNTIME,
    ledger: hasLedger ? {
      ledgerId: 'ledger-project', tier: 'project', owner: { tier: 'project', id: 'repo-1' }, revision,
      entryCount: 0, nextSequence: 1, staleAfterDays, name: 'quirky', ownerName: 'quirky', repoId: 'repo-1'
    } : null,
    entries: []
  }
}

function makeContext(respond: Responder = async () => settingsResponse()): SettingsContext {
  const calls: Call[] = []
  const listeners = new Set<Listener>()
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method !== 'quirky.ledger/request') throw new Error(`Unexpected settings request route: ${method}`)
      return respond(params)
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
  return {
    context: context as unknown as UiPluginContext,
    calls,
    emit(type) { for (const listener of [...listeners]) listener({ type }) },
    subscriberCount() { return listeners.size }
  }
}

async function mount(respond?: Responder) {
  const fixture = makeContext(respond)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LedgerSettings context={fixture.context} input={{ repoId: 'repo-1' }} />))
  return { ...fixture, host, root }
}

const settle = () => act(async () => {
  const timer = Promise.withResolvers<void>()
  setTimeout(timer.resolve, 20)
  await timer.promise
})

async function resolveAndSettle(resolveResponse: (response: LedgerResponse) => void, response: LedgerResponse): Promise<void> {
  await act(async () => {
    resolveResponse(response)
    const timer = Promise.withResolvers<void>()
    setTimeout(timer.resolve, 20)
    await timer.promise
  })
}
const requests = (calls: Call[], operation: string) => calls.filter((call) => call.method === 'quirky.ledger/request' && call.params.operation === operation)

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

function inlineError(root: ParentNode, message: string): HTMLElement {
  const error = root.querySelector<HTMLElement>('.ui-inline-error')
  expect(error).toBeDefined()
  expect(error?.getAttribute('role')).toBe('alert')
  expect(error?.textContent).toContain(message)
  return error!
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click())
}

async function setDays(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('LedgerSettings renders the shared loading notice while the initial request is pending', async () => {
  const pending = Promise.withResolvers<LedgerResponse>()
  const app = await mount(() => pending.promise)
  expect(app.host.querySelector('.ui-notice-line')?.textContent).toContain('Loading ledger settings…')
  expect(app.host.querySelector('.ui-inline-error')).toBeNull()
  await resolveAndSettle(pending.resolve, settingsResponse())
})

test('LedgerSettings uses EmptyState when the project has no ledger', async () => {
  const app = await mount(async () => settingsResponse(90, false))
  await settle()
  expect(app.host.querySelector('.ui-empty-state')?.textContent).toContain('This project has no ledger yet. File an entry to create one.')
  expect(app.host.querySelector('input[type="number"]')).toBeNull()
})

test('initial load errors render InlineError and Retry reloads through quirky.ledger/request', async () => {
  let attempts = 0
  const app = await mount(async () => {
    attempts++
    if (attempts === 1) throw new Error('ledger daemon offline')
    return settingsResponse()
  })
  await settle()
  const error = inlineError(app.host, 'ledger daemon offline')
  await click(buttonByText(error, 'Retry'))
  await settle()
  expect(requests(app.calls, 'list')).toHaveLength(2)
  expect(requests(app.calls, 'list')[1]?.params).toMatchObject({ target: { owner: { tier: 'project', id: 'repo-1' } } })
  expect(app.host.querySelector('.ui-inline-error')).toBeNull()
})

test('a loaded settings error offers Reload and reloads the ledger', async () => {
  const app = await mount(async (params) => {
    if (params.operation === 'settings') throw new Error('settings write failed')
    return settingsResponse()
  })
  await settle()
  const input = app.host.querySelector<HTMLInputElement>('input[type="number"]')!
  await setDays(input, '14')
  await click(buttonByText(app.host, 'Save'))
  await settle()
  const error = inlineError(app.host, 'settings write failed')
  expect(buttonByText(error, 'Reload')).toBeDefined()
  await click(buttonByText(error, 'Reload'))
  await settle()
  expect(requests(app.calls, 'list')).toHaveLength(2)
  expect(requests(app.calls, 'list')[1]?.params).toMatchObject({ target: { owner: { tier: 'project', id: 'repo-1' } } })
})

test('saving staleAfterDays uses the ledger request route and confirms with a status', async () => {
  const app = await mount(async (params) => params.operation === 'settings'
    ? settingsResponse(Number(params.staleAfterDays), true, 5)
    : settingsResponse())
  await settle()
  await setDays(app.host.querySelector<HTMLInputElement>('input[type="number"]')!, '14')
  await click(buttonByText(app.host, 'Save'))
  await settle()
  expect(requests(app.calls, 'settings')).toHaveLength(1)
  expect(requests(app.calls, 'settings')[0]?.params).toMatchObject({
    target: { owner: { tier: 'project', id: 'repo-1' } }, ifLedgerRevision: 4, staleAfterDays: 14
  })
  expect(app.host.querySelector('[role="status"]')?.textContent).toBe('Saved')
  expect(app.host.querySelector('.ui-inline-error')).toBeNull()
})

test('quirky.ledger subscription refreshes the same project and ignores unrelated events', async () => {
  const app = await mount()
  await settle()
  expect(requests(app.calls, 'list')).toHaveLength(1)
  await act(async () => app.emit('quirky.repo/changed'))
  await settle()
  expect(requests(app.calls, 'list')).toHaveLength(1)
  await act(async () => app.emit('quirky.ledger/entry-created'))
  await settle()
  expect(requests(app.calls, 'list')).toHaveLength(2)
  expect(requests(app.calls, 'list').map((call) => call.params.target)).toEqual([
    { owner: { tier: 'project', id: 'repo-1' } }, { owner: { tier: 'project', id: 'repo-1' } }
  ])
})

test('newer settings loads win and unmount invalidates pending refreshes', async () => {
  const pending: Array<(response: LedgerResponse) => void> = []
  const app = await mount(() => {
    const request = Promise.withResolvers<LedgerResponse>()
    pending.push(request.resolve)
    return request.promise
  })
  expect(app.subscriberCount()).toBe(1)
  await act(async () => app.emit('quirky.ledger/changed'))
  await settle()
  expect(pending).toHaveLength(2)
  await resolveAndSettle(pending[1]!, settingsResponse(14))
  await resolveAndSettle(pending[0]!, settingsResponse(37))
  expect(app.host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('14')

  const unmounted = Promise.withResolvers<LedgerResponse>()
  const next = await mount(() => unmounted.promise)
  expect(next.subscriberCount()).toBe(1)
  await act(async () => next.root.unmount())
  const rootIndex = roots.indexOf(next.root)
  if (rootIndex !== -1) roots.splice(rootIndex, 1)
  expect(next.subscriberCount()).toBe(0)
  await resolveAndSettle(unmounted.resolve, settingsResponse())
  expect(next.host.querySelector('[aria-label="Ledger settings"]')).toBeNull()
  await act(async () => next.emit('quirky.ledger/changed'))
  await settle()
  expect(requests(next.calls, 'list')).toHaveLength(1)
})

test('ledger-settings fragment owns its surface and every LedgerSettings audit candidate', () => {
  const inventory: Inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.ledger') as PluginInventory | undefined
  expect(plugin).toBeDefined()
  const fragment = plugin!.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  const coverage = parseCoverage(fragment!.content)
  expect(coverage.surfaces).toEqual({
    [SURFACE]: { loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } }
  })
  expect(coverage.states.map((entry) => entry.state).sort()).toEqual(['empty', 'error', 'loading'])
  expect(coverage.notState.some((entry) => entry.site.file === SETTINGS && entry.site.quote.includes('role="status">Saved'))).toBe(true)
  expect(coverage.actions.some((entry) => 'route' in entry && entry.site.file === SETTINGS && entry.route.target === 'quirky.ledger/request')).toBe(true)

  const graph = discoverUiFiles(plugin!)
  expect(graph.failures).toEqual([])
  const settingsCandidates = discoverCandidates(plugin!, graph.files).filter((candidate) => candidate.file === SETTINGS)
  expect(settingsCandidates.length).toBeGreaterThan(0)
  const evidenceEntries = [...coverage.states, ...coverage.notState, ...coverage.actions]
  expect(evidenceEntries.every((entry) => entry.site.file === SETTINGS)).toBe(true)
  const issues = auditPlugin(inventory, plugin!).flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
  expect(issues.filter((entry: Evidence) => entry.source?.file === SETTINGS || entry.coverageFile === FRAGMENT || entry.targetId === SURFACE)).toEqual([])
})
