/**
 * A lock this desktop's own earlier process took and exited without releasing (BUG-23): the
 * activation fence, or a version dir's install lock a quit left mid-upload. The steal takes it
 * without the 20-minute wait, but only through its own arbitration and only while the lock is the
 * same instance and still names the exited holder's token. Process exit alone is not enough: sshd
 * keeps pty-less steps running, so the lock must also be quiet for three heartbeats and, for the
 * fence, there must be no state-mutation lock at all; the steal then holds that lock across the
 * takeover, and a mutation rechecks its fence once it holds it, so the two never overlap.
 */
import {
  QUIRKYD_FENCE_OWNER_FILENAME,
  posixQuirkydFenceOwnedTest
} from '../managed-server/activation/quirkyd-activation-fence-scope'
import {
  forgetHeldQuirkydFence,
  quirkydFenceTokensHeldByExitedProcesses
} from './quirkyd-held-fence-tokens'
import { readBoundedQuirkydRemoteRecord } from '../managed-server/install/quirkyd-remote-record-file'
import {
  execQuirkydRemote,
  type QuirkydRemoteExecTarget
} from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  installQuirkydWindowsHostScript,
  quirkydWindowsHostOpCommand
} from '../managed-server/install/quirkyd-remote-windows-node'
import {
  QUIRKYD_EXITED_OWN_LOCK_QUIET_SECONDS,
  QUIRKYD_STATE_MUTATION_LOCK_DIRNAME
} from '../managed-server/host-state/quirkyd-state-snapshot-members'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../../shared/windows-command-line-budget'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { InstallLockExitedOwnerProof } from '../managed-server/install/remote-install-lock'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'

// Keeps the Windows command line short; an older token left out only waits out the stale window.
const MAX_WINDOWS_CANDIDATES = 16

/** `baseDir` is `~/.quirky-remote`; `guardsStateMutation` means a live state mutation there keeps the lock. */
export type ExitedOwnLockScope = { baseDir: string; guardsStateMutation: boolean }

export function exitedOwnLockProof(
  target: QuirkydRemoteExecTarget,
  scope: ExitedOwnLockScope
): InstallLockExitedOwnerProof {
  return {
    find: (lockDir) => findExitedOwnLockToken(target, lockDir, scope),
    reclaimed: forgetHeldQuirkydFence,
    quietSeconds: QUIRKYD_EXITED_OWN_LOCK_QUIET_SECONDS,
    mutationLock: mutationLockOf(target, scope) ?? undefined
  }
}

/** Read-only: the token of an exited holder of this desktop the lock still names, or null. */
export async function findExitedOwnLockToken(
  target: QuirkydRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope
): Promise<string | null> {
  const exited = quirkydFenceTokensHeldByExitedProcesses()
  if (exited.length === 0) {
    return null
  }
  try {
    const token = isWindowsRemoteHost(target.host)
      ? await findOnWindows(target, lockDir, scope, exited.slice(-MAX_WINDOWS_CANDIDATES))
      : await findOnPosix(target, lockDir, scope, exited)
    return token !== null && exited.includes(token) ? token : null
  } catch {
    // Unanswered: the stale window still applies.
    return null
  }
}

function mutationLockOf(target: QuirkydRemoteExecTarget, scope: ExitedOwnLockScope): string | null {
  return scope.guardsStateMutation
    ? joinRemotePath(target.host, scope.baseDir, QUIRKYD_STATE_MUTATION_LOCK_DIRNAME)
    : null
}

async function findOnPosix(
  target: QuirkydRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const owner = await readBoundedQuirkydRemoteRecord(
    target,
    joinRemotePath(target.host, lockDir, QUIRKYD_FENCE_OWNER_FILENAME),
    64
  )
  const token = owner.state === 'present' ? owner.raw.trim() : ''
  if (!exited.includes(token)) {
    return null
  }
  const command = exitedOwnLockCheckCommand({ lockDir, token }, mutationLockOf(target, scope))
  return (await execQuirkydRemote(target, command)).trim() === 'EXITED_OWNER' ? token : null
}

/** The host script reads the owner itself, so one node.exe answers with the token it found. */
async function findOnWindows(
  target: QuirkydRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const command = quirkydWindowsHostOpCommand(target.host, scope.baseDir, 'fence-exited-owner', [
    lockDir,
    scope.guardsStateMutation ? '1' : '0',
    ...exited
  ])
  // Too long for sshd's cmd.exe: no proof, so the stale window applies.
  if (command.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  await installQuirkydWindowsHostScript(target, scope.baseDir)
  const output = await execQuirkydRemote(target, command)
  const match = /^EXITED_OWNER (\S+)$/u.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? match[1] : null
}

function exitedOwnLockCheckCommand(
  lock: { lockDir: string; token: string },
  mutationLock: string | null
): string {
  const quiet = (path: string): string =>
    `[ -n "$(find ${path} -maxdepth 0 -mmin +${QUIRKYD_EXITED_OWN_LOCK_QUIET_SECONDS / 60} 2>/dev/null)" ]`
  return [
    `${posixQuirkydFenceOwnedTest(lock)} && ${quiet(quotePosixShell(lock.lockDir))} || exit 0;`,
    ...(mutationLock
      ? [
          // Any mutation lock refuses, as the steal does: it can only take an absent one.
          `[ -e ${quotePosixShell(mutationLock)} ] && exit 0;`
        ]
      : []),
    'echo EXITED_OWNER'
  ].join(' ')
}
