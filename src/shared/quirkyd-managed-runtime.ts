import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { QuirkydTerminalCensus } from './quirkyd-terminal-census'
import type { QuirkydMigrationBlocker } from './quirkyd-migration/quirkyd-migration-preflight'
import type { QuirkydMigrationSourceCutoverPhase } from './quirkyd-migration/quirkyd-migration-source-cutover'
import type { QuirkydDaemonRetirementVerdict } from './quirkyd-stop-request'
import type { SshManagedServerLinkedProject } from './ssh-types'

export const QUIRKYD_MANAGED_REMOTE_PORT = 6_768

/** Refused because terminals are, or may be, still running on the host. */
export type QuirkydManagedRefusal = {
  outcome: 'refused'
  verdict: 'live' | 'unverifiable'
  code: string
  reason: string
  /** Only saved state blocks, which a confirmed "Move anyway" leaves on this desktop. */
  canLeaveBehind?: true
}

export type QuirkydManagedDeferral = {
  outcome: 'deferred'
  candidateVersion: string
  code: string
  reason: string
  /** False when force cannot make the rejected lifecycle transition safe. */
  forceable?: boolean
}

export type QuirkydManagedDeployResult =
  | {
      outcome: 'created' | 'updated' | 'already-current'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
    }
  | QuirkydManagedDeferral

export type QuirkydManagedRollbackResult =
  | {
      outcome: 'rolled-back'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
      discarded: string[]
    }
  | { outcome: 'refused' | 'failed'; code: string; reason: string }

/** A recovery that needs the operator to accept restoring a snapshot over changed state. */
export const QUIRKYD_RECOVERY_CHANGED_STATE_CODE = 'quirkyd_recovery_changed_state'

export type QuirkydManagedRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      environment: PublicKnownRuntimeEnvironment
    }
  | QuirkydManagedRefusal

/** Only a proven `exited` unlinks the server locally; anything less keeps it linked. */
export type QuirkydManagedStopResult =
  | {
      outcome: 'unlinked'
      verdict: 'exited'
      environmentId: string
      sshTargetId: string
      stoppedVersion: string | null
      retirement: QuirkydDaemonRetirementVerdict | null
    }
  | QuirkydManagedRefusal

/**
 * Restarting the server from the current SSH session. Refused while any terminal runs or can't be
 * counted (`liveSessions: null`): the terminal daemon outlives quirkyd and keeps what it inherited.
 */
export type QuirkydManagedRestartResult =
  | { outcome: 'restarted'; environmentId: string }
  | { outcome: 'terminals-running'; liveSessions: number | null }
  | { outcome: 'not-restarted'; reason: string }

/**
 * Unlinks the server from this desktop without reaching its host, for a host that is gone or
 * unreachable. Never a claim of exit: the server may still run there, so the verdict stays
 * `unverifiable`.
 */
export type QuirkydManagedForgetResult =
  | {
      outcome: 'forgotten'
      verdict: 'unverifiable'
      environmentId: string
      sshTargetId: string
    }
  | QuirkydManagedRefusal

export type QuirkydManagedCancelStopResult =
  | { outcome: 'none' }
  /** The stop was withdrawn before quirkyd acted on it; the server keeps serving. */
  | { outcome: 'canceled'; activeVersion: string }
  /** quirkyd had already exited; finish with stop to unlink the server. */
  | { outcome: 'already-stopped' }
  | QuirkydManagedRefusal

export type QuirkydManagedRuntimeStatus = {
  environmentId: string
  sshTargetId: string
  activeVersion: string | null
  previousVersion: string | null
  activatedAt: string | null
  rollbackAvailable: boolean
  recovery:
    | {
        operation: 'activate'
        phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'rollback'
        phase:
          | 'prepared'
          | 'incumbent-stopped'
          | 'rescue-captured'
          | 'rollback-state-restored'
          | 'target-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'decommission'
        phase: 'prepared' | 'stop-dispatched' | 'process-exited'
        version: string
        startedAt: string
      }
    | null
  /** Terminals the daemon runs; `null` counts are unverifiable and block updates and stops. */
  terminals: QuirkydTerminalCensus
  /** An unfinished dormant migration into this server; a rollback is refused while it runs. */
  migration: {
    migrationId: string
    phase: QuirkydMigrationSourceCutoverPhase
    startedAt: string
  } | null
  /** The last update this client deferred for this server, cleared once one goes through. */
  deferredUpdate: (QuirkydManagedDeferral & { deferredAt: string }) | null
}

export type QuirkydManagedConversionResult =
  | {
      /** Committed on the server and retired from the SSH host. */
      outcome: 'converted'
      environment: PublicKnownRuntimeEnvironment
      migrationId: string
      /** Projects the server already held, so this desktop's own state for them did not move. */
      linkedProjects?: SshManagedServerLinkedProject[]
    }
  | QuirkydManagedDeferral
  | QuirkydManagedRefusal

export type QuirkydManagedPendingMigrationRow = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: QuirkydMigrationSourceCutoverPhase
  startedAt: string
}

export type QuirkydDeltaMoveRow = {
  kind: 'repository' | 'folder-workspace' | 'project-group'
  id: string
  label: string
}

/** What moving a host's newer projects would add, and what the server will keep as it is. */
export type QuirkydDeltaMovePreview = {
  sshTargetId: string
  environmentId: string
  added: QuirkydDeltaMoveRow[]
  /** Projects an older build changed or removed; the server keeps its own copy of these. */
  notReflected: { edited: QuirkydDeltaMoveRow[]; removed: QuirkydDeltaMoveRow[] }
  blockers: QuirkydMigrationBlocker[]
}

export type QuirkydDeltaMoveResult =
  | { outcome: 'moved'; migrationId: string }
  | { outcome: 'refused'; code: string; reason: string; blockers?: QuirkydMigrationBlocker[] }
