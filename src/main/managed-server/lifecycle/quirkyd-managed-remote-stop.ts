/**
 * Stopping one remote quirkyd instance through its instance-bound request, never a signal.
 *
 * The client names the instance from two host records that must agree: the slot's readiness
 * payload (runtime ID, PID, capability) and the data root's instance lock (PID, start time,
 * nonce). The slot's own `quirkyd.js` then writes the request and proves exit on the host.
 */
import { randomUUID } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { selectQuirkydSlotRuntimeCommand } from '../install/quirkyd-remote-runtime'
import {
  parseQuirkydReadinessWaitOutput,
  readQuirkydReadinessNowCommand
} from '../install/quirkyd-remote-readiness-wait'
import { execQuirkydRemote } from '../install/quirkyd-remote-runtime-control'
import { readBoundedQuirkydRemoteRecord } from '../install/quirkyd-remote-record-file'
import { quirkydSlotDir, type QuirkydSlotOptions } from '../../ssh/quirkyd-recovery-slot'
import { isWindowsRemoteHost, joinRemotePath } from '../../ssh/ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  quirkydWindowsNodeCommandLine,
  quirkydWindowsSlotOpCommand,
  readQuirkydWindowsEncodedAnswer
} from '../install/quirkyd-remote-windows-node'
import { QUIRKYD_WINDOWS_RUNTIME_MARKER } from '../host-state/quirkyd-windows-host-script'
import {
  QUIRKYD_LOCK_FILE_NAME,
  parseQuirkydInstanceLockRecord
} from '../../quirkyd/quirkyd-instance-lock'
import {
  QUIRKYD_CANCEL_MANAGED_STOP_FLAG,
  QUIRKYD_COMPLETE_MANAGED_STOP_FLAG,
  QUIRKYD_MANAGED_STOP_REQUEST_FILE_FLAG,
  QUIRKYD_STOP_REQUESTS_CAPABILITY,
  QuirkydManagedStopCancellationSchema,
  QuirkydManagedStopCompletionSchema,
  type QuirkydManagedStopCancellation,
  type QuirkydManagedStopCompletion,
  type QuirkydManagedStopContext,
  type QuirkydManagedStopRequest
} from '../../../shared/quirkyd-stop-request'

const LOCK_RECORD_MAX_BYTES = 64 * 1024

export type QuirkydManagedStopTarget =
  | { state: 'ready'; context: QuirkydManagedStopContext }
  | { state: 'refused'; verdict: 'unverifiable'; code: string; reason: string }

function refused(code: string, reason: string): QuirkydManagedStopTarget {
  return { state: 'refused', verdict: 'unverifiable', code, reason }
}

/** Names the running instance of `version`, or says why the host could not prove which it is. */
export async function readRemoteQuirkydManagedStopTarget(
  options: QuirkydSlotOptions,
  version: string
): Promise<QuirkydManagedStopTarget> {
  const slotDir = quirkydSlotDir(options, version)
  const readiness = parseQuirkydReadinessWaitOutput(
    options.host,
    await execQuirkydRemote(options, readQuirkydReadinessNowCommand(options.host, slotDir))
  )
  if (readiness.state !== 'ready' || !readiness.readiness.health) {
    return refused(
      'quirkyd_managed_stop_readiness_unverifiable',
      `quirkyd ${version} has no readable readiness record, so the running instance is unknown.`
    )
  }
  const { health, runtimeId } = readiness.readiness
  if (health.stopRequests !== QUIRKYD_STOP_REQUESTS_CAPABILITY) {
    return refused(
      'quirkyd_managed_stop_unsupported',
      `quirkyd ${version} predates managed stop requests; it can only be stopped by signal.`
    )
  }
  const lockPath = joinRemotePath(options.host, options.userDataDir, QUIRKYD_LOCK_FILE_NAME)
  const lockRead = await readBoundedQuirkydRemoteRecord(options, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = lockRead.state === 'present' ? parseQuirkydInstanceLockRecord(lockRead.raw) : null
  if (!lock || lock.pid !== health.pid || !runtimeId) {
    return refused(
      'quirkyd_managed_stop_instance_unverifiable',
      `The instance lock does not name the quirkyd ${version} that published readiness.`
    )
  }
  return {
    state: 'ready',
    context: {
      version,
      runtimeId,
      instance: {
        pid: lock.pid,
        startedAtMs: lock.startedAtMs,
        // Older slots drop these; newer ones prove identity without the drifting wall clock.
        ...(lock.linuxStartTicks && lock.bootId
          ? { linuxStartTicks: lock.linuxStartTicks, bootId: lock.bootId }
          : {}),
        nonce: lock.nonce,
        lockPath
      }
    }
  }
}

export async function completeRemoteQuirkydManagedStop(
  options: QuirkydSlotOptions,
  request: QuirkydManagedStopRequest
): Promise<QuirkydManagedStopCompletion> {
  return QuirkydManagedStopCompletionSchema.parse(
    await runSlotCommand(options, request, QUIRKYD_COMPLETE_MANAGED_STOP_FLAG)
  )
}

export async function cancelRemoteQuirkydManagedStop(
  options: QuirkydSlotOptions,
  request: QuirkydManagedStopRequest
): Promise<QuirkydManagedStopCancellation> {
  return QuirkydManagedStopCancellationSchema.parse(
    await runSlotCommand(options, request, QUIRKYD_CANCEL_MANAGED_STOP_FLAG)
  )
}

/** Runs the slot's own build, which owns the request format it is asked to write. */
async function runSlotCommand(
  options: QuirkydSlotOptions,
  request: QuirkydManagedStopRequest,
  flag: string
): Promise<unknown> {
  const slotDir = quirkydSlotDir(options, request.version)
  const entry = joinRemotePath(options.host, slotDir, 'quirkyd.js')
  const output = isWindowsRemoteHost(options.host)
    ? await runWindowsSlotCommand(options, slotDir, entry, request, flag)
    : await execQuirkydRemote(
        options,
        `${selectQuirkydSlotRuntimeCommand(options.host, slotDir, options.nodePath)} && ` +
          `"$quirkyd_runtime" ${quotePosixShell(entry)} ${flag} ${quotePosixShell(JSON.stringify(request))}`
      )
  const line = output
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    throw new Error('quirkyd managed stop command returned no verifiable answer')
  }
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('quirkyd managed stop command returned no verifiable answer')
  }
  // The answer must be about this exact request, not another transaction's.
  if (!('transactionId' in parsed) || parsed.transactionId !== request.transactionId) {
    throw new Error('quirkyd managed stop command answered another transaction')
  }
  return parsed
}

/** Windows passes the request as a staged file: JSON on a command line meets two quoting layers. */
async function runWindowsSlotCommand(
  options: QuirkydSlotOptions,
  slotDir: string,
  entry: string,
  request: QuirkydManagedStopRequest,
  flag: string
): Promise<string> {
  const runtime = readQuirkydWindowsEncodedAnswer(
    await execQuirkydRemote(
      options,
      quirkydWindowsSlotOpCommand(options.host, slotDir, 'slot-runtime', [slotDir])
    ),
    QUIRKYD_WINDOWS_RUNTIME_MARKER
  )
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this quirkyd slot needs.')
  }
  const staged = joinRemotePath(options.host, slotDir, `.quirkyd-stop-command-${randomUUID()}.json`)
  let removeStaged = true
  try {
    await options.conn.writeFile(staged, JSON.stringify(request), {
      hostPlatform: options.host,
      signal: options.signal
    })
    return await execQuirkydRemote(
      options,
      quirkydWindowsNodeCommandLine(runtime, [
        entry,
        flag,
        QUIRKYD_MANAGED_STOP_REQUEST_FILE_FLAG,
        staged
      ])
    )
  } catch (error) {
    // The command may still be reading it.
    removeStaged = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (removeStaged) {
      await execQuirkydRemote(
        options,
        quirkydWindowsSlotOpCommand(options.host, slotDir, 'remove-file', [staged])
      ).catch(() => {})
    }
  }
}
