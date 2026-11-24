/**
 * One activation or rollback per host, and the fence an interrupted one leaves behind.
 *
 * The lock lives in the transaction root, so releasing it also removes the journal. A run
 * that cannot prove the host is back to one serving slot retains both and marks the lock
 * ownerless; only recovery may take a retained fence over, and it waits out the install lock's
 * stale window only for a fence whose holder may still be working.
 */
import { randomUUID } from 'node:crypto'
import {
  execQuirkydRemote,
  withoutAbortSignal,
  type QuirkydRemoteExecTarget
} from '../install/quirkyd-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from '../install/remote-install-lock'
import {
  orphanInstallLockCommand,
  probeInstallLockExistsCommand
} from '../install/remote-install-lock-commands'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  QUIRKYD_FENCE_OWNER_FILENAME,
  posixQuirkydFenceOwnedTest,
  runWithQuirkydFence,
  type QuirkydFence
} from './quirkyd-activation-fence-scope'
import {
  quirkydRemoteBaseDir,
  quirkydWindowsHomeOpCommand
} from '../install/quirkyd-remote-windows-node'
import {
  forgetHeldQuirkydFence,
  rememberHeldQuirkydFence
} from '../../ssh/quirkyd-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/quirkyd-exited-own-lock'
import { isWindowsRemoteHost } from '../../ssh/ssh-remote-platform'
import {
  quirkydActivationFenceLockDir,
  quirkydActivationTransactionPath,
  quirkydActivationTransactionRoot
} from './quirkyd-activation-transaction'
import {
  readQuirkydActivationTransaction,
  writeQuirkydActivationTransaction
} from './quirkyd-activation-transaction-store'

const QUIRKYD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

export type QuirkydActivationLockOptions = QuirkydRemoteExecTarget & { remoteHome: string }

export type QuirkydActivationLockControl = {
  /** Keep the fence if the run throws: a journal now describes host state. */
  retainOnError(): void
  /** Keep the fence even on return: the host is not proven back to one serving slot. */
  retain(): void
  /** The host is proven back on its recorded slot: release even if the run then throws. */
  recovered(): void
}

/** Bounded so a crashed holder's lock goes stale long before a live holder could still be waiting. */
export function resolveQuirkydActivationReadinessTimeout(
  configured: number | undefined,
  fallback: number
): number {
  const timeout = configured ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > QUIRKYD_ACTIVATION_MAX_READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      `quirkyd readiness timeout must be an integer from 1 to ${QUIRKYD_ACTIVATION_MAX_READINESS_TIMEOUT_MS}ms`
    )
  }
  return timeout
}

// Long enough for a brief hold (a wake, a retried lock command), short beside a lifecycle queue.
const QUIRKYD_ACTIVATION_FENCE_WAIT_MS = 5_000

/**
 * A fence still held after a short wait answers `held()`: a retained one never clears by waiting.
 * `token` names this run's generation; a wake passes its own so it can prove an interrupted fence.
 */
export async function withQuirkydActivationLock<T>(
  options: QuirkydActivationLockOptions,
  run: (control: QuirkydActivationLockControl) => Promise<T>,
  held: () => T | Promise<T>,
  token: string = randomUUID()
): Promise<T> {
  const lockRoot = quirkydActivationTransactionRoot(options.host, options.remoteHome)
  rememberHeldQuirkydFence(token)
  try {
    await acquireInstallLock(options.conn, lockRoot, options.host, {
      signal: options.signal,
      relayGcClaim: false,
      // A retained fence means state ownership is unresolved. Age cannot make it safe.
      allowStaleTakeover: false,
      waitTimeoutMs: QUIRKYD_ACTIVATION_FENCE_WAIT_MS,
      owner: { fileName: QUIRKYD_FENCE_OWNER_FILENAME, token }
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldQuirkydFence(token)
      return await held()
    }
    throw error
  }
  const fence = activationFence(options, token)
  let retainOnError = false
  let retain = false
  try {
    const result = await runWithQuirkydFence(fence, () =>
      run({
        retainOnError: () => {
          retainOnError = true
        },
        retain: () => {
          retain = true
        },
        recovered: () => {
          retainOnError = false
        }
      })
    )
    await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
    return result
  } catch (error) {
    // A remote mutation whose teardown is unconfirmed may still be running: keep its fence fresh.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await (
        retainOnError ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence)
      ).catch((releaseError: unknown) => {
        console.warn(
          `[quirkyd] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

/**
 * Takes over only a stale or previous-boot fence, or one this desktop's exited process left;
 * a fresh one throws `RemoteInstallLockBusyError`.
 */
export async function withStaleQuirkydActivationRecoveryLock<T>(
  options: QuirkydActivationLockOptions,
  run: (control: Pick<QuirkydActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = quirkydActivationTransactionRoot(options.host, options.remoteHome)
  const token = randomUUID()
  rememberHeldQuirkydFence(token)
  // The takeover writes this run's token, so the holder it replaced can no longer act or release.
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    allowStaleTakeover: true,
    waitTimeoutMs: 0,
    owner: { fileName: QUIRKYD_FENCE_OWNER_FILENAME, token },
    exitedOwner: exitedOwnLockProof(options, {
      baseDir: quirkydRemoteBaseDir(options.host, options.remoteHome),
      guardsStateMutation: true
    })
  }).catch((error: unknown) => {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldQuirkydFence(token)
    }
    throw error
  })
  const fence = activationFence(options, token)
  let retain = false
  let result: T
  try {
    result = await runWithQuirkydFence(fence, async () => {
      await adoptInterruptedJournal(options)
      return run({ retain: () => (retain = true) })
    })
  } catch (error) {
    // Any throw keeps the fence: recovery failed to prove one serving slot.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await orphanRetainedFence(options, fence).catch(() => undefined)
    }
    throw error
  }
  await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
  return result
}

/** Re-stamps a taken-over run's journal with this generation, so this run's release removes it. */
async function adoptInterruptedJournal(options: QuirkydActivationLockOptions): Promise<void> {
  const journal = await readQuirkydActivationTransaction(options).catch(() => null)
  if (journal) {
    await writeQuirkydActivationTransaction(options, journal)
  }
}

function activationFence(options: QuirkydActivationLockOptions, token: string): QuirkydFence {
  return { lockDir: quirkydActivationFenceLockDir(options.host, options.remoteHome), token }
}

/**
 * A fence this run keeps after it is done: nothing of ours still works under it, so the next
 * recovery may take it over at once. Left fresh, every failed recovery would restart the stale
 * window it waits out, and the host could never be recovered. Guarded, so a superseded run
 * never ages its successor's fence.
 */
async function orphanRetainedFence(
  options: QuirkydActivationLockOptions,
  fence: QuirkydFence
): Promise<void> {
  try {
    await runWithQuirkydFence(fence, () =>
      execQuirkydRemote(
        withoutAbortSignal(options),
        orphanInstallLockCommand(options.host, fence.lockDir)
      )
    )
    forgetHeldQuirkydFence(fence.token)
  } catch (error) {
    // Best effort: the fence still holds; recovery then waits out the stale window as before.
    console.warn(
      `[quirkyd] Could not mark a retained activation fence as ownerless: ${String(error)}`
    )
  }
}

/** Whether any lock is held; a lost probe throws rather than reading as open. */
export async function quirkydActivationFenceExists(
  options: QuirkydActivationLockOptions
): Promise<boolean> {
  const lockDir = quirkydActivationFenceLockDir(options.host, options.remoteHome)
  const answer = (
    await execQuirkydRemote(options, probeInstallLockExistsCommand(options.host, lockDir))
  ).trim()
  if (answer !== 'LOCKED' && answer !== 'OPEN') {
    throw new Error('The activation fence probe returned no verifiable answer.')
  }
  return answer === 'LOCKED'
}

/** Drops the fence `token` names, and nothing else: a successor's fence carries its own token. */
export function releaseQuirkydActivationFence(
  options: QuirkydActivationLockOptions,
  token: string
): Promise<void> {
  return releaseActivationFence(options, activationFence(options, token))
}

/**
 * Conditional on the host: only while the lock still carries this run's token, journal first,
 * then the lock renamed aside and removed, so a successor's fresh lock is never what goes.
 */
async function releaseActivationFence(
  options: QuirkydActivationLockOptions,
  fence: QuirkydFence
): Promise<void> {
  const lockRoot = quirkydActivationTransactionRoot(options.host, options.remoteHome)
  const journal = quirkydActivationTransactionPath(options.host, options.remoteHome)
  // Why no signal: a cancelled run must still be able to drop a fence it proved unnecessary.
  const target = withoutAbortSignal(options)
  const command = isWindowsRemoteHost(options.host)
    ? quirkydWindowsHomeOpCommand(options.host, options.remoteHome, 'fence-release', [
        fence.lockDir,
        journal,
        fence.token
      ])
    : posixReleaseFenceCommand(fence, journal, lockRoot)
  const answer = (await execQuirkydRemote(target, command)).trim()
  forgetHeldQuirkydFence(fence.token)
  if (answer.endsWith('SUPERSEDED')) {
    console.warn(
      '[quirkyd] A newer run had taken this activation fence over; it was left in place.'
    )
  }
}

/**
 * Each piece is renamed aside first and kept only if it is ours, else put straight back: a release
 * that stalls after its token check can then never delete a successor's journal or lock.
 */
export function posixReleaseFenceCommand(
  fence: QuirkydFence,
  journal: string,
  lockRoot: string
): string {
  const lock = quotePosixShell(fence.lockDir)
  const journalPath = quotePosixShell(journal)
  const stamp = quotePosixShell(journalFenceStamp(fence.token))
  return [
    `${posixQuirkydFenceOwnedTest(fence)} || { echo SUPERSEDED; exit 0; };`,
    `ja=${journalPath}.release.$$;`,
    `if mv ${journalPath} "$ja" 2>/dev/null; then`,
    `grep -qF ${stamp} "$ja" || mv -n "$ja" ${journalPath} 2>/dev/null; rm -f "$ja"; fi;`,
    `la=${lock}.released.$$;`,
    `if mv ${lock} "$la" 2>/dev/null; then`,
    `if [ "$(cat "$la"/${QUIRKYD_FENCE_OWNER_FILENAME} 2>/dev/null)" = ${quotePosixShell(fence.token)} ]; then rm -rf "$la";`,
    `else mv -n "$la" ${lock} 2>/dev/null; fi; fi;`,
    `rmdir ${quotePosixShell(lockRoot)} 2>/dev/null; echo RELEASED`
  ].join(' ')
}

/** How a journal this generation wrote names it (see writeQuirkydActivationTransaction). */
function journalFenceStamp(token: string): string {
  return `"fenceToken": ${JSON.stringify(token)}`
}
