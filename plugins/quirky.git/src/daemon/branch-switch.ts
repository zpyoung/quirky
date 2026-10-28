import { resolve } from 'node:path'
import { gitApi } from '@quirky/git'
import type { GitStatus, Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'

type SwitchTarget = { branch: string; remoteRef?: string }

const invalidTarget = (env: DaemonEnv, branch: string): Error =>
  env.errors.reasoned('invalid-params', 'not-allowed', `Branch ${branch} is not an available local or remote branch.`)

function assertClean(env: DaemonEnv, status: GitStatus): void {
  if (status.operation !== 'none' || status.entries.some((entry) => entry.area === 'conflicts' || entry.conflict !== undefined)) {
    throw env.errors.reasoned('conflict', 'conflicts', 'Finish or abort the active Git operation before switching branches.')
  }
  if (status.capped || status.entries.length > 0) {
    throw env.errors.reasoned('conflict', 'local-changes', 'Commit or discard all local changes before switching branches.')
  }
}

function assertExpectedSource(env: DaemonEnv, status: GitStatus, params: Record<string, unknown>): void {
  if (typeof params.expectedBranch === 'string' && params.expectedBranch !== status.branch) {
    throw env.errors.reasoned('conflict', 'branch-changed', 'The checked-out branch changed. Refresh Source Control and try again.')
  }
  if (typeof params.expectedHead === 'string' && params.expectedHead !== status.head) {
    throw env.errors.reasoned('conflict', 'branch-changed', 'The branch HEAD changed. Refresh Source Control and try again.')
  }
}

async function resolveTarget(env: DaemonEnv, worktree: Worktree, branch: unknown): Promise<SwitchTarget> {
  if (typeof branch !== 'string' || branch === '' || branch.endsWith('/HEAD') || !(await gitApi().checkRefFormatBranch(branch))) {
    throw invalidTarget(env, typeof branch === 'string' ? branch : '')
  }

  if ((await gitApi().resolveCommit(worktree.path, `refs/heads/${branch}`)) !== null) return { branch }

  const remotes = await gitApi().listRemotes(worktree.path)
  let remote: string | undefined
  for (const name of remotes) {
    if (branch.startsWith(`${name}/`) && (remote === undefined || name.length > remote.length)) remote = name
  }
  if (!remote) throw invalidTarget(env, branch)
  const localBranch = branch.slice(remote.length + 1)
  if (!(await gitApi().checkRefFormatBranch(localBranch))) throw invalidTarget(env, branch)
  if ((await gitApi().resolveCommit(worktree.path, `refs/remotes/${branch}`)) === null) throw invalidTarget(env, branch)
  return { branch: localBranch, remoteRef: branch }
}

async function assertTargetAvailable(env: DaemonEnv, worktree: Worktree, target: SwitchTarget, status: GitStatus): Promise<boolean> {
  if (target.remoteRef && status.branch === target.branch && (await gitApi().upstreamOf(worktree.path, target.branch)) === target.remoteRef) {
    return false
  }
  if (!target.remoteRef && status.branch === target.branch) return false

  const worktrees = await gitApi().listWorktrees(worktree.path)
  const holder = worktrees.find((entry) => entry.branch === target.branch && resolve(entry.path) !== resolve(worktree.path))
  if (holder) {
    throw env.errors.reasoned('conflict', 'branch-checked-out', `Branch ${target.branch} is already checked out in another worktree.`)
  }
  if (target.remoteRef && (await gitApi().localBranchExists(worktree.path, target.branch))) {
    throw env.errors.reasoned(
      'conflict',
      'branch-exists',
      `Local branch ${target.branch} already exists. Select the local branch instead of ${target.remoteRef}.`
    )
  }
  return true
}

function assertNoOperationLock(env: DaemonEnv, worktree: Worktree): void {
  const busy = env.lock.heldBy(worktree.id)
  if (busy !== null) throw env.errors.reasoned('conflict', 'busy', `A ${busy} is already running in this worktree.`)
}

export function describeSwitchBranch(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    assertNoOperationLock(env, worktree)
    const status = await env.readStatus(worktree)
    assertClean(env, status)
    assertExpectedSource(env, status, params)
    const target = await resolveTarget(env, worktree, params.branch)
    await assertTargetAvailable(env, worktree, target, status)
    const from = status.branch ?? 'detached HEAD'
    const to = target.remoteRef ? `${target.remoteRef} (new local ${target.branch})` : target.branch
    return `Switch from ${from} to ${to}? This changes the checked-out branch in this worktree.`
  }
}

export function switchBranch(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const targetName = params.branch as string
    return env.lock.withLock(worktree.id, 'switch', async () => {
      const status = await env.readStatus(worktree)
      assertClean(env, status)
      assertExpectedSource(env, status, params)
      const target = await resolveTarget(env, worktree, targetName)
      const changed = await assertTargetAvailable(env, worktree, target, status)
      if (!changed) {
        return { previousBranch: status.branch, branch: target.branch, changed: false, createdTrackingBranch: false }
      }

      await gitApi().switchToBranch(worktree.path, target.branch, target.remoteRef)
      env.changed(worktree)
      return {
        previousBranch: status.branch,
        branch: target.branch,
        changed: true,
        createdTrackingBranch: target.remoteRef !== undefined
      }
    })
  }
}
