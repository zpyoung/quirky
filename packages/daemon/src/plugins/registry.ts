import {
  formatContributionId,
  parseContributionId,
  type ContributionInfo,
  type PluginDiagnostic,
} from '@quirky/protocol'
import type { DiscoveredPlugin } from './discover'

/** A discovered plugin with its computed status and the diagnostics that explain it. */
export type RegistryPlugin = {
  discovered: DiscoveredPlugin
  status: 'enabled' | 'disabled' | 'invalid'
  /** Load errors, cascade reasons, then override conflicts and warnings. */
  diagnostics: PluginDiagnostic[]
  /** Why a `disabled` plugin is off. */
  disabledReason?: 'user' | 'distro' | 'dependency'
}

export type Registry = {
  /** Every discovered entry, sorted by ID with built-in before installed. */
  entries: RegistryPlugin[]
  /** By plugin ID: the usable entry only, never an invalid duplicate. */
  plugins: Map<string, RegistryPlugin>
  /** Every declaration from non-invalid plugins, sorted by ID then plugin. */
  declarations: ContributionInfo[]
  /** Contribution ID to the declaration in effect. */
  effective: Map<string, ContributionInfo>
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareEntries(a: DiscoveredPlugin, b: DiscoveredPlugin): number {
  if (a.id !== b.id) return compare(a.id, b.id)
  if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
  return compare(a.dir, b.dir)
}

function dependenciesOf(plugin: RegistryPlugin): string[] {
  return plugin.discovered.manifest?.dependencies ?? []
}

function addError(plugin: RegistryPlugin, message: string): void {
  plugin.diagnostics.push({ level: 'error', message })
}

function markInvalid(plugins: Map<string, RegistryPlugin>): void {
  const dependencyProblems = (plugin: RegistryPlugin): string[] =>
    dependenciesOf(plugin).flatMap((dep) => {
      const target = plugins.get(dep)
      if (!target) return [`dependency ${dep} is not installed`]
      return target.status === 'invalid' ? [`dependency ${dep} is invalid`] : []
    })

  for (;;) {
    const failing = [...plugins.values()]
      .filter((plugin) => plugin.status !== 'invalid')
      .map((plugin) => ({ plugin, problems: dependencyProblems(plugin) }))
      .filter(({ problems }) => problems.length > 0)
    if (failing.length > 0) {
      for (const { plugin, problems } of failing) {
        plugin.status = 'invalid'
        for (const problem of problems) addError(plugin, problem)
      }
      continue
    }
    const cycles = findCycles(plugins)
    if (cycles.length === 0) return
    for (const members of cycles) {
      const message = `dependency cycle: ${members.map((m) => m.discovered.id).join(', ')}`
      for (const plugin of members) {
        plugin.status = 'invalid'
        addError(plugin, message)
      }
    }
  }
}

/** Strongly connected components of size above one (or a self-loop) among the still-valid plugins. */
function findCycles(plugins: Map<string, RegistryPlugin>): RegistryPlugin[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: RegistryPlugin[][] = []
  let counter = 0

  const visit = (id: string) => {
    index.set(id, counter)
    low.set(id, counter)
    counter += 1
    stack.push(id)
    onStack.add(id)
    const plugin = plugins.get(id)!
    for (const dep of dependenciesOf(plugin)) {
      const target = plugins.get(dep)
      if (!target || target.status === 'invalid') continue
      if (!index.has(dep)) {
        visit(dep)
        low.set(id, Math.min(low.get(id)!, low.get(dep)!))
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id)!, index.get(dep)!))
      }
    }
    if (low.get(id) !== index.get(id)) return
    const members: RegistryPlugin[] = []
    for (;;) {
      const member = stack.pop()!
      onStack.delete(member)
      members.push(plugins.get(member)!)
      if (member === id) break
    }
    const selfLoop = members.length === 1 && dependenciesOf(members[0]).includes(id)
    if (members.length > 1 || selfLoop) {
      cycles.push(members.sort((a, b) => compare(a.discovered.id, b.discovered.id)))
    }
  }

  for (const [id, plugin] of [...plugins].sort(([a], [b]) => compare(a, b))) {
    if (plugin.status !== 'invalid' && !index.has(id)) visit(id)
  }
  return cycles
}

function markDisabled(
  plugins: Map<string, RegistryPlugin>,
  disabled: ReadonlySet<string>,
  distroDisabled: ReadonlySet<string>
): void {
  for (const plugin of plugins.values()) {
    if (plugin.status !== 'enabled') continue
    if (disabled.has(plugin.discovered.id)) {
      plugin.status = 'disabled'
      plugin.disabledReason = 'user'
      addError(plugin, 'disabled by the user')
    } else if (distroDisabled.has(plugin.discovered.id)) {
      plugin.status = 'disabled'
      plugin.disabledReason = 'distro'
      addError(plugin, 'disabled by the distro')
    }
  }
  for (;;) {
    const cascading = [...plugins.values()]
      .filter((plugin) => plugin.status === 'enabled')
      .map((plugin) => ({
        plugin,
        reasons: dependenciesOf(plugin).filter((dep) => plugins.get(dep)?.status === 'disabled'),
      }))
      .filter(({ reasons }) => reasons.length > 0)
    if (cascading.length === 0) return
    for (const { plugin, reasons } of cascading) {
      plugin.status = 'disabled'
      plugin.disabledReason = 'dependency'
      for (const dep of reasons) addError(plugin, `dependency ${dep} is disabled`)
    }
  }
}

function collectDeclarations(plugins: RegistryPlugin[]): ContributionInfo[] {
  const declarations: ContributionInfo[] = []
  for (const { discovered } of plugins) {
    const manifest = discovered.manifest!
    for (const [kind, entries] of Object.entries(manifest.contributes ?? {})) {
      for (const { id: name, ...data } of entries) {
        declarations.push({
          id: formatContributionId(kind, discovered.id, name),
          kind,
          name,
          plugin: discovered.id,
          override: false,
          status: 'effective',
          data,
        })
      }
    }
    for (const { id, ...data } of manifest.overrides ?? []) {
      const parsed = parseContributionId(id)!
      declarations.push({ id, kind: parsed.kind, name: parsed.name, plugin: discovered.id, override: true, status: 'effective', data })
    }
  }
  return declarations.sort((a, b) => compare(a.id, b.id) || compare(a.plugin, b.plugin))
}

function applyDisabledIds(
  declarations: ContributionInfo[],
  plugins: Map<string, RegistryPlugin>,
  disabled: ReadonlySet<string>,
  distroDisabled: ReadonlySet<string>,
): ContributionInfo[] {
  const disabledByPlugin = new Map<string, string>()
  for (const plugin of [...plugins.values()].sort((a, b) => compare(a.discovered.id, b.discovered.id))) {
    if (plugin.status !== 'enabled') continue
    for (const id of plugin.discovered.manifest?.disables ?? []) {
      if (!disabledByPlugin.has(id)) disabledByPlugin.set(id, plugin.discovered.id)
    }
  }
  const remaining: ContributionInfo[] = []
  for (const declaration of declarations) {
    const disablingPlugin = disabledByPlugin.get(declaration.id)
    if (plugins.get(declaration.plugin)?.status === 'disabled') {
      declaration.status = 'disabled'
      declaration.disabledBy = 'owner'
    } else if (disabled.has(declaration.id)) {
      declaration.status = 'disabled'
      declaration.disabledBy = 'user'
    } else if (distroDisabled.has(declaration.id)) {
      declaration.status = 'disabled'
      declaration.disabledBy = 'distro'
    } else if (disablingPlugin !== undefined) {
      declaration.status = 'disabled'
      declaration.disabledBy = 'plugin'
      declaration.disablingPlugin = disablingPlugin
    } else {
      remaining.push(declaration)
    }
  }
  return remaining
}

function transitiveDependencies(plugins: Map<string, RegistryPlugin>): (id: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>()
  const closure = (id: string): Set<string> => {
    const known = memo.get(id)
    if (known) return known
    const result = new Set<string>()
    memo.set(id, result)
    const plugin = plugins.get(id)
    for (const dep of plugin ? dependenciesOf(plugin) : []) {
      result.add(dep)
      for (const inherited of closure(dep)) result.add(inherited)
    }
    return result
  }
  return closure
}

/**
 * Computes which plugins are usable and which declaration is in effect for every contribution ID.
 * Pure and deterministic: no filesystem, store or clock, and the result doesn't depend on the
 * order of `discovered`. Nothing here loads plugin code. `distroDisabled` IDs switch plugins and
 * contributions off like `disabled` ones do, but are marked as the distro's; the user's mark wins
 * when both name the same ID.
 */
export function computeRegistry(
  discovered: DiscoveredPlugin[],
  disabled: ReadonlySet<string>,
  distroDisabled: readonly string[] = [],
): Registry {
  const distroSet = new Set(distroDisabled)
  const entries: RegistryPlugin[] = [...discovered].sort(compareEntries).map((plugin) => ({
    discovered: plugin,
    status: plugin.errors.length > 0 ? ('invalid' as const) : ('enabled' as const),
    diagnostics: plugin.errors.map((message) => ({ level: 'error' as const, message })),
  }))

  const plugins = new Map<string, RegistryPlugin>()
  for (const entry of entries) {
    if (!plugins.has(entry.discovered.id)) plugins.set(entry.discovered.id, entry)
    else if (entry.status !== 'invalid') {
      entry.status = 'invalid'
      addError(entry, `duplicates the plugin ${entry.discovered.id}`)
    }
  }

  markInvalid(plugins)
  markDisabled(plugins, disabled, distroSet)

  const declarations = collectDeclarations([...plugins.values()].filter((plugin) => plugin.status !== 'invalid'))
  const contenders = applyDisabledIds(declarations, plugins, disabled, distroSet)

  const dependsOn = transitiveDependencies(plugins)
  const effective = new Map<string, ContributionInfo>()
  const byId = new Map<string, ContributionInfo[]>()
  for (const declaration of contenders) {
    byId.set(declaration.id, [...(byId.get(declaration.id) ?? []), declaration])
  }

  const sourceOf = (declaration: ContributionInfo) => plugins.get(declaration.plugin)!.discovered.source
  const beats = (a: ContributionInfo, b: ContributionInfo) =>
    sourceOf(a) === sourceOf(b) ? dependsOn(a.plugin).has(b.plugin) : sourceOf(a) === 'installed'

  for (const [id, group] of byId) {
    const overrides = group.filter((declaration) => declaration.override)
    if (overrides.length === 0) {
      effective.set(id, group[0])
      continue
    }
    const maxima = overrides.filter((candidate) => !overrides.some((other) => other !== candidate && beats(other, candidate)))
    const winner = maxima.reduce((best, candidate) => (compare(candidate.plugin, best.plugin) < 0 ? candidate : best))
    for (const declaration of group) {
      if (declaration === winner) continue
      if (maxima.includes(declaration)) {
        declaration.status = 'rejected'
        declaration.conflictWith = winner.plugin
        plugins.get(declaration.plugin)!.diagnostics.push({
          level: 'warning',
          message: `override of ${id} conflicts with ${winner.plugin}`,
        })
      } else {
        declaration.status = 'overridden'
        declaration.overriddenBy = winner.plugin
      }
    }
    effective.set(id, winner)

    const hasBase = declarations.some((declaration) => declaration.id === id && !declaration.override)
    const namespace = plugins.get(parseContributionId(id)!.namespace)
    if (!hasBase && (!namespace || namespace.status === 'enabled')) {
      plugins.get(winner.plugin)!.diagnostics.push({ level: 'warning', message: `override of ${id} replaces nothing` })
    }
  }

  return { entries, plugins, declarations, effective }
}
