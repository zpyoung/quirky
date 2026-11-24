import {
  quirkydActivationTransactionPath,
  parseQuirkydActivationTransaction,
  serializeQuirkydActivationTransaction,
  type QuirkydActivationTransaction
} from './quirkyd-activation-transaction'
import {
  readBoundedQuirkydRemoteRecord,
  writeAtomicQuirkydRemoteRecord
} from '../install/quirkyd-remote-record-file'
import type { QuirkydRemoteExecTarget } from '../install/quirkyd-remote-runtime-control'
import { currentQuirkydFence } from './quirkyd-activation-fence-scope'

const QUIRKYD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type QuirkydActivationTransactionStoreOptions = QuirkydRemoteExecTarget & { remoteHome: string }

/** `null` only on a verified absence; an unreadable journal keeps the host fenced. */
export async function readQuirkydActivationTransaction(
  options: QuirkydActivationTransactionStoreOptions
): Promise<QuirkydActivationTransaction | null> {
  const read = await readBoundedQuirkydRemoteRecord(
    options,
    quirkydActivationTransactionPath(options.host, options.remoteHome),
    QUIRKYD_ACTIVATION_TRANSACTION_MAX_BYTES
  )
  const parsed = parseQuirkydActivationTransaction(read.state === 'present' ? read.raw : null)
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's quirkyd activation transaction: ${parsed.reason}`)
  }
  return parsed.state === 'ok' ? parsed.transaction : null
}

/**
 * Stamped with the writing run's fence token, so a release only ever removes its own generation's
 * journal (Astra pass 9); readers ignore the extra field.
 */
export function writeQuirkydActivationTransaction(
  options: QuirkydActivationTransactionStoreOptions,
  transaction: QuirkydActivationTransaction
): Promise<void> {
  const fenceToken = currentQuirkydFence()?.token
  return writeAtomicQuirkydRemoteRecord(
    options,
    quirkydActivationTransactionPath(options.host, options.remoteHome),
    serializeQuirkydActivationTransaction(fenceToken ? { ...transaction, fenceToken } : transaction)
  )
}
