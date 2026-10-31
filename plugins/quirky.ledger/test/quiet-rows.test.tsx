import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'

type LedgerModule = typeof import('../src/ui/LedgerApp')
let createRoot: typeof CreateRoot
let LedgerApp: LedgerModule['LedgerApp']

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
const projectSummary = { ledgerId: 'ledger-project', tier: 'project', owner: { tier: 'project', id: 'repo-1' }, revision: 4, entryCount: 1, nextSequence: 2, staleAfterDays: 30, name: 'quirky', ownerName: 'quirky' }
const entry = {
  id: 'BUG-1', type: 'bug', sequence: 1, revision: 1, content: { title: 'A very long title that has to truncate instead of wrapping under the buttons' }, state: 'open', reviewed: false,
  origin: { workspaceId: 'wt-1' }, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', history: []
}

function fakeContext(calls: Array<{ method: string; params: Record<string, unknown> }>): UiPluginContext {
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'quirky.repo/list') return [{ id: 'repo-1', name: 'quirky', kind: 'git' }]
    if (method === 'quirky.repo/groupList') return []
    if (method === 'quirky.worktree/list') return [{ id: 'wt-1', repoId: 'repo-1', name: 'main', kind: 'git' }]
    if (method !== 'quirky.ledger/request') return []
    const base = { schemaVersion: 1, runtime: RUNTIME }
    if (params.operation === 'catalog') return { ...base, ledger: null, ledgers: [projectSummary], owners: [] }
    if (params.operation === 'approve') return { ...base, ledger: projectSummary, entries: [{ ...entry, reviewed: true }] }
    return { ...base, ledger: projectSummary, entries: [entry] }
  }
  return {
    call,
    getLayout: () => ({ worktree: 'wt-1' }),
    onLayout: () => () => {},
    subscribe: () => () => {},
    openView: () => {}
  } as unknown as UiPluginContext
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

async function mountPanel(calls: Array<{ method: string; params: Record<string, unknown> }> = []): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LedgerApp context={fakeContext(calls)} mode="panel" />))
  await settle()
  await settle()
  return host
}

test('an entry is one line whose Edit, Review and Delete stay in the DOM under a hover reveal', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const host = await mountPanel(calls)
  const row = host.querySelector<HTMLElement>('[data-entry-id="BUG-1"]')!
  const reveal = row.querySelector<HTMLElement>('.ledger-row-actions')!
  for (const label of ['Edit BUG-1', 'Review BUG-1', 'Delete BUG-1']) {
    expect(reveal.querySelector(`button[aria-label="${label}"]`)?.textContent).toBe(label)
  }
  expect(row.querySelector('.ledger-row-title')?.textContent).toContain('A very long title')
  expect(row.style.borderBottom).toBe('')
  expect(row.style.flexDirection).not.toBe('column')
})

test('Review and Delete still run their actions', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const host = await mountPanel(calls)
  const row = host.querySelector<HTMLElement>('[data-entry-id="BUG-1"]')!
  await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-label="Review BUG-1"]')!.click() })
  await settle()
  expect(calls.some((item) => item.params.operation === 'approve')).toBe(true)
  await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-label="Delete BUG-1"]')!.click() })
  await settle()
  expect(document.body.querySelector('[role="dialog"], .ui-dialog')).not.toBeNull()
})

test('Edit opens the entry form', async () => {
  const host = await mountPanel()
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Edit BUG-1"]')!.click() })
  await settle()
  expect(document.body.querySelector('[role="dialog"], .ui-dialog, form')).not.toBeNull()
})

const css = readFileSync(new URL('../../../packages/ui/src/design-system/ledger-rows.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector!.split(',').map((part) => part.trim()),
  body: body!.replace(/\s+/g, ' ').trim()
}))

test('ledger-rows.css hides with opacity 0, reveals on hover and focus within, and never uses display or visibility', () => {
  expect(rules.some((rule) => /(^|;|\s)opacity: 0(;|$)/.test(rule.body))).toBe(true)
  const shown = rules.filter((rule) => /(^|;|\s)opacity: 1(;|$)/.test(rule.body)).flatMap((rule) => rule.selectors)
  expect(shown.some((selector) => selector.includes(':hover'))).toBe(true)
  expect(shown.some((selector) => selector.includes(':focus-within'))).toBe(true)
  expect(css).not.toMatch(/display:\s*none/)
  expect(css).not.toMatch(/visibility:\s*hidden/)
})

test('every ledger-rows.css selector is scoped under the entry row class, and Delete is red only on its own hover or focus', () => {
  expect(rules.length).toBeGreaterThan(0)
  for (const rule of rules) for (const selector of rule.selectors) expect(selector).toMatch(/\.ledger-entry-row\b/)
  const filled = rules.filter((rule) => /background: var\(--ui-failing\)/.test(rule.body)).flatMap((rule) => rule.selectors)
  expect(filled.length).toBeGreaterThan(0)
  for (const selector of filled) expect(selector).toMatch(/:(hover|focus-visible)/)
})
