import {
  CODE_BACKED_KINDS,
  DEFAULT_THEME,
  RESERVED_CHORDS,
  parseChord,
  parseContributionId,
  type ContributionInfo,
  type PluginDiagnostic,
  type PluginInfo,
  type SettingDeclaration,
  type ThemeInfo,
  type UiCommandEntry,
  type UiKeybinding,
  type UiModel,
  type UiSettingEntry,
  type UiSlotEntry,
} from '@quirky/protocol'

const DEFAULT_ORDER = 100

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isCodeBacked(kind: string): boolean {
  return (CODE_BACKED_KINDS as readonly string[]).includes(kind)
}

function moduleUrl(pluginId: string, ui: string): string {
  const segments = ui
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map(encodeURIComponent)
  return `/plugins/${encodeURIComponent(pluginId)}/${segments.join('/')}`
}

function stringField(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field]
  return typeof value === 'string' ? value : undefined
}

function addWarning(warnings: Map<string, PluginDiagnostic[]>, pluginId: string, message: string): void {
  const list = warnings.get(pluginId) ?? []
  list.push({ level: 'warning', message })
  warnings.set(pluginId, list)
}

/** The usable entry for each plugin ID; an invalid duplicate never hides a valid one. */
function pluginsById(plugins: PluginInfo[]): Map<string, PluginInfo> {
  const byId = new Map<string, PluginInfo>()
  for (const plugin of plugins) {
    const known = byId.get(plugin.id)
    if (!known || (known.state === 'invalid' && plugin.state !== 'invalid')) byId.set(plugin.id, plugin)
  }
  return byId
}

function dependencyClosure(byId: Map<string, PluginInfo>): (id: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>()
  const closure = (id: string): Set<string> => {
    const known = memo.get(id)
    if (known) return known
    const result = new Set<string>()
    memo.set(id, result)
    for (const dep of byId.get(id)?.dependencies ?? []) {
      result.add(dep)
      for (const inherited of closure(dep)) result.add(inherited)
    }
    return result
  }
  return closure
}

type Binding = { declaration: ContributionInfo; chord: string; command: string }

function resolveKeybindings(
  effective: ContributionInfo[],
  effectiveCommands: Set<string>,
  byId: Map<string, PluginInfo>,
  warnings: Map<string, PluginDiagnostic[]>
): UiKeybinding[] {
  const dependsOn = dependencyClosure(byId)
  const sourceOf = (declaration: ContributionInfo) => byId.get(declaration.plugin)?.source
  const beats = (a: ContributionInfo, b: ContributionInfo): boolean => {
    if (a.plugin === b.plugin) return false
    return sourceOf(a) === sourceOf(b) ? dependsOn(a.plugin).has(b.plugin) : sourceOf(a) === 'installed'
  }

  const result: UiKeybinding[] = []
  const byChord = new Map<string, Binding[]>()
  for (const declaration of effective) {
    const parsed = parseChord(stringField(declaration.data, 'key') ?? '')
    if (!parsed.ok) continue
    const written = stringField(declaration.data, 'command') ?? ''
    const command = parseContributionId(written) ? written : `command:${declaration.plugin}/${written}`
    const base = { id: declaration.id, plugin: declaration.plugin, key: parsed.chord, command }
    if (!effectiveCommands.has(command)) {
      result.push({ ...base, status: 'unbound' })
      continue
    }
    byChord.set(parsed.chord, [...(byChord.get(parsed.chord) ?? []), { declaration, chord: parsed.chord, command }])
  }

  for (const [chord, bindings] of byChord) {
    const reserved = RESERVED_CHORDS.includes(chord)
    const maxima = bindings.filter(
      (candidate) => !bindings.some((other) => other !== candidate && beats(other.declaration, candidate.declaration))
    )
    const winner = (maxima.length > 0 ? maxima : bindings).reduce((best, candidate) => {
      const byOwner = compare(candidate.declaration.plugin, best.declaration.plugin)
      return (byOwner !== 0 ? byOwner : compare(candidate.declaration.id, best.declaration.id)) < 0 ? candidate : best
    })
    for (const binding of bindings) {
      const { declaration } = binding
      const base = { id: declaration.id, plugin: declaration.plugin, key: chord, command: binding.command }
      if (reserved) {
        result.push({ ...base, status: 'shadowed', shadowedBy: 'kernel' })
        addWarning(warnings, declaration.plugin, `${declaration.id} is shadowed by the window's own shortcut ${chord}`)
      } else if (binding === winner) {
        result.push({ ...base, status: 'active' })
      } else {
        result.push({ ...base, status: 'shadowed', shadowedBy: winner.declaration.id })
        addWarning(
          warnings,
          declaration.plugin,
          `${declaration.id} is shadowed by ${winner.declaration.id} on ${chord}`
        )
      }
    }
  }
  return result.sort((a, b) => compare(a.id, b.id))
}

function buildThemes(effective: ContributionInfo[]): ThemeInfo[] {
  const declared = effective.map((declaration): ThemeInfo => {
    const { data } = declaration
    return {
      id: declaration.id,
      plugin: declaration.plugin,
      title: stringField(data, 'title') ?? declaration.name,
      appearance: data.appearance === 'light' ? 'light' : 'dark',
      colors: { ...DEFAULT_THEME.colors, ...((data.colors as Partial<ThemeInfo['colors']> | undefined) ?? {}) },
    }
  })
  declared.sort((a, b) => a.title.localeCompare(b.title) || compare(a.id, b.id))
  return [DEFAULT_THEME, ...declared]
}

/**
 * Turns every contribution declaration and the plugin list into the UI model the window renders,
 * plus the derived warnings keyed by the plugin that owns the offending entry. Pure: it reads
 * only its input, so the same declarations always give the same model.
 */
export function buildUiModel(input: {
  declarations: ContributionInfo[]
  plugins: PluginInfo[]
  chosenTheme: string
}): { model: UiModel; warnings: Map<string, PluginDiagnostic[]> } {
  const { declarations, chosenTheme } = input
  const byId = pluginsById(input.plugins)
  const warnings = new Map<string, PluginDiagnostic[]>()
  const effective = declarations.filter((declaration) => declaration.status === 'effective')
  const ofKind = (kind: string) => effective.filter((declaration) => declaration.kind === kind)

  const provides = new Map<string, Set<string>>()
  for (const declaration of declarations) {
    if (!isCodeBacked(declaration.kind)) continue
    provides.set(declaration.plugin, (provides.get(declaration.plugin) ?? new Set()).add(declaration.id))
  }
  const codeBackedOwners = new Set(effective.filter((d) => isCodeBacked(d.kind)).map((d) => d.plugin))

  const modules: UiModel['modules'] = {}
  for (const pluginId of [...codeBackedOwners].sort(compare)) {
    const ui = byId.get(pluginId)?.ui
    if (ui === undefined) {
      addWarning(warnings, pluginId, 'declares commands, views, panels or sidebar sections but has no ui module')
      continue
    }
    modules[pluginId] = { url: moduleUrl(pluginId, ui), provides: [...(provides.get(pluginId) ?? [])].sort(compare) }
  }
  const moduleOf = (pluginId: string): string | null => modules[pluginId]?.url ?? null

  const slot = (kind: UiSlotEntry['kind']): UiSlotEntry[] =>
    ofKind(kind).map((declaration) => ({
      id: declaration.id,
      kind,
      plugin: declaration.plugin,
      title: stringField(declaration.data, 'title') ?? declaration.name,
      order: typeof declaration.data.order === 'number' ? declaration.data.order : DEFAULT_ORDER,
      module: moduleOf(declaration.plugin),
    }))
  const byOrder = (a: UiSlotEntry, b: UiSlotEntry) => a.order - b.order || compare(a.id, b.id)

  const commands: UiCommandEntry[] = ofKind('command').map((declaration) => {
    const description = stringField(declaration.data, 'description')
    return {
      id: declaration.id,
      plugin: declaration.plugin,
      title: stringField(declaration.data, 'title') ?? declaration.name,
      ...(description !== undefined ? { description } : {}),
      module: moduleOf(declaration.plugin),
    }
  })
  commands.sort((a, b) => a.title.localeCompare(b.title) || compare(a.id, b.id))

  const settings: UiSettingEntry[] = ofKind('setting').map((declaration) => ({
    id: declaration.id,
    plugin: declaration.plugin,
    ...(declaration.data as SettingDeclaration),
  }))
  settings.sort((a, b) => compare(a.id, b.id))

  const effectiveCommands = new Set(ofKind('command').map((declaration) => declaration.id))
  const keybindings = resolveKeybindings(ofKind('keybinding'), effectiveCommands, byId, warnings)

  const themes = buildThemes(ofKind('theme'))
  const active = themes.some((theme) => theme.id === chosenTheme) ? chosenTheme : DEFAULT_THEME.id

  const model: UiModel = {
    sidebarSections: slot('sidebar-section').sort(byOrder),
    panels: slot('panel').sort(byOrder),
    views: slot('view').sort((a, b) => compare(a.id, b.id)),
    commands,
    keybindings,
    settings,
    themes,
    theme: { chosen: chosenTheme, active },
    modules,
  }
  return { model, warnings }
}
