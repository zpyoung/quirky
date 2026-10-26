import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  DISTRO_MANIFEST_FILE,
  RESERVED_CHORDS,
  checkSettingValue,
  parseDistroManifest,
  type DistroInfo,
  type DistroInspection,
  type DistroManifest,
  type PluginInspection,
  type QuirkyEvent,
  type SettingDeclaration,
  type UiSettingEntry
} from '@quirky/protocol'
import { conflict, internal, invalidParams, notFound } from '../errors'
import type { Store } from '../store'
import type { PluginHost } from './host'
import { inspectPlugin } from './install'
import { pluginDataDir } from './stores'
import { buildUiModel } from './ui-model'
import { chosenThemeOf, resolveSetting } from './ui-service'

export type DistroServiceOptions = {
  home: string
  store: Pick<Store, 'getDistro' | 'putDistro' | 'deleteDistro' | 'getSettingValue' | 'getUiState'>
  plugins: PluginHost
  log: (message: string) => void
  /** True in safe mode: the stored distro is kept but not applied. */
  safeMode: boolean
  /** Delivers `setting.changed` and `theme.changed` to clients; without it the layer changes silently. */
  broadcast?: (event: QuirkyEvent) => void
  /** Reads a bundled plugin's manifest; replaceable so the distro layer can be exercised on its own. */
  inspectPlugin?: typeof inspectPlugin
}

type Prepared = {
  manifest: DistroManifest
  plugins: { source: string; dir: string; inspection: PluginInspection }[]
  /** Reasons the distro cannot be read or applied (InvalidParams). */
  problems: string[]
  /** Clashes with what is already installed (Conflict). */
  conflicts: string[]
}

const pad = (word: string) => word.padEnd(10)

function pluginLines(inspection: PluginInspection): string[] {
  const { installed } = inspection
  const label = installed ? `${inspection.id} ${installed.version} → ${inspection.version}` : `${inspection.id} ${inspection.version}`
  const lines = [`${label} (${inspection.name})`]
  for (const contribution of inspection.contributions) {
    const key = contribution.kind === 'keybinding' && typeof contribution.data.key === 'string' ? `  ${contribution.data.key}` : ''
    lines.push(`${pad(contribution.kind)} ${contribution.id}${key}`)
  }
  for (const override of inspection.overrides) lines.push(`${pad('override')} ${override.id} (replaces ${override.replaces}'s)`)
  for (const id of inspection.disables) lines.push(`${pad('disables')} ${id}`)
  for (const id of installed?.added ?? []) lines.push(`+ ${id}`)
  for (const id of installed?.removed ?? []) lines.push(`- ${id}`)
  return lines
}

/**
 * The text a person sees before a distro installs: each bundled plugin with its contributions, the
 * IDs it turns off, each setting with its current and new value, the theme, the keybindings, and
 * a warning for every keybinding on a chord the window reserves.
 */
export function renderDistroInspection(inspection: DistroInspection): string {
  const { manifest } = inspection
  const lines = [`distro ${manifest.id} ${manifest.version} (${manifest.name})`]
  for (const plugin of inspection.plugins) lines.push('', ...pluginLines(plugin))
  const layer: string[] = []
  for (const id of manifest.disable ?? []) layer.push(`${pad('disable')} ${id}`)
  for (const { id, current, next } of inspection.settings) {
    layer.push(`${pad('setting')} ${id}  ${JSON.stringify(current)} → ${JSON.stringify(next)}`)
  }
  if (manifest.theme !== undefined) layer.push(`${pad('theme')} ${manifest.theme}`)
  for (const [chord, command] of Object.entries(manifest.keybindings ?? {})) {
    layer.push(`${pad('keybinding')} ${chord}  ${command}`)
  }
  for (const [chord, command] of Object.entries(manifest.keybindings ?? {})) {
    if (RESERVED_CHORDS.includes(chord)) {
      layer.push(`${pad('warning')} ${chord} is a shortcut the window keeps for itself, so ${command} will not run on it`)
    }
  }
  if (layer.length > 0) lines.push('', ...layer)
  return lines.join('\n')
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Paths under `dir` that are symlinks pointing outside `root` (or nowhere). */
function escapingLinks(root: string, dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (lstatSync(path).isSymbolicLink()) {
      let target: string | null = null
      try {
        target = realpathSync(path)
      } catch {
        target = null
      }
      if (target === null || !insideRoot(root, target)) found.push(path)
      continue
    }
    if (lstatSync(path).isDirectory()) found.push(...escapingLinks(root, path))
  }
  return found
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Installs, lists and removes the distro layer and serves it to the host, settings and UI model. */
export class DistroService {
  constructor(private readonly options: DistroServiceOptions) {}

  /** Reads a distro directory and everything installing it would change; installs nothing. */
  async inspect(path: string): Promise<DistroInspection> {
    const prepared = this.prepare(path)
    if (prepared.problems.length > 0) throw invalidParams(prepared.problems.join('; '))
    return this.inspectionOf(prepared)
  }

  /**
   * Installs the distro at `path` as a layer under the user's own choices. Everything is checked
   * first, so a refusal (InvalidParams for a distro that cannot be applied, Conflict for a clash
   * with another distro or an installed plugin) changes nothing.
   */
  async install(path: string): Promise<DistroInfo> {
    const { store, plugins, home, log } = this.options
    const prepared = this.prepare(path)
    if (prepared.problems.length > 0) throw invalidParams(prepared.problems.join('; '))
    if (prepared.conflicts.length > 0) throw conflict(prepared.conflicts.join('; '))

    const earlier = store.getDistro()
    const installedDir = join(home, 'plugins')
    mkdirSync(installedDir, { recursive: true })
    const staged = prepared.plugins.map(({ dir, inspection }) => ({
      id: inspection.id,
      from: dir,
      temp: join(installedDir, `.tmp-${inspection.id}`),
      to: join(installedDir, inspection.id)
    }))
    try {
      for (const { from, temp } of staged) {
        rmSync(temp, { recursive: true, force: true })
        cpSync(from, temp, { recursive: true, dereference: true })
      }
    } catch (error) {
      for (const { temp } of staged) rmSync(temp, { recursive: true, force: true })
      throw internal(`could not copy the distro's plugins: ${messageOf(error)}`)
    }
    for (const { temp, to } of staged) {
      rmSync(to, { recursive: true, force: true })
      renameSync(temp, to)
    }
    const ids = staged.map(({ id }) => id)
    for (const stale of (earlier?.plugins ?? []).filter((id) => !ids.includes(id))) this.deletePlugin(stale)

    const row = { id: prepared.manifest.id, manifest: prepared.manifest, plugins: ids, installedAt: Date.now() }
    store.putDistro(row)
    await plugins.rescan()
    this.announce(prepared.manifest, earlier?.manifest ?? null)
    log(`distro ${row.id} installed with ${ids.length} plugin(s)`)
    return this.infoOf(row)
  }

  list(): DistroInfo[] {
    const row = this.options.store.getDistro()
    return row ? [this.infoOf(row)] : []
  }

  /** Removes the distro, its plugins and their data; NotFound for an ID that is not installed. */
  async remove(id: string): Promise<void> {
    const { store, plugins, log } = this.options
    const row = store.getDistro()
    if (!row || row.id !== id) throw notFound(`no distro ${id}`)
    store.deleteDistro(id)
    for (const pluginId of row.plugins) this.deletePlugin(pluginId)
    await plugins.rescan()
    this.announce(row.manifest, null)
    log(`distro ${id} removed`)
  }

  /** The manifest being applied, or null with no distro installed or in safe mode. */
  active(): DistroManifest | null {
    if (this.options.safeMode) return null
    return this.options.store.getDistro()?.manifest ?? null
  }

  private infoOf(row: { id: string; manifest: DistroManifest; plugins: string[]; installedAt: number }): DistroInfo {
    const { manifest } = row
    return {
      id: row.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      plugins: row.plugins,
      installedAt: row.installedAt
    }
  }

  private deletePlugin(id: string): void {
    rmSync(join(this.options.home, 'plugins', id), { recursive: true, force: true })
    rmSync(pluginDataDir(this.options.home, id), { recursive: true, force: true })
  }

  private prepare(path: string): Prepared {
    const { home, plugins, store } = this.options
    const inspectOne = this.options.inspectPlugin ?? inspectPlugin
    const root = resolve(path)
    const file = join(root, DISTRO_MANIFEST_FILE)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw invalidParams(`no ${DISTRO_MANIFEST_FILE} in ${root}`)
    }
    const parsed = parseDistroManifest(text)
    if (!parsed.ok) throw invalidParams(parsed.errors.map((error) => `${DISTRO_MANIFEST_FILE}: ${error}`).join('; '))
    const { manifest } = parsed

    const earlier = store.getDistro()
    if (earlier && earlier.id !== manifest.id) {
      throw conflict(`distro ${earlier.id} is installed; remove it before installing ${manifest.id}`)
    }
    const owned = new Set(earlier?.plugins ?? [])

    const problems: string[] = []
    const conflicts: string[] = []
    const found: Prepared['plugins'] = []
    const realRoot = realpathSync(root)
    for (const source of manifest.plugins ?? []) {
      const dir = resolve(root, source)
      try {
        if (!insideRoot(realRoot, realpathSync(dir))) {
          problems.push(`plugin ${source}: resolves outside the distro`)
          continue
        }
        const escaping = escapingLinks(realpathSync(dir), dir)
        if (escaping.length > 0) {
          problems.push(`plugin ${source}: ${escaping[0]} links outside the plugin`)
          continue
        }
        found.push({ source, dir, inspection: inspectOne({ home, plugins, log: this.options.log }, dir) })
      } catch (error) {
        problems.push(`plugin ${source}: ${messageOf(error)}`)
      }
    }

    const builtin = new Set(plugins.list().filter((plugin) => plugin.source === 'builtin').map((plugin) => plugin.id))
    const installed = new Set(plugins.list().filter((plugin) => plugin.source === 'installed').map((plugin) => plugin.id))
    const seen = new Set<string>()
    for (const { source, inspection } of found) {
      if (seen.has(inspection.id)) problems.push(`plugin ${source}: duplicates the plugin ${inspection.id} in this distro`)
      seen.add(inspection.id)
      if (builtin.has(inspection.id)) conflicts.push(`plugin ${inspection.id} is a built-in plugin`)
      else if (!owned.has(inspection.id) && (installed.has(inspection.id) || existsSync(join(home, 'plugins', inspection.id)))) {
        conflicts.push(`plugin ${inspection.id} is already installed`)
      }
    }

    const inspections = found.map(({ inspection }) => inspection)
    const settings = this.settingDeclarations(inspections)
    for (const [id, value] of Object.entries(manifest.settings ?? {})) {
      const declaration = settings.get(id)
      if (!declaration) problems.push(`settings: unknown setting ${id}`)
      else {
        const problem = checkSettingValue(id, declaration, value)
        if (problem !== null) problems.push(`settings: ${problem}`)
      }
    }
    if (manifest.theme !== undefined && !this.themeIds(inspections).has(manifest.theme)) {
      problems.push(`theme: ${manifest.theme} is not declared by a built-in plugin or the distro's plugins`)
    }
    return { manifest, plugins: found, problems, conflicts }
  }

  private builtinContributions(kind: string) {
    const builtin = new Set(
      this.options.plugins.list().filter((plugin) => plugin.source === 'builtin').map((plugin) => plugin.id)
    )
    return this.options.plugins.contributions({ kind, all: true }).filter((item) => builtin.has(item.plugin))
  }

  private settingDeclarations(inspections: PluginInspection[]): Map<string, UiSettingEntry> {
    const declarations = new Map<string, UiSettingEntry>()
    for (const item of this.builtinContributions('setting')) {
      declarations.set(item.id, { id: item.id, plugin: item.plugin, ...(item.data as SettingDeclaration) })
    }
    for (const inspection of inspections) {
      for (const item of inspection.contributions.filter((contribution) => contribution.kind === 'setting')) {
        if (!declarations.has(item.id)) {
          declarations.set(item.id, { id: item.id, plugin: inspection.id, ...(item.data as SettingDeclaration) })
        }
      }
    }
    return declarations
  }

  private themeIds(inspections: PluginInspection[]): Set<string> {
    return new Set([
      ...this.builtinContributions('theme').map((item) => item.id),
      ...inspections.flatMap((inspection) => inspection.contributions.filter((item) => item.kind === 'theme').map((item) => item.id))
    ])
  }

  private inspectionOf(prepared: Prepared): DistroInspection {
    const { store } = this.options
    const declarations = this.settingDeclarations(prepared.plugins.map(({ inspection }) => inspection))
    const current = this.active()
    const settings = Object.keys(prepared.manifest.settings ?? {}).map((id) => {
      const entry = declarations.get(id)!
      const stored = store.getSettingValue(id)
      return {
        id,
        current: resolveSetting(entry, stored, current).value,
        next: resolveSetting(entry, stored, prepared.manifest).value
      }
    })
    return { manifest: prepared.manifest, plugins: prepared.plugins.map(({ inspection }) => inspection), settings }
  }

  /** Broadcasts the effective value of every setting either manifest layers, and the theme when either names one. */
  private announce(next: DistroManifest, previous: DistroManifest | null): void {
    const { broadcast, plugins, store } = this.options
    if (!broadcast) return
    const layer = this.active()
    const { model } = buildUiModel({
      declarations: plugins.contributions({ all: true }),
      plugins: plugins.list(),
      chosenTheme: chosenThemeOf(store.getUiState('theme'), layer)
    })
    const ids = new Set([...Object.keys(next.settings ?? {}), ...Object.keys(previous?.settings ?? {})])
    for (const id of ids) {
      const entry = model.settings.find((setting) => setting.id === id)
      if (entry) broadcast({ type: 'setting.changed', id, value: resolveSetting(entry, store.getSettingValue(id), layer).value })
    }
    if (next.theme !== undefined || previous?.theme !== undefined) {
      broadcast({ type: 'theme.changed', chosen: model.theme.chosen, active: model.theme.active })
    }
  }
}
