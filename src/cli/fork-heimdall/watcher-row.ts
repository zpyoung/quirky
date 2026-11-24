import { HEIMDALL_CHANNELS, type HeimdallFleetSnapshot } from '../../shared/fork-heimdall/api'
import type { WatcherFleetEntry } from '../../shared/fork-heimdall/fleet-types'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { normalizeWorktreeSelectorForCaller, resolveCurrentWorktreeSelector } from '../selectors'
import type { HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'

export async function resolveWatcherRow(
  client: HandlerContext['client'],
  watcherId: string
): Promise<WatcherFleetEntry> {
  const fleet = await client.call<HeimdallFleetSnapshot>(HEIMDALL_CHANNELS.fleet, {})
  let row: WatcherFleetEntry | undefined
  for (const entry of fleet.result.entries) {
    if (entry.target.watcherId !== watcherId) {
      continue
    }
    if (row !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Heimdall watcher ${watcherId} is ambiguous across multiple owners`
      )
    }
    row = entry
  }
  if (row === undefined) {
    throw new RuntimeClientError('invalid_argument', `Heimdall watcher ${watcherId} was not found`)
  }
  return row
}

/** Resolves a --worktree value, preferring the local folder workspace for active/current. */
export async function resolveHeimdallWorkspaceSelector(
  requested: string,
  cwd: string,
  client: HandlerContext['client']
): Promise<string> {
  if (requested !== 'active' && requested !== 'current') {
    return await normalizeWorktreeSelectorForCaller(requested, cwd, client)
  }
  const folderWorkspaceId = process.env.QUIRKY_WORKSPACE_ID?.trim()
  if (!client.isRemote && folderWorkspaceId?.startsWith('folder:')) {
    return folderWorkspaceId
  }
  return await resolveCurrentWorktreeSelector(cwd, client)
}

export async function resolveWatcherWorktreeFilter(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: HandlerContext['client']
): Promise<RuntimeWorktreeRecord | undefined> {
  const requested = flags.has('worktree') ? getRequiredStringFlag(flags, 'worktree') : undefined
  if (requested === undefined) {
    return undefined
  }
  const selector = await resolveHeimdallWorkspaceSelector(requested, cwd, client)
  const response = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return response.result.worktree
}

export function watcherMatchesWorktree(
  row: WatcherFleetEntry,
  worktree: RuntimeWorktreeRecord
): boolean {
  const enrollment = row.entry.enrollment
  const sameWorkspace =
    enrollment.worktreeId === worktree.id ||
    (enrollment.worktreeId === null &&
      enrollment.repoId === worktree.repoId &&
      enrollment.workspacePath === worktree.path)
  if (!sameWorkspace) {
    return false
  }
  if (worktree.runtimeOwnerEnvironmentId !== undefined) {
    return row.target.connectionId === worktree.runtimeOwnerEnvironmentId
  }
  const worktreeHostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  if (row.target.connectionId !== null) {
    return worktreeHostId === toRuntimeExecutionHostId(row.target.connectionId)
  }
  return enrollment.executionHostId === worktreeHostId
}
