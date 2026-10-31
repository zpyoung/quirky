import { describe, expect, test } from 'bun:test'
import type { CaptureTarget } from './contracts'
import { captureCells, discoverCaptureTargets, hostingToolFor, openSurfaceTool, selectCaptureTargets, waitForStateShown } from './capture'
import { goldenFor } from './goldens'
import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'

const slot = (id: string, plugin: string, title = id): UiSlotEntry => ({
  id, plugin, title, kind: id.slice(0, id.indexOf(':')) as UiSlotEntry['kind'],
  module: `/plugins/${plugin}/dist/ui.js`, order: 10
})

function model(): UiModel {
  return {
    sidebarSections: [slot('sidebar-section:acme.worktrees/list', 'acme.worktrees')],
    statusBars: [slot('status-bar:acme.status/summary', 'acme.status')],
    activityItems: [slot('activity-item:acme.inbox/items', 'acme.inbox')],
    panels: [slot('panel:acme.git/changes', 'acme.git')],
    settingsSections: [slot('settings-section:acme.settings/accounts', 'acme.settings')],
    views: [slot('view:acme.editor/document', 'acme.editor')],
    overlays: [slot('overlay:acme.editor/quick-open', 'acme.editor')],
    commands: [],
    keybindings: [],
    settings: [],
    menuItems: [],
    themes: [],
    theme: { chosen: 'default', active: 'default' },
    modules: {}
  } as UiModel
}

describe('UI capture inventory', () => {
  test('discovers all seven contribution slot kinds and the host surfaces', () => {
    const targets = discoverCaptureTargets(model())

    expect(new Set(targets.map((target) => target.kind))).toEqual(new Set([
      'host', 'view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'
    ]))
    expect(targets.filter((target) => target.kind === 'host').map((target) => target.id)).toEqual([
      'host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'
    ])
    expect(targets.map((target) => target.id)).toContain('settings-section:acme.settings/accounts')
  })

  test('matches exact contribution IDs and exact plugin IDs without partial matches', () => {
    const targets = discoverCaptureTargets(model())
    const byContribution = selectCaptureTargets(targets, ['view:acme.editor/document'])
    const byPlugin = selectCaptureTargets(targets, ['acme.editor'])

    expect(byContribution.map((target) => target.id)).toEqual(['view:acme.editor/document'])
    expect(byPlugin.map((target) => target.id)).toEqual([
      'view:acme.editor/document', 'overlay:acme.editor/quick-open'
    ])
    expect(() => selectCaptureTargets(targets, ['acme'])).toThrow(/unknown.*selector/i)
  })

  test('rejects empty and unknown selectors instead of returning an empty success', () => {
    const targets = discoverCaptureTargets(model())

    expect(() => selectCaptureTargets(targets, [''])).toThrow(/empty.*selector/i)
    expect(() => selectCaptureTargets(targets, ['   '])).toThrow(/empty.*selector/i)
    expect(() => selectCaptureTargets(targets, ['host:missing'])).toThrow(/unknown.*selector/i)
    expect(() => selectCaptureTargets(targets, ['acme.editor', 'missing.plugin'])).toThrow(/unknown.*selector/i)
  })

  test('rejects duplicate target IDs before constructing a coverage matrix', () => {
    const duplicate = model()
    duplicate.views = [slot('host:shell', 'acme.editor') as UiModel['views'][number]]

    expect(() => discoverCaptureTargets(duplicate)).toThrow(/duplicate.*target ID/i)
  })

  test('creates exactly one dark and light coverage cell per selected target', () => {
    const targets: CaptureTarget[] = [
      { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' },
      { id: 'panel:acme.git/changes', plugin: 'acme.git', title: 'Changes', kind: 'panel' }
    ]
    const cells = captureCells(targets)

    expect(cells).toHaveLength(4)
    expect(cells).toEqual([
      { targetId: 'host:shell', theme: 'dark' },
      { targetId: 'panel:acme.git/changes', theme: 'dark' },
      { targetId: 'host:shell', theme: 'light' },
      { targetId: 'panel:acme.git/changes', theme: 'light' }
    ])
    expect(new Set(cells.map(({ targetId, theme }) => `${targetId}\0${theme}`)).size).toBe(cells.length)
  })
})

describe('host composite targets', () => {
  test('host:shell, host:scoped and host:popups are listed and each maps to its own golden', () => {
    const hosts = discoverCaptureTargets(model()).filter((target) => target.kind === 'host')

    expect(hosts.map((target) => target.id)).toEqual(expect.arrayContaining(['host:shell', 'host:scoped', 'host:popups']))
    for (const [id, kind] of [['host:shell', 'shell'], ['host:scoped', 'scoped'], ['host:popups', 'popups']] as const) {
      expect(goldenFor(id, 'dark')).toEndWith(`golden-${kind}-dark.png`)
      expect(goldenFor(id, 'light')).toEndWith(`golden-${kind}-light.png`)
    }
  })
})

const tool = (id: string, contributionId: string | null, aliases: string[] = [contributionId ?? id]): UiToolEntry => ({
  id, title: id, icon: 'pulse', hue: 'slate', defaultSlot: 'left-top', contributionId, aliases
})

function toolModel(): UiModel {
  return {
    ...model(),
    tools: [
      tool('sidebar-section:acme.worktrees/list', 'sidebar-section:acme.worktrees/list'),
      tool('sidebar-section:acme.tasks/list', 'view:acme.tasks/page', ['sidebar-section:acme.tasks/list', 'view:acme.tasks/page']),
      tool('panel:acme.git/changes', 'panel:acme.git/changes', ['panel:acme.git/changes', 'activity-item:acme.git/source-control'])
    ]
  } as UiModel
}

const target = (id: string, plugin: string, kind: CaptureTarget['kind']): CaptureTarget => ({ id, plugin, title: id, kind })

function fakeRuntime(state: () => unknown) {
  const calls: Array<{ method: string; params: unknown }> = []
  const runtime = {
    model: toolModel(),
    options: { timeoutMs: 400 },
    client: {
      async callAny(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params })
        return method === 'ui.state' ? state() : {}
      },
      close() {}
    }
  }
  return { runtime, calls }
}

describe('opening the tool that hosts a target', () => {
  test('a sidebar section is hosted by the tool that lists it as its body or an alias', () => {
    const m = toolModel()

    expect(hostingToolFor(m, target('sidebar-section:acme.worktrees/list', 'acme.worktrees', 'sidebar-section'))).toBe('sidebar-section:acme.worktrees/list')
    expect(hostingToolFor(m, target('sidebar-section:acme.tasks/list', 'acme.tasks', 'sidebar-section'))).toBe('sidebar-section:acme.tasks/list')
    expect(hostingToolFor(m, target('activity-item:acme.git/source-control', 'acme.git', 'activity-item'))).toBe('panel:acme.git/changes')
  })

  test('a status bar item needs no tool', () => {
    expect(hostingToolFor(toolModel(), target('status-bar:acme.status/summary', 'acme.status', 'status-bar'))).toBeNull()
  })

  test('a sidebar section with no hosting tool is reported instead of waited for', () => {
    expect(() => hostingToolFor(toolModel(), target('sidebar-section:acme.ghost/none', 'acme.ghost', 'sidebar-section'))).toThrow(/no tool hosts/i)
  })

  test('a sidebar-section target opens its tool and is shown without waiting out the timeout', async () => {
    const section = target('sidebar-section:acme.worktrees/list', 'acme.worktrees', 'sidebar-section')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [{ id: section.id, shown: calls.some((call) => call.method === 'ui.tool.open') }] }))
    const started = Date.now()

    await openSurfaceTool(runtime as never, section)
    await waitForStateShown(runtime as never, section)

    expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: 'sidebar-section:acme.worktrees/list' })
    expect(Date.now() - started).toBeLessThan(300)
  })

  test('a section whose tool shows a different body fails at once instead of waiting for a state that cannot come', async () => {
    const tasks = target('sidebar-section:acme.tasks/list', 'acme.tasks', 'sidebar-section')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [] }))

    await expect(openSurfaceTool(runtime as never, tasks)).rejects.toThrow(/view:acme\.tasks\/page/)
    expect(calls.map((call) => call.method)).not.toContain('ui.tool.open')
  })

  test('a status-bar target opens no tool', async () => {
    const status = target('status-bar:acme.status/summary', 'acme.status', 'status-bar')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [{ id: status.id, shown: true }] }))

    await openSurfaceTool(runtime as never, status)
    await waitForStateShown(runtime as never, status)

    expect(calls.map((call) => call.method)).not.toContain('ui.tool.open')
  })
})
