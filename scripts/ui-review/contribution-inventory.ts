import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'
import type { CaptureTarget, ContributionInventory, ToolNavigationAlias } from './contracts'

export function discoverCaptureTargets(model: UiModel): CaptureTarget[] {
  const toTarget = (entry: UiSlotEntry, kind: CaptureTarget['kind']): CaptureTarget => {
    const separator = entry.id.indexOf(':')
    const slash = entry.id.indexOf('/', separator + 1)
    const plugin = separator >= 0 && slash > separator
      ? entry.id.slice(separator + 1, slash)
      : entry.plugin
    return { id: entry.id, plugin, title: entry.title, kind }
  }
  const targets = [
    { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' as const },
    { id: 'host:scoped', plugin: null, title: 'Quirky scoped to one project', kind: 'host' as const },
    { id: 'host:popups', plugin: null, title: 'Quirky with its popups open', kind: 'host' as const },
    ...model.views.map((entry) => toTarget(entry, 'view')),
    ...model.panels.map((entry) => toTarget(entry, 'panel')),
    ...model.sidebarSections.map((entry) => toTarget(entry, 'sidebar-section')),
    ...model.activityItems.map((entry) => toTarget(entry, 'activity-item')),
    ...model.statusBars.map((entry) => toTarget(entry, 'status-bar')),
    ...model.overlays.map((entry) => toTarget(entry, 'overlay')),
    ...model.settingsSections.map((entry) => toTarget(entry, 'settings-section')),
    { id: 'host:settings', plugin: null, title: 'Settings', kind: 'host' as const },
    { id: 'host:palette', plugin: null, title: 'Command palette', kind: 'host' as const }
  ]
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.id)) throw new Error(`duplicate UI capture target ID ${target.id}`)
    seen.add(target.id)
  }
  return targets
}

const TARGET_KINDS = {
  host: true,
  panel: true,
  view: true,
  'sidebar-section': true,
  'activity-item': true,
  'status-bar': true,
  overlay: true,
  'settings-section': true
} satisfies Record<CaptureTarget['kind'], true>

type ToolProjectionEntry = Pick<UiToolEntry, 'id' | 'contributionId' | 'aliases'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function kindFromId(id: string): string | null {
  const separator = id.indexOf(':')
  return separator > 0 ? id.slice(0, separator) : null
}

function ownerFromId(id: string): string | null {
  const separator = id.indexOf(':')
  const slash = id.indexOf('/', separator + 1)
  return separator >= 0 && slash > separator ? id.slice(separator + 1, slash) : null
}

function compareId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function invalidToolProjection(reason: string, ...ids: Array<string | null | undefined>): never {
  const evidence = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  throw new Error(`invalid-tool-projection: ${reason}${evidence.length > 0 ? ` (${evidence.join(', ')})` : ''}`)
}

function invalidContributionInventory(reason: string, ...ids: Array<string | null | undefined>): never {
  const evidence = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  throw new Error(`invalid-contribution-inventory: ${reason}${evidence.length > 0 ? ` (${evidence.join(', ')})` : ''}`)
}

function assertCaptureTarget(value: unknown, context: string): CaptureTarget {
  if (!isRecord(value) || !exactKeys(value, ['id', 'plugin', 'title', 'kind'])) {
    invalidContributionInventory(`malformed ${context}`)
  }
  const { id, plugin, title, kind } = value
  if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string' ||
    typeof kind !== 'string' || !Object.hasOwn(TARGET_KINDS, kind) ||
    (plugin !== null && typeof plugin !== 'string')) {
    invalidContributionInventory(`malformed ${context}`, typeof id === 'string' ? id : undefined)
  }
  if (kind === 'host') {
    if (plugin !== null || kindFromId(id) !== 'host') {
      invalidContributionInventory(`invalid host ownership in ${context}`, id)
    }
  } else if (plugin === null || kindFromId(id) !== kind || ownerFromId(id) !== plugin) {
    invalidContributionInventory(`invalid contribution ownership or kind in ${context}`, id)
  }
  return value as unknown as CaptureTarget
}

function sameTarget(left: CaptureTarget, right: CaptureTarget): boolean {
  return left.id === right.id &&
    left.plugin === right.plugin &&
    left.title === right.title &&
    left.kind === right.kind
}

function assertSortedById(values: Array<{ id: string }>, label: string): void {
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1].id > values[index].id) {
      invalidContributionInventory(`${label} are not sorted by ID`, values[index - 1].id, values[index].id)
    }
  }
}

function validateAliasGraph(edges: Array<{ declarationId: string; renderedId: string }>): void {
  const nextByDeclaration = new Map<string, string>()
  for (const edge of edges) {
    if (nextByDeclaration.has(edge.declarationId)) {
      invalidContributionInventory('duplicate alias declaration', edge.declarationId)
    }
    if (edge.declarationId === edge.renderedId) {
      invalidContributionInventory('self-alias cycle', edge.declarationId)
    }
    nextByDeclaration.set(edge.declarationId, edge.renderedId)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      invalidContributionInventory('cyclic alias mapping', ...path, id)
    }
    if (visited.has(id)) return
    visiting.add(id)
    const next = nextByDeclaration.get(id)
    if (next !== undefined && nextByDeclaration.has(next)) visit(next, [...path, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const edge of edges) visit(edge.declarationId, [])

  for (const edge of edges) {
    if (nextByDeclaration.has(edge.renderedId)) {
      invalidContributionInventory('alias chain maps through another declaration', edge.declarationId, edge.renderedId)
    }
  }
}

export function validateContributionInventory(
  inventory: unknown,
  targets: readonly CaptureTarget[]
): asserts inventory is ContributionInventory {
  if (!isRecord(inventory) || !exactKeys(inventory, ['declaredTargets', 'toolAliases'])) {
    invalidContributionInventory('metadata must contain only declaredTargets and toolAliases')
  }
  if (!Array.isArray(inventory.declaredTargets) || !Array.isArray(inventory.toolAliases) || !Array.isArray(targets)) {
    invalidContributionInventory('declarations, aliases and projected targets must be arrays')
  }

  const declaredTargets = inventory.declaredTargets.map((target, index) =>
    assertCaptureTarget(target, `declared target ${index}`))
  const projectedTargets = targets.map((target, index) =>
    assertCaptureTarget(target, `projected target ${index}`))
  assertSortedById(declaredTargets, 'declared targets')

  const declarationsById = new Map<string, CaptureTarget>()
  for (const declaration of declaredTargets) {
    if (declarationsById.has(declaration.id)) {
      invalidContributionInventory('duplicate declared target ID', declaration.id)
    }
    declarationsById.set(declaration.id, declaration)
  }
  const projectedById = new Map<string, CaptureTarget>()
  for (const target of projectedTargets) {
    if (projectedById.has(target.id)) {
      invalidContributionInventory('duplicate projected target ID', target.id)
    }
    projectedById.set(target.id, target)
    const declaration = declarationsById.get(target.id)
    if (!declaration) invalidContributionInventory('projected target is not declared', target.id)
    if (!sameTarget(target, declaration)) {
      invalidContributionInventory('projected target disagrees with its declaration', target.id)
    }
  }

  const edges: Array<{ declarationId: string; renderedId: string }> = []
  for (let index = 0; index < inventory.toolAliases.length; index++) {
    const value: unknown = inventory.toolAliases[index]
    if (!isRecord(value) || !exactKeys(value, ['declaration', 'toolId', 'renderedTarget', 'reason']) ||
      typeof value.toolId !== 'string' || value.toolId.length === 0 ||
      value.reason !== 'tool-navigation-alias' ||
      !isRecord(value.declaration) || typeof value.declaration.id !== 'string' ||
      !isRecord(value.renderedTarget) || typeof value.renderedTarget.id !== 'string') {
      invalidContributionInventory(`malformed tool alias ${index}`)
    }
    edges.push({
      declarationId: value.declaration.id,
      renderedId: value.renderedTarget.id
    })
  }
  validateAliasGraph(edges)

  const aliasesByDeclaration = new Map<string, ToolNavigationAlias>()
  const validatedAliases: ToolNavigationAlias[] = []
  for (let index = 0; index < inventory.toolAliases.length; index++) {
    const value = inventory.toolAliases[index] as Record<string, unknown>
    const declaration = assertCaptureTarget(value.declaration, `alias declaration ${index}`)
    const renderedTarget = assertCaptureTarget(value.renderedTarget, `alias body ${index}`)
    const toolId = value.toolId as string
    if (aliasesByDeclaration.has(declaration.id)) {
      invalidContributionInventory('duplicate tool alias', declaration.id, toolId)
    }
    const declaredDeclaration = declarationsById.get(declaration.id)
    const declaredBody = declarationsById.get(renderedTarget.id)
    const projectedBody = projectedById.get(renderedTarget.id)
    if (!declaredDeclaration || !sameTarget(declaration, declaredDeclaration)) {
      invalidContributionInventory('alias declaration is missing or disagrees with its declaration', declaration.id)
    }
    if (!declaredBody || !projectedBody ||
      !sameTarget(renderedTarget, declaredBody) || !sameTarget(renderedTarget, projectedBody)) {
      invalidContributionInventory('alias body is not a declared projected target', declaration.id, toolId, renderedTarget.id)
    }
    if (declaration.kind !== 'sidebar-section' ||
      (renderedTarget.kind !== 'view' && renderedTarget.kind !== 'panel')) {
      invalidContributionInventory('invalid alias declaration or rendered body kind', declaration.id, toolId, renderedTarget.id)
    }
    if (declaration.id === renderedTarget.id) {
      invalidContributionInventory('self-alias is not a rendered target', declaration.id, toolId)
    }
    const toolOwner = ownerFromId(toolId)
    const toolKind = kindFromId(toolId)
    if (!declaration.plugin || declaration.plugin !== renderedTarget.plugin ||
      declaration.plugin !== toolOwner ||
      (toolKind !== 'panel' && toolKind !== 'sidebar-section')) {
      invalidContributionInventory('alias ownership does not match its tool and rendered body', declaration.id, toolId, renderedTarget.id)
    }
    const alias: ToolNavigationAlias = {
      declaration,
      toolId,
      renderedTarget,
      reason: 'tool-navigation-alias'
    }
    aliasesByDeclaration.set(declaration.id, alias)
    validatedAliases.push(alias)
  }
  assertSortedById(validatedAliases.map(({ declaration }) => declaration), 'tool aliases')

  for (const declaration of declaredTargets) {
    const isAlias = aliasesByDeclaration.has(declaration.id)
    const isProjectedTarget = projectedById.has(declaration.id)
    if (isAlias === isProjectedTarget) {
      invalidContributionInventory(
        isAlias ? 'alias declaration is also a projected target' : 'declaration is missing from the target partition',
        declaration.id
      )
    }
  }
  for (const alias of validatedAliases) {
    if (aliasesByDeclaration.has(alias.renderedTarget.id)) {
      invalidContributionInventory('rendered body cannot be another alias declaration', alias.declaration.id, alias.toolId, alias.renderedTarget.id)
    }
  }
}

export function projectCaptureInventory(model: UiModel): {
  targets: CaptureTarget[]
  contributionInventory: ContributionInventory
} {
  const declaredTargets = discoverCaptureTargets(model)
  const targetsById = new Map(declaredTargets.map((target) => [target.id, target]))
  const slotEntries = [
    ...model.views,
    ...model.panels,
    ...model.sidebarSections,
    ...model.activityItems,
    ...model.statusBars,
    ...model.overlays,
    ...model.settingsSections
  ]
  const slotsById = new Map(slotEntries.map((entry) => [entry.id, entry]))
  const tools: ToolProjectionEntry[] = []

  if (model.tools !== undefined) {
    if (!Array.isArray(model.tools)) invalidToolProjection('tools must be an array', 'tools')
    const toolIds = new Set<string>()
    for (const value of model.tools as unknown[]) {
      if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 ||
        (value.contributionId !== null && typeof value.contributionId !== 'string') ||
        !Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === 'string')) {
        invalidToolProjection('malformed tool entry', isRecord(value) && typeof value.id === 'string' ? value.id : 'tools')
      }
      if (toolIds.has(value.id)) invalidToolProjection('duplicate tool ID', value.id)
      toolIds.add(value.id)
      if (new Set(value.aliases).size !== value.aliases.length) {
        invalidToolProjection('duplicate tool alias ID', value.id)
      }
      tools.push({
        id: value.id,
        contributionId: value.contributionId as string | null,
        aliases: value.aliases as string[]
      })
    }
  }

  const toolAliases: ToolNavigationAlias[] = []
  for (const declaration of declaredTargets) {
    if (declaration.kind !== 'sidebar-section') continue
    const hostingTools = tools.filter((tool) =>
      tool.id === declaration.id || tool.aliases.includes(declaration.id))
    if (hostingTools.length > 1) {
      invalidToolProjection(
        'sidebar declaration has multiple hosting tools',
        declaration.id,
        ...hostingTools.map(({ id }) => id)
      )
    }
    const tool = hostingTools[0]
    if (!tool) continue
    const bodyId = tool.contributionId
    if (bodyId === null) {
      invalidToolProjection('hosting tool has a null body or is Inbox', declaration.id, tool.id)
    }
    const renderedTarget = targetsById.get(bodyId)
    const bodyEntry = slotsById.get(bodyId)
    if (!renderedTarget || !bodyEntry) {
      invalidToolProjection('hosting tool body is undeclared', declaration.id, tool.id, bodyId)
    }
    if (typeof bodyEntry.module !== 'string' || bodyEntry.module.length === 0) {
      invalidToolProjection('hosting tool body has no UI module', declaration.id, tool.id, bodyId)
    }
    const declarationEntry = slotsById.get(declaration.id)
    if (!declarationEntry || typeof declarationEntry.module !== 'string' || declarationEntry.module.length === 0) {
      invalidToolProjection('sidebar declaration has no UI module', declaration.id, tool.id, bodyId)
    }
    const toolOwner = ownerFromId(tool.id)
    if (!declaration.plugin || renderedTarget.plugin !== declaration.plugin || toolOwner !== declaration.plugin) {
      invalidToolProjection('tool body and sidebar have different logical owners', declaration.id, tool.id, bodyId)
    }
    if (renderedTarget.id === declaration.id) continue
    if (renderedTarget.kind !== 'view' && renderedTarget.kind !== 'panel') {
      invalidToolProjection('aliased sidebar body must be a view or panel', declaration.id, tool.id, bodyId)
    }
    toolAliases.push({
      declaration,
      toolId: tool.id,
      renderedTarget,
      reason: 'tool-navigation-alias'
    })
  }

  const aliasIds = new Set(toolAliases.map(({ declaration }) => declaration.id))
  const targets = declaredTargets.filter(({ id }) => !aliasIds.has(id))
  const contributionInventory: ContributionInventory = {
    declaredTargets: [...declaredTargets].sort(compareId),
    toolAliases: toolAliases.sort((left, right) => compareId(left.declaration, right.declaration))
  }
  validateContributionInventory(contributionInventory, targets)
  return { targets, contributionInventory }
}

function projectedTargetsFromInventory(inventory: unknown): CaptureTarget[] {
  if (!isRecord(inventory) || !Array.isArray(inventory.declaredTargets) || !Array.isArray(inventory.toolAliases)) {
    invalidContributionInventory('cannot scope malformed contribution inventory')
  }
  const aliasIds = new Set<string>()
  for (const value of inventory.toolAliases) {
    if (isRecord(value) && isRecord(value.declaration) && typeof value.declaration.id === 'string') {
      aliasIds.add(value.declaration.id)
    }
  }
  return inventory.declaredTargets.filter((target): target is CaptureTarget =>
    isRecord(target) && typeof target.id === 'string' && !aliasIds.has(target.id))
}

export function scopeCaptureInventory(
  inventory: ContributionInventory,
  selectedTargets: readonly CaptureTarget[]
): ContributionInventory {
  const projectedTargets = projectedTargetsFromInventory(inventory)
  validateContributionInventory(inventory, projectedTargets)
  if (!Array.isArray(selectedTargets)) invalidContributionInventory('selected targets must be an array')

  const allTargets = new Map(projectedTargets.map((target) => [target.id, target]))
  const selectedIds = new Set<string>()
  for (const selected of selectedTargets) {
    const target = assertCaptureTarget(selected, 'selected target')
    if (selectedIds.has(target.id)) invalidContributionInventory('duplicate selected target', target.id)
    selectedIds.add(target.id)
    const known = allTargets.get(target.id)
    if (!known) invalidContributionInventory('selected ID is not a projected target', target.id)
    if (!sameTarget(target, known)) invalidContributionInventory('selected target disagrees with inventory', target.id)
  }

  const aliases = inventory.toolAliases.filter(({ renderedTarget }) => selectedIds.has(renderedTarget.id))
  const includedIds = new Set(selectedIds)
  for (const alias of aliases) includedIds.add(alias.declaration.id)
  return {
    declaredTargets: inventory.declaredTargets
      .filter(({ id }) => includedIds.has(id))
      .sort(compareId),
    toolAliases: [...aliases].sort((left, right) => compareId(left.declaration, right.declaration))
  }
}

function visibilitySettingIds(model: unknown): string[] {
  if (!isRecord(model)) {
    throw new Error('invalid-visibility-setting: missing contribution model for visibility settings')
  }
  const value = model.visibilitySettings
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('invalid-visibility-setting: malformed visibilitySettings inventory')
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) {
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    throw new Error(`invalid-visibility-setting: duplicate visibility setting ${duplicate ?? '<unknown>'}`)
  }
  return [...ids].sort()
}

function validateVisibilityDeclarations(model: unknown, ids: string[]): void {
  if (!isRecord(model) || !Array.isArray(model.settings)) {
    throw new Error(`invalid-visibility-setting: missing setting declarations ${ids[0] ?? '<visibilitySettings>'}`)
  }
  for (const id of ids) {
    const matches = model.settings.filter((setting) => isRecord(setting) && setting.id === id)
    if (matches.length === 0) {
      throw new Error(`invalid-visibility-setting: missing setting declaration ${id}`)
    }
    if (matches.length > 1) {
      throw new Error(`invalid-visibility-setting: duplicate setting declaration ${id}`)
    }
    if (!isRecord(matches[0]) || matches[0].type !== 'boolean') {
      throw new Error(`invalid-visibility-setting: non-boolean setting ${id}`)
    }
  }
}

export async function enableCaptureVisibilitySettings(
  initialModel: UiModel,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<{ model: UiModel; activatedVisibilitySettings: string[] }> {
  const settingIds = visibilitySettingIds(initialModel)
  validateVisibilityDeclarations(initialModel, settingIds)
  if (settingIds.length === 0) return { model: initialModel, activatedVisibilitySettings: [] }

  for (const id of settingIds) {
    let result: unknown
    try {
      result = await call('setting.set', { id, value: true })
    } catch {
      throw new Error(`invalid-visibility-setting: setting write failed ${id}`)
    }
    if (!isRecord(result) || result.id !== id || result.type !== 'boolean') {
      throw new Error(`invalid-visibility-setting: setting write returned malformed result ${id}`)
    }
    if (result.value !== true) {
      throw new Error(`invalid-visibility-setting: effective value was not true for ${id}`)
    }
  }

  let refreshedValue: unknown
  try {
    refreshedValue = await call('ui.contributions', {})
  } catch {
    throw new Error(`invalid-visibility-setting: contribution refetch failed after setting ${settingIds[0]}`)
  }
  const refreshedIds = visibilitySettingIds(refreshedValue)
  const changedIds = [...new Set([...settingIds, ...refreshedIds])]
    .filter((id) => settingIds.includes(id) !== refreshedIds.includes(id))
    .sort()
  if (changedIds.length > 0) {
    throw new Error(`invalid-visibility-setting: changed visibility setting inventory after refresh ${changedIds[0]}`)
  }
  validateVisibilityDeclarations(refreshedValue, refreshedIds)
  return {
    model: refreshedValue as UiModel,
    activatedVisibilitySettings: settingIds
  }
}
