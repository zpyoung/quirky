import { afterEach, expect, test } from 'bun:test'
import type { CliArgs, UiModel, UiState } from '@quirky/protocol'
import type { Group, GroupNode, Tab, ViewTab, Workspace } from '../../quirky.terminal/src/layout/types'
import { isViewTab } from '../../quirky.terminal/src/layout/types'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import type { IterationDetail, LoopSnapshot } from '../src/types'
import { commands as cliCommands } from '../cli'
import { loopConfig, startLoopRig, type LoopRig, type ScriptedTurn } from './rig'

const OVERLAY_ID = 'overlay:quirky.loops/dialogs'
const LOOP_VIEW_ID = 'view:quirky.loops/loop'

let rig: LoopRig | null = null
let headless: HeadlessWindow | null = null
let releaseTurn: (() => void) | null = null
let failStop = false
const loopIds: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

afterEach(async () => {
  releaseTurn?.()
  releaseTurn = null
  failStop = false
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

async function waitForOverlay(check: (report: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  if (!headless) throw new Error('headless window is not running')
  return headless.waitFor(async () => {
    const state = await rig!.call<UiState>('ui.state', {})
    const report = overlayReport(state)
    return report && check(report) ? report : undefined
  })
}

async function uiCommand(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await rig!.call<{ result: unknown }>('ui.command.run', {
    id: `command:quirky.loops/${name}`,
    args
  })
  return response.result
}

async function cliUiCommand(name: string, args: CliArgs): Promise<void> {
  const handler = cliCommands[`cli-command:quirky.loops/${name}`]
  if (!handler) throw new Error(`missing loop CLI command ${name}`)
  const { context } = rig!.cliContext(true)
  await handler(args, context)
}

async function workspace(): Promise<Workspace> {
  const result = await rig!.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig!.worktree.id })
  return result.workspace
}

test('plus setup, lifecycle, queue, history, close and CLI actions use real daemon and window APIs', async () => {
  const started = Promise.withResolvers<void>()
  const heldTurn = Promise.withResolvers<{ status: 'waiting' }>()
  releaseTurn = () => heldTurn.resolve({ status: 'waiting' })
  const script: ScriptedTurn = async ({ text }) => {
    if (text.toLowerCase().includes('history fixture')) return { text: 'History fixture completed', status: 'done' }
    started.resolve()
    return heldTurn.promise
  }
  rig = await startLoopRig({
    extraPlugins: ['quirky.terminal'],
    script,
    onStop: () => {
      if (failStop) throw new Error('fixture stop failure')
    }
  })
  const initial = await rig.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig.worktree.id, ensure: true })
  const groupId = initial.workspace.activeGroup
  const initialTab = activeTab(initial.workspace)
  headless = await startHeadlessWindow({ home: rig.home, runtime: rig.harness.runtime })
  await rig.call('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: rig.worktree.id } })
  await rig.call('ui.focus', { target: 'view' })
  await headless.waitFor(() => headless!.document.querySelector(`[data-plus="${groupId}"]`))

  const model = await rig.call<UiModel>('ui.contributions', {})
  expect(model.menuItems.some((item) => item.id === 'menu-item:quirky.loops/new-loop' && item.menu === 'quirky.terminal/plus')).toBe(true)
  const commandIds = model.commands.map((command) => command.id)
  for (const name of ['new', 'setup-action', 'open', 'action', 'close-tab', 'close-choice']) {
    expect(commandIds).toContain(`command:quirky.loops/${name}`)
  }

  await headless.click(`[data-plus="${groupId}"]`)
  const menuLabels = await headless.waitFor(() => {
    const labels = [...headless!.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map((item) => (item.textContent ?? '').trim())
    return labels.includes('Loop…') ? labels : undefined
  })
  expect(menuLabels.at(-1)).toBe('Loop…')
  const loopRow = [...headless.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => (item.textContent ?? '').includes('Loop…'))
  if (!loopRow) throw new Error('Loop… is missing from the plus menu')
  loopRow.click()
  await waitForOverlay((report) => isRecord(report.dialog) && report.dialog.kind === 'setup')
  expect(headless.document.body.textContent).toContain('Enter a prompt to start the loop.')
  await uiCommand('setup-action', { action: 'cancel' })
  await waitForOverlay((report) => report.dialog === null)
  expect((await rig.call<LoopSnapshot[]>('quirky.loops/list', { worktreeId: rig.worktree.id })).length).toBe(0)
  expect(activeTab(await workspace())).toBe(initialTab)
  await expect(uiCommand('setup-action', { action: 'update', params: { patch: { prompt: 'stale' } } })).rejects.toThrow('no live loop setup surface')

  await cliUiCommand('ui-new', {
    positionals: [],
    flags: { workspace: rig.worktree.id, group: groupId }
  })
  const setupReport = await waitForOverlay((report) => report.dialog !== null && isRecord(report.setup))
  expect(isRecord(setupReport.setup)).toBe(true)
  const setupState = setupReport.setup
  if (!isRecord(setupState) || !isRecord(setupState.draft)) throw new Error('setup report omitted its draft')
  expect(setupState.draft.advanced).toBe(false)
  await uiCommand('setup-action', {
    action: 'update',
    params: { patch: { name: 'UI loop', prompt: 'Keep this loop running during the API acceptance flow.' } }
  })
  await uiCommand('setup-action', { action: 'start' })
  const created = await headless.waitFor(async () => {
    const loops = await rig!.call<LoopSnapshot[]>('quirky.loops/list', { worktreeId: rig!.worktree.id })
    return loops[0]
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
  const activeViewWorkspace = await workspace()
  const activeViewTab = viewForLoop(activeViewWorkspace, created.id)
  expect(activeViewTab).toBeDefined()
  expect(activeTab(activeViewWorkspace)).toBe(activeViewTab!.id)
  await waitForOverlay((report) => railIsForLoop(report, created.id))
  await uiCommand('action', { loopId: created.id, action: 'steer-open' })
  await uiCommand('action', { loopId: created.id, action: 'steer-update', params: { text: 'Unsent guidance draft' } })
  await waitForOverlay((report) =>
    railIsForLoop(report, created.id) && isRecord(report.rail) && report.rail.steerDraft === 'Unsent guidance draft'
  )
  await uiCommand('action', { loopId: created.id, action: 'steer-cancel' })

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
  const reopened = viewForLoop(await workspace(), created.id)
  if (!reopened) throw new Error('explicit open did not restore the loop tab')
  await uiCommand('close-tab', { loopId: created.id, tabId: reopened.id })
  await waitForOverlay((report) => isRecord(report.close) && report.close.loopId === created.id)
  failStop = true
  await expect(uiCommand('close-choice', { choice: 'stop' })).rejects.toThrow()
  expect(viewForLoop(await workspace(), created.id)).toBeDefined()
  await headless!.waitFor(async () => {
    const state = await rig!.call<UiState>('ui.state', {})
    return state.toasts.some((toast) => toast.title === 'Could not update the loop, so the tab stays open.') || undefined
  })
  failStop = false
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
  await waitForOverlay((report) => railIsForLoop(report, queueLoop.id))
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
  await uiCommand('action', { loopId: queueLoop.id, action: 'edit-update', params: { patch: { name: 'Edited queue loop' } } })
  await uiCommand('action', { loopId: queueLoop.id, action: 'edit-save' })
  expect((await rig.snapshot(queueLoop.id)).name).toBe('Edited queue loop')

  const historyLoop = await rig.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig.worktree.id,
    agent: 'claude',
    config: loopConfig('history fixture', { caps: { maxIterations: 1 } })
  })
  loopIds.push(historyLoop.id)
  const withHistory = await rig.waitForLoop(historyLoop.id, (loop) => loop.iterationsCompleted > 0)
  const iterations = await rig.call<IterationDetail[]>('quirky.loops/iterations', { loopId: historyLoop.id })
  expect(iterations.length).toBeGreaterThan(0)
  await cliUiCommand('ui-open', { positionals: [historyLoop.id], flags: {} })
  await waitForOverlay((report) => railIsForLoop(report, historyLoop.id))
  await uiCommand('action', { loopId: historyLoop.id, action: 'resume-update', params: { value: '2' } })
  await waitForOverlay((report) => railIsForLoop(report, historyLoop.id) && isRecord(report.rail) && report.rail.resumeAdd === '2')
  const detail = iterations[0]!
  await cliUiCommand('ui-action', {
    positionals: [historyLoop.id, 'iteration'],
    flags: { payload: JSON.stringify({ n: detail.n, attempt: detail.attempt }) }
  })
  await waitForOverlay((report) => isRecord(report.detail) && report.detail.n === detail.n && report.detail.attempt === detail.attempt)
  expect(withHistory.iterationsCompleted).toBeGreaterThan(0)
  await uiCommand('action', { loopId: historyLoop.id, action: 'back' })
  await waitForOverlay((report) => report.detail === null)
})
