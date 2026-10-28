import { afterEach, expect, test } from 'bun:test'
import type { CliArgs, Session, UiState } from '@quirky/protocol'
import type { Group, GroupNode, Tab, ViewTab, Workspace } from '../../quirky.terminal/src/layout/types'
import { isViewTab } from '../../quirky.terminal/src/layout/types'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import type { IterationDetail, LoopSnapshot } from '../src/types'
import { commands as cliCommands } from '../cli'
import { loopConfig, startLoopRig, type LoopRig, type ScriptedTurn } from './rig'

const OVERLAY_ID = 'overlay:quirky.loops/dialogs'
const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
const HIDDEN_VIEW_ID = 'view:quirky.agents/settings'
const LOOP_VIEW_ID = 'view:quirky.loops/loop'

let rig: LoopRig | null = null
let headless: HeadlessWindow | null = null
let restoreWorkspaceViewport: (() => void) | null = null
let releaseTurn: (() => void) | null = null
const loopIds: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function measureWorkspaceViewport(): () => void {
  const prototype = Element.prototype
  const original = prototype.getBoundingClientRect
  const viewport = {
    left: 0,
    top: 0,
    width: 1000,
    height: 600,
    x: 0,
    y: 0,
    right: 1000,
    bottom: 600,
    toJSON: () => ({})
  } as DOMRect
  prototype.getBoundingClientRect = function (this: Element) {
    if (/\bqt-(panes|groups|body)\b/.test(this.getAttribute('class') ?? '')) return viewport
    return original.call(this)
  }
  return () => {
    prototype.getBoundingClientRect = original
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
        // A loop may already have stopped as part of the acceptance flow.
      }
    }
  }
  loopIds.length = 0
  await headless?.stop()
  headless = null
  restoreWorkspaceViewport?.()
  restoreWorkspaceViewport = null
  await rig?.cleanup()
  rig = null
})

function groupById(node: GroupNode, groupId: string): Group | null {
  if (node.kind === 'group') return node.id === groupId ? node : null
  return groupById(node.first, groupId) ?? groupById(node.second, groupId)
}

function tabsIn(node: GroupNode): Tab[] {
  if (node.kind === 'split') return [...tabsIn(node.first), ...tabsIn(node.second)]
  return node.tabs
}

function viewForLoop(workspace: Workspace, loopId: string): ViewTab | undefined {
  return tabsIn(workspace.root).find((tab): tab is ViewTab => isViewTab(tab) && tab.viewId === LOOP_VIEW_ID && tab.key === loopId)
}

function activeTab(workspace: Workspace): string | null {
  return groupById(workspace.root, workspace.activeGroup)?.activeTab ?? null
}

function overlayReport(state: UiState): Record<string, unknown> | null {
  const report = state.slots.find((slot) => slot.id === OVERLAY_ID)?.report
  return isRecord(report) ? report : null
}

function railIsForLoop(report: Record<string, unknown>, loopId: string): boolean {
  return isRecord(report.rail) && isRecord(report.rail.snapshot) && report.rail.snapshot.id === loopId
}

function railIsReadyForLoop(report: Record<string, unknown>, loopId: string): boolean {
  return railIsForLoop(report, loopId) &&
    isRecord(report.rail) &&
    report.rail.connectionStatus === 'connected' &&
    isRecord(report.rail.errors) &&
    report.rail.errors.snapshot === null
}

async function waitForOverlay(check: (report: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  if (!headless) throw new Error('headless window is not running')
  try {
    return await headless.waitFor(async () => {
      const state = await rig!.call<UiState>('ui.state', {})
      const report = overlayReport(state)
      return report && check(report) ? report : undefined
    })
  } catch (error) {
    const state = await rig!.call<UiState>('ui.state', {})
    throw new Error(`${String(error)}; ui.state=${JSON.stringify(state)}; page=${headless.document.body.textContent ?? ''}`)
  }
}

async function uiCommand(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    const response = await rig!.call<{ result: unknown }>('ui.command.run', {
      id: `command:quirky.loops/${name}`,
      args
    })
    return response.result
  } catch (error) {
    if (error instanceof Error) {
      error.stack = `${error.stack ?? error.message}\n    at uiCommand(${name}, ${JSON.stringify(args)})`
    }
    throw error
  }
}

async function cliUiCommand(name: string, args: CliArgs): Promise<void> {
  const handler = cliCommands[`cli-command:quirky.loops/${name}`]
  if (!handler) throw new Error(`missing loop CLI command ${name}`)
  const { context } = rig!.cliContext(true)
  try {
    await handler(args, context)
  } catch (error) {
    if (error instanceof Error) {
      error.stack = `${error.stack ?? error.message}\n    at cliUiCommand(${name}, ${JSON.stringify(args)})`
    }
    throw error
  }
}

async function workspace(): Promise<Workspace> {
  const result = await rig!.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig!.worktree.id })
  return result.workspace
}

async function waitForWindowView(id: string): Promise<void> {
  if (!headless) throw new Error('headless window is not running')
  await headless.waitFor(async () => {
    const state = await rig!.call<UiState>('ui.state', {})
    return isRecord(state.layout) && isRecord(state.layout.view) && state.layout.view.id === id ? true : undefined
  })
}

async function showWorktreeView(): Promise<void> {
  await rig!.call('ui.view.open', { id: WORKTREE_VIEW_ID, input: { worktree: rig!.worktree.id } })
  await rig!.call('ui.focus', { target: 'view' })
  await waitForWindowView(WORKTREE_VIEW_ID)
  await headless!.waitFor(() => headless!.document.querySelector('.qt-group'))
}

async function hideWorktreeView(): Promise<void> {
  await rig!.call('ui.view.open', { id: HIDDEN_VIEW_ID, input: {} })
  await rig!.call('ui.focus', { target: 'view' })
  await waitForWindowView(HIDDEN_VIEW_ID)
  await headless!.waitFor(() => headless!.document.querySelector('.qt-group') ? undefined : true)
}

// The combined flow has multiple waits; 30s covers 8–10s inner deadlines without enlarging them.
test('setup, lifecycle, queue, history, close and CLI actions use real daemon and window APIs', async () => {
  const started = Promise.withResolvers<void>()
  const heldTurn = Promise.withResolvers<{ status: 'waiting' }>()
  releaseTurn = () => heldTurn.resolve({ status: 'waiting' })
  const script: ScriptedTurn = async ({ text }) => {
    if (text.toLowerCase().includes('history fixture')) return { text: 'History fixture completed', status: 'done' }
    started.resolve()
    return heldTurn.promise
  }
  rig = await startLoopRig({
    extraPlugins: ['quirky.terminal', 'quirky.git', 'quirky.sidebar-extras'],
    script,
    onStop: () => releaseTurn?.()
  })
  const initial = await rig.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig.worktree.id, ensure: true })
  const groupId = initial.workspace.activeGroup
  const initialTab = activeTab(initial.workspace)
  headless = await startHeadlessWindow({ home: rig.home, runtime: rig.harness.runtime })
  restoreWorkspaceViewport = measureWorkspaceViewport()
  await hideWorktreeView()
  await waitForOverlay((report) => report.dialog === null)

  await uiCommand('new', { workspace: rig.worktree.id, group: groupId })
  const initialSetup = await waitForOverlay((report) =>
    isRecord(report.dialog) &&
    report.dialog.kind === 'setup' &&
    isRecord(report.setup) &&
    report.setup.loading === false
  )
  const initialSetupState = initialSetup.setup
  if (!isRecord(initialSetupState) || !isRecord(initialSetupState.draft)) throw new Error('setup report omitted its draft')
  expect(initialSetupState.draft.advanced).toBe(false)
  await uiCommand('setup-action', { action: 'cancel' })
  await waitForOverlay((report) => report.dialog === null)
  expect((await rig.call<LoopSnapshot[]>('quirky.loops/list', { worktreeId: rig.worktree.id })).length).toBe(0)
  expect(activeTab(await workspace())).toBe(initialTab)
  await expect(uiCommand('setup-action', { action: 'update', params: { patch: { prompt: 'stale' } } })).rejects.toThrow('no live loop setup surface')

  await cliUiCommand('ui-new', {
    positionals: [],
    flags: { workspace: rig.worktree.id, group: groupId }
  })
  const setupReport = await waitForOverlay((report) =>
    isRecord(report.dialog) &&
    report.dialog.kind === 'setup' &&
    isRecord(report.setup) &&
    report.setup.loading === false
  )
  expect(isRecord(setupReport.setup)).toBe(true)
  const setupState = setupReport.setup
  if (!isRecord(setupState) || !isRecord(setupState.draft)) throw new Error('setup report omitted its draft')
  expect(setupState.draft.advanced).toBe(false)
  await uiCommand('setup-action', {
    action: 'update',
    params: { patch: { name: 'UI loop', prompt: 'Keep this loop running during the API acceptance flow.' } }
  })
  const startResult = await uiCommand('setup-action', { action: 'start' })
  if (!isRecord(startResult) || startResult.ok !== true || !isRecord(startResult.loop) || typeof startResult.loop.id !== 'string') {
    const state = await rig.call<UiState>('ui.state', {})
    throw new Error(`setup start did not return a created loop: ${JSON.stringify(startResult)}; ui.state=${JSON.stringify(state)}`)
  }
  const createdId = startResult.loop.id
  const created = await headless.waitFor(async () => {
    const loops = await rig!.call<LoopSnapshot[]>('quirky.loops/list', { worktreeId: rig!.worktree.id })
    return loops.find((loop) => loop.id === createdId)
  })
  loopIds.push(created.id)
  await started.promise
  await rig.waitForLoop(created.id, (loop) => loop.state === 'running')
  const afterCreate = await workspace()
  const createdTab = viewForLoop(afterCreate, created.id)
  expect(createdTab).toBeDefined()
  expect(afterCreate.activeGroup).toBe(initial.workspace.activeGroup)
  expect(activeTab(afterCreate)).toBe(initialTab)
  await waitForOverlay((report) => report.dialog === null)

  await expect(uiCommand('action', { loopId: 'missing-live-loop', action: 'pause' })).rejects.toThrow('no live loop view surface')
  await uiCommand('open', { loopId: created.id })
  await showWorktreeView()
  const activeViewWorkspace = await workspace()
  const activeViewTab = viewForLoop(activeViewWorkspace, created.id)
  expect(activeViewTab).toBeDefined()
  expect(activeTab(activeViewWorkspace)).toBe(activeViewTab!.id)
  await waitForOverlay((report) => railIsReadyForLoop(report, created.id))
  await uiCommand('action', { loopId: created.id, action: 'steer-open' })
  await uiCommand('action', { loopId: created.id, action: 'steer-update', params: { text: 'Unsent guidance draft' } })
  await waitForOverlay((report) =>
    railIsForLoop(report, created.id) && isRecord(report.rail) && report.rail.steerDraft === 'Unsent guidance draft'
  )
  await uiCommand('action', { loopId: created.id, action: 'steer-cancel' })

  await hideWorktreeView()
  await uiCommand('close-tab', { loopId: created.id, tabId: activeViewTab!.id })
  await waitForOverlay((report) => isRecord(report.close) && report.close.loopId === created.id)
  await cliUiCommand('ui-close-choice', { positionals: ['cancel'], flags: {} })
  expect(viewForLoop(await workspace(), created.id)).toBeDefined()
  expect((await rig.snapshot(created.id)).state).toBe('running')

  const sessionBeforeDetach = (await rig.snapshot(created.id)).sessionId
  await uiCommand('close-tab', { loopId: created.id, tabId: activeViewTab!.id })
  await uiCommand('close-choice', { choice: 'keep-running' })
  expect(viewForLoop(await workspace(), created.id)).toBeUndefined()
  expect((await rig.snapshot(created.id)).state).toBe('running')
  expect((await rig.snapshot(created.id)).sessionId).toBe(sessionBeforeDetach)

  await uiCommand('open', { loopId: created.id })
  await showWorktreeView()
  const reopened = viewForLoop(await workspace(), created.id)
  if (!reopened) throw new Error('explicit open did not restore the loop tab')
  await hideWorktreeView()
  await uiCommand('close-tab', { loopId: created.id, tabId: reopened.id })
  await waitForOverlay((report) => isRecord(report.close) && report.close.loopId === created.id)
  const staleBinding = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    viewId: LOOP_VIEW_ID,
    key: created.id,
    title: created.name,
    input: { loopId: created.id },
    activate: false,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: 'quirky.loops/viewCloseGuard',
    closeParams: { loopId: 'stale-binding' },
    closeContext: true
  })
  expect(staleBinding.tab).toBe(reopened.id)
  const stopError = await uiCommand('close-choice', { choice: 'stop' }).then(
    () => null,
    (error: unknown) => error instanceof Error ? error.message : String(error)
  )
  if (stopError === null) throw new Error('stop choice accepted a loop tab with stale binding metadata')
  expect(stopError).toBe(`no hosted loop tab ${reopened.id} for ${created.id}`)
  expect(viewForLoop(await workspace(), created.id)).toMatchObject({
    id: reopened.id,
    viewId: LOOP_VIEW_ID,
    key: created.id,
    input: { loopId: created.id },
    closeParams: { loopId: 'stale-binding' },
    closeContext: true
  })
  expect((await rig.snapshot(created.id)).state).toBe('running')
  const failureToast = await headless!.waitFor(async () => {
    const state = await rig!.call<UiState>('ui.state', {})
    return state.toasts.find((toast) => toast.body === stopError)
  })
  expect(failureToast.body).toBe(stopError)
  const restoredBinding = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    viewId: LOOP_VIEW_ID,
    key: created.id,
    title: created.name,
    input: { loopId: created.id },
    activate: false,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: 'quirky.loops/viewCloseGuard',
    closeParams: { loopId: created.id },
    closeContext: true
  })
  expect(restoredBinding.tab).toBe(reopened.id)
  expect(viewForLoop(restoredBinding.workspace, created.id)).toMatchObject({
    id: reopened.id,
    viewId: LOOP_VIEW_ID,
    key: created.id,
    input: { loopId: created.id },
    closeParams: { loopId: created.id },
    closeContext: true
  })
  await uiCommand('close-choice', { choice: 'stop' })
  expect(viewForLoop(await workspace(), created.id)).toBeUndefined()
  expect((await rig.snapshot(created.id)).state).toBe('stopped')

  const queueLoop = await rig.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig.worktree.id,
    agent: 'claude',
    preset: 'queue',
    queueItems: [{ body: 'Queue first task' }, { body: 'Queue second task' }],
    config: loopConfig('unused', {
      promptSource: { kind: 'queue', repeatQueue: false },
      sessionPolicy: 'continue'
    })
  })
  loopIds.push(queueLoop.id)
  await uiCommand('open', { loopId: queueLoop.id })
  await showWorktreeView()
  await waitForOverlay((report) => railIsReadyForLoop(report, queueLoop.id))
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-draft', params: { body: 'Unsent queue draft' } })
  await waitForOverlay((report) =>
    railIsForLoop(report, queueLoop.id) &&
    isRecord(report.rail) &&
    isRecord(report.rail.queueDraft) &&
    report.rail.queueDraft.addDraft === 'Unsent queue draft'
  )
  expect((await rig.snapshot(queueLoop.id)).queueItems.some((item) => item.body === 'Unsent queue draft')).toBe(false)
  await cliUiCommand('ui-action', {
    positionals: [queueLoop.id, 'queue-add'],
    flags: { payload: JSON.stringify({ body: 'Queue third task' }) }
  })
  let queueState = await rig.snapshot(queueLoop.id)
  const added = queueState.queueItems.find((item) => item.body === 'Queue third task')
  if (!added) throw new Error('queue-add did not persist the new task')
  const editableItem = queueState.queueItems.find((item) => item.state !== 'in-flight')
  if (!editableItem) throw new Error('queue fixture has no editable pending task')
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-edit-open', params: { id: editableItem.id } })
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-edit-update', params: { body: 'Unsent edit draft' } })
  await waitForOverlay((report) =>
    railIsForLoop(report, queueLoop.id) &&
    isRecord(report.rail) &&
    isRecord(report.rail.queueDraft) &&
    report.rail.queueDraft.editingId === editableItem.id &&
    report.rail.queueDraft.editingBody === 'Unsent edit draft'
  )
  expect((await rig.snapshot(queueLoop.id)).queueItems.find((item) => item.id === editableItem.id)?.body).toBe(editableItem.body)
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-edit-cancel' })
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-edit', params: { id: added.id, body: 'Edited third task' } })
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-move', params: { id: added.id, position: 1 } })
  queueState = await rig.snapshot(queueLoop.id)
  expect(queueState.queueItems.find((item) => item.id === added.id)?.body).toBe('Edited third task')
  await uiCommand('action', { loopId: queueLoop.id, action: 'queue-remove', params: { id: added.id } })
  expect((await rig.snapshot(queueLoop.id)).queueItems.some((item) => item.id === added.id)).toBe(false)

  await uiCommand('action', { loopId: queueLoop.id, action: 'edit-open' })
  await uiCommand('action', {
    loopId: queueLoop.id,
    action: 'edit-update',
    params: { patch: { name: 'Edited queue loop', pacingKind: 'interval', intervalMinutes: '30', anchor: 'from-end' } }
  })
  await uiCommand('action', { loopId: queueLoop.id, action: 'edit-save' })
  const editedQueue = await rig.snapshot(queueLoop.id)
  expect(editedQueue.name).toBe('Edited queue loop')
  expect(editedQueue.preset).toBe('queue')
  expect(editedQueue.config.pacing).toEqual({ kind: 'interval', minutes: 30, anchor: 'from-end' })

  const historyLoop = await rig.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig.worktree.id,
    agent: 'claude',
    config: loopConfig('history fixture', { caps: { maxIterations: 1 } })
  })
  loopIds.push(historyLoop.id)
  const withHistory = await rig.waitForLoop(
    historyLoop.id,
    (loop) => loop.state === 'paused' && loop.pauseReason === 'cap-iterations' && loop.iterationsCompleted === 1
  )
  const iterations = await rig.call<IterationDetail[]>('quirky.loops/iterations', { loopId: historyLoop.id })
  expect({
    state: withHistory.state,
    pauseReason: withHistory.pauseReason,
    iterationsCompleted: withHistory.iterationsCompleted
  }).toEqual({ state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 1 })
  expect(iterations.map(({ loopId, n, attempt, endReason }) => ({ loopId, n, attempt, endReason }))).toEqual([
    { loopId: historyLoop.id, n: 1, attempt: 1, endReason: 'settled' }
  ])
  await headless.waitFor(async () => {
    const sessions = await rig!.call<Session[]>('quirky.session/list', {})
    return sessions.every((session) => session.id !== withHistory.sessionId) || undefined
  })
  await cliUiCommand('ui-open', { positionals: [historyLoop.id], flags: {} })
  await waitForOverlay((report) => railIsReadyForLoop(report, historyLoop.id))
  await headless.waitFor(() =>
    headless!.document.querySelector('[aria-label="Loop output"]')?.textContent?.includes('History fixture completed') || undefined
  )
  await uiCommand('action', { loopId: historyLoop.id, action: 'resume-update', params: { value: '2' } })
  await waitForOverlay((report) => railIsForLoop(report, historyLoop.id) && isRecord(report.rail) && report.rail.resumeAdd === '2')
  const detail = iterations[0]!
  await cliUiCommand('ui-action', {
    positionals: [historyLoop.id, 'iteration'],
    flags: { payload: JSON.stringify({ n: detail.n, attempt: detail.attempt }) }
  })
  await waitForOverlay((report) => isRecord(report.detail) && report.detail.n === detail.n && report.detail.attempt === detail.attempt)
  await uiCommand('action', { loopId: historyLoop.id, action: 'back' })
  await waitForOverlay((report) => report.detail === null)
  const pausedTab = viewForLoop(await workspace(), historyLoop.id)
  if (!pausedTab) throw new Error('the paused loop lost its hosted view')
  await rig.call('quirky.loops/closeView', { loopId: historyLoop.id, tabId: pausedTab.id, choice: 'stop' })
  expect((await rig.snapshot(historyLoop.id)).state).toBe('stopped')
  expect(viewForLoop(await workspace(), historyLoop.id)).toBeUndefined()
  await hideWorktreeView()
}, 30_000)
