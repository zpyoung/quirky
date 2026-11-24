/**
 * Fencing a relay-hosted SSH target for a dormant migration into a managed quirkyd.
 *
 * Two durable records describe a fence: the journal sidecar and the target's `quirkydFence`.
 * Write order is journal, then fence, then the profile flush, all before any remote call, so a
 * crash leaves either nothing, a journal without a fence (stale, never authority), or both.
 * A fence without a journal is never released here: only the destination can say what happened.
 */
import { randomUUID } from 'node:crypto'
import { getManagedQuirkydFenceEnvironmentId } from '../../shared/managed-quirkyd-ssh-owner'
import type { QuirkydMigrationBlocker } from '../../shared/quirkyd-migration/quirkyd-migration-preflight'
import {
  QUIRKYD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type QuirkydMigrationSourceCutover
} from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import {
  assertQuirkydMigrationRequestFits,
  createQuirkydMigrationManifest
} from './quirkyd-migration-manifest-export'
import {
  findQuirkydMigrationSourceCutoverForTarget,
  removeQuirkydMigrationSourceCutover,
  writeQuirkydMigrationSourceCutover
} from './quirkyd-migration-cutover-journal'
import {
  confirmQuirkydMigrationTerminalsUnderFence,
  type QuirkydMigrationTerminalVerdict
} from './quirkyd-migration-terminal-gate'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'
import {
  isBlockingQuirkydMigrationBlocker,
  preflightQuirkydMigrationExport,
  type QuirkydMigrationPreflightStore
} from './targets/ssh-target-quirkyd-preflight'
import { quirkydMigrationRefusalReason } from './quirkyd-migration-refusal-reason'

export const QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS = 'quirkyd_migration_leave_behind_terminals'
export const QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON =
  'Move anyway needs every terminal on this host closed first, and Quirky could not confirm they all exited. Close them, or end them on the host, then connect again.'

export type QuirkydMigrationFenceState =
  | { state: 'none' }
  /** Owner and journal agree: the migration can resume. */
  | { state: 'fenced'; cutover: QuirkydMigrationSourceCutover }
  /** Owned by an empty-host deploy, which records itself as a provisioning intent instead. */
  | { state: 'owned-by-deploy'; environmentId: string }
  /** Owner with no journal (a downgrade dropped it, or it never landed): recover, never release. */
  | { state: 'fenced-unverifiable'; environmentId: string }
  /** Journal whose fence is gone or changed: it can never authorize staging. */
  | { state: 'stale-journal'; cutover: QuirkydMigrationSourceCutover }

/** Throws when the journal cannot be read: an unreadable record keeps the host fenced. */
export function resolveQuirkydMigrationFence(
  userDataPath: string,
  target: SshTarget
): QuirkydMigrationFenceState {
  const cutover = findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)
  const ownerEnvironmentId = getManagedQuirkydFenceEnvironmentId(target)
  if (cutover) {
    return ownerEnvironmentId === cutover.destinationEnvironmentId &&
      target.generation === cutover.sshTargetGeneration
      ? { state: 'fenced', cutover }
      : { state: 'stale-journal', cutover }
  }
  if (!ownerEnvironmentId) {
    return { state: 'none' }
  }
  return target.quirkydProvisioning
    ? { state: 'owned-by-deploy', environmentId: ownerEnvironmentId }
    : { state: 'fenced-unverifiable', environmentId: ownerEnvironmentId }
}

export type QuirkydMigrationFenceResult =
  | { outcome: 'fenced'; cutover: QuirkydMigrationSourceCutover; resumed: boolean }
  | {
      outcome: 'refused'
      verdict: 'live' | 'unverifiable'
      code: string
      reason: string
      blockers?: QuirkydMigrationBlocker[]
    }

export async function fenceQuirkydMigrationSource(args: {
  userDataPath: string
  store: QuirkydMigrationPreflightStore
  claims: SshTargetQuirkydClaims
  targetId: string
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by the caller while the relay could still answer; see quirkyd-migration-terminal-gate. */
  terminalProof: QuirkydMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}): Promise<QuirkydMigrationFenceResult> {
  const target = args.store.getSshTarget(args.targetId)
  if (!target) {
    return refuse('unverifiable', 'quirkyd_migration_target_not_found', 'The SSH host is gone.')
  }
  const existing = resolveQuirkydMigrationFence(args.userDataPath, target)
  if (existing.state === 'fenced') {
    return existing.cutover.destinationEnvironmentId === args.destinationEnvironmentId
      ? { outcome: 'fenced', cutover: existing.cutover, resumed: true }
      : refuse('live', 'quirkyd_migration_in_progress', 'Another migration holds this SSH host.')
  }
  if (existing.state !== 'none') {
    return refuse(
      'unverifiable',
      `quirkyd_migration_${existing.state.replaceAll('-', '_')}`,
      fenceStateReason(existing)
    )
  }
  const proof = args.terminalProof
  if (proof.verdict !== 'exited' && proof.verdict !== 'bridged') {
    return refuse(proof.verdict, 'quirkyd_migration_terminals', proof.reason)
  }
  if (proof.verdict === 'bridged' && target.managedServerLeaveBehind) {
    // Why: leaving the saved tabs behind drops the identities the relay bridge reattaches through.
    return refuse(
      proof.relayVerdict,
      QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS,
      QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON
    )
  }
  const preflight = preflightQuirkydMigrationExport(
    args.store,
    target.id,
    undefined,
    proof.verdict === 'bridged' ? proof.bridgedPtyIds : []
  )
  if (!preflight.claimable) {
    return {
      ...refuse(
        // Only a proven blocker reads live; one that is merely unanswered stays unverifiable.
        preflight.blockers
          .filter(isBlockingQuirkydMigrationBlocker)
          .every((blocker) => blocker.category === 'live-or-unverifiable')
          ? 'unverifiable'
          : 'live',
        'quirkyd_migration_preflight_blocked',
        quirkydMigrationRefusalReason(preflight.blockers)
      ),
      blockers: preflight.blockers
    }
  }
  const generation = args.claims.ensureGeneration(target.id)
  const now = (args.now ?? (() => new Date()))().toISOString()
  const manifest = createQuirkydMigrationManifest(
    args.store,
    { ...target, generation },
    { migrationId: randomUUID(), destinationEnvironmentId: args.destinationEnvironmentId }
  )
  // Before the journal: a fence on a manifest no request can carry could never be released.
  assertQuirkydMigrationRequestFits({ manifest })
  const cutover: QuirkydMigrationSourceCutover = {
    version: QUIRKYD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'source-fenced',
    startedAt: now,
    updatedAt: now,
    destinationEnvironmentId: args.destinationEnvironmentId,
    destinationName: args.destinationName,
    sshTargetId: target.id,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: proof.verdict === 'exited' ? proof.provenPtyIds : [],
    ...(proof.verdict === 'bridged' ? { bridgedPtyIds: proof.bridgedPtyIds } : {}),
    // Taken with the export, before any commit is possible: the only proof of what the server holds.
    manifest
  }
  writeQuirkydMigrationSourceCutover(args.userDataPath, cutover)
  args.claims.fenceForMigration(target.id, args.destinationEnvironmentId, generation)
  await args.claims.flush(args.signal)
  // Why again: a terminal may have started between the proof and the fence.
  const underFence = confirmQuirkydMigrationTerminalsUnderFence(
    args.store,
    target.id,
    args.terminalProof
  )
  if (underFence.verdict !== 'exited' && underFence.verdict !== 'bridged') {
    await releaseUnstagedFence(args, cutover)
    return refuse(underFence.verdict, 'quirkyd_migration_terminals', underFence.reason)
  }
  return { outcome: 'fenced', cutover, resumed: false }
}

type FenceReleaseArgs = {
  userDataPath: string
  claims: SshTargetQuirkydClaims
  signal?: AbortSignal
}

/** Undoes a fence nothing remote has seen. */
export async function releaseUnstagedFence(
  args: FenceReleaseArgs,
  cutover: QuirkydMigrationSourceCutover
): Promise<void> {
  if (cutover.phase !== 'source-fenced') {
    throw new Error('quirkyd_migration_fence_release_after_stage')
  }
  await releaseQuirkydMigrationFence(args, cutover)
}

/**
 * Owner first, then the journal: a crash between them leaves a stale journal, which grants
 * nothing, rather than an owner nothing explains.
 */
export async function releaseQuirkydMigrationFence(
  args: FenceReleaseArgs,
  cutover: QuirkydMigrationSourceCutover
): Promise<void> {
  args.claims.release(cutover.sshTargetId, cutover.destinationEnvironmentId)
  await args.claims.flush(args.signal)
  removeQuirkydMigrationSourceCutover(args.userDataPath, cutover.migrationId)
}

/**
 * Releases a migration fence whose destination server was never registered: no deploy finished,
 * so nothing could have been staged there. A registered destination must answer an abort instead.
 */
export async function releaseUndeployedMigrationFence(args: {
  userDataPath: string
  claims: SshTargetQuirkydClaims
  targetId: string
  isDestinationRegistered: (environmentId: string) => boolean
  signal?: AbortSignal
}): Promise<'released' | 'none'> {
  const cutover = findQuirkydMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  if (!cutover) {
    return 'none'
  }
  if (args.isDestinationRegistered(cutover.destinationEnvironmentId)) {
    throw new Error('quirkyd_migration_destination_registered')
  }
  await releaseUnstagedFence(args, cutover)
  return 'released'
}

function fenceStateReason(state: QuirkydMigrationFenceState): string {
  switch (state.state) {
    case 'owned-by-deploy':
      return 'Quirky already runs on this SSH host.'
    case 'fenced-unverifiable':
      return 'This SSH host is held for a migration whose record is missing. Recover it from this host’s Quirky server first.'
    case 'stale-journal':
      return 'A migration record names this SSH host but its fence is gone. Resolve that migration first.'
    case 'fenced':
    case 'none':
      return 'This SSH host is not in a state a migration can start from.'
  }
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<QuirkydMigrationFenceResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
