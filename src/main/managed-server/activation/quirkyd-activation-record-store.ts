/**
 * Reading the activation record off a host.
 *
 * Split out from the deploy driver because the rollback path needs it too, and because an
 * unreadable record must fail loudly in both: treating "I cannot parse this" as "nothing is
 * activated" would deploy over a live install and lose its rollback target.
 */
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  QUIRKYD_ACTIVATION_FILENAME,
  emptyQuirkydActivationRecord,
  parseQuirkydActivationRecord,
  serializeQuirkydActivationRecord,
  type QuirkydActivationReadResult,
  type QuirkydActivationRecord
} from './quirkyd-activation-record'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  readBoundedQuirkydRemoteRecord,
  writeAtomicQuirkydRemoteRecord
} from '../install/quirkyd-remote-record-file'

const QUIRKYD_ACTIVATION_RECORD_MAX_BYTES = 64 * 1024

type ActivationRecordTarget = {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

export function quirkydActivationPath(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, QUIRKYD_ACTIVATION_FILENAME)
}

/** A failed read rejects; it never reads as absent, because absence would admit a fresh deploy. */
async function readActivationRecordState(
  options: ActivationRecordTarget
): Promise<QuirkydActivationReadResult> {
  const read = await readBoundedQuirkydRemoteRecord(
    options,
    quirkydActivationPath(options.host, options.remoteHome),
    QUIRKYD_ACTIVATION_RECORD_MAX_BYTES
  )
  return read.state === 'absent' ? read : parseQuirkydActivationRecord(read.raw)
}

export async function readQuirkydActivationRecord(
  options: ActivationRecordTarget
): Promise<QuirkydActivationRecord> {
  const parsed = await readActivationRecordState(options)
  if (parsed.state === 'ok') {
    return parsed.record
  }
  if (parsed.state === 'unreadable') {
    // Why throw: an unreadable record is not an empty one. Treating it as empty would
    // activate over a live install and orphan its rollback target.
    throw new Error(`Cannot read this host's quirkyd activation record: ${parsed.reason}`)
  }
  return emptyQuirkydActivationRecord()
}

/** Refuses to replace a record this client cannot read, e.g. one a newer client wrote. */
export async function writeQuirkydActivationRecord(
  options: ActivationRecordTarget,
  record: QuirkydActivationRecord
): Promise<void> {
  const existing = await readActivationRecordState(options)
  if (existing.state === 'unreadable') {
    throw new Error(
      `Refusing to overwrite this host's quirkyd activation record: ${existing.reason}`
    )
  }
  await writeAtomicQuirkydRemoteRecord(
    options,
    quirkydActivationPath(options.host, options.remoteHome),
    serializeQuirkydActivationRecord(record)
  )
}
