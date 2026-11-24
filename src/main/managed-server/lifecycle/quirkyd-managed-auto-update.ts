/**
 * Updating a managed quirkyd on connect, through the same update the Managed servers action runs.
 *
 * The connect only picks whether to try: the update planner still defers over live or uncounted
 * terminals, and a rejected candidate is restored through the activation journal, so the old
 * version keeps serving. A host a newer Quirky activated is never downgraded.
 */
import type { QuirkydActivationRecord } from '../activation/quirkyd-activation-record'
import {
  refuseQuirkydHostDowngrade,
  type QuirkydHostVersionRefusal
} from '../../ssh/quirkyd-host-version-admission'
import { materializeQuirkydArtifact } from '../../quirkyd/quirkyd-artifact-materializer'
import {
  QuirkydArtifactsUnavailableError,
  QuirkydHostUnsupportedError
} from '../../quirkyd/quirkyd-host-unavailable'
import { findIncompleteManagedQuirkydMigration } from './quirkyd-managed-migration-status'
import { QUIRKYD_ACTIVATION_FENCE_BUSY_CODE } from '../activation/quirkyd-activation-fence-hold'
import { resolveLinkedQuirkydContext } from './quirkyd-managed-runtime-context'
import {
  runManagedQuirkydUpdate,
  withManagedQuirkydLifecycle
} from '../../ssh/quirkyd-runtime-maintenance'
import type { QuirkydUpdateDeferCode } from '../../ssh/quirkyd-update-plan'
import { readLocalFullVersion } from '../install/remote-versioned-install'

export type ManagedQuirkydAutoUpdateSkip =
  | 'current'
  | 'no-template'
  | 'rolled-back'
  | 'failed-before'
  | 'migrating'
  | QuirkydHostVersionRefusal

export type ManagedQuirkydAutoUpdatePlan =
  | { action: 'update' }
  | { action: 'skip'; reason: ManagedQuirkydAutoUpdateSkip }

export type ManagedQuirkydAutoUpdateOutcome =
  | { outcome: 'skipped'; reason: ManagedQuirkydAutoUpdateSkip }
  | { outcome: 'updated'; activeVersion: string }
  /** The update planner chose to wait, e.g. for terminals to close; a later connect retries. */
  | { outcome: 'deferred'; code: string; reason: string }
  /** The candidate was rejected or the update threw; the incumbent keeps serving. */
  | { outcome: 'failed'; reason: string }

export function planManagedQuirkydAutoUpdate(input: {
  record: QuirkydActivationRecord
  /** This app's bundled build for the host's target; null when the template lacks it. */
  candidateVersion: string | null
  appVersion: string
  /** An update to this app version already failed on this host. */
  failedBefore: boolean
}): ManagedQuirkydAutoUpdatePlan {
  const { record, candidateVersion } = input
  if (!candidateVersion) {
    return { action: 'skip', reason: 'no-template' }
  }
  if (record.active === candidateVersion) {
    return { action: 'skip', reason: 'current' }
  }
  if (record.rolledBackFrom === candidateVersion) {
    return { action: 'skip', reason: 'rolled-back' }
  }
  const refusal = refuseQuirkydHostDowngrade(record, candidateVersion, input.appVersion)
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  // Why no `failedBefore` skip on a stopped host: nothing serves, so retrying is the only way back.
  if (record.active === null && record.previous !== null) {
    return { action: 'update' }
  }
  return input.failedBefore ? { action: 'skip', reason: 'failed-before' } : { action: 'update' }
}

const WAITING_CODES: ReadonlySet<string> = new Set<
  QuirkydUpdateDeferCode | typeof QUIRKYD_ACTIVATION_FENCE_BUSY_CODE
>([
  QUIRKYD_ACTIVATION_FENCE_BUSY_CODE,
  'quirkyd_update_terminals_running',
  'quirkyd_update_terminal_census_unavailable',
  'quirkyd_update_strands_live_terminals',
  'quirkyd_update_daemon_protocol_unverifiable',
  'quirkyd_update_ends_in_process_terminals'
])

/**
 * Deferrals that mean "not now", as opposed to a candidate that was tried and rejected. An
 * interrupted activation is not one: no later connect clears it, so it surfaces as a failure.
 */
export function isWaitingQuirkydUpdateDeferral(code: string): boolean {
  return WAITING_CODES.has(code)
}

export function autoUpdateManagedQuirkydEnvironment(
  userDataPath: string,
  args: {
    environmentId: string
    appVersion: string
    /** Read under the host's lifecycle lock, so overlapping checks see an earlier attempt's result. */
    failedBefore: () => boolean
    onUpdating: () => void
  }
): Promise<ManagedQuirkydAutoUpdateOutcome> {
  return withManagedQuirkydLifecycle(userDataPath, args.environmentId, async (managed) => {
    // Why: a restart mid-migration would race the staging the cutover journal is driving.
    if (findIncompleteManagedQuirkydMigration(userDataPath, managed.environment.id)) {
      return { outcome: 'skipped', reason: 'migrating' }
    }
    const context = await resolveLinkedQuirkydContext(managed.environment, managed.deployment)
    const candidateVersion = await bundledQuirkydVersion(context.serverTarget)
    const plan = planManagedQuirkydAutoUpdate({
      record: context.activationRecord,
      candidateVersion,
      appVersion: args.appVersion,
      failedBefore: args.failedBefore()
    })
    if (plan.action === 'skip') {
      return { outcome: 'skipped', reason: plan.reason }
    }
    args.onUpdating()
    let lockedSkip: ManagedQuirkydAutoUpdateSkip | null = null
    try {
      const result = await runManagedQuirkydUpdate(userDataPath, managed, context, {
        // Why again under the fence: another desktop may activate or stop a newer build mid-upload.
        admitRecord: (record) => {
          const locked = planManagedQuirkydAutoUpdate({
            record,
            candidateVersion,
            appVersion: args.appVersion,
            failedBefore: false
          })
          if (locked.action === 'update') {
            return null
          }
          lockedSkip = locked.reason
          return `Auto-update skipped under the host fence: ${locked.reason}.`
        }
      })
      if (lockedSkip) {
        return { outcome: 'skipped', reason: lockedSkip }
      }
      if (result.outcome !== 'deferred') {
        return { outcome: 'updated', activeVersion: result.activeVersion }
      }
      return isWaitingQuirkydUpdateDeferral(result.code)
        ? { outcome: 'deferred', code: result.code, reason: result.reason }
        : { outcome: 'failed', reason: result.reason }
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

type QuirkydTarget = Parameters<typeof materializeQuirkydArtifact>[0]

// Why per session: the packaged template can't change while the app runs, and hashing it costs a read.
const bundledVersions = new Map<QuirkydTarget, Promise<string | null>>()

function bundledQuirkydVersion(target: QuirkydTarget): Promise<string | null> {
  let version = bundledVersions.get(target)
  if (!version) {
    version = materializeQuirkydArtifact(target).then(readLocalFullVersion, (error: unknown) => {
      if (
        error instanceof QuirkydHostUnsupportedError ||
        error instanceof QuirkydArtifactsUnavailableError
      ) {
        return null
      }
      throw error
    })
    // A transient local failure must not stick for the session.
    version.catch(() => bundledVersions.delete(target))
    bundledVersions.set(target, version)
  }
  return version
}

export function resetBundledQuirkydVersionsForTests(): void {
  bundledVersions.clear()
}
