import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord as record } from './json'

export const WORKSPACE_LEASE_TTL_MS = 90_000
export const WORKSPACE_LEASE_RENEWAL_MS = 30_000
const HOLDER_MODE = 0o600
const DIRECTORY_MODE = 0o700
const MAX_HOLDER_BYTES = 1_024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export type WorkspaceKind = 'git' | 'folder'
export type WorkspaceLeaseClaim = { holderId: string; epoch: number }
export type WorkspaceLeaseAcquire =
  | ({ kind: 'acquired' } & WorkspaceLeaseClaim)
  | ({ kind: 'held' } & WorkspaceLeaseClaim)
  | { kind: 'unverifiable'; reason: 'workspace-unavailable' | 'lease-storage-unavailable' | 'lease-state-invalid' }
export interface WorkspaceLeaseAuthority {
  acquire(): WorkspaceLeaseAcquire
  assertHeld(claim: WorkspaceLeaseClaim): void
  renew(claim: WorkspaceLeaseClaim): boolean
  release(claim: WorkspaceLeaseClaim): boolean
}

type LeaseHolder = { holderId: string; epoch: number; renewedAtMs: number; releasedAtMs?: number }
type EpochEntry = { epoch: number; path: string; isDirectory: boolean }
type HolderState =
  | { kind: 'valid'; holder: LeaseHolder; mtimeMs: number }
  | { kind: 'missing'; mtimeMs: number }
  | { kind: 'invalid'; mtimeMs: number | null }

export class WorkspaceLeaseLostError extends Error {
  constructor() {
    super('workspace lease is no longer held at the expected epoch')
    this.name = 'WorkspaceLeaseLostError'
  }
}


function workspaceBase(workspacePath: string, workspaceKind: WorkspaceKind): { base: string; parts: string[] } {
  if (!isAbsolute(workspacePath)) throw new Error('workspace path is not absolute')
  const workspace = realpathSync.native(resolve(workspacePath))
  const workspaceStat = lstatSync(workspace)
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error('workspace path is not a regular directory')
  if (workspaceKind === 'folder') return { base: workspace, parts: ['.orca', 'heimdall', 'lease'] }

  const dotGit = join(workspace, '.git')
  const metadata = lstatSync(dotGit)
  if (metadata.isSymbolicLink()) throw new Error('git metadata is a symbolic link')
  let gitDir: string
  if (metadata.isDirectory()) {
    gitDir = realpathSync.native(dotGit)
  } else if (metadata.isFile()) {
    const data = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(data)
    if (!match) throw new Error('git worktree metadata is malformed')
    gitDir = realpathSync.native(resolve(workspace, match[1]!))
  } else {
    throw new Error('git metadata is not a regular directory or file')
  }
  if (!statSync(gitDir).isDirectory()) throw new Error('git metadata directory is unavailable')
  return { base: gitDir, parts: ['orca-heimdall', 'lease'] }
}

/** The workspace-host location that is shared by every kernel observing this workspace. */
export function workspaceLeaseDirectory(workspacePath: string, workspaceKind: WorkspaceKind): string {
  const { base, parts } = workspaceBase(workspacePath, workspaceKind)
  return join(base, ...parts)
}

function ensureChildDirectory(parent: string, name: string): string {
  const path = join(parent, name)
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE })
  } catch (error) {
    if (!record(error) || error.code !== 'EEXIST') throw error
  }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('lease directory is not a regular directory')
  return path
}

function ensureLeaseRoot(workspacePath: string, workspaceKind: WorkspaceKind): string {
  const { base, parts } = workspaceBase(workspacePath, workspaceKind)
  let current = base
  for (const part of parts) current = ensureChildDirectory(current, part)
  return current
}

function isExpired(mtimeMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - mtimeMs >= ttlMs
}

function safeEpochEntries(root: string): EpochEntry[] {
  const entries: EpochEntry[] = []
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const match = /^epoch-([1-9]\d*)$/.exec(item.name)
    if (!match) continue
    const epoch = Number(match[1])
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('lease epoch is invalid')
    entries.push({ epoch, path: join(root, item.name), isDirectory: item.isDirectory() && !item.isSymbolicLink() })
  }
  entries.sort((left, right) => left.epoch - right.epoch)
  return entries
}

function inspectHolder(epoch: EpochEntry): HolderState {
  const dirStat = lstatSync(epoch.path)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !epoch.isDirectory) {
    throw new Error('current lease epoch is not a regular directory')
  }
  const path = join(epoch.path, 'holder.json')
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return { kind: 'missing', mtimeMs: dirStat.mtimeMs }
    let mtimeMs: number | null = null
    try {
      const info = lstatSync(path)
      if (!info.isSymbolicLink() && info.isFile()) mtimeMs = info.mtimeMs
    } catch { /* No authority can be derived from an unreadable holder file. */ }
    return { kind: 'invalid', mtimeMs }
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o777) !== HOLDER_MODE || info.size > MAX_HOLDER_BYTES) {
      return { kind: 'invalid', mtimeMs: info.mtimeMs }
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, { encoding: 'utf8' }))
    if (!record(parsed) || typeof parsed.holderId !== 'string' || parsed.holderId.length === 0 ||
      !Number.isSafeInteger(parsed.epoch) || parsed.epoch !== epoch.epoch || !Number.isFinite(parsed.renewedAtMs) ||
      (Object.hasOwn(parsed, 'releasedAtMs') && !Number.isFinite(parsed.releasedAtMs))) {
      return { kind: 'invalid', mtimeMs: info.mtimeMs }
    }
    const holder: LeaseHolder = {
      holderId: parsed.holderId,
      epoch: parsed.epoch as number,
      renewedAtMs: parsed.renewedAtMs as number,
      ...(typeof parsed.releasedAtMs === 'number' ? { releasedAtMs: parsed.releasedAtMs } : {})
    }
    return { kind: 'valid', holder, mtimeMs: info.mtimeMs }
  } catch {
    let mtimeMs: number | null = null
    try { mtimeMs = fstatSync(fd).mtimeMs } catch { /* A failed stat remains unverifiable. */ }
    return { kind: 'invalid', mtimeMs }
  } finally {
    closeSync(fd)
  }
}

function atomicWrite(path: string, epochDirectory: string, value: LeaseHolder): void {
  const temporary = join(epochDirectory, `.holder-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, HOLDER_MODE)
    writeFileSync(fd, JSON.stringify(value))
    futimesSync(fd, value.renewedAtMs / 1_000, value.renewedAtMs / 1_000)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* The unique temporary is not authority. */ }
    throw error
  }
}

export function createWorkspaceLease(options: {
  workspacePath: string
  workspaceKind: WorkspaceKind
  holderId: string
  ttlMs?: number
  now?: () => number
}): WorkspaceLeaseAuthority {
  const ttlMs = options.ttlMs ?? WORKSPACE_LEASE_TTL_MS
  const now = options.now ?? Date.now
  const holderId = options.holderId
  if (holderId.length === 0 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid workspace lease identity or TTL')

  function currentEpoch(root: string): EpochEntry | null {
    const entries = safeEpochEntries(root)
    return entries.at(-1) ?? null
  }

  function claimIsCurrent(root: string, claim: WorkspaceLeaseClaim): boolean {
    const latest = currentEpoch(root)
    if (!latest || latest.epoch !== claim.epoch || !latest.isDirectory) return false
    const state = inspectHolder(latest)
    return state.kind === 'valid' && state.holder.holderId === claim.holderId &&
      state.holder.epoch === claim.epoch && state.holder.releasedAtMs === undefined &&
      !isExpired(state.mtimeMs, now(), ttlMs)
  }

  function assertHeld(claim: WorkspaceLeaseClaim): void {
    let root: string
    try {
      root = ensureLeaseRoot(options.workspacePath, options.workspaceKind)
      if (claim.holderId !== holderId || !claimIsCurrent(root, claim)) throw new WorkspaceLeaseLostError()
    } catch (error) {
      if (error instanceof WorkspaceLeaseLostError) throw error
      throw new WorkspaceLeaseLostError()
    }
  }

  function writeHolder(epoch: EpochEntry, value: LeaseHolder, create: boolean): void {
    const path = join(epoch.path, 'holder.json')
    if (create) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, HOLDER_MODE)
      try {
        writeFileSync(fd, JSON.stringify(value))
        futimesSync(fd, value.renewedAtMs / 1_000, value.renewedAtMs / 1_000)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      atomicWrite(path, epoch.path, value)
    }
  }

  function claimNext(root: string, epoch: number): boolean {
    const path = join(root, `epoch-${epoch}`)
    try {
      mkdirSync(path, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (record(error) && error.code === 'EEXIST') return false
      throw error
    }
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('claimed epoch is not a regular directory')
    const entry: EpochEntry = { epoch, path, isDirectory: true }
    writeHolder(entry, { holderId, epoch, renewedAtMs: now() }, true)
    return true
  }

  function acquire(): WorkspaceLeaseAcquire {
    let root: string
    try {
      root = ensureLeaseRoot(options.workspacePath, options.workspaceKind)
    } catch {
      return { kind: 'unverifiable', reason: 'workspace-unavailable' }
    }
    for (;;) {
      let latest: EpochEntry | null
      let state: HolderState | undefined
      try {
        latest = currentEpoch(root)
        if (latest) state = inspectHolder(latest)
      } catch {
        return { kind: 'unverifiable', reason: 'lease-state-invalid' }
      }
      if (!latest) {
        try {
          if (!claimNext(root, 1)) continue
          const claim = { holderId, epoch: 1 }
          if (claimIsCurrent(root, claim)) return { kind: 'acquired', ...claim }
          continue
        } catch {
          return { kind: 'unverifiable', reason: 'lease-storage-unavailable' }
        }
      }
      if (!state) return { kind: 'unverifiable', reason: 'lease-state-invalid' }
      const mtimeMs = state.mtimeMs
      const expired = mtimeMs !== null && isExpired(mtimeMs, now(), ttlMs)
      if (state.kind === 'valid' && state.holder.releasedAtMs === undefined && !expired) {
        if (state.holder.holderId !== holderId) {
          return { kind: 'held', holderId: state.holder.holderId, epoch: latest.epoch }
        }
        const claim = { holderId, epoch: latest.epoch }
        try {
          if (!claimIsCurrent(root, claim)) continue
          writeHolder(latest, { holderId, epoch: latest.epoch, renewedAtMs: now() }, false)
          if (claimIsCurrent(root, claim)) return { kind: 'acquired', ...claim }
          continue
        } catch {
          return { kind: 'unverifiable', reason: 'lease-storage-unavailable' }
        }
      }
      if (state.kind === 'valid' && state.holder.releasedAtMs !== undefined) {
        // Release is an authoritative fence and can be superseded immediately.
      } else if (!expired) {
        return { kind: 'unverifiable', reason: 'lease-state-invalid' }
      }
      if (latest.epoch >= Number.MAX_SAFE_INTEGER) return { kind: 'unverifiable', reason: 'lease-state-invalid' }
      try {
        if (!claimNext(root, latest.epoch + 1)) continue
      } catch {
        return { kind: 'unverifiable', reason: 'lease-storage-unavailable' }
      }
    }
  }

  function renew(claim: WorkspaceLeaseClaim): boolean {
    if (claim.holderId !== holderId) return false
    try {
      assertHeld(claim)
      const root = ensureLeaseRoot(options.workspacePath, options.workspaceKind)
      const latest = currentEpoch(root)
      if (!latest || latest.epoch !== claim.epoch) return false
      writeHolder(latest, { holderId, epoch: claim.epoch, renewedAtMs: now() }, false)
      return claimIsCurrent(root, claim)
    } catch {
      return false
    }
  }

  function release(claim: WorkspaceLeaseClaim): boolean {
    if (claim.holderId !== holderId) return false
    try {
      assertHeld(claim)
      const root = ensureLeaseRoot(options.workspacePath, options.workspaceKind)
      const latest = currentEpoch(root)
      if (!latest || latest.epoch !== claim.epoch) return false
      writeHolder(latest, { holderId, epoch: claim.epoch, renewedAtMs: now(), releasedAtMs: now() }, false)
      const released = inspectHolder(latest)
      return currentEpoch(root)?.epoch === claim.epoch && released.kind === 'valid' &&
        released.holder.holderId === holderId && released.holder.releasedAtMs !== undefined
    } catch {
      return false
    }
  }

  return { acquire, assertHeld, renew, release }
}
