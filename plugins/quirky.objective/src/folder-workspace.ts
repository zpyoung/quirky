import { constants as fsConstants, type BigIntStats, type ReadStream } from 'node:fs'
import { createHash, type Hash } from 'node:crypto'
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type WorkspaceKind = 'git' | 'folder'

export interface FolderEntry {
  path: string
  kind: 'file' | 'symlink'
  executable: boolean
  digest: string
}

export type TaskBaseline =
  | { kind: 'git'; treeOid: string }
  | { kind: 'folder'; version: 1; contentIdentity: string; entries: FolderEntry[] }

export type FolderObservation = Extract<TaskBaseline, { kind: 'folder' }>

const identityPrefix = 'objective-folder-v1:'
const manifestDomain = Buffer.from('objective-folder-manifest\0v1\0', 'utf8')
const readChunkSize = 64 * 1024

class FolderTreeError extends Error {
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'FolderTreeError'
  }
}

function fail(code: string, detail: string): never {
  throw new FolderTreeError(code, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => typeof key === 'string' && expected.includes(key))
}

function isUtf8String(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || !isUtf8String(value) || value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) || value.includes('\0') || value.includes('\\')) return false
  const components = value.split('/')
  return components.every(component => component !== '' && component !== '.' && component !== '..')
}

function isExcludedPath(path: string): boolean {
  return path.split('/').includes('.git') || path === '.quirky/objective' || path.startsWith('.quirky/objective/') ||
    path === '.orca/heimdall/lease' || path.startsWith('.orca/heimdall/lease/')
}

function comparePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function updateFrame(hash: Hash, bytes: Buffer): void {
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length)
  hash.update(bytes)
}

function contentIdentityForEntries(entries: readonly FolderEntry[]): string {
  const hash = createHash('sha256')
  hash.update(manifestDomain)
  for (const entry of entries) {
    updateFrame(hash, Buffer.from(entry.path, 'utf8'))
    updateFrame(hash, Buffer.from(entry.kind, 'ascii'))
    updateFrame(hash, Buffer.from(entry.executable ? [1] : [0]))
    updateFrame(hash, Buffer.from(entry.digest, 'hex'))
  }
  return `${identityPrefix}${hash.digest('hex')}`
}

function isFolderEntry(value: unknown): value is FolderEntry {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'kind', 'executable', 'digest'])) return false
  if (!validRelativePath(value.path) || isExcludedPath(value.path)) return false
  if (value.kind !== 'file' && value.kind !== 'symlink') return false
  if (typeof value.executable !== 'boolean' || (value.kind === 'symlink' && value.executable)) return false
  return typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
}

export function isFolderObservation(value: unknown): value is FolderObservation {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ['kind', 'version', 'contentIdentity', 'entries']) ||
      value.kind !== 'folder' || value.version !== 1 || typeof value.contentIdentity !== 'string' ||
      !value.contentIdentity.startsWith(identityPrefix) || !Array.isArray(value.entries)) return false
    if (Reflect.ownKeys(value.entries).length !== value.entries.length + 1) return false
    let previousPath: string | undefined
    for (let index = 0; index < value.entries.length; index++) {
      if (!(index in value.entries)) return false
      const entry: unknown = value.entries[index]
      if (!isFolderEntry(entry)) return false
      if (previousPath !== undefined && comparePathBytes(previousPath, entry.path) >= 0) return false
      previousPath = entry.path
    }
    return value.contentIdentity === contentIdentityForEntries(value.entries)
  } catch {
    return false
  }
}

export function isTaskBaseline(value: unknown): value is TaskBaseline {
  try {
    if (!isRecord(value)) return false
    if (value.kind === 'git') {
      return hasExactKeys(value, ['kind', 'treeOid']) && typeof value.treeOid === 'string' && value.treeOid.length > 0
    }
    return value.kind === 'folder' && isFolderObservation(value)
  } catch {
    return false
  }
}

function codeOf(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined
  return error.code
}

function filesystemFailure(error: unknown, racedCodes: boolean): never {
  if (error instanceof FolderTreeError) throw error
  const code = codeOf(error)
  if (racedCodes && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'EINVAL', 'ENXIO', 'ENODEV'].includes(code ?? '')) {
    fail('folder-tree-unstable', `path changed while observing (${code})`)
  }
  fail('folder-tree-unavailable', code ? `filesystem operation failed (${code})` : 'filesystem operation failed')
}

function statStamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.size,
    stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].map(String).join(':')
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return statStamp(left) === statStamp(right)
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid
}

async function lstatDuringScan(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    filesystemFailure(error, true)
  }
}

function decodeName(name: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(name)
    if (!decoded || !isUtf8String(decoded) || decoded === '.' || decoded === '..' || decoded.includes('/')) {
      fail('folder-tree-unsupported-path', 'filesystem entry name cannot be represented safely')
    }
    return decoded
  } catch (error) {
    if (error instanceof FolderTreeError) throw error
    fail('folder-tree-unsupported-path', 'filesystem entry name is not valid UTF-8')
  }
}

async function readRegularFile(path: string, expected: BigIntStats): Promise<string> {
  let handle: FileHandle | undefined
  let stream: ReadStream | undefined
  try {
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    handle = await open(path, flags)
    const descriptorBefore = await handle.stat({ bigint: true })
    if (!descriptorBefore.isFile() || !sameStat(expected, descriptorBefore)) {
      fail('folder-tree-unstable', 'regular file was replaced before reading')
    }

    const hash = createHash('sha256')
    stream = handle.createReadStream({ autoClose: false, highWaterMark: readChunkSize })
    for await (const chunk of stream) hash.update(chunk as Buffer)

    const descriptorAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstatDuringScan(path)
    if (!descriptorAfter.isFile() || !pathAfter.isFile() || !sameStat(expected, descriptorAfter) ||
      !sameStat(expected, pathAfter) || !sameStat(descriptorAfter, pathAfter)) {
      fail('folder-tree-unstable', 'regular file changed while reading')
    }
    return hash.digest('hex')
  } catch (error) {
    return filesystemFailure(error, true)
  } finally {
    stream?.destroy()
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
  }
}

async function readSymlink(path: string, expected: BigIntStats): Promise<string> {
  try {
    const target = await readlink(path, { encoding: 'buffer' })
    const after = await lstatDuringScan(path)
    if (!after.isSymbolicLink() || !sameStat(expected, after)) {
      fail('folder-tree-unstable', 'symbolic link changed while reading')
    }
    return createHash('sha256').update(target).digest('hex')
  } catch (error) {
    filesystemFailure(error, true)
  }
}

interface DirectoryWork {
  path: string
  relativePath: string
  expected: BigIntStats
}

async function scanManifest(rootPath: string): Promise<FolderEntry[]> {
  let rootStat: BigIntStats
  try {
    rootStat = await lstat(rootPath, { bigint: true })
  } catch (error) {
    filesystemFailure(error, false)
  }
  if (!rootStat.isDirectory()) fail('folder-tree-unsupported-path', 'workspace root is not a real directory')

  const pending: DirectoryWork[] = [{ path: rootPath, relativePath: '', expected: rootStat }]
  const entries: FolderEntry[] = []
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const directory = pending[cursor]
    const before = await lstatDuringScan(directory.path)
    if (!before.isDirectory() || !sameDirectory(directory.expected, before)) {
      fail('folder-tree-unstable', 'directory was replaced before reading')
    }

    let names: Buffer[]
    try {
      names = await readdir(directory.path, { encoding: 'buffer' })
    } catch (error) {
      filesystemFailure(error, true)
    }

    for (const rawName of names) {
      const name = decodeName(rawName)
      const relativePath = directory.relativePath ? `${directory.relativePath}/${name}` : name
      if (isExcludedPath(relativePath)) continue
      if (!validRelativePath(relativePath)) fail('folder-tree-unsupported-path', 'filesystem path is not representable safely')

      const absolutePath = join(directory.path, name)
      const entryStat = await lstatDuringScan(absolutePath)
      if (entryStat.isDirectory()) {
        pending.push({ path: absolutePath, relativePath, expected: entryStat })
      } else if (entryStat.isFile()) {
        entries.push({
          path: relativePath,
          kind: 'file',
          executable: (entryStat.mode & 0o111n) !== 0n,
          digest: await readRegularFile(absolutePath, entryStat)
        })
      } else if (entryStat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          kind: 'symlink',
          executable: false,
          digest: await readSymlink(absolutePath, entryStat)
        })
      } else {
        fail('folder-tree-unsupported-entry', `unsupported filesystem entry at ${relativePath}`)
      }
    }

    const after = await lstatDuringScan(directory.path)
    if (!after.isDirectory() || !sameDirectory(before, after)) {
      fail('folder-tree-unstable', 'directory changed while reading')
    }
  }

  entries.sort((left, right) => comparePathBytes(left.path, right.path))
  return entries
}

function sameManifest(left: readonly FolderEntry[], right: readonly FolderEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return entry.path === other.path && entry.kind === other.kind && entry.executable === other.executable &&
      entry.digest === other.digest
  })
}

export async function captureFolderObservation(workspacePath: string): Promise<FolderObservation> {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0 || !isUtf8String(workspacePath) ||
    workspacePath.includes('\0')) {
    fail('folder-tree-unsupported-path', 'workspace path is not representable safely')
  }
  const rootPath = resolve(workspacePath)
  const first = await scanManifest(rootPath)
  const second = await scanManifest(rootPath)
  if (!sameManifest(first, second)) fail('folder-tree-unstable', 'complete folder manifests did not match')

  const observation: FolderObservation = {
    kind: 'folder',
    version: 1,
    contentIdentity: contentIdentityForEntries(first),
    entries: first
  }
  if (!isFolderObservation(observation)) fail('folder-tree-unsupported-path', 'generated folder manifest was invalid')
  return observation
}
