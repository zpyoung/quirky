/**
 * The managed-server actions the Managed servers settings run, published by the desktop main
 * process so runtime RPC can offer the same ones. A runtime with none registered (headless
 * `quirky serve`) has no SSH registry to manage servers from, and does not advertise them.
 */
import type {
  QuirkydManagedCancelStopResult,
  QuirkydManagedDeployResult,
  QuirkydManagedForgetResult,
  QuirkydManagedRecoveryResult,
  QuirkydManagedRollbackResult,
  QuirkydManagedRuntimeStatus,
  QuirkydManagedStopResult
} from '../../shared/quirkyd-managed-runtime'

export type ManagedServerActions = {
  status: (selector: string) => Promise<QuirkydManagedRuntimeStatus>
  update: (selector: string, force: boolean) => Promise<QuirkydManagedDeployResult>
  rollback: (selector: string) => Promise<QuirkydManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<QuirkydManagedRecoveryResult>
  stop: (selector: string) => Promise<QuirkydManagedStopResult>
  cancelStop: (selector: string) => Promise<QuirkydManagedCancelStopResult>
  /** Unlinks a server whose host cannot answer, without stopping it there. */
  forget: (selector: string) => Promise<QuirkydManagedForgetResult>
}

let registered: ManagedServerActions | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions
}

export function getManagedServerActions(): ManagedServerActions | null {
  return registered
}
