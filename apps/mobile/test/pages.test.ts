import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import type { Ask, MobileMarkdownDocument, MobileWorkspaceTab, Repo, Session, Worktree, WorkspaceOriginView } from '@quirky/protocol'
import type { MobilePageBridge } from '../src/contracts'
import { validatePageReport, validatePageRpc } from '../src/shell/bridge-policy'
import { DEFAULT_WORKSPACE_PREFERENCES, workspacePreferencesKey } from '../src/pages/storage'
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
function fakeBridge(options: {
  route?: MobilePageBridge['init']['route']
  worktrees?: Worktree[]
  sessions?: Session[]
  asks?: Ask[]
  sessionTabs?: MobileWorkspaceTab[]
  answerError?: string
  loopSummaries?: unknown
  origins?: WorkspaceOriginView[]
  summaryError?: string
  summaryProvider?: () => Promise<unknown>
} = {}) {
  let worktrees = options.worktrees ?? [makeWorktree('wt-api', 'api-payments'), makeWorktree('wt-web', 'web-shell', { repoId: 'repo-web' })]
  let sessions = options.sessions ?? [session]
  let asks = options.asks ?? []
  let sessionTabs = options.sessionTabs ?? []
  const documents = new Map<string, MobileMarkdownDocument>()
  let loopSummaries = options.loopSummaries ?? []
  let summaryError = options.summaryError
  const calls: Call[] = []
  const reports: Record<string, unknown>[] = []
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
        case 'quirky.worktree/origins': result = options.origins ?? []; break
        case 'quirky.session/workspaceSleepStates': result = []; break
        case 'quirky.worktree/show': result = { ...worktrees.find((item) => item.id === params.worktree), children: [] }; break
        case 'quirky.session/list': result = params.worktree === undefined ? sessions : sessions.filter((item) => item.worktreeId === params.worktree); break
        case 'quirky.ask/list': result = asks; break
        case 'quirky.mobile/agentCatalog': result = { defaultAgent: 'codex', agents: [{ id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true, resumable: false }] }; break
        case 'quirky.mobile/sessionTabs': result = sessionTabs; break
        case 'quirky.mobile/markdownCreate': {
          const tabId = 'actual-markdown-tab'
          const worktreeId = String(params.worktree)
          const document: MobileMarkdownDocument = {
            tabId, worktreeId, title: 'Phone note.md', relativePath: 'Phone note.md',
            text: '', revision: 1, dirty: false, readOnly: false
          }
          documents.set(tabId, document)
          sessionTabs = [...sessionTabs, { tabId, worktreeId, kind: 'markdown', title: document.title, dirty: false }]
          result = document
          break
        }
        case 'quirky.mobile/markdownRead': {
          const document = documents.get(String(params.tabId))
          if (!document) throw new Error('Markdown tab not found')
          result = document
          break
        }
        case 'quirky.mobile/markdownWrite': {
          const document = documents.get(String(params.tabId))
          if (!document || params.expectedRevision !== document.revision) throw new Error('stale Markdown revision')
          const next = { ...document, text: String(params.text), revision: document.revision + 1, dirty: true }
          documents.set(next.tabId, next)
          sessionTabs = sessionTabs.map((tab) => tab.tabId === next.tabId ? { ...tab, dirty: true } : tab)
          result = next
          break
        }
        case 'quirky.mobile/markdownSave': {
          const document = documents.get(String(params.tabId))
          if (!document || params.expectedRevision !== document.revision) throw new Error('stale Markdown revision')
          const next = { ...document, revision: document.revision + 1, dirty: false }
          documents.set(next.tabId, next)
          sessionTabs = sessionTabs.map((tab) => tab.tabId === next.tabId ? { ...tab, dirty: false } : tab)
          result = next
          break
        }
        case 'quirky.mobile/sessionTabAction': {
          const document = documents.get(String(params.tabId))
          if (params.action === 'rename' && document) {
            const next = { ...document, title: String(params.name) }
            documents.set(next.tabId, next)
            sessionTabs = sessionTabs.map((tab) => tab.tabId === next.tabId ? { ...tab, title: next.title } : tab)
            result = { tabId: params.tabId, closed: false }
          } else if (params.action === 'close' && document) {
            if (document.dirty && params.discard !== true) result = { tabId: params.tabId, closed: false }
            else {
              documents.delete(document.tabId)
              sessionTabs = sessionTabs.filter((tab) => tab.tabId !== document.tabId)
              result = { tabId: params.tabId, closed: true }
            }
          } else {
            result = { tabId: params.tabId, closed: false }
          }
          break
        }
        case 'quirky.loops/summaries':
          if (options.summaryProvider) result = await options.summaryProvider()
          else if (summaryError) throw new Error(summaryError)
          else result = loopSummaries
          break
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
    report: (state: Record<string, unknown>) => {
      validatePageReport(state)
      reports.push(state)
    },
    close: () => {}
  } as unknown as MobilePageBridge
  const setConnection = (state: MobilePageBridge['state']) => {
    connectionState = state
    for (const handler of stateHandlers) handler(state)
  }
  return {
    bridge, calls, navigations, storage, reports, setConnection,
    setLoopSummaries(value: unknown) { loopSummaries = value },
    setSummaryError(value: string | null) { summaryError = value ?? undefined }
  }
}
async function mount(bridge: MobilePageBridge): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PageApp, { bridge }))
  })
}

async function unmountPage(): Promise<void> {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
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

test('automation loop summaries render in both layouts and only sanitized labels enter the page report', async () => {
  const worktrees = [
    makeWorktree('wt-needs-you', 'needs-you'),
    makeWorktree('wt-paused', 'paused'),
    makeWorktree('wt-running', 'running')
  ]
  const summaries = [
    { id: 'loop-running-new', worktreeId: 'wt-needs-you', state: 'running', pauseReason: null, iterationsCompleted: 9, maxIterations: 10, updatedAt: 100 },
    { id: 'loop-needs-you', worktreeId: 'wt-needs-you', state: 'needs-you', pauseReason: null, iterationsCompleted: 4, maxIterations: 8, updatedAt: 2 },
    { id: 'loop-paused', worktreeId: 'wt-paused', state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 2, maxIterations: 2, updatedAt: 3 },
    { id: 'loop-uncapped', worktreeId: 'wt-running', state: 'running', pauseReason: null, iterationsCompleted: 3, maxIterations: null, updatedAt: 4, prompt: 'private prompt' }
  ]
  const { bridge, reports } = fakeBridge({ worktrees, loopSummaries: summaries })
  await mount(bridge)

  expect(container?.textContent).toContain('Loop 4/8 · needs-you')
  expect(container?.textContent).toContain('Loop 2/2 · paused: iteration cap reached')
  expect(container?.textContent).toContain('Loop 3 · running')
  expect(reports.at(-1)).toMatchObject({
    loopSummaryStatus: 'available',
    loopSummaries: [
      { worktreeId: 'wt-needs-you', loopId: 'loop-needs-you', label: 'Loop 4/8 · needs-you' },
      { worktreeId: 'wt-paused', loopId: 'loop-paused', label: 'Loop 2/2 · paused: iteration cap reached' },
      { worktreeId: 'wt-running', loopId: 'loop-uncapped', label: 'Loop 3 · running' }
    ]
  })
  expect(JSON.stringify(reports.at(-1))).not.toContain('private prompt')

  await click(buttonNamed('Workspace options'))
  await click(buttonNamed('Compact'))
  await click(buttonNamed('Done'))
  expect(container?.textContent).toContain('Loop 4/8 · needs-you')
  expect(container?.textContent).toContain('Loop 2/2 · paused: iteration cap reached')
})

test('an unavailable loop provider does not prevent the workspace catalog from loading', async () => {
  const { bridge } = fakeBridge({ summaryError: 'unknown loop summary method' })
  await mount(bridge)

  expect(container?.textContent).toContain('api-payments')
  expect(container?.textContent).toContain('web-shell')
  expect(container?.textContent).not.toContain('Could not load workspaces')
  expect(container?.textContent).not.toContain('Loop ')
})

test('malformed loop summaries are unavailable without breaking the workspace page', async () => {
  const { bridge, reports } = fakeBridge({ loopSummaries: [{ id: 'bad-loop', state: 'running' }] })
  await mount(bridge)

  expect(container?.textContent).toContain('api-payments')
  expect(container?.textContent).not.toContain('Loop ')
  expect(reports.at(-1)).toMatchObject({ loopSummaryStatus: 'unavailable', loopSummaries: [] })
})

test('cached loop summaries become unverifiable on disconnect and read failure, then clear after a successful empty read', async () => {
  const { bridge, calls, reports, setConnection, setLoopSummaries, setSummaryError } = fakeBridge({
    loopSummaries: [{ id: 'loop-cache', worktreeId: 'wt-api', state: 'running', pauseReason: null, iterationsCompleted: 3, maxIterations: 10, updatedAt: 1 }]
  })
  await mount(bridge)
  expect(container?.textContent).toContain('Loop 3/10 · running')

  await act(async () => setConnection({ phase: 'disconnected', attempts: 1 }))
  expect(container?.textContent).toContain('Loop 3/10 · unverifiable')

  setSummaryError('loop plugin is unavailable')
  await act(async () => setConnection({ phase: 'connected', attempts: 0 }))
  expect(container?.textContent).toContain('Loop 3/10 · unverifiable')

  setSummaryError(null)
  setLoopSummaries([{ id: 'loop-refreshed', worktreeId: 'wt-api', state: 'running', pauseReason: null, iterationsCompleted: 4, maxIterations: 10, updatedAt: 2 }])
  await act(async () => setConnection({ phase: 'disconnected', attempts: 1 }))
  await act(async () => setConnection({ phase: 'connected', attempts: 0 }))
  expect(container?.textContent).toContain('Loop 4/10 · running')

  setLoopSummaries([])
  await act(async () => setConnection({ phase: 'disconnected', attempts: 1 }))
  await act(async () => setConnection({ phase: 'connected', attempts: 0 }))
  expect(container?.textContent).not.toContain('Loop 4/10')
  expect(reports.at(-1)).toMatchObject({ loopSummaryStatus: 'available', loopSummaries: [] })
  expect(calls.filter((call) => call.method === 'quirky.loops/summaries')).toHaveLength(4)
})

test('older summary responses cannot replace newer refreshes or update an unmounted page', async () => {
  const stale = Promise.withResolvers<unknown>()
  const afterUnmount = Promise.withResolvers<unknown>()
  let summaryReads = 0
  const { bridge, reports, setConnection } = fakeBridge({
    summaryProvider: () => {
      summaryReads += 1
      if (summaryReads === 1) return stale.promise
      if (summaryReads === 2) return Promise.resolve([
        { id: 'loop-current', worktreeId: 'wt-api', state: 'running', pauseReason: null, iterationsCompleted: 6, maxIterations: null, updatedAt: 2 }
      ])
      return afterUnmount.promise
    }
  })
  await mount(bridge)
  await act(async () => setConnection({ phase: 'disconnected', attempts: 1 }))
  await act(async () => setConnection({ phase: 'connected', attempts: 0 }))
  expect(container?.textContent).toContain('Loop 6 · running')

  await act(async () => {
    stale.resolve([{ id: 'loop-stale', worktreeId: 'wt-api', state: 'needs-you', pauseReason: null, iterationsCompleted: 1, maxIterations: 1, updatedAt: 1 }])
    await Promise.resolve()
  })
  expect(container?.textContent).toContain('Loop 6 · running')
  expect(container?.textContent).not.toContain('loop-stale')

  await act(async () => setConnection({ phase: 'disconnected', attempts: 1 }))
  await act(async () => setConnection({ phase: 'connected', attempts: 0 }))
  const reportsBeforeUnmount = reports.length
  await unmountPage()
  await act(async () => {
    afterUnmount.resolve([{ id: 'loop-after-unmount', worktreeId: 'wt-api', state: 'needs-you', pauseReason: null, iterationsCompleted: 1, maxIterations: 1, updatedAt: 3 }])
    await Promise.resolve()
  })
  expect(reports).toHaveLength(reportsBeforeUnmount)
})

test('page bridge rejects widened summary requests and loop controller access', () => {
  const workspaceRoute = { kind: 'workspaces' } as const
  const artifactRoute = { kind: 'terminal-artifacts', worktreeId: 'wt-api', sessionId: 'session-api' } as const

  expect(() => validatePageRpc('quirky.loops/summaries', {}, [], workspaceRoute)).toThrow(/rpc grant/i)
  expect(() => validatePageRpc('quirky.loops/summaries', {}, ['rpc'], artifactRoute)).toThrow()
  for (const params of [{ worktree: 'wt-api' }, { includeEnded: true }, { token: 'secret' }]) {
    expect(() => validatePageRpc('quirky.loops/summaries', params, ['rpc'], workspaceRoute)).toThrow()
  }
  for (const method of ['quirky.loops/list', 'quirky.loops/get', 'quirky.loops/history', 'quirky.loops/iterations', 'quirky.loops/create', 'quirky.loops/stop']) {
    expect(() => validatePageRpc(method, {}, ['rpc'], workspaceRoute)).toThrow()
  }
})

test('automation-created workspace filtering uses durable origins and persists its option', async () => {
  const provenance = {
    kind: 'created-by-automation' as const,
    automationId: 'automation-1',
    automationName: 'Nightly',
    runId: 'run-1',
    runTitle: 'Nightly run',
    projectId: repo.id,
    hostId: 'local' as const
  }
  const worktrees = [
    makeWorktree('wt-origin-main', 'planner-main', { isMain: true, automationProvenance: provenance }),
    makeWorktree('wt-origin-feature', 'planner-feature', { automationProvenance: provenance }),
    makeWorktree('wt-auto-prefix', 'automated-by-a-person'),
    makeWorktree('wt-cli', 'cli-created', { createdBy: 'cli' })
  ]
  const origins: WorkspaceOriginView[] = [
    { worktreeId: 'wt-origin-main', automation: true, otherClient: null },
    { worktreeId: 'wt-origin-feature', automation: true, otherClient: null }
  ]
  const { bridge, storage } = fakeBridge({ worktrees, origins })
  const preferenceKey = workspacePreferencesKey('host-1')
  storage.set(preferenceKey, JSON.stringify({
    ...DEFAULT_WORKSPACE_PREFERENCES,
    filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters, exceptDefaultBranch: true }
  }))
  await mount(bridge)

  await click(buttonNamed('Workspace options'))
  const checkbox = [...document.querySelectorAll<HTMLLabelElement>('.qp-filter-toggle')]
    .find((label) => label.textContent?.includes('Hide automation-created'))?.querySelector('input')
  if (!checkbox) throw new Error('Missing automation-created filter')
  expect(checkbox.disabled).toBe(false)
  await act(async () => {
    checkbox.click()
  })
  await click(buttonNamed('Done'))

  expect(container?.textContent).toContain('planner-main')
  expect(container?.textContent).not.toContain('planner-feature')
  expect(container?.textContent).toContain('automated-by-a-person')
  expect(container?.textContent).toContain('cli-created')
  const saved = JSON.parse(storage.get(preferenceKey) ?? '{}') as { filters?: { hideAutomationCreated?: boolean } }
  expect(saved.filters?.hideAutomationCreated).toBe(true)

  await unmountPage()
  await mount(bridge)
  expect(container?.textContent).toContain('planner-main')
  expect(container?.textContent).not.toContain('planner-feature')
  await click(buttonNamed('Workspace options'))
  const reloadedCheckbox = [...document.querySelectorAll<HTMLLabelElement>('.qp-filter-toggle')]
    .find((label) => label.textContent?.includes('Hide automation-created'))?.querySelector('input')
  expect(reloadedCheckbox?.disabled).toBe(false)
  expect(reloadedCheckbox?.checked).toBe(true)
})

