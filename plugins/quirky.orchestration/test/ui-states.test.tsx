import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import type { activate as Activate } from '../src/ui'
import manifest from '../quirky-plugin.json'
import { ORCHESTRATION_EXAMPLES } from '../src/window/setup-state'

type Responder = (params: Record<string, unknown>) => unknown | Promise<unknown>
type FakeUi = {
  provided: Map<string, unknown>
  calls: { method: string; params: Record<string, unknown> }[]
  executed: unknown[][]
  toasts: string[]
  context: UiPluginContext
}
let activate: typeof Activate
const mounted: (() => void)[] = []
beforeAll(async () => {
  GlobalRegistrator.register()
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  // React DOM must detect the registered browser globals before the plugin loads.
  ;({ activate } = await import('../src/ui'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
afterEach(async () => {
  await act(async () => { for (const u of mounted.splice(0)) u() })
  document.body.innerHTML = ''
  localStorage.clear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

const missing = { state: 'missing', agents: [{ id: 'claude', label: 'Claude Code', state: 'missing', path: '/p/SKILL.md', detail: null }], installCommand: 'quirky orchestration skill-install', text: 'Install the orchestration skill, then re-check.' }
const page = (over: Record<string, unknown> = {}) => ({ dispatchId: 'ctx_1', sessionId: null, source: 'terminal', archived: false, sourceExact: true, fallbackReason: null, content: 'line 1', contentComplete: true, clipping: { clipped: false, maxBytes: 0 }, nextCursor: null, terminalLiveness: 'live', agentLiveness: { status: 'live', reason: null }, warnings: [], sourceIdentity: 'src-1', remote: { peerId: 'peer', bindingId: 'b', hostDispatchId: 'ctx_h', hostIncarnation: 'i1' }, ...over })

function fake(responders: Record<string, Responder>): FakeUi {
  const provided = new Map<string, unknown>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const executed: unknown[][] = []
  const toasts: string[] = []
  const context = {
    pluginId: 'quirky.orchestration',
    provide(id: string, impl: unknown) { provided.set(id, impl) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const r = responders[method]
      if (!r) throw new Error(`unexpected ${method}`)
      return r(params)
    },
    subscribe() { return () => {} },
    toast(t: string, b: string) { toasts.push(`${t}${b ? `: ${b}` : ''}`) },
    openView(id: string) { const r = responders['openView']; if (r) r({ id }) },
    async executeCommand(id: string, args?: unknown, options?: unknown) {
      executed.push(options === undefined ? [id, args] : [id, args, options])
      const c = provided.get(id)
      if (typeof c !== 'function') throw new Error(`no command ${id}`)
      return (c as (a?: unknown) => unknown)(args)
    },
    log() {}
  } as unknown as UiPluginContext
  activate(context)
  return { provided, calls, executed, toasts, context }
}
async function mount(f: FakeUi, id: string, props: Record<string, unknown> = {}) {
  const el = document.createElement('div'); document.body.append(el)
  let u: unknown
  await act(async () => { u = (f.provided.get(id) as MountFunction)(el, props as never) })
  if (typeof u === 'function') mounted.push(u as () => void)
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
  return el
}
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
const btn = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label) as HTMLButtonElement
const pending = () => Promise.withResolvers<unknown>().promise
const SV = 'view:quirky.orchestration/settings'
const RV = 'view:quirky.orchestration/remote-worker-output'

describe('settings', () => {
  test('shows shared loading states without claiming the policy is read-only', async () => {
    const f = fake({ 'quirky.orchestration/skillStatus': pending, 'quirky.orchestration/policyShow': pending })
    const root = await mount(f, SV)
    const lines = [...root.querySelectorAll('p.ui-notice-line')].map((p) => p.textContent)
    expect(lines).toEqual(['Checking skill coverage…', 'Checking nested worker depth…'])
    expect(root.querySelector('.ui-empty-state__message')?.textContent).toBe('Checking detected agent CLIs…')
    expect(root.textContent).not.toContain('read-only')
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })
  test('shows one read error with unavailable coverage and depth placeholders', async () => {
    const f = fake({ 'quirky.orchestration/skillStatus': () => { throw new Error('daemon down') }, 'quirky.orchestration/policyShow': () => ({ nestedWorkerMaxDepth: 1, canChange: true }) })
    const root = await mount(f, SV)
    expect([...root.querySelectorAll('div.ui-inline-error[role="alert"] .ui-inline-error__message')].map((e) => e.textContent)).toEqual(['daemon down'])
    expect(root.querySelector('.ui-error-text')).toBeNull()
    expect(root.textContent).toContain('Agent coverage is unavailable.')
    expect(root.textContent).toContain('Nested worker depth is unavailable.')
    expect(root.textContent).not.toContain('read-only')
    expect(root.querySelector('p.ui-notice-line')).toBeNull()
  })
  test.each(['permission denied', null])('shows an agent error once below its row: %s', async (detail) => {
    const st = { state: 'error', agents: [{ id: 'codex', label: 'Codex', state: 'error', path: '/p', detail }], installCommand: 'quirky orchestration skill-install', text: 'One target needs attention.' }
    const f = fake({ 'quirky.orchestration/skillStatus': () => st, 'quirky.orchestration/policyShow': () => ({ nestedWorkerMaxDepth: 1, canChange: true }) })
    const root = await mount(f, SV)
    const row = root.querySelector('[data-orchestration-agent="codex"]')!
    const message = detail ?? 'This skill target needs attention.'
    expect(row.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe(message)
    expect(row.querySelector('.ui-error-text')).toBeNull()
    expect(row.textContent!.split(message).length).toBe(2)
  })
  test('rejects fractional worker depth without saving it', async () => {
    const f = fake({ 'quirky.orchestration/skillStatus': () => missing, 'quirky.orchestration/policyShow': () => ({ nestedWorkerMaxDepth: 1, canChange: true }), 'quirky.orchestration/policySet': () => ({ nestedWorkerMaxDepth: 2, canChange: true }) })
    const root = await mount(f, SV)
    const input = root.querySelector('input[aria-label="Nested worker depth"]') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { btn(root, 'Save depth').click() })
    expect(root.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('Nested worker depth must be an integer greater than or equal to 1.')
    expect(f.calls.some((c) => c.method === 'quirky.orchestration/policySet')).toBe(false)
  })
  test('routes install command copy and keeps success or failure in its dialog', async () => {
    const f = fake({ 'quirky.orchestration/skillStatus': () => missing, 'quirky.orchestration/policyShow': () => ({ nestedWorkerMaxDepth: 1, canChange: true }) })
    const root = await mount(f, SV)
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (v: string) => { copied.push(v) } } })
    await act(async () => { btn(root, 'Copy command').click() })
    await act(async () => { btn(root, 'Copy command to clipboard').click() }); await settle()
    expect(f.executed).toEqual([['command:quirky.orchestration/copy-install-command', {}, { activateOwner: false }]])
    expect(copied).toEqual(['quirky orchestration skill-install'])
    expect(root.querySelector('[data-orchestration-copy-status]')?.textContent).toBe('Copied install command.')
    expect(root.querySelector('[data-orchestration-feedback]')).toBeNull()
    expect(f.toasts).toEqual(['Copied install command.'])
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    await act(async () => { btn(root, 'Copy command to clipboard').click() }); await settle()
    const dialog = root.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('Failed to copy install command. denied')
    expect(dialog.querySelector('.ui-error-text')).toBeNull()
    expect(dialog.querySelector('[data-orchestration-copy-status]')).toBeNull()
    expect(f.toasts.at(-1)).toBe('Failed to copy install command.: denied')
    await act(async () => { btn(root, 'Done').click() })
    await act(async () => { btn(root, 'Copy command').click() })
    expect(root.querySelector('[role="dialog"] .ui-inline-error')).toBeNull()
  })
  test('routes prompt copy and reports clipboard rejection', async () => {
    const f = fake({ 'quirky.orchestration/skillStatus': () => missing, 'quirky.orchestration/policyShow': () => ({ nestedWorkerMaxDepth: 1, canChange: true }) })
    const root = await mount(f, SV)
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (v: string) => { copied.push(v) } } })
    await act(async () => { btn(root, 'Copy prompt: Run a phased workflow').click() }); await settle()
    expect(f.executed).toEqual([['command:quirky.orchestration/copy-prompt', { example: 'phased-workflow' }, { activateOwner: false }]])
    expect(copied).toEqual([ORCHESTRATION_EXAMPLES.find((example) => example.id === 'phased-workflow')!.prompt])
    expect(root.querySelector('[data-orchestration-feedback]')?.textContent).toBe('Copied prompt: Run a phased workflow')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    await act(async () => { btn(root, 'Copy prompt: Run a phased workflow').click() }); await settle()
    expect(root.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('Failed to copy prompt: Run a phased workflow denied')
    expect(f.toasts.at(-1)).toBe('Failed to copy prompt: Run a phased workflow: denied')
    expect(root.querySelector('[data-orchestration-feedback]')).toBeNull()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
    await act(async () => { btn(root, 'Copy prompt: Run a phased workflow').click() }); await settle()
    expect(root.querySelector('.ui-inline-error')).toBeNull()
    expect(root.querySelector('[data-orchestration-feedback]')?.textContent).toBe('Copied prompt: Run a phased workflow')
  })
  test('copies from commands without a mounted view and rejects invalid requests', async () => {
    const f = fake({})
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (v: string) => { copied.push(v) } } })
    const installResult: unknown = await f.context.executeCommand('command:quirky.orchestration/copy-install-command')
    const promptResult: unknown = await f.context.executeCommand('command:quirky.orchestration/copy-prompt', { example: 'parallel-work' })
    expect(installResult).toEqual({ copied: true })
    expect(promptResult).toEqual({ copied: true })
    expect(copied).toEqual(['quirky orchestration skill-install', ORCHESTRATION_EXAMPLES.find((example) => example.id === 'parallel-work')!.prompt])
    await expect(f.context.executeCommand('command:quirky.orchestration/copy-prompt', { example: 'nope' })).rejects.toThrow('Unknown orchestration example: nope')
    expect(copied).toHaveLength(2)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await expect(f.context.executeCommand('command:quirky.orchestration/copy-install-command')).rejects.toThrow('Clipboard access is not available in this window.')
    const copyPrompt = manifest.contributes.command.find((command) => command.id === 'copy-prompt')
    expect(copyPrompt?.args?.properties.example.enum).toEqual(ORCHESTRATION_EXAMPLES.map((example) => example.id))
  })
})
describe('overlay', () => {
  test('shows a shared error when Enable cannot open settings', async () => {
    const f = fake({ 'quirky.terminal/floating': () => ({ enabled: true, open: true }), 'quirky.orchestration/skillStatus': () => missing, openView: () => { throw new Error('no window') } })
    const root = await mount(f, 'overlay:quirky.orchestration/floating-setup')
    await act(async () => { btn(root, 'Enable').click() }); await settle()
    expect(root.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('no window')
    expect(root.querySelector('.ui-error-text')).toBeNull()
  })
})
describe('remote output', () => {
  test('rejects missing Dispatch input without reading output', async () => {
    const f = fake({})
    const root = await mount(f, RV, { input: {} })
    expect(root.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('Remote output view requires a home Dispatch ID.')
    expect(root.querySelector('.ui-empty-state')).toBeNull()
    expect(f.calls).toHaveLength(0)
  })
  test('loads output from the paired host before showing an empty state', async () => {
    const f = fake({ 'quirky.orchestration/workerRead': pending })
    const root = await mount(f, RV, { input: { dispatchId: 'ctx_1' } })
    expect(root.querySelector('.ui-empty-state__message')?.textContent).toBe('Reading output from the paired host…')
    expect(f.calls[0]).toEqual({ method: 'quirky.orchestration/workerRead', params: { dispatchId: 'ctx_1', source: 'auto', limit: 40 } })
  })
  test('keeps the last output after a refresh fails', async () => {
    let n = 0
    const f = fake({ 'quirky.orchestration/workerRead': () => { n += 1; if (n === 1) return page(); throw new Error('host offline') } })
    const root = await mount(f, RV, { input: { dispatchId: 'ctx_1' } })
    await act(async () => { btn(root, 'Refresh').click() }); await settle()
    expect([...root.querySelectorAll('pre.ui-readout')].map((p) => p.textContent)).toEqual(['line 1'])
    expect(root.querySelector('div.ui-inline-error .ui-inline-error__message')?.textContent).toBe('host offline')
    expect(root.querySelector('.ui-error-text')).toBeNull()
  })
  test('announces older output loading and appends the returned page', async () => {
    const older = Promise.withResolvers<unknown>()
    const f = fake({ 'quirky.orchestration/workerRead': (p) => p.cursor ? older.promise : page({ nextCursor: 'c1' }) })
    const root = await mount(f, RV, { input: { dispatchId: 'ctx_1' } })
    await act(async () => { btn(root, 'Load older output').click() })
    expect(root.querySelector('p.ui-notice-line')?.textContent).toBe('Loading older output…')
    await act(async () => { older.resolve(page({ content: 'line 0' })) }); await settle()
    expect(root.querySelector('p.ui-notice-line')).toBeNull()
    expect([...root.querySelectorAll('pre.ui-readout')].map((p) => p.textContent)).toEqual(['line 1', 'line 0'])
    expect(f.calls[1]!.params).toEqual({ dispatchId: 'ctx_1', source: 'auto', limit: 40, cursor: 'c1' })
  })
  test('shows empty output only after the host returns no content', async () => {
    const f = fake({ 'quirky.orchestration/workerRead': () => page({ content: '' }) })
    const root = await mount(f, RV, { input: { dispatchId: 'ctx_1' } })
    expect(root.querySelector('.ui-empty-state__message')?.textContent).toBe('No output is currently available.')
    expect(root.querySelector('pre.ui-readout')).toBeNull()
  })
})
