import type { MobileBundleAsset, MobileBundleManifest, MobileBundleManifestResult, MobileBundleReadResult, MobileBundleRoute, MobilePageGrant } from '@quirky/protocol'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'

export const MOBILE_BUNDLE_CHUNK_BYTES = 256 * 1024
export const MOBILE_BUNDLE_RANGE_BYTES = 96 * 1024

export type MobileBundleErrorKind = 'invalid-params' | 'not-found' | 'conflict'
export class MobileBundleError extends Error {
  constructor(readonly kind: MobileBundleErrorKind, message: string) {
    super(message)
    this.name = 'MobileBundleError'
  }
}

const GRANTS: Record<string, true> = {
  rpc: true, terminal: true, storage: true, navigate: true,
  'clipboard.read': true, 'clipboard.write': true, externalLink: true, haptics: true
}
const WORKSPACE_GRANTS: readonly MobilePageGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'externalLink']
const SESSION_GRANTS: readonly MobilePageGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink']
const SHA256_HEX = /^[0-9a-f]{64}$/
const SAFE_ASSET_PART = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/
const MIME = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;\s*charset=utf-8)?$/

type BundleRequest = { buildId: string; path: string; offset: number }
type RangeRequest = BundleRequest & { gzip?: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function safeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\\') || value.includes('%') || value.includes('\0')) return false
  return value.split('/').every((part) => {
    const last = part.charCodeAt(part.length - 1)
    return part.length > 0 && part !== '.' && part !== '..' && last !== 0x0a && last !== 0x0d &&
      last !== 0x2028 && last !== 0x2029 && SAFE_ASSET_PART.test(part)
  })
}

function validGrantList(value: unknown, expected: readonly MobilePageGrant[]): value is MobilePageGrant[] {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  const seen: Record<string, true> = {}
  for (const item of value) {
    if (typeof item !== 'string' || !Object.hasOwn(GRANTS, item) || Object.hasOwn(seen, item)) return false
    seen[item] = true
  }
  return expected.every((grant) => Object.hasOwn(seen, grant))
}

function validateManifest(value: unknown): MobileBundleManifest {
  if (!isRecord(value) || !exactKeys(value, ['v', 'shellVersion', 'buildId', 'assets', 'totalBytes', 'routes'])) throw new MobileBundleError('conflict', 'mobile page bundle manifest is invalid')
  if (value.v !== 1 || value.shellVersion !== 1) throw new MobileBundleError('conflict', 'mobile page bundle shell version is unsupported')
  if (typeof value.buildId !== 'string' || !SHA256_HEX.test(value.buildId)) throw new MobileBundleError('conflict', 'mobile page bundle build ID is invalid')
  if (!Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 1 || (value.totalBytes as number) > 32 * 1024 * 1024) throw new MobileBundleError('conflict', 'mobile page bundle total size is invalid')
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 256) throw new MobileBundleError('conflict', 'mobile page bundle asset count is invalid')
  if (!Array.isArray(value.routes) || value.routes.length !== 2 || value.routes.length > 64) throw new MobileBundleError('conflict', 'mobile page bundle route count is invalid')

  let totalBytes = 0
  const seenPaths: Record<string, true> = {}
  for (const asset of value.assets) {
    if (!isRecord(asset) || !exactKeys(asset, ['path', 'bytes', 'sha256', 'contentType']) || !safeAssetPath(asset.path)) throw new MobileBundleError('conflict', 'mobile page bundle asset path or shape is invalid')
    if (Object.hasOwn(seenPaths, asset.path)) throw new MobileBundleError('conflict', 'mobile page bundle has duplicate asset paths')
    seenPaths[asset.path] = true
    if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 1 || (asset.bytes as number) > 10 * 1024 * 1024) throw new MobileBundleError('conflict', 'mobile page bundle asset size is invalid')
    if (typeof asset.sha256 !== 'string' || !SHA256_HEX.test(asset.sha256)) throw new MobileBundleError('conflict', 'mobile page bundle asset hash is invalid')
    if (typeof asset.contentType !== 'string' || asset.contentType.length > 128 || !MIME.test(asset.contentType)) throw new MobileBundleError('conflict', 'mobile page bundle content type is invalid')
    totalBytes += asset.bytes as number
  }
  if (totalBytes !== value.totalBytes) throw new MobileBundleError('conflict', 'mobile page bundle byte total does not match its assets')

  const seenKinds: Record<string, true> = {}
  for (const route of value.routes) {
    if (!isRecord(route) || !exactKeys(route, ['kind', 'path', 'grants']) ||
      (route.kind !== 'workspaces' && route.kind !== 'session') ||
      (route.kind === 'workspaces' ? route.path !== '/' : route.path !== '/session')) throw new MobileBundleError('conflict', 'mobile page bundle route is invalid')
    if (Object.hasOwn(seenKinds, route.kind)) throw new MobileBundleError('conflict', 'mobile page bundle has duplicate routes')
    seenKinds[route.kind] = true
    const grants = route.kind === 'workspaces' ? WORKSPACE_GRANTS : SESSION_GRANTS
    if (!validGrantList(route.grants, grants)) throw new MobileBundleError('conflict', 'mobile page bundle route grants are unsupported')
  }
  if (!Object.hasOwn(seenKinds, 'workspaces') || !Object.hasOwn(seenKinds, 'session')) throw new MobileBundleError('conflict', 'mobile page bundle route is missing')
  return value as unknown as MobileBundleManifest
}

function bundleRoot(pluginDir: string): string {
  const root = join(pluginDir, 'assets', 'mobile')
  try {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('invalid root')
    return realpathSync(root)
  } catch {
    throw new MobileBundleError('not-found', 'mobile page bundle is unavailable; run the mobile page bundle builder')
  }
}

function manifestAt(pluginDir: string): { root: string; manifest: MobileBundleManifest } {
  const root = bundleRoot(pluginDir)
  try {
    const file = join(root, 'manifest.json')
    const info = lstatSync(file)
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) throw new Error('invalid manifest file')
    const manifest = validateManifest(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    return { root, manifest }
  } catch (error) {
    if (error instanceof MobileBundleError) throw error
    throw new MobileBundleError('conflict', 'mobile page bundle manifest is unavailable or invalid')
  }
}

export function getMobileBundleManifest(pluginDir: string): MobileBundleManifestResult {
  const { manifest } = manifestAt(pluginDir)
  return { manifest, chunkBytes: MOBILE_BUNDLE_CHUNK_BYTES, rangeBytes: MOBILE_BUNDLE_RANGE_BYTES }
}

function parseRequest(value: unknown, allowGzip: boolean): BundleRequest | RangeRequest {
  const keys = allowGzip ? ['buildId', 'path', 'offset', 'gzip'] : ['buildId', 'path', 'offset']
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)) ||
    (typeof value.buildId !== 'string' || !SHA256_HEX.test(value.buildId)) || !safeAssetPath(value.path) ||
    !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
    (allowGzip && value.gzip !== undefined && typeof value.gzip !== 'boolean')) throw new MobileBundleError('invalid-params', 'mobile page bundle read params are invalid')
  return value as unknown as BundleRequest | RangeRequest
}

function checkedAsset(pluginDir: string, buildId: string, path: string): { manifest: MobileBundleManifest; asset: MobileBundleAsset; bytes: Buffer } {
  const { root, manifest } = manifestAt(pluginDir)
  if (manifest.buildId !== buildId) throw new MobileBundleError('conflict', 'mobile page bundle build changed; reload its manifest')
  const asset = manifest.assets.find((candidate) => candidate.path === path)
  if (!asset) throw new MobileBundleError('not-found', 'mobile page bundle asset is not listed in the manifest')
  const target = join(root, ...asset.path.split('/'))
  const relativePath = relative(root, target)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || win32.isAbsolute(relativePath)) throw new MobileBundleError('invalid-params', 'mobile page bundle asset path is unsafe')
  let bytes: Buffer
  try {
    const info = lstatSync(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('invalid asset file')
    const real = realpathSync(target)
    const relReal = relative(root, real)
    if (relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal) || win32.isAbsolute(relReal)) throw new Error('asset escapes bundle root')
    if (statSync(real).size !== asset.bytes) throw new Error('asset length changed')
    bytes = readFileSync(real)
  } catch {
    throw new MobileBundleError('conflict', 'mobile page bundle asset is unavailable or changed')
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) throw new MobileBundleError('conflict', 'mobile page bundle asset hash does not match the manifest')
  return { manifest, asset, bytes }
}

function readBytes(pluginDir: string, input: unknown, range: boolean): MobileBundleReadResult {
  const request = parseRequest(input, range)
  const { asset, bytes } = checkedAsset(pluginDir, request.buildId, request.path)
  const offset = request.offset
  const maximum = range ? MOBILE_BUNDLE_RANGE_BYTES : MOBILE_BUNDLE_CHUNK_BYTES
  if (offset > asset.bytes || (!range && offset !== asset.bytes && offset % MOBILE_BUNDLE_CHUNK_BYTES !== 0)) throw new MobileBundleError('invalid-params', 'mobile page bundle offset is invalid')
  const end = Math.min(asset.bytes, offset + maximum)
  const content = bytes.subarray(offset, end)
  const encoding = range && (request as RangeRequest).gzip === true ? 'gzip' : 'identity'
  const encoded = encoding === 'gzip' ? gzipSync(content) : content
  return {
    buildId: request.buildId,
    path: request.path,
    offset,
    data: encoded.toString('base64'),
    encoding,
    eof: end === asset.bytes,
    sha256: asset.sha256
  }
}

export function getMobileBundleChunk(pluginDir: string, params: unknown): MobileBundleReadResult {
  return readBytes(pluginDir, params, false)
}

export function getMobileBundleRange(pluginDir: string, params: unknown): MobileBundleReadResult {
  return readBytes(pluginDir, params, true)
}
