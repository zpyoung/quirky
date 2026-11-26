import {
  canDispatchWorkspaceTabCommand,
  dispatchWorkspaceTabCommand,
  type WorkspaceTabCommand
} from '@/lib/workspace-tab-commands'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { showClientCreationActionError } from '@/lib/client-creation-action-error'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import type { HoveredWorkspaceDeleteTarget } from '../components/sidebar/hovered-workspace-delete'
import { getDeleteStateForWorktreeHost } from '../components/sidebar/worktree-delete-state-host-match'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { canLaunchAgentInNewTab } from '@/lib/launch-agent-in-new-tab-check'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { readDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { createNewTerminalTab } from '../components/terminal/terminal-tab-create'
import { captureAgentTabLaunchContext } from '../components/agent-tab-launch-context'
import { useAppStore } from '../store'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import { agentTabActionId, type KeybindingActionId } from '../../../shared/keybindings'

type AppStoreState = ReturnType<typeof useAppStore.getState>

/** What a tab command needs from the handler map that composes it. */
export type TabCommandContext = {
  options: { worktreeId?: string }
  /** Records why the handler declined and returns false so callers can `return decline(...)`. */
  decline: (actionId: KeybindingActionId, reason: string) => false
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
  /** Claims only when `check` passes and then `run` reports it acted; a probe runs `check` alone. */
  claimWhen: (
    actionId: KeybindingActionId,
    action: { check: () => boolean; run: () => boolean },
    reason: string
  ) => boolean
  /** The workspace an active-workspace action acts on, or null after recording why it cannot. */
  requireActiveWorkspace: (actionId: KeybindingActionId) => string | null
}

/**
 * An RPC delete names its workspace; unlike the shortcut it never falls back to the hovered row.
 * A workspace id repeats across hosts, so `hostId` picks the copy, and an id that several hosts
 * publish with no host given declines instead of picking one.
 */
export function resolveExplicitWorkspaceDeleteTarget(
  store: AppStoreState,
  workspaceId: string,
  hostId?: ExecutionHostId
): { target: HoveredWorkspaceDeleteTarget } | { reason: string } {
  const scope = parseWorkspaceKey(workspaceId)
  const folderWorkspaceId =
    scope?.type === 'folder'
      ? scope.folderWorkspaceId
      : store.folderWorkspaces.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : null
  if (folderWorkspaceId !== null) {
    if (!findFolderWorkspaceOwner(store, folderWorkspaceId)) {
      return { reason: `folder workspace ${folderWorkspaceId} was not found` }
    }
    return {
      target: {
        kind: 'folder',
        executionHostId: getExecutionHostIdForFolderWorkspace(store, folderWorkspaceId),
        folderWorkspaceId,
        workspaceKey: folderWorkspaceKey(folderWorkspaceId)
      }
    }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoMap = getRepoMapFromState(store)
  const hostOf = (candidate: Worktree): ExecutionHostId =>
    getWorktreeExecutionHostId(candidate, repoMap.get(candidate.repoId))
  const sameId = getAllWorktreesFromState(store).filter((candidate) => candidate.id === worktreeId)
  const candidates = hostId ? sameId.filter((candidate) => hostOf(candidate) === hostId) : sameId
  const hosts = [...new Set(candidates.map(hostOf))].toSorted()
  if (hosts.length > 1) {
    return {
      reason: `workspace ${workspaceId} exists on several hosts (${hosts.join(', ')}); name one`
    }
  }
  const worktree = candidates[0]
  if (!worktree) {
    return {
      reason: hostId
        ? `workspace ${workspaceId} was not found on host ${hostId}`
        : `workspace ${workspaceId} was not found`
    }
  }
  if (worktree.isMainWorktree) {
    return { reason: 'the main worktree cannot be deleted' }
  }
  if (getDeleteStateForWorktreeHost(worktree, store.deleteStateByWorktreeId)?.isDeleting) {
    return { reason: `workspace ${workspaceId} is already being deleted` }
  }
  return { target: { kind: 'worktree', worktree } }
}

type TabCommandFactory = (context: TabCommandContext) => () => boolean

function activeGroupIdFor(store: AppStoreState, worktreeId: string): string | undefined {
  return store.activeGroupIdByWorktree[worktreeId] ?? store.groupsByWorktree[worktreeId]?.[0]?.id
}

function openNewTerminalTab(worktreeId: string): void {
  const store = useAppStore.getState()
  const targetGroupId = activeGroupIdFor(store, worktreeId)
  // the store action resolves the target from the active workspace, so only the active one may use it
  if (targetGroupId && store.activeWorktreeId === worktreeId) {
    void store.openNewTerminalTabInActiveWorkspace(targetGroupId)
    return
  }
  createNewTerminalTab(worktreeId)
}

function tabCommandAction(command: WorkspaceTabCommand): {
  check: () => boolean
  run: () => boolean
} {
  return {
    check: () => canDispatchWorkspaceTabCommand(command),
    run: () => dispatchWorkspaceTabCommand(command)
  }
}

function switchTab(
  actionId: KeybindingActionId,
  direction: number,
  scope: 'same-type' | 'all-types' | 'terminal'
): TabCommandFactory {
  return (context) => () =>
    context.requireActiveWorkspace(actionId) === null
      ? false
      : context.claimWhen(
          actionId,
          tabCommandAction({ type: 'switch', direction, scope }),
          'no other tab to switch to'
        )
}

function launchAgentTab(actionId: KeybindingActionId, agent: string): TabCommandFactory {
  return (context) => () => {
    const worktreeId = context.requireActiveWorkspace(actionId)
    if (worktreeId === null) {
      return false
    }
    const store = useAppStore.getState()
    const resolvedAgent =
      agent === 'default'
        ? resolveDefaultAgentForNewTab({
            defaultTuiAgent: store.settings?.defaultTuiAgent,
            detectedAgentIds: readDetectedAgentsForWorktree(store, worktreeId),
            disabledTuiAgents: store.settings?.disabledTuiAgents
          })
        : ALL_TUI_AGENTS.find((candidate) => candidate === agent)
    if (!resolvedAgent) {
      return context.decline(actionId, 'no agent CLI is detected for this workspace')
    }
    return context.claimWhen(
      actionId,
      {
        check: () =>
          canLaunchAgentInNewTab(useAppStore.getState(), { agent: resolvedAgent, worktreeId }),
        run: () => {
          const { groupId, focusIntent } = captureAgentTabLaunchContext(worktreeId)
          return (
            launchAgentInNewTab({
              requestId: newAgentLaunchRequestId(),
              focusIntent,
              agent: resolvedAgent,
              worktreeId,
              groupId,
              launchSource: 'shortcut'
            }) !== null
          )
        }
      },
      `could not build a launch command for ${resolvedAgent}`
    )
  }
}

const TAB_FACTORIES: Partial<Record<KeybindingActionId, TabCommandFactory>> = {
  'tab.nextSameType': switchTab('tab.nextSameType', 1, 'same-type'),
  'tab.previousSameType': switchTab('tab.previousSameType', -1, 'same-type'),
  'tab.nextAllTypes': switchTab('tab.nextAllTypes', 1, 'all-types'),
  'tab.previousAllTypes': switchTab('tab.previousAllTypes', -1, 'all-types'),
  'tab.nextTerminal': switchTab('tab.nextTerminal', 1, 'terminal'),
  'tab.previousTerminal': switchTab('tab.previousTerminal', -1, 'terminal'),
  'tab.previousRecent': (context) => () =>
    context.requireActiveWorkspace('tab.previousRecent') === null
      ? false
      : context.claimWhen(
          'tab.previousRecent',
          tabCommandAction({ type: 'previous-recent' }),
          'no previously used tab to switch to'
        ),
  'tab.close': (context) => () => {
    const { worktreeId } = context.options
    if (worktreeId) {
      const tab = useAppStore.getState().getActiveTab(worktreeId)
      if (!tab) {
        return context.decline('tab.close', `no focused tab in workspace ${worktreeId}`)
      }
      return context.claimWhen(
        'tab.close',
        tabCommandAction({
          type: 'close',
          target: { kind: 'tab', worktreeId, tabId: tab.id }
        }),
        `the tab in workspace ${worktreeId} could not be closed`
      )
    }
    const activeWorktreeId = context.requireActiveWorkspace('tab.close')
    if (activeWorktreeId === null) {
      return false
    }
    return context.claimWhen(
      'tab.close',
      tabCommandAction({ type: 'close' }),
      `no focused tab in workspace ${activeWorktreeId}`
    )
  },
  'tab.reopenClosed': (context) => () => {
    const worktreeId =
      context.options.worktreeId ?? context.requireActiveWorkspace('tab.reopenClosed')
    if (worktreeId === null) {
      return false
    }
    return context.claimWhen(
      'tab.reopenClosed',
      {
        check: () =>
          (useAppStore.getState().recentlyClosedTabKindsByWorktree[worktreeId]?.length ?? 0) > 0,
        run: () => {
          try {
            return useAppStore.getState().reopenClosedTab(worktreeId)
          } catch (error) {
            showClientCreationActionError(error)
            return true
          }
        }
      },
      `no recently closed tab to reopen in workspace ${worktreeId}`
    )
  },
  'tab.openQuickCommandsMenu': (context) => () =>
    context.claim('tab.openQuickCommandsMenu', () =>
      window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
    ),
  'tab.newTerminal': (context) => () => {
    const worktreeId = context.requireActiveWorkspace('tab.newTerminal')
    return worktreeId === null
      ? false
      : context.claim('tab.newTerminal', () => openNewTerminalTab(worktreeId))
  },
  'tab.newBrowser': (context) => () => {
    const worktreeId = context.requireActiveWorkspace('tab.newBrowser')
    if (worktreeId === null) {
      return false
    }
    const groupId = activeGroupIdFor(useAppStore.getState(), worktreeId)
    if (!groupId) {
      return context.decline('tab.newBrowser', `no tab group in workspace ${worktreeId}`)
    }
    return context.claim('tab.newBrowser', () => {
      void useAppStore
        .getState()
        .openNewBrowserTabInActiveWorkspace(groupId)
        .catch(showClientCreationActionError)
    })
  },
  'tab.newMarkdown': (context) => () => {
    const worktreeId = context.requireActiveWorkspace('tab.newMarkdown')
    if (worktreeId === null) {
      return false
    }
    const groupId = activeGroupIdFor(useAppStore.getState(), worktreeId)
    if (!groupId) {
      return context.decline('tab.newMarkdown', `no tab group in workspace ${worktreeId}`)
    }
    return context.claim('tab.newMarkdown', () => {
      void useAppStore
        .getState()
        .openNewMarkdownInActiveWorkspace(groupId)
        .catch(showClientCreationActionError)
    })
  },
  'tab.newAgent': launchAgentTab('tab.newAgent', 'default')
}

for (const agent of ALL_TUI_AGENTS) {
  const actionId = agentTabActionId(agent)
  TAB_FACTORIES[actionId] = launchAgentTab(actionId, agent)
}

/** Tab switching, closing, reopening and creation commands, keyed by action id. */
export const TAB_COMMAND_FACTORIES: Readonly<
  Partial<Record<KeybindingActionId, TabCommandFactory>>
> = TAB_FACTORIES
