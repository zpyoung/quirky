import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

type Manifest = { id?: string; main?: string; cli?: string; ui?: string; [key: string]: unknown }

const MANIFEST = 'quirky-plugin.json'

/** `entry` with its extension replaced by `.js`, keeping the directory. */
function jsName(entry: string): string {
  const { dir, name } = parse(entry)
  return dir ? join(dir, `${name}.js`) : `${name}.js`
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
 * was there. Each copy holds the rewritten manifest, `main` and `cli` bundled to `.js` with their
 * dependencies inlined, and the built UI module; sources, `test/` and `node_modules/` stay behind.
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
    const outPluginDir = join(outDir, entry.name)
    mkdirSync(outPluginDir, { recursive: true })

    if (manifest.main) manifest.main = await bundleEntry(id, pluginDir, outPluginDir, manifest.main)
    if (manifest.cli) manifest.cli = await bundleEntry(id, pluginDir, outPluginDir, manifest.cli)
    if (manifest.ui) copyUi(id, pluginDir, outPluginDir, manifest.ui)

    writeFileSync(join(outPluginDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    bundled.push(id)
  }
  return bundled
}
