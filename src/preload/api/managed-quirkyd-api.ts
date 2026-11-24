/** Managed quirkyd servers over SSH; desktop-only, so web clients leave it undefined. */
import { ipcRenderer } from 'electron'
import type {
  QuirkydDeltaMovePreview,
  QuirkydDeltaMoveResult,
  QuirkydManagedCancelStopResult,
  QuirkydManagedConversionResult,
  QuirkydManagedDeployResult,
  QuirkydManagedForgetResult,
  QuirkydManagedPendingMigrationRow,
  QuirkydManagedRecoveryResult,
  QuirkydManagedRestartResult,
  QuirkydManagedRollbackResult,
  QuirkydManagedRuntimeStatus,
  QuirkydManagedStopResult
} from '../../shared/quirkyd-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type {
  RuntimeSshAccessLinkRequest,
  RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'

export type ManagedQuirkydPreloadApi = {
  deploy: (args: {
    name: string
    sshTargetId: string
    force?: boolean
  }) => Promise<QuirkydManagedDeployResult>
  getStatus: (args: { selector: string }) => Promise<QuirkydManagedRuntimeStatus>
  update: (args: { selector: string; force?: boolean }) => Promise<QuirkydManagedDeployResult>
  rollback: (args: { selector: string }) => Promise<QuirkydManagedRollbackResult>
  recover: (args: {
    selector: string
    /** Restore the snapshot over state a rejected build changed; see QUIRKYD_RECOVERY_CHANGED_STATE_CODE. */
    acceptChangedState?: boolean
  }) => Promise<QuirkydManagedRecoveryResult>
  /** Restarts from this client's SSH session; refused while terminals run. */
  restart: (args: { selector: string }) => Promise<QuirkydManagedRestartResult>
  stop: (args: { selector: string }) => Promise<QuirkydManagedStopResult>
  cancelStop: (args: { selector: string }) => Promise<QuirkydManagedCancelStopResult>
  forget: (args: { selector: string }) => Promise<QuirkydManagedForgetResult>
  linkSshAccess: (args: RuntimeSshAccessLinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  unlinkSshAccess: (args: RuntimeSshAccessUnlinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  convertSshHost: (args: {
    sshTargetId: string
    name: string
  }) => Promise<QuirkydManagedConversionResult>
  listPendingMigrations: () => Promise<QuirkydManagedPendingMigrationRow[]>
  previewDeltaMove: (args: { sshTargetId: string }) => Promise<QuirkydDeltaMovePreview>
  moveDelta: (args: { sshTargetId: string }) => Promise<QuirkydDeltaMoveResult>
  keepServerVersion: (args: { sshTargetId: string }) => Promise<void>
  /** "Move anyway": the next connect leaves what can't move on this desktop. */
  allowMoveLeavingBehind: (args: { sshTargetId: string }) => Promise<void>
}

export const managedQuirkydApi: ManagedQuirkydPreloadApi = {
  deploy: (args) => ipcRenderer.invoke('runtimeEnvironments:deployQuirkyd', args),
  getStatus: (args) => ipcRenderer.invoke('runtimeEnvironments:getQuirkydStatus', args),
  update: (args) => ipcRenderer.invoke('runtimeEnvironments:updateQuirkyd', args),
  rollback: (args) => ipcRenderer.invoke('runtimeEnvironments:rollbackQuirkyd', args),
  recover: (args) => ipcRenderer.invoke('runtimeEnvironments:recoverQuirkyd', args),
  restart: (args) => ipcRenderer.invoke('runtimeEnvironments:restartQuirkyd', args),
  stop: (args) => ipcRenderer.invoke('runtimeEnvironments:stopQuirkyd', args),
  cancelStop: (args) => ipcRenderer.invoke('runtimeEnvironments:cancelQuirkydStop', args),
  forget: (args) => ipcRenderer.invoke('runtimeEnvironments:forgetQuirkyd', args),
  linkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:linkSshAccess', args),
  unlinkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:unlinkSshAccess', args),
  convertSshHost: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:convertSshHostToManagedQuirkyd', args),
  listPendingMigrations: () =>
    ipcRenderer.invoke('runtimeEnvironments:listPendingQuirkydMigrations'),
  previewDeltaMove: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:previewQuirkydDeltaMove', args),
  moveDelta: (args) => ipcRenderer.invoke('runtimeEnvironments:moveQuirkydDelta', args),
  keepServerVersion: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:keepQuirkydServerVersion', args),
  allowMoveLeavingBehind: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:allowQuirkydMoveLeavingBehind', args)
}
