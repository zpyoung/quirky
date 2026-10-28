import type { MobileBundleAsset, MobileBundleManifest, MobileBundleManifestResult, MobileBundleReadResult, MobileGrant } from '../contracts'
import { MOBILE_BUNDLE_LIMITS } from '../contracts'

export type StoredGeneration = { manifest: MobileBundleManifest; directory: string; activatedAt: number }
export type GenerationStage = {
  readonly directory: string
  writeAsset(path: string, bytes: Uint8Array): Promise<void>
  activate(manifest: MobileBundleManifest): Promise<StoredGeneration>
  discard(): Promise<void>
}
export type GenerationStore = {
  getActive(hostId: string): Promise<StoredGeneration | null>
  begin(hostId: string, manifest: MobileBundleManifest): Promise<GenerationStage>
  touch(hostId: string, at: number): Promise<void>
  pruneHosts(keepHostId: string, maxHosts: number): Promise<void>
}
export type BundleFileEntry = { name: string; isDirectory: boolean; modifiedAt: number }
export type BundleFileSystem = {
  exists(path: string): Promise<boolean>
  createDirectory(path: string): Promise<void>
  listDirectory(path: string): Promise<BundleFileEntry[]>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  movePath(source: string, destination: string): Promise<void>
  removePath(path: string): Promise<void>
}
export type BundleSha256 = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array
export type BundleProgress = { receivedBytes: number; totalBytes: number }
export type BundleChunkFetcher = (buildId: string, path: string, offset: number) => Promise<MobileBundleReadResult>

const GRANT: Record<string, true> = {
  rpc: true, terminal: true, storage: true, navigate: true,
  'clipboard.read': true, 'clipboard.write': true, externalLink: true, haptics: true
}
const WORKSPACE_GRANTS: readonly MobileGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'externalLink']
const SESSION_GRANTS: readonly MobileGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink']
const ASSET_CONTENT_TYPE = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;\s*charset=utf-8)?$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const SAFE_ASSET_PART = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_RANGE_BYTES = 128 * 1024
let generationNonce = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\\') || value.includes('%') || value.includes('\0')) return false
  return value.split('/').every((part) => {
    const last = part.charCodeAt(part.length - 1)
    return part.length > 0 && part !== '.' && part !== '..' && last !== 0x0a && last !== 0x0d &&
      last !== 0x2028 && last !== 0x2029 && SAFE_ASSET_PART.test(part)
  })
}

function isRoutePath(value: unknown): value is string {
  return value === '/' || value === '/session'
}

function sameGrants(actual: unknown, expected: readonly MobileGrant[]): actual is MobileGrant[] {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const seen: Record<string, true> = {}
  for (const grant of actual) {
    if (typeof grant !== 'string' || !Object.hasOwn(GRANT, grant) || Object.hasOwn(seen, grant)) return false
    seen[grant] = true
  }
  return expected.every((grant) => Object.hasOwn(seen, grant))
}

export function validateBundleManifest(value: unknown): MobileBundleManifest {
  if (!isRecord(value) || !hasExactKeys(value, ['v', 'shellVersion', 'buildId', 'assets', 'totalBytes', 'routes'])) throw new Error('mobile bundle manifest has an invalid shape')
  if (value.v !== 1 || value.shellVersion !== 1) throw new Error('mobile bundle shell version is unsupported')
  if (typeof value.buildId !== 'string' || !SHA256_HEX.test(value.buildId)) throw new Error('mobile bundle build ID is invalid')
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > MOBILE_BUNDLE_LIMITS.assets) throw new Error('mobile bundle asset count is outside supported limits')
  if (!Array.isArray(value.routes) || value.routes.length !== 2 || value.routes.length > MOBILE_BUNDLE_LIMITS.routes) throw new Error('mobile bundle route count is invalid')
  if (!Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 1 || (value.totalBytes as number) > MOBILE_BUNDLE_LIMITS.totalBytes) throw new Error('mobile bundle total size is outside supported limits')

  let totalBytes = 0
  const paths: Record<string, true> = {}
  for (const rawAsset of value.assets) {
    if (!isRecord(rawAsset) || !hasExactKeys(rawAsset, ['path', 'bytes', 'sha256', 'contentType'])) throw new Error('mobile bundle asset entry has an invalid shape')
    if (!isAssetPath(rawAsset.path)) throw new Error('mobile bundle asset path is unsafe')
    if (Object.hasOwn(paths, rawAsset.path)) throw new Error('mobile bundle contains a duplicate asset path')
    paths[rawAsset.path] = true
    if (!Number.isSafeInteger(rawAsset.bytes) || (rawAsset.bytes as number) < 1 || (rawAsset.bytes as number) > MOBILE_BUNDLE_LIMITS.assetBytes) throw new Error('mobile bundle asset size is outside supported limits')
    if (typeof rawAsset.sha256 !== 'string' || !SHA256_HEX.test(rawAsset.sha256)) throw new Error('mobile bundle asset hash is invalid')
    if (typeof rawAsset.contentType !== 'string' || rawAsset.contentType.length > 128 || !ASSET_CONTENT_TYPE.test(rawAsset.contentType)) throw new Error('mobile bundle asset content type is invalid')
    totalBytes += rawAsset.bytes as number
  }
  if (totalBytes !== value.totalBytes) throw new Error('mobile bundle total size does not match its assets')

  const routeKinds: Record<string, true> = {}
  for (const rawRoute of value.routes) {
    if (!isRecord(rawRoute) || !hasExactKeys(rawRoute, ['kind', 'path', 'grants'])) throw new Error('mobile bundle route entry has an invalid shape')
    if (rawRoute.kind !== 'workspaces' && rawRoute.kind !== 'session') throw new Error('mobile bundle route is unsupported')
    if (!isRoutePath(rawRoute.path) || (rawRoute.kind === 'workspaces' && rawRoute.path !== '/') || (rawRoute.kind === 'session' && rawRoute.path !== '/session')) throw new Error('mobile bundle route path is unsupported')
    if (Object.hasOwn(routeKinds, rawRoute.kind)) throw new Error('mobile bundle contains a duplicate route')
    routeKinds[rawRoute.kind] = true
    const expected = rawRoute.kind === 'workspaces' ? WORKSPACE_GRANTS : SESSION_GRANTS
    if (!sameGrants(rawRoute.grants, expected)) throw new Error(`mobile bundle ${rawRoute.kind} grants are unsupported`)
  }
  if (!Object.hasOwn(routeKinds, 'workspaces') || !Object.hasOwn(routeKinds, 'session')) throw new Error('mobile bundle is missing a required route')
  return value as unknown as MobileBundleManifest
}

function isPlainResponse(value: unknown): value is MobileBundleReadResult {
  return isRecord(value) && hasExactKeys(value, ['buildId', 'path', 'offset', 'data', 'encoding', 'eof', 'sha256']) &&
    typeof value.buildId === 'string' && typeof value.path === 'string' && Number.isSafeInteger(value.offset) &&
    typeof value.data === 'string' && (value.encoding === 'identity' || value.encoding === 'gzip') &&
    typeof value.eof === 'boolean' && typeof value.sha256 === 'string'
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('mobile bundle chunk is not canonical base64')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const output = new Uint8Array(value.length / 4 * 3 - padding)
  let outputOffset = 0
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value[index]!)
    const b = BASE64.indexOf(value[index + 1]!)
    const c = value[index + 2] === '=' ? 0 : BASE64.indexOf(value[index + 2]!)
    const d = value[index + 3] === '=' ? 0 : BASE64.indexOf(value[index + 3]!)
    const bits = (a << 18) | (b << 12) | (c << 6) | d
    if (outputOffset < output.length) output[outputOffset++] = (bits >>> 16) & 0xff
    if (outputOffset < output.length) output[outputOffset++] = (bits >>> 8) & 0xff
    if (outputOffset < output.length) output[outputOffset++] = bits & 0xff
  }
  return output
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkBytes = 3 * 8192
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    const end = Math.min(bytes.length, start + chunkBytes)
    let chunk = ''
    for (let index = start; index < end; index += 3) {
      const first = bytes[index]!
      const hasSecond = index + 1 < end
      const hasThird = index + 2 < end
      const second = hasSecond ? bytes[index + 1]! : 0
      const third = hasThird ? bytes[index + 2]! : 0
      const value = (first << 16) | (second << 8) | third
      chunk += BASE64[(value >>> 18) & 0x3f]!
      chunk += BASE64[(value >>> 12) & 0x3f]!
      chunk += hasSecond ? BASE64[(value >>> 6) & 0x3f]! : '='
      chunk += hasThird ? BASE64[value & 0x3f]! : '='
    }
    chunks.push(chunk)
  }
  return chunks.join('')
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
function canonicalBuildIdBytes(manifest: MobileBundleManifest): Uint8Array {
  let canonical = `v=${manifest.v}\nshellVersion=${manifest.shellVersion}\n`
  const assets = [...manifest.assets].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  for (const asset of assets) canonical += `${asset.path}\0${asset.bytes}\0${asset.sha256}\0${asset.contentType}\n`
  return encodeUtf8(canonical)
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, '')}/${child}`
}

function assetPath(root: string, assetPathValue: string): string {
  if (!isAssetPath(assetPathValue)) throw new Error('mobile bundle asset path is unsafe')
  return assetPathValue.split('/').reduce((path, part) => joinPath(path, part), root)
}

function hostIdHash(sha256: BundleSha256, hostId: string): Promise<string> {
  if (typeof hostId !== 'string' || hostId.length === 0 || hostId.length > 256) throw new Error('mobile cache host ID is invalid')
  return Promise.resolve(sha256(encodeUtf8(hostId))).then(bytesToHex)
}

function safeGenerationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}-[a-z0-9-]{1,48}$/.test(value)
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

export async function createGenerationStore(fs: BundleFileSystem, root: string, sha256: BundleSha256, now: () => number = Date.now): Promise<GenerationStore> {
  if (root.length === 0 || /[\0\r\n]/.test(root)) throw new Error('mobile cache root is invalid')
  await fs.createDirectory(root)
  let nextGeneration = 0

  const hostDirectory = async (hostId: string) => joinPath(root, await hostIdHash(sha256, hostId))
  const readMarkers = async (hostPath: string) => (await fs.listDirectory(joinPath(hostPath, 'activations')))
    .filter((entry) => !entry.isDirectory && /^active-[0-9]{16}\.json$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name))

  async function verifyGeneration(hostPath: string, generationKey: string, expectedBuildId: string): Promise<StoredGeneration | null> {
    if (!safeGenerationKey(generationKey)) return null
    const directory = joinPath(joinPath(hostPath, 'generations'), generationKey)
    try {
      const rawManifest = parseJsonBytes(await fs.readFile(joinPath(directory, 'manifest.json')))
      const manifest = validateBundleManifest(rawManifest)
      if (manifest.buildId !== expectedBuildId ||
        bytesToHex(await sha256(canonicalBuildIdBytes(manifest))) !== manifest.buildId) return null
      for (const asset of manifest.assets) {
        const bytes = await fs.readFile(assetPath(directory, asset.path))
        if (bytes.byteLength !== asset.bytes || bytesToHex(await sha256(bytes)) !== asset.sha256) return null
      }
      return { manifest, directory, activatedAt: 0 }
    } catch {
      return null
    }
  }

  async function highestActivationSequence(hostPath: string): Promise<number> {
    let highest = 0
    for (const entry of await fs.listDirectory(joinPath(hostPath, 'activations'))) {
      const match = /^active-([0-9]{16})\.json$/.exec(entry.name)
      if (match) highest = Math.max(highest, Number(match[1]))
    }
    return highest
  }

  return {
    async getActive(hostId) {
      const hostPath = await hostDirectory(hostId)
      if (!await fs.exists(hostPath)) return null
      for (const marker of await readMarkers(hostPath)) {
        try {
          const value = parseJsonBytes(await fs.readFile(joinPath(joinPath(hostPath, 'activations'), marker.name)))
          if (!isRecord(value) || !hasExactKeys(value, ['generationKey', 'buildId', 'activatedAt']) || !safeGenerationKey(value.generationKey) || typeof value.buildId !== 'string' || !SHA256_HEX.test(value.buildId) || !Number.isSafeInteger(value.activatedAt)) continue
          const installed = await verifyGeneration(hostPath, value.generationKey, value.buildId)
          if (installed) {
            const active = { ...installed, activatedAt: value.activatedAt as number }
            await this.touch(hostId, now())
            return active
          }
        } catch {
          continue
        }
      }
      return null
    },

    async begin(hostId, manifestValue) {
      const manifest = validateBundleManifest(manifestValue)
      const hostPath = await hostDirectory(hostId)
      const stagingRoot = joinPath(hostPath, 'staging')
      const generationsRoot = joinPath(hostPath, 'generations')
      const activationsRoot = joinPath(hostPath, 'activations')
      await fs.createDirectory(stagingRoot)
      await fs.createDirectory(generationsRoot)
      await fs.createDirectory(activationsRoot)
      const generationKey = `${manifest.buildId}-${now().toString(36)}-${(++nextGeneration).toString(36)}`
      if (!safeGenerationKey(generationKey)) throw new Error('mobile bundle generation key is invalid')
      const stageDirectory = joinPath(stagingRoot, generationKey)
      await fs.createDirectory(stageDirectory)
      const expected = new Map(manifest.assets.map((asset) => [asset.path, asset]))
      const written = new Set<string>()
      let finished = false

      return {
        directory: stageDirectory,
        async writeAsset(path, bytes) {
          const asset = expected.get(path)
          if (!asset || written.has(path) || bytes.byteLength !== asset.bytes) throw new Error('mobile bundle stage received an unexpected asset')
          const target = assetPath(stageDirectory, path)
          const relativeParts = path.split('/')
          let directory = stageDirectory
          for (const part of relativeParts.slice(0, -1)) {
            directory = joinPath(directory, part)
            await fs.createDirectory(directory)
          }
          await fs.writeFile(target, bytes)
          written.add(path)
        },
        async activate(nextManifest) {
          if (finished || validateBundleManifest(nextManifest).buildId !== manifest.buildId || written.size !== expected.size) throw new Error('mobile bundle stage is incomplete')
          if (bytesToHex(await sha256(canonicalBuildIdBytes(manifest))) !== manifest.buildId) throw new Error('mobile bundle build ID does not match its assets')
          for (const asset of manifest.assets) {
            if (!written.has(asset.path)) throw new Error('mobile bundle stage is missing an asset')
            const bytes = await fs.readFile(assetPath(stageDirectory, asset.path))
            if (bytes.byteLength !== asset.bytes || bytesToHex(await sha256(bytes)) !== asset.sha256) throw new Error('mobile bundle stage asset hash mismatch')
          }
          await fs.writeFile(joinPath(stageDirectory, 'manifest.json'), encodeUtf8(JSON.stringify(manifest)))
          const finalDirectory = joinPath(generationsRoot, generationKey)
          await fs.movePath(stageDirectory, finalDirectory)
          const sequence = await highestActivationSequence(hostPath) + 1
          const markerName = `active-${String(sequence).padStart(16, '0')}.json`
          const markerTemporary = joinPath(activationsRoot, `${markerName}.tmp`)
          const markerFinal = joinPath(activationsRoot, markerName)
          const activatedAt = now()
          await fs.writeFile(markerTemporary, encodeUtf8(JSON.stringify({ generationKey, buildId: manifest.buildId, activatedAt })))
          await fs.movePath(markerTemporary, markerFinal)
          finished = true
          await fs.writeFile(joinPath(hostPath, 'host.json'), encodeUtf8(JSON.stringify({ hostId, lastUsedAt: activatedAt })))
          await pruneOldGenerations(fs, hostPath, generationKey)
          return { manifest, directory: finalDirectory, activatedAt }
        },
        async discard() {
          if (finished) return
          await fs.removePath(stageDirectory)
          const markers = await readMarkers(hostPath)
          const generations = await fs.listDirectory(generationsRoot)
          if (markers.length === 0 && generations.length === 0) await fs.removePath(hostPath)
        }
      }
    },

    async touch(hostId, at) {
      const hostPath = await hostDirectory(hostId)
      await fs.createDirectory(hostPath)
      await fs.writeFile(joinPath(hostPath, 'host.json'), encodeUtf8(JSON.stringify({ hostId, lastUsedAt: at })))
    },

    async pruneHosts(keepHostId, maxHosts) {
      if (!Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new Error('mobile cache host limit is invalid')
      const entries = await fs.listDirectory(root)
      const hosts: { hostId: string; lastUsedAt: number; directory: string }[] = []
      for (const entry of entries) {
        if (!entry.isDirectory) continue
        const directory = joinPath(root, entry.name)
        let hostId = entry.name
        let lastUsedAt = 0
        try {
          const metadata = parseJsonBytes(await fs.readFile(joinPath(directory, 'host.json')))
          if (isRecord(metadata) && typeof metadata.hostId === 'string' && Number.isSafeInteger(metadata.lastUsedAt)) {
            hostId = metadata.hostId
            lastUsedAt = metadata.lastUsedAt as number
          }
        } catch {}
        hosts.push({ hostId, lastUsedAt, directory })
      }
      const evicted = new Set(evictLeastRecentlyUsedHosts(hosts, maxHosts, keepHostId))
      for (const host of hosts) if (evicted.has(host.hostId)) await fs.removePath(host.directory)
    }
  }
}

async function pruneOldGenerations(fs: BundleFileSystem, hostPath: string, activeGenerationKey: string): Promise<void> {
  const markers = (await fs.listDirectory(joinPath(hostPath, 'activations')))
    .filter((entry) => !entry.isDirectory && /^active-[0-9]{16}\.json$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name))
  const keep = new Set(markers.slice(0, 2).map((entry) => entry.name))
  const keepKeys = new Set<string>([activeGenerationKey])
  for (const marker of markers) {
    if (keep.has(marker.name)) {
      try {
        const value = parseJsonBytes(await fs.readFile(joinPath(joinPath(hostPath, 'activations'), marker.name)))
        if (isRecord(value) && safeGenerationKey(value.generationKey)) keepKeys.add(value.generationKey)
      } catch {}
    } else {
      await fs.removePath(joinPath(joinPath(hostPath, 'activations'), marker.name))
    }
  }
  for (const entry of await fs.listDirectory(joinPath(hostPath, 'generations'))) {
    if (entry.isDirectory && !keepKeys.has(entry.name)) await fs.removePath(joinPath(joinPath(hostPath, 'generations'), entry.name))
  }
}

export function evictLeastRecentlyUsedHosts(hosts: readonly { hostId: string; lastUsedAt: number }[], maxHosts: number, keepHostId: string): string[] {
  if (!Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new Error('mobile cache host limit is invalid')
  const ordered = [...hosts].sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.hostId.localeCompare(right.hostId))
  const keep = new Set<string>(ordered.some((host) => host.hostId === keepHostId) ? [keepHostId] : [])
  for (let index = ordered.length - 1; index >= 0 && keep.size < maxHosts; index--) keep.add(ordered[index]!.hostId)
  return ordered.filter((host) => !keep.has(host.hostId)).map((host) => host.hostId)
}

export async function downloadBundle(
  hostId: string,
  result: MobileBundleManifestResult,
  fetchChunk: BundleChunkFetcher,
  store: GenerationStore,
  sha256: BundleSha256,
  onProgress?: (progress: BundleProgress) => void
): Promise<StoredGeneration> {
  const manifest = validateBundleManifest(result?.manifest)
  if (bytesToHex(await sha256(canonicalBuildIdBytes(manifest))) !== manifest.buildId) throw new Error('mobile bundle build ID does not match its assets')
  if (!Number.isSafeInteger(result.chunkBytes) || result.chunkBytes < 1 || result.chunkBytes > MAX_CHUNK_BYTES ||
    !Number.isSafeInteger(result.rangeBytes) || result.rangeBytes < 1 || result.rangeBytes > MAX_RANGE_BYTES) throw new Error('mobile bundle chunk limits are unsupported')
  const cached = await store.getActive(hostId)
  if (cached?.manifest.buildId === manifest.buildId) {
    await store.touch(hostId, Date.now())
    return cached
  }
  if (!cached) await store.pruneHosts(hostId, MOBILE_BUNDLE_LIMITS.hosts - 1)
  const stage = await store.begin(hostId, manifest)
  let activated = false
  try {
    let receivedBytes = 0
    for (const asset of manifest.assets) {
      const bytes = new Uint8Array(asset.bytes)
      let offset = 0
      while (offset < asset.bytes) {
        const raw = await fetchChunk(manifest.buildId, asset.path, offset)
        if (!isPlainResponse(raw) || raw.buildId !== manifest.buildId || raw.path !== asset.path || raw.offset !== offset || raw.encoding !== 'identity' || raw.sha256 !== asset.sha256) throw new Error('mobile bundle chunk metadata does not match its manifest')
        if (raw.data.length > Math.ceil(result.chunkBytes / 3) * 4 + 4) throw new Error('mobile bundle chunk exceeds its byte limit')
        const chunk = decodeBase64(raw.data)
        if (chunk.byteLength === 0 || chunk.byteLength > result.chunkBytes || offset + chunk.byteLength > asset.bytes) throw new Error('mobile bundle chunk has an invalid length')
        const eof = offset + chunk.byteLength === asset.bytes
        if (raw.eof !== eof) throw new Error('mobile bundle chunk has an invalid end marker')
        bytes.set(chunk, offset)
        offset += chunk.byteLength
        receivedBytes += chunk.byteLength
        onProgress?.({ receivedBytes, totalBytes: manifest.totalBytes })
      }
      if (bytesToHex(await sha256(bytes)) !== asset.sha256) throw new Error(`mobile bundle asset hash mismatch: ${asset.path}`)
      await stage.writeAsset(asset.path, bytes)
    }
    const installed = await stage.activate(manifest)
    activated = true
    await store.pruneHosts(hostId, MOBILE_BUNDLE_LIMITS.hosts)
    return installed
  } catch (error) {
    if (!activated) await stage.discard()
    throw error
  }
}
