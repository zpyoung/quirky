import { describe, expect, test } from 'bun:test'
import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'
import {
  discoverCaptureTargets,
  enableCaptureVisibilitySettings,
  projectCaptureInventory,
  scopeCaptureInventory,
  validateContributionInventory
} from './contribution-inventory'
import type { CaptureTarget, ContributionInventory } from './contracts'

const ownerOf = (id: string): string | null => {
  const separator = id.indexOf(':')
  const slash = id.indexOf('/', separator + 1)
  return separator >= 0 && slash > separator ? id.slice(separator + 1, slash) : null
}

function emptyModel(): UiModel {
  return {
    sidebarSections: [],
    statusBars: [],
    activityItems: [],
    panels: [],
    settingsSections: [],
    views: [],
    overlays: [],
    commands: [],
    keybindings: [],
    settings: [],
    menuItems: [],
    themes: [],
    theme: { chosen: 'default', active: 'default' },
    modules: {},
    tools: []
  } as UiModel
}

function addSlot(model: UiModel, id: string, module: string | null = `/plugins/${ownerOf(id)}/dist/ui.js`): UiSlotEntry {
  const kind = id.slice(0, id.indexOf(':')) as UiSlotEntry['kind']
  const entry: UiSlotEntry = {
    id,
    kind,
    plugin: ownerOf(id) ?? 'acme.test',
    title: id,
    order: 0,
    module
  }
  switch (kind) {
    case 'sidebar-section': model.sidebarSections.push(entry); break
    case 'status-bar': model.statusBars.push(entry); break
    case 'activity-item': model.activityItems.push(entry); break
    case 'panel': model.panels.push(entry); break
    case 'view': model.views.push(entry); break
    case 'overlay': model.overlays.push(entry); break
    case 'settings-section': model.settingsSections.push(entry); break
  }
  return entry
}

function addTool(model: UiModel, id: string, contributionId: string | null, aliases: string[] = [id]): UiToolEntry {
  const tool: UiToolEntry = {
    id,
    title: id,
    icon: 'pulse',
    hue: 'slate',
    defaultSlot: 'left-top',
    contributionId,
    aliases
  }
  model.tools!.push(tool)
  return tool
}

function captureTarget(id: string, kind: CaptureTarget['kind']): CaptureTarget {
  return { id, plugin: ownerOf(id), title: id, kind }
}

const fiveMappings = [
  ['sidebar-section:quirky.mobile/mobile', 'sidebar-section:quirky.mobile/mobile', 'view:quirky.mobile/page'],
  ['sidebar-section:quirky.editor/explorer', 'panel:quirky.editor/explorer', 'panel:quirky.editor/explorer'],
  ['sidebar-section:quirky.automations/automations', 'sidebar-section:quirky.automations/automations', 'view:quirky.automations/automations'],
  ['sidebar-section:quirky.heimdall/navigation', 'sidebar-section:quirky.heimdall/navigation', 'view:quirky.heimdall/fleet'],
  ['sidebar-section:quirky.ledger/ledger', 'panel:quirky.ledger/ledger', 'panel:quirky.ledger/ledger']
] as const

function fivePairModel(): UiModel {
  const model = emptyModel()
  for (const [declarationId, toolId, bodyId] of fiveMappings) {
    addSlot(model, declarationId)
    addSlot(model, bodyId)
    addTool(model, toolId, bodyId, [...new Set([toolId, declarationId, bodyId])])
  }
  addSlot(model, 'sidebar-section:acme.extras/ordinary')
  addTool(model, 'sidebar-section:acme.extras/ordinary', 'sidebar-section:acme.extras/ordinary')
  addSlot(model, 'activity-item:acme.extras/activity')
  addSlot(model, 'panel:acme.extras/activity-body')
  addTool(model, 'panel:acme.extras/activity-body', 'panel:acme.extras/activity-body', [
    'panel:acme.extras/activity-body', 'activity-item:acme.extras/activity'
  ])
  addTool(model, 'host:inbox', null, [])
  return model
}

function aliasModel(): UiModel {
  const model = emptyModel()
  const declarationId = 'sidebar-section:acme.owner/navigation'
  const bodyId = 'view:acme.owner/page'
  addSlot(model, declarationId)
  addSlot(model, bodyId)
  addTool(model, declarationId, bodyId, [declarationId, bodyId])
  return model
}

function setting(id: string, type: 'boolean' | 'number' = 'boolean') {
  return { id, plugin: id.split(':')[1]?.split('/')[0] ?? '', pluginName: 'Example', type, title: id, default: false }
}

function visibleModel(visibilitySettings: string[] = []): UiModel {
  const model = emptyModel()
  model.visibilitySettings = visibilitySettings
  model.settings = visibilitySettings.map((id) => setting(id) as UiModel['settings'][number])
  return model
}

describe('raw UI capture discovery', () => {
  test('retains the unchanged host surfaces and every raw slot kind', () => {
    const model = emptyModel()
    for (const [kind, id] of [
      ['view', 'view:acme.editor/document'],
      ['panel', 'panel:acme.git/changes'],
      ['sidebar-section', 'sidebar-section:acme.nav/home'],
      ['activity-item', 'activity-item:acme.activity/items'],
      ['status-bar', 'status-bar:acme.status/summary'],
      ['overlay', 'overlay:acme.editor/quick-open'],
      ['settings-section', 'settings-section:acme.settings/accounts']
    ] as const) addSlot(model, id)

    const targets = discoverCaptureTargets(model)

    expect(targets.filter(({ kind }) => kind === 'host').map(({ id }) => id)).toEqual([
      'host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'
    ])
    expect(new Set(targets.map(({ kind }) => kind))).toEqual(new Set([
      'host', 'view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'
    ]))
  })

  test('rejects duplicate raw contribution IDs', () => {
    const model = emptyModel()
    addSlot(model, 'view:acme.editor/document')
    addSlot(model, 'panel:acme.editor/document')
    model.panels[0] = { ...model.panels[0], id: 'view:acme.editor/document' }

    expect(() => discoverCaptureTargets(model)).toThrow(/duplicate.*target ID/i)
  })
})

describe('projected contribution inventory', () => {
  test('reconciles five sidebar navigation aliases while keeping declarations and independently mounted activity items', () => {
    const { targets, contributionInventory } = projectCaptureInventory(fivePairModel())
    const aliasIds = fiveMappings.map(([declarationId]) => declarationId).sort()
    const expectedMappings = fiveMappings
      .map(([declarationId, toolId, renderedTargetId]) => ({ declarationId, toolId, renderedTargetId }))
      .sort((left, right) => left.declarationId < right.declarationId ? -1 : left.declarationId > right.declarationId ? 1 : 0)

    expect(aliasIds.every((id) => !targets.some((target) => target.id === id))).toBe(true)
    expect(contributionInventory.toolAliases.map(({ declaration }) => declaration.id)).toEqual(aliasIds)
    expect(contributionInventory.toolAliases.map(({ renderedTarget }) => renderedTarget.id).sort()).toEqual(
      fiveMappings.map(([, , bodyId]) => bodyId).sort()
    )
    expect(contributionInventory.declaredTargets.map(({ id }) => id)).toEqual(
      [...contributionInventory.declaredTargets.map(({ id }) => id)].sort()
    )
    expect(contributionInventory.declaredTargets.map(({ id }) => id)).toEqual(expect.arrayContaining(aliasIds))
    expect(targets.map(({ id }) => id)).toContain('sidebar-section:acme.extras/ordinary')
    expect(targets.map(({ id }) => id)).toContain('activity-item:acme.extras/activity')
    expect(targets.map(({ id }) => id)).toContain('panel:acme.extras/activity-body')
    expect(contributionInventory.toolAliases.map(({ declaration, toolId, renderedTarget }) => ({
      declarationId: declaration.id,
      toolId,
      renderedTargetId: renderedTarget.id
    }))).toEqual(expectedMappings)
    expect(contributionInventory.toolAliases).toEqual(contributionInventory.toolAliases.map((alias) => ({
      declaration: alias.declaration,
      toolId: alias.toolId,
      renderedTarget: alias.renderedTarget,
      reason: 'tool-navigation-alias'
    })))
  })

  test('retains canonical and ordinary sidebar bodies as screenshot targets', () => {
    const model = emptyModel()
    addSlot(model, 'sidebar-section:acme.owner/navigation')
    addTool(model, 'sidebar-section:acme.owner/navigation', 'sidebar-section:acme.owner/navigation')

    const { targets, contributionInventory } = projectCaptureInventory(model)

    expect(targets.map(({ id }) => id)).toContain('sidebar-section:acme.owner/navigation')
    expect(contributionInventory.toolAliases).toEqual([])
  })

  test.each([
    ['missing body', (model: UiModel) => { model.tools![0].contributionId = 'view:acme.owner/missing' }, 'view:acme.owner/missing'],
    ['null module', (model: UiModel) => { model.views[0].module = null }, 'view:acme.owner/page'],
    ['null body from Inbox', (model: UiModel) => { model.tools![0].contributionId = null; model.tools![0].id = 'host:inbox' }, 'sidebar-section:acme.owner/navigation'],
    ['multiple hosting tools', (model: UiModel) => { addTool(model, 'panel:acme.owner/other', 'view:acme.owner/page', ['sidebar-section:acme.owner/navigation']) }, 'sidebar-section:acme.owner/navigation'],
    ['different logical owner', (model: UiModel) => { model.views[0].id = 'view:another.owner/page'; model.tools![0].contributionId = 'view:another.owner/page' }, 'another.owner'],
    ['undeclared body', (model: UiModel) => { model.tools![0].contributionId = 'panel:acme.owner/undeclared' }, 'panel:acme.owner/undeclared'],
    ['non-renderable body kind', (model: UiModel) => { addSlot(model, 'status-bar:acme.owner/status'); model.tools![0].contributionId = 'status-bar:acme.owner/status' }, 'status-bar:acme.owner/status']
  ])('fails closed for %s tool projections with identifying IDs', (_name, mutate, evidence) => {
    const model = aliasModel()
    mutate(model)

    expect(() => projectCaptureInventory(model)).toThrow(new RegExp(`invalid-tool-projection.*${String(evidence).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
  })
})

describe('contribution inventory validation and scope', () => {
  function validInventory() {
    return projectCaptureInventory(aliasModel())
  }
  function replaceTarget(targets: CaptureTarget[], id: string, replacement: CaptureTarget): void {
    const index = targets.findIndex((target) => target.id === id)
    if (index < 0) throw new Error(`missing target fixture: ${id}`)
    targets[index] = replacement
  }

  test('validates a complete declaration partition and scopes exact bodies with their aliases', () => {
    const { targets, contributionInventory } = validInventory()
    validateContributionInventory(contributionInventory, targets)

    const body = targets.find(({ id }) => id === 'view:acme.owner/page')!
    const scoped = scopeCaptureInventory(contributionInventory, [body])
    expect(scoped.declaredTargets.map(({ id }) => id)).toEqual([
      'sidebar-section:acme.owner/navigation', 'view:acme.owner/page'
    ])
    expect(scoped.toolAliases).toHaveLength(1)
    expect(scoped.toolAliases[0].renderedTarget.id).toBe(body.id)
    expect(scopeCaptureInventory(contributionInventory, [targets.find(({ kind }) => kind === 'host')!]).toolAliases).toEqual([])
  })

  test('rejects a selected alias declaration instead of treating it as a screenshot target', () => {
    const { contributionInventory } = validInventory()
    expect(() => scopeCaptureInventory(contributionInventory, [
      captureTarget('sidebar-section:acme.owner/navigation', 'sidebar-section')
    ])).toThrow(/not a projected target|unknown.*target/i)
  })

  test.each([
    ['missing metadata', (inventory: ContributionInventory, _targets: CaptureTarget[]) => { delete (inventory as unknown as Record<string, unknown>).toolAliases }, 'metadata must contain only declaredTargets and toolAliases'],
    ['duplicate declarations', (inventory: ContributionInventory, _targets: CaptureTarget[]) => {
      const declaration = inventory.declaredTargets[0]
      inventory.declaredTargets.splice(1, 0, { ...declaration })
    }, 'duplicate declared target ID'],
    ['duplicate alias records', (inventory: ContributionInventory, _targets: CaptureTarget[]) => { inventory.toolAliases.push({ ...inventory.toolAliases[0] }) }, 'duplicate alias declaration'],
    ['forged ordinary alias', (inventory: ContributionInventory, targets: CaptureTarget[]) => {
      const previous = inventory.toolAliases[0].declaration
      const replacement = captureTarget('activity-item:acme.owner/navigation', 'activity-item')
      inventory.toolAliases[0].declaration = replacement
      replaceTarget(inventory.declaredTargets, previous.id, replacement)
      inventory.declaredTargets.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      targets.push(replacement)
    }, 'invalid alias declaration or rendered body kind'],
    ['wrong body kind', (inventory: ContributionInventory, targets: CaptureTarget[]) => {
      const previous = inventory.toolAliases[0].renderedTarget
      const replacement = captureTarget('sidebar-section:acme.owner/page', 'sidebar-section')
      inventory.toolAliases[0].renderedTarget = replacement
      replaceTarget(inventory.declaredTargets, previous.id, replacement)
      inventory.declaredTargets.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      replaceTarget(targets, previous.id, replacement)
    }, 'invalid alias declaration or rendered body kind'],
    ['different tool owner', (inventory: ContributionInventory, _targets: CaptureTarget[]) => {
      inventory.toolAliases[0].toolId = 'sidebar-section:another.owner/navigation'
    }, 'alias ownership does not match its tool and rendered body'],
    ['self alias', (inventory: ContributionInventory, _targets: CaptureTarget[]) => { inventory.toolAliases[0].renderedTarget = { ...inventory.toolAliases[0].declaration } }, 'self-alias cycle'],
    ['chain', (inventory: ContributionInventory, _targets: CaptureTarget[]) => {
      inventory.toolAliases.push({
        ...inventory.toolAliases[0],
        declaration: { ...inventory.toolAliases[0].declaration, id: 'sidebar-section:acme.owner/second' },
        renderedTarget: { ...inventory.toolAliases[0].declaration }
      })
    }, 'alias chain maps through another declaration'],
    ['cycle', (inventory: ContributionInventory, _targets: CaptureTarget[]) => {
      const first = inventory.toolAliases[0]
      const secondDeclaration = { ...first.declaration, id: 'sidebar-section:acme.owner/second' }
      inventory.toolAliases = [
        { ...first, renderedTarget: secondDeclaration },
        { ...first, declaration: secondDeclaration, renderedTarget: first.declaration }
      ]
    }, 'cyclic alias mapping'],
    ['alias extra fields', (inventory: ContributionInventory, _targets: CaptureTarget[]) => { (inventory.toolAliases[0] as unknown as Record<string, unknown>).score = 90 }, 'malformed tool alias 0'],
    ['incomplete declaration partition', (_inventory: ContributionInventory, targets: CaptureTarget[]) => {
      const index = targets.findIndex(({ id }) => id === 'host:shell')
      if (index < 0) throw new Error('missing host target fixture')
      targets.splice(index, 1)
    }, 'declaration is missing from the target partition']
  ])('rejects %s inventory evidence', (_name, mutate, expectedReason) => {
    const { targets, contributionInventory } = validInventory()
    const changed = structuredClone(contributionInventory) as ContributionInventory
    mutate(changed, targets)

    const escapedReason = expectedReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(() => validateContributionInventory(changed, targets)).toThrow(
      new RegExp(`^invalid-contribution-inventory: ${escapedReason}(?: \\(|$)`)
    )
  })

  test('rejects duplicate and runtime-only projected targets', () => {
    const { targets, contributionInventory } = validInventory()
    expect(() => validateContributionInventory(contributionInventory, [...targets, targets[0]])).toThrow(/duplicate/i)
    expect(() => validateContributionInventory(contributionInventory, [
      ...targets, captureTarget('panel:acme.owner/runtime-only', 'panel')
    ])).toThrow(/inventory|partition|declared/i)
  })
})

describe('capture visibility gates', () => {
  test('sets only declared visibility booleans, verifies effective values, then refetches the model', async () => {
    const ids = ['setting:quirky.agent-status/dashboard-enabled', 'setting:acme.plugin/other-gate']
    const unrelatedId = 'setting:acme.plugin/unrelated-enabled'
    const initial = visibleModel([...ids].reverse())
    const refreshed = visibleModel([...ids].reverse())
    const unrelatedSetting = setting(unrelatedId) as UiModel['settings'][number]
    initial.settings.push(unrelatedSetting)
    refreshed.settings.push({ ...unrelatedSetting })
    addSlot(refreshed, 'sidebar-section:quirky.agent-status/dashboard')
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const result = await enableCaptureVisibilitySettings(initial, async (method, params) => {
      calls.push({ method, params })
      if (method === 'setting.set') return { id: params.id, type: 'boolean', value: true }
      if (method === 'ui.contributions') return refreshed
      throw new Error(`unexpected RPC ${method}`)
    })

    expect(calls).toEqual([
      { method: 'setting.set', params: { id: 'setting:acme.plugin/other-gate', value: true } },
      { method: 'setting.set', params: { id: 'setting:quirky.agent-status/dashboard-enabled', value: true } },
      { method: 'ui.contributions', params: {} }
    ])
    expect(initial.visibilitySettings).not.toContain(unrelatedId)
    expect(refreshed.visibilitySettings).not.toContain(unrelatedId)
    expect(initial.settings.find(({ id }) => id === unrelatedId)).toMatchObject({ type: 'boolean', default: false })
    expect(refreshed.settings.find(({ id }) => id === unrelatedId)).toMatchObject({ type: 'boolean', default: false })
    expect(result.model).toBe(refreshed)
    expect(discoverCaptureTargets(result.model).map(({ id }) => id)).toContain('sidebar-section:quirky.agent-status/dashboard')
    expect(result).toEqual({ model: refreshed, activatedVisibilitySettings: [...ids].sort() })
  })

  test('leaves a model with no visibility gates untouched', async () => {
    const initial = visibleModel()
    const result = await enableCaptureVisibilitySettings(initial, async () => {
      throw new Error('no RPC should be needed')
    })
    expect(result).toEqual({ model: initial, activatedVisibilitySettings: [] })
  })

  test.each([
    ['missing setting', (model: UiModel) => { model.settings = [] }, /missing.*setting.*setting:acme.owner\/gate/i],
    ['non-boolean setting', (model: UiModel) => { model.settings = [setting('setting:acme.owner/gate', 'number') as UiModel['settings'][number]] }, /non-boolean.*setting.*setting:acme.owner\/gate/i]
  ])('rejects a %s gate before writing', async (_name, mutate, expected) => {
    const initial = visibleModel(['setting:acme.owner/gate'])
    mutate(initial)
    let calls = 0
    await expect(enableCaptureVisibilitySettings(initial, async () => { calls++; return {} })).rejects.toThrow(expected)
    expect(calls).toBe(0)
  })

  test.each([
    ['refused write', async () => { throw new Error('denied') }, /setting write.*setting:acme.owner\/gate/i],
    ['wrong effective value', async () => ({ id: 'setting:acme.owner/gate', type: 'boolean', value: false }), /effective value.*setting:acme.owner\/gate/i],
    ['wrong returned ID', async () => ({ id: 'setting:other.owner/gate', type: 'boolean', value: true }), /setting write.*setting:acme.owner\/gate/i]
  ])('rejects a %s', async (_name, setResult, expected) => {
    const initial = visibleModel(['setting:acme.owner/gate'])
    const calls: string[] = []
    await expect(enableCaptureVisibilitySettings(initial, async (method) => {
      calls.push(method)
      if (method === 'setting.set') return setResult()
      return visibleModel(['setting:acme.owner/gate'])
    })).rejects.toThrow(expected)
    expect(calls).toEqual(['setting.set'])
  })

  test('rejects changed visibility gates after the refetch', async () => {
    const initial = visibleModel(['setting:acme.owner/gate'])
    await expect(enableCaptureVisibilitySettings(initial, async (method, params) => {
      if (method === 'setting.set') return { id: params.id, type: 'boolean', value: true }
      return visibleModel(['setting:acme.owner/new-gate'])
    })).rejects.toThrow(/changed.*visibility.*setting:acme.owner\/gate|setting:acme.owner\/new-gate/i)
  })
})
