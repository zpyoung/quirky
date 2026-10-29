import { afterEach, expect, test } from 'bun:test'
import type { CliArgs, UiState } from '@quirky/protocol'
import type { Group, GroupNode, Tab, ViewTab, Workspace } from '../../quirky.terminal/src/layout/types'
import { isViewTab } from '../../quirky.terminal/src/layout/types'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import type { IterationDetail, LoopSnapshot } from '../src/types'
import { commands as cliCommands } from '../cli'
import type { CodexAppServerLogEntry, CodexAppServerFixture } from '../../quirky.structured/test/fakes/codex-app-server'
import { loopConfig, startLoopRig, type LoopRig } from './rig'

const OVERLAY_ID = 'overlay:quirky.loops/dialogs'
const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
const HIDDEN_VIEW_ID = 'view:quirky.agents/settings'
const LOOP_VIEW_ID = 'view:quirky.loops/loop'
const EXTRA_PLUGINS = ['quirky.terminal', 'quirky.git', 'quirky.sidebar-extras']

type NativeSession = {
  id: string
  status: string
  providerSession?: { id?: string | null } | null
}

type NativeTurn = {
  loop: LoopSnapshot
  session: NativeSession
  threadId: string
  start: CodexAppServerLogEntry
}

let rig: LoopRig | null = null
let headless: HeadlessWindow | null = null
let restoreWorkspaceViewport: (() => void) | null = null
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
  try {
    await headless?.stop()
  } finally {
    headless = null
    try {
      restoreWorkspaceViewport?.()
    } finally {
      restoreWorkspaceViewport = null
      try {
        await rig?.cleanup()
      } finally {
        rig = null
      }
    }
  }
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

function overlayReport(state: UiState): Record<string, unknown> | null {
  const report = state.slots.find((slot) => slot.id === OVERLAY_ID)?.report
  return isRecord(report) ? report : null
}

function railIsReadyForLoop(report: Record<string, unknown>, loopId: string): boolean {
  return isRecord(report.rail) &&
    isRecord(report.rail.snapshot) &&
    report.rail.snapshot.id === loopId &&
    report.rail.connectionStatus === 'connected' &&
    isRecord(report.rail.errors) &&
    report.rail.errors.snapshot === null
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

async function waitForWindowView(id: string): Promise<void> {
  await headless!.waitFor(async () => {
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

async function waitForRail(loopId: string): Promise<void> {
  await headless!.waitFor(async () => {
    const state = await rig!.call<UiState>('ui.state', {})
    const report = overlayReport(state)
    return report && railIsReadyForLoop(report, loopId) ? report : undefined
  })
}

async function openRail(loopId: string): Promise<void> {
  await uiCommand('open', { loopId })
  await showWorktreeView()
  await waitForRail(loopId)
}

function nativeFixture(): CodexAppServerFixture {
  if (!rig?.nativeFixture) throw new Error('native Codex fixture was not installed')
  return rig.nativeFixture
}

function inputText(entry: CodexAppServerLogEntry): string {
  const input = entry.params?.input
  if (!Array.isArray(input)) return ''
  return input
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'text')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('\n')
}

function requestsFor(method: string, threadId: string): CodexAppServerLogEntry[] {
  return nativeFixture().requests().filter((entry) => entry.method === method && entry.params?.threadId === threadId)
}

async function waitForNativeTurn(loopId: string, promptPart: string, timeoutMs?: number): Promise<NativeTurn> {
  return headless!.waitFor(async () => {
    const loop = await rig!.snapshot(loopId)
    if (!loop.sessionId || loop.state !== 'running') return undefined
    const session = await rig!.call<NativeSession>('quirky.session/get', { session: loop.sessionId })
    const threadId = session.providerSession?.id
    if (!threadId || session.status !== 'working') return undefined
    const start = requestsFor('turn/start', threadId).find((entry) => inputText(entry).includes(promptPart))
    return start ? { loop, session, threadId, start } : undefined
  }, timeoutMs)
}

async function sessionFor(sessionId: string): Promise<NativeSession> {
  return rig!.call<NativeSession>('quirky.session/get', { session: sessionId })
}

async function createRepeatLoop(name: string, prompt: string): Promise<LoopSnapshot> {
  const loop = await rig!.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig!.worktree.id,
    name,
    agent: 'codex',
    config: loopConfig(prompt, { sessionPolicy: 'continue', caps: { maxIterations: 5 } })
  })
  loopIds.push(loop.id)
  return loop
}

async function renderedButton(label: string): Promise<HTMLButtonElement> {
  return headless!.waitFor(() => {
    const button = [...headless!.document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
    return button ?? undefined
  })
}

async function clickRenderedButton(label: string): Promise<void> {
  ;(await renderedButton(label)).click()
}

async function waitForDialog(title: string): Promise<Element> {
  return headless!.waitFor(() => {
    const dialog = [...headless!.document.querySelectorAll('[role="dialog"]')]
      .find((candidate) => candidate.textContent?.includes(title))
    return dialog ?? undefined
  })
}

async function waitForDialogClosed(title: string): Promise<void> {
  await headless!.waitFor(() => {
    const dialog = [...headless!.document.querySelectorAll('[role="dialog"]')]
      .some((candidate) => candidate.textContent?.includes(title))
    return dialog ? undefined : true
  })
}

async function openStopDialog(): Promise<void> {
  await clickRenderedButton('Stop')
  await waitForDialog('Stop the loop')
}

async function requestTabClose(loopId: string): Promise<ViewTab> {
  await hideWorktreeView()
  const tab = viewForLoop(await workspace(), loopId)
  if (!tab) throw new Error(`loop ${loopId} has no hosted tab to close`)
  await uiCommand('close-tab', { loopId, tabId: tab.id })
  await waitForDialog('Close a running loop?')
  return tab
}

async function createQueueLoop(): Promise<LoopSnapshot> {
  const loop = await rig!.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig!.worktree.id,
    name: 'Detached native queue',
    agent: 'codex',
    preset: 'queue',
    queueItems: [
      { body: 'First queue work [hold]' },
      { body: 'Second queue work [hold]' }
    ],
    config: loopConfig('unused queue prompt', {
      promptSource: { kind: 'queue', repeatQueue: false },
      sessionPolicy: 'continue',
      caps: { maxIterations: 5 }
    })
  })
  loopIds.push(loop.id)
  return loop
}

async function startNativeRig(): Promise<void> {
  rig = await startLoopRig({ nativeCodex: true, extraPlugins: EXTRA_PLUGINS })
  headless = await startHeadlessWindow({ home: rig.home, runtime: rig.harness.runtime })
  restoreWorkspaceViewport = measureWorkspaceViewport()
  await rig.call('quirky.terminal/workspace', { workspace: rig.worktree.id, ensure: true })
  await hideWorktreeView()
}

test('rendered Stop Cancel and After this iteration preserve a held native turn until structured steering settles it', async () => {
  await startNativeRig()
  const loop = await createRepeatLoop('Deferred native stop', 'Hold this native iteration [hold]')
  const held = await waitForNativeTurn(loop.id, 'Hold this native iteration [hold]')
  await openRail(loop.id)

  await openStopDialog()
  await clickRenderedButton('Cancel')
  await waitForDialogClosed('Stop the loop')
  const afterCancel = await rig!.snapshot(loop.id)
  expect(afterCancel.state).toBe('running')
  expect(afterCancel.sessionId).toBe(held.session.id)
  expect((await sessionFor(held.session.id)).providerSession?.id).toBe(held.threadId)
  expect((await sessionFor(held.session.id)).status).toBe('working')
  expect(requestsFor('turn/start', held.threadId)).toHaveLength(1)
  expect(requestsFor('turn/interrupt', held.threadId)).toHaveLength(0)

  await openStopDialog()
  await clickRenderedButton('After this iteration')
  await waitForDialogClosed('Stop the loop')
  const deferred = await rig!.snapshot(loop.id)
  expect(deferred.state).toBe('running')
  expect(deferred.sessionId).toBe(held.session.id)
  expect(deferred.iterationsCompleted).toBe(0)
  expect((await sessionFor(held.session.id)).status).toBe('working')
  expect(requestsFor('turn/interrupt', held.threadId)).toHaveLength(0)
  expect(await rig!.call<IterationDetail[]>('quirky.loops/iterations', { loopId: loop.id })).toHaveLength(0)

  await rig!.call('quirky.structured/send', {
    session: held.session.id,
    text: 'Public structured steering releases the held native iteration.'
  })
  // Public steering is human input; preserve the loop's 20-second quiet gate.
  const stopped = await rig!.waitForLoop(loop.id, (snapshot) => snapshot.state === 'stopped', 30_000)
  const history = await rig!.call<IterationDetail[]>('quirky.loops/iterations', { loopId: loop.id })
  const native = requestsFor('turn/start', held.threadId)
  const steering = requestsFor('turn/steer', held.threadId)
  expect(stopped.iterationsCompleted).toBe(1)
  expect(history.map(({ n, attempt, endReason }) => ({ n, attempt, endReason }))).toEqual([
    { n: 1, attempt: 1, endReason: 'settled' }
  ])
  expect(native).toHaveLength(1)
  expect(steering).toHaveLength(1)
  expect(steering[0]?.params?.expectedTurnId).toBe('turn-1')
  expect(inputText(steering[0]!)).toContain('Public structured steering releases the held native iteration.')
  expect(requestsFor('turn/interrupt', held.threadId)).toHaveLength(0)
}, 60_000)

test('rendered Stop Now interrupts a held native turn and retains stopped history without lifecycle controls', async () => {
  await startNativeRig()
  const loop = await createRepeatLoop('Immediate native stop', 'Hold this native iteration [hold]')
  const held = await waitForNativeTurn(loop.id, 'Hold this native iteration [hold]')
  await openRail(loop.id)

  await openStopDialog()
  await clickRenderedButton('Now')
  await waitForDialogClosed('Stop the loop')
  const stopped = await rig!.waitForLoop(loop.id, (snapshot) => snapshot.state === 'stopped')
  const history = await rig!.call<IterationDetail[]>('quirky.loops/iterations', { loopId: loop.id })
  await headless!.waitFor(() => headless!.document.querySelector('[aria-label="Iteration history"] button[aria-label="Iteration 1"]'))

  expect(stopped.iterationsCompleted).toBe(0)
  expect(history.map(({ n, attempt, endReason }) => ({ n, attempt, endReason }))).toEqual([
    { n: 1, attempt: 1, endReason: 'stopped' }
  ])
  expect(requestsFor('turn/start', held.threadId)).toHaveLength(1)
  expect(requestsFor('turn/interrupt', held.threadId)).toMatchObject([
    { params: { threadId: held.threadId, turnId: 'turn-1' } }
  ])
  expect(headless!.document.querySelector('[aria-label="Loop lifecycle controls"]')).toBeNull()
}, 30_000)

test('rendered Close Cancel preserves the tab, Keep running detaches the same held queue turn, and Stop loop leaves its native sentinel live', async () => {
  await startNativeRig()
  const primary = await createQueueLoop()
  const sentinel = await createRepeatLoop('Native sentinel', 'Keep the sentinel turn held [hold]')
  const firstTurn = await waitForNativeTurn(primary.id, 'First queue work [hold]')
  const sentinelTurn = await waitForNativeTurn(sentinel.id, 'Keep the sentinel turn held [hold]')
  expect(firstTurn.threadId).not.toBe(sentinelTurn.threadId)

  await uiCommand('open', { loopId: sentinel.id })
  const sentinelTab = viewForLoop(await workspace(), sentinel.id)
  if (!sentinelTab) throw new Error('native sentinel loop did not acquire its hosted tab')
  await openRail(primary.id)
  const originalTab = viewForLoop(await workspace(), primary.id)
  if (!originalTab) throw new Error('native queue loop did not acquire its hosted tab')
  const originalSessionId = firstTurn.session.id
  const originalProviderId = firstTurn.threadId

  await requestTabClose(primary.id)
  await clickRenderedButton('Cancel')
  await waitForDialogClosed('Close a running loop?')
  expect(viewForLoop(await workspace(), primary.id)).toEqual(originalTab)
  expect(viewForLoop(await workspace(), sentinel.id)).toEqual(sentinelTab)
  expect((await rig!.snapshot(primary.id)).sessionId).toBe(originalSessionId)
  expect((await sessionFor(originalSessionId)).providerSession?.id).toBe(originalProviderId)
  expect((await sessionFor(originalSessionId)).status).toBe('working')
  expect(requestsFor('turn/start', originalProviderId)).toHaveLength(1)
  expect(requestsFor('turn/interrupt', originalProviderId)).toHaveLength(0)
  expect(requestsFor('turn/steer', originalProviderId)).toHaveLength(0)
  expect((await sessionFor(sentinelTurn.session.id)).status).toBe('working')

  await openRail(primary.id)
  await requestTabClose(primary.id)
  await clickRenderedButton('Keep running')
  await waitForDialogClosed('Close a running loop?')
  expect(viewForLoop(await workspace(), primary.id)).toBeUndefined()
  expect(viewForLoop(await workspace(), sentinel.id)).toEqual(sentinelTab)
  expect((await rig!.snapshot(primary.id)).sessionId).toBe(originalSessionId)
  expect((await sessionFor(originalSessionId)).providerSession?.id).toBe(originalProviderId)
  expect((await sessionFor(originalSessionId)).status).toBe('working')
  expect(requestsFor('turn/start', originalProviderId)).toHaveLength(1)
  expect(requestsFor('turn/interrupt', originalProviderId)).toHaveLength(0)
  expect(requestsFor('turn/steer', originalProviderId)).toHaveLength(0)

  await rig!.call('quirky.structured/send', {
    session: originalSessionId,
    text: 'Release the first queue item while its view is detached.'
  })
  // The detached loop must honor the same human-input quiet gate before its next turn.
  const secondTurn = await waitForNativeTurn(primary.id, 'Second queue work [hold]', 30_000)
  const detachedQueue = await rig!.waitForLoop(primary.id, (snapshot) => snapshot.state === 'running' && snapshot.iterationsCompleted === 1)
  expect(viewForLoop(await workspace(), primary.id)).toBeUndefined()
  expect(secondTurn.threadId).toBe(originalProviderId)
  expect(detachedQueue.queueItems.map(({ body, state }) => ({ body, state }))).toEqual([
    { body: 'First queue work [hold]', state: 'done' },
    { body: 'Second queue work [hold]', state: 'in-flight' }
  ])
  expect(requestsFor('turn/steer', originalProviderId)).toMatchObject([
    { params: { threadId: originalProviderId, expectedTurnId: 'turn-1' } }
  ])
  expect((await sessionFor(sentinelTurn.session.id)).status).toBe('working')

  await cliUiCommand('ui-open', { positionals: [primary.id], flags: {} })
  await headless!.waitFor(async () => viewForLoop(await workspace(), primary.id))
  await showWorktreeView()
  await waitForRail(primary.id)
  await requestTabClose(primary.id)
  await clickRenderedButton('Stop loop')
  await waitForDialogClosed('Close a running loop?')
  const stopped = await rig!.waitForLoop(primary.id, (snapshot) => snapshot.state === 'stopped')
  expect(stopped.state).toBe('stopped')
  expect(viewForLoop(await workspace(), primary.id)).toBeUndefined()
  expect(requestsFor('turn/interrupt', originalProviderId)).toMatchObject([
    { params: { threadId: originalProviderId, turnId: 'turn-2' } }
  ])
  expect((await rig!.snapshot(sentinel.id)).state).toBe('running')
  expect((await sessionFor(sentinelTurn.session.id)).status).toBe('working')
  expect(requestsFor('turn/interrupt', sentinelTurn.threadId)).toHaveLength(0)
}, 60_000)
