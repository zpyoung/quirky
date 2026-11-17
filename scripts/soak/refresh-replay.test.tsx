import { afterAll, afterEach, expect, jest, test } from 'bun:test'
import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import { createNativeBrowserCapability } from '../../packages/ui/src/native-browser'
import type { act as ReactAct } from '../../packages/ui/node_modules/@types/react'
import type { Fake as GitFake } from '../../plugins/quirky.git/test/ui/panel-support'
import type { ReviewsState } from '../../plugins/quirky.reviews/src/contracts'
import type { TasksState } from '../../plugins/quirky.tasks/src/contracts'
import type { PanelState, SessionInfo } from '../../plugins/quirky.session-info/src/types'
import type { PanelKey, PanelRequestRecord, PanelRefreshRecord, SoakConfig, SoakReport, WindowBeat } from './contracts'
import type { SoakEvidence } from './verdict'
import { DEFAULT_LIMITS, MAX_PANEL_REFRESHES_PER5S } from './contracts'
import { isPanelRefreshRequest, judge, panelOfRequest } from './verdict'
import { registerDom } from '../../plugins/quirky.git/test/ui/register-dom'

// root scripts resolve DOM and React through the UI workspace's existing dependencies
const uiDir = `${import.meta.dir}/../../packages/ui`
const { GlobalRegistrator } = await import(Bun.resolveSync('@happy-dom/global-registrator', uiDir))
const ownsDom = !GlobalRegistrator.isRegistered

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// ReactDOM and plugin UI modules must load only after happy-dom installs window globals.
const { act }: { act: typeof ReactAct } = await import(Bun.resolveSync('react', uiDir))
const { fakeContext, layoutFor, statusOf } = await import('../../plugins/quirky.git/test/ui/panel-support')
const { activate: activateGit } = await import('../../plugins/quirky.git/src/ui')
const { activate: activateReviews } = await import('../../plugins/quirky.reviews/src/ui')
const { CHECKS_PANEL } = await import('../../plugins/quirky.reviews/src/contracts')
const { activate: activateEditor } = await import('../../plugins/quirky.editor/src/ui')
const { activate: activateTasks } = await import('../../plugins/quirky.tasks/src/ui')
const { TASKS_TOOL } = await import('../../plugins/quirky.tasks/src/contracts')
const { activate: activateSessionInfo } = await import('../../plugins/quirky.session-info/src/ui')

const GIT_PANEL = 'panel:quirky.git/source-control'
const GIT_STATUS_BAR = 'status-bar:quirky.git/ahead-behind'
const EDITOR_PANEL = 'panel:quirky.editor/explorer'
const SESSION_PANEL = 'panel:quirky.session-info/info'
const WORKTREE_A = '/work/tree-a'
const WORKTREE_B = '/work/tree-b'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const START_AT = -3_000

type ConnectionStatus = 'connected' | 'reconnecting'
type RecordedCall = { at: number; window: number; method: string; params: Record<string, unknown>; response?: unknown }
type RpcHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type SubscriptionOptions = { worktreeId?: string | null }
type Subscription = {
  listener: (event: QuirkyEvent) => void | Promise<void>
  options?: SubscriptionOptions
  active: boolean
}
type ReplayContext = {
  context: UiPluginContext
  provided: Map<string, unknown>
  setLayout(layout: UiLayout): void
  deliver(event: QuirkyEvent): void
  connect(status: ConnectionStatus): void
}
type ReplayWindow = {
  index: number
  worktree: string
  phase: 'review' | 'agents'
  calls: RecordedCall[]
  contexts: ReplayContext[]
  git: GitFake | null
  gitConnections: Set<(status: ConnectionStatus) => void>
  sessionId: string
}
type MountedContribution = { element: HTMLElement; reports: unknown[]; unmount(): void }
type GitMount = { panel: MountedContribution; statusBar: MountedContribution; unmount(): void }
type DeferredRpc = { promise: Promise<unknown>; resolve(value: unknown): void; reject(reason?: unknown): void }
type ReplayReport = Pick<SoakReport, 'verdict' | 'qualifies' | 'disqualified' | 'checks'>
type ReplayJudgment = { report: ReplayReport; calls: RecordedCall[] }

type TimerControls = typeof jest & {
  clearAllTimers(): void
  advanceTimersByTime(milliseconds: number): void
  setSystemTime(date: Date): void
}
const timers = jest as TimerControls
const mounted: MountedContribution[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function layoutForPhase(worktree: string, phase: 'review' | 'agents'): UiLayout {
  const layout = layoutFor(worktree)
  return {
    ...layout,
    tools: {
      open: phase === 'review'
        ? { 'left-bottom': TASKS_TOOL, 'right-bottom': CHECKS_PANEL, 'bottom-right': EDITOR_PANEL }
        : { 'left-bottom': TASKS_TOOL, 'right-bottom': SESSION_PANEL }
    }
  } as UiLayout
}

function newWindow(index: number, worktree = WORKTREE_A): ReplayWindow {
  return {
    index,
    worktree,
    phase: 'review',
    calls: [],
    contexts: [],
    git: null,
    gitConnections: new Set(),
    sessionId: 'session-a'
  }
}

function recordCall(window: ReplayWindow, method: string, params: Record<string, unknown>): RecordedCall {
  const call: RecordedCall = { at: Date.now(), window: window.index, method, params: { ...params } }
  window.calls.push(call)
  return call
}

function makeContext(
  window: ReplayWindow,
  pluginId: string,
  handler: RpcHandler = () => ({})
): ReplayContext {
  let layout = layoutForPhase(window.worktree, window.phase)
  const provided = new Map<string, unknown>()
  const subscriptions: Subscription[] = []
  const layoutListeners = new Set<(next: UiLayout) => void>()
  const connectionListeners = new Set<(status: ConnectionStatus) => void>()
  const connectionId = 100 + window.index
  const context = {
    pluginId,
    nativeBrowser: createNativeBrowserCapability(),
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, rawParams: unknown = {}) {
      const params = isRecord(rawParams) ? rawParams : {}
      const call = recordCall(window, method, params)
      if (method === 'ui.window.self') {
        const result = { connId: connectionId }
        call.response = result
        return result
      }
      if (method === 'ui.window.command.run') {
        const id = params.id
        const implementation = typeof id === 'string' ? provided.get(id) : undefined
        if (typeof implementation !== 'function') throw new Error(`No provided command ${String(id)} in window ${window.index}`)
        const result = { result: await (implementation as (args?: unknown) => unknown)(params.args) }
        call.response = result
        return result
      }
      const result = await handler(method, params)
      call.response = result
      return result
    },
    subscribe(listener: Subscription['listener'], options?: SubscriptionOptions) {
      const subscription: Subscription = { listener, options, active: true }
      subscriptions.push(subscription)
      return () => { subscription.active = false }
    },
    getLayout() { return layout },
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => { layoutListeners.delete(listener) }
    },
    onConnection(listener: (status: ConnectionStatus) => void) {
      connectionListeners.add(listener)
      return () => { connectionListeners.delete(listener) }
    },
    async executeCommand(id: string, args?: unknown) {
      const implementation = provided.get(id)
      if (typeof implementation === 'function') await (implementation as (input?: unknown) => unknown)(args)
    },
    async nativeDropPaths() { return null },
    async readClipboardText() { return '' },
    log() {},
    getSetting(name: string) {
      if (pluginId !== 'quirky.editor') return undefined
      const settings: Record<string, boolean | number | string> = {
        editorAutoSave: false, editorAutoSaveDelayMs: 1000, editorWordWrap: false, editorFontFamily: 'monospace',
        editorPreviewTabsEnabled: true, richMarkdownSpellcheckEnabled: false, markdownReviewToolsEnabled: false,
        showGitIgnoredFiles: false, followSymlinkedDirectories: false, editorFontZoomLevel: 0,
        editorMinimapEnabled: false, editorSidebarWidth: 280
      }
      return settings[name]
    },
    createCommandDrag() { throw new Error('command dragging is unavailable in the replay') },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    onStream() { return () => {} },
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  } as unknown as UiPluginContext
  const replayContext: ReplayContext = {
    context,
    provided,
    setLayout(next) {
      layout = next
      for (const listener of [...layoutListeners]) listener(next)
    },
    deliver(event) {
      const eventWorktree = 'worktreeId' in event && typeof event.worktreeId === 'string' ? event.worktreeId : undefined
      for (const subscription of subscriptions) {
        if (!subscription.active) continue
        const scope = subscription.options?.worktreeId
        if (scope !== undefined && eventWorktree !== undefined && eventWorktree !== scope) continue
        void subscription.listener(event)
      }
    },
    connect(status) { for (const listener of [...connectionListeners]) listener(status) }
  }
  window.contexts.push(replayContext)
  return replayContext
}

function activateGitWindow(window: ReplayWindow): GitFake {
  const fake = fakeContext(layoutForPhase(window.worktree, window.phase), 200 + window.index)
  fake.statuses[WORKTREE_A] = statusOf([], { branch: 'worker/base-a', head: HEAD_A })
  fake.statuses[WORKTREE_B] = statusOf([], { branch: 'worker/commit-b', head: HEAD_B })
  window.git = fake
  const call = fake.context.call.bind(fake.context)
  fake.context.call = async (method, params = {}) => {
    const recorded = recordCall(window, method, params)
    const result = await call(method, params)
    recorded.response = result
    return result
  }
  fake.context.onConnection = (listener) => {
    window.gitConnections.add(listener)
    return () => { window.gitConnections.delete(listener) }
  }
  activateGit(fake.context)
  return fake
}

function setLayout(window: ReplayWindow, worktree: string, phase: 'review' | 'agents'): void {
  window.worktree = worktree
  window.phase = phase
  const layout = layoutForPhase(worktree, phase)
  window.git?.setLayout(layout)
  for (const context of window.contexts) context.setLayout(layout)
}

async function emit(window: ReplayWindow, event: QuirkyEvent): Promise<void> {
  await act(async () => {
    window.git?.emit(event)
    for (const context of window.contexts) context.deliver(event)
  })
  await settle()
}

async function connect(window: ReplayWindow, status: ConnectionStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...window.gitConnections]) listener(status)
    for (const context of window.contexts) context.connect(status)
  })
  await settle()
}

function mountProvided(provided: Map<string, unknown>, id: string): MountedContribution {
  const implementation = provided.get(id)
  if (typeof implementation !== 'function') throw new Error(`Missing provided mount ${id}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: unknown[] = []
  let cleanup: (() => void) | void
  act(() => { cleanup = (implementation as MountFunction)(element, { report: (state) => reports.push(state) }) })
  let active = true
  const handle: MountedContribution = {
    element,
    reports,
    unmount() {
      if (!active) return
      active = false
      cleanup?.()
      element.remove()
    }
  }
  mounted.push(handle)
  return handle
}

async function mountGit(fake: GitFake): Promise<GitMount> {
  const panel = mountProvided(fake.provided, GIT_PANEL)
  const statusBar = mountProvided(fake.provided, GIT_STATUS_BAR)
  await settle()
  return {
    panel,
    statusBar,
    unmount() { panel.unmount(); statusBar.unmount() }
  }
}

async function unmountAll(): Promise<void> {
  await act(async () => { for (const contribution of mounted.splice(0)) contribution.unmount() })
  document.body.innerHTML = ''
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 7; turn += 1) await act(async () => {})
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => { timers.advanceTimersByTime(milliseconds) })
  await settle()
}

function changed(type: string, data: Record<string, unknown> = {}, worktreeId?: string): QuirkyEvent {
  return { type, data, ...(worktreeId === undefined ? {} : { worktreeId }) } as QuirkyEvent
}

function reviewsState(worktree: string | null, revision = 1): ReviewsState {
  const detail = {
    target: null, tab: 'conversation', audience: 'all', generation: 0, loading: false, error: null, review: null, details: null,
    checks: null, comments: null, files: null, expandedChecks: [], queuedComments: [], checksCollapsed: false,
    selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true,
    commentDraft: '', bodyDraft: null, pending: [], fetchedAt: 0
  }
  const checks = {
    worktree, generation: 0, loading: false, error: null,
    lookup: { kind: 'unsupported', reason: 'missing_origin' }, eligibility: null, review: null, checks: null, comments: null,
    conflicts: null, audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
    commentDraft: '', titleDraft: null, height: 320, fetchedAt: Date.now(), agentDialog: null
  }
  const creation = { worktree, generation: 0, loading: false, error: null, eligibility: null, title: '', body: '', base: '', head: '',
    draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false, bases: [], generating: false,
    requestId: null, submitting: false, generated: false, result: null, defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false } }
  const settings = { worktree, generation: 0, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0 }
  return { revision, previousView: null, detail, checks, creation, settings,
    defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    repoDefaults: {}, botOverrides: [], links: {}, suppressed: {} } as unknown as ReviewsState
}

function tasksState(): TasksState {
  return {
    revision: 1,
    navigation: { source: 'github', mode: 'prs', repoIds: null, query: 'is:pr is:open', page: 1, scrollTop: 0,
      detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:pr is:open', page: 1 } },
    preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
    issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
    projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
    links: {}
  }
}

function sessionState(session: string): PanelState {
  const workspace = session === 'session-b' ? WORKTREE_B : WORKTREE_A
  const info: SessionInfo = {
    identity: { agent: 'claude', sessionId: session, providerSessionId: `provider-${session}`, model: 'Claude Sonnet', pane: 'pane-1',
      paneTitle: 'Claude ready', worktreeId: workspace, cwd: '/repo', startedAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000,
      transcriptPath: '/tmp/session.jsonl' },
    liveActivity: { state: 'working', label: `Working ${session}`, toolName: 'Read', toolInput: 'src/index.ts', subagentCount: 2,
      startedAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000 },
    usage: { status: 'ready', freshness: 'stale', totalTokens: 1200, turnCount: 2, input: 300, output: 500,
      cacheRead: 200, cacheWrite: 200, updatedAt: 1_700_000_060_000, error: 'usage is stale' }
  }
  return { session, pane: 'pane-1', workspace, openSections: ['liveActivity', 'usage'], info }
}

function callsFor(window: ReplayWindow, method: string): RecordedCall[] {
  return window.calls.filter((call) => call.method === method)
}

function countedAt(window: ReplayWindow, method: string, worktree: string, at: number): number {
  return window.calls.filter((call) => call.method === method && call.params.worktree === worktree && call.at === at).length
}

function judgeReplay(windows: ReplayWindow[]): ReplayJudgment {
  const panelRefreshes: PanelRefreshRecord[] = []
  const panelRequests: PanelRequestRecord[] = []
  for (const window of windows) {
    for (const call of window.calls) {
      const seconds = call.at / 1000
      if (isPanelRefreshRequest(call.method, call.params)) {
        const worktree = typeof call.params.worktree === 'string' ? call.params.worktree : window.worktree
        panelRefreshes.push({ at: seconds, index: window.index, worktree, method: call.method })
      }
      const panel: PanelKey | null = panelOfRequest(call.method, call.params)
      if (panel !== null) panelRequests.push({ at: seconds, index: window.index, panel })
    }
  }
  const windowBeats: WindowBeat[] = windows.map((window) => ({
    worktree: window.worktree, open: true, shown: true, lastRequestAgeSeconds: 0
  }))
  const evidence: SoakEvidence = {
    durationSeconds: 1_800,
    windows: windows.length,
    windowBeats,
    samples: [],
    events: [],
    panelRefreshes,
    probes: [],
    workers: Array.from({ length: 7 }, (_, index) => ({ worktree: `worker-${index}`, lastBeatAgeSeconds: 0 })),
    daemonExited: false,
    windowRequestSeconds: windows.map(() => []),
    panelRequests,
    gitProbes: windows.map((window) => ({ at: 0, ms: 1, ownLagMs: 0, timedOut: false, failed: false, worktree: window.worktree })),
    day: { enabled: false, windows: [], worktrees: [] },
    switches: [], phases: [], taskInteractions: []
  }
  const config: SoakConfig = {
    minutes: 30, out: '/tmp/refresh-replay', windows: windows.length, limits: { ...DEFAULT_LIMITS }
  }
  return { report: judge(evidence, config), calls: windows.flatMap((window) => window.calls) }
}

function panelPeak(result: ReplayJudgment, panel: PanelKey): number {
  return Math.max(0, ...result.report.checks.refreshes.byPanel.filter((row) => row.panel === panel).map((row) => row.peakPer5s))
}

function assertBound(label: string, actual: number, bound: number, calls: RecordedCall[]): void {
  if (actual > bound) {
    throw new Error(`${label}: expected <= ${bound}, received ${actual}\nRPC attempts (time/window/method/params):\n${JSON.stringify(calls.map(({ at, window, method, params }) => ({ at, window, method, params })), null, 2)}`)
  }
}
function assertExactCount(label: string, actual: number, expected: number, calls: RecordedCall[]): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}\nRPC attempts (time/window/method/params):\n${JSON.stringify(calls.map(({ at, window, method, params }) => ({ at, window, method, params })), null, 2)}`)
  }
}

function assertSoakBounds(windows: ReplayWindow[]): void {
  const result = judgeReplay(windows)
  expect(result.report.checks.refreshes.limitPer5s).toBe(MAX_PANEL_REFRESHES_PER5S)
  assertBound('window refresh peak', result.report.checks.refreshes.peakPer5s, 7, result.calls)
  assertBound('Changes panel peak', panelPeak(result, 'changes'), 5, result.calls)
  assertBound('Checks panel peak', panelPeak(result, 'checks'), 7, result.calls)
  assertBound('Session info panel peak', panelPeak(result, 'session-info'), 5, result.calls)
  assertBound('Explorer panel peak', panelPeak(result, 'explorer'), 3, result.calls)
  assertBound('Tasks panel peak', panelPeak(result, 'tasks'), 4, result.calls)
}

function assertExtraBounds(windows: ReplayWindow[], reconnect: boolean): void {
  const result = judgeReplay(windows)
  expect(result.report.checks.refreshes.limitPer5s).toBe(8)
  assertBound('single-extra window peak', result.report.checks.refreshes.peakPer5s, 8, result.calls)
  assertBound('single-extra Changes peak', panelPeak(result, 'changes'), 6, result.calls)
  assertBound('single-extra Checks peak', panelPeak(result, 'checks'), reconnect ? 8 : 7, result.calls)
  assertBound('Explorer panel peak', panelPeak(result, 'explorer'), 3, result.calls)
  assertBound('Tasks panel peak', panelPeak(result, 'tasks'), 4, result.calls)
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('Expected replay button was not rendered')
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
}

async function unmountGit(git: GitMount): Promise<void> {
  await act(async () => git.unmount())
  await settle()
}

function gitRefreshControl(reports: unknown[]): Record<string, unknown> {
  const report = [...reports].reverse().find((value) => isRecord(value) && Array.isArray(value.uiControls))
  if (!isRecord(report) || !Array.isArray(report.uiControls)) throw new Error('Git panel has not published its refresh control')
  const control = report.uiControls.find((value) => isRecord(value) && Array.isArray(value.actions) && value.actions.includes('refresh'))
  if (!isRecord(control)) throw new Error('Git panel did not provide its refresh action')
  return { surface: control.surface, target: control.target, generation: control.generation, action: 'refresh' }
}

async function triggerGitBarrier(fake: GitFake, reports: unknown[], window: ReplayWindow): Promise<void> {
  const before = callsFor(window, 'quirky.git/status').length
  const implementation = fake.provided.get('command:quirky.git/ui-control')
  if (typeof implementation !== 'function') throw new Error('Git UI-control command was not provided')
  const result = implementation(gitRefreshControl(reports))
  if (!isRecord(result) || result.delivered !== true) throw new Error('Git refresh control was not delivered')
  await settle()
  assertExactCount('Git fresh barrier starts one immediate status read', callsFor(window, 'quirky.git/status').length, before + 1, window.calls)
}

async function mountReviewSurface(window: ReplayWindow, deferred?: {
  a: DeferredRpc
  b: DeferredRpc
  holdA: boolean
  holdB: boolean
}): Promise<{ context: ReplayContext; mount: MountedContribution }> {
  const context = makeContext(window, 'quirky.reviews', (method, params) => {
    if (method === 'quirky.reviews/state') {
      const target = typeof params.worktree === 'string' ? params.worktree : window.worktree
      return reviewsState(target, callsFor(window, method).length)
    }
    if (method === 'quirky.reviews/checksRefresh') {
      if (deferred?.holdA && params.worktree === WORKTREE_A) return deferred.a.promise
      if (deferred?.holdB && params.worktree === WORKTREE_B) return deferred.b.promise
      return { ok: true }
    }
    if (method === 'quirky.reviews/checksSitterGet') return { available: false }
    return {}
  })
  activateReviews(context.context)
  const mount = mountProvided(context.provided, CHECKS_PANEL)
  await settle()
  return { context, mount }
}

async function mountEditor(window: ReplayWindow): Promise<{ context: ReplayContext; mount: MountedContribution }> {
  const context = makeContext(window, 'quirky.editor', (method, params) => {
    if (method === 'quirky.git/status') return window.git?.statuses[String(params.worktree)] ?? statusOf()
    if (method === 'quirky.editor/documentRoot') return { id: `repo-${String(params.worktree)}`, path: `/repo/${String(params.worktree)}` }
    if (method === 'quirky.editor/explorer') return { path: params.path ?? '', entries: [] }
    if (method === 'quirky.worktree/list') return []
    return {}
  })
  activateEditor(context.context)
  const mount = mountProvided(context.provided, EDITOR_PANEL)
  await settle()
  return { context, mount }
}

async function mountTasks(window: ReplayWindow): Promise<{ context: ReplayContext; mount: MountedContribution }> {
  const state = tasksState()
  const context = makeContext(window, 'quirky.tasks', (method) => {
    if (method === 'quirky.tasks/state' || method === 'quirky.tasks/prepare') return state
    if (method === 'quirky.tasks/list') return { items: [], repositories: [], page: 1, totalPages: 1, perRepo: 0, failures: [], sources: {} }
    if (method === 'quirky.tasks/counts') return { issues: 0, prs: 0 }
    return {}
  })
  activateTasks(context.context)
  const mount = mountProvided(context.provided, TASKS_TOOL)
  await settle()
  return { context, mount }
}

function activateSession(window: ReplayWindow, inspect?: Promise<unknown>): ReplayContext {
  const context = makeContext(window, 'quirky.session-info', (method) => {
    if (method === 'quirky.session-info/get') return sessionState(window.sessionId)
    if (method === 'quirky.session-info/inspect' && inspect) return inspect
    if (method === 'quirky.session-info/sections') return { open: ['liveActivity', 'usage'] }
    return {}
  })
  activateSessionInfo(context.context)
  return context
}

async function runCombinedReplay(aCompletesBeforeSwitch: boolean): Promise<void> {
  timers.useFakeTimers()
  timers.setSystemTime(new Date(START_AT))
  const main = newWindow(0)
  const peer = newWindow(1)
  const mainGitFake = activateGitWindow(main)
  const peerGitFake = activateGitWindow(peer)
  let mainGit = await mountGit(mainGitFake)
  await mountGit(peerGitFake)
  const sessionContext = activateSession(main)
  const pendingA = Promise.withResolvers<unknown>()
  const pendingB = Promise.withResolvers<unknown>()
  const entry = { a: pendingA, b: pendingB, holdA: true, holdB: true }
  await settle()

  const initialPeer = countedAt(peer, 'quirky.git/status', WORKTREE_A, START_AT)
  assertExactCount('independent window owns its initial status read', initialPeer, 1, peer.calls)
  assertExactCount('main window owns its shared initial Git read', countedAt(main, 'quirky.git/status', WORKTREE_A, START_AT), 1, main.calls)
  await connect(main, 'connected')
  await connect(main, 'connected')
  await connect(peer, 'connected')
  await connect(peer, 'connected')

  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.git/changed', { worktreeId: WORKTREE_A }, WORKTREE_A))
    await emit(peer, changed('quirky.git/changed', { worktreeId: WORKTREE_A }, WORKTREE_A))
  }
  mainGitFake.statuses[WORKTREE_A] = statusOf([], { branch: 'worker/commit-a', head: 'c'.repeat(40) })
  await advance(2_990)
  const editor = await mountEditor(main)
  await mountTasks(main)
  const checksResult = await mountReviewSurface(main, entry)
  await settle()
  await mountReviewSurface(peer)
  assertExactCount('independent Checks activation reads and completes its own entry', callsFor(peer, 'quirky.reviews/state').length, 2, peer.calls)
  await connect(main, 'connected')
  await connect(main, 'connected')

  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.reviews/changed', { revision: index + 1, worktree: WORKTREE_A, loading: index % 2 === 0, completed: index % 2 === 1 }, WORKTREE_A))
  }
  if (aCompletesBeforeSwitch) {
    await act(async () => { pendingA.resolve({ ok: true }); await pendingA.promise })
    await settle()
  }
  await advance(10)
  mainGitFake.statuses[WORKTREE_B] = statusOf([], { branch: 'worker/commit-b', head: HEAD_B })
  peerGitFake.statuses[WORKTREE_B] = statusOf([], { branch: 'worker/commit-b', head: HEAD_B })
  await act(async () => {
    setLayout(main, WORKTREE_B, 'review')
    setLayout(peer, WORKTREE_B, 'review')
  })
  await settle()
  await emit(main, changed('quirky.hosting/reviewCacheChanged', { worktreeId: WORKTREE_B }, WORKTREE_B))
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.git/changed', { worktreeId: WORKTREE_B }, WORKTREE_B))
    await emit(peer, changed('quirky.git/changed', { worktreeId: WORKTREE_B }, WORKTREE_B))
    await emit(main, changed('quirky.reviews/changed', { revision: index + 1, worktree: WORKTREE_B, loading: index % 2 === 0, completed: index % 2 === 1 }, WORKTREE_B))
  }
  if (!aCompletesBeforeSwitch) {
    await act(async () => { pendingB.resolve({ ok: true }); await pendingB.promise })
    await settle()
    await advance(5)
    await act(async () => { pendingA.resolve({ ok: true }); await pendingA.promise })
    entry.holdA = false
    await settle()
  } else {
    await act(async () => { pendingB.resolve({ ok: true }); await pendingB.promise })
    entry.holdB = false
    await settle()
  }
  await emit(main, changed('quirky.tasks/changed', { revision: 2 }))
  await advance(3_030 - Date.now())
  await advance(5_500 - Date.now())

  await act(async () => {
    checksResult.mount.unmount()
    editor.mount.unmount()
  })
  await settle()
  await act(async () => { setLayout(main, WORKTREE_B, 'agents') })
  await settle()
  await unmountGit(mainGit)
  mainGit = await mountGit(mainGitFake)
  const sessionMount = mountProvided(sessionContext.provided, SESSION_PANEL)
  await settle()
  await connect(main, 'connected')
  await advance(20)
  main.sessionId = 'session-b'
  await emit(main, changed('quirky.terminal/focusContextChanged', { workspace: WORKTREE_B }))
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.session/changed', { session: { id: 'session-b' } }))
    await emit(main, changed('quirky.agent-status/changed', { sessionId: 'session-b' }))
    await emit(main, changed('quirky.session-info/changed', { sessionId: null }))
  }
  await emit(main, changed('quirky.session-info/changed', { sessionId: 'another-session' }))
  await advance(1_490)
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.session/changed', { session: { id: 'session-b' } }))
    await emit(main, changed('quirky.session-info/changed', { sessionId: null }))
  }
  await advance(1_490)
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.agent-status/changed', { sessionId: 'session-b' }))
    await emit(main, changed('quirky.session-info/changed', { sessionId: null }))
  }
  await advance(1_490)
  await advance(11_000 - Date.now())

  expect(sessionMount.element.textContent).toContain('session-b')
  await act(async () => {
    sessionMount.unmount()
    setLayout(main, WORKTREE_B, 'review')
  })
  await settle()
  const checksAgainMount = mountProvided(checksResult.context.provided, CHECKS_PANEL)
  await settle()
  mountProvided(editor.context.provided, EDITOR_PANEL)
  await settle()
  await connect(main, 'connected')
  await emit(main, changed('quirky.reviews/changed', { worktree: WORKTREE_B }, WORKTREE_B))
  await advance(3_000)
  await settle()

  const gitReport = [...mainGit.panel.reports].reverse().find(isRecord)
  expect(gitReport).toMatchObject({ worktree: WORKTREE_B, branch: 'worker/commit-b' })
  const checksReport = [...checksAgainMount.reports].reverse().find(isRecord)
  expect(checksReport).toMatchObject({ worktree: WORKTREE_B })
  const externalHead = main.calls.find((call) =>
    call.method === 'quirky.git/status' && call.params.worktree === WORKTREE_A && call.at === 0)
  expect(externalHead?.response).toMatchObject({ branch: 'worker/commit-a', head: 'c'.repeat(40) })
  const finalHead = [...main.calls].reverse().find((call) =>
    call.method === 'quirky.git/status' && call.params.worktree === WORKTREE_B && isRecord(call.response))
  expect(finalHead?.response).toMatchObject({ branch: 'worker/commit-b', head: HEAD_B })
  expect(sessionMount.reports.at(-1)).toMatchObject({ session: 'session-b' })
  expect(callsFor(main, 'quirky.editor/explorer').filter((call) => call.params.action === 'list').length).toBeLessThanOrEqual(3)
  assertExactCount('soak workload Session info starts', callsFor(main, 'quirky.session-info/get').length, 5, main.calls)
  assertSoakBounds([main, peer])

  const callsBeforeRelease = main.calls.length + peer.calls.length
  await unmountAll()
  await advance(10_000)
  expect(main.calls.length + peer.calls.length).toBe(callsBeforeRelease)
}

for (const aCompletesBeforeSwitch of [true, false]) {
  test(`combined contribution replay preserves bounds when A entry completes ${aCompletesBeforeSwitch ? 'before' : 'after'} the switch`, async () => {
    await runCombinedReplay(aCompletesBeforeSwitch)
  })
}

async function runBarrierReplay(barrierAt: number, reconnect = false): Promise<void> {
  timers.useFakeTimers()
  timers.setSystemTime(new Date(START_AT))
  const main = newWindow(0)
  const peer = newWindow(1)
  const mainGitFake = activateGitWindow(main)
  const peerGitFake = activateGitWindow(peer)
  const mainGitMount = await mountGit(mainGitFake)
  await mountGit(peerGitFake)
  await settle()
  await advance(3_000)
  await mountEditor(main)
  await mountTasks(main)
  await mountReviewSurface(main)
  await settle()
  const performExtra = async () => {
    const before = callsFor(main, 'quirky.git/status').length
    if (reconnect) {
      await connect(main, 'reconnecting')
      await connect(main, 'connected')
      await emit(main, changed('quirky.reviews/changed', { worktree: main.worktree }, main.worktree))
    } else await triggerGitBarrier(mainGitFake, mainGitMount.panel.reports, main)
    assertExactCount('explicit/recovery Git read starts immediately', callsFor(main, 'quirky.git/status').length, before + 1, main.calls)
  }
  if (barrierAt < 20) {
    await advance(barrierAt)
    await performExtra()
    await advance(20 - barrierAt)
    await act(async () => { setLayout(main, WORKTREE_B, 'review'); setLayout(peer, WORKTREE_B, 'review') })
  } else {
    await advance(20)
    await act(async () => { setLayout(main, WORKTREE_B, 'review'); setLayout(peer, WORKTREE_B, 'review') })
    await settle()
    await advance(barrierAt - 20)
    await performExtra()
  }
  await settle()
  if (barrierAt >= 20 && barrierAt < 3_020) {
    const bStartAt = 3_020
    await advance(bStartAt - Date.now())
    assertExactCount(`fresh Git barrier at ${barrierAt}ms resets the prior B deadline`, countedAt(main, 'quirky.git/status', WORKTREE_B, bStartAt), 0, main.calls)
  }
  await advance(5_000 - Date.now())
  const result = judgeReplay([main, peer])
  expect(result.report.checks.refreshes.limitPer5s).toBe(8)
  assertBound(`fresh Git barrier window peak at ${barrierAt}ms`, result.report.checks.refreshes.peakPer5s, 8, result.calls)
  assertBound(`fresh Git barrier Changes peak at ${barrierAt}ms`, panelPeak(result, 'changes'), 6, result.calls)
  assertBound('Checks panel peak', panelPeak(result, 'checks'), reconnect ? 8 : 7, result.calls)
  assertBound('Explorer panel peak', panelPeak(result, 'explorer'), 3, result.calls)
  assertBound('Tasks panel peak', panelPeak(result, 'tasks'), 4, result.calls)
  const beforeRelease = main.calls.length + peer.calls.length
  await unmountAll()
  await advance(10_000)
  expect(main.calls.length + peer.calls.length).toBe(beforeRelease)
}

test('one fresh Git barrier stays separately within 8/6 across the switch, inclusive edge, and ordinary poll ±1ms', async () => {
  for (const at of [19, 20, 21, 1_999, 2_000, 2_001, 3_019, 3_020, 3_021]) {
    await unmountAll()
    await runBarrierReplay(at)
  }
})

test('one reconnect is counted on both sides of the switch and ordinary deadline ±1ms', async () => {
  for (const at of [19, 20, 21, 1_999, 2_000, 2_001, 3_019, 3_020, 3_021]) {
    await unmountAll()
    await runBarrierReplay(at, true)
  }
})

test('one reconnect stays within the separate 8/6/8 recovery bounds and resets automatic deadlines', async () => {
  timers.useFakeTimers()
  timers.setSystemTime(new Date(START_AT))
  const main = newWindow(0)
  const peer = newWindow(1)
  const mainGitFake = activateGitWindow(main)
  const peerGitFake = activateGitWindow(peer)
  await mountGit(mainGitFake)
  await mountGit(peerGitFake)
  await settle()
  await connect(main, 'connected')
  await connect(peer, 'connected')
  await advance(3_000)
  await mountEditor(main)
  await mountTasks(main)
  await mountReviewSurface(main)
  await settle()
  await connect(main, 'connected')
  await advance(20)
  await act(async () => { setLayout(main, WORKTREE_B, 'review'); setLayout(peer, WORKTREE_B, 'review') })
  await settle()
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(main, changed('quirky.git/changed', { worktreeId: WORKTREE_B }, WORKTREE_B))
    await emit(main, changed('quirky.reviews/changed', { revision: index + 1, worktree: WORKTREE_B, loading: index % 2 === 0, completed: index % 2 === 1 }, WORKTREE_B))
  }
  await advance(1_970)
  await connect(main, 'reconnecting')
  await connect(peer, 'reconnecting')
  await connect(main, 'connected')
  await connect(peer, 'connected')
  assertExactCount('reconnect immediately starts a fresh Git status read', countedAt(main, 'quirky.git/status', WORKTREE_B, 2_000), 1, main.calls)
  assertExactCount('reconnect immediately starts a fresh Checks state read', countedAt(main, 'quirky.reviews/state', WORKTREE_B, 2_000), 1, main.calls)
  await emit(main, changed('quirky.git/changed', { worktreeId: WORKTREE_B }, WORKTREE_B))
  await emit(main, changed('quirky.reviews/changed', { revision: 50, worktree: WORKTREE_B }, WORKTREE_B))
  await advance(4_999 - Date.now())
  assertExactCount('reconnect reset Git auto deadline past +3020', countedAt(main, 'quirky.git/status', WORKTREE_B, 3_020), 0, main.calls)
  assertExactCount('reconnect reset Reviews auto deadline past +3020', countedAt(main, 'quirky.reviews/state', WORKTREE_B, 3_020), 0, main.calls)
  await advance(1)

  assertExtraBounds([main, peer], true)
  const callsBeforeRelease = main.calls.length + peer.calls.length
  await unmountAll()
  await advance(10_000)
  expect(main.calls.length + peer.calls.length).toBe(callsBeforeRelease)
})

test('Session info Retry starts a fresh get beside inspection and resets the 1500ms event deadline', async () => {
  timers.useFakeTimers()
  timers.setSystemTime(new Date(0))
  const window = newWindow(0)
  window.phase = 'agents'
  const inspect = Promise.withResolvers<unknown>()
  const sessionContext = activateSession(window, inspect.promise)
  const mount = mountProvided(sessionContext.provided, SESSION_PANEL)
  await settle()
  await connect(window, 'connected')
  await connect(window, 'connected')
  await advance(20)
  window.sessionId = 'session-b'
  await emit(window, changed('quirky.terminal/focusContextChanged', { workspace: WORKTREE_B }))
  for (let index = 0; index < 10; index += 1) {
    await advance(1)
    await emit(window, changed('quirky.session-info/changed', { sessionId: null }))
    await emit(window, changed('quirky.session/changed', { session: { id: 'session-b' } }))
    await emit(window, changed('quirky.agent-status/changed', { sessionId: 'session-b' }))
  }
  await advance(1_490)
  await advance(480)
  const retryBaseline = callsFor(window, 'quirky.session-info/get').length
  await click(mount.element.querySelector('button[aria-label="Retry usage"]'))
  const afterRetry = callsFor(window, 'quirky.session-info/get').length
  assertExactCount('Session info Retry dispatches a fresh get before inspection resolves', afterRetry, retryBaseline + 1, window.calls)
  await advance(1)
  await emit(window, changed('quirky.session-info/changed', { sessionId: null }))
  await advance(999)
  assertExactCount('Retry reset the old automatic deadline', callsFor(window, 'quirky.session-info/get').length, afterRetry, window.calls)
  await advance(20)
  assertExactCount('Retry retired the old 1500ms deadline at +3020', callsFor(window, 'quirky.session-info/get').length, afterRetry, window.calls)
  await advance(480)
  assertExactCount('one queued Session read starts at the fresh 1500ms deadline', callsFor(window, 'quirky.session-info/get').length, afterRetry + 1, window.calls)
  await advance(1)
  await emit(window, changed('quirky.session-info/changed', { sessionId: 'another-session' }))
  await emit(window, changed('quirky.session-info/changed', { sessionId: null }))
  await advance(1_499)
  const result = judgeReplay([window])
  assertExactCount('Session info Retry inclusive-window count', callsFor(window, 'quirky.session-info/get').length, 6, window.calls)
  assertBound('Session info Retry recovery peak', panelPeak(result, 'session-info'), 6, result.calls)
  expect(mount.reports.at(-1)).toMatchObject({ session: 'session-b' })
  await act(async () => { inspect.resolve({ mcp: [], updatedAt: Date.now(), statusline: { state: 'available' } }); await inspect.promise })
  await settle()
  const beforeRelease = window.calls.length
  await unmountAll()
  await advance(5_000)
  expect(window.calls.length).toBe(beforeRelease)
})

afterEach(async () => {
  await unmountAll()
  timers.clearAllTimers()
  jest.useRealTimers()
})

afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister() })

for (const recovery of ['retry', 'reconnect'] as const) {
  test(`Session info ${recovery} stays within six reads around focus and automatic deadlines ±1ms`, async () => {
    for (const at of [19, 20, 21, 1_519, 1_520, 1_521, 1_999, 2_000, 2_001, 3_019, 3_020, 3_021]) {
      await unmountAll()
      timers.useFakeTimers()
      timers.setSystemTime(new Date(0))
      const main = newWindow(0)
      const peer = newWindow(1)
      main.phase = peer.phase = 'agents'
      peer.sessionId = 'peer-session'
      const inspection = Promise.withResolvers<unknown>()
      const owner = activateSession(main, inspection.promise)
      const other = activateSession(peer)
      const surface = mountProvided(owner.provided, SESSION_PANEL)
      await settle()
      const peerSurface = mountProvided(other.provided, SESSION_PANEL)
      await settle()
      assertExactCount('Session info cold main read', callsFor(main, 'quirky.session-info/get').length, 1, main.calls)
      assertExactCount('Session info independent activation read', callsFor(peer, 'quirky.session-info/get').length, 1, peer.calls)
      expect(peerSurface.reports.at(-1)).toMatchObject({ session: 'peer-session' })

      const driveUntil = async (target: number) => {
        while (Date.now() < target) {
          await advance(Math.min(100, target - Date.now()))
          await emit(main, changed('quirky.session-info/changed', { sessionId: null }))
          await emit(main, changed('quirky.session/changed', { session: { id: main.sessionId } }))
          await emit(main, changed('quirky.agent-status/changed', { sessionId: main.sessionId }))
        }
      }
      let oldDeadline = 0
      const recover = async () => {
        const before = callsFor(main, 'quirky.session-info/get')
        oldDeadline = before.at(-1)!.at + 1_500
        if (recovery === 'retry') await click(surface.element.querySelector('button[aria-label="Retry usage"]'))
        else {
          await connect(main, 'reconnecting')
          await connect(main, 'connected')
        }
        assertExactCount(`${recovery} starts a fresh projection immediately at ${at}`, callsFor(main, 'quirky.session-info/get').length, before.length + 1, main.calls)
      }
      if (at < 20) {
        await driveUntil(at)
        await recover()
        await driveUntil(20)
        main.sessionId = 'session-b'
        await emit(main, changed('quirky.terminal/focusContextChanged', { workspace: WORKTREE_B }))
      } else {
        await driveUntil(20)
        main.sessionId = 'session-b'
        await emit(main, changed('quirky.terminal/focusContextChanged', { workspace: WORKTREE_B }))
        await driveUntil(at)
        await recover()
      }
      await driveUntil(5_000)
      const calls = callsFor(main, 'quirky.session-info/get')
      const result = judgeReplay([main, peer])
      assertBound(`${recovery} projection starts at ${at}`, calls.length, 6, result.calls)
      assertBound(`${recovery} inclusive Session info peak at ${at}`, panelPeak(result, 'session-info'), 6, result.calls)
      if (at >= 20 && oldDeadline > at && oldDeadline < at + 1_500) {
        assertExactCount(`${recovery} replaces its old automatic timer at ${oldDeadline}`, calls.filter((call) => call.at === oldDeadline).length, 0, main.calls)
      }
      expect(surface.reports.at(-1)).toMatchObject({ session: 'session-b' })
      expect(surface.element.textContent).toContain('Working session-b')
      expect(peerSurface.reports.at(-1)).toMatchObject({ session: 'peer-session' })
      await act(async () => { inspection.resolve({ mcp: [], updatedAt: Date.now() }); await inspection.promise })
      await settle()
      const beforeUnmount = main.calls.length + peer.calls.length
      await unmountAll()
      await advance(5_000)
      expect(main.calls.length + peer.calls.length).toBe(beforeUnmount)
    }
  })
}
