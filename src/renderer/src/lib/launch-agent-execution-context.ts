import { toast } from 'sonner'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  refineLocalLaunchPlatform,
  resolveExecutionHostAgentStartupShell,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import type { useAppStore } from '@/store'

/** Where a new-tab agent launch runs, and the quoting rules that follow from it. */
export type AgentLaunchExecutionContext = {
  /** `undefined` means rival host rows disagree, which is not evidence of a remote. */
  worktreeSshConnectionId: string | null | undefined
  resolvedLaunchPlatform: NodeJS.Platform
  isRemote: boolean
  /** Only set for a local Windows launch; remote targets need their own shell signal. */
  queuedShell: AgentStartupShell | undefined
}

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type AgentLaunchExecutionContextPeek =
  | { kind: 'resolved'; context: AgentLaunchExecutionContext }
  | { kind: 'withheld'; reason: string }

/** Where a new-tab launch would run, without telling the user when the host's OS is unknown. */
export function peekAgentLaunchExecutionContext(
  store: AppStoreState,
  args: { worktreeId: string; launchPlatform?: NodeJS.Platform }
): AgentLaunchExecutionContextPeek {
  // Why: `undefined` (rival host rows disagree) is not evidence of a remote; main rejects it anyway.
  const worktreeSshConnectionId = getConnectionIdFromState(store, args.worktreeId)
  // Why getKnownWorktreeById: folder workspaces are not in allWorktrees, and their path marks WSL.
  const workspacePath = (
    store.getKnownWorktreeById?.(args.worktreeId) ??
    store.allWorktrees?.().find((entry) => entry.id === args.worktreeId)
  )?.path
  // Why: the agent runs on the workspace's execution host, so its OS and shell decide quoting (#22204).
  const fact = resolveWorktreeExecutionHostPlatform(store, args.worktreeId, workspacePath)
  if (fact.kind === 'withheld') {
    return { kind: 'withheld', reason: fact.reason }
  }
  const launchHost = refineLocalLaunchPlatform(fact, args.launchPlatform)
  return {
    kind: 'resolved',
    context: {
      worktreeSshConnectionId,
      resolvedLaunchPlatform: launchHost.platform,
      // Why: SSH remotes deploy the shim as plain `quirky`, so skip the Linux-only `quirky-ide` rename for remote launches.
      isRemote: Boolean(worktreeSshConnectionId),
      queuedShell: resolveExecutionHostAgentStartupShell(
        launchHost,
        store.settings?.terminalWindowsShell
      )
    }
  }
}

/** `null` means the host's OS is unknown; the user has been told why the launch stopped. */
export function resolveAgentLaunchExecutionContext(
  store: AppStoreState,
  args: { worktreeId: string; launchPlatform?: NodeJS.Platform }
): AgentLaunchExecutionContext | null {
  const peek = peekAgentLaunchExecutionContext(store, args)
  if (peek.kind === 'withheld') {
    toast.error(peek.reason)
    return null
  }
  return peek.context
}
