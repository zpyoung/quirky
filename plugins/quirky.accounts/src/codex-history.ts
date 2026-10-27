import { createHash } from 'node:crypto'
import { constants, type Dirent, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

const CODEX_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const CODEX_ROLLOUT_RELATIVE_PATH = /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/:]+\.jsonl(?:\.zst)?$/
const MAX_FALLBACK_COPY_BYTES = 256 * 1024 * 1024

const INVALID_SOURCE = 'The Codex rollout is not a trusted dated file for this provider session. Keep the previous session or restore its original rollout before retrying.'
const MISSING_SOURCE = 'The Codex conversation rollout is missing or unavailable in its recorded source home. Keep the previous session or restore the rollout before retrying.'
const TARGET_CONFLICT = 'A different Codex rollout already occupies the selected account path. Resolve that file conflict before retrying.'
const COPY_FAILED = 'The Codex conversation could not be copied safely into the selected account. Verify that both Codex sessions folders are readable and writable, then retry.'

export type CodexResumeMetadata = {
  sourceSessionId: string
  providerSession: { id: string; transcriptPath: string | null }
}

export class CodexHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexHistoryError'
  }
}

type ResumePaths = {
  sourcePath: string
  targetPath: string
  relativePath: string
}


/** Makes one dated rollout visible to Codex's ID-based resume lookup before spawn. */
export async function prepareCodexHistoryResume(args: {
  resume: CodexResumeMetadata
  sourceHomes: readonly string[]
  targetHome: string
}): Promise<string> {
  const paths = await resolveResumePaths(args)
  await assertSafeTargetDirectories(args.targetHome, paths.relativePath)
  if (resolve(paths.sourcePath) === resolve(paths.targetPath)) return paths.targetPath

  const existing = await lstatIfPresent(paths.targetPath)
  if (existing) {
    await assertMatchingExistingTarget(paths.sourcePath, paths.targetPath)
    return paths.targetPath
  }

  const parts = paths.relativePath.split(/[\\/]/)
  await ensureTargetDirectories(args.targetHome, parts.slice(0, -1))
  try {
    await link(paths.sourcePath, paths.targetPath)
    await assertMatchingExistingTarget(paths.sourcePath, paths.targetPath)
    return paths.targetPath
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      await assertMatchingExistingTarget(paths.sourcePath, paths.targetPath)
      return paths.targetPath
    }
  }

  try {
    await copyWithoutOverwrite(paths.sourcePath, paths.targetPath)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      await assertMatchingExistingTarget(paths.sourcePath, paths.targetPath)
      return paths.targetPath
    }
    if (error instanceof CodexHistoryError) throw error
    throw new CodexHistoryError(COPY_FAILED, { cause: error })
  }
  return paths.targetPath
}

async function resolveResumePaths(args: {
  resume: CodexResumeMetadata
  sourceHomes: readonly string[]
  targetHome: string
}): Promise<ResumePaths> {
  const sessionId = args.resume.providerSession.id
  if (!CODEX_SESSION_ID.test(sessionId)) throw new CodexHistoryError(INVALID_SOURCE)
  const homes = uniqueAbsoluteHomes(args.sourceHomes)
  if (homes.length === 0 || !isAbsolute(args.targetHome)) throw new CodexHistoryError(INVALID_SOURCE)

  const capturedPath = args.resume.providerSession.transcriptPath
  const source = capturedPath === null
    ? await findRolloutBySessionId(homes, sessionId)
    : await resolveCapturedRollout(homes, capturedPath, sessionId)
  if (!source) throw new CodexHistoryError(MISSING_SOURCE)

  const relativePath = validateDatedRollout(source.relativePath, sessionId)
  const targetHome = resolve(args.targetHome)
  return {
    sourcePath: source.path,
    targetPath: join(targetHome, 'sessions', ...relativePath.split(/[\\/]/)),
    relativePath
  }
}

async function resolveCapturedRollout(
  homes: readonly string[],
  transcriptPath: string,
  sessionId: string
): Promise<{ path: string; relativePath: string } | null> {
  if (!transcriptPath.trim() || !isAbsolute(transcriptPath) || hasTraversal(transcriptPath)) {
    throw new CodexHistoryError(INVALID_SOURCE)
  }
  for (const home of homes) {
    const sessionsRoot = join(home, 'sessions')
    const relativePath = relativeInside(sessionsRoot, transcriptPath)
    if (relativePath === null) continue
    const homeStat = await lstatIfPresent(home)
    if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) throw new CodexHistoryError(MISSING_SOURCE)
    const path = await resolveExistingRolloutPath(sessionsRoot, transcriptPath, relativePath, sessionId)
    if (path) {
      const resolvedRelativePath = relativeInside(sessionsRoot, path)
      if (resolvedRelativePath === null) throw new CodexHistoryError(INVALID_SOURCE)
      return { path, relativePath: resolvedRelativePath }
    }
    throw new CodexHistoryError(MISSING_SOURCE)
  }
  throw new CodexHistoryError(INVALID_SOURCE)
}

async function resolveExistingRolloutPath(
  sessionsRoot: string,
  persistedPath: string,
  persistedRelativePath: string,
  sessionId: string
): Promise<string | null> {
  const candidates = persistedPath.endsWith('.jsonl.zst')
    ? [persistedPath.slice(0, -'.zst'.length), persistedPath]
    : persistedPath.endsWith('.jsonl')
      ? [persistedPath, `${persistedPath}.zst`]
      : []
  if (candidates.length === 0) throw new CodexHistoryError(INVALID_SOURCE)

  for (const candidate of candidates) {
    const relativePath = relativeInside(sessionsRoot, candidate)
    if (relativePath === null) throw new CodexHistoryError(INVALID_SOURCE)
    validateDatedRollout(relativePath, sessionId)
    if (!sameRolloutStem(persistedRelativePath, relativePath)) throw new CodexHistoryError(INVALID_SOURCE)
    await assertSourceDirectories(sessionsRoot, relativePath)
    const stat = await lstatIfPresent(candidate)
    if (!stat) continue
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CodexHistoryError(INVALID_SOURCE)
    return candidate
  }
  return null
}

async function findRolloutBySessionId(
  homes: readonly string[],
  sessionId: string
): Promise<{ path: string; relativePath: string } | null> {
  const expectedSuffix = `-${sessionId.toLowerCase()}.jsonl`
  for (const home of homes) {
    const homeStat = await lstatIfPresent(home)
    if (!homeStat) continue
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) throw new CodexHistoryError(INVALID_SOURCE)
    const sessionsRoot = join(home, 'sessions')
    const sessionsStat = await lstatIfPresent(sessionsRoot)
    if (!sessionsStat) continue
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) throw new CodexHistoryError(INVALID_SOURCE)

    let years
    try {
      years = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      throw new CodexHistoryError(MISSING_SOURCE, { cause: error })
    }
    for (const year of years) {
      if (!/^\d{4}$/.test(year.name)) continue
      const yearPath = join(sessionsRoot, year.name)
      if (year.isSymbolicLink()) throw new CodexHistoryError(INVALID_SOURCE)
      if (!year.isDirectory()) continue
      for (const month of await readDatedDirectory(yearPath)) {
        if (!/^\d{2}$/.test(month.name)) continue
        if (month.isSymbolicLink()) throw new CodexHistoryError(INVALID_SOURCE)
        if (!month.isDirectory()) continue
        const monthPath = join(yearPath, month.name)
        for (const day of await readDatedDirectory(monthPath)) {
          if (!/^\d{2}$/.test(day.name)) continue
          if (day.isSymbolicLink()) throw new CodexHistoryError(INVALID_SOURCE)
          if (!day.isDirectory()) continue
          const dayPath = join(monthPath, day.name)
          const files = await readDatedDirectory(dayPath)
          const candidates = files
            .filter((entry) => isMatchingRolloutName(entry.name, expectedSuffix))
            .sort((left, right) => Number(left.name.endsWith('.zst')) - Number(right.name.endsWith('.zst')))
          for (const entry of candidates) {
            if (entry.isSymbolicLink()) throw new CodexHistoryError(INVALID_SOURCE)
            if (!entry.isFile()) continue
            const path = join(dayPath, entry.name)
            const relativePath = relative(sessionsRoot, path)
            await assertSourceDirectories(sessionsRoot, relativePath)
            const stat = await lstatIfPresent(path)
            if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new CodexHistoryError(INVALID_SOURCE)
            return { path, relativePath }
          }
        }
      }
    }
  }
  return null
}

async function readDatedDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new CodexHistoryError(MISSING_SOURCE, { cause: error })
  }
}

function isMatchingRolloutName(name: string, expectedSuffix: string): boolean {
  const plainName = name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name
  return /^rollout-[^/:]+\.jsonl$/.test(plainName) && plainName.toLowerCase().endsWith(expectedSuffix)
}

function validateDatedRollout(relativePath: string, sessionId: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!CODEX_ROLLOUT_RELATIVE_PATH.test(normalized)) throw new CodexHistoryError(INVALID_SOURCE)
  const name = basename(normalized)
  const plainName = name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name
  if (!/^rollout-[^/:]+\.jsonl$/.test(plainName) || !plainName.toLowerCase().endsWith(`-${sessionId.toLowerCase()}.jsonl`)) {
    throw new CodexHistoryError(INVALID_SOURCE)
  }
  return normalized
}

function sameRolloutStem(left: string, right: string): boolean {
  return left.replace(/\.zst$/, '') === right.replace(/\.zst$/, '')
}

async function assertSourceDirectories(sessionsRoot: string, relativePath: string): Promise<void> {
  const normalized = relativePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (parts.length !== 4 || !CODEX_ROLLOUT_RELATIVE_PATH.test(normalized)) throw new CodexHistoryError(INVALID_SOURCE)
  const homeStat = await lstatIfPresent(dirname(sessionsRoot))
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) throw new CodexHistoryError(MISSING_SOURCE)
  const sessionsStat = await lstatIfPresent(sessionsRoot)
  if (!sessionsStat || sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) throw new CodexHistoryError(MISSING_SOURCE)
  let current = sessionsRoot
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const stat = await lstatIfPresent(current)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new CodexHistoryError(MISSING_SOURCE)
  }
}

async function assertSafeTargetDirectories(targetHome: string, relativePath: string): Promise<void> {
  const parts = relativePath.split(/[\\/]/)
  if (parts.length !== 4 || !isAbsolute(targetHome)) throw new CodexHistoryError(TARGET_CONFLICT)
  let current = resolve(targetHome)
  for (const part of ['', 'sessions', ...parts.slice(0, -1)]) {
    if (part) current = join(current, part)
    const stat = await lstatIfPresent(current)
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new CodexHistoryError(TARGET_CONFLICT)
    if (!stat) break
  }
}

async function ensureTargetDirectories(targetHome: string, parts: readonly string[]): Promise<void> {
  const directories = [resolve(targetHome)]
  let current = resolve(targetHome)
  for (const part of ['sessions', ...parts]) {
    current = join(current, part)
    directories.push(current)
  }
  for (const directory of directories) {
    let stat = await lstatIfPresent(directory)
    if (!stat) {
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      stat = await lstatIfPresent(directory)
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new CodexHistoryError(TARGET_CONFLICT)
  }
}

async function assertMatchingExistingTarget(sourcePath: string, targetPath: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([lstatIfPresent(sourcePath), lstatIfPresent(targetPath)])
  if (!sourceStat || !targetStat) throw new CodexHistoryError(MISSING_SOURCE)
  if (
    !sourceStat.isFile() || sourceStat.isSymbolicLink() ||
    !targetStat.isFile() || targetStat.isSymbolicLink() ||
    sourceStat.size !== targetStat.size
  ) throw new CodexHistoryError(TARGET_CONFLICT)
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) return
  try {
    if (await fileDigest(sourcePath) === await fileDigest(targetPath)) return
  } catch (error) {
    throw new CodexHistoryError(TARGET_CONFLICT, { cause: error })
  }
  throw new CodexHistoryError(TARGET_CONFLICT)
}
async function openVerifiedRegularFile(path: string, flags: number): Promise<FileHandle> {
  const pathStat = await lstatIfPresent(path)
  if (!pathStat) throw new CodexHistoryError(MISSING_SOURCE)
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new CodexHistoryError(INVALID_SOURCE)
  const handle = await open(path, flags)
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new CodexHistoryError(INVALID_SOURCE)
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function fileDigest(path: string): Promise<string> {
  const handle = await openVerifiedRegularFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function copyWithoutOverwrite(sourcePath: string, targetPath: string): Promise<void> {
  const sourceHandle = await openVerifiedRegularFile(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let targetHandle: FileHandle | null = null
  let createdTarget = false
  try {
    const sourceStat = await sourceHandle.stat({ bigint: true })
    if (!sourceStat.isFile() || sourceStat.size > BigInt(MAX_FALLBACK_COPY_BYTES)) {
      throw new CodexHistoryError(COPY_FAILED)
    }
    targetHandle = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    createdTarget = true
    let copied = 0n
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        copied += BigInt(chunk.byteLength)
        if (copied > BigInt(MAX_FALLBACK_COPY_BYTES)) {
          callback(new CodexHistoryError(COPY_FAILED))
          return
        }
        callback(null, chunk)
      }
    })
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      limiter,
      targetHandle.createWriteStream({ autoClose: false })
    )
    const [sourceAfter, targetStat] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      targetHandle.stat({ bigint: true })
    ])
    if (
      copied !== sourceStat.size || targetStat.size !== copied ||
      sourceAfter.size !== sourceStat.size || sourceAfter.mtimeNs !== sourceStat.mtimeNs || sourceAfter.ctimeNs !== sourceStat.ctimeNs
    ) throw new CodexHistoryError(COPY_FAILED)
  } catch (error) {
    if (targetHandle) {
      await targetHandle.close().catch(() => {})
      targetHandle = null
    }
    if (createdTarget) await rm(targetPath, { force: true }).catch(() => {})
    throw error
  } finally {
    if (targetHandle) await targetHandle.close().catch(() => {})
    await sourceHandle.close().catch(() => {})
  }
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function relativeInside(root: string, path: string): string | null {
  const comparisonRoot = trustedPathComparisonCopy(root)
  const comparisonPath = trustedPathComparisonCopy(path)
  if (!comparisonRoot || !comparisonPath) return null
  const result = relative(resolve(comparisonRoot), resolve(comparisonPath))
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) return null
  return result
}

function trustedPathComparisonCopy(path: string): string | null {
  if (path.startsWith('\\\\.\\')) return null
  if (!path.startsWith('\\\\?\\')) return path
  return path.match(/^\\\\\?\\([A-Za-z]:[\\/][\s\S]*)$/)?.[1] ?? null
}

function uniqueAbsoluteHomes(homes: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const home of homes) {
    if (!isAbsolute(home)) continue
    const normalized = resolve(home)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === '..')
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}
