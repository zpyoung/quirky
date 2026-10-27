import {
  CODE_BACKED_KINDS,
  DEFAULT_THEME,
  RESERVED_CHORDS,
  parseChord,
  parseContributionId,
  parseWhen,
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

/** The module URL for a plugin's ui path, or null when the path cannot be encoded (never throws). */
function moduleUrl(pluginId: string, ui: string): string | null {
  try {
    return encodeModuleUrl(pluginId, ui)
  } catch {
    return null
  }
}

function encodeModuleUrl(pluginId: string, ui: string): string {
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

type Binding = { declaration: ContributionInfo; chord: string; when: string; command: string }

export type DistroKeybinding = { key: string; command: string }

/** Distro bindings by canonical chord, with their `keybinding:<distro>/k<n>` IDs; unparseable chords are dropped. */
function distroBindings(
  distroKeybindings: DistroKeybinding[],
  distroId: string
): { id: string; chord: string; command: string }[] {
  return distroKeybindings.flatMap((binding, index) => {
    const parsed = parseChord(binding.key)
    return parsed.ok ? [{ id: `keybinding:${distroId}/k${index + 1}`, chord: parsed.chord, command: binding.command }] : []
  })
}

/**
 * Plugin IDs from highest to lowest precedence: each step takes, among the plugins no remaining
 * plugin beats, the one whose ID sorts first. A plugin that beats another is always ahead of it.
 */
function precedenceOrder(owners: string[], beats: (a: string, b: string) => boolean): Map<string, number> {
  const remaining = [...new Set(owners)].sort(compare)
  const rank = new Map<string, number>()
  while (remaining.length > 0) {
    const index = remaining.findIndex((candidate) => !remaining.some((other) => other !== candidate && beats(other, candidate)))
    const [next] = remaining.splice(index === -1 ? 0 : index, 1)
    rank.set(next, rank.size)
  }
  return rank
}

/**
 * Resolves each chord and `when` condition on its own: within one group a single binding is
 * `active`, the rest `shadowed`; groups with different conditions never shadow each other.
 * A reserved chord shadows every group, and a distro binding (which has no condition) only
 * the unconditional one. The result lists distro bindings first, in manifest order, then the
 * plugins' bindings by `precedenceOrder` of their owner and by ID within an owner.
 */
function resolveKeybindings(
  effective: ContributionInfo[],
  effectiveCommands: Set<string>,
  byId: Map<string, PluginInfo>,
  warnings: Map<string, PluginDiagnostic[]>,
  distro: { id: string; bindings: { id: string; chord: string; command: string }[] }
): UiKeybinding[] {
  const dependsOn = dependencyClosure(byId)
  const sourceOf = (pluginId: string) => byId.get(pluginId)?.source
  const beatsPlugin = (a: string, b: string): boolean => {
    if (a === b) return false
    return sourceOf(a) === sourceOf(b) ? dependsOn(a).has(b) : sourceOf(a) === 'installed'
  }
  const beats = (a: ContributionInfo, b: ContributionInfo): boolean => beatsPlugin(a.plugin, b.plugin)

  const result: UiKeybinding[] = []
  const byGroup = new Map<string, Binding[]>()
  const owners: string[] = []
  for (const declaration of effective) {
    const parsed = parseChord(stringField(declaration.data, 'key') ?? '')
    if (!parsed.ok) continue
    const rawWhen = declaration.data.when
    const parsedWhen = rawWhen === undefined ? null : parseWhen(typeof rawWhen === 'string' ? rawWhen : '')
    if (parsedWhen !== null && !parsedWhen.ok) continue
    const when = parsedWhen?.canonical ?? ''
    const written = stringField(declaration.data, 'command') ?? ''
    const command = parseContributionId(written) ? written : `command:${declaration.plugin}/${written}`
    const base = {
      id: declaration.id,
      plugin: declaration.plugin,
      key: parsed.chord,
      command,
      ...(when !== '' ? { when } : {}),
    }
    owners.push(declaration.plugin)
    if (!effectiveCommands.has(command)) {
      result.push({ ...base, status: 'unbound' })
      continue
    }
    const group = `${parsed.chord}\0${when}`
    byGroup.set(group, [...(byGroup.get(group) ?? []), { declaration, chord: parsed.chord, when, command }])
  }

  const distroOrder = new Map<string, number>()
  distro.bindings.forEach((binding, index) => distroOrder.set(binding.id, index))
  const distroByChord = new Map<string, { id: string; command: string }>()
  for (const binding of distro.bindings) {
    const base = { id: binding.id, plugin: distro.id, key: binding.chord, command: binding.command }
    if (!effectiveCommands.has(binding.command)) result.push({ ...base, status: 'unbound' })
    else if (RESERVED_CHORDS.includes(binding.chord)) result.push({ ...base, status: 'shadowed', shadowedBy: 'kernel' })
    else distroByChord.set(binding.chord, binding)
  }

  for (const bindings of byGroup.values()) {
    const { chord, when } = bindings[0]
    const reserved = RESERVED_CHORDS.includes(chord)
    const distroBinding = when === '' ? distroByChord.get(chord) : undefined
    const maxima = bindings.filter(
      (candidate) => !bindings.some((other) => other !== candidate && beats(other.declaration, candidate.declaration))
    )
    const winner = (maxima.length > 0 ? maxima : bindings).reduce((best, candidate) => {
      const byOwner = compare(candidate.declaration.plugin, best.declaration.plugin)
      return (byOwner !== 0 ? byOwner : compare(candidate.declaration.id, best.declaration.id)) < 0 ? candidate : best
    })
    for (const binding of bindings) {
      const { declaration } = binding
      const base = {
        id: declaration.id,
        plugin: declaration.plugin,
        key: chord,
        command: binding.command,
        ...(when !== '' ? { when } : {}),
      }
      if (reserved) {
        result.push({ ...base, status: 'shadowed', shadowedBy: 'kernel' })
        addWarning(warnings, declaration.plugin, `${declaration.id} is shadowed by the window's own shortcut ${chord}`)
      } else if (distroBinding) {
        result.push({ ...base, status: 'shadowed', shadowedBy: distroBinding.id })
        addWarning(warnings, declaration.plugin, `${declaration.id} is shadowed by ${distroBinding.id} on ${chord}`)
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
  for (const [chord, binding] of distroByChord) {
    result.push({ id: binding.id, plugin: distro.id, key: chord, command: binding.command, status: 'active' })
  }

  const rank = precedenceOrder(owners, beatsPlugin)
  return result.sort((a, b) => {
    const distroA = distroOrder.get(a.id)
    const distroB = distroOrder.get(b.id)
    if (distroA !== undefined || distroB !== undefined) {
      return distroA === undefined ? 1 : distroB === undefined ? -1 : distroA - distroB
    }
    return (rank.get(a.plugin) ?? 0) - (rank.get(b.plugin) ?? 0) || compare(a.id, b.id)
  })
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
  /** The active distro's bindings in manifest order; they beat every plugin binding on their chord. */
  distroKeybindings?: DistroKeybinding[]
  /** The active distro's ID, which names its bindings. */
  distroId?: string | null
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
      addWarning(warnings, pluginId, 'declares code-backed contributions but has no ui module')
      continue
    }
    const url = moduleUrl(pluginId, ui)
    if (url === null) continue
    modules[pluginId] = { url, provides: [...(provides.get(pluginId) ?? [])].sort(compare) }
  }
  const moduleOf = (pluginId: string): string | null => modules[pluginId]?.url ?? null

  const slot = (kind: UiSlotEntry['kind']): UiSlotEntry[] =>
    ofKind(kind).map((declaration) => ({
      id: declaration.id,
      kind,
      plugin: declaration.plugin,
      title: stringField(declaration.data, 'title') ?? declaration.name,
      ...(kind === 'settings-section' && stringField(declaration.data, 'description') !== undefined
        ? { description: stringField(declaration.data, 'description') }
        : {}),
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
  const keybindings = resolveKeybindings(ofKind('keybinding'), effectiveCommands, byId, warnings, {
    id: input.distroId ?? '',
    bindings: input.distroId ? distroBindings(input.distroKeybindings ?? [], input.distroId) : []
  })

  const themes = buildThemes(ofKind('theme'))
  const active = themes.some((theme) => theme.id === chosenTheme) ? chosenTheme : DEFAULT_THEME.id

  const model: UiModel = {
    sidebarSections: slot('sidebar-section').sort(byOrder),
    statusBars: slot('status-bar').sort(byOrder),
    panels: slot('panel').sort(byOrder),
    settingsSections: slot('settings-section').sort(byOrder),
    views: slot('view').sort((a, b) => compare(a.id, b.id)),
    overlays: slot('overlay').sort(byOrder),
    commands,
    keybindings,
    settings,
    themes,
    theme: { chosen: chosenTheme, active },
    modules,
  }
  return { model, warnings }
}
