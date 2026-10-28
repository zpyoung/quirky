import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import type { Ask, Repo, Session, Worktree } from '@quirky/protocol'
import type { MobilePageBridge } from '../src/contracts'
import { validatePageReport } from '../src/shell/bridge-policy'
import type { PageApp as PageAppComponent } from '../src/pages/PageApp'

const repo: Repo = {
  id: 'repo-api',
  name: 'api',
  path: '/repos/api',
  addedAt: 1,
  kind: 'git',
  displayName: null,
  groupId: null
}

const makeWorktree = (id: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  repoId: repo.id,
  path: `/workspaces/${name}`,
  branch: name,
  head: 'deadbeef',
  isMain: false,
  name,
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 1,
  createdBy: 'api',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 1,
  instanceId: `${id}-instance`,
  ...extra
})

const session: Session = {
  id: 'session-api',
  kind: 'terminal',
  agent: 'shell',
  worktreeId: 'wt-api',
  cwd: '/workspaces/api',
  title: 'shell',
  status: 'running',
  createdAt: 1,
  lastActivityAt: 1,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
}

const ask: Ask = {
  id: 'ask-release',
  spec: {
    title: 'Release approval',
    questions: [{ id: 'approval', question: 'Approve this release?', type: 'select', required: true, options: [{ value: 'yes', label: 'Approve' }, { value: 'no', label: 'Decline' }] }]
  },
  sessionId: null,
  worktreeId: 'wt-api',
  createdAt: 1,
  envelope: { status: 'pending', askId: 'ask-release', answers: {}, skipped: [], summary: '' },
  seq: 1,
  queued: false,
  partial: {},
  expiresAt: null
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let createRoot: typeof ReactCreateRoot
let PageApp: typeof PageAppComponent

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ PageApp } = await import('../src/pages/PageApp'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

type Call = { method: string; params: Record<string, unknown> }
function fakeBridge(options: { route?: MobilePageBridge['init']['route']; worktrees?: Worktree[]; sessions?: Session[]; asks?: Ask[]; answerError?: string } = {}) {
  let worktrees = options.worktrees ?? [makeWorktree('wt-api', 'api-payments'), makeWorktree('wt-web', 'web-shell', { repoId: 'repo-web' })]
  let sessions = options.sessions ?? [session]
  let asks = options.asks ?? []
  const calls: Call[] = []
  const navigations: unknown[] = []
  const storage = new Map<string, string>()
  let connectionState: MobilePageBridge['state'] = { phase: 'connected', attempts: 0 }
  const stateHandlers = new Set<(state: MobilePageBridge['state']) => void>()
  const bridge = {
    init: {
      v: 1,
      sessionId: 'page-session',
      host: { id: 'host-1', name: 'Desk', endpoint: 'wss://desk.invalid/rpc', publicKeyB64: 'public-key', lastConnected: 1 },
      route: options.route ?? { kind: 'workspaces' },
      grants: ['rpc', 'terminal', 'storage', 'navigate'],
      preferences: {
        sessionView: 'terminal', onboardingCompleted: true, notificationChoice: 'disabled',
        terminalTextScale: 1, autocomplete: false, terminalLinkMode: 'desktop', shortcuts: []
      },
      connectionState: { phase: 'connected', attempts: 0 },
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 }
    },
    get state() { return connectionState },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      let result: unknown
      switch (method) {
        case 'quirky.repo/list': result = [repo, { ...repo, id: 'repo-web', name: 'web', path: '/repos/web' }]; break
        case 'quirky.repo/groupList': result = []; break
        case 'quirky.worktree/list': result = worktrees; break
        case 'quirky.worktree/show': result = { ...worktrees.find((item) => item.id === params.worktree), children: [] }; break
        case 'quirky.session/list': result = params.worktree === undefined ? sessions : sessions.filter((item) => item.worktreeId === params.worktree); break
        case 'quirky.ask/list': result = asks; break
        case 'quirky.mobile/agentCatalog': result = { defaultAgent: 'codex', agents: [{ id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true, resumable: false }] }; break
        case 'quirky.worktree/describeRemove': result = 'This will remove the selected workspace and its sessions.'; break
        case 'quirky.worktree/remove':
          worktrees = worktrees.filter((item) => item.id !== params.worktree)
          result = { ok: true, removed: [String(params.worktree)] }
          break
        case 'quirky.worktree/set':
          worktrees = worktrees.map((item) => item.id === params.worktree ? { ...item, pinned: params.pinned === true } : item)
          result = worktrees.find((item) => item.id === params.worktree)
          break
        case 'quirky.ask/answer':
          if (options.answerError) {
            asks = asks.map((item): Ask => item.id === params.askId ? { ...item, envelope: { ...item.envelope, status: 'timed_out' } } : item)
            throw new Error(options.answerError)
          }
          asks = asks.filter((item) => item.id !== params.askId)
          result = { status: 'answered', askId: params.askId, answers: params.answers, skipped: [], summary: 'Approve this release?: Approve' }
          break
        default: throw new Error(`Unexpected page RPC ${method}`)
      }
      return result as T
    },
    onEvent: (_handler: (event: { event: string; data: unknown }) => void) => () => {},
    onStream: (_streamId: number, _handler: (bytes: Uint8Array) => void) => () => {},
    onState(handler: (state: MobilePageBridge['state']) => void) {
      stateHandlers.add(handler)
      return () => stateHandlers.delete(handler)
    },
    storage: {
      async get(key: string) { return storage.get(key) ?? null },
      async set(key: string, value: string) { storage.set(key, value) },
      async remove(key: string) { storage.delete(key) }
    },
    native: { async clipboardRead() { return '' }, async clipboardWrite() {}, async openExternal() {}, async haptic() {} },
    async navigate(route: unknown) { navigations.push(route) },
    report: (state: Record<string, unknown>) => validatePageReport(state),
    close: () => {}
  } as unknown as MobilePageBridge
  const setConnection = (state: MobilePageBridge['state']) => {
    connectionState = state
    for (const handler of stateHandlers) handler(state)
  }
  return { bridge, calls, navigations, storage, setConnection }
}

async function mount(bridge: MobilePageBridge): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PageApp, { bridge }))
  })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}
async function inputValue(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!input) throw new Error(`No field matches ${selector}`)
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button named ${name}`)
  return button
}

test('workspace search filters rendered worktrees and opening uses the selected real worktree ID', async () => {
  const { bridge, navigations } = fakeBridge()
  await mount(bridge)

  await click(buttonNamed('Search'))
  await inputValue('input[placeholder="Search workspaces"]', 'payments')
  expect(container?.textContent).toContain('api-payments')
  expect(container?.textContent).not.toContain('web-shell')

  await click(buttonNamed('Open api-payments'))
  expect(navigations).toContainEqual({ kind: 'session', worktreeId: 'wt-api' })
})
test('bridge connection updates disable workspace mutations immediately', async () => {
  const { bridge, setConnection, calls } = fakeBridge()
  await mount(bridge)

  await act(async () => {
    setConnection({ phase: 'disconnected', attempts: 1 })
  })

  expect(container?.textContent).toContain('Disconnected')
  expect(buttonNamed('New workspace').disabled).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
})
test('excluding the default branch does not bypass an active workspace search', async () => {
  const main = makeWorktree('wt-main', 'api-main', { isMain: true })
  const { bridge } = fakeBridge({ worktrees: [makeWorktree('wt-feature', 'api-feature'), main] })
  await mount(bridge)

  await click(buttonNamed('Workspace options'))
  const exceptDefault = [...document.querySelectorAll<HTMLLabelElement>('.qp-filter-toggle')].find((label) => label.textContent?.includes('Except default branch'))?.querySelector('input')
  if (!exceptDefault) throw new Error('Missing default-branch filter')
  await act(async () => {
    exceptDefault.checked = true
    exceptDefault.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(buttonNamed('Done'))
  await click(buttonNamed('Search'))
  await inputValue('input[placeholder="Search workspaces"]', 'feature')

  expect(container?.textContent).toContain('api-feature')
  expect(container?.textContent).not.toContain('api-main')
})

test('workspace sheets trap Tab focus inside the dialog', async () => {
  const { bridge } = fakeBridge()
  await mount(bridge)

  await click(buttonNamed('New workspace'))
  const dialog = document.querySelector('[role="dialog"]')
  const buttons = dialog?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  const first = buttons?.[0]
  const last = buttons?.[buttons.length - 1]
  if (!first || !last) throw new Error('Workspace dialog has no keyboard controls')
  last.focus()
  await act(async () => {
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  })
  expect(document.activeElement).toBe(first)
})

test('workspace removal asks the daemon for its preflight and waits for explicit confirmation', async () => {
  const { bridge, calls } = fakeBridge()
  await mount(bridge)

  await click(buttonNamed('Workspace actions for api-payments'))
  await click(buttonNamed('Delete workspace'))
  expect(calls).toContainEqual({ method: 'quirky.worktree/describeRemove', params: { worktree: 'wt-api' } })
  expect(calls.some((call) => call.method === 'quirky.worktree/remove')).toBe(false)
  expect(container?.textContent).toContain('This will remove the selected workspace')

  await click(buttonNamed('Confirm delete workspace'))
  expect(calls).toContainEqual({ method: 'quirky.worktree/remove', params: { worktree: 'wt-api', yes: true } })
})

test('a scoped ask sends the selected typed answer through quirky.ask/answer', async () => {
  const { bridge, calls } = fakeBridge({ route: { kind: 'session', worktreeId: 'wt-api' }, sessions: [], asks: [ask] })
  await mount(bridge)

  expect(container?.textContent).toContain('Approve this release?')
  await click(buttonNamed('Approve'))
  await click(buttonNamed('Submit answer'))

  expect(calls).toContainEqual({
    method: 'quirky.ask/answer',
    params: { askId: 'ask-release', answers: { approval: { value: 'yes', label: 'Approve', source: 'option' } }, skipped: [] }
  })
})

test('new tab presents curated agent choices', async () => {
  const { bridge } = fakeBridge({ route: { kind: 'session', worktreeId: 'wt-api' }, sessions: [] })
  await mount(bridge)

  await click(buttonNamed('New Tab'))

  expect(buttonNamed('Codex')).toBeInstanceOf(HTMLButtonElement)
})

test('agent asks submit every supported answer type using the protocol answer schema', async () => {
  const typedAsk: Ask = {
    ...ask,
    id: 'ask-all-types',
    spec: {
      title: 'Release details',
      questions: [
        { id: 'release', header: 'Release type', question: 'Choose a release type.', type: 'select', required: true, options: [{ value: 'stable', label: 'Stable' }] },
        { id: 'custom', header: 'Custom type', question: 'Enter another type.', type: 'select', required: true, options: [{ value: 'other', label: 'Other' }] },
        { id: 'channels', header: 'Channels', question: 'Choose channels.', type: 'multiselect', required: true, options: [{ value: 'beta', label: 'Beta' }, { value: 'stable', label: 'Stable' }] },
        { id: 'notes', header: 'Notes', question: 'What is changing?', type: 'text', required: true, multiline: true },
        { id: 'count', header: 'Count', question: 'How many?', type: 'number', required: true, integer: true, min: 1, max: 5 },
        { id: 'shipDate', header: 'Ship date', question: 'When?', type: 'date', required: true },
        { id: 'approved', header: 'Approved', question: 'Is this approved?', type: 'confirm', required: true }
      ]
    },
    partial: {}
  }
  const { bridge, calls } = fakeBridge({ route: { kind: 'session', worktreeId: 'wt-api' }, sessions: [], asks: [typedAsk] })
  await mount(bridge)

  await click(buttonNamed('Stable'))
  await inputValue('input[aria-label="Other answer or note for Release type"]', 'security patch')
  await inputValue('input[aria-label="Other answer or note for Custom type"]', 'canary')
  const channel = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!channel) throw new Error('Missing multiselect option')
  await act(async () => {
    channel.click()
  })
  await inputValue('input[aria-label="Other answer for Channels"]', 'nightly')
  await inputValue('textarea[aria-label="Notes"]', 'Ships today')
  await inputValue('input[aria-label="Count"]', '3')
  await inputValue('input[aria-label="Ship date"]', '2026-10-28')
  await click(buttonNamed('No'))
  await click(buttonNamed('Submit answer'))

  const answerCall = calls.find((call) => call.method === 'quirky.ask/answer')
  expect(answerCall?.params).toEqual({
    askId: 'ask-all-types',
    answers: {
      release: { value: 'stable', label: 'Stable', note: 'security patch', source: 'option' },
      custom: { value: 'canary', source: 'other' },
      channels: { values: ['beta'], labels: ['Beta'], other: 'nightly', source: 'options' },
      notes: { value: 'Ships today', source: 'input' },
      count: { value: 3, source: 'input' },
      shipDate: { value: '2026-10-28', source: 'input' },
      approved: { value: false, source: 'input' }
    },
    skipped: []
  })
})

test('an answer conflict refreshes the authoritative expired ask state', async () => {
  const expiredAsk = { ...ask, expiresAt: null }
  const { bridge, calls } = fakeBridge({
    route: { kind: 'session', worktreeId: 'wt-api' },
    sessions: [],
    asks: [expiredAsk],
    answerError: 'ask expired'
  })
  await mount(bridge)

  await click(buttonNamed('Approve'))
  await click(buttonNamed('Submit answer'))

  expect(calls).toContainEqual({ method: 'quirky.ask/list', params: { pendingOnly: false } })
  expect(container?.textContent).toContain('Expired')
  expect(container?.textContent).toContain('ask expired')
})
