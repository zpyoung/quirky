import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, UiState, Worktree } from '@quirky/protocol'
import type { Group, GroupNode, Tab, ViewTab, Workspace } from '../../quirky.terminal/src/layout/types'
import { isViewTab } from '../../quirky.terminal/src/layout/types'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import type { LoopSnapshot } from '../src/types'
import { startLoopRig, loopConfig, type LoopRig, type ScriptedTurn } from './rig'

const OVERLAY_ID = 'overlay:quirky.loops/dialogs'
const WORKSPACE_VIEW_ID = 'view:quirky.session/worktree'
const SETTINGS_VIEW_ID = 'view:quirky.git/ai-settings'
const LOOP_VIEW_ID = 'view:quirky.loops/loop'
const SETTINGS_KEY = 'loops-ui-form-settings-sentinel'
const SECOND_LOOP_WARNING = 'This workspace already has a running loop. A second loop edits the same files at the same time.'
const WHOLE_NUMBER_ERROR = 'Enter a whole number of at least 1.'
const TIMEOUT_ERROR = 'Enter 1 to 600 seconds.'
const COST_ERROR = 'Enter an amount above 0.'
const QUEUE_ERROR = 'Queue prompts cannot be blank.'

let rig: LoopRig | null = null
let headless: HeadlessWindow | null = null
let restoreGeometry: (() => void) | null = null
let settingsTabId: string | null = null
let activeGroupId: string | null = null
let fixtureQueue = Promise.resolve()
let releaseFixture: (() => void) | null = null
const loopIds: string[] = []
const heldTurns: (() => void)[] = []
const turns: { sessionId: string; text: string }[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopAgent(value: unknown): value is LoopSnapshot['agent'] {
  return value === 'claude' || value === 'codex'
}

function currentRig(): LoopRig {
  if (!rig) throw new Error('loop rig is not running')
  return rig
}

function currentWindow(): HeadlessWindow {
  if (!headless) throw new Error('headless window is not running')
  return headless
}

function fixtureActiveGroupId(): string {
  if (activeGroupId === null) throw new Error('terminal fixture did not capture its active group')
  return activeGroupId
}

function releaseHeldTurns(): void {
  for (const release of heldTurns.splice(0)) release()
}

async function acquireFixture(): Promise<void> {
  const previous = fixtureQueue
  const turn = Promise.withResolvers<void>()
  fixtureQueue = turn.promise
  await previous
  releaseFixture = turn.resolve
}

function patchWorkspaceGeometry(): void {
  const prototype = Element.prototype
  const original = prototype.getBoundingClientRect
  prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (!this.classList.contains('qt-groups') && !this.classList.contains('qt-body') && !this.classList.contains('qt-panes')) {
      return original.call(this)
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({})
    } as DOMRect
  }
  restoreGeometry = () => {
    prototype.getBoundingClientRect = original
  }
}

function groupById(node: GroupNode, groupId: string): Group | null {
  if (node.kind === 'group') return node.id === groupId ? node : null
  return groupById(node.first, groupId) ?? groupById(node.second, groupId)
}

function tabsIn(node: GroupNode): Tab[] {
  if (node.kind === 'split') return [...tabsIn(node.first), ...tabsIn(node.second)]
  return node.tabs
}

function activeTab(workspace: Workspace): string | null {
  return groupById(workspace.root, workspace.activeGroup)?.activeTab ?? null
}

function viewForLoop(workspace: Workspace, loopId: string): ViewTab | undefined {
  return tabsIn(workspace.root).find((tab): tab is ViewTab =>
    isViewTab(tab) && tab.viewId === LOOP_VIEW_ID && tab.key === loopId
  )
}

function overlayReport(state: UiState): Record<string, unknown> | null {
  const report = state.slots.find((slot) => slot.id === OVERLAY_ID)?.report
  return isRecord(report) ? report : null
}

function draftOf(setup: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(setup.draft)) throw new Error('setup report omitted its draft')
  return setup.draft
}

function errorsOf(setup: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(setup.errors)) throw new Error('setup report omitted validation errors')
  return setup.errors
}

async function readOverlay(): Promise<Record<string, unknown> | null> {
  return overlayReport(await currentRig().call<UiState>('ui.state', {}))
}

async function waitForSetup(check: (setup: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  return currentWindow().waitFor(async () => {
    const report = await readOverlay()
    if (!report || !isRecord(report.setup) || report.setup.loading !== false) return undefined
    return check(report.setup) ? report.setup : undefined
  })
}

async function waitForSetupClosed(): Promise<void> {
  await currentWindow().waitFor(async () => {
    const report = await readOverlay()
    return report && report.setup === null ? true : undefined
  })
}

async function waitForSetupDraft(check: (draft: Record<string, unknown>, setup: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return waitForSetup((setup) => isRecord(setup.draft) && check(setup.draft, setup))
}

async function uiCommand(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await currentRig().call<{ result: unknown }>('ui.command.run', {
    id: `command:quirky.loops/${name}`,
    args
  })
  return response.result
}

async function updateSetup(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  await uiCommand('setup-action', { action: 'update', params: { patch } })
  return waitForSetupDraft((draft) => Object.entries(patch).every(([key, value]) => {
    const current = draft[key]
    return Array.isArray(value) ? Array.isArray(current) && JSON.stringify(current) === JSON.stringify(value) : current === value
  }))
}

async function queueAction(action: 'queue-add' | 'queue-edit' | 'queue-move' | 'queue-remove', params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await uiCommand('setup-action', { action, params })
  return waitForSetup()
}

async function workspace(workspaceId = currentRig().worktree.id): Promise<Workspace> {
  const result = await currentRig().call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: workspaceId })
  return result.workspace
}

async function loops(worktreeId = currentRig().worktree.id): Promise<LoopSnapshot[]> {
  return currentRig().call<LoopSnapshot[]>('quirky.loops/list', { worktreeId })
}

async function startFixture(): Promise<void> {
  await acquireFixture()
  const script: ScriptedTurn = async ({ session, text }) => {
    turns.push({ sessionId: session.id, text })
    const held = Promise.withResolvers<{ status: 'waiting' }>()
    heldTurns.push(() => held.resolve({ status: 'waiting' }))
    return held.promise
  }
  rig = await startLoopRig({
    extraPlugins: ['quirky.terminal', 'quirky.sidebar-extras', 'quirky.git'],
    script,
    onStop: () => releaseHeldTurns()
  })
  headless = await startHeadlessWindow({ home: rig.home, runtime: rig.harness.runtime })
  patchWorkspaceGeometry()

  const initial = await workspace()
  activeGroupId = initial.activeGroup
  await rig.call('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    group: initial.activeGroup,
    viewId: SETTINGS_VIEW_ID,
    key: SETTINGS_KEY,
    title: 'Source Control AI defaults',
    input: { worktree: rig.worktree.id },
    activate: true
  })
  const withSettings = await workspace()
  const settingsTab = tabsIn(withSettings.root).find((tab): tab is ViewTab =>
    isViewTab(tab) && tab.viewId === SETTINGS_VIEW_ID && tab.key === SETTINGS_KEY
  )
  if (!settingsTab) throw new Error('hosted settings sentinel was not added to the workspace')
  settingsTabId = settingsTab.id
  expect(activeTab(withSettings)).toBe(settingsTab.id)

  await rig.call('ui.view.open', { id: WORKSPACE_VIEW_ID, input: { worktree: rig.worktree.id } })
  await currentWindow().waitFor(() => currentWindow().document.querySelector(`[data-plus="${initial.activeGroup}"]`))
  const sessions = await rig.call<Session[]>('quirky.session/list', {})
  expect(sessions.some((session) => session.worktreeId === rig!.worktree.id && session.agent === 'shell')).toBe(false)
  const visibleWorkspace = await workspace()
  expect(activeTab(visibleWorkspace)).toBe(settingsTab.id)
}

async function openSetup(workspaceId = currentRig().worktree.id): Promise<Record<string, unknown>> {
  await uiCommand('new', {
    worktree: currentRig().worktree.id,
    workspace: workspaceId,
    ...(workspaceId === currentRig().worktree.id && activeGroupId ? { group: activeGroupId } : {})
  })
  return waitForSetup()
}

async function startFromSetup(worktreeId: string): Promise<LoopSnapshot> {
  const previous = new Set((await loops(worktreeId)).map((loop) => loop.id))
  await uiCommand('setup-action', { action: 'start' })
  const created = await currentWindow().waitFor(async () =>
    (await loops(worktreeId)).find((loop) => !previous.has(loop.id))
  )
  loopIds.push(created.id)
  await currentRig().waitForLoop(created.id, (loop) => loop.state === 'running')
  await waitForSetupClosed()
  return currentRig().snapshot(created.id)
}

async function waitForTurns(count: number): Promise<void> {
  await currentWindow().waitFor(() => turns.length >= count ? turns.length : undefined)
}

async function createFolderWorkspace(name: string): Promise<Worktree> {
  const path = join(currentRig().home, 'folder-project')
  mkdirSync(path, { recursive: true })
  const repo = await currentRig().call<{ id: string }>('quirky.repo/add', { path, folder: true })
  const created = await currentRig().call<{ worktree: Worktree }>('quirky.worktree/create', { repo: repo.id, name })
  return created.worktree
}

afterEach(async () => {
  if (rig) {
    for (const loopId of loopIds) {
      try {
        await rig.call('quirky.loops/stop', { loopId, mode: 'now' })
      } catch {
        // A create flow may already have ended the loop or disabled its API.
      }
    }
  }
  releaseHeldTurns()

  if (rig && headless) {
    try {
      const current = await readOverlay()
      if (current && current.setup !== null) {
        await uiCommand('setup-action', { action: 'cancel' })
        await waitForSetupClosed()
      }
    } catch {
      // The UI plugin can be unavailable after a public daemon capability change.
    }
    try {
      const state = await rig.call<UiState>('ui.state', {})
      if (state.layout.view !== null) await rig.call('ui.view.close', {})
      await headless.waitFor(async () => {
        const current = await rig!.call<UiState>('ui.state', {})
        const groupGone = activeGroupId === null || !headless!.document.querySelector(`[data-plus="${activeGroupId}"]`)
        return current.layout.view === null && groupGone ? true : undefined
      })
    } catch {
      // Continue teardown; the harness cleanup still stops all daemon processes.
    }
  }

  try {
    await headless?.stop()
  } finally {
    restoreGeometry?.()
    restoreGeometry = null
    headless = null
    await rig?.cleanup()
    rig = null
    settingsTabId = null
    activeGroupId = null
    loopIds.length = 0
    turns.length = 0
    heldTurns.length = 0
    releaseFixture?.()
    releaseFixture = null
  }
})

test('setup API reports defaults, preset resets, queue edits, and validation without creating a loop', async () => {
  await startFixture()
  let setup = await openSetup()
  let draft = draftOf(setup)
  expect(setup.loading).toBe(false)
  expect(draft).toMatchObject({
    name: '',
    preset: 'until-done',
    prompt: '',
    queueItems: [],
    sessionPolicy: 'fresh',
    maxIterations: '10',
    checkTimeout: '300',
    checkWhen: 'every-iteration',
    noProgress: true,
    advanced: false
  })
  const agentIds = Array.isArray(setup.agents)
    ? setup.agents.flatMap((agent) => isRecord(agent) && typeof agent.id === 'string' ? [agent.id] : [])
    : []
  expect([...agentIds].sort()).toEqual(['claude', 'codex'])
  const agent = draft.agent
  if (!isLoopAgent(agent)) throw new Error('setup draft omitted a supported loop agent')
  expect(['claude', 'codex']).toContain(agent)
  expect(errorsOf(setup).prompt).toBe('Enter a prompt to start the loop.')
  expect(setup.canStart).toBe(false)
  expect(currentWindow().document.body.textContent).toContain('Enter a prompt to start the loop.')

  await uiCommand('setup-action', { action: 'advanced', params: { open: true } })
  setup = await waitForSetupDraft((current) => current.advanced === true)
  expect(currentWindow().document.querySelector('[aria-label="Done check command"]')).not.toBeNull()
  expect(currentWindow().document.querySelector('[aria-label="Check timeout (seconds)"]')).toBeNull()
  expect(currentWindow().document.querySelector('[aria-label="Run the check"]')).toBeNull()

  await updateSetup({ maxIterations: '6', checkCommand: 'true', checkTimeout: '45' })
  await currentWindow().waitFor(() =>
    currentWindow().document.querySelector<HTMLInputElement>('[aria-label="Check timeout (seconds)"]')?.value === '45' &&
    currentWindow().document.querySelector<HTMLSelectElement>('[aria-label="Run the check"]')?.value === 'every-iteration'
  )
  setup = await updateSetup({ preset: 'interval' })
  draft = draftOf(setup)
  expect(draft).toMatchObject({ preset: 'interval', pacingKind: 'interval', intervalMinutes: '30', anchor: 'from-end', sessionPolicy: 'continue', maxIterations: '6', checkCommand: 'true', checkTimeout: '45' })
  setup = await updateSetup({ intervalMinutes: '0' })
  expect(draftOf(setup).intervalMinutes).toBe('0')
  expect(errorsOf(setup).intervalMinutes).toBe(WHOLE_NUMBER_ERROR)
  expect(setup.canStart).toBe(false)
  expect(currentWindow().document.body.textContent).toContain(WHOLE_NUMBER_ERROR)
  await uiCommand('setup-action', { action: 'start' })
  expect(await loops()).toHaveLength(0)

  setup = await updateSetup({ intervalMinutes: '30', preset: 'queue' })
  expect(draftOf(setup)).toMatchObject({ preset: 'queue', sessionPolicy: 'continue', maxIterations: '6', checkCommand: 'true' })
  expect(errorsOf(setup).queueItems).toBe('Add at least one prompt to the queue.')
  expect(currentWindow().document.body.textContent).toContain('Add at least one prompt to the queue.')
  setup = await queueAction('queue-add', { body: 'ONE' })
  await queueAction('queue-add', { body: 'TWO' })
  setup = await queueAction('queue-edit', { index: 1, body: 'TWO edited' })
  setup = await queueAction('queue-move', { index: 1, position: 'up' })
  expect(draftOf(setup).queueItems).toEqual(['TWO edited', 'ONE'])
  setup = await queueAction('queue-remove', { index: 1 })
  expect(draftOf(setup).queueItems).toEqual(['TWO edited'])
  setup = await queueAction('queue-edit', { index: 0, body: '   ' })
  expect(draftOf(setup).queueItems).toEqual(['   '])
  expect(errorsOf(setup)['queueItems.0']).toBe(QUEUE_ERROR)
  expect(setup.canStart).toBe(false)
  await uiCommand('setup-action', { action: 'start' })
  expect(await loops()).toHaveLength(0)
  await queueAction('queue-edit', { index: 0, body: 'TWO edited' })
  setup = await updateSetup({ repeatQueue: true, preset: 'until-done', prompt: 'Validation prompt' })
  draft = draftOf(setup)
  expect(draft).toMatchObject({ preset: 'until-done', sessionPolicy: 'fresh', maxIterations: '6', checkCommand: 'true', repeatQueue: true, prompt: 'Validation prompt' })

  setup = await updateSetup({ maxIterations: '1.5' })
  expect(draftOf(setup).maxIterations).toBe('1.5')
  expect(errorsOf(setup).maxIterations).toBe(WHOLE_NUMBER_ERROR)
  expect(setup.canStart).toBe(false)
  await uiCommand('setup-action', { action: 'start' })
  expect(await loops()).toHaveLength(0)

  setup = await updateSetup({ maxIterations: '', maxActiveMinutes: '2.5', maxCostUsd: '0' })
  draft = draftOf(setup)
  expect(draft).toMatchObject({ maxIterations: '', maxActiveMinutes: '2.5', maxCostUsd: '0' })
  expect(errorsOf(setup).maxActiveMinutes).toBe(WHOLE_NUMBER_ERROR)
  expect(errorsOf(setup).maxCostUsd).toBe(COST_ERROR)
  expect(setup.canStart).toBe(false)
  await uiCommand('setup-action', { action: 'start' })
  expect(await loops()).toHaveLength(0)

  setup = await updateSetup({ maxActiveMinutes: '', maxCostUsd: '', checkTimeout: '0' })
  expect(draftOf(setup).checkTimeout).toBe('0')
  expect(errorsOf(setup).checkTimeout).toBe(TIMEOUT_ERROR)
  expect(setup.canStart).toBe(false)
  await uiCommand('setup-action', { action: 'start' })
  expect(await loops()).toHaveLength(0)
  setup = await updateSetup({
    checkTimeout: '600',
    checkWhen: 'on-claim',
    evaluatorCondition: 'The requested changes are complete.',
    protectedPaths: 'secret/**\n build.log ',
    noProgress: false,
    checkpointCommits: true,
    askBeforeNext: true,
    resumeAtLimitReset: true
  })
  draft = draftOf(setup)
  expect(draft).toMatchObject({
    maxIterations: '',
    maxActiveMinutes: '',
    maxCostUsd: '',
    checkTimeout: '600',
    checkWhen: 'on-claim',
    protectedPaths: 'secret/**\n build.log ',
    noProgress: false,
    checkpointCommits: true,
    askBeforeNext: true,
    resumeAtLimitReset: true
  })
  expect(setup.canStart).toBe(true)
  expect(errorsOf(setup)).toEqual({})
  await uiCommand('setup-action', { action: 'cancel' })
  await waitForSetupClosed()
  expect(await loops()).toHaveLength(0)

  setup = await openSetup()
  expect(draftOf(setup)).toMatchObject({ advanced: false, preset: 'until-done', sessionPolicy: 'fresh', maxIterations: '10', noProgress: true })
  await uiCommand('setup-action', { action: 'cancel' })
  await waitForSetupClosed()
  expect(activeTab(await workspace())).toBe(settingsTabId)
}, 30_000)

test('valid Until-done setup creates a native loop with trimmed name and background focus', async () => {
  await startFixture()
  const setup = await openSetup()
  expect(draftOf(setup)).toMatchObject({ preset: 'until-done', sessionPolicy: 'fresh', maxIterations: '10', noProgress: true })
  const prompt = 'Finish the requested change.\nKeep the workspace clean.'
  await updateSetup({ name: '  Explicit until loop  ', prompt })
  const created = await startFromSetup(currentRig().worktree.id)
  await waitForTurns(1)
  expect(turns[0]?.text).toContain('Finish the requested change.')
  expect(created).toMatchObject({ name: 'Explicit until loop', preset: 'until-done', worktreeId: currentRig().worktree.id, state: 'running' })
  expect(created.config).toMatchObject({
    promptSource: { kind: 'repeat', body: prompt },
    pacing: { kind: 'on-idle' },
    sessionPolicy: 'fresh',
    caps: { maxIterations: 10 },
    noProgress: true,
    checkpointCommits: false
  })
  expect(created.config.done).toEqual({})
  expect(created.costUsd).toBeNull()
  const currentWorkspace = await workspace()
  expect(viewForLoop(currentWorkspace, created.id)).toBeDefined()
  expect(activeTab(currentWorkspace)).toBe(settingsTabId)
  expect(currentWorkspace.activeGroup).toBe(fixtureActiveGroupId())
  const sessions = await currentRig().call<Session[]>('quirky.session/list', {})
  expect(sessions.some((session) => session.agent === 'shell')).toBe(false)
}, 30_000)

test('a live loop warns on interval setup but the second loop still starts in the background', async () => {
  await startFixture()
  const existing = await currentRig().call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: currentRig().worktree.id,
    agent: 'claude',
    config: loopConfig('Existing live loop')
  })
  loopIds.push(existing.id)
  await currentRig().waitForLoop(existing.id, (loop) => loop.state === 'running')
  await waitForTurns(1)
  expect(turns[0]?.text).toContain('Existing live loop')

  const setup = await openSetup()
  expect(setup.warning).toBe(SECOND_LOOP_WARNING)
  const prompt = `${'Interval task '.repeat(5)}\nUse the same workspace.`
  await updateSetup({ preset: 'interval', name: ' ', prompt, maxIterations: '' })
  const ready = await waitForSetupDraft((draft, current) => draft.preset === 'interval' && current.warning === SECOND_LOOP_WARNING)
  expect(draftOf(ready)).toMatchObject({ sessionPolicy: 'continue', intervalMinutes: '30', anchor: 'from-end' })
  const interval = await startFromSetup(currentRig().worktree.id)
  await waitForTurns(2)
  expect(turns[1]?.text).toContain(prompt.split('\n')[0]!)
  expect(interval.name).toBe(prompt.split('\n')[0]!.slice(0, 48))
  expect(interval).toMatchObject({ preset: 'interval', worktreeId: currentRig().worktree.id, state: 'running' })
  expect(interval.config).toMatchObject({
    promptSource: { kind: 'repeat', body: prompt },
    pacing: { kind: 'interval', minutes: 30, anchor: 'from-end' },
    sessionPolicy: 'continue',
    noProgress: true
  })
  expect(interval.config.caps).toEqual({})
  expect(interval.warnings).toContain('worktree-has-running-loop')
  expect(interval.costUsd).toBeNull()
  expect(await loops()).toHaveLength(2)
  const currentWorkspace = await workspace()
  expect(viewForLoop(currentWorkspace, interval.id)).toBeDefined()
  expect(activeTab(currentWorkspace)).toBe(settingsTabId)
  expect(currentWorkspace.activeGroup).toBe(fixtureActiveGroupId())
}, 30_000)

test('valid queue setup starts with the edited queue order and preserves the active tab', async () => {
  await startFixture()
  const setup = await openSetup()
  expect(setup.warning).toBeNull()
  await updateSetup({ preset: 'queue', name: '' })
  await queueAction('queue-add', { body: 'Queue first task' })
  await queueAction('queue-add', { body: 'Queue second task' })
  const ready = await updateSetup({ repeatQueue: true })
  expect(draftOf(ready)).toMatchObject({ preset: 'queue', sessionPolicy: 'continue', repeatQueue: true, queueItems: ['Queue first task', 'Queue second task'] })
  const queued = await startFromSetup(currentRig().worktree.id)
  await waitForTurns(1)
  expect(turns[0]?.text).toContain('Queue first task')
  expect(queued.name).toBe('Queue first task')
  expect(queued).toMatchObject({ preset: 'queue', worktreeId: currentRig().worktree.id, state: 'running' })
  expect(queued.config).toMatchObject({
    promptSource: { kind: 'queue', repeatQueue: true },
    pacing: { kind: 'on-idle' },
    sessionPolicy: 'continue',
    caps: { maxIterations: 10 },
    noProgress: true
  })
  expect(queued.queueItems.map((item) => item.body)).toEqual(['Queue first task', 'Queue second task'])
  expect(queued.costUsd).toBeNull()
  const currentWorkspace = await workspace()
  expect(viewForLoop(currentWorkspace, queued.id)).toBeDefined()
  expect(activeTab(currentWorkspace)).toBe(settingsTabId)
  expect(currentWorkspace.activeGroup).toBe(fixtureActiveGroupId())
}, 30_000)

test('folder workspace setup hides checkpoints and never sends a checkpoint configuration', async () => {
  await startFixture()
  const folder = await createFolderWorkspace('folder-loop')
  expect(folder.kind).toBe('folder')
  const setup = await openSetup(folder.id)
  expect(setup.workspaceKind).toBe('folder')
  await uiCommand('setup-action', { action: 'advanced', params: { open: true } })
  let ready = await waitForSetupDraft((draft) => draft.advanced === true)
  expect(draftOf(ready).checkpointCommits).toBe(false)
  expect([...currentWindow().document.querySelectorAll('label')].some((label) => label.textContent?.includes('Commit a checkpoint after each iteration'))).toBe(false)

  ready = await updateSetup({ name: 'Folder loop', prompt: 'Check folder workspace support.', checkpointCommits: true })
  expect(draftOf(ready).checkpointCommits).toBe(true)
  expect([...currentWindow().document.querySelectorAll('label')].some((label) => label.textContent?.includes('Commit a checkpoint after each iteration'))).toBe(false)
  const created = await startFromSetup(folder.id)
  await waitForTurns(1)
  expect(created).toMatchObject({ workspaceKind: 'folder', worktreeId: folder.id, state: 'running' })
  expect(created.config.checkpointCommits).toBe(false)
  expect(created.costUsd).toBeNull()
  expect((await loops(folder.id)).map((loop) => loop.id)).toEqual([created.id])
}, 30_000)

test('a server-side loop-file refusal preserves the setup draft and creates no loop tab', async () => {
  await startFixture()
  const folder = await createFolderWorkspace('refused-loop')
  const setup = await openSetup(folder.id)
  expect(setup.workspaceKind).toBe('folder')
  const name = 'Draft survives refusal'
  const prompt = 'This valid request encounters a loop-notes path conflict.'
  await updateSetup({ name, prompt })
  writeFileSync(join(folder.path, '.quirky'), 'blocks loop-note directory creation')
  await uiCommand('setup-action', { action: 'start' })
  const failed = await waitForSetup((current) => typeof current.error === 'string' && current.error.trim() !== '')
  expect(failed.canStart).toBe(true)
  expect(draftOf(failed)).toMatchObject({ name, prompt })
  const error = failed.error
  if (typeof error !== 'string') throw new Error('setup report omitted the server refusal message')
  expect(error).toContain('could not prepare loop notes and private git exclusion')
  const uiState = await currentRig().call<UiState>('ui.state', {})
  expect(uiState.toasts.some((toast) => toast.title === 'Could not start the loop.')).toBe(true)
  expect(await loops(folder.id)).toHaveLength(0)
  const folderWorkspace = await workspace(folder.id)
  expect(tabsIn(folderWorkspace.root).some((tab) => isViewTab(tab) && tab.viewId === LOOP_VIEW_ID)).toBe(false)

  await uiCommand('setup-action', { action: 'cancel' })
  await waitForSetupClosed()
}, 30_000)
