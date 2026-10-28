import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'

type Manifest = { id?: string; main?: string; cli?: string; ui?: string; staticAssets?: unknown; workers?: unknown; [key: string]: unknown }
const MANIFEST_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    main: { type: 'string' },
    cli: { type: 'string' },
    ui: { type: 'string' },
    staticAssets: { type: 'array', items: { type: 'string' } }
  },
  additionalProperties: true
}

const MANIFEST = 'quirky-plugin.json'
const SOUNDS = 'sounds'
type Asset = { dependency: string; source: string; destination: string; executable?: boolean }
type PrivatePackage = { dependencies?: Record<string, string>; quirky?: { assets?: unknown } }

const PLATFORM = process.platform
const ARCH = process.arch
const ASSETS_SCHEMA: Schema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      dependency: { type: 'string' },
      source: { type: 'string' },
      destination: { type: 'string' },
      executable: { type: 'boolean' }
    },
    required: ['dependency', 'source', 'destination'],
    additionalProperties: false
  }
}
const PRIVATE_PACKAGE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    dependencies: { type: 'object', additionalProperties: true },
    quirky: { type: 'object', properties: { assets: ASSETS_SCHEMA }, additionalProperties: true }
  },
  additionalProperties: true
}
function readPrivatePackage(pluginId: string, packagePath: string): PrivatePackage {
  let value: unknown
  try { value = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown } catch {
    throw new Error(`plugin ${pluginId}: private package.json is invalid JSON`)
  }
  if (validateValue(PRIVATE_PACKAGE_SCHEMA, value, 'private package.json')) {
    throw new Error(`plugin ${pluginId}: private package.json has an invalid schema`)
  }
  // Structural schema validation above proves the map; this subset cannot constrain dynamic values.
  const structuralPackage = value as { dependencies?: Record<string, unknown> }
  const dependencies = structuralPackage.dependencies
  if (dependencies && Object.values(dependencies).some((version) => typeof version !== 'string')) {
    throw new Error(`plugin ${pluginId}: dependency versions must be strings`)
  }
  // Both structural fields and dynamic dependency values have been validated.
  const parsed = value as PrivatePackage
  return parsed
}

function readPackageName(packagePath: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown
    const schema: Schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: true }
    if (validateValue(schema, value, 'dependency package.json')) return undefined
    const manifest = value as { name: string }
    return manifest.name
  } catch {
    return undefined
  }
}

function safeRelativePath(pluginId: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value) || win32.parse(value).root !== '') {
    throw new Error(`plugin ${pluginId}: asset ${field} must be a safe relative path`)
  }
  const parts = value.split(/[\\/]+/)
  if (parts.some((part) => part === '..' || part === '')) {
    throw new Error(`plugin ${pluginId}: asset ${field} must not traverse directories`)
  }
  return parts.join(sep)
}

function expandAssetPath(pluginId: string, field: string, value: string): string {
  const expanded = value.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    if (name === 'platform') return PLATFORM
    if (name === 'arch') return ARCH
    throw new Error(`plugin ${pluginId}: asset ${field} has unknown placeholder {${name}}`)
  })
  if (/[{}]/.test(expanded)) throw new Error(`plugin ${pluginId}: asset ${field} has malformed placeholder`)
  return safeRelativePath(pluginId, field, expanded)
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function dependencyRoot(pluginId: string, pluginDir: string, dependency: string): string {
  const require = createRequire(join(pluginDir, 'package.json'))
  let packageJson: string | undefined
  try {
    packageJson = require.resolve(`${dependency}/package.json`)
  } catch {
    try {
      let candidate = dirname(require.resolve(dependency))
      for (;;) {
        const path = join(candidate, 'package.json')
        if (existsSync(path) && readPackageName(path) === dependency) {
          packageJson = path
          break
        }
        const parent = dirname(candidate)
        if (parent === candidate) break
        candidate = parent
      }
    } catch {
      // Report the same actionable missing-package error below.
    }
  }
  if (packageJson === undefined) throw new Error(`plugin ${pluginId}: declared asset dependency ${dependency} cannot be resolved`)
  const root = realpathSync(dirname(packageJson))
  if (readPackageName(join(root, 'package.json')) !== dependency) {
    throw new Error(`plugin ${pluginId}: resolved asset dependency does not match ${dependency}`)
  }
  return root
}

function readPrivateAssets(pluginId: string, pluginDir: string): Asset[] {
  const packagePath = join(pluginDir, 'package.json')
  if (!existsSync(packagePath)) return []
  const pkg = readPrivatePackage(pluginId, packagePath)
  const raw = pkg.quirky?.assets
  if (raw === undefined) return []
  if (validateValue(ASSETS_SCHEMA, raw, 'quirky.assets')) throw new Error(`plugin ${pluginId}: quirky.assets has an invalid schema`)
  return (raw as Asset[]).map((asset) => ({
    dependency: asset.dependency,
    source: safeRelativePath(pluginId, 'source', asset.source),
    destination: safeRelativePath(pluginId, 'destination', asset.destination),
    ...(asset.executable === undefined ? {} : { executable: asset.executable })
  }))
}


function pathConflicts(a: string, b: string): boolean {
  const left = a.split(/[\\/]+/).join('/')
  const right = b.split(/[\\/]+/).join('/')
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function copyPrivateAssets(
  pluginId: string,
  pluginDir: string,
  outPluginDir: string,
  manifest: Manifest,
  entryOutputs: string[]
): void {
  const assets = readPrivateAssets(pluginId, pluginDir)
  if (assets.length === 0) return
  const packagePath = join(pluginDir, 'package.json')
  const pkg = readPrivatePackage(pluginId, packagePath)
  const dependencies = pkg.dependencies ?? {}
  const destinations = [MANIFEST, ...entryOutputs, ...(manifest.ui ? [manifest.ui] : []), SOUNDS]
  const seen: string[] = []
  for (const asset of assets) {
    if (!Object.hasOwn(dependencies, asset.dependency)) {
      throw new Error(`plugin ${pluginId}: asset dependency ${asset.dependency} must be a declared dependency`)
    }
    const source = expandAssetPath(pluginId, 'source', asset.source)
    const destination = expandAssetPath(pluginId, 'destination', asset.destination)
    if (destinations.some((reserved) => pathConflicts(destination, reserved)) || seen.some((prior) => pathConflicts(destination, prior))) {
      throw new Error(`plugin ${pluginId}: asset destination ${destination} collides with a bundled output`)
    }
    seen.push(destination)
    const root = dependencyRoot(pluginId, pluginDir, asset.dependency)
    let from: string
    try { from = realpathSync(join(root, source)) } catch {
      throw new Error(`plugin ${pluginId}: declared asset source ${source} is missing from dependency ${asset.dependency}`)
    }
    if (!within(root, from) || !lstatSync(from).isFile()) {
      throw new Error(`plugin ${pluginId}: asset source ${source} escapes ${asset.dependency} or is not a file`)
    }
    const to = resolve(outPluginDir, destination)
    if (!within(resolve(outPluginDir), to)) throw new Error(`plugin ${pluginId}: asset destination ${destination} escapes plugin output`)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(from), { mode: asset.executable ? 0o755 : 0o644 })
    if (asset.executable) chmodSync(to, 0o755)
  }
}
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
  const relativeDirectory = dirname(ui)
  if (relativeDirectory === '.') {
    mkdirSync(dirname(join(outPluginDir, ui)), { recursive: true })
    cpSync(from, join(outPluginDir, ui))
    return
  }
  const sourceDirectory = join(pluginDir, relativeDirectory)
  const outputDirectory = join(outPluginDir, relativeDirectory)
  mkdirSync(dirname(outputDirectory), { recursive: true })
  cpSync(sourceDirectory, outputDirectory, { recursive: true })
}

function staticAssetRoots(pluginId: string, manifest: Manifest): string[] {
  if (manifest.staticAssets === undefined) return []
  if (!Array.isArray(manifest.staticAssets) || manifest.staticAssets.some((path) => typeof path !== 'string')) {
    throw new Error(`plugin ${pluginId}: staticAssets must be an array of root-relative directories`)
  }
  const roots = (manifest.staticAssets as string[]).map((path) => safeRelativePath(pluginId, 'static asset', path))
  if (roots.some((path) => path.split(/[\\/]+/).some((part) => part === '.'))) throw new Error(`plugin ${pluginId}: static asset paths must not contain dot segments`)
  for (let index = 0; index < roots.length; index++) {
    if (roots.slice(index + 1).some((other) => pathConflicts(roots[index]!, other))) throw new Error(`plugin ${pluginId}: static asset roots collide`)
  }
  return roots
}

function assertNoStaticLinks(pluginId: string, path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) throw new Error(`plugin ${pluginId}: static asset trees cannot contain symlinks`)
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) assertNoStaticLinks(pluginId, join(path, child))
  } else if (!entry.isFile()) {
    throw new Error(`plugin ${pluginId}: static assets must contain only regular files and directories`)
  }
}

function copyStaticAssets(
  pluginId: string,
  pluginDir: string,
  outPluginDir: string,
  roots: readonly string[],
  bundledOutputs: readonly string[]
): void {
  const pluginRoot = realpathSync(pluginDir)
  const destinations = [MANIFEST, SOUNDS, ...bundledOutputs]
  const copied: string[] = []
  for (const root of roots) {
    if (destinations.some((reserved) => pathConflicts(root, reserved)) || copied.some((prior) => pathConflicts(root, prior))) {
      throw new Error(`plugin ${pluginId}: static asset root ${root} collides with a bundled output`)
    }
    const source = resolve(pluginDir, root)
    const output = resolve(outPluginDir, root)
    if (!within(resolve(pluginDir), source) || !within(resolve(outPluginDir), output)) throw new Error(`plugin ${pluginId}: static asset root escapes its plugin directory`)
    try {
      if (!lstatSync(source).isDirectory()) throw new Error('not a directory')
      assertNoStaticLinks(pluginId, source)
      const real = realpathSync(source)
      if (!within(pluginRoot, real)) throw new Error('outside plugin root')
      mkdirSync(dirname(output), { recursive: true })
      cpSync(real, output, { recursive: true, dereference: false })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`plugin ${pluginId}:`)) throw error
      throw new Error(`plugin ${pluginId}: static asset directory ${root} is missing or unsafe`)
    }
    copied.push(root)
  }
}

function copyNotebookBridge(pluginDir: string, outPluginDir: string): void {
  const relativePath = 'src/notebook/kernel-bridge.py'
  const from = join(pluginDir, relativePath)
  if (!existsSync(from)) return
  const to = join(outPluginDir, relativePath)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
}

const LEGAL_NOTICE_NAME = /^(?:licen[cs]e|notice)(?:[._-].*)?$/i

function copyLegalNotices(pluginId: string, pluginDir: string, outPluginDir: string): void {
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!LEGAL_NOTICE_NAME.test(entry.name)) continue
    if (!entry.isFile()) throw new Error(`plugin ${pluginId}: legal notice ${entry.name} must be a regular file`)
    const destination = join(outPluginDir, entry.name)
    if (existsSync(destination)) throw new Error(`plugin ${pluginId}: legal notice ${entry.name} collides with a bundled output`)
    writeFileSync(destination, readFileSync(join(pluginDir, entry.name)), { mode: 0o644 })
  }
}

/**
 * Writes a self-contained copy of every plugin under `srcDir` into `outDir`, replacing whatever
 * was there. Each copy holds the rewritten manifest; `main` and `cli` bundled to `.js` with their
 * dependencies inlined; generated UI asset tree and declared static asset trees; `sounds/`; the plugin-local
 * runtime bridge `src/notebook/kernel-bridge.py` when present; declared private package assets;
 * and legal notices. Other sources, `test/` and `node_modules/` stay behind.
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

    const rawManifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    if (validateValue(MANIFEST_SCHEMA, rawManifest, 'plugin manifest')) throw new Error(`plugin ${entry.name}: manifest entry fields are invalid`)
    const manifest = rawManifest as Manifest
    const id = manifest.id ?? entry.name
    const workers = workerEntries(id, pluginDir, manifest.workers)
    const outPluginDir = join(outDir, entry.name)
    mkdirSync(outPluginDir, { recursive: true })

    if (manifest.main) manifest.main = await bundleEntry(id, pluginDir, outPluginDir, manifest.main)
    if (manifest.cli) manifest.cli = await bundleEntry(id, pluginDir, outPluginDir, manifest.cli)
    const workerOutputs: string[] = []
    if (manifest.workers !== undefined) {
      const bundledWorkers: Record<string, string> = {}
      for (const [name, worker] of workers) {
        const output = await bundleEntry(id, pluginDir, outPluginDir, worker)
        bundledWorkers[name] = output
        workerOutputs.push(output)
      }
      manifest.workers = bundledWorkers
    }
    if (manifest.ui) copyUi(id, pluginDir, outPluginDir, manifest.ui)
    copyNotebookBridge(pluginDir, outPluginDir)
    if (existsSync(join(pluginDir, SOUNDS))) cpSync(join(pluginDir, SOUNDS), join(outPluginDir, SOUNDS), { recursive: true })
    const staticAssets = staticAssetRoots(id, manifest)
    const bundledOutputs = [manifest.main, manifest.cli, ...workerOutputs, ...(manifest.ui ? [manifest.ui] : [])].filter((name): name is string => typeof name === 'string')
    copyStaticAssets(id, pluginDir, outPluginDir, staticAssets, bundledOutputs)
    copyPrivateAssets(id, pluginDir, outPluginDir, manifest, [...bundledOutputs, ...staticAssets])
    copyLegalNotices(id, pluginDir, outPluginDir)

    writeFileSync(join(outPluginDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    bundled.push(id)
  }
  return bundled
}
