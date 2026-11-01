import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, UI_TOOL_SLOTS } from '@quirky/protocol'
import type { UiModel, UiSlotEntry } from '@quirky/protocol'
import { Store } from '../../src/store'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'
import { startHarness, type Harness } from '../helpers'
import { checkUiKindEntry } from '../../src/plugins/ui-kinds'
import { projectTools } from '../../src/plugins/tool-layout'

const harnesses: Harness[] = []
const UI_TOOL_PLACEMENTS: readonly string[] = [...UI_TOOL_SLOTS, 'overflow']

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
const HEIMDALL = 'sidebar-section:quirky.heimdall/navigation'
const HEIMDALL_VIEW = 'view:quirky.heimdall/fleet'
const AUTOMATIONS = 'sidebar-section:quirky.automations/automations'
const MOBILE = 'sidebar-section:quirky.mobile/mobile'
const REVIEW_VIEW = 'view:quirky.reviews/review'
const LEDGER = 'panel:quirky.ledger/ledger'
const LEDGER_SIDEBAR = 'sidebar-section:quirky.ledger/ledger'
const OUTLINE = 'panel:acme.tools/outline'
const CUSTOM = 'panel:acme.tools/custom'
const PLUGIN_UI = { 'ui.js': 'export function activate() {}\n' }

const builtinFixtures: { id: string; contributes: Record<string, unknown> }[] = [
  { id: 'quirky.worktree', contributes: { 'sidebar-section': [{ id: 'worktrees', title: 'Worktrees' }, { id: 'remote-workspaces', title: 'Remote workspaces' }] } },
  { id: 'quirky.agent-status', contributes: { 'sidebar-section': [{ id: 'activity', title: 'Activity' }, { id: 'dashboard', title: 'Agent Dashboard' }] } },
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
  { id: 'quirky.vault', contributes: { panel: [{ id: 'history', title: 'Agent Session History', hue: 'rose' }] } },
  { id: 'quirky.ledger', contributes: { panel: [{ id: 'ledger', title: 'Ledger' }], 'sidebar-section': [{ id: 'ledger', title: 'Ledger' }] } },
  { id: 'quirky.terminal', contributes: { panel: [{ id: 'sessions', title: 'Terminal Sessions' }, { id: 'quick-commands', title: 'Quick Commands' }] } },
  {
    id: 'acme.tools',
    contributes: {
      panel: [
        { id: 'outline', title: 'Outline' },
        { id: 'custom', title: 'Custom', defaultSlot: 'bottom-right', icon: 'sparkles', hue: 'plum' }
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
    expect(tool(model, TASKS)).toMatchObject({ contributionId: TASKS, aliases: [TASKS], expandedView: TASKS_VIEW, defaultSlot: 'left-bottom' })
    for (const id of [HEIMDALL, AUTOMATIONS, MOBILE]) expect(tool(model, id)).not.toHaveProperty('expandedView')
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
    expect(layout.sizes).toEqual({ left: 280, right: 280, bottom: 176, leftSplit: 0.75, rightSplit: 0.5, bottomSplit: 0.5 })
  })

  test('keeps third-party contributions reachable and carries validated placement and icon metadata', async () => {
    const { caller } = await start()
    const model = await caller.call('ui.contributions', {})
    expect(tool(model, CUSTOM)).toMatchObject({ title: 'Custom', icon: 'sparkles', hue: 'plum', defaultSlot: 'bottom-right', contributionId: CUSTOM })
    expect(tool(model, 'sidebar-section:acme.tools/launcher')).toMatchObject({ defaultSlot: 'bottom-right', icon: 'rocket' })
    expect(tool(model, 'activity-item:acme.tools/shortcuts')).toMatchObject({ defaultSlot: 'bottom-left', icon: 'zap' })
    expect(tool(model, OUTLINE)).toMatchObject({ defaultSlot: 'right-bottom' })
  })
  test('gives every tool its registered icon and hue, with manifest values winning over rules', async () => {
    const { caller } = await start()
    const model = await caller.call('ui.contributions', {})
    expect(tool(model, CHANGES)).toMatchObject({ icon: 'git-diff', hue: 'azure' })
    expect(tool(model, 'host:inbox')).toMatchObject({ icon: 'tray', hue: 'violet' })
    expect(tool(model, 'sidebar-section:quirky.worktree/remote-workspaces')).toMatchObject({ icon: 'hard-drives', hue: 'slate' })
    expect(tool(model, 'sidebar-section:quirky.agent-status/activity')).toMatchObject({ icon: 'pulse', hue: 'coral' })
    expect(tool(model, 'sidebar-section:quirky.agent-status/dashboard')).toMatchObject({ icon: 'gauge', hue: 'mint' })
    expect(tool(model, 'panel:quirky.vault/history')).toMatchObject({ icon: 'vault', hue: 'rose' })
    expect(tool(model, 'panel:quirky.ask/questions')).toMatchObject({ icon: 'chat-circle-dots', hue: 'lilac' })
    expect(tool(model, LEDGER)).toMatchObject({ icon: 'book-open-text', hue: 'tan' })
    expect(tool(model, OUTLINE)).toMatchObject({ icon: 'squares-four', hue: 'slate' })
    expect(tool(model, 'sidebar-section:acme.tools/launcher')).toMatchObject({ hue: 'slate' })
    expect(tool(model, 'activity-item:acme.tools/shortcuts')).toMatchObject({ icon: 'zap', hue: 'slate' })
  })

  test('falls back by registration kind when a tool has no rule, icon or hue', () => {
    const entry = (kind: UiSlotEntry['kind'], id: string): UiSlotEntry => ({ id, kind, plugin: 'acme.tools', title: id, order: 0, module: '/ui.js' })
    const tools = projectTools({
      panels: [entry('panel', 'panel:acme.tools/p')],
      sidebarSections: [entry('sidebar-section', 'sidebar-section:acme.tools/s')],
      activityItems: [entry('activity-item', 'activity-item:acme.tools/a')],
      views: []
    })
    const byId = (id: string) => tools.find((candidate) => candidate.id === id)
    expect(byId('panel:acme.tools/p')).toMatchObject({ icon: 'squares-four', hue: 'slate' })
    expect(byId('sidebar-section:acme.tools/s')).toMatchObject({ icon: 'sidebar', hue: 'slate' })
    expect(byId('activity-item:acme.tools/a')).toMatchObject({ icon: 'pulse', hue: 'slate' })
  })

  test('validates optional tool hue metadata on registration kinds', () => {
    for (const kind of ['panel', 'sidebar-section', 'activity-item']) {
      const valid: string[] = []
      checkUiKindEntry(kind, `${kind} valid`, { id: 'valid', title: 'Valid', hue: 'rose' }, valid)
      expect(valid).toEqual([])
      const errors: string[] = []
      checkUiKindEntry(kind, `${kind} invalid`, { id: 'invalid', title: 'Invalid', hue: 'neon' }, errors)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('hue')
      expect(errors[0]).toContain('neon')
    }
    const unknown: string[] = []
    checkUiKindEntry('view', 'view hue', { id: 'view', hue: 'rose' }, unknown)
    expect(unknown).toEqual(['view hue: unknown field `hue`'])
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

  test('registration kinds may name a setting that shows them; it must be a setting name', () => {
    for (const kind of ['panel', 'sidebar-section', 'activity-item']) {
      const valid: string[] = []
      checkUiKindEntry(kind, `${kind} valid`, { id: 'valid', title: 'Valid', whenSetting: 'board-enabled' }, valid)
      expect(valid).toEqual([])
    }
    const errors: string[] = []
    checkUiKindEntry('panel', 'panel invalid', { id: 'invalid', title: 'Invalid', whenSetting: '' }, errors)
    expect(errors).toEqual(['panel invalid: whenSetting must be a non-empty string'])
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

  test('moving a tool to overflow closes it, persists, and opening it restores its default slot', async () => {
    const env = makeEnv()
    const first = await env.start()
    const caller = await first.connect('cli')

    await caller.call('ui.tool.open', { id: TASKS })
    const moved = await caller.call('ui.tool.move', { id: TASKS, slot: 'overflow' })
    expect(moved.tools?.placements[TASKS]).toBe('overflow')
    expect(Object.values(moved.tools!.open)).not.toContain(TASKS)
    expect(moved.tools?.open['left-bottom']).toBeNull()

    const restarted = await env.restart()
    const afterRestart = await restarted.connect('cli')
    const stored = (await afterRestart.call('ui.state', {})).layout.tools!
    expect(stored.placements[TASKS]).toBe('overflow')
    expect(Object.values(stored.open)).not.toContain(TASKS)

    const reopened = await afterRestart.call('ui.tool.open', { id: TASKS })
    expect(reopened.tools?.placements[TASKS]).toBe('left-bottom')
    expect(reopened.tools?.open['left-bottom']).toBe(TASKS)
    for (const placement of Object.values(reopened.tools!.placements)) expect(UI_TOOL_PLACEMENTS).toContain(placement)
  })

  test('moving a closed tool to overflow leaves other open tools alone', async () => {
    const { caller } = await start()
    const moved = await caller.call('ui.tool.move', { id: LEDGER, slot: 'overflow' })
    expect(moved.tools?.placements[LEDGER]).toBe('overflow')
    expect(moved.tools?.open['left-top']).toBe(WORKTREES)
    expect(moved.tools?.open['right-top']).toBe(CHANGES)
  })

  test('opening a panel whose tool is in overflow restores the default slot', async () => {
    const { caller } = await start()
    await caller.call('ui.tool.move', { id: OUTLINE, slot: 'overflow' })
    const opened = await caller.call('ui.panel.open', { id: OUTLINE })
    expect(opened.tools?.placements[OUTLINE]).toBe('right-bottom')
    expect(opened.tools?.open['right-bottom']).toBe(OUTLINE)
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
    expect(layout.sizes).toMatchObject({ left: 280, right: 450, bottom: 240, leftSplit: 0.75, rightSplit: 0.4 })
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

  test('a stored overflow placement survives a layout resolve and an unknown placement falls back to the default slot', async () => {
    const seed = {
      view: null,
      panel: null,
      sidebar: true,
      focus: null,
      tools: {
        placements: { [WORKTREES]: 'left-top', [LEDGER]: 'overflow', [TASKS]: 'nowhere' },
        order: [WORKTREES, LEDGER, TASKS],
        open: { 'left-top': WORKTREES, 'left-bottom': null, 'right-top': null, 'right-bottom': null, 'bottom-left': LEDGER, 'bottom-right': null },
        sizes: { left: 280, right: 320, bottom: 240, leftSplit: 0.5, rightSplit: 0.5, bottomSplit: 0.5 }
      }
    }
    const { caller } = await start(seed)
    const layout = (await caller.call('ui.state', {})).layout.tools!
    expect(layout.placements[LEDGER]).toBe('overflow')
    expect(layout.placements[TASKS]).toBe('left-bottom')
    expect(layout.open['bottom-left']).toBeNull()
    expect(layout.open['left-top']).toBe(WORKTREES)
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
    expect((await caller.call('ui.state', {})).slots.find(({ id }) => id === HEIMDALL_VIEW)?.shown).toBe(false)
    const window = await harness.connectWithEvents('ui')
    await caller.call('ui.tool.open', { id: HEIMDALL })
    await window.client.call('ui.report', { slot: HEIMDALL_VIEW, state: { mounted: true } })

    const state = await caller.call('ui.state', {})
    expect(state.slots.find(({ id }) => id === HEIMDALL_VIEW)).toMatchObject({
      kind: 'view',
      shown: true,
      report: { mounted: true }
    })
    expect(state.slots.find(({ id }) => id === HEIMDALL)).toMatchObject({ kind: 'sidebar-section', shown: false })
  })

  test('state reports the Tasks slot body and its expanded view separately', async () => {
    const { caller } = await start()
    await caller.call('ui.tool.open', { id: TASKS })
    let state = await caller.call('ui.state', {})
    expect(state.slots.find(({ id }) => id === TASKS)?.shown).toBe(true)
    expect(state.slots.find(({ id }) => id === TASKS_VIEW)?.shown).toBe(false)

    await caller.call('ui.view.open', { id: TASKS_VIEW })
    state = await caller.call('ui.state', {})
    expect(state.slots.find(({ id }) => id === TASKS)?.shown).toBe(false)
    expect(state.slots.find(({ id }) => id === TASKS_VIEW)?.shown).toBe(true)
  })
  test('legacy panel width configuration remains a profile layout preference', async () => {
    const { caller } = await start()
    const configured = await caller.call('ui.panel.configure', { id: OUTLINE, width: 420 })
    expect(configured.panelWidths?.[OUTLINE]).toBe(420)
  })
})


describe('a tool with an expanded view', () => {
  const SLOT = 'left-bottom'

  function seedWithBothOpen() {
    return {
      view: { id: TASKS_VIEW },
      viewTabs: [{ id: TASKS_VIEW }],
      panel: null,
      sidebar: true,
      focus: null,
      tools: {
        placements: { [WORKTREES]: 'left-top', [TASKS]: SLOT },
        order: [WORKTREES, TASKS],
        open: { 'left-top': WORKTREES, [SLOT]: TASKS, 'right-top': null, 'right-bottom': null, 'bottom-left': null, 'bottom-right': null },
        sizes: { left: 280, right: 280, bottom: 176, leftSplit: 0.75, rightSplit: 0.5, bottomSplit: 0.5 }
      }
    }
  }

  async function connectWindow(harness: Harness, focused = false) {
    const window = await harness.connectWithEvents('ui')
    const { connId } = await window.client.call('ui.window.self', {})
    if (focused) await window.client.call('ui.window.focused', { focused: true })
    return { ...window, connId }
  }

  test('projects expandedView only while that view is effective, and only for the Tasks rule', async () => {
    const entry = (kind: UiSlotEntry['kind'], id: string): UiSlotEntry => ({ id, kind, plugin: 'quirky.tasks', title: id, order: 0, module: '/ui.js' })
    const sidebar = [entry('sidebar-section', TASKS), entry('sidebar-section', HEIMDALL)]
    const withView = projectTools({ panels: [], sidebarSections: sidebar, activityItems: [], views: [entry('view', TASKS_VIEW), entry('view', HEIMDALL_VIEW)] })
    expect(withView.find(({ id }) => id === TASKS)).toMatchObject({ contributionId: TASKS, expandedView: TASKS_VIEW })
    expect(withView.find(({ id }) => id === HEIMDALL)).toMatchObject({ contributionId: HEIMDALL_VIEW })
    expect(withView.find(({ id }) => id === HEIMDALL)).not.toHaveProperty('expandedView')

    const withoutView = projectTools({ panels: [], sidebarSections: sidebar, activityItems: [], views: [] })
    expect(withoutView.find(({ id }) => id === TASKS)).toMatchObject({ contributionId: TASKS })
    expect(withoutView.find(({ id }) => id === TASKS)).not.toHaveProperty('expandedView')
  })

  test('opening the tool while its view is active closes the view and opens the slot', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: TASKS_VIEW, input: { n: 1 } })
    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.view).toBeNull()
    expect(opened.viewTabs).toEqual([])
    expect(opened.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.state', {})).layout).toMatchObject({ view: null, tools: { open: { [SLOT]: TASKS } } })
  })

  test('closing the active view hands the center to the previous tab', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: REVIEW_VIEW, input: { n: 7 } })
    await caller.call('ui.view.open', { id: TASKS_VIEW })
    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.view).toEqual({ id: REVIEW_VIEW, input: { n: 7 } })
    expect(opened.viewTabs).toEqual([{ id: REVIEW_VIEW, input: { n: 7 } }])
    expect(opened.tools?.open[SLOT]).toBe(TASKS)
  })

  test('opening the tool while its view is a background tab activates the view with its input and leaves slots alone', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: TASKS_VIEW, input: { navigation: { page: 3 } } })
    await caller.call('ui.view.open', { id: REVIEW_VIEW })
    const before = (await caller.call('ui.state', {})).layout.tools!.open
    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.view).toEqual({ id: TASKS_VIEW, input: { navigation: { page: 3 } } })
    expect(opened.viewTabs?.map(({ id }) => id)).toEqual([TASKS_VIEW, REVIEW_VIEW])
    expect(opened.tools?.open).toEqual(before)
    expect(opened.tools?.open[SLOT]).toBeNull()
  })

  test('opening the tool while its view is not open opens the slot as before', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: REVIEW_VIEW })
    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.view).toEqual({ id: REVIEW_VIEW })
    expect(opened.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.tool.open', { id: TASKS })).tools?.open[SLOT]).toBe(TASKS)
  })

  test('opening the view clears the tool slot and keeps the rest of the layout', async () => {
    const { caller } = await start()
    await caller.call('ui.tool.open', { id: TASKS })
    await caller.call('ui.tool.open', { id: LEDGER })
    const opened = await caller.call('ui.view.open', { id: TASKS_VIEW, input: { detail: 1 } })
    expect(opened.view).toEqual({ id: TASKS_VIEW, input: { detail: 1 } })
    expect(opened.tools?.open[SLOT]).toBeNull()
    expect(opened.tools?.open['left-top']).toBe(WORKTREES)
    expect(opened.tools?.open['bottom-left']).toBe(LEDGER)
    expect(opened.tools?.placements[TASKS]).toBe(SLOT)
  })

  test('closing the view leaves every slot alone, and closing a slot works as before', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: TASKS_VIEW })
    await caller.call('ui.tool.open', { id: LEDGER })
    const closedView = await caller.call('ui.view.close', {})
    expect(closedView.view).toBeNull()
    expect(closedView.tools?.open[SLOT]).toBeNull()
    expect(closedView.tools?.open['bottom-left']).toBe(LEDGER)
    expect((await caller.call('ui.tool.close', { slot: 'bottom-left' })).tools?.open['bottom-left']).toBeNull()
  })

  test('a tool without an expanded view keeps both its slot and its body view', async () => {
    const { caller } = await start()
    await caller.call('ui.tool.open', { id: HEIMDALL })
    const viewOpened = await caller.call('ui.view.open', { id: HEIMDALL_VIEW })
    expect(viewOpened.view?.id).toBe(HEIMDALL_VIEW)
    expect(viewOpened.tools?.open[SLOT]).toBe(HEIMDALL)
    const toolOpened = await caller.call('ui.tool.open', { id: HEIMDALL })
    expect(toolOpened.view?.id).toBe(HEIMDALL_VIEW)
    expect(toolOpened.tools?.open[SLOT]).toBe(HEIMDALL)
  })

  test('a window opening the view or the tool follows the same rules', async () => {
    const { harness, caller } = await start()
    const window = await connectWindow(harness, true)
    await caller.call('ui.tool.open', { id: TASKS })

    const expanded = await caller.call('ui.window.view.open', { connId: window.connId, id: TASKS_VIEW, input: { a: 1 } })
    expect(expanded.view?.id).toBe(TASKS_VIEW)
    expect(expanded.tools?.open[SLOT]).toBeNull()

    const collapsed = await caller.call('ui.tool.open', { id: TASKS })
    expect(collapsed.view).toBeNull()
    expect(collapsed.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.window.state', { connId: window.connId })).layout.viewTabs).toEqual([])
  })

  test('with two windows the focused window decides, and no call hits the single-window conflict', async () => {
    const { harness, caller } = await start()
    const first = await connectWindow(harness)
    const second = await connectWindow(harness, true)
    await caller.call('ui.window.view.open', { connId: second.connId, id: TASKS_VIEW })
    await caller.call('ui.window.view.open', { connId: first.connId, id: TASKS_VIEW })

    const opened = await caller.call('ui.tool.open', { id: TASKS })
    expect(opened.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.window.state', { connId: second.connId })).layout.view).toBeNull()
    expect((await caller.call('ui.window.state', { connId: first.connId })).layout.view?.id).toBe(TASKS_VIEW)

    const reopened = await caller.call('ui.window.view.open', { connId: second.connId, id: TASKS_VIEW })
    expect(reopened.tools?.open[SLOT]).toBeNull()
    expect(reopened.view?.id).toBe(TASKS_VIEW)
  })

  test('a window that closed its own copy does not make the next panel open collapse', async () => {
    const { harness, caller } = await start()
    const first = await connectWindow(harness, true)
    await caller.call('ui.window.view.open', { connId: first.connId, id: TASKS_VIEW })
    const second = await connectWindow(harness)
    await caller.call('ui.window.view.close', { connId: first.connId })

    await caller.call('ui.tool.open', { id: TASKS })
    expect((await caller.call('ui.window.state', { connId: first.connId })).layout.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.window.state', { connId: second.connId })).layout.tools?.open[SLOT]).toBe(TASKS)
    expect((await caller.call('ui.state', {})).layout.tools?.open[SLOT]).toBe(TASKS)
  })

  test('a stored layout with both open settles to the tab at load', async () => {
    const { caller } = await start(seedWithBothOpen())
    const layout = (await caller.call('ui.state', {})).layout
    expect(layout.view).toEqual({ id: TASKS_VIEW })
    expect(layout.viewTabs).toEqual([{ id: TASKS_VIEW }])
    expect(layout.tools?.open[SLOT]).toBeNull()
    expect(layout.tools?.open['left-top']).toBe(WORKTREES)
  })

  test('a stored layout is left alone at load when two windows are already connected', async () => {
    const env = makeEnv(seedWithBothOpen())
    const harness = await env.start()
    const caller = await harness.connect('cli')
    await harness.connectWithEvents('ui')
    await harness.connectWithEvents('ui')
    expect((await caller.call('ui.state', {})).layout.tools?.open[SLOT]).toBe(TASKS)
  })
})
