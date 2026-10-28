import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import type { UiModel } from '@quirky/protocol'
import { Store } from '../../src/store'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'
import { startHarness, type Harness } from '../helpers'
import { checkUiKindEntry } from '../../src/plugins/ui-kinds'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

const WORKTREES = 'sidebar-section:quirky.worktree/worktrees'
const CHANGES = 'panel:quirky.git/source-control'
const FILES = 'panel:quirky.editor/explorer'
const EDITOR_SIDEBAR = 'sidebar-section:quirky.editor/explorer'
const SIDEBAR_ACTIVITY = 'activity-item:quirky.sidebar-extras/source-control'
const TASKS = 'sidebar-section:quirky.tasks/tasks'
const TASKS_VIEW = 'view:quirky.tasks/tasks'
const LEDGER = 'panel:quirky.ledger/ledger'
const LEDGER_SIDEBAR = 'sidebar-section:quirky.ledger/ledger'
const OUTLINE = 'panel:acme.tools/outline'
const CUSTOM = 'panel:acme.tools/custom'
const PLUGIN_UI = { 'ui.js': 'export function activate() {}\n' }

const builtinFixtures: { id: string; contributes: Record<string, unknown> }[] = [
  { id: 'quirky.worktree', contributes: { 'sidebar-section': [{ id: 'worktrees', title: 'Worktrees' }] } },
  { id: 'quirky.git', contributes: { panel: [{ id: 'source-control', title: 'Source Control' }] } },
  {
    id: 'quirky.editor',
    contributes: {
      panel: [{ id: 'explorer', title: 'Explorer' }],
      'sidebar-section': [{ id: 'explorer', title: 'Explorer' }]
    }
  },
  { id: 'quirky.sidebar-extras', contributes: { 'activity-item': [{ id: 'source-control', title: 'Source Control' }] } },
  { id: 'quirky.tasks', contributes: { 'sidebar-section': [{ id: 'tasks', title: 'Tasks' }], view: [{ id: 'tasks', title: 'Tasks' }] } },
  { id: 'quirky.automations', contributes: { 'sidebar-section': [{ id: 'automations', title: 'Automations' }], view: [{ id: 'automations', title: 'Automations' }] } },
  { id: 'quirky.mobile', contributes: { 'sidebar-section': [{ id: 'mobile', title: 'Mobile' }], view: [{ id: 'page', title: 'Mobile' }] } },
  { id: 'quirky.heimdall', contributes: { 'sidebar-section': [{ id: 'navigation', title: 'Heimdall' }], view: [{ id: 'fleet', title: 'Heimdall Fleet' }] } },
  { id: 'quirky.reviews', contributes: { panel: [{ id: 'checks', title: 'Checks' }], view: [{ id: 'review', title: 'Pull request' }] } },
  { id: 'quirky.ask', contributes: { panel: [{ id: 'questions', title: 'Questions' }] } },
  { id: 'quirky.session-info', contributes: { panel: [{ id: 'info', title: 'Session Info' }] } },
  { id: 'quirky.vault', contributes: { panel: [{ id: 'history', title: 'Agent Session History' }] } },
  { id: 'quirky.ledger', contributes: { panel: [{ id: 'ledger', title: 'Ledger' }], 'sidebar-section': [{ id: 'ledger', title: 'Ledger' }] } },
  { id: 'quirky.terminal', contributes: { panel: [{ id: 'sessions', title: 'Terminal Sessions' }, { id: 'quick-commands', title: 'Quick Commands' }] } },
  {
    id: 'acme.tools',
    contributes: {
      panel: [
        { id: 'outline', title: 'Outline' },
        { id: 'custom', title: 'Custom', defaultSlot: 'bottom-right', icon: 'sparkles' }
      ],
      'sidebar-section': [{ id: 'launcher', title: 'Launcher', defaultSlot: 'bottom-right', icon: 'rocket' }],
      'activity-item': [{ id: 'shortcuts', title: 'Shortcuts', defaultSlot: 'bottom-left', icon: 'zap' }],
    }
  }
]

function makeEnv(seed?: unknown) {
  const home = makeTempDir('qd-tool-slots-home-')
  const builtin = makeTempDir('qd-tool-slots-builtins-')
  const settings = new Store(join(home, 'quirky.db'))
  try {
    settings.setSettingValue('setting:quirky.agent-status/hooks', false)
    if (seed !== undefined) settings.setUiState('layout', seed)
  } finally {
    settings.close()
  }
  for (const { id, contributes } of builtinFixtures) {
    const root = id === 'acme.tools' ? join(home, 'plugins') : builtin
    writePlugin(root, { id, name: id, version: '1.0.0', ui: 'ui.js', contributes }, PLUGIN_UI)
  }
  const env = {
    harness: null as Harness | null,
    async start(): Promise<Harness> {
      const harness = await startHarness({ home, builtinPluginsDir: builtin })
      harnesses.push(harness)
      env.harness = harness
      return harness
    },
    async restart(): Promise<Harness> {
      const old = env.harness!
      harnesses.splice(harnesses.indexOf(old), 1)
      for (const client of old.clients) client.close()
      await old.daemon.stop()
      old.pty.stop()
      return env.start()
    }
  }
  return env
}

async function start(seed?: unknown) {
  const env = makeEnv(seed)
  const harness = await env.start()
  const caller = await harness.connect('cli')
  return { env, harness, caller }
}

async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

function tool(model: UiModel, id: string) {
  return model.tools?.find((entry) => entry.id === id)
}


describe('effective tool projection', () => {
  test('projects actual built-in bodies once, including view-backed launchers and explicit aliases', async () => {
    const { caller } = await start()
    const model = await caller.call('ui.contributions', {})
    const entries = model.tools!
    const ids = entries.map(({ id }) => id)

    expect(ids).toContain('host:inbox')
    expect(ids).toContain(WORKTREES)
    expect(ids).toContain(CHANGES)
    expect(ids).toContain(FILES)
    expect(ids).toContain('panel:quirky.reviews/checks')
    expect(ids).toContain('panel:quirky.ask/questions')
    expect(ids).toContain('view:quirky.reviews/review')
    expect(ids).toContain('panel:quirky.session-info/info')
    expect(ids).toContain('panel:quirky.vault/history')
    expect(ids).toContain(LEDGER)
    expect(ids).toContain('panel:quirky.terminal/sessions')
    expect(ids).toContain('panel:quirky.terminal/quick-commands')
    expect(ids).not.toContain(EDITOR_SIDEBAR)
    expect(ids).not.toContain(LEDGER_SIDEBAR)
    expect(ids).not.toContain(SIDEBAR_ACTIVITY)
    expect(ids.some((id) => /problems|checks-output/i.test(id))).toBe(false)

    expect(tool(model, FILES)).toMatchObject({ contributionId: FILES, defaultSlot: 'right-top', aliases: expect.arrayContaining([EDITOR_SIDEBAR]) })
    expect(tool(model, CHANGES)).toMatchObject({ contributionId: CHANGES, defaultSlot: 'right-top', aliases: expect.arrayContaining([SIDEBAR_ACTIVITY]) })
    expect(tool(model, LEDGER)).toMatchObject({ aliases: expect.arrayContaining([LEDGER_SIDEBAR]), defaultSlot: 'bottom-left' })
    expect(tool(model, TASKS)).toMatchObject({ contributionId: TASKS_VIEW, aliases: expect.arrayContaining([TASKS_VIEW]), defaultSlot: 'left-bottom' })
    expect(tool(model, 'sidebar-section:quirky.heimdall/navigation')).toMatchObject({
      contributionId: 'view:quirky.heimdall/fleet',
      defaultSlot: 'left-bottom'
    })
    expect(tool(model, 'sidebar-section:quirky.automations/automations')).toMatchObject({
      contributionId: 'view:quirky.automations/automations',
      defaultSlot: 'left-bottom'
    })
    expect(tool(model, 'sidebar-section:quirky.mobile/mobile')).toMatchObject({
      contributionId: 'view:quirky.mobile/page',
      defaultSlot: 'left-bottom'
    })
    expect(tool(model, 'panel:quirky.vault/history')).toMatchObject({ title: 'Vault', defaultSlot: 'right-bottom' })
    expect(tool(model, 'view:quirky.reviews/review')).toMatchObject({ title: 'Reviews', contributionId: 'view:quirky.reviews/review' })
    expect(model.panels.some(({ id }) => id === FILES)).toBe(true)
    expect(model.sidebarSections.some(({ id }) => id === EDITOR_SIDEBAR)).toBe(true)

    const layout = (await caller.call('ui.state', {})).layout.tools!
    expect(layout.placements).toEqual(Object.fromEntries(entries.map(({ id, defaultSlot }) => [id, defaultSlot])))
    expect(layout.open).toMatchObject({
      'left-top': WORKTREES,
      'left-bottom': null,
      'right-top': CHANGES,
      'right-bottom': null,
      'bottom-left': null,
      'bottom-right': null
    })
    expect(layout.sizes).toEqual({ left: 280, right: 320, bottom: 240, leftSplit: 0.5, rightSplit: 0.5, bottomSplit: 0.5 })
  })

  test('keeps third-party contributions reachable and carries validated placement and icon metadata', async () => {
    const { caller } = await start()
    const model = await caller.call('ui.contributions', {})
    expect(tool(model, CUSTOM)).toMatchObject({ title: 'Custom', icon: 'sparkles', defaultSlot: 'bottom-right', contributionId: CUSTOM })
    expect(tool(model, 'sidebar-section:acme.tools/launcher')).toMatchObject({ defaultSlot: 'bottom-right', icon: 'rocket' })
    expect(tool(model, 'activity-item:acme.tools/shortcuts')).toMatchObject({ defaultSlot: 'bottom-left', icon: 'zap' })
    expect(tool(model, OUTLINE)).toMatchObject({ defaultSlot: 'right-bottom' })
  })
  test('validates optional tool slot and icon metadata on registration kinds', () => {
    for (const kind of ['panel', 'sidebar-section', 'activity-item']) {
      const valid: string[] = []
      checkUiKindEntry(kind, `${kind} valid`, { id: 'valid', title: 'Valid', defaultSlot: 'bottom-right', icon: 'files' }, valid)
      expect(valid).toEqual([])
    }
    const errors: string[] = []
    checkUiKindEntry('panel', 'panel invalid', { id: 'invalid', title: 'Invalid', defaultSlot: 'middle', icon: 42 }, errors)
    expect(errors).toEqual([
      'panel invalid: defaultSlot must be one of left-top, left-bottom, right-top, right-bottom, bottom-left, bottom-right',
      'panel invalid: icon must be a non-empty string'
    ])
  })

})

describe('tool layout mutations', () => {
  test('repeated open requests do not close an already visible tool', async () => {
    const harness = await makeEnv().start()
    const caller = await harness.connect('cli')
    await caller.call('ui.tool.open', { id: TASKS })
    const repeated = await caller.call('ui.tool.open', { id: TASKS })
    expect(repeated.tools?.open['left-bottom']).toBe(TASKS)
    const closed = await caller.call('ui.tool.close', { slot: 'left-bottom' })
    expect(closed.tools?.open['left-bottom']).toBeNull()
    expect(closed.tools?.open['left-top']).toBe(WORKTREES)
  })

  test('opens, moves and resizes tools through RPC, then restores the same profile state after restart', async () => {
    const env = makeEnv()
    const first = await env.start()
    const caller = await first.connect('cli')

    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.tools?.open['left-bottom']).toBe(TASKS)
    expect(opened.tools?.open['left-top']).toBe(WORKTREES)

    const moved = await caller.call('ui.tool.move', { id: LEDGER, slot: 'right-bottom' })
    expect(moved.tools?.placements[LEDGER]).toBe('right-bottom')
    expect(moved.tools?.open['bottom-left']).toBeNull()
    expect(moved.tools?.open['right-bottom']).toBeNull()
    const shown = await caller.call('ui.tool.open', { id: LEDGER })
    expect(shown.tools?.open['right-bottom']).toBe(LEDGER)

    const resized = await caller.call('ui.tool.resize', { left: 360, rightSplit: 0.65 })
    expect(resized.tools?.sizes).toMatchObject({ left: 360, rightSplit: 0.65 })
    const restarted = await env.restart()
    const afterRestart = await restarted.connect('cli')
    expect((await afterRestart.call('ui.state', {})).layout.tools).toMatchObject({
      placements: { [LEDGER]: 'right-bottom' },
      open: { 'right-bottom': LEDGER },
      sizes: { left: 360, rightSplit: 0.65 }
    })
  })

  test('rejects unknown tools, invalid slots, empty resize, unexpected fields and non-finite geometry', async () => {
    const { caller } = await start()
    const before = (await caller.call('ui.state', {})).layout.tools
    expect((await failure(caller.call('ui.tool.open', { id: 'panel:acme.missing/tool' }))).code).toBe(RpcErrorCode.NotFound)
    expect((await failure(caller.callAny('ui.tool.close', { slot: 'middle' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.callAny('ui.tool.move', { id: LEDGER, slot: 'middle' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.call('ui.tool.resize', {}))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.callAny('ui.tool.resize', { left: 320, surprise: 1 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.call('ui.tool.resize', { left: Number.NaN }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.call('ui.tool.resize', { left: 159 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(caller.call('ui.tool.resize', { bottomSplit: 0.86 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await caller.call('ui.state', {})).layout.tools).toEqual(before)
  })

  test('drops corrupt and disabled IDs without reopening explicit closures or losing valid dimensions', async () => {
    const seed = {
      view: null,
      panel: null,
      sidebar: true,
      focus: null,
      tools: {
        placements: { [WORKTREES]: 'left-top', [CHANGES]: 'right-top', [CUSTOM]: 'middle', stale: 'left-bottom' },
        order: [WORKTREES, CHANGES, CUSTOM, 'stale'],
        open: {
          'left-top': null,
          'left-bottom': 'stale',
          'right-top': null,
          'right-bottom': CHANGES,
          'bottom-left': null,
          'bottom-right': null
        },
        sizes: { left: 9000, right: 450, bottom: 240, leftSplit: 0.99, rightSplit: 0.4, bottomSplit: 0.5 }
      }
    }
    const { caller } = await start(seed)
    let layout = (await caller.call('ui.state', {})).layout.tools!
    expect(layout.open).toMatchObject({ 'left-top': null, 'left-bottom': null, 'right-top': null })
    expect(layout.sizes).toMatchObject({ left: 280, right: 450, bottom: 240, leftSplit: 0.5, rightSplit: 0.4 })
    expect(layout.placements).not.toHaveProperty('stale')
    expect(layout.placements[CUSTOM]).toBe('bottom-right')

    await caller.call('ui.tool.open', { id: OUTLINE })
    expect((await caller.call('ui.state', {})).layout.tools?.open['right-bottom']).toBe(OUTLINE)
    await caller.call('ui.tool.close', { slot: 'right-bottom' })
    await caller.call('plugin.disable', { id: 'acme.tools' })
    layout = (await caller.call('ui.state', {})).layout.tools!
    expect(layout.placements).not.toHaveProperty(OUTLINE)
    expect(layout.placements).not.toHaveProperty(CUSTOM)
    await caller.call('plugin.enable', { id: 'acme.tools' })
    layout = (await caller.call('ui.state', {})).layout.tools!
    expect(layout.placements[OUTLINE]).toBe('right-bottom')
    expect(layout.placements[CUSTOM]).toBe('bottom-right')
    expect(layout.open['right-bottom']).toBeNull()
    expect(layout.open['right-top']).toBeNull()
    expect(layout.open['left-top']).toBeNull()
  })

  test('migrates legacy panel and sidebar state into tool slots and routes legacy methods to the same state', async () => {
    const { caller } = await start({ view: null, panel: OUTLINE, sidebar: false, focus: null })
    let layout = (await caller.call('ui.state', {})).layout
    expect(layout.tools?.open['left-top']).toBeNull()
    expect(layout.tools?.open['right-bottom']).toBe(OUTLINE)
    expect(layout.panel).toBe(OUTLINE)

    await caller.call('ui.panel.close', {})
    await caller.call('ui.sidebar.set', { visible: true })
    layout = (await caller.call('ui.state', {})).layout
    expect(layout.tools?.open['right-bottom']).toBeNull()
    expect(layout.tools?.open['left-top']).toBe(WORKTREES)
    expect(layout.sidebar).toBe(true)

    await caller.call('ui.panel.open', { id: OUTLINE })
    layout = (await caller.call('ui.state', {})).layout
    expect(layout.tools?.open['right-bottom']).toBe(OUTLINE)
    expect(layout.panel).toBe(OUTLINE)
  })

  test('state reports the active view-backed tool body and its window report', async () => {
    const { harness, caller } = await start()
    expect((await caller.call('ui.state', {})).slots.find(({ id }) => id === TASKS_VIEW)?.shown).toBe(false)
    const window = await harness.connectWithEvents('ui')
    await caller.call('ui.tool.open', { id: TASKS })
    await window.client.call('ui.report', { slot: TASKS_VIEW, state: { mounted: true } })

    const state = await caller.call('ui.state', {})
    expect(state.slots.find(({ id }) => id === TASKS_VIEW)).toMatchObject({
      kind: 'view',
      shown: true,
      report: { mounted: true }
    })
    expect(state.slots.find(({ id }) => id === TASKS)).toMatchObject({ kind: 'sidebar-section', shown: false })
  })
  test('legacy panel width configuration remains a profile layout preference', async () => {
    const { caller } = await start()
    const configured = await caller.call('ui.panel.configure', { id: OUTLINE, width: 420 })
    expect(configured.panelWidths?.[OUTLINE]).toBe(420)
  })
})

