import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  refineLocalLaunchPlatform,
  resolveExecutionHostAgentStartupShell,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import type { AgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import type { useAppStore } from '@/store'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type AgentLaunchStartupBase = Parameters<typeof planLaunchAgentStartupPrompt>[0]['base']

/**
 * Where a new-tab launch would run, without telling the user when the host's OS is unknown.
 * `null` matches `resolveAgentLaunchExecutionContext` returning null.
 */
export function peekAgentLaunchExecutionContext(
  store: AppStoreState,
  args: { worktreeId: string; launchPlatform?: NodeJS.Platform }
): AgentLaunchExecutionContext | null {
  const worktreeSshConnectionId = getConnectionIdFromState(store, args.worktreeId)
  const workspacePath = (
    store.getKnownWorktreeById?.(args.worktreeId) ??
    store.allWorktrees?.().find((entry) => entry.id === args.worktreeId)
  )?.path
  const fact = resolveWorktreeExecutionHostPlatform(store, args.worktreeId, workspacePath)
  if (fact.kind === 'withheld') {
    return null
  }
  const launchHost = refineLocalLaunchPlatform(fact, args.launchPlatform)
  return {
    worktreeSshConnectionId,
    resolvedLaunchPlatform: launchHost.platform,
    isRemote: Boolean(worktreeSshConnectionId),
    queuedShell: resolveExecutionHostAgentStartupShell(
      launchHost,
      store.settings?.terminalWindowsShell
    )
  }
}

/** The inputs the launch command is built from, shared by the launch and its availability check. */
export function buildAgentLaunchStartupBase(
  store: AppStoreState,
  args: {
    agent: TuiAgent
    executionContext: AgentLaunchExecutionContext
    agentArgs?: string | null
    sessionOptions?: Record<string, SessionOptionValue>
    includeSessionOptionCatalogDefaults?: boolean
  }
): AgentLaunchStartupBase {
  const { agent, executionContext } = args
  return {
    agent,
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    platform: executionContext.resolvedLaunchPlatform,
    shell: executionContext.queuedShell,
    isRemote: executionContext.isRemote,
    agentArgs:
      args.agentArgs !== undefined
        ? args.agentArgs
        : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
    sessionOptions: args.sessionOptions,
    includeSessionOptionCatalogDefaults: args.includeSessionOptionCatalogDefaults
  }
}

/**
 * Whether a prompt-less new-tab launch can get as far as opening a surface: the workspace's host
 * is known and a launch command can be built. A structured chat the host later declines is not
 * predictable here.
 */
export function canLaunchAgentInNewTab(
  store: AppStoreState,
  args: { agent: TuiAgent; worktreeId: string }
): boolean {
  const executionContext = peekAgentLaunchExecutionContext(store, { worktreeId: args.worktreeId })
  if (!executionContext) {
    return false
  }
  const { startupPlan } = planLaunchAgentStartupPrompt({
    base: buildAgentLaunchStartupBase(store, { agent: args.agent, executionContext }),
    prompt: '',
    promptDelivery: 'auto-submit',
    isFollowupPath: false
  })
  return startupPlan !== null
}
