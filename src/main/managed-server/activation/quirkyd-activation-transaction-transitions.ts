import type { QuirkydActivationRecord } from './quirkyd-activation-record'
import { QUIRKYD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './quirkyd-activation-transaction-schema'
import type {
  QuirkydActivateTransaction,
  QuirkydRollbackTransaction
} from './quirkyd-activation-transaction'

export function createQuirkydActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
  appVersion?: string
  recordBefore: QuirkydActivationRecord
  snapshotDirName: string
  now: Date
}): QuirkydActivateTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: QUIRKYD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'activate',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    candidateVersion: options.candidateVersion,
    candidateAppVersion: options.appVersion ?? null,
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
  }
}

export function withQuirkydActivationIncumbentStopped(
  transaction: QuirkydActivateTransaction,
  now: Date
): QuirkydActivateTransaction {
  return {
    ...transaction,
    phase: 'incumbent-stopped',
    updatedAt: now.toISOString()
  }
}

export function withQuirkydActivationSnapshot(
  transaction: QuirkydActivateTransaction,
  state: 'captured' | 'empty',
  now: Date
): QuirkydActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: { dirName: transaction.snapshot.dirName, state }
  }
}

export function withQuirkydActivationCandidateReady(
  transaction: QuirkydActivateTransaction,
  recordAfter: QuirkydActivationRecord,
  now: Date
): QuirkydActivateTransaction {
  return {
    ...transaction,
    phase: 'candidate-ready',
    updatedAt: now.toISOString(),
    recordAfter
  }
}

export function createQuirkydRollbackTransaction(options: {
  transactionId: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: QuirkydActivationRecord
  recordAfter: QuirkydActivationRecord
  rescueDirName: string
  now: Date
}): QuirkydRollbackTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: QUIRKYD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'rollback',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    incumbentVersion: options.incumbentVersion,
    targetVersion: options.targetVersion,
    recordBefore: options.recordBefore,
    recordAfter: options.recordAfter,
    rescue: { dirName: options.rescueDirName, state: 'pending' }
  }
}

export function withQuirkydRollbackPhase(
  transaction: QuirkydRollbackTransaction,
  phase: 'incumbent-stopped' | 'rollback-state-restored' | 'target-ready',
  now: Date
): QuirkydRollbackTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withQuirkydRollbackRescue(
  transaction: QuirkydRollbackTransaction,
  state: 'captured' | 'empty',
  now: Date
): QuirkydRollbackTransaction {
  return {
    ...transaction,
    phase: 'rescue-captured',
    updatedAt: now.toISOString(),
    rescue: { dirName: transaction.rescue.dirName, state }
  }
}
