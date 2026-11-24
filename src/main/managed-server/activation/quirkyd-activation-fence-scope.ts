/**
 * Which activation fence this run holds, so every remote step it issues can prove it still does.
 *
 * Age only says a holder went quiet, not that it cannot act: a desktop suspended past the stale
 * window resumes believing it owns the fence a successor has since taken (Astra pass 8). Each
 * holder writes a generation token into the lock it creates, and each of its commands checks that
 * token on the host, in the same command as the step, so a superseded holder aborts instead of
 * launching, mutating state, or deleting the successor's fence and journal.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { isSshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'

export const QUIRKYD_FENCE_OWNER_FILENAME = '.quirky-fence-owner'
export const QUIRKYD_FENCE_LOST_MARKER = '__QUIRKYD_FENCE_LOST__'
/** EX_TEMPFAIL: the step did not run, and retrying under this fence never will. */
export const QUIRKYD_FENCE_LOST_EXIT = 75

export type QuirkydFence = { lockDir: string; token: string }

const scope = new AsyncLocalStorage<QuirkydFence>()

export function runWithQuirkydFence<T>(fence: QuirkydFence, run: () => Promise<T>): Promise<T> {
  return scope.run(fence, run)
}

export function currentQuirkydFence(): QuirkydFence | null {
  return scope.getStore() ?? null
}

export class QuirkydFenceLostError extends Error {
  constructor() {
    super(
      "This run's activation fence was taken over by another run, so it stopped before changing the host."
    )
    this.name = 'QuirkydFenceLostError'
  }
}

/** A POSIX test that succeeds only while the lock still carries this run's token. */
export function posixQuirkydFenceOwnedTest(fence: QuirkydFence): string {
  const owner = quotePosixShell(
    `${fence.lockDir.replace(/\/+$/u, '')}/${QUIRKYD_FENCE_OWNER_FILENAME}`
  )
  return `[ "$(cat ${owner} 2>/dev/null)" = ${quotePosixShell(fence.token)} ]`
}

export function posixQuirkydFenceGuard(fence: QuirkydFence): string {
  return `${posixQuirkydFenceOwnedTest(fence)} || { echo ${QUIRKYD_FENCE_LOST_MARKER}; exit ${QUIRKYD_FENCE_LOST_EXIT}; };`
}

/**
 * Classified from the exit status and the step's own stdout, never the message: the message
 * quotes the command, and every fenced command carries the guard's marker text.
 */
export function isQuirkydFenceLost(error: unknown): boolean {
  if (!isSshCommandExitError(error)) {
    return false
  }
  // `powershell -Command` reports any nonzero native exit as 1.
  const exited = error.exitCode === QUIRKYD_FENCE_LOST_EXIT || error.exitCode === 1
  return exited && error.stdout.trim().split(/\r?\n/u).at(-1) === QUIRKYD_FENCE_LOST_MARKER
}
