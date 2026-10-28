import { afterEach, expect, test } from 'bun:test'
import type { Session, UiState } from '@quirky/protocol'
import { isViewTab, type Group, type GroupNode, type Tab, type ViewTab, type Workspace } from '../../quirky.terminal/src/layout/types'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { loopConfig, startLoopRig, type LoopRig } from '../../quirky.loops/test/rig'

const WORKTREE_SLOT = 'sidebar-section:quirky.worktree/worktrees'
const LOOP_VIEW = 'view:quirky.loops/loop'
const CLOSE_GUARD = 'quirky.loops/viewCloseGuard'

type LoopApiSnapshot = {
  id: string
  name: string
  state: 'running' | 'needs-you' | 'paused' | 'completed' | 'stopped'
  pauseReason: string | null
  sessionId: string | null
  iterationsCompleted: number
}
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

let rig: LoopRig | null = null
let headless: HeadlessWindow | null = null
let releaseTurn: (() => void) | null = null
const loopIds: string[] = []

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function groupById(node: GroupNode, groupId: string): Group | null {
  if (node.kind === 'group') return node.id === groupId ? node : null
  return groupById(node.first, groupId) ?? groupById(node.second, groupId)
}

function tabsIn(node: GroupNode): Tab[] {
  return node.kind === 'split' ? [...tabsIn(node.first), ...tabsIn(node.second)] : node.tabs
}

function viewForLoop(workspace: Workspace, loopId: string): ViewTab | undefined {
  return tabsIn(workspace.root).find(
    (tab): tab is ViewTab => isViewTab(tab) && tab.viewId === LOOP_VIEW && tab.key === loopId
  )
}

function activeTab(workspace: Workspace): string | null {
  return groupById(workspace.root, workspace.activeGroup)?.activeTab ?? null
}

function findWorktree(report: Record<string, unknown>, worktreeId: string): Record<string, unknown> | undefined {
  const projects = Array.isArray(report.projects) ? report.projects : []
  const groups = Array.isArray(report.groups) ? report.groups : []
  const projectRows = projects.flatMap((project) => isRecord(project) && Array.isArray(project.worktrees) ? project.worktrees : [])
  const groupRows = groups.flatMap((group) => {
    if (!isRecord(group)) return []
    const rows = Array.isArray(group.worktrees) ? group.worktrees : []
    const nestedProjects = Array.isArray(group.projects) ? group.projects : []
    return [...rows, ...nestedProjects.flatMap((project) => isRecord(project) && Array.isArray(project.worktrees) ? project.worktrees : [])]
  })
  return [...projectRows, ...groupRows].find((row): row is Record<string, unknown> => isRecord(row) && row.id === worktreeId)
}

async function sidebarReport(): Promise<Record<string, unknown> | undefined> {
  const state = await rig!.call<UiState>('ui.state', {})
  const value = state.slots.find((slot) => slot.id === WORKTREE_SLOT)?.report
  return isRecord(value) ? value : undefined
}

async function workspace(): Promise<Workspace> {
  const result = await rig!.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig!.worktree.id })
  return result.workspace
}

async function waitForSidebar(check: (report: Record<string, unknown>, row: Record<string, unknown>) => boolean) {
  if (!headless) throw new Error('headless window is not running')
  try {
    return await headless.waitFor(async () => {
      const report = await sidebarReport()
      const row = report && findWorktree(report, rig!.worktree.id)
      return report && row && check(report, row) ? { report, row } : undefined
    })
  } catch (error) {
    const report = await sidebarReport().catch(() => undefined)
    throw new Error(`${String(error)}; sidebar report=${JSON.stringify(report)}`)
  }
}

afterEach(async () => {
  releaseTurn?.()
  releaseTurn = null
  if (rig) {
    for (const loopId of loopIds) {
      try {
        await rig.call('quirky.loops/stop', { loopId, mode: 'now' })
      } catch {
        // The lifecycle assertion may already have stopped the loop.
      }
    }
  }
  loopIds.length = 0
  await headless?.stop()
  headless = null
  await rig?.cleanup()
  rig = null
})

test('public loop create, hosted-view binding and stop stay in sync with the sidebar report without focus or shell adoption', async () => {
  const turnStarted = Promise.withResolvers<void>()
  const heldTurn = Promise.withResolvers<string>()
  releaseTurn = () => heldTurn.resolve('iteration completed')
  rig = await startLoopRig({
    extraPlugins: ['quirky.cli', 'quirky.terminal', 'quirky.git', 'quirky.sidebar-extras'],
    script: async () => {
      turnStarted.resolve()
      return heldTurn.promise
    },
    onStop: () => releaseTurn?.()
  })

  const focusAnchor = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    viewId: 'view:quirky.git/ai-settings',
    key: 'sidebar-loop-focus-anchor',
    title: 'Source Control AI settings',
    input: { worktree: rig.worktree.id }
  })
  const initialWorkspace = focusAnchor.workspace
  const initialActiveTab = activeTab(initialWorkspace)
  expect(initialActiveTab).toBe(focusAnchor.tab)
  headless = await startHeadlessWindow({ home: rig.home, runtime: rig.harness.runtime })
  const initialReport = await headless.waitFor(async () => {
    const report = await sidebarReport()
    return report && findWorktree(report, rig!.worktree.id) ? report : undefined
  })
  expect(findWorktree(initialReport, rig.worktree.id)?.id).toBe(rig.worktree.id)
  const initialUiState = await rig.call<UiState>('ui.state', {})

  const created = await rig.call<LoopApiSnapshot>('quirky.loops/create', {
    worktreeId: rig.worktree.id,
    agent: 'claude',
    name: 'Sidebar API loop',
    config: loopConfig('Complete one controlled sidebar integration iteration', { caps: { maxIterations: 1 } })
  })
  loopIds.push(created.id)
  await turnStarted.promise
  const running = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'running')

  const opened = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    viewId: LOOP_VIEW,
    key: created.id,
    title: running.name,
    input: { loopId: created.id },
    activate: false,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: CLOSE_GUARD,
    closeParams: { loopId: created.id },
    closeContext: true
  })
  expect(viewForLoop(opened.workspace, created.id)).toMatchObject({
    viewId: LOOP_VIEW,
    key: created.id,
    input: { loopId: created.id },
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: CLOSE_GUARD,
    closeParams: { loopId: created.id },
    closeContext: true
  })
  expect(opened.workspace.activeGroup).toBe(initialWorkspace.activeGroup)
  expect(activeTab(opened.workspace)).toBe(initialActiveTab)

  const runningReport = await waitForSidebar((_report, row) => {
    const loop = row.loop
    return isRecord(loop) && loop.id === created.id && loop.state === 'running' && loop.presentation === 'running'
  })
  expect(runningReport.report.loops).toMatchObject({ status: 'available' })
  expect(runningReport.row.loop).toMatchObject({
    id: created.id,
    state: 'running',
    pauseReason: null,
    presentation: 'running',
    iterationsCompleted: 0,
    maxIterations: 1,
    label: 'Loop 0/1 · running'
  })

  releaseTurn()
  releaseTurn = null
  const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused' && snapshot.iterationsCompleted === 1)
  const pausedReport = await waitForSidebar((_report, row) => {
    const loop = row.loop
    return isRecord(loop) && loop.id === created.id && loop.state === 'paused' && loop.presentation === 'paused' &&
      loop.iterationsCompleted === paused.iterationsCompleted
  })
  expect(pausedReport.row.loop).toMatchObject({
    id: paused.id,
    state: paused.state,
    pauseReason: paused.pauseReason,
    presentation: 'paused',
    iterationsCompleted: paused.iterationsCompleted,
    maxIterations: 1,
    label: 'Loop 1/1 · paused: cap-iterations'
  })

  const stopped = await rig.call<LoopApiSnapshot>('quirky.loops/stop', { loopId: created.id, mode: 'now' })
  expect(stopped.state).toBe('stopped')
  const stoppedReport = await waitForSidebar((report, row) =>
    isRecord(report.loops) && report.loops.status === 'available' && !('loop' in row)
  )
  expect(stoppedReport.row).not.toHaveProperty('loop')
  expect(stoppedReport.report.loops).toMatchObject({ status: 'available' })

  const finalWorkspace = await workspace()
  expect(finalWorkspace.activeGroup).toBe(initialWorkspace.activeGroup)
  expect(activeTab(finalWorkspace)).toBe(initialActiveTab)
  const finalUiState = await rig.call<UiState>('ui.state', {})
  expect(finalUiState.layout).toEqual(initialUiState.layout)
  const sessions = await rig.call<Session[]>('quirky.session/list', {})
  expect(sessions.some((session) => session.agent === 'shell')).toBe(false)
  expect(rig.harness.pty.requests.some((request) => request.type === 'create')).toBe(false)
}, 30_000)
