import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../shared/execution-host'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WorkspaceKey } from '../../shared/fork-heimdall/watcher-types'
import { resolveGitDir } from '../git/source-control/resolve-git-dir'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { getErrorCode } from '../git/worktree-operation-options'
import { ExecutionHostNotDispatchableError } from '../providers/execution-host-provider-dispatch'
import {
  requireLocalRuntimeGitRoute,
  type RuntimeGitTarget
} from '../runtime/runtime-git-command-target'
import { highestEpoch } from './lease-epoch-directory'
import { LeaseWorkspaceRemovedError } from './lease-workspace-absence'
import {
  parseLeaseHolderRecord,
  type LeaseHolderReadResult,
  type LeaseHolderRecord
} from './lease-holder-record'
import {
  createLocalLeaseFilesystem,
  resolveLeasePathFlavor,
  type LeaseHostFilesystem,
  type LeasePathFlavor
} from './lease-host-filesystem'

export type { WorkspaceKey } from '../../shared/fork-heimdall/watcher-types'
export type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'

export type LeaseWorkspaceTarget = {
  kind: 'git' | 'folder'
  executionHostId: ExecutionHostId
  workspacePath: string
  watcherId: string
  /** Required for git workspaces and resolved through `resolveRuntimeGitTarget`. */
  gitTarget?: RuntimeGitTarget
  /** Needed only when the execution host is local Node but the workspace path is WSL guest-spelled. */
  localGitOptions?: Pick<GitRuntimeOptions, 'wslDistro'>
}

export type LeaseResult =
  | { status: 'held'; epoch: number; guard: LeaseGuard }
  | { status: 'refused'; reason: 'held-by-other'; holder: string; epoch: number }
  | { status: 'unverifiable'; reason: string }
  | { status: 'configuration-error'; reason: string }
  | { status: 'workspace-removed'; reason: 'workspace-removed' }

export type LeaseLocationDescription = {
  executionHostId: ExecutionHostId
  leaseDirectory: string
  pathSeparator: string
}

export type LeaseStore = {
  acquireOrRenew(key: WorkspaceKey, holder: string, ttlMs: number): Promise<LeaseResult>
  release(key: WorkspaceKey, holder: string, epoch: number): Promise<void>
  describeLocation?(key: WorkspaceKey): LeaseLocationDescription | null
}

type ResolvedLeaseLocation = {
  key: WorkspaceKey
  target: LeaseWorkspaceTarget
  leaseDirectory: string
  fs: LeaseHostFilesystem
  pathFlavor: LeasePathFlavor
}

export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseLostError'
  }
}

export class LeaseConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseConfigurationError'
  }
}

export function makeWorkspaceKey(
  executionHostId: ExecutionHostId,
  canonicalPath: string
): WorkspaceKey {
  if (!canonicalPath) {
    throw new Error('A workspace key requires a canonical path')
  }
  return `${executionHostId}::${canonicalPath}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyExists(error: unknown): boolean {
  return getErrorCode(error) === 'EEXIST' || /already exists|\bEEXIST\b/i.test(errorMessage(error))
}

function isNotFound(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT' || /not found/i.test(errorMessage(error))
}

class EpochLeaseGuard implements LeaseGuard {
  private renewalTimer: ReturnType<typeof setInterval> | null = null
  private renewalFailure: LeaseLostError | null = null

  constructor(
    readonly epoch: number,
    readonly holder: string,
    private readonly ttlMs: number,
    private readonly location: ResolvedLeaseLocation,
    private readonly verify: (
      location: ResolvedLeaseLocation,
      epoch: number,
      holder: string,
      ttlMs: number,
      renew: boolean
    ) => Promise<void>
  ) {}

  async assertHeld(): Promise<void> {
    if (this.renewalFailure) {
      throw this.renewalFailure
    }
    try {
      await this.verify(this.location, this.epoch, this.holder, this.ttlMs, false)
    } catch (error) {
      throw error instanceof LeaseLostError ? error : new LeaseLostError(errorMessage(error))
    }
  }

  renewLoop(): { dispose(): void } {
    if (this.renewalTimer === null) {
      this.renewalTimer = setInterval(
        () => {
          void this.verify(this.location, this.epoch, this.holder, this.ttlMs, true).catch(
            (error) => {
              this.renewalFailure =
                error instanceof LeaseLostError ? error : new LeaseLostError(errorMessage(error))
              if (this.renewalTimer) {
                clearInterval(this.renewalTimer)
                this.renewalTimer = null
              }
            }
          )
        },
        Math.max(1, Math.floor(this.ttlMs / 3))
      )
      this.renewalTimer.unref?.()
    }
    return {
      dispose: () => {
        if (this.renewalTimer) {
          clearInterval(this.renewalTimer)
          this.renewalTimer = null
        }
      }
    }
  }
}

export class HostRoutedLeaseStore implements LeaseStore {
  private readonly locations = new Map<WorkspaceKey, ResolvedLeaseLocation>()
  private readonly epochOperationTails = new Map<string, Promise<void>>()
  private readonly renewedAtMs = new Map<string, number>()

  constructor(
    private readonly dependencies: {
      resolveTarget(key: WorkspaceKey): Promise<LeaseWorkspaceTarget>
      ownerNow?: () => number
    }
  ) {}

  describeLocation(key: WorkspaceKey): LeaseLocationDescription | null {
    const location = this.locations.get(key)
    return location
      ? {
          executionHostId: location.target.executionHostId,
          leaseDirectory: location.leaseDirectory,
          pathSeparator: location.pathFlavor.sep
        }
      : null
  }

  async acquireOrRenew(key: WorkspaceKey, holder: string, ttlMs: number): Promise<LeaseResult> {
    try {
      if (!holder || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new LeaseConfigurationError('Invalid lease acquisition request')
      }
      const location = await this.resolveLocation(key)
      await location.fs.createDir(location.leaseDirectory)
      const epoch = highestEpoch(await location.fs.readDir(location.leaseDirectory))
      if (epoch > 0) {
        const current = await this.readCurrentHolder(location, epoch)
        if (current.status === 'incomplete') {
          const incompleteExpired = await this.isIncompleteHolderExpired(
            location,
            epoch,
            current.freshnessPath,
            ttlMs
          )
          if (!incompleteExpired) {
            throw new LeaseLostError(`Lease epoch ${epoch} has an incomplete holder record`)
          }
        } else {
          const expired = await this.isExpiredByHostClock(location, epoch, current.record.ttlMs)
          if (!current.record.released && !expired) {
            if (current.record.holder !== holder) {
              return {
                status: 'refused',
                reason: 'held-by-other',
                holder: current.record.holder,
                epoch
              }
            }
            await this.verifyAndMaybeRenew(location, epoch, holder, ttlMs, true)
            return this.held(location, epoch, holder, ttlMs)
          }
        }
      }
      return await this.claimNextEpoch(location, epoch + 1, holder, ttlMs)
    } catch (error) {
      if (error instanceof LeaseWorkspaceRemovedError) {
        return { status: 'workspace-removed', reason: 'workspace-removed' }
      }
      if (
        error instanceof LeaseConfigurationError ||
        error instanceof ExecutionHostNotDispatchableError
      ) {
        return { status: 'configuration-error', reason: error.message }
      }
      if (error instanceof LeaseLostError) {
        return { status: 'unverifiable', reason: error.message }
      }
      return { status: 'unverifiable', reason: errorMessage(error) }
    }
  }

  async release(key: WorkspaceKey, holder: string, epoch: number): Promise<void> {
    const location = this.locations.get(key) ?? (await this.resolveLocation(key))
    await this.serializeEpochOperation(location, epoch, async () => {
      const currentEpoch = highestEpoch(await location.fs.readDir(location.leaseDirectory))
      if (currentEpoch !== epoch) {
        throw new LeaseLostError(`Lease epoch ${epoch} is fenced by epoch ${currentEpoch}`)
      }
      const holderPath = this.holderPath(location, epoch)
      const current = parseLeaseHolderRecord((await location.fs.readFile(holderPath)).content)
      if (current.holder !== holder) {
        throw new LeaseLostError(`Lease epoch ${epoch} is not held by ${holder}`)
      }
      await this.publishHolderRecord(location, epoch, { ...current, released: true })
      const currentEpochAfterRelease = highestEpoch(
        await location.fs.readDir(location.leaseDirectory)
      )
      if (currentEpochAfterRelease !== epoch) {
        throw new LeaseLostError(`Lease epoch ${epoch} was fenced while it was being released`)
      }
      this.renewedAtMs.delete(`${location.leaseDirectory}\0${epoch}`)
    })
  }

  private async resolveLocation(key: WorkspaceKey): Promise<ResolvedLeaseLocation> {
    const target = await this.dependencies.resolveTarget(key)
    if (makeWorkspaceKey(target.executionHostId, target.workspacePath) !== key) {
      throw new LeaseConfigurationError('Lease target does not match its workspace key')
    }
    const fs = createLocalLeaseFilesystem()
    const localWorkspacePath =
      resolveWorktreeHostPath(target.workspacePath, target.localGitOptions) ?? target.workspacePath
    let leaseDirectory: string
    let pathFlavor: LeasePathFlavor
    if (target.kind === 'folder') {
      pathFlavor = resolveLeasePathFlavor(target.executionHostId, localWorkspacePath)
      leaseDirectory = pathFlavor.join(localWorkspacePath, '.quirky', 'heimdall', 'lease')
    } else {
      if (!target.gitTarget) {
        throw new LeaseConfigurationError('Git lease target has no runtime Git target')
      }
      if (target.gitTarget.executionHostId !== target.executionHostId) {
        throw new LeaseConfigurationError('Git and filesystem routes disagree on execution host')
      }
      requireLocalRuntimeGitRoute(target.gitTarget)
      const gitDirectory = await resolveGitDir(
        target.workspacePath,
        target.gitTarget.localGitOptions
      )
      if (!gitDirectory) {
        throw new LeaseConfigurationError('Git did not return an absolute git directory')
      }
      pathFlavor = resolveLeasePathFlavor(target.executionHostId, gitDirectory)
      leaseDirectory = pathFlavor.join(gitDirectory, 'quirky-heimdall', 'lease')
    }
    const location = { key, target, leaseDirectory, fs, pathFlavor }
    this.locations.set(key, location)
    return location
  }

  private async claimNextEpoch(
    location: ResolvedLeaseLocation,
    epoch: number,
    holder: string,
    ttlMs: number
  ): Promise<LeaseResult> {
    const epochPath = this.epochPath(location, epoch)
    try {
      await location.fs.createDirNoClobber(epochPath)
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error
      }
      const winnerEpoch = highestEpoch(await location.fs.readDir(location.leaseDirectory))
      const winner = await this.readCurrentHolder(location, winnerEpoch)
      if (winner.status === 'incomplete') {
        throw new LeaseLostError(`Lease epoch ${winnerEpoch} has an incomplete holder record`)
      }
      return {
        status: 'refused',
        reason: 'held-by-other',
        holder: winner.record.holder,
        epoch: winnerEpoch
      }
    }
    const record: LeaseHolderRecord = {
      holder,
      watcherId: location.target.watcherId,
      acquiredAtMs: this.dependencies.ownerNow?.() ?? Date.now(),
      ttlMs,
      released: false
    }
    const currentEpochBeforePublish = highestEpoch(
      await location.fs.readDir(location.leaseDirectory)
    )
    if (currentEpochBeforePublish !== epoch) {
      throw new LeaseLostError(
        `Lease epoch ${epoch} was fenced before its holder record could be published`
      )
    }
    await this.publishHolderRecord(location, epoch, record)
    const currentEpochAfterPublish = highestEpoch(
      await location.fs.readDir(location.leaseDirectory)
    )
    if (currentEpochAfterPublish !== epoch) {
      throw new LeaseLostError(`Lease epoch ${epoch} was fenced while it was being published`)
    }
    return this.held(location, epoch, holder, ttlMs)
  }

  private held(
    location: ResolvedLeaseLocation,
    epoch: number,
    holder: string,
    ttlMs: number
  ): Extract<LeaseResult, { status: 'held' }> {
    return {
      status: 'held',
      epoch,
      guard: new EpochLeaseGuard(
        epoch,
        holder,
        ttlMs,
        location,
        (target, guardEpoch, guardHolder, guardTtl, renew) =>
          this.verifyAndMaybeRenew(target, guardEpoch, guardHolder, guardTtl, renew)
      )
    }
  }

  private async verifyAndMaybeRenew(
    location: ResolvedLeaseLocation,
    epoch: number,
    holder: string,
    ttlMs: number,
    renew: boolean
  ): Promise<void> {
    await this.serializeEpochOperation(location, epoch, async () => {
      const currentEpoch = highestEpoch(await location.fs.readDir(location.leaseDirectory))
      if (currentEpoch !== epoch) {
        throw new LeaseLostError(`Lease epoch ${epoch} is fenced by epoch ${currentEpoch}`)
      }
      const holderPath = this.holderPath(location, epoch)
      const current = parseLeaseHolderRecord((await location.fs.readFile(holderPath)).content)
      if (current.holder !== holder || current.released) {
        throw new LeaseLostError('Lease is no longer held by this owner')
      }
      if (await this.isExpiredByHostClock(location, epoch, ttlMs)) {
        throw new LeaseLostError('Lease expired on its execution host')
      }
      // The holder file's mtime is the liveness signal, so an immediate re-tick gains nothing by
      // rewriting it; the renewal loop's own ttl/3 cadence still keeps it well inside the TTL.
      const renewalKey = `${location.leaseDirectory}\0${epoch}`
      const ownerNow = this.dependencies.ownerNow?.() ?? Date.now()
      const lastRenewedAtMs = this.renewedAtMs.get(renewalKey)
      const renewalDue =
        lastRenewedAtMs === undefined || ownerNow - lastRenewedAtMs >= Math.floor(ttlMs / 3)
      if (renew && renewalDue) {
        await this.publishHolderRecord(location, epoch, { ...current, ttlMs, released: false })
        this.renewedAtMs.set(renewalKey, ownerNow)
      }
      const currentEpochAfterVerification = highestEpoch(
        await location.fs.readDir(location.leaseDirectory)
      )
      if (currentEpochAfterVerification !== epoch) {
        throw new LeaseLostError(
          `Lease epoch ${epoch} was fenced while it was being ${renew ? 'renewed' : 'verified'}`
        )
      }
    })
  }

  // Why rename: an in-place write truncates first, and a competing reader must never parse a
  // half-written record as incomplete while the lease is live.
  private async publishHolderRecord(
    location: ResolvedLeaseLocation,
    epoch: number,
    record: LeaseHolderRecord
  ): Promise<void> {
    const stagingPath = location.pathFlavor.join(
      this.epochPath(location, epoch),
      `holder.${randomUUID()}.tmp`
    )
    await location.fs.writeFile(stagingPath, JSON.stringify(record))
    await location.fs.rename(stagingPath, this.holderPath(location, epoch))
  }

  private async isExpiredByHostClock(
    location: ResolvedLeaseLocation,
    epoch: number,
    ttlMs: number
  ): Promise<boolean> {
    return this.isHostPathExpired(location, this.holderPath(location, epoch), ttlMs)
  }

  private async isIncompleteHolderExpired(
    location: ResolvedLeaseLocation,
    epoch: number,
    freshnessPath: string,
    ttlMs: number
  ): Promise<boolean> {
    try {
      return await this.isHostPathExpired(location, freshnessPath, ttlMs)
    } catch (error) {
      if (freshnessPath === this.holderPath(location, epoch) && isNotFound(error)) {
        return this.isHostPathExpired(location, this.epochPath(location, epoch), ttlMs)
      }
      throw error
    }
  }

  private async isHostPathExpired(
    location: ResolvedLeaseLocation,
    candidatePath: string,
    ttlMs: number
  ): Promise<boolean> {
    const probePath = location.pathFlavor.join(location.leaseDirectory, 'clock-probe')
    await location.fs.writeFile(probePath, '')
    const [probe, candidate] = await Promise.all([
      location.fs.stat(probePath),
      location.fs.stat(candidatePath)
    ])
    const probeMtime = probe.mtimeMs ?? probe.mtime
    const candidateMtime = candidate.mtimeMs ?? candidate.mtime
    return probeMtime - candidateMtime > ttlMs
  }

  private async readCurrentHolder(
    location: ResolvedLeaseLocation,
    epoch: number
  ): Promise<LeaseHolderReadResult> {
    const holderPath = this.holderPath(location, epoch)
    let content: string
    try {
      content = (await location.fs.readFile(holderPath)).content
    } catch (error) {
      if (isNotFound(error)) {
        return { status: 'incomplete', freshnessPath: this.epochPath(location, epoch) }
      }
      throw error
    }
    try {
      return { status: 'complete', record: parseLeaseHolderRecord(content) }
    } catch {
      return { status: 'incomplete', freshnessPath: holderPath }
    }
  }

  private async serializeEpochOperation<T>(
    location: ResolvedLeaseLocation,
    epoch: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const operationKey = `${location.key}\0${epoch}`
    const previous = this.epochOperationTails.get(operationKey) ?? Promise.resolve()
    let finish!: () => void
    const tail = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.epochOperationTails.set(operationKey, tail)
    await previous
    try {
      return await operation()
    } finally {
      finish()
      if (this.epochOperationTails.get(operationKey) === tail) {
        this.epochOperationTails.delete(operationKey)
      }
    }
  }

  private epochPath(location: ResolvedLeaseLocation, epoch: number): string {
    return location.pathFlavor.join(location.leaseDirectory, `epoch-${epoch}`)
  }

  private holderPath(location: ResolvedLeaseLocation, epoch: number): string {
    return location.pathFlavor.join(this.epochPath(location, epoch), 'holder.json')
  }
}
