import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, win32 } from 'node:path'

type Manifest = { id?: string; main?: string; cli?: string; ui?: string; workers?: unknown; [key: string]: unknown }

const MANIFEST = 'quirky-plugin.json'
const SOUNDS = 'sounds'
const LEGAL_FILES = ['LICENSE', 'NOTICE'] as const

/** `entry` with its extension replaced by `.js`, keeping the directory. */
function jsName(entry: string): string {
  const { dir, name } = parse(entry)
  return dir ? join(dir, `${name}.js`) : `${name}.js`
}
function workerEntries(pluginId: string, pluginDir: string, value: unknown): [string, string][] {
  if (value === undefined) return []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin ${pluginId}: workers must be an object of worker names to entry paths`)
  }
  const entries: [string, string][] = []
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(name)) {
      throw new Error(`plugin ${pluginId}: worker name '${name}' is not valid`)
    }
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`plugin ${pluginId}: worker ${name} must name a non-empty entry path`)
    }
    const rel = relative(pluginDir, resolve(pluginDir, entry))
    if (isAbsolute(entry) || win32.isAbsolute(entry) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`plugin ${pluginId}: worker ${name} entry must be root-relative and inside the plugin directory`)
    }
    entries.push([name, entry])
  }
  return entries
}

async function bundleEntry(pluginId: string, pluginDir: string, outPluginDir: string, entry: string): Promise<string> {
  const target = jsName(entry)
  const result = await Bun.build({
    entrypoints: [join(pluginDir, entry)],
    target: 'bun',
    outdir: dirname(join(outPluginDir, target)),
    naming: parse(target).base,
    throw: false
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bundling ${pluginId}: ${entry} failed`)
  }
  return target
}

function copyUi(pluginId: string, pluginDir: string, outPluginDir: string, ui: string): void {
  const from = join(pluginDir, ui)
  if (!existsSync(from)) {
    throw new Error(`plugin ${pluginId}: ${ui} is missing; run \`bun run build\` to produce the plugin UI modules`)
  }
  mkdirSync(dirname(join(outPluginDir, ui)), { recursive: true })
  cpSync(from, join(outPluginDir, ui))
}

/**
 * Writes a self-contained copy of every plugin under `srcDir` into `outDir`, replacing whatever
 * was there. Each copy holds the rewritten manifest, bundled `main`, `cli` and worker entries,
 * the built UI module, legal notices and any `sounds/` directory; sources, `test/` and
 * `node_modules/` stay behind.
 * A manifest that names a UI module which has not been built fails the whole bundle. Returns the
 * bundled plugin IDs.
 */
export async function bundlePlugins(srcDir: string, outDir: string): Promise<string[]> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const bundled: string[] = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const pluginDir = join(srcDir, entry.name)
    const manifestPath = join(pluginDir, MANIFEST)
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const id = manifest.id ?? entry.name
    const workers = workerEntries(id, pluginDir, manifest.workers)
    const outPluginDir = join(outDir, entry.name)
    mkdirSync(outPluginDir, { recursive: true })

    if (manifest.main) manifest.main = await bundleEntry(id, pluginDir, outPluginDir, manifest.main)
    if (manifest.cli) manifest.cli = await bundleEntry(id, pluginDir, outPluginDir, manifest.cli)
    if (manifest.workers !== undefined) {
      const bundledWorkers: Record<string, string> = {}
      for (const [name, worker] of workers) bundledWorkers[name] = await bundleEntry(id, pluginDir, outPluginDir, worker)
      manifest.workers = bundledWorkers
    }
    if (manifest.ui) copyUi(id, pluginDir, outPluginDir, manifest.ui)
    if (existsSync(join(pluginDir, SOUNDS))) cpSync(join(pluginDir, SOUNDS), join(outPluginDir, SOUNDS), { recursive: true })
    for (const name of LEGAL_FILES) {
      if (existsSync(join(pluginDir, name))) cpSync(join(pluginDir, name), join(outPluginDir, name))
    }

    writeFileSync(join(outPluginDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    bundled.push(id)
  }
  return bundled
}
