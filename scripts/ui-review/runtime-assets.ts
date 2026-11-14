import { createHash } from 'node:crypto'
import {
  constants as fsConstants, lstatSync, readFileSync, readdirSync, realpathSync,
  type Stats
} from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, readdir, realpath, rm, stat, symlink
} from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isPluginId, type UiModel } from '@quirky/protocol'

const STAGING_DIRECTORY = 'capture-assets'
const UI_OUTPUT_DIRECTORY = 'packages/ui/dist'
const BUILTIN_PLUGINS_DIRECTORY = 'plugins'
const SKIPPED_PLUGIN_ENTRIES = new Set(['.git', 'dist', 'node_modules'])
const REQUIRED_SHELL_ASSETS = [
  'index.html',
  'main.js',
  'main.css',
  'xterm.css',
  'vendor/react.js',
  'vendor/react-dom.js',
  'vendor/react-dom-client.js',
  'vendor/jsx-runtime.js'
]

export type RuntimeAssets = {
  repoRoot: string
  uiDir: string
  pluginsDir: string
  ownedRoot: string | null
}

export type AssetFingerprint = { path: string; size: number; sha256: string }
export type AssetSnapshot = ReadonlyMap<string, AssetFingerprint>
type FileInfo = Stats

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function ensureWithin(root: string, candidate: string, displayPath: string): void {
  if (!isWithin(root, candidate)) throw new Error(`runtime assets: escapes root ${displayPath}`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason instanceof Error ? `: ${signal.reason.message}` : ''
  throw new Error(`runtime assets: staging aborted${reason}`)
}

async function optionalLstat(path: string): Promise<FileInfo | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function optionalLstatSync(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function linkDependency(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const sourceInfo = await optionalLstat(source)
  if (sourceInfo === null) return
  const canonicalSource = await realpath(source)
  const targetInfo = await stat(canonicalSource)
  if (!targetInfo.isDirectory()) throw new Error(`runtime assets: invalid dependency directory ${source}`)
  throwIfAborted(signal)
  await symlink(canonicalSource, destination, 'dir')
}

async function copyPluginDirectory(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await mkdir(destination)
  const entries = (await readdir(source)).sort()
  for (const name of entries) {
    if (SKIPPED_PLUGIN_ENTRIES.has(name)) continue
    throwIfAborted(signal)
    const sourceEntry = join(source, name)
    const destinationEntry = join(destination, name)
    const info = await lstat(sourceEntry)
    if (info.isSymbolicLink()) throw new Error(`runtime assets: unexpected source symlink ${sourceEntry}`)
    if (info.isDirectory()) {
      await copyPluginDirectory(sourceEntry, destinationEntry, signal)
    } else if (info.isFile()) {
      await copyFile(sourceEntry, destinationEntry, fsConstants.COPYFILE_EXCL)
      await chmod(destinationEntry, info.mode & 0o777)
      throwIfAborted(signal)
    } else {
      throw new Error(`runtime assets: unsupported source entry ${sourceEntry}`)
    }
  }
}

async function copyBuiltins(sourceRoot: string, destinationRoot: string, signal?: AbortSignal): Promise<void> {
  const sourceInfo = await lstat(sourceRoot)
  if (sourceInfo.isSymbolicLink()) throw new Error(`runtime assets: unexpected source symlink ${sourceRoot}`)
  if (!sourceInfo.isDirectory()) throw new Error(`runtime assets: missing plugins source ${sourceRoot}`)
  const entries = (await readdir(sourceRoot)).sort()
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue
    throwIfAborted(signal)
    const sourcePlugin = join(sourceRoot, name)
    const info = await lstat(sourcePlugin)
    if (info.isSymbolicLink()) throw new Error(`runtime assets: unexpected source symlink ${sourcePlugin}`)
    if (!info.isDirectory()) continue
    const manifestPath = join(sourcePlugin, 'quirky-plugin.json')
    const manifestInfo = await optionalLstat(manifestPath)
    if (manifestInfo === null) continue
    if (manifestInfo.isSymbolicLink()) throw new Error(`runtime assets: unexpected source symlink ${manifestPath}`)
    if (!manifestInfo.isFile()) throw new Error(`runtime assets: invalid plugin manifest ${manifestPath}`)

    const destinationPlugin = join(destinationRoot, name)
    await copyPluginDirectory(sourcePlugin, destinationPlugin, signal)
    await linkDependency(join(sourcePlugin, 'node_modules'), join(destinationPlugin, 'node_modules'), signal)
  }
}

function safeManifestUiPath(value: unknown, pluginId: string): string[] {
  function invalid(): never { throw new Error(`runtime assets: invalid URL ${String(value)} for ${pluginId}`) }
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#')) invalid()
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid()
  const segments = value.split('/')
  if (segments.length < 2 || segments[0] !== 'dist') invalid()
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') invalid()
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      invalid()
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(decoded) || decoded.includes('?') || decoded.includes('#')) invalid()
  }
  return segments
}

function addFingerprint(snapshot: Map<string, AssetFingerprint>, publicPath: string, canonicalPath: string): void {
  const bytes = readFileSync(canonicalPath)
  snapshot.set(publicPath, {
    path: canonicalPath,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
}

function childPublicPath(parent: string, name: string): string {
  return `${parent}/${encodeURIComponent(name)}`
}

function snapshotTree(
  directory: string,
  containmentRoot: string,
  publicPrefix: string,
  snapshot: Map<string, AssetFingerprint>
): void {
  for (const name of readdirSync(directory).sort()) {
    const entry = join(directory, name)
    const publicPath = childPublicPath(publicPrefix, name)
    const info = lstatSync(entry)
    const canonicalEntry = realpathSync(entry)
    ensureWithin(containmentRoot, canonicalEntry, publicPath)
    if (info.isSymbolicLink()) throw new Error(`runtime assets: output entry is a symlink ${publicPath}`)
    if (info.isDirectory()) snapshotTree(entry, containmentRoot, publicPath, snapshot)
    else if (info.isFile()) addFingerprint(snapshot, publicPath, canonicalEntry)
    else throw new Error(`runtime assets: invalid output entry ${publicPath}`)
  }
}

function outputRoot(path: string, trustedRoot: string, publicPath: string): string {
  const info = optionalLstatSync(path)
  if (info === null) throw new Error(`runtime assets: missing ${publicPath}`)
  const canonicalPath = realpathSync(path)
  ensureWithin(trustedRoot, canonicalPath, publicPath)
  if (info.isSymbolicLink()) throw new Error(`runtime assets: output root is a symlink ${publicPath}`)
  if (!info.isDirectory()) throw new Error(`runtime assets: missing ${publicPath}`)
  return canonicalPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function manifestForPlugin(pluginPath: string, pluginId: string, pluginsRoot: string): Record<string, unknown> | null {
  const manifestPath = join(pluginPath, 'quirky-plugin.json')
  const info = optionalLstatSync(manifestPath)
  if (info === null) return null
  const publicManifest = `/plugins/${encodeURIComponent(pluginId)}/quirky-plugin.json`
  const canonicalManifest = realpathSync(manifestPath)
  ensureWithin(pluginsRoot, canonicalManifest, publicManifest)
  if (info.isSymbolicLink()) throw new Error(`runtime assets: plugin manifest is a symlink ${publicManifest}`)
  if (!info.isFile()) throw new Error(`runtime assets: missing ${publicManifest}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(canonicalManifest, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`runtime assets: invalid plugin manifest ${publicManifest}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.id !== pluginId || !isPluginId(pluginId)) {
    throw new Error(`runtime assets: invalid plugin ID ${pluginId}`)
  }
  return parsed
}

/** Creates a private build tree under this capture home, or points skip-build captures at checkout output. */
export async function prepareRuntimeAssets(options: {
  repoRoot: string
  home: string
  skipBuild: boolean
  signal?: AbortSignal
}): Promise<RuntimeAssets> {
  const { repoRoot, home, skipBuild, signal } = options
  throwIfAborted(signal)
  if (skipBuild) {
    return {
      repoRoot,
      uiDir: join(repoRoot, UI_OUTPUT_DIRECTORY),
      pluginsDir: join(repoRoot, BUILTIN_PLUGINS_DIRECTORY),
      ownedRoot: null
    }
  }

  const canonicalRepoRoot = await realpath(repoRoot)
  const canonicalHome = await realpath(home)
  const ownedRoot = join(canonicalHome, STAGING_DIRECTORY)
  if (isWithin(canonicalRepoRoot, ownedRoot) || isWithin(ownedRoot, canonicalRepoRoot)) {
    throw new Error(`runtime assets: staging overlaps source tree ${ownedRoot}`)
  }
  if (await optionalLstat(ownedRoot)) throw new Error(`runtime assets: staging path already exists ${ownedRoot}`)

  let created = false
  try {
    throwIfAborted(signal)
    await mkdir(ownedRoot)
    created = true
    const uiDir = join(ownedRoot, 'ui')
    const pluginsDir = join(ownedRoot, BUILTIN_PLUGINS_DIRECTORY)
    await mkdir(uiDir)
    await mkdir(pluginsDir)
    await linkDependency(join(canonicalRepoRoot, 'node_modules'), join(ownedRoot, 'node_modules'), signal)
    await copyBuiltins(join(canonicalRepoRoot, BUILTIN_PLUGINS_DIRECTORY), pluginsDir, signal)
    throwIfAborted(signal)
    return { repoRoot, uiDir, pluginsDir, ownedRoot }
  } catch (error) {
    if (created) {
      try {
        await rm(ownedRoot, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'runtime assets: staging cleanup failed')
      }
    }
    throw error
  }
}

/** Overlays only the four builder/daemon root variables without mutating the caller's environment. */
export function runtimeAssetEnvironment(base: Record<string, string>, assets: RuntimeAssets): Record<string, string> {
  return {
    ...base,
    QUIRKY_UI_OUT: assets.uiDir,
    QUIRKY_UI_DIR: assets.uiDir,
    QUIRKY_PLUGINS_DIR: assets.pluginsDir,
    QUIRKY_BUILTIN_PLUGINS_DIR: assets.pluginsDir
  }
}

/** Records every immutable shell and built-in UI file by its canonical public URL and real file identity. */
export function snapshotRuntimeAssets(assets: RuntimeAssets): AssetSnapshot {
  const ownerRoot = realpathSync(assets.ownedRoot ?? assets.repoRoot)
  const uiRoot = outputRoot(assets.uiDir, ownerRoot, '/index.html')
  const pluginsRoot = outputRoot(assets.pluginsDir, ownerRoot, '/plugins')
  const snapshot = new Map<string, AssetFingerprint>()

  snapshotTree(assets.uiDir, uiRoot, '', snapshot)
  for (const asset of REQUIRED_SHELL_ASSETS) {
    const publicPath = `/${asset.split('/').map(encodeURIComponent).join('/')}`
    if (!snapshot.has(publicPath)) throw new Error(`runtime assets: missing ${publicPath}`)
  }

  for (const name of readdirSync(assets.pluginsDir).sort()) {
    const pluginPath = join(assets.pluginsDir, name)
    const info = lstatSync(pluginPath)
    const canonicalPlugin = realpathSync(pluginPath)
    const publicPlugin = `/plugins/${encodeURIComponent(name)}`
    ensureWithin(pluginsRoot, canonicalPlugin, publicPlugin)
    if (info.isSymbolicLink()) throw new Error(`runtime assets: plugin root is a symlink ${publicPlugin}`)
    if (!info.isDirectory()) continue
    const manifest = manifestForPlugin(pluginPath, name, pluginsRoot)
    if (manifest === null || !Object.hasOwn(manifest, 'ui')) continue
    const uiSegments = safeManifestUiPath(manifest.ui, name)
    const pluginRoot = realpathSync(pluginPath)
    const distPath = join(pluginPath, 'dist')
    const distRoot = outputRoot(distPath, pluginRoot, `${publicPlugin}/dist`)
    const prefix = `${publicPlugin}/dist`
    snapshotTree(distPath, distRoot, prefix, snapshot)
    const entryUrl = `${publicPlugin}/${uiSegments.map(encodeURIComponent).join('/')}`
    if (!snapshot.has(entryUrl)) throw new Error(`runtime assets: missing ${entryUrl}`)
  }

  return snapshot
}

function publicAssetUrl(value: string, pluginId?: string): string {
  const invalid = (): never => { throw new Error(`runtime assets: invalid URL ${value}`) }
  if (!value.startsWith('/') || value.startsWith('//') || /[\\?#\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid()
  const parts = value.slice(1).split('/').map((part) => {
    let decoded: string
    try { decoded = decodeURIComponent(part) } catch { return invalid() }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\?#\u0000-\u001f\u007f-\u009f]/u.test(decoded) ||
      Buffer.byteLength(decoded) > 255) invalid()
    return decoded
  })
  if (parts[0] === 'plugins') {
    if (!isPluginId(parts[1] ?? '') || parts[2] !== 'dist' || parts.length < 4) invalid()
  }
  if (pluginId !== undefined && (!isPluginId(pluginId) || parts[0] !== 'plugins' || parts[1] !== pluginId)) invalid()
  return `/${parts.map(encodeURIComponent).join('/')}`
}

function requireAsset(snapshot: AssetSnapshot, url: string, pluginId?: string): void {
  const canonical = publicAssetUrl(url, pluginId)
  if (!snapshot.has(canonical)) throw new Error(`runtime assets: missing ${canonical}`)
}

function checkSnapshot(assets: RuntimeAssets, expected: AssetSnapshot): void {
  const current = snapshotRuntimeAssets(assets)
  for (const [url, fingerprint] of expected) {
    const actual = current.get(url)
    if (!actual) throw new Error(`runtime assets: missing ${url}`)
    if (actual.path !== fingerprint.path || actual.size !== fingerprint.size || actual.sha256 !== fingerprint.sha256) {
      throw new Error(`runtime assets: changed ${url}`)
    }
  }
  for (const url of current.keys()) {
    if (!expected.has(url)) throw new Error(`runtime assets: changed ${url} (added)`)
  }
}

function htmlAttribute(value: string): string {
  const escapes: Record<string, string> = { '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }
  return value.replace(/[&"'<>]/g, (character) => escapes[character]!)
}

function documentAssetUrl(value: string): string {
  const decoded = value.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ({
    '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>'
  })[entity]!)
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) throw new Error(`runtime assets: invalid URL ${value}`)
  return decoded.startsWith('/') ? decoded : `/${decoded.replace(/^\.\//, '')}`
}

function checkDocumentAssets(html: string, snapshot: AssetSnapshot): void {
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes: Record<string, string> = {}
    for (const attribute of match[2]!.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attributes[attribute[1]!.toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? ''
    }
    if (match[1]!.toLowerCase() === 'script' && attributes.src !== undefined) {
      requireAsset(snapshot, documentAssetUrl(attributes.src))
    }
    const relations = (attributes.rel ?? '').toLowerCase().split(/\s+/)
    if (match[1]!.toLowerCase() === 'link' && attributes.href !== undefined &&
      (relations.includes('stylesheet') || relations.includes('modulepreload') ||
        (relations.includes('preload') && ['script', 'style'].includes(attributes.as ?? '')))) {
      requireAsset(snapshot, documentAssetUrl(attributes.href))
    }
  }
  for (const match of html.matchAll(/<script\b(?=[^>]*\s+type\s*=\s*(["'])importmap\1)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let map: unknown
    try { map = JSON.parse(match[2]!) } catch { throw new Error('runtime assets: invalid URL in index import map') }
    if (!isRecord(map)) throw new Error('runtime assets: invalid URL in index import map')
    const mappings = [map.imports, ...(isRecord(map.scopes) ? Object.values(map.scopes) : [])]
    for (const mapping of mappings) {
      if (mapping === undefined) continue
      if (!isRecord(mapping)) throw new Error('runtime assets: invalid URL in index import map')
      for (const value of Object.values(mapping)) {
        if (typeof value !== 'string') throw new Error('runtime assets: invalid URL in index import map')
        requireAsset(snapshot, documentAssetUrl(value))
      }
    }
  }
}

function expectedIndex(snapshot: AssetSnapshot, modules: string[]): AssetFingerprint {
  const recorded = snapshot.get('/index.html')
  if (!recorded) throw new Error('runtime assets: missing /index.html')
  const bytes = readFileSync(recorded.path)
  if (bytes.byteLength !== recorded.size || createHash('sha256').update(bytes).digest('hex') !== recorded.sha256) {
    throw new Error('runtime assets: changed /index.html')
  }
  const html = bytes.toString('utf8')
  checkDocumentAssets(html, snapshot)
  const importMap = /<script\b(?=[^>]*\s+type\s*=\s*(["'])importmap\1)[^>]*>/i.test(html)
  const bodyEnd = /<\/body\s*>/i.exec(html)
  const links = importMap && bodyEnd !== null && modules.length > 0
    ? modules.map((url) => `<link rel="modulepreload" href="${htmlAttribute(url)}">`).join('\n')
    : ''
  const expected = links && bodyEnd !== null ? `${html.slice(0, bodyEnd.index)}${links}${html.slice(bodyEnd.index)}` : html
  return { path: recorded.path, size: Buffer.byteLength(expected, 'utf8'), sha256: createHash('sha256').update(expected).digest('hex') }
}

async function verifyResponse(origin: string, url: string, expected: AssetFingerprint, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${origin}${url}`, { method: 'GET', redirect: 'manual', signal })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (response.status !== 200) throw new Error(`runtime assets: HTTP ${response.status} ${url}`)
    if (!response.body) throw new Error(`runtime assets: served bytes differ ${url}`)
    reader = response.body.getReader()
    const hash = createHash('sha256')
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > expected.size) throw new Error(`runtime assets: response too large ${url}`)
      hash.update(value)
    }
    if (received !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new Error(`runtime assets: served bytes differ ${url}`)
    }
  } finally {
    if (reader) {
      try { await reader.cancel() } catch { /* abort can already have closed the reader */ }
      reader.releaseLock()
    } else {
      try { await response.body?.cancel() } catch { /* a failed request may have closed its body */ }
    }
  }
}

/** Proves that the isolated loopback daemon serves the recorded build, without following URLs outside that build. */
export async function verifyRuntimeAssets(
  assets: RuntimeAssets,
  snapshot: AssetSnapshot,
  model: UiModel,
  options: { port: number; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535 ||
    !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('runtime assets: invalid verification bounds')
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error(`runtime assets: verification timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
  try {
    controller.signal.throwIfAborted()
    checkSnapshot(assets, snapshot)
    const modules = Object.entries(model.modules).map(([pluginId, module]) => {
      requireAsset(snapshot, module.url, pluginId)
      return module.url
    })
    const index = expectedIndex(snapshot, modules)
    const origin = `http://127.0.0.1:${options.port}`
    for (const [url, fingerprint] of snapshot) {
      controller.signal.throwIfAborted()
      const canonical = publicAssetUrl(url)
      if (canonical !== url) throw new Error(`runtime assets: invalid URL ${url}`)
      await verifyResponse(origin, url, url === '/index.html' ? index : fingerprint, controller.signal)
    }
    await verifyResponse(origin, '/', index, controller.signal)
    checkSnapshot(assets, snapshot)
    controller.signal.throwIfAborted()
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

