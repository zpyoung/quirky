import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginManifest, PluginSource } from '@quirky/protocol'
import { MANIFEST_FILE, parseManifest } from './manifest'

/** One directory found under a plugin root; `errors` is non-empty when the plugin can't load. */
export type DiscoveredPlugin = {
  /** The manifest's ID, or the directory name when the manifest is unusable. */
  id: string
  /** Absolute path of the plugin directory. */
  dir: string
  source: PluginSource
  manifest: PluginManifest | null
  errors: string[]
}

function listDirectories(root: string): string[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function readPlugin(root: string, dirName: string, source: PluginSource): DiscoveredPlugin {
  const dir = resolve(root, dirName)
  const file = join(dir, MANIFEST_FILE)
  if (!existsSync(file)) return { id: dirName, dir, source, manifest: null, errors: [`no ${MANIFEST_FILE}`] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { id: dirName, dir, source, manifest: null, errors: [`${MANIFEST_FILE} can't be read: ${(error as Error).message}`] }
  }
  const result = parseManifest(text, { dirName, dir, source })
  if (result.ok) return { id: result.manifest.id, dir, source, manifest: result.manifest, errors: [] }
  return { id: dirName, dir, source, manifest: null, errors: result.errors }
}

/**
 * Lists the plugin directories under the built-in and installed roots, built-ins first and each
 * list sorted by directory name. Reads manifests only; no plugin code runs. An installed entry
 * that reuses a built-in's ID is kept as a separate, invalid entry so the built-in stays usable.
 */
export function discoverPlugins(dirs: { builtin: string | null; installed: string }): DiscoveredPlugin[] {
  const builtin = dirs.builtin ? listDirectories(dirs.builtin).map((name) => readPlugin(dirs.builtin!, name, 'builtin')) : []
  const builtinIds = new Set(builtin.map((plugin) => plugin.id))
  const installed = listDirectories(dirs.installed).map((name) => {
    const plugin = readPlugin(dirs.installed, name, 'installed')
    if (builtinIds.has(plugin.id)) plugin.errors.push(`duplicates the built-in plugin ${plugin.id}`)
    return plugin
  })
  return [...builtin, ...installed]
}
