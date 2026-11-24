/**
 * What an in-flight activation, rollback or decommission still needs from GC.
 *
 * The journal names every slot the transaction may restart or settle; GC must keep them all.
 * A held fence without a journal, or a journal this client cannot read, means a transaction
 * this client cannot see into, so GC keeps everything rather than guess.
 */
import { quirkydInstallDirNames } from '../managed-server/activation/quirkyd-activation-record'
import type { QuirkydActivationTransaction } from '../managed-server/activation/quirkyd-activation-transaction'
import { readQuirkydActivationTransaction } from '../managed-server/activation/quirkyd-activation-transaction-store'
import { quirkydActivationFenceExists } from '../managed-server/activation/quirkyd-activation-lock'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import type { QuirkydRemoteExecTarget } from '../managed-server/install/quirkyd-remote-runtime-control'

export type QuirkydGcTransactionPins =
  | { state: 'pinned'; dirNames: string[] }
  | { state: 'keep-all' }

function transactionVersions(transaction: QuirkydActivationTransaction): (string | null)[] {
  const records = [transaction.recordBefore, transaction.recordAfter]
  const fromRecords = records.flatMap((record) => (record ? [record.active, record.previous] : []))
  if (transaction.operation === 'activate') {
    return [...fromRecords, transaction.candidateVersion]
  }
  // Any other operation names its slots through its records.
  return transaction.operation === 'rollback'
    ? [...fromRecords, transaction.incumbentVersion, transaction.targetVersion]
    : fromRecords
}

export async function readQuirkydGcTransactionPins(
  target: QuirkydRemoteExecTarget & { remoteHome: string }
): Promise<QuirkydGcTransactionPins> {
  try {
    const transaction = await readQuirkydActivationTransaction(target)
    if (!transaction) {
      // A fence without a journal is a transaction starting or a release cut short.
      return (await quirkydActivationFenceExists(target))
        ? { state: 'keep-all' }
        : { state: 'pinned', dirNames: [] }
    }
    return { state: 'pinned', dirNames: quirkydInstallDirNames(transactionVersions(transaction)) }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return { state: 'keep-all' }
  }
}
