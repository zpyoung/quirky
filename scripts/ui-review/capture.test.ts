import { describe, expect, test } from 'bun:test'
import type { CaptureTarget } from './contracts'
import { captureCells, discoverCaptureTargets, selectCaptureTargets } from './capture'
import type { UiModel } from '@quirky/protocol'

const slot = (id: string, plugin: string, title = id) => ({ id, plugin, title, module: `/plugins/${plugin}/dist/ui.js`, order: 10 })

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
  test('discovers all seven contribution slot kinds and the three host surfaces', () => {
    const targets = discoverCaptureTargets(model())

    expect(new Set(targets.map((target) => target.kind))).toEqual(new Set([
      'host', 'view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'
    ]))
    expect(targets.filter((target) => target.kind === 'host').map((target) => target.id)).toEqual([
      'host:shell', 'host:settings', 'host:palette'
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
