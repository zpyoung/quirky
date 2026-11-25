import { useMemo } from 'react'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import type { ConnectionState } from '../transport/types'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** The desktop's platform: its own report, or the paired descriptor's before that lands. */
export function useResolvedHostPlatform(
  state: HostScreenState,
  hostId: string | undefined
): NodeJS.Platform | null {
  const descriptorPlatform = useHostDescriptor(hostId)?.platform ?? null
  return state.hostPlatform ?? descriptorPlatform
}

/** The rows the host list renders: the live or last-known catalog with display state and host badges. */
export function useHostDisplayWorktrees(
  connState: ConnectionState,
  state: HostScreenState,
  /** Metadata reads it only for a mixed desktop catalog. */
  hostPlatform: NodeJS.Platform | null
) {
  return useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(base, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById: state.hostLabelById,
        hostPlatform,
        hostHealthById: state.hostHealthById
      }
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    state.hostLabelById,
    hostPlatform,
    state.hostHealthById
  ])
}
