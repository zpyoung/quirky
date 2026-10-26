import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { formatContributionId, parseContributionId, type PluginInfo, type PluginInspection, type PluginManifest } from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import type { PluginHost } from './host'
import { MANIFEST_FILE, parseManifest } from './manifest'

export type PluginInstallDeps = {
  home: string
  plugins: PluginHost
  log: (message: string) => void
  /** The ID of the installed distro that owns this plugin, or null when none does. */
  distroOf?: (pluginId: string) => string | null
}

const KIND_COLUMN_WIDTH = 'keybinding'.length

const locks = new WeakMap<PluginHost, Promise<unknown>>()

/** Runs installs and uninstalls for one host one at a time, since they share `.tmp-<id>` paths. */
function serialized<T>(host: PluginHost, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(host) ?? Promise.resolve()).then(work)
  locks.set(host, run.catch(() => undefined))
  return run
}

function peekManifestId(path: string): string | null {
  try {
    return peekId(readFileSync(join(resolve(path), MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}

function readSource(path: string): { dir: string; manifest: PluginManifest } {
  const dir = resolve(path)
  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    throw notFound(`no directory at ${path}`)
  }
  if (!isDirectory) throw invalidParams(`${path} is not a directory`)
  const file = join(dir, MANIFEST_FILE)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw invalidParams(`no ${MANIFEST_FILE} in ${path}`)
  }
  // the copy is installed under the manifest's ID, so the source directory's own name is irrelevant
  const dirName = peekId(text) ?? basename(dir)
  const parsed = parseManifest(text, { dirName, dir, source: 'installed' })
  if (!parsed.ok) throw invalidParams(`invalid plugin manifest: ${parsed.errors.join('; ')}`)
  return { dir, manifest: parsed.manifest }
}

function peekId(text: string): string | null {
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

function contributionsOf(manifest: PluginManifest): PluginInspection['contributions'] {
  return Object.entries(manifest.contributes ?? {}).flatMap(([kind, entries]) =>
    entries.map(({ id: name, ...data }) => ({ kind, id: formatContributionId(kind, manifest.id, name), data }))
  )
}

function declaredIds(manifest: PluginManifest): string[] {
  return [...contributionsOf(manifest).map((item) => item.id), ...(manifest.overrides ?? []).map((item) => item.id)]
}

function installedManifest(deps: PluginInstallDeps, id: string): PluginManifest | null | undefined {
  const dir = join(deps.home, 'plugins', id)
  if (!existsSync(dir)) return undefined
  try {
    const parsed = parseManifest(readFileSync(join(dir, MANIFEST_FILE), 'utf8'), { dirName: id, dir, source: 'installed' })
    return parsed.ok ? parsed.manifest : null
  } catch {
    return null
  }
}

/**
 * Reads a plugin directory's manifest and lists its contributions, overrides and disables; runs no
 * plugin code. `installed` is present when a plugin with this ID is already installed. InvalidParams
 * lists every manifest error.
 */
export function inspectPlugin(deps: PluginInstallDeps, path: string): PluginInspection {
  const { manifest } = readSource(path)
  const declarations = deps.plugins.contributions({ all: true })
  const overrides = (manifest.overrides ?? []).map(({ id }) => ({
    id,
    replaces: declarations.find((item) => item.id === id && !item.override)?.plugin ?? parseContributionId(id)!.namespace
  }))
  const inspection: PluginInspection = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    contributions: contributionsOf(manifest),
    overrides,
    disables: manifest.disables ?? []
  }
  const current = installedManifest(deps, manifest.id)
  if (current !== undefined) {
    const before = new Set(current === null ? [] : declaredIds(current))
    const after = new Set(declaredIds(manifest))
    inspection.installed = {
      version: current?.version ?? 'invalid',
      added: [...after].filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !after.has(id))
    }
  }
  return inspection
}

/**
 * The text a client shows before an install: the plugin line, one line per contribution, override
 * and disable, and for a reinstall the version change plus `+`/`-` lines for what was added or removed.
 */
export function renderInspection(inspection: PluginInspection): string {
  const row = (kind: string, rest: string) => `${kind.padEnd(KIND_COLUMN_WIDTH)} ${rest}`
  const version = inspection.installed ? `${inspection.installed.version} → ${inspection.version}` : inspection.version
  const lines = [`${inspection.id} ${version} (${inspection.name})`]
  for (const { kind, id, data } of inspection.contributions) {
    const key = kind === 'keybinding' && typeof data.key === 'string' ? `  ${data.key}` : ''
    lines.push(row(kind, `${id}${key}`))
  }
  for (const { id, replaces } of inspection.overrides) lines.push(row('override', `${id} (replaces ${replaces}'s)`))
  for (const id of inspection.disables) lines.push(row('disables', id))
  for (const id of inspection.installed?.added ?? []) lines.push(`+ ${id}`)
  for (const id of inspection.installed?.removed ?? []) lines.push(`- ${id}`)
  return lines.join('\n')
}

/**
 * Copies `source` to `target`, following symlinks that stay inside `root` and refusing any that
 * resolve outside it, so the copy never depends on the source tree afterwards.
 */
function copyTree(source: string, target: string, root: string, ancestors: string[]): void {
  const real = realpathSync(source)
  if (ancestors.includes(real)) throw invalidParams(`plugin contains a symlink loop at ${relative(root, source) || '.'}`)
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const shown = relative(root, from)
    let resolved = from
    if (lstatSync(from).isSymbolicLink()) {
      try {
        resolved = realpathSync(from)
      } catch {
        throw invalidParams(`plugin contains a broken symlink: ${shown}`)
      }
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw invalidParams(`plugin contains a symlink that points outside its directory: ${shown}`)
      }
    }
    const stats = statSync(resolved)
    if (stats.isDirectory()) copyTree(resolved, to, root, [...ancestors, real])
    else if (stats.isFile()) cpSync(resolved, to)
    else throw invalidParams(`plugin contains a file that is not a regular file or directory: ${shown}`)
  }
}

/**
 * Copies the plugin at `path` into `<home>/plugins` (replacing an earlier install, which is
 * deactivated first) and rescans. Conflict for a built-in ID or a plugin the active distro owns;
 * InvalidParams for an invalid manifest or a symlink leaving the directory.
 */
export function installPlugin(deps: PluginInstallDeps, path: string): Promise<PluginInfo> {
  return serialized(deps.plugins, async () => {
    const claimed = peekManifestId(path)
    if (claimed !== null && deps.plugins.list().some((plugin) => plugin.id === claimed && plugin.source === 'builtin')) {
      throw conflict(`${claimed} is a built-in plugin and can't be replaced by an install`)
    }
    const { dir, manifest } = readSource(path)
    const { id } = manifest
    const distro = deps.distroOf?.(id) ?? null
    if (distro !== null) throw conflict(`${id} belongs to the distro ${distro}; remove the distro instead`)

    const pluginsDir = join(deps.home, 'plugins')
    const staging = join(pluginsDir, `.tmp-${id}`)
    const final = join(pluginsDir, id)
    rmSync(staging, { recursive: true, force: true })
    try {
      const root = realpathSync(dir)
      copyTree(root, staging, root, [])
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    await deps.plugins.replacePlugin(id, () => {
      const previous = join(pluginsDir, `.old-${id}`)
      rmSync(previous, { recursive: true, force: true })
      if (existsSync(final)) renameSync(final, previous)
      try {
        renameSync(staging, final)
      } catch (error) {
        if (existsSync(previous)) renameSync(previous, final)
        rmSync(staging, { recursive: true, force: true })
        throw error
      }
      rmSync(previous, { recursive: true, force: true })
    })
    deps.log(`plugin installed: ${id} ${manifest.version}`)
    const info = deps.plugins.list().find((plugin) => plugin.id === id && plugin.source === 'installed')
    return info!
  })
}

/**
 * Deactivates and deletes an installed plugin and its data, then rescans. InvalidParams for a
 * built-in, Conflict for a plugin the active distro owns, NotFound for an unknown ID.
 */
export function uninstallPlugin(deps: PluginInstallDeps, id: string): Promise<void> {
  return serialized(deps.plugins, async () => {
    const entries = deps.plugins.list().filter((plugin) => plugin.id === id)
    if (entries.some((plugin) => plugin.source === 'builtin')) {
      throw invalidParams('built-in plugins can be disabled but not removed')
    }
    if (!entries.some((plugin) => plugin.source === 'installed')) throw notFound(`no installed plugin ${id}`)
    const distro = deps.distroOf?.(id) ?? null
    if (distro !== null) throw conflict(`${id} belongs to the distro ${distro}; remove the distro instead`)
    await deps.plugins.replacePlugin(id, () => {
      rmSync(join(deps.home, 'plugins', id), { recursive: true, force: true })
      rmSync(join(deps.home, 'plugin-data', id), { recursive: true, force: true })
    })
    deps.log(`plugin uninstalled: ${id}`)
  })
}
