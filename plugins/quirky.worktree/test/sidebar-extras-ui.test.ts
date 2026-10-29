import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, Session, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import { resolveMembershipTarget } from '../src/membership'
import type { DropPreviewReport } from '../src/report'
import type * as React from 'react'
import type { Root } from 'react-dom/client'
import type { ToolPanelFrame as ToolPanelFrameComponent } from '@quirky/ui'

import { accessibleName } from './window/dom'
const SLOT = 'sidebar-section:quirky.worktree/worktrees'
const BASE = Date.now()
const DAY = 86_400_000

type WindowName = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'
type Preferences = {
  workspaceActivityWindow: WindowName
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: Exclude<WindowName, 'live-only'>
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
  hideAutomationCreated: boolean
}
type SidebarState = {
  client: string
  preferences: Preferences
  active: { worktreeId: string; instanceId: string } | null
  visits: Record<string, number>
  exits: Record<string, number>
}
type ReviewFact = {
  state: 'open' | 'draft' | 'closed' | 'merged'
  checksStatus: 'neutral' | 'pending' | 'success' | 'failure'
  stale?: boolean
  error?: string
} | null
type ProjectedWorkspace = {
  worktreeId: string
  activityAt: number
  live: boolean | null
  reason: 'selected' | 'all' | 'recent' | 'old' | 'live' | 'sleeping' | 'main' | 'folder' | 'unknown'
  error?: string
  reviewReason?: 'completed' | 'passing' | 'unknown'
  reviewError?: string
}
type SidebarProjection = SidebarState & {
  visibleIds: string[]
  hiddenIds: string[]
  hiddenCount: number
  filterCount: number
  automationHiddenIds: string[]
  automationHiddenCount: number
  reviewHiddenIds: string[]
  reviewHiddenCount: number
  workspaces: ProjectedWorkspace[]
}
type Mount = (element: HTMLElement, props?: { report?(state: unknown): void }) => () => void
type Call = { method: string; params: Record<string, unknown> }
type Group = ProjectGroup & { parentId: string | null }
type RendererReport = {
  groups: { id: string; projects: { id: string }[] }[]
  projects: { id: string; worktrees: { id: string; depth: number }[] }[]
  dialog: { kind: string; worktreeId?: string; withDescendants?: boolean; action?: string; groupId?: string } | null
  appliedFilter: Preferences | null
  hiddenIds: string[]
  hiddenCount: number
  automationHiddenIds: string[]
  automationHiddenCount: number
  reviewHiddenIds: string[]
  reviewHiddenCount: number
  filterCount: number
  separators: { enabled: boolean; eligibleBoundaries: string[] }
  dropPreview: DropPreviewReport | null
}
type TestWorld = {
  repos: Repo[]
  groups: Group[]
  worktrees: Worktree[]
  sessions: Session[]
  now: number
  preferences: Preferences
  active: SidebarState['active']
  visits: Record<string, number>
  exits: Record<string, number>
  live: Record<string, boolean | null>
  reviews: Record<string, ReviewFact>
  calls: Call[]
  logs: string[]
  extrasDisabled: boolean
  extrasFailure: Error | null
  ledgerPreview: { ledgerId: string; revision: number; entryCount: number }[] | null
  ledgerPreviewFailure: Error | null
}
type UiHarness = {
  world: TestWorld
  calls: Call[]
  reports: unknown[]
  mount(): Promise<void>
  flush(): Promise<void>
  setLayout(next: UiLayout): Promise<void>
  click(element: Element): Promise<void>
  emit(type: string): Promise<void>
  deferNextSet(): { started: Promise<void>; release(): void }
  deferNextProjection(): { started: Promise<void>; release(): void }
}

let act: (callback: () => unknown) => Promise<void>
type CallGate = { started: Promise<void>; wait: Promise<void>; start(): void; release(): void }
function callGate(): CallGate {
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  return {
    started: started.promise,
    wait: gate.promise,
    start: started.resolve,
    release: gate.resolve
  }
}
function intervalClock() {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const cleanup: Array<() => void> = []
  const intervals: { callback: () => void; delay: number; elapsed: number }[] = []

  const interceptSetInterval = (<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void,
    delay?: number,
    ...args: TArgs
  ) => {
    const handle = realSetInterval(() => {}, delay)
    cleanup.push(() => realClearInterval(handle))
    if (typeof callback === 'function') {
      intervals.push({
        callback: () => callback(...args),
        delay: delay ?? 0,
        elapsed: 0
      })
    }
    return handle
  }) as typeof globalThis.setInterval
  globalThis.setInterval = interceptSetInterval

  return {
    advance(milliseconds: number) {
      for (const interval of intervals) {
        interval.elapsed += milliseconds
        while (interval.delay > 0 && interval.elapsed >= interval.delay) {
          interval.elapsed -= interval.delay
          interval.callback()
        }
      }
    },
    restore() {
      globalThis.setInterval = realSetInterval
      for (const clear of cleanup) clear()
    }
  }
}

let activate: (context: UiPluginContext) => void
let createElement: typeof React.createElement
let createRoot: (container: HTMLElement) => Root
let ToolPanelFrame: typeof ToolPanelFrameComponent
let host: HTMLElement
let currentCleanup: (() => Promise<void>) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React and its renderer bind DOM globals when imported, so load them after happy-dom registration.
  const react = await import('react')
  act = react.act as typeof act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  ToolPanelFrame = (await import('@quirky/ui')).ToolPanelFrame
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  await currentCleanup?.()
  currentCleanup = null
})

const repo = (id: string, name: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name,
  path: `/projects/${name}`,
  addedAt: BASE - 90 * DAY,
  kind: 'git',
  displayName: null,
  groupId: null,
  ...extra
})

const worktree = (id: string, repoId: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  repoId,
  path: `/worktrees/${name}`,
  branch: name,
  head: 'abc123',
  isMain: false,
  name,
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: BASE - 90 * DAY,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  instanceId: `instance-${id}`,
  ...extra
})

const group = (id: string, name: string, extra: Partial<Group> = {}): Group => ({
  id,
  name,
  parentPath: null,
  collapsed: false,
  order: 0,
  createdFrom: 'manual',
  repoIds: [],
  parentId: null,
  ...extra
})

const session = (id: string, worktreeId: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/worktrees',
  title: id,
  status,
  createdAt: BASE - 45 * DAY,
  lastActivityAt: BASE - 45 * DAY,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
})

class RpcLike extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

function fixture() {
  const repos: Repo[] = [
    repo('r-api', 'api'),
    repo('r-web', 'web'),
    repo('r-empty', 'empty'),
    repo('r-notes', 'notes', { kind: 'folder', groupId: 'g-team' })
  ]
  const groups: Group[] = [
    group('g-team', 'Team', { order: 1 }),
    group('g-child', 'Child', { order: 2, parentId: 'g-team' }),
    group('g-release', 'Release', { order: 3 })
  ]
  const worktrees: Worktree[] = [
    worktree('w-main', 'r-api', 'main', { isMain: true, lastActivityAt: BASE - 45 * DAY }),
    worktree('w-feature', 'r-api', 'feature', { projectGroupId: 'g-team', pinned: true, lastActivityAt: BASE - 45 * DAY }),
    worktree('w-child', 'r-api', 'child', { parentId: 'w-feature', lastActivityAt: BASE - 45 * DAY }),
    worktree('w-independent', 'r-api', 'independent', { projectGroupId: 'g-child', lastActivityAt: BASE - 45 * DAY }),
    worktree('w-other', 'r-web', 'other', { lastActivityAt: BASE - 2 * DAY }),
    worktree('w-lost', 'r-web', 'lost-group', { projectGroupId: 'g-missing', lastActivityAt: BASE - 45 * DAY }),
    worktree('w-notes', 'r-notes', 'notes', { kind: 'folder', isMain: true, lastActivityAt: BASE - 45 * DAY })
  ]
  return { repos, groups, worktrees }
}

function setup(
  layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null },
  options: { disabled?: boolean; failure?: Error | null } = {}
): UiHarness {
  const data = fixture()
  const preferences: Preferences = {
    workspaceActivityWindow: 'all',
    workspaceActivityCustomDays: 30,
    alwaysShowDefaultBranchWorkspace: true,
    workspaceActivityWindowBeforeLiveOnly: 'all',
    hideCompletedReviewWorkspaces: false,
    hidePassingCheckWorkspaces: false,
    hideAutomationCreated: false
  }
  const world: TestWorld = {
    ...data,
    sessions: [session('s-other', 'w-other', 'working')],
    now: BASE,
    preferences,
    active: null,
    visits: {},
    exits: {},
    live: { 'w-main': false, 'w-feature': false, 'w-child': false, 'w-independent': null, 'w-other': true, 'w-notes': false },
    reviews: {},
    extrasDisabled: options.disabled ?? false,
    extrasFailure: options.failure ?? null,
    ledgerPreview: null,
    ledgerPreviewFailure: null,
    calls: [],
    logs: []
  }
  let nextSetGate: CallGate | null = null
  let nextProjectionGate: CallGate | null = null
  const calls: Call[] = []
  const reports: unknown[] = []
  const provided = new Map<string, unknown>()
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(next: UiLayout) => void>()
  let current = layout
  const emit = async (event: QuirkyEvent) => {
    await Promise.all([...eventListeners].map((listener) => listener(event)))
  }

  const state = (client = 'desktop'): SidebarState => ({
    client,
    preferences: { ...world.preferences },
    active: world.active ? { ...world.active } : null,
    visits: { ...world.visits },
    exits: { ...world.exits }
  })
  const project = (client = 'desktop'): SidebarProjection => {
    const snapshot = state(client)
    const window = snapshot.preferences.workspaceActivityWindow
    const selectedId = snapshot.active?.worktreeId ?? null
    const projected = world.worktrees.map((item): ProjectedWorkspace => {
      const visitKey = `${item.id}@${item.instanceId}`
      const repoAddedAt = world.repos.find((entry) => entry.id === item.repoId)?.addedAt ?? 0
      const sessionActivity = world.sessions.filter((entry) => entry.worktreeId === item.id).reduce((latest, entry) => Math.max(latest, entry.lastActivityAt), 0)
      const activityAt = Math.max(item.lastActivityAt, sessionActivity, snapshot.visits[visitKey] ?? 0, snapshot.exits[visitKey] ?? 0, item.createdAt, repoAddedAt)
      const live = world.live[item.id] ?? null
      let reason: ProjectedWorkspace['reason'] = 'all'
      let visible = true
      if (item.id === selectedId) reason = 'selected'
      else if (window === 'live-only') {
        if (live === true) reason = 'live'
        else if (live === null) reason = 'unknown'
        else if (item.kind === 'folder') reason = 'folder'
        else if (item.isMain && snapshot.preferences.alwaysShowDefaultBranchWorkspace) reason = 'main'
        else {
          reason = 'sleeping'
          visible = false
        }
      } else if (window !== 'all') {
        const days = window === 'today' ? 1 : window === 'week' ? 7 : window === 'month' ? 30 : snapshot.preferences.workspaceActivityCustomDays
        visible = activityAt >= world.now - days * DAY
        reason = visible ? 'recent' : 'old'
      }
      const review = world.reviews[item.id]
      const usable = review && !review.stale && !review.error ? review : null
      const completed = usable?.state === 'merged' || usable?.state === 'closed'
      const passing = usable?.checksStatus === 'success'
      const reviewReason = snapshot.preferences.hideCompletedReviewWorkspaces && completed
        ? 'completed'
        : snapshot.preferences.hidePassingCheckWorkspaces && passing
          ? 'passing'
          : 'unknown'
      return {
        worktreeId: item.id,
        activityAt,
        live,
        reason,
        ...(visible ? {} : { error: 'hidden' }),
        reviewReason,
        ...(review?.error ? { reviewError: review.error } : {})
      }
    })
    const activityHiddenIds = new Set(projected.filter((item) => item.reason === 'sleeping' || item.reason === 'old').map((item) => item.worktreeId))
    const automationHiddenIds = snapshot.preferences.hideAutomationCreated
      ? world.worktrees.filter((item) => item.automationProvenance?.kind === 'created-by-automation').map((item) => item.id)
      : []
    const reviewHiddenIds = projected.filter((item) => {
      const review = world.reviews[item.worktreeId]
      if (!review || review.stale || review.error) return false
      return (snapshot.preferences.hideCompletedReviewWorkspaces && (review.state === 'merged' || review.state === 'closed')) ||
        (snapshot.preferences.hidePassingCheckWorkspaces && review.checksStatus === 'success')
    }).map((item) => item.worktreeId)
    const hidden = new Set([...activityHiddenIds, ...automationHiddenIds, ...reviewHiddenIds])
    const visibleIds = projected.filter((item) => !hidden.has(item.worktreeId)).map((item) => item.worktreeId)
    const hiddenIds = projected.filter((item) => hidden.has(item.worktreeId)).map((item) => item.worktreeId)
    return {
      ...snapshot,
      visibleIds,
      hiddenIds,
      hiddenCount: activityHiddenIds.size,
      filterCount: (window === 'all' ? 0 : 1) +
        Number(snapshot.preferences.hideCompletedReviewWorkspaces) +
        Number(snapshot.preferences.hidePassingCheckWorkspaces) +
        Number(snapshot.preferences.hideAutomationCreated),
      automationHiddenIds,
      automationHiddenCount: automationHiddenIds.length,
      reviewHiddenIds,
      reviewHiddenCount: reviewHiddenIds.length,
      workspaces: projected
    }
  }
  const changeMembership = (id: string, patch: Record<string, unknown>) => {
    const found = world.worktrees.find((item) => item.id === id)
    if (!found) throw new Error(`unknown workspace ${id}`)
    Object.assign(found, patch)
    return found
  }
  const context = {
    pluginId: 'quirky.worktree',
    log(message: string) {
      world.logs.push(message)
    },
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      const entry = { method, params }
      calls.push(entry)
      world.calls.push(entry)
      switch (method) {
        case 'quirky.repo/list':
          return [...world.repos]
        case 'quirky.repo/groupList':
          return [...world.groups]
        case 'quirky.ledger/request':
          if (world.ledgerPreviewFailure) throw world.ledgerPreviewFailure
          if (world.ledgerPreview === null) throw new RpcLike('method not found', RpcErrorCode.MethodNotFound)
          return { removalPreview: [...world.ledgerPreview] }
        case 'quirky.worktree/list':
          return [...world.worktrees]
        case 'quirky.worktree/projectOrder':
          return world.repos.map((repo) => repo.id)
        case 'quirky.worktree/statusDefinitions':
          return [
            { id: 'todo', label: 'To do', color: '#8b8b8b' },
            { id: 'in-progress', label: 'In progress', color: '#3478c5' },
            { id: 'in-review', label: 'In review', color: '#a57de8' },
            { id: 'done', label: 'Done', color: '#48a878' }
          ]
        case 'quirky.worktree/projectMetadataList':
          return world.repos.map((repo) => ({
            repoId: repo.id,
            identity: { displayName: repo.displayName, icon: null, color: null, trackerProject: null },
            externalVisibility: 'inherit',
            effectiveExternalVisibility: 'hide',
            externalInboxSuppressed: false,
            sharedDirectories: []
          }))
        case 'quirky.worktree/navigate':
        case 'quirky.worktree/openIn': {
          const next: UiLayout = {
            ...current,
            view: {
              id: params.target === 'changes' ? 'view:quirky.git/diff' : 'view:quirky.session/worktree',
              input: params.target === 'changes'
                ? { worktree: params.worktree, mode: 'combined', area: 'all' }
                : { worktree: params.worktree }
            }
          }
          current = next
          for (const listener of layoutListeners) listener(next)
          return { worktreeId: params.worktree, target: params.target ?? 'terminal' }
        }
        case 'quirky.session/list':
          return [...world.sessions]
        case 'quirky.sidebar-extras/state':
          if (world.extrasDisabled) throw new RpcLike('sidebar extras is disabled', RpcErrorCode.MethodNotFound)
          if (world.extrasFailure) throw world.extrasFailure
          return state(typeof params.client === 'string' ? params.client : 'desktop')
        case 'quirky.sidebar-extras/projection': {
          if (world.extrasDisabled) throw new RpcLike('sidebar extras is disabled', RpcErrorCode.MethodNotFound)
          if (world.extrasFailure) throw world.extrasFailure
          const projection = project(typeof params.client === 'string' ? params.client : 'desktop')
          if (nextProjectionGate) {
            const gate = nextProjectionGate
            nextProjectionGate = null
            gate.start()
            await gate.wait
          }
          return projection
        }
        case 'quirky.sidebar-extras/set':
          if (world.extrasDisabled) throw new RpcLike('sidebar extras is disabled', RpcErrorCode.MethodNotFound)
          if (world.extrasFailure) throw world.extrasFailure
          if (nextSetGate) {
            const gate = nextSetGate
            nextSetGate = null
            gate.start()
            await gate.wait
          }
          if (params.workspaceActivityWindow !== undefined) world.preferences.workspaceActivityWindow = params.workspaceActivityWindow as WindowName
          if (params.workspaceActivityCustomDays !== undefined) world.preferences.workspaceActivityCustomDays = params.workspaceActivityCustomDays as number
          if (params.alwaysShowDefaultBranchWorkspace !== undefined) world.preferences.alwaysShowDefaultBranchWorkspace = params.alwaysShowDefaultBranchWorkspace as boolean
          if (params.hideCompletedReviewWorkspaces !== undefined) world.preferences.hideCompletedReviewWorkspaces = params.hideCompletedReviewWorkspaces as boolean
          if (params.hidePassingCheckWorkspaces !== undefined) world.preferences.hidePassingCheckWorkspaces = params.hidePassingCheckWorkspaces as boolean
          if (params.hideAutomationCreated !== undefined) world.preferences.hideAutomationCreated = params.hideAutomationCreated as boolean
          return state(typeof params.client === 'string' ? params.client : 'desktop')
        case 'quirky.sidebar-extras/activate': {
          if (world.extrasDisabled) throw new RpcLike('sidebar extras is disabled', RpcErrorCode.MethodNotFound)
          if (world.extrasFailure) throw world.extrasFailure
          const selected = typeof params.worktree === 'string' ? world.worktrees.find((item) => item.id === params.worktree) : undefined
          const next = selected ? { worktreeId: selected.id, instanceId: selected.instanceId } : null
          if (world.active?.worktreeId === next?.worktreeId && world.active?.instanceId === next?.instanceId) return state()
          if (world.active) world.exits[`${world.active.worktreeId}@${world.active.instanceId}`] = BASE
          if (next) world.visits[`${next.worktreeId}@${next.instanceId}`] = BASE
          world.active = next
          return state()
        }
        case 'quirky.worktree/set': {
          const changed = changeMembership(String(params.worktree), Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'worktree')))
          await emit({ type: 'quirky.worktree/changed', data: { repoId: changed.repoId } } as QuirkyEvent)
          return changed
        }
        case 'quirky.repo/groupAdd': {
          const target = world.repos.find((item) => item.id === params.repo)
          if (!target) throw new Error('unknown project')
          target.groupId = String(params.group)
          await emit({ type: 'quirky.repo/changed', data: { groupId: target.groupId } } as QuirkyEvent)
          return { ok: true }
        }
        case 'quirky.repo/groupRemove': {
          const target = world.repos.find((item) => item.id === params.repo)
          if (!target) throw new Error('unknown project')
          target.groupId = null
          await emit({ type: 'quirky.repo/changed', data: {} } as QuirkyEvent)
          return { ok: true }
        }
        case 'quirky.repo/groupCollapse': {
          const target = world.groups.find((item) => item.id === params.group)
          if (target) target.collapsed = params.collapsed as boolean
          await emit({ type: 'quirky.repo/changed', data: { groupId: params.group } } as QuirkyEvent)
          return { ok: true }
        }
        case 'quirky.repo/groupDelete': {
          const deleted = new Set([String(params.group)])
          let found = true
          while (found) {
            found = false
            for (const candidate of world.groups) {
              if (candidate.parentId !== null && deleted.has(candidate.parentId) && !deleted.has(candidate.id)) {
                deleted.add(candidate.id)
                found = true
              }
            }
          }
          world.groups = world.groups.filter((candidate) => !deleted.has(candidate.id))
          for (const repo of world.repos) if (repo.groupId && deleted.has(repo.groupId)) repo.groupId = null
          for (const item of world.worktrees) if (item.projectGroupId && deleted.has(item.projectGroupId)) item.projectGroupId = null
          await emit({ type: 'quirky.repo/changed', data: {} } as QuirkyEvent)
          await emit({ type: 'quirky.worktree/changed', data: {} } as QuirkyEvent)
          return { ok: true }
        }
        case 'quirky.worktree/releaseGroups': {
          const deleted = new Set(Array.isArray(params.groups) ? params.groups.filter((value): value is string => typeof value === 'string') : [])
          for (const item of world.worktrees) if (item.projectGroupId && deleted.has(item.projectGroupId)) item.projectGroupId = null
          await emit({ type: 'quirky.worktree/changed', data: {} } as QuirkyEvent)
          return { ok: true }
        }
        case 'quirky.worktree/createGroup': {
          const target = world.worktrees.find((item) => item.id === params.worktree)
          const created = group(`g-created-${world.groups.length}`, String(params.name), { order: world.groups.length + 1 })
          const assigned = target !== undefined &&
            target.instanceId === params.expectedInstanceId &&
            target.projectGroupId === params.expectedProjectGroupId
          world.groups.push(created)
          if (target && assigned) target.projectGroupId = created.id
          await emit({ type: 'quirky.repo/changed', data: { groupId: created.id } } as QuirkyEvent)
          await emit({ type: 'quirky.worktree/changed', data: { repoId: target?.repoId } } as QuirkyEvent)
          return {
            group: created,
            worktree: target,
            assigned,
            ...(assigned ? {} : { reason: 'worktree identity or membership changed' })
          }
        }
        case 'setting.set':
          return {}
        default:
          throw new Error(`unexpected renderer call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    getSetting: () => undefined,
    executeCommand: async () => {},
    openView(id: string, input?: unknown) {
      const next: UiLayout = { ...current, view: { id, input } }
      current = next
      for (const listener of layoutListeners) listener(next)
    },
    closeView() {},
    togglePanel() {},
    getLayout: () => current,
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    onConnection: () => () => {},
    async confirm() {
      return true
    },
    toast() {},
    setPanelBadge() {}
  } as unknown as UiPluginContext

  activate(context)
  const mount = provided.get(SLOT) as Mount
  const flush = async () => act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  return {
    world,
    calls,
    reports,
    async mount() {
      const frameRoot = createRoot(host)
      const pluginHostRef = { current: null as HTMLDivElement | null }
      await act(async () => {
        frameRoot.render(createElement(ToolPanelFrame, {
          title: 'Worktrees',
          children: createElement('div', { ref: (node: HTMLDivElement | null) => { pluginHostRef.current = node } })
        }))
      })
      if (!pluginHostRef.current) throw new Error('Worktrees panel body did not mount')
      let unmount = () => {}
      await act(async () => {
        unmount = mount(pluginHostRef.current!, { report: (value) => reports.push(value) })
      })
      currentCleanup = async () => act(async () => {
        unmount()
        frameRoot.unmount()
      })
      await flush()
    },
    async flush() {
      await flush()
    },
    async setLayout(next: UiLayout) {
      await act(async () => {
        current = next
        for (const listener of layoutListeners) listener(next)
        await Promise.resolve()
      })
      await flush()
    },
    async click(element: Element) {
      await act(async () => {
        ;(element as HTMLElement).click()
        await Promise.resolve()
      })
      await flush()
    },
    async emit(type: string) {
      await emit({ type, data: {} } as QuirkyEvent)
    },
    deferNextSet() {
      const gate = callGate()
      nextSetGate = gate
      return { started: gate.started, release: gate.release }
    },
    deferNextProjection() {
      const gate = callGate()
      nextProjectionGate = gate
      return { started: gate.started, release: gate.release }
    }
  }
}
const optionsPopover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Worktrees options"]')
const optionsContent = () => optionsPopover() ?? document.body
const buttons = (within: ParentNode = optionsContent()) => [...within.querySelectorAll<HTMLButtonElement>('button')]
const card = (name: string) => [...host.querySelectorAll<HTMLElement>('[data-worktree-id]')].find((row) => row.querySelector('.worktree-name')?.textContent?.trim() === name)
const childChip = (name: string) => card(name)?.querySelector<HTMLButtonElement>('button[aria-expanded]')
const sectionHeading = (section: HTMLElement) => section.querySelector(':scope > header h2')?.textContent?.trim()
const sectionHeader = (section: HTMLElement) => section.querySelector<HTMLElement>(':scope > header')!
const sectionForRepo = (name: string) => [...host.querySelectorAll<HTMLElement>('section.repo')].find((section) => sectionHeading(section) === name)
const sectionForGroup = (name: string) => [...host.querySelectorAll<HTMLElement>('section.group')].find((section) => sectionHeading(section) === name)
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
const visibleMenuText = (node: Node): string => {
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  return [...node.childNodes].map(visibleMenuText).join('')
}
const normalizedMenuLabel = (item: Element) => visibleMenuText(item).replace(/\s+/g, ' ').trim()
const menuItem = (name: string) => menuItems().find((item) => normalizedMenuLabel(item) === name)
const buttonNamed = (within: ParentNode, name: string) =>
  buttons(within).find((button) => button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
const openOptions = async (h: UiHarness) => {
  if (optionsPopover()) return
  const trigger = buttonNamed(host, 'Worktrees options')
  if (!trigger) throw new Error('Worktrees options are unavailable in the panel header')
  await h.click(trigger)
}
const openCardMenu = async (h: UiHarness, name: string) => {
  const target = buttonNamed(card(name)!, `Actions for ${name}`)
  if (!target) throw new Error(`no action button for ${name}`)
  await h.click(target)
}
const filterButton = () => buttons(optionsContent()).find((button) => button.textContent?.trim().startsWith('Activity filters'))
const filterCount = () => filterButton()?.querySelector<HTMLElement>('[role="img"]')?.getAttribute('aria-label')?.match(/^\d+/)?.[0]

const checkboxFor = (label: string) =>
  [...optionsContent().querySelectorAll<HTMLLabelElement>('label')]
    .find((item) => item.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
const fieldFor = (name: string) =>
  [...optionsContent().querySelectorAll<HTMLLabelElement>('label')]
    .find((label) => label.textContent?.replace(/\s+/g, ' ').trim() === name)
    ?.control as HTMLInputElement | undefined
const openFilters = async (h: UiHarness) => {
  await openOptions(h)
  const trigger = filterButton()
  if (!trigger) throw new Error('workspace activity filters are unavailable')
  if (trigger.getAttribute('aria-expanded') !== 'true') await h.click(trigger)
}
const selectWindow = async (h: UiHarness, label: string) => {
  let option = buttons(optionsContent()).find((button) => button.textContent?.trim() === label)
  if (!option) {
    await openFilters(h)
    option = buttons(optionsContent()).find((button) => button.textContent?.trim() === label)
  }
  if (!option) throw new Error(`no activity window option ${label}`)
  await h.click(option)
}
const commitDays = async (h: UiHarness, input: HTMLInputElement) => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.blur()
    await Promise.resolve()
  })
  await h.flush()
}
const inputValue = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await Promise.resolve()
})
const lastReport = (h: UiHarness): RendererReport => {
  const value = h.reports[h.reports.length - 1]
  if (!value || typeof value !== 'object') throw new Error('sidebar did not report a renderer state')
  return value as RendererReport
}

function eventAt(type: string, clientY: number, dataTransfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, { clientY: { value: clientY }, clientX: { value: 24 }, dataTransfer: { value: dataTransfer } })
  return event
}

function setRect(element: Element, top: number, bottom: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: top, top, bottom, left: 0, right: 320, width: 320, height: bottom - top, toJSON: () => ({}) })
  })
}

test('SC-03/05: loose hierarchy keeps child disclosures while delete confirmation counts canonical descendants', async () => {
  const h = setup()
  await h.mount()

  expect(sectionForGroup('Team')).toBeDefined()
  expect(sectionForGroup('Child')).toBeDefined()
  expect(card('feature')?.closest('section.group')).toBe(sectionForGroup('Team'))
  expect(card('independent')?.closest('section.group')).toBe(sectionForGroup('Child'))
  expect(card('child')?.closest('section.repo')).toBe(sectionForRepo('api'))
  expect(childChip('feature')).toBeNull()
  expect(sectionForRepo('empty')).toBeDefined()
  expect(card('lost-group')?.closest('section.repo')).toBe(sectionForRepo('web'))
  expect(h.world.worktrees.find((item) => item.id === 'w-lost')?.projectGroupId).toBe('g-missing')
  const teamOrder = [...sectionForGroup('Team')!.querySelectorAll<HTMLElement>('h2, .worktree-name')].map((item) => item.textContent)
  expect(teamOrder.indexOf('notes')).toBeLessThan(teamOrder.indexOf('feature'))
  expect(Boolean(sectionForGroup('Team')!.compareDocumentPosition(sectionForRepo('api')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(lastReport(h).groups.find((entry) => entry.id === 'g-team')?.projects.some((entry) => entry.id === 'r-api')).toBe(false)
  expect(lastReport(h).projects.find((project) => project.id === 'r-api')?.worktrees.find((item) => item.id === 'w-child')?.depth).toBe(0)

  await openCardMenu(h, 'feature')
  expect(menuItem('Delete with Descendants (1)…')).toBeDefined()
  await h.click(menuItem('Delete with Descendants (1)…')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Child workspaces will be deleted')
  expect(lastReport(h).dialog).toEqual({ kind: 'delete', worktreeId: 'w-feature', withDescendants: true })
})

test('SC-03: diversion keeps an empty project placeholder and returning a parent restores child nesting', async () => {
  const h = setup()
  await h.mount()

  for (const [name, groupName] of [['main', 'Team'], ['child', 'Child']] as const) {
    await openCardMenu(h, name)
    await h.click(menuItem('Add worktree to group')!)
    await h.click(menuItem(groupName)!)
  }
  expect(sectionForRepo('api')).toBeDefined()
  expect(sectionForRepo('api')!.querySelectorAll('[data-worktree-id]')).toHaveLength(0)
  expect(h.world.worktrees.filter((item) => item.repoId === 'r-api').every((item) => item.projectGroupId !== null)).toBe(true)

  for (const name of ['feature', 'main', 'child', 'independent']) {
    await openCardMenu(h, name)
    await h.click(menuItem('Remove worktree from group')!)
  }
  expect(sectionForRepo('api')!.querySelectorAll('[data-worktree-id]')).toHaveLength(4)
  expect(childChip('feature')?.getAttribute('aria-expanded')).toBe('true')
  expect(lastReport(h).projects.find((project) => project.id === 'r-api')?.worktrees.find((item) => item.id === 'w-child')?.depth).toBe(1)
})

test('SC-05: the group action button is the sole menu trigger and rename selects the initial text', async () => {
  const h = setup()
  await h.mount()
  const team = sectionForGroup('Team')!
  sectionHeader(team).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()

  const more = buttonNamed(team, 'Actions for group Team')
  expect(more).toBeDefined()
  await h.click(more!)
  const rename = menuItems().find((item) => /rename/i.test(item.textContent ?? ''))
  expect(rename).toBeDefined()
  await h.click(rename!)

  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')
  expect(input).not.toBeNull()
  expect(document.activeElement).toBe(input)
  expect(input!.selectionStart).toBe(0)
  expect(input!.selectionEnd).toBe(input!.value.length)
})

test('SC-05: cancelling group deletion preserves its subtree; confirming releases nested memberships', async () => {
  const h = setup()
  await h.mount()
  const openDelete = async () => {
    const team = sectionForGroup('Team')!
    const more = buttonNamed(team, 'Actions for group Team')!
    await h.click(more)
    const remove = menuItems().find((item) => /delete group/i.test(item.textContent ?? ''))
    expect(remove).toBeDefined()
    await h.click(remove!)
  }

  await openDelete()
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog ? accessibleName(dialog) : undefined).toBe('Delete the group Team')
  expect(dialog?.querySelector('[role="alert"]')).toBeNull()
  expect(lastReport(h).dialog).toEqual({ kind: 'group', action: 'delete', groupId: 'g-team' })
  await h.click([...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Cancel')!)
  expect(h.world.groups.map((item) => item.id)).toContain('g-child')
  expect(h.world.worktrees.find((item) => item.id === 'w-feature')?.projectGroupId).toBe('g-team')

  await openDelete()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Delete Group')
  expect(confirm?.disabled).toBe(false)
  expect(confirm).toBeDefined()
  await h.click(confirm!)
  expect(h.calls.filter((call) => call.method === 'quirky.repo/groupDelete').at(-1)?.params).toEqual({ group: 'g-team' })
  expect(h.world.groups.map((item) => item.id)).not.toContain('g-team')
  expect(h.world.groups.map((item) => item.id)).not.toContain('g-child')
  expect(h.world.worktrees.find((item) => item.id === 'w-feature')?.projectGroupId).toBeNull()
  expect(h.world.worktrees.find((item) => item.id === 'w-independent')?.projectGroupId).toBeNull()
  expect(sectionForGroup('Team')).toBeUndefined()
  expect(card('feature')?.closest('section.repo')).toBe(sectionForRepo('api'))
  expect(card('independent')?.closest('section.repo')).toBe(sectionForRepo('api'))
})

test('group deletion retries ledger preview failures and sends subtree snapshots', async () => {
  const h = setup()
  await h.mount()
  h.world.groups.push(group('g-grandchild', 'Grandchild', { order: 4, parentId: 'g-child' }))
  h.world.ledgerPreviewFailure = new Error('ledger backend unavailable')

  const team = sectionForGroup('Team')!
  await h.click(buttonNamed(team, 'Actions for group Team')!)
  await h.click(menuItems().find((item) => /delete group/i.test(item.textContent ?? ''))!)

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Delete Group')!
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('ledger backend unavailable')
  expect(confirm.disabled).toBe(true)

  const scope = { operation: 'removal-preview', removal: { groupIds: ['g-team', 'g-child', 'g-grandchild'] } }
  expect(h.calls.filter((call) => call.method === 'quirky.ledger/request').map((call) => call.params)).toEqual([scope])

  h.world.ledgerPreviewFailure = null
  h.world.ledgerPreview = [{ ledgerId: 'ledger-team', revision: 7, entryCount: 3 }]
  await h.click([...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Retry')!)
  expect(dialog.textContent).toContain('3 entries across 1 ledger')
  expect(confirm.disabled).toBe(false)
  await h.click(confirm)

  expect(h.calls.filter((call) => call.method === 'quirky.ledger/request').map((call) => call.params)).toEqual([scope, scope])
  expect(h.calls.filter((call) => call.method === 'quirky.repo/groupDelete').at(-1)?.params).toEqual({
    group: 'g-team',
    expectedLedgers: [{ ledgerId: 'ledger-team', revision: 7 }]
  })
  expect(h.world.groups.map((item) => item.id)).not.toContain('g-grandchild')
})
test('SC-01: new group creation is guarded by the selected Git worktree identity', async () => {
  const h = setup()
  await h.mount()
  const openNewGroup = async () => {
    await openCardMenu(h, 'other')
    const create = menuItems().find((item) => /new group from worktree/i.test(item.textContent ?? ''))
    expect(create).toBeDefined()
    await h.click(create!)
  }

  await openNewGroup()
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const input = dialog?.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('new worktree group dialog input was not rendered')
  expect(input.value).toBe('other group')
  expect(document.activeElement).toBe(input)
  expect(input?.selectionStart).toBe(0)
  expect(input?.selectionEnd).toBe(input?.value.length)
  await h.click([...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Cancel')!)
  expect(h.world.groups).toHaveLength(3)
  expect(h.calls.some((call) => call.method === 'quirky.worktree/createGroup')).toBe(false)

  await openNewGroup()
  await h.click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Create')!)
  const request = h.calls.find((call) => call.method === 'quirky.worktree/createGroup')
  expect(request?.params).toEqual({
    worktree: 'w-other',
    name: 'other group',
    expectedInstanceId: 'instance-w-other',
    expectedProjectGroupId: null
  })
  const createdGroupId = h.world.worktrees.find((worktree) => worktree.id === 'w-other')?.projectGroupId
  expect(createdGroupId).toBeTruthy()
  expect(h.world.worktrees.find((worktree) => worktree.id === 'w-feature')?.projectGroupId).toBe('g-team')
  expect(h.world.worktrees.find((worktree) => worktree.id === 'w-child')?.projectGroupId).toBeNull()
  expect(h.world.worktrees.find((worktree) => worktree.id === 'w-other')?.repoId).toBe('r-web')
  expect(h.world.worktrees.find((worktree) => worktree.id === 'w-lost')?.projectGroupId).toBe('g-missing')
  expect(h.world.repos.find((repo) => repo.id === 'r-web')?.groupId).toBeNull()

  const target = h.world.worktrees.find((worktree) => worktree.id === 'w-other')!
  await openNewGroup()
  target.projectGroupId = 'g-release'
  await h.click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Create')!)
  const requests = h.calls.filter((call) => call.method === 'quirky.worktree/createGroup')
  expect(requests[requests.length - 1]?.params.expectedProjectGroupId).toBe(createdGroupId)
  expect(target.projectGroupId).toBe('g-release')
  const unassigned = h.world.groups[h.world.groups.length - 1]!
  expect(h.world.worktrees.some((worktree) => worktree.projectGroupId === unassigned.id)).toBe(false)
})
test('project menu opens the project group dialog', async () => {
  const h = setup()
  await h.mount()

  const section = sectionForRepo('api')
  const actions = section && buttons(section).find((button) => button.getAttribute('aria-label') === 'Actions for api')
  if (!actions) throw new Error('project actions button was not rendered')
  await h.click(actions)

  const create = menuItem('New Group from Project…')
  if (!create) throw new Error('new group menu item was not rendered')
  await h.click(create)

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('project group dialog was not rendered')
  expect(lastReport(h).dialog).toMatchObject({ kind: 'group', action: 'new' })
})



test('SC-02/06: loose membership menus move and remove one worktree, and folder rows offer only project actions', async () => {
  const h = setup()
  await h.mount()

  await openCardMenu(h, 'other')
  await h.click(menuItem('Add worktree to group')!)
  await h.click(menuItem('Release')!)
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBe('g-release')
  expect(card('other')?.closest('section.group')).toBe(sectionForGroup('Release'))
  expect(sectionForRepo('web')).toBeDefined()

  await openCardMenu(h, 'other')
  await h.click(menuItem('Remove worktree from group')!)
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBeNull()
  expect(card('other')?.closest('section.repo')).toBe(sectionForRepo('web'))


  const pinnedFeature = [...host.querySelectorAll<HTMLElement>('section.pinned [data-worktree-id]')].find(
    (row) => row.querySelector('.worktree-name')?.textContent === 'feature'
  )
  expect(pinnedFeature).toBeDefined()
  await h.click(buttonNamed(pinnedFeature!, 'Actions for feature')!)
  await h.click(menuItem('Remove worktree from group')!)
  expect(h.world.worktrees.find((item) => item.id === 'w-feature')?.projectGroupId).toBeNull()
  expect(card('feature')?.closest('section.repo')).toBe(sectionForRepo('api'))
  await openCardMenu(h, 'notes')
  const labels = menuItems().map(normalizedMenuLabel)
  expect(labels).toContain('Move project to group')
  expect(labels).not.toContain('Add worktree to group')
  expect(labels).not.toContain('Remove worktree from group')
})

test('SC-02: moving a Git project moves every repo row without changing loose worktree membership', async () => {
  const h = setup()
  await h.mount()
  const before = h.world.worktrees.find((item) => item.id === 'w-feature')!.projectGroupId

  await openCardMenu(h, 'feature')
  await h.click(menuItem('Move project to group')!)
  await h.click(menuItem('Release')!)

  expect(h.world.repos.find((item) => item.id === 'r-api')?.groupId).toBe('g-release')
  expect(h.world.worktrees.filter((item) => item.repoId === 'r-api').map((item) => item.id)).toEqual(['w-main', 'w-feature', 'w-child', 'w-independent'])
  expect(h.world.worktrees.find((item) => item.id === 'w-feature')?.projectGroupId).toBe(before)
  expect([...sectionForGroup('Release')!.querySelectorAll('section.repo > header h2')].map((heading) => heading.textContent)).toContain('api')
})

test('membership target resolution prefers an overlapping group and rejects unrelated projects', () => {
  const group = { id: 'g-team', left: 0, right: 320, top: 10, bottom: 30 }
  const ownRepo = { id: 'r-api', left: 0, right: 320, top: 10, bottom: 30 }
  const otherRepo = { id: 'r-web', left: 0, right: 320, top: 40, bottom: 60 }
  expect(resolveMembershipTarget(24, 20, [group], [ownRepo], 'r-api')).toEqual({ kind: 'group', id: 'g-team' })
  expect(resolveMembershipTarget(24, 50, [], [ownRepo, otherRepo], 'r-api')).toBeNull()
  expect(resolveMembershipTarget(24, 20, [], [ownRepo], 'r-api')).toEqual({ kind: 'repo', id: 'r-api' })
})

test('SC-04: current painted geometry joins, no-ops, leaves only at the owning repo, and ignores unrelated sections', async () => {
  const h = setup()
  await h.mount()
  const source = () => card('other')!
  const groupHeader = sectionHeader(sectionForGroup('Team')!)
  const ownRepoSection = sectionForRepo('web')!
  const ownRepoHeader = sectionHeader(ownRepoSection)
  const unrelatedRepoHeader = sectionHeader(sectionForRepo('api')!)
  const transfer = {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData() {},
    getData() { return 'w-other' }
  } as unknown as DataTransfer
  const drop = async (target: Element, y: number) => {
    await act(async () => {
      source().dispatchEvent(eventAt('dragstart', y, transfer))
      target.dispatchEvent(eventAt('dragover', y, transfer))
      target.dispatchEvent(eventAt('drop', y, transfer))
      await Promise.resolve()
    })
    await h.flush()
  }

  setRect(groupHeader, 100, 140)
  setRect(ownRepoHeader, 100, 140)
  await act(async () => {
    source().dispatchEvent(eventAt('dragstart', 110, transfer))
    groupHeader.dispatchEvent(eventAt('dragover', 110, transfer))
    await Promise.resolve()
  })
  await h.flush()
  expect(lastReport(h).dropPreview).toEqual({ kind: 'group', id: 'g-team' })
  await act(async () => source().dispatchEvent(new Event('dragend', { bubbles: true })))
  await h.flush()
  expect(lastReport(h).dropPreview).toBeNull()
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBeNull()
  await drop(groupHeader, 110)
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBe('g-team')
  const assignmentsAfterJoin = h.calls.filter((call) =>
    call.method === 'quirky.worktree/set' && call.params.worktree === 'w-other' && call.params.projectGroupId === 'g-team'
  ).length
  await drop(groupHeader, 110)
  expect(h.calls.filter((call) =>
    call.method === 'quirky.worktree/set' && call.params.worktree === 'w-other' && call.params.projectGroupId === 'g-team'
  )).toHaveLength(assignmentsAfterJoin)
  expect(lastReport(h).dropPreview).toBeNull()
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBe('g-team')

  setRect(unrelatedRepoHeader, 180, 200)
  await drop(unrelatedRepoHeader, 190)
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBe('g-team')

  setRect(ownRepoHeader, 220, 240)
  await drop(ownRepoHeader, 230)
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBeNull()
  expect(card('other')?.closest('section.repo')).toBe(ownRepoSection)

  setRect(groupHeader, 260, 300)
  await act(async () => {
    source().dispatchEvent(eventAt('dragstart', 270, transfer))
    groupHeader.dispatchEvent(eventAt('dragover', 270, transfer))
    source().dispatchEvent(new Event('dragend', { bubbles: true }))
    await Promise.resolve()
  })
  await h.flush()
  expect(h.world.worktrees.find((item) => item.id === 'w-other')?.projectGroupId).toBeNull()
  expect(lastReport(h).dropPreview).toBeNull()
})
 
test('Worktrees options dismiss and reopen without losing applied activity filters', async () => {
  const h = setup()
  await h.mount()

  const trigger = buttonNamed(host, 'Worktrees options')
  expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')
  expect(optionsPopover()).toBeNull()
  for (const label of ['Add project', 'Workspace options', 'Activity filters', 'More workspace tools']) {
    expect(host.textContent).not.toContain(label)
  }

  await h.click(trigger!)
  const initialPopover = optionsPopover()
  expect(initialPopover?.parentElement).toBe(document.body)
  expect(host.contains(initialPopover)).toBe(false)
  await openFilters(h)
  await selectWindow(h, 'Week')
  expect(h.world.preferences.workspaceActivityWindow).toBe('week')

  await act(async () => {
    initialPopover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await h.flush()
  expect(optionsPopover()).toBeNull()
  expect(buttonNamed(host, 'Worktrees options')?.getAttribute('aria-expanded')).toBe('false')
  expect(h.world.preferences.workspaceActivityWindow).toBe('week')

  await h.click(buttonNamed(host, 'Worktrees options')!)
  await openFilters(h)
  expect(optionsContent().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Week')

  await act(async () => {
    host.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
  })
  await h.flush()
  expect(optionsPopover()).toBeNull()
  expect(h.world.preferences.workspaceActivityWindow).toBe('week')

  await h.click(buttonNamed(host, 'Worktrees options')!)
  await openFilters(h)
  expect(optionsContent().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Week')
})

test('SC-08/11/12: filters use exact windows, validate custom days on Enter and blur, and recover an empty list', async () => {
  const h = setup()
  await h.mount()
  await openFilters(h)

  expect(optionsContent().querySelector('[role="tablist"][aria-label="Workspace activity window"]')?.querySelectorAll('[role="tab"]')).toHaveLength(6)
  await selectWindow(h, 'Week')
  expect(h.world.preferences.workspaceActivityWindow).toBe('week')
  expect(card('feature')).toBeUndefined()
  expect(card('other')).toBeDefined()
  expect(lastReport(h).hiddenCount).toBeGreaterThan(0)
  expect(lastReport(h).appliedFilter?.workspaceActivityWindow).toBe('week')
  expect(filterCount()).toBe('1')
  expect(buttons().some((button) => /hidden/i.test(button.textContent ?? ''))).toBe(true)
  await selectWindow(h, 'Today')
  expect(card('other')).toBeUndefined()

  await h.setLayout({ view: null, panel: null, sidebar: true, focus: null })
  expect(card('other')).toBeUndefined()
  const hidden = buttons().find((button) => /hidden/i.test(button.textContent ?? ''))
  expect(hidden).toBeDefined()
  await h.click(hidden!)
  expect(h.world.preferences.workspaceActivityWindow).toBe('all')
  expect(filterCount()).toBe('0')
  expect(card('other')).toBeDefined()
  expect(h.world.worktrees.find((item) => item.id === 'w-feature')?.projectGroupId).toBe('g-team')

  await selectWindow(h, 'Custom')
  const days = fieldFor('Custom days')
  expect(days).not.toBeNull()
  expect(days!.value).toBe('30')
  for (const invalid of ['0', '-1', '1.5', 'text', '9007199254740992']) {
    await inputValue(days!, invalid)
    await commitDays(h, days!)
    expect(h.world.preferences.workspaceActivityCustomDays).toBe(30)
    expect(optionsContent().querySelector('[role="alert"]')).not.toBeNull()
  }
  await inputValue(days!, '3')
  await commitDays(h, days!)
  expect(h.world.preferences.workspaceActivityCustomDays).toBe(3)
  expect(optionsContent().querySelector('[role="alert"]')).toBeNull()

  expect(buttons().some((button) => button.textContent?.trim() === 'Clear filters')).toBe(true)
  await h.click(buttons().find((button) => button.textContent?.trim() === 'Clear filters')!)
  expect(h.world.preferences.workspaceActivityWindow).toBe('all')
  await selectWindow(h, 'Today')
  expect(h.world.preferences.workspaceActivityWindow).toBe('today')
  await selectWindow(h, 'Month')
  expect(h.world.preferences.workspaceActivityWindow).toBe('month')
  await selectWindow(h, 'All')
  expect(h.world.preferences.workspaceActivityWindow).toBe('all')
})

test('Custom days commits on blur without Enter and rejects an invalid blur without changing the window', async () => {
  const h = setup()
  await h.mount()
  await selectWindow(h, 'Custom')
  const days = fieldFor('Custom days')!
  await act(async () => { days.focus() })
  await inputValue(days, '3')
  await act(async () => { days.blur() })
  await h.flush()
  expect(h.world.preferences.workspaceActivityCustomDays).toBe(3)
  expect(h.world.preferences.workspaceActivityWindow).toBe('custom')
  expect(card('other')).toBeDefined()
  expect(card('feature')).toBeUndefined()

  await act(async () => { days.focus() })
  await inputValue(days, '0')
  await act(async () => { days.blur() })
  await h.flush()
  expect(h.world.preferences.workspaceActivityCustomDays).toBe(3)
  expect(h.world.preferences.workspaceActivityWindow).toBe('custom')
  expect(optionsContent().querySelector('[role="alert"]')).not.toBeNull()
  expect(card('other')).toBeDefined()
  expect(card('feature')).toBeUndefined()
})
 
test('SC-10/13: Live preserves selected, unknown, folder and default rows; visits are identity-keyed and idempotent', async () => {
  const h = setup({ view: { id: 'view:quirky.session/worktree', input: { worktree: 'w-main' } }, panel: null, sidebar: true, focus: 'view' })
  await h.mount()
  expect(h.world.active).toEqual({ worktreeId: 'w-main', instanceId: 'instance-w-main' })
  expect(card('main')).toBeDefined()

  await selectWindow(h, 'Live only')
  expect(h.world.preferences.workspaceActivityWindow).toBe('live-only')
  expect(card('main')).toBeDefined()
  expect(card('independent')).toBeDefined()
  expect(card('other')).toBeDefined()
  expect(card('notes')).toBeDefined()
  expect(card('feature')).toBeUndefined()

  const exception = optionsContent().querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(exception).not.toBeNull()
  expect(exception!.closest('label')?.textContent).toContain('Except default branch')
  await h.click(exception!)
  expect(h.world.preferences.alwaysShowDefaultBranchWorkspace).toBe(false)
  expect(card('main')).toBeDefined()

  await h.setLayout({ view: { id: 'view:quirky.session/worktree', input: { worktree: 'w-other' } }, panel: null, sidebar: true, focus: 'view' })
  expect(card('main')).toBeUndefined()
  expect(h.world.exits['w-main@instance-w-main']).toBe(BASE)
  expect(h.world.visits['w-other@instance-w-other']).toBe(BASE)
  await h.setLayout({ view: { id: 'view:quirky.session/worktree', input: { worktree: 'w-other' } }, panel: null, sidebar: true, focus: 'view' })
  expect(Object.keys(h.world.exits)).toEqual(['w-main@instance-w-main'])
  expect(h.world.visits['w-other@instance-w-other']).toBe(BASE)
})
 
 
 
test('disabled extras falls back to the ordinary tree, while ordinary failures report unavailability', async () => {
  const disabled = setup({ view: null, panel: null, sidebar: true, focus: null }, { disabled: true })
  await disabled.mount()
  expect(card('main')).toBeDefined()
  expect(host.textContent).not.toMatch(/activity filters unavailable/i)
  await currentCleanup?.()
  currentCleanup = null

  const unavailable = setup({ view: null, panel: null, sidebar: true, focus: null }, { failure: new Error('temporary sidebar extras transport failure') })
  await unavailable.mount()
  expect(card('main')).toBeDefined()
  await openOptions(unavailable)
  expect(optionsContent().textContent).toMatch(/unavailable/i)
  expect(unavailable.world.logs.join('\n')).toContain('temporary sidebar extras transport failure')
  expect(unavailable.world.preferences.workspaceActivityWindow).toBe('all')
})

test('review filters use server preferences, compose with activity, and clear independently', async () => {
  const h = setup({ view: { id: 'view:quirky.session/worktree', input: { worktree: 'w-child' } }, panel: null, sidebar: true, focus: 'view' })
  h.world.worktrees.find((item) => item.id === 'w-child')!.projectGroupId = 'g-team'
  h.world.reviews['w-child'] = { state: 'merged', checksStatus: 'failure' }
  h.world.reviews['w-other'] = { state: 'open', checksStatus: 'success' }
  await h.mount()
  await openFilters(h)

  expect(h.world.active).toEqual({ worktreeId: 'w-child', instanceId: 'instance-w-child' })
  expect(checkboxFor('Hide merged/closed reviews')?.checked).toBe(false)
  expect(checkboxFor('Hide passing checks')?.checked).toBe(false)
  expect(filterCount()).toBe('0')

  const pendingSet = h.deferNextSet()
  await h.click(checkboxFor('Hide merged/closed reviews')!)
  await pendingSet.started
  expect(checkboxFor('Hide merged/closed reviews')?.checked).toBe(false)
  expect(card('child')).toBeDefined()
  expect(filterCount()).toBe('0')
  pendingSet.release()
  await h.flush()

  expect(h.world.preferences.hideCompletedReviewWorkspaces).toBe(true)
  expect(checkboxFor('Hide merged/closed reviews')?.checked).toBe(true)
  expect(card('child')).toBeUndefined()
  expect(childChip('feature')).toBeFalsy()
  expect(lastReport(h).hiddenIds).toContain('w-child')
  expect(lastReport(h).reviewHiddenIds).toEqual(['w-child'])
  expect(lastReport(h).reviewHiddenCount).toBe(1)
  expect(lastReport(h).appliedFilter?.hideCompletedReviewWorkspaces).toBe(true)
  expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/set').at(-1)?.params).toEqual({ hideCompletedReviewWorkspaces: true })
  expect(filterCount()).toBe('1')

  await h.click(checkboxFor('Hide passing checks')!)
  expect(h.world.preferences.hidePassingCheckWorkspaces).toBe(true)
  expect(card('other')).toBeUndefined()
  expect(lastReport(h).reviewHiddenCount).toBe(2)
  expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/set').at(-1)?.params).toEqual({ hidePassingCheckWorkspaces: true })
  expect(filterCount()).toBe('2')

  await h.click(checkboxFor('Hide merged/closed reviews')!)
  expect(h.world.preferences.hideCompletedReviewWorkspaces).toBe(false)
  expect(card('child')).toBeDefined()
  expect(childChip('feature')).toBeDefined()
  expect(card('other')).toBeUndefined()
  expect(filterCount()).toBe('1')

  await h.click(checkboxFor('Hide merged/closed reviews')!)
  await selectWindow(h, 'Week')
  expect(h.world.preferences.workspaceActivityWindow).toBe('week')
  expect(lastReport(h).filterCount).toBe(3)
  expect(lastReport(h).hiddenCount).toBeGreaterThan(lastReport(h).reviewHiddenCount)
  expect(lastReport(h).reviewHiddenIds).toContain('w-child')
  expect(lastReport(h).hiddenIds).toContain('w-child')
  expect(lastReport(h).appliedFilter?.hidePassingCheckWorkspaces).toBe(true)
  expect(filterCount()).toBe('3')

  const recovery = buttons().find((button) => /hidden/i.test(button.textContent ?? ''))
  expect(recovery).toBeDefined()
  await h.click(recovery!)
  expect(h.world.preferences.workspaceActivityWindow).toBe('all')
  expect(h.world.preferences.hideCompletedReviewWorkspaces).toBe(true)
  expect(h.world.preferences.hidePassingCheckWorkspaces).toBe(true)
  expect(lastReport(h).hiddenCount).toBe(0)
  expect(lastReport(h).reviewHiddenCount).toBe(2)
  expect(card('child')).toBeUndefined()
  expect(card('other')).toBeUndefined()
  expect(filterCount()).toBe('2')

  await h.click(buttons().find((button) => button.textContent?.trim() === 'Clear filters')!)
  expect(h.world.preferences.workspaceActivityWindow).toBe('all')
  expect(h.world.preferences.hideCompletedReviewWorkspaces).toBe(false)
  expect(h.world.preferences.hidePassingCheckWorkspaces).toBe(false)
  expect(checkboxFor('Hide merged/closed reviews')?.checked).toBe(false)
  expect(checkboxFor('Hide passing checks')?.checked).toBe(false)
  expect(card('child')).toBeDefined()
  expect(card('other')).toBeDefined()
  expect(childChip('feature')).toBeDefined()
  expect(lastReport(h).reviewHiddenIds).toEqual([])
  expect(lastReport(h).reviewHiddenCount).toBe(0)
  expect(filterCount()).toBe('0')
})

test('hosting review events refresh only active filters and late projections cannot restore stale visibility', async () => {
  const h = setup()
  h.world.reviews['w-feature'] = { state: 'open', checksStatus: 'failure' }
  h.world.reviews['w-other'] = { state: 'open', checksStatus: 'success' }
  await h.mount()

  const offCalls = h.calls.length
  const offReports = h.reports.length
  await h.emit('quirky.hosting/changed')
  await h.emit('quirky.hosting/refresh')
  await h.emit('quirky.hosting/reviewCacheChanged')
  await h.flush()
  expect(h.calls).toHaveLength(offCalls)
  expect(h.reports).toHaveLength(offReports)

  await openFilters(h)
  await h.click(checkboxFor('Hide merged/closed reviews')!)
  await h.click(checkboxFor('Hide passing checks')!)
  expect(checkboxFor('Hide passing checks')?.checked).toBe(true)
  expect(card('other')).toBeUndefined()
  expect(card('feature')).toBeDefined()
  const activeCalls = h.calls.filter((call) => call.method === 'quirky.sidebar-extras/projection').length
  h.world.reviews['w-feature'] = { state: 'merged', checksStatus: 'failure' }
  await h.emit('quirky.hosting/reviewCacheChanged')
  await h.flush()
  expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/projection').length).toBeGreaterThan(activeCalls)
  expect(card('feature')).toBeUndefined()

  h.world.reviews['w-feature'] = { state: 'open', checksStatus: 'failure' }
  const delayed = h.deferNextProjection()
  await h.emit('quirky.hosting/reviewCacheChanged')
  await delayed.started
  h.world.reviews['w-feature'] = { state: 'merged', checksStatus: 'failure' }
  await h.emit('quirky.hosting/reviewCacheChanged')
  delayed.release()
  await h.flush()
  expect(card('feature')).toBeUndefined()
  expect(lastReport(h).reviewHiddenIds).toContain('w-feature')
})
test('quiet activity aging refreshes at sixty seconds without store events', async () => {
  const h = setup()
  h.world.preferences.workspaceActivityWindow = 'today'
  h.world.worktrees.find((item) => item.id === 'w-other')!.lastActivityAt = BASE - DAY + 1
  const timers = intervalClock()
  try {
    await h.mount()
    expect(card('other')).toBeDefined()
    const projectionCalls = h.calls.filter((call) => call.method === 'quirky.sidebar-extras/projection').length

    h.world.now = BASE + 59_999
    await act(async () => {
      timers.advance(59_999)
      await Promise.resolve()
    })
    await h.flush()
    expect(card('other')).toBeDefined()
    expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/projection')).toHaveLength(projectionCalls)

    h.world.now = BASE + 60_000
    await act(async () => {
      timers.advance(1)
      await Promise.resolve()
    })
    await h.flush()
    expect(card('other')).toBeUndefined()
    expect(lastReport(h).hiddenCount).toBeGreaterThan(0)
  } finally {
    await currentCleanup?.()
    currentCleanup = null
    timers.restore()
  }
})
test('section separators mark top-level boundaries only with Pinned first', async () => {
  const h = setup()
  await h.mount()
  const separators = lastReport(h).separators
  expect(separators.enabled).toBe(true)
  expect(separators.eligibleBoundaries).toContain('group:g-team')
  expect(separators.eligibleBoundaries).not.toContain('pinned')
})
test('sticky top-level headers suppress adjacent section separators', async () => {
  const style = document.createElement('style')
  style.textContent = 'section.group[data-top-level-section="group:g-team"] > header { position: sticky; }'
  document.head.append(style)
  const h = setup()
  try {
    await h.mount()
    const separators = lastReport(h).separators
    expect(separators.eligibleBoundaries).not.toContain('group:g-team')
    expect(separators.eligibleBoundaries).not.toContain('group:g-release')
    expect(separators.eligibleBoundaries).toContain('repo:r-web')
  } finally {
    style.remove()
  }
})

test('automation filtering uses only durable attribution and appears in visible counts', async () => {
  const h = setup()
  const attributed = h.world.worktrees.find((item) => item.id === 'w-lost')!
  attributed.name = 'auto-generated'
  attributed.automationProvenance = {
    kind: 'created-by-automation', automationId: 'auto-1', automationName: 'Audit',
    runId: 'run-1', runTitle: 'Audit run', projectId: 'r-web', hostId: 'local'
  }
  const namePrefixApi = h.world.worktrees.find((item) => item.id === 'w-other')!
  namePrefixApi.name = 'auto-manual'
  namePrefixApi.createdBy = 'api'
  await h.mount()
  await openFilters(h)

  expect(checkboxFor('Hide automation-created')?.checked).toBe(false)
  expect(card('auto-generated')).toBeDefined()
  expect(card('auto-manual')).toBeDefined()
  await h.click(checkboxFor('Hide automation-created')!)

  expect(h.world.preferences.hideAutomationCreated).toBe(true)
  expect(card('auto-generated')).toBeUndefined()
  expect(card('auto-manual')).toBeDefined()
  expect(lastReport(h).automationHiddenIds).toEqual(['w-lost'])
  expect(lastReport(h).automationHiddenCount).toBe(1)
  expect(lastReport(h).hiddenIds).toContain('w-lost')
  expect(lastReport(h).appliedFilter?.hideAutomationCreated).toBe(true)
  expect(lastReport(h).filterCount).toBe(1)
  expect(filterCount()).toBe('1')
  expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/set').at(-1)?.params).toEqual({ hideAutomationCreated: true })
})
