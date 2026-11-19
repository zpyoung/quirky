import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcErrorCode, type Session, type UiPluginContext } from '@quirky/protocol'
import { controllerFor as findController } from '../../src/window/workspace/registry'
import { requestWindowCommand } from '../../src/window/window-command'
import {
  click,
  conceptualWorkspace,
  fakeContext,
  fakeDaemon,
  fire,
  group,
  key,
  loadWorkspace,
  makeWorkspace,
  mouse,
  mountFixture,
  pane,
  session,
  simpleWorkspace,
  settle,
  startRecording,
  stopRecording,
  tab,
  type as typeText,
  unloadWorkspace,
  type DaemonOptions,
  type MountedWorkspace
} from './workspace-support'

const VIEW_ACTION = 'command:quirky.terminal/workspace-view-action'
const ACTION_NAME = 'workspace-view-action'
const ACTIONS = 'open-pane-menu, close-menu, cancel-dialog, confirm-close, submit-session, activate-switcher'
const KINDS = ['close-running', 'close-pinned', 'new-session', 'switch-tabs']
const AGENTS = {
  defaultAgent: 'claude',
  agents: [
    { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: false },
    { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } }
  ]
}

const mounted: MountedWorkspace[] = []

type MountOptions = {
  daemon?: DaemonOptions
  extra?: Record<string, (params: Record<string, unknown>) => unknown>
  input?: unknown
}

type ActionHandler = (args?: unknown) => unknown

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  for (const view of mounted.splice(0).reverse()) await view.unmount()
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(workspace = conceptualWorkspace(), options: MountOptions = {}) {
  const view = await mountFixture(fakeDaemon(workspace, { agents: AGENTS, ...options.daemon }), {
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.extra === undefined ? {} : { extra: options.extra })
  })
  mounted.push(view)
  return view
}

function controllerFor(view: MountedWorkspace, id?: string) {
  const report = view.last() as { worktree?: string | null }
  return findController(id ?? report.worktree ?? 'wt-main')!
}

/** Commands load after loadWorkspace because their module imports browser-bound workspace code. */
async function actionHandler(context: UiPluginContext): Promise<ActionHandler | undefined> {
  const { terminalCommands } = await import('../../src/window/commands')
  return terminalCommands(context)[ACTION_NAME]
}

async function invokeAction(context: UiPluginContext, args: unknown): Promise<unknown> {
  const handler = await actionHandler(context)
  if (!handler) return undefined
  let result: unknown
  await act(async () => {
    result = await handler(args)
  })
  return result
}

/** Exercise the same-window RPC installer, which invokes the actual registered command handler. */
async function runAction(view: MountedWorkspace, args: unknown): Promise<unknown> {
  if (!await actionHandler(view.fake.context)) return undefined
  let result: unknown
  await act(async () => {
    result = await requestWindowCommand(view.fake.context, { command: VIEW_ACTION, args })
  })
  return result
}

type DialogReport = { kind: string; title: string; generation: string }

function reportedDialog(view: MountedWorkspace): DialogReport | null {
  const report: unknown = view.last()
  if (typeof report !== 'object' || report === null || !('dialog' in report)) return null
  const dialog = report.dialog
  if (dialog === null || typeof dialog !== 'object' || !('kind' in dialog) || !('title' in dialog) || !('generation' in dialog)) return null
  const { kind, title, generation } = dialog
  if (typeof kind !== 'string' || typeof title !== 'string' || typeof generation !== 'string') return null
  return { kind, title, generation }
}

function expectDialog(view: MountedWorkspace, kind: string, title: string): string {
  const dialog = reportedDialog(view)
  expect(dialog).toEqual({ kind, title, generation: expect.any(String) })
  const generation = dialog?.generation
  if (typeof generation !== 'string') return 'missing-generation'
  expect(generation).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
  return generation
}

async function chooseAgent(view: MountedWorkspace, groupId = 'grp-1', agent = 'codex', background = false) {
  let result: unknown
  await act(async () => {
    result = await controllerFor(view).chooseAgent(groupId, agent, background)
  })
  return result
}

describe('workspace view action manifest and validation', () => {
  test('declares one hidden strict command with the exact public argument types', async () => {
    const manifest = JSON.parse(await Bun.file(new URL('../../quirky-plugin.json', import.meta.url)).text()) as {
      contributes: { command: { id: string; title: string; palette?: boolean; args?: unknown }[] }
    }
    const entry = manifest.contributes.command.find((command) => command.id === ACTION_NAME)
    expect(entry).toEqual({
      id: ACTION_NAME,
      title: 'Terminal Workspace View Action',
      palette: false,
      args: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          action: { type: 'string', enum: ['open-pane-menu', 'close-menu', 'cancel-dialog', 'confirm-close', 'submit-session', 'activate-switcher'] },
          pane: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          kind: { type: 'string', enum: KINDS },
          generation: { type: 'string' },
          dontAskAgain: { type: 'boolean' },
          prompt: { type: 'string' },
          tab: { type: 'string' }
        },
        required: ['workspace', 'action'],
        additionalProperties: false
      }
    })
  })

  test('validates malformed direct requests with the exact action-specific refusal', async () => {
    const fake = fakeContext()
    const malformed: [unknown, string][] = [
      [null, 'invalid workspace view arguments'],
      [[], 'invalid workspace view arguments'],
      ['workspace', 'invalid workspace view arguments'],
      [{ action: 'unknown' }, 'workspace is required'],
      [{ workspace: '', action: 'close-menu' }, 'workspace is required'],
      [{ workspace: 7, action: 'close-menu' }, 'workspace is required'],
      [{ workspace: 'wt-main' }, `action must be one of ${ACTIONS}`],
      [{ workspace: 'wt-main', action: 'not-an-action' }, `action must be one of ${ACTIONS}`],
      [{ workspace: 'wt-main', action: 'open-pane-menu' }, 'pane is required'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: '', x: 1, y: 2 }, 'pane is required'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 2, x: 1, y: 2 }, 'pane is required'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', y: 2 }, 'x and y must be finite numbers'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: '1', y: 2 }, 'x and y must be finite numbers'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: Infinity, y: 2 }, 'x and y must be finite numbers'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: 1, y: NaN }, 'x and y must be finite numbers'],
      [{ workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: 1, y: 2, kind: 'close-running' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'close-menu', generation: 'g-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'close-menu', pane: 'pane-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running' }, 'generation is required'],
      [{ workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: '' }, 'generation is required'],
      [{ workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: 7 }, 'generation is required'],
      [{ workspace: 'wt-main', action: 'cancel-dialog', kind: 'other', generation: 'g-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: 'g-1', tab: 'tab-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'confirm-close', kind: 'switch-tabs', generation: 'g-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'confirm-close', kind: 'close-running', generation: 'g-1', dontAskAgain: 'yes' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'confirm-close', kind: 'close-running', generation: 'g-1', prompt: 'wrong action' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'submit-session', kind: 'new-session', generation: 'g-1' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'submit-session', kind: 'new-session', generation: 'g-1', prompt: 9 }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'submit-session', kind: 'close-running', generation: 'g-1', prompt: 'text' }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'activate-switcher', kind: 'switch-tabs', generation: 'g-1', tab: 7 }, 'invalid workspace view arguments'],
      [{ workspace: 'wt-main', action: 'activate-switcher', kind: 'switch-tabs', generation: 'g-1', prompt: 'wrong action' }, 'invalid workspace view arguments']
    ]
    for (const [args, reason] of malformed) {
      expect(await invokeAction(fake.context, args)).toEqual({ ok: false, reason })
    }
  })

  test('checks required generation before resolving an exact mounted controller', async () => {
    const fake = fakeContext()
    expect(await invokeAction(fake.context, { workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running' })).toEqual({
      ok: false,
      reason: 'generation is required'
    })
    expect(await invokeAction(fake.context, { workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: 'g-old' })).toEqual({
      ok: false,
      reason: 'no mounted terminal workspace wt-main'
    })
    expect(await invokeAction(fake.context, { workspace: 'wt-main', action: 'close-menu' })).toEqual({
      ok: false,
      reason: 'no mounted terminal workspace wt-main'
    })
  })

  test('rejects a selector alias when the controller reports a different workspace ID', async () => {
    const view = await mount(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]), { id: 'wt-actual' }), {
      input: { worktree: 'wt-selector' }
    })
    expect(controllerFor(view, 'wt-selector')).toBeDefined()
    expect(await invokeAction(view.fake.context, { workspace: 'wt-selector', action: 'close-menu' })).toEqual({
      ok: false,
      reason: 'no mounted terminal workspace wt-selector'
    })
  })
})

describe('workspace view action UI adapter', () => {
  async function loadAdapter() {
    try {
      return await import('../../src/window/workspace/view-actions')
    } catch {
      return null
    }
  }

  test('runs exactly once in the clicking window and does not toast success or call the owner command', async () => {
    const adapter = await loadAdapter()
    expect(adapter).not.toBeNull()
    if (!adapter?.runWorkspaceViewAction) return
    expect(adapter.WORKSPACE_VIEW_ACTION_COMMAND).toBe(VIEW_ACTION)
    const fake = fakeContext({
      'ui.window.self': () => ({ connId: 41 }),
      'ui.window.command.run': () => ({ result: { ok: true } })
    })
    const ownerCalls: unknown[] = []
    fake.context.executeCommand = async (id, args) => { ownerCalls.push({ id, args }) }

    await adapter.runWorkspaceViewAction(fake.context, { workspace: 'wt-main', action: 'close-menu' })

    expect(fake.callsTo('ui.window.self').map((call) => call.params)).toEqual([{}])
    expect(fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([{
      connId: 41,
      id: VIEW_ACTION,
      args: { workspace: 'wt-main', action: 'close-menu' }
    }])
    expect(fake.toasts).toEqual([])
    expect(ownerCalls).toEqual([])
  })

  test('reports a returned refusal once with the shared action title', async () => {
    const adapter = await loadAdapter()
    expect(adapter).not.toBeNull()
    if (!adapter?.runWorkspaceViewAction) return
    const fake = fakeContext({
      'ui.window.self': () => ({ connId: 41 }),
      'ui.window.command.run': () => ({ result: { ok: false, reason: 'dialog g-1 is no longer open in wt-main' } })
    })

    await adapter.runWorkspaceViewAction(fake.context, { workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: 'g-1' })

    expect(fake.toasts).toEqual([{ title: 'Could not run workspace action', body: 'dialog g-1 is no longer open in wt-main' }])
    expect(fake.callsTo('ui.window.command.run')).toHaveLength(1)
  })

  for (const method of ['ui.window.self', 'ui.window.command.run']) {
    test(`reports a ${method} transport failure once without retry or owner fallback`, async () => {
      const adapter = await loadAdapter()
      expect(adapter).not.toBeNull()
      if (!adapter?.runWorkspaceViewAction) return
      const fake = fakeContext({
        'ui.window.self': () => ({ connId: 41 }),
        'ui.window.command.run': () => ({ result: { ok: true } }),
        [method]: () => { throw new Error(`${method} offline`) }
      })
      const ownerCalls: unknown[] = []
      fake.context.executeCommand = async (id, args) => { ownerCalls.push({ id, args }) }

      await adapter.runWorkspaceViewAction(fake.context, { workspace: 'wt-main', action: 'close-menu' })

      expect(fake.toasts).toEqual([{ title: 'Could not run workspace action', body: `${method} offline` }])
      expect(fake.callsTo('ui.window.self')).toHaveLength(1)
      expect(fake.callsTo('ui.window.command.run')).toHaveLength(method === 'ui.window.self' ? 0 : 1)
      expect(ownerCalls).toEqual([])
    })
  }
})

describe('workspace view action refusals and delegation', () => {
  test('opens the exact pane menu position and closes it without requiring a live target', async () => {
    const view = await mount()
    const controller = controllerFor(view)
    const ownerCalls: unknown[] = []
    view.fake.context.executeCommand = async (id, args) => { ownerCalls.push({ id, args }) }

    expect(await runAction(view, { workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: 17, y: 29 })).toEqual({ ok: true })
    expect(controller.getSnapshot().menu).toMatchObject({ kind: 'pane', target: 'pane-1', x: 17, y: 29 })
    expect(await runAction(view, { workspace: 'wt-main', action: 'close-menu' })).toEqual({ ok: true })
    expect(controller.getSnapshot().menu).toBeNull()
    expect(view.fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      { connId: 41, id: VIEW_ACTION, args: { workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: 17, y: 29 } },
      { connId: 41, id: VIEW_ACTION, args: { workspace: 'wt-main', action: 'close-menu' } }
    ])
    expect(ownerCalls).toEqual([])

    await act(() => { controller.openMenu('pane', 'already-gone', { x: 1, y: 2 }) })
    expect(await invokeAction(view.fake.context, { workspace: 'wt-main', action: 'close-menu' })).toEqual({ ok: true })
    expect(controller.getSnapshot().menu).toBeNull()
  })

  test('refuses a pane that is absent from the addressed workspace', async () => {
    const view = await mount()
    expect(await invokeAction(view.fake.context, { workspace: 'wt-main', action: 'open-pane-menu', pane: 'missing-pane', x: 17, y: 29 })).toEqual({
      ok: false,
      reason: 'pane missing-pane is not in workspace wt-main'
    })
  })

  test('addresses the named controller instead of whichever workspace is focused', async () => {
    const first = await mount(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]), { id: 'wt-one' }))
    const second = await mount(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]), { id: 'wt-two' }))
    const firstController = controllerFor(first, 'wt-one')
    const secondController = controllerFor(second, 'wt-two')

    expect(await runAction(first, { workspace: 'wt-two', action: 'open-pane-menu', pane: 'pane-1', x: 23, y: 31 })).toEqual({ ok: true })

    expect(firstController.getSnapshot().menu).toBeNull()
    expect(secondController.getSnapshot().menu).toMatchObject({ kind: 'pane', target: 'pane-1', x: 23, y: 31 })
  })

  test('returns stale generation before kind or pending checks and refuses a matching wrong kind', async () => {
    const view = await mount(simpleWorkspace(), { daemon: { describe: 'Stop command?' } })
    const controller = controllerFor(view)
    await act(async () => { await controller.closeTab('tab-1') })
    const generation = expectDialog(view, 'close-running', 'Stop running command?')

    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-pinned', generation: 'stale-generation'
    })).toEqual({ ok: false, reason: 'dialog stale-generation is no longer open in wt-main' })
    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-pinned', generation
    })).toEqual({ ok: false, reason: 'no close-pinned dialog is open in wt-main' })

    await act(async () => { await controller.answerCloseDialog(false) })
    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation
    })).toEqual({ ok: false, reason: `dialog ${generation} is no longer open in wt-main` })
  })

  test('confirms a running close through the reported generation', async () => {
    const view = await mount(simpleWorkspace(), { daemon: { describe: 'Stop command?' } })
    const controller = controllerFor(view)
    await act(async () => { await controller.closeTab('tab-1') })
    const generation = expectDialog(view, 'close-running', 'Stop running command?')

    expect(await runAction(view, {
      workspace: 'wt-main', action: 'confirm-close', kind: 'close-running', generation, dontAskAgain: false
    })).toEqual({ ok: true })
    expect(view.fake.callsTo('quirky.terminal/closeTab').map((call) => call.params)).toEqual([{ tab: 'tab-1', yes: true }])
    expect(reportedDialog(view)).toBeNull()
  })

  test('confirms pinned close with the existing setting and close effects', async () => {
    const workspace = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { pinned: true })]))
    const view = await mount(workspace)
    const controller = controllerFor(view)
    await act(async () => { await controller.closeTab('tab-1') })
    const generation = expectDialog(view, 'close-pinned', 'Close pinned tab?')

    expect(await runAction(view, {
      workspace: 'wt-main', action: 'confirm-close', kind: 'close-pinned', generation, dontAskAgain: true
    })).toEqual({ ok: true })
    expect(view.fake.callsTo('setting.set').map((call) => call.params)).toEqual([{
      id: 'setting:quirky.terminal/confirm-close-pinned', value: false
    }])
    expect(view.fake.callsTo('quirky.terminal/closeTab').map((call) => call.params)).toEqual([{ tab: 'tab-1', yes: true }])
  })

  test('cancels each dialog kind through its existing controller method', async () => {
    const closeView = await mount(simpleWorkspace(), { daemon: { describe: 'Stop command?' } })
    const closeController = controllerFor(closeView)
    await act(async () => { await closeController.closeTab('tab-1') })
    const closeGeneration = expectDialog(closeView, 'close-running', 'Stop running command?')
    expect(await invokeAction(closeView.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'close-running', generation: closeGeneration
    })).toEqual({ ok: true })
    expect(closeView.fake.callsTo('quirky.terminal/closeTab')).toEqual([])

    const promptView = await mount(simpleWorkspace())
    expect(await chooseAgent(promptView)).toEqual({ ok: true })
    const promptGeneration = expectDialog(promptView, 'new-session', 'New Codex session')
    expect(await invokeAction(promptView.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'new-session', generation: promptGeneration
    })).toEqual({ ok: true })
    expect(promptView.fake.callsTo('quirky.terminal/newTab')).toEqual([])
    expect(promptView.fake.callsTo('quirky.structured/create')).toEqual([])

    const switchView = await mount(conceptualWorkspace())
    const switchController = controllerFor(switchView)
    await act(async () => { switchController.recentTab() })
    const switchGeneration = expectDialog(switchView, 'switch-tabs', 'Switch tabs')
    expect(await invokeAction(switchView.fake.context, {
      workspace: 'wt-main', action: 'cancel-dialog', kind: 'switch-tabs', generation: switchGeneration
    })).toEqual({ ok: true })
    expect(switchView.fake.callsTo('quirky.terminal/activateTab')).toEqual([])
  })

  test('submits a foreground prompt exactly once through the action command', async () => {
    const view = await mount(simpleWorkspace())
    expect(await chooseAgent(view)).toEqual({ ok: true })
    const generation = expectDialog(view, 'new-session', 'New Codex session')

    expect(await runAction(view, {
      workspace: 'wt-main', action: 'submit-session', kind: 'new-session', generation, prompt: ' review the diff '
    })).toEqual({ ok: true })
    expect(view.fake.callsTo('quirky.terminal/newTab').map((call) => call.params)).toEqual([{
      workspace: 'wt-main', group: 'grp-1', agent: 'codex', prompt: 'review the diff'
    }])
    expect(view.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('refuses an empty unstarted background prompt but permits an already-started retry', async () => {
    const daemon = fakeDaemon(simpleWorkspace(), { agents: AGENTS })
    const creation = Promise.withResolvers<Session>()
    let createCalls = 0
    let adoptCalls = 0
    const view = await mountFixture(daemon, {
      extra: {
        'quirky.structured/create': () => { createCalls += 1; return creation.promise },
        'quirky.terminal/adoptSession': () => {
          adoptCalls += 1
          if (adoptCalls === 1) throw new Error('adopt refused')
          return { workspace: daemon.workspace }
        }
      }
    })
    mounted.push(view)
    expect(await chooseAgent(view, 'grp-1', 'claude', true)).toEqual({ ok: true })
    const generation = expectDialog(view, 'new-session', 'New Claude (background) session')
    const args = { workspace: 'wt-main', action: 'submit-session', kind: 'new-session', generation }

    expect(await invokeAction(view.fake.context, { ...args, prompt: ' \t ' })).toEqual({
      ok: false,
      reason: 'a background session requires a prompt'
    })
    expect(createCalls).toBe(0)

    let pendingRequest: unknown
    try {
      const submitHandler = await actionHandler(view.fake.context)
      if (!submitHandler) throw new Error('workspace view action handler is missing')
      await act(() => {
        pendingRequest = submitHandler({ ...args, prompt: 'start this' })
      })
      await settle()
      expect(controllerFor(view).getSnapshot().dialog).toMatchObject({ pending: true, generation })
      expect(reportedDialog(view)?.generation).toBe(generation)
      expect(await invokeAction(view.fake.context, { ...args, prompt: 'another' })).toEqual({
        ok: false,
        reason: 'session request is pending'
      })
      expect(await invokeAction(view.fake.context, { ...args, action: 'cancel-dialog' })).toEqual({
        ok: false,
        reason: 'session request is pending'
      })

      creation.resolve(session('s-started', { kind: 'structured', agent: 'claude' }))
      let pendingResult: unknown
      await act(async () => {
        pendingResult = await Promise.resolve(pendingRequest)
      })
      expect(pendingResult).toEqual({ ok: true })
    } finally {
      creation.resolve(session('s-started', { kind: 'structured', agent: 'claude' }))
      if (pendingRequest !== undefined) {
        await act(async () => {
          await Promise.resolve(pendingRequest)
        })
      }
    }
    expect(controllerFor(view).getSnapshot().dialog).toMatchObject({
      pending: false,
      generation,
      error: 'Session already started; could not open it: adopt refused',
      startedSession: { id: 's-started' }
    })
    expect(reportedDialog(view)?.generation).toBe(generation)

    expect(await invokeAction(view.fake.context, { ...args, prompt: '' })).toEqual({ ok: true })
    expect(createCalls).toBe(1)
    expect(adoptCalls).toBe(2)
    expect(reportedDialog(view)).toBeNull()
  })

  test('activates only an open switcher tab and defaults to the highlighted entry when omitted', async () => {
    const view = await mount(conceptualWorkspace())
    const controller = controllerFor(view)
    await act(async () => { controller.recentTab() })
    const generation = expectDialog(view, 'switch-tabs', 'Switch tabs')

    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'activate-switcher', kind: 'switch-tabs', generation, tab: 'missing-tab'
    })).toEqual({ ok: false, reason: 'tab missing-tab is not in the open switcher' })
    expect(await runAction(view, {
      workspace: 'wt-main', action: 'activate-switcher', kind: 'switch-tabs', generation, tab: 'tab-1'
    })).toEqual({ ok: true })
    expect(view.fake.callsTo('quirky.terminal/activateTab').map((call) => call.params)).toEqual([{ tab: 'tab-1' }])
    expect(reportedDialog(view)).toBeNull()

    await act(async () => { controller.recentTab() })
    const nextGeneration = expectDialog(view, 'switch-tabs', 'Switch tabs')
    const activeDialog = controller.getSnapshot().dialog
    if (activeDialog?.kind !== 'switch-tabs') throw new Error('the switcher dialog is not open')
    const selected = activeDialog.order[activeDialog.index]
    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'activate-switcher', kind: 'switch-tabs', generation: nextGeneration
    })).toEqual({ ok: true })
    expect(view.fake.callsTo('quirky.terminal/activateTab').map((call) => call.params).at(-1)).toEqual({ tab: selected })
  })

  test('returns an unexpected execution error as its exact reason', async () => {
    const view = await mount(simpleWorkspace())
    const controller = controllerFor(view)
    const original = controller.openMenu
    controller.openMenu = (() => { throw new Error('menu execution failed') }) as typeof controller.openMenu

    expect(await invokeAction(view.fake.context, {
      workspace: 'wt-main', action: 'open-pane-menu', pane: 'pane-1', x: 17, y: 29
    })).toEqual({ ok: false, reason: 'menu execution failed' })

    controller.openMenu = original
  })
})

describe('public dialog generation lifetime', () => {
  test('reports fresh close generations, keeps a report stable, and refreshes pinned-to-running questions', async () => {
    const originalNow = Date.now
    let now = 10000
    Date.now = () => now
    try {
      const pinned = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { pinned: true })]))
      const view = await mount(pinned, { daemon: { describe: 'Stop command?' } })
      const controller = controllerFor(view)

      await act(async () => { await controller.closeTab('tab-1') })
      const pinnedGeneration = expectDialog(view, 'close-pinned', 'Close pinned tab?')
      expect(controller.report().dialog).toEqual(reportedDialog(view))
      expect(controller.report().dialog).toEqual(controller.report().dialog)

      await act(async () => { await controller.answerCloseDialog(true) })
      const runningGeneration = expectDialog(view, 'close-running', 'Stop running command?')
      expect(runningGeneration).not.toBe(pinnedGeneration)

      await act(async () => { await controller.answerCloseDialog(false) })
      now += 1000
      await act(async () => { await controller.closeTab('tab-1') })
      const reopenedGeneration = expectDialog(view, 'close-pinned', 'Close pinned tab?')
      expect(reopenedGeneration).not.toBe(pinnedGeneration)
    } finally {
      Date.now = originalNow
    }
  })

  test('preserves switcher generation through highlight updates and allocates a new one after reopening', async () => {
    const view = await mount(conceptualWorkspace())
    const controller = controllerFor(view)

    await act(async () => { controller.recentTab() })
    const firstGeneration = expectDialog(view, 'switch-tabs', 'Switch tabs')
    await act(async () => {
      controller.stepSwitcher(1)
      controller.setSwitcherIndex(0)
    })
    expect(reportedDialog(view)?.generation).toBe(firstGeneration)
    expect(controller.report().dialog?.generation).toBe(firstGeneration)

    await act(async () => { await controller.endSwitcher(false) })
    await act(async () => { controller.recentTab() })
    const reopenedGeneration = expectDialog(view, 'switch-tabs', 'Switch tabs')
    expect(reopenedGeneration).not.toBe(firstGeneration)
  })

  test('preserves prompt generation through error and issues a new one for another request and controller remount', async () => {
    const view = await mount(conceptualWorkspace())
    const controller = controllerFor(view)
    const daemon = view.daemon
    daemon.fail('newTab', RpcErrorCode.Internal, 'start refused')
    expect(await chooseAgent(view, 'grp-1', 'codex')).toEqual({ ok: true })
    const firstGeneration = expectDialog(view, 'new-session', 'New Codex session')

    await act(async () => { await controller.submitNewSession('build') })
    expect(controller.getSnapshot().dialog).toMatchObject({ error: 'start refused', generation: firstGeneration })
    expect(reportedDialog(view)?.generation).toBe(firstGeneration)
    await act(async () => { await controller.submitNewSession(null) })

    expect(await chooseAgent(view, 'grp-2', 'claude')).toEqual({ ok: true })
    const changedGeneration = expectDialog(view, 'new-session', 'New Claude session')
    expect(changedGeneration).not.toBe(firstGeneration)
    await view.unmount()
    mounted.splice(mounted.indexOf(view), 1)

    const remounted = await mount(conceptualWorkspace())
    expect(await chooseAgent(remounted, 'grp-1', 'codex')).toEqual({ ok: true })
    const remountedGeneration = expectDialog(remounted, 'new-session', 'New Codex session')
    expect(remountedGeneration).not.toBe(firstGeneration)
    expect(remountedGeneration).not.toBe(changedGeneration)
  })
})

describe('workspace view action UI controls', () => {
  test('pane contextmenu and dismissal stay with the addressed workspace', async () => {
    const first = await mount(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]), { id: 'wt-one' }))
    const second = await mount(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]), { id: 'wt-two' }))
    const firstController = controllerFor(first, 'wt-one')
    const secondController = controllerFor(second, 'wt-two')

    await fire(first.q('[data-pane="pane-1"]'), mouse('contextmenu', { clientX: 17, clientY: 29 }))

    expect(firstController.getSnapshot().menu).toMatchObject({ kind: 'pane', target: 'pane-1', x: 17, y: 29 })
    expect(secondController.getSnapshot().menu).toBeNull()
    expect(first.fake.callsTo('ui.window.command.run').map((call) => call.params.args)).toEqual([
      { workspace: 'wt-one', action: 'open-pane-menu', pane: 'pane-1', x: 17, y: 29 }
    ])
    expect(second.fake.callsTo('ui.window.command.run')).toEqual([])

    await key(document.querySelector('[role="menu"]')!, 'Escape')

    expect(firstController.getSnapshot().menu).toBeNull()
    expect(secondController.getSnapshot().menu).toBeNull()
    expect(first.fake.callsTo('ui.window.command.run').map((call) => call.params.args)).toEqual([
      { workspace: 'wt-one', action: 'open-pane-menu', pane: 'pane-1', x: 17, y: 29 },
      { workspace: 'wt-one', action: 'close-menu' }
    ])
    expect(second.fake.callsTo('ui.window.command.run')).toEqual([])
  })

  const switcherEvents: {
    label: string
    event: () => Event
    action: 'activate-switcher' | 'cancel-dialog'
  }[] = [
    {
      label: 'Enter',
      event: () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      action: 'activate-switcher'
    },
    {
      label: 'Control release',
      event: () => new KeyboardEvent('keyup', { key: 'Control', bubbles: true, cancelable: true }),
      action: 'activate-switcher'
    },
    {
      label: 'Escape',
      event: () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      action: 'cancel-dialog'
    },
    {
      label: 'window blur',
      event: () => new FocusEvent('blur'),
      action: 'cancel-dialog'
    }
  ]

  test.each(switcherEvents)('$label routes through the captured switcher generation', async ({ event, action }) => {
    const view = await mount(conceptualWorkspace())
    const controller = controllerFor(view)
    await act(() => { controller.recentTab() })
    const generation = expectDialog(view, 'switch-tabs', 'Switch tabs')

    await fire(window, event())

    expect(view.fake.callsTo('ui.window.command.run').map((call) => call.params.args)).toEqual([{
      workspace: 'wt-main',
      action,
      kind: 'switch-tabs',
      generation
    }])
    expect(reportedDialog(view)).toBeNull()
  })
})

type RaceKind = 'close-running' | 'close-pinned' | 'new-session' | 'switch-tabs'
type RaceOperation = 'confirm' | 'submit' | 'activate' | 'cancel'

const intentRaces: { kind: RaceKind; operation: RaceOperation }[] = [
  { kind: 'close-running', operation: 'confirm' },
  { kind: 'new-session', operation: 'submit' },
  { kind: 'switch-tabs', operation: 'activate' },
  { kind: 'close-running', operation: 'cancel' },
  { kind: 'close-pinned', operation: 'cancel' },
  { kind: 'new-session', operation: 'cancel' },
  { kind: 'switch-tabs', operation: 'cancel' }
]

for (const pauseAt of ['ui.window.self', 'ui.window.command.run'] as const) {
  test.each(intentRaces)(`delayed ${pauseAt} cannot carry $operation across a replaced $kind generation`, async ({ kind, operation }) => {
    const originalNow = Date.now
    let now = 10000
    Date.now = () => now
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<unknown>()
    let interactionStarted = false
    let view: MountedWorkspace | undefined
    try {
      const workspace = conceptualWorkspace()
      if (kind === 'close-pinned') {
        if (workspace.root.kind !== 'split' || workspace.root.first.kind !== 'group') throw new Error('expected fixture group')
        for (const tab of workspace.root.first.tabs) tab.pinned = true
      }
      view = await mountFixture(fakeDaemon(workspace, { agents: AGENTS, describe: 'Stop sleep?' }), {
        provider: true,
        extra: {
          'ui.contributions': () => ({ menuItems: [] }),
          'quirky.terminal/quickCommands': () => ({ commands: [] }),
          'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
          'quirky.worktree/wake': () => ({})
        }
      })
      mounted.push(view)
      const controller = controllerFor(view)
      const handler = view.fake.provided.get(VIEW_ACTION) as ActionHandler | undefined
      if (!handler) throw new Error('workspace action was not provided')
      const ownerCalls: unknown[] = []
      view.fake.context.executeCommand = async (command, args) => { ownerCalls.push([command, args]) }
      const open = async (replacement: boolean) => {
        await act(async () => {
          if (kind === 'new-session') {
            await controller.chooseAgent(replacement ? 'grp-2' : 'grp-1', replacement ? 'claude' : 'codex', false)
          } else if (kind === 'switch-tabs') {
            controller.recentTab()
          } else {
            await controller.requestClose({ kind: 'tab', tab: replacement ? 'tab-2' : 'tab-1' })
          }
        })
        await settle()
      }

      await open(false)
      const generationA = reportedDialog(view)?.generation
      if (!generationA) throw new Error('dialog A did not publish its generation')
      if (kind === 'new-session') await typeText(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, ' old prompt ')
      if (kind.startsWith('close-')) await click(view.q('[role="dialog"] input[type="checkbox"]'))

      const originalCall = view.fake.context.call.bind(view.fake.context)
      let armed = true
      view.fake.context.call = async (method, params = {}) => {
        if (armed && method === pauseAt) {
          armed = false
          interactionStarted = true
          entered.resolve()
          await gate.promise
        }
        const result = await originalCall(method, params)
        if (method === 'ui.window.command.run' && params.id === VIEW_ACTION) completed.resolve(result)
        return result
      }
      const dialogButton = (label: string) =>
        [...view!.element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === label) ?? null

      if (operation === 'confirm') await click(dialogButton('Stop and Close'))
      else if (operation === 'submit') await click(view.q('[role="dialog"] button[type="submit"]'))
      else if (operation === 'activate') await click(view.q('[data-tab-option="tab-1"]'))
      else if (kind === 'switch-tabs') await fire(view.q('.qt-overlay'), new MouseEvent('mousedown', { bubbles: true }))
      else await click(dialogButton('Cancel'))
      await entered.promise

      await act(async () => {
        expect(await handler({ workspace: 'wt-main', action: 'cancel-dialog', kind, generation: generationA })).toEqual({ ok: true })
      })
      await open(true)
      const generationB = reportedDialog(view)?.generation
      if (!generationB) throw new Error('dialog B did not publish its generation')
      expect(generationB).not.toBe(generationA)
      const dialogB = controller.getSnapshot().dialog
      expect(dialogB).toMatchObject({ kind, generation: generationB })
      if (kind.startsWith('close-')) expect(dialogB).toMatchObject({ target: { kind: 'tab', tab: 'tab-2' } })
      if (kind === 'new-session') expect(dialogB).toMatchObject({ group: 'grp-2', request: { agent: 'claude' } })
      if (kind === 'switch-tabs') expect(dialogB).toMatchObject({ group: 'grp-1' })
      if (kind === 'new-session') {
        expect(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('')
        expect(view.q('[role="dialog"]')!.textContent).toContain('New Claude session')
      }
      if (kind.startsWith('close-')) expect(view.q<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.checked).toBe(false)

      now += 1000
      gate.resolve()
      const reason = `dialog ${generationA} is no longer open in wt-main`
      expect(await completed.promise).toEqual({ result: { ok: false, reason } })
      await settle()
      expect(reportedDialog(view)?.generation).toBe(generationB)
      expect(controller.getSnapshot().dialog).toEqual(dialogB)
      expect(view.fake.toasts).toEqual([{ title: 'Could not run workspace action', body: reason }])
      for (const method of [
        'quirky.terminal/closeTab',
        'quirky.terminal/closePane',
        'setting.set',
        'quirky.terminal/newTab',
        'quirky.structured/create',
        'quirky.terminal/adoptSession',
        'quirky.terminal/activateTab'
      ]) expect(view.fake.callsTo(method)).toEqual([])
      expect(ownerCalls).toEqual([])
      const actionCalls = view.fake.callsTo('ui.window.command.run').filter((call) => call.params.id === VIEW_ACTION)
      expect(actionCalls).toHaveLength(1)
      expect(actionCalls[0]!.params.args).toMatchObject({ workspace: 'wt-main', kind, generation: generationA })

      const current = { workspace: 'wt-main', kind, generation: generationB }
      await act(async () => {
        const result = operation === 'confirm'
          ? await handler({ ...current, action: 'confirm-close', dontAskAgain: false })
          : operation === 'submit'
            ? await handler({ ...current, action: 'submit-session', prompt: 'current prompt' })
            : operation === 'activate'
              ? await handler({ ...current, action: 'activate-switcher', tab: 'tab-1' })
              : await handler({ ...current, action: 'cancel-dialog' })
        expect(result).toEqual({ ok: true })
      })
      expect(reportedDialog(view)).toBeNull()
      if (operation === 'confirm') {
        expect(view.fake.callsTo('quirky.terminal/closeTab').map((call) => call.params)).toEqual([{ tab: 'tab-2', yes: true }])
      }
      if (operation === 'submit') {
        expect(view.fake.callsTo('quirky.terminal/newTab').map((call) => call.params)).toEqual([{
          workspace: 'wt-main', group: 'grp-2', agent: 'claude', prompt: 'current prompt'
        }])
      }
      if (operation === 'activate') {
        expect(view.fake.callsTo('quirky.terminal/activateTab').map((call) => call.params)).toEqual([{ tab: 'tab-1' }])
      }
    } finally {
      gate.resolve()
      entered.resolve()
      if (interactionStarted) await act(async () => { await completed.promise })
      else completed.resolve(undefined)
      Date.now = originalNow
    }
  })
}
