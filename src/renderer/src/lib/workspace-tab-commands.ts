import type { KeybindingContext } from '../../../shared/keybindings'
import { toVisibleTabType, type Tab } from '../../../shared/tab-types'
import { useAppStore } from '@/store'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import { createWorkspaceTabCloseCommands } from '@/components/tab-group/workspace-tab-close-commands'
import { captureWorkspaceEmptiedReaction } from '@/components/tab-group/workspace-emptied-reaction'
import {
  canSwitchRecentTab,
  canSwitchTab,
  canSwitchTabAcrossAllTypes,
  canSwitchTerminalTab,
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '@/hooks/ipc-tab-switch'
import { selectEmptyFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import {
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceTab
} from './floating-workspace-terminal-actions'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { closeWorkspaceBrowserTab } from './workspace-browser-tab-close'
import { resolveBrowserWorkspaceOwner } from './browser-workspace-source-resolution'

export type WorkspaceTabTarget =
  | { kind: 'tab'; worktreeId: string; tabId: string }
  | { kind: 'browser-source'; sourceId: string }

export type WorkspaceTabCommand =
  | {
      type: 'close'
      target?: WorkspaceTabTarget
      context?: KeybindingContext
      skipEmptyCheck?: boolean
      bulk?: boolean
      floatingPanelGuestOwned?: boolean
    }
  | { type: 'switch'; direction: number; scope: 'same-type' | 'all-types' | 'terminal' }
  | { type: 'previous-recent' }

type TabState = ReturnType<typeof useAppStore.getState>

function hasFocusedGroup(state: TabState, worktreeId: string): boolean {
  const groupId = state.activeGroupIdByWorktree?.[worktreeId]
  return (state.groupsByWorktree?.[worktreeId] ?? []).some((group) => group.id === groupId)
}

function resolveActiveTab(state: TabState, worktreeId: string): Tab | null {
  const activeTab = state.getActiveTab(worktreeId)
  if (activeTab) {
    return activeTab
  }
  if (hasFocusedGroup(state, worktreeId)) {
    return null
  }
  // Hydration can publish the backing selection before its group selection.
  const entityId =
    state.activeTabType === 'browser'
      ? state.activeBrowserTabId
      : state.activeTabType === 'editor'
        ? state.activeFileId
        : state.activeTabId
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) =>
        toVisibleTabType(tab.contentType) === state.activeTabType && tab.entityId === entityId
    ) ?? null
  )
}

function resolveCloseTarget(
  state: TabState,
  target?: WorkspaceTabTarget
): { worktreeId: string; tab: Tab | null; browserWorkspaceId?: string } | null {
  if (target?.kind === 'tab') {
    const tab = (state.unifiedTabsByWorktree[target.worktreeId] ?? []).find(
      (tab) => tab.id === target.tabId
    )
    return tab ? { worktreeId: target.worktreeId, tab } : null
  }
  if (target?.kind === 'browser-source') {
    const owner = resolveBrowserWorkspaceOwner(state, target.sourceId)
    if (!owner) {
      return null
    }
    const tab = (state.unifiedTabsByWorktree[owner.worktreeId] ?? []).find(
      (tab) => tab.contentType === 'browser' && tab.entityId === owner.workspaceId
    )
    return { worktreeId: owner.worktreeId, tab: tab ?? null, browserWorkspaceId: owner.workspaceId }
  }
  if (!state.activeWorktreeId) {
    return null
  }
  const tab = resolveActiveTab(state, state.activeWorktreeId)
  if (tab) {
    return { worktreeId: state.activeWorktreeId, tab }
  }
  if (
    !hasFocusedGroup(state, state.activeWorktreeId) &&
    state.activeTabType === 'browser' &&
    state.activeBrowserTabId
  ) {
    return resolveCloseTarget(state, { kind: 'browser-source', sourceId: state.activeBrowserTabId })
  }
  return null
}

type CloseCommand = Extract<WorkspaceTabCommand, { type: 'close' }>

type CloseOutcome =
  | { kind: 'empty-floating-panel' }
  | { kind: 'browser-workspace'; worktreeId: string; browserWorkspaceId: string }
  | { kind: 'tab'; worktreeId: string; tab: Tab }
  | null

/** What a close command would act on, or null when it would decline; reads state only. */
function resolveCloseOutcome(state: TabState, command: CloseCommand): CloseOutcome {
  if (!command.target) {
    if (selectEmptyFloatingWorkspacePanelVisible(state)) {
      return { kind: 'empty-floating-panel' }
    }
    if (isFloatingWorkspacePanelFocused()) {
      return null
    }
  }
  const target = resolveCloseTarget(state, command.target)
  if (!target) {
    return null
  }
  if (!target.tab) {
    return target.browserWorkspaceId
      ? {
          kind: 'browser-workspace',
          worktreeId: target.worktreeId,
          browserWorkspaceId: target.browserWorkspaceId
        }
      : null
  }
  if (command.context === 'terminal' && target.tab.contentType === 'terminal') {
    return null
  }
  return { kind: 'tab', worktreeId: target.worktreeId, tab: target.tab }
}

/** Whether `dispatchWorkspaceTabCommand` would claim the command, without running it. */
export function canDispatchWorkspaceTabCommand(command: WorkspaceTabCommand): boolean {
  if (command.type === 'close') {
    return resolveCloseOutcome(useAppStore.getState(), command) !== null
  }
  if (command.type === 'previous-recent') {
    return !isFloatingWorkspacePanelFocused() && canSwitchRecentTab()
  }
  if (isFloatingWorkspacePanelFocused()) {
    return true
  }
  switch (command.scope) {
    case 'same-type':
      return canSwitchTab(command.direction)
    case 'all-types':
      return canSwitchTabAcrossAllTypes(command.direction)
    case 'terminal':
      return canSwitchTerminalTab(command.direction)
  }
}

/** Input adapters describe intent; targeting and tab operations live here. */
export function dispatchWorkspaceTabCommand(command: WorkspaceTabCommand): boolean {
  const state = useAppStore.getState()
  if (command.type === 'close') {
    const outcome = resolveCloseOutcome(state, command)
    if (!outcome) {
      return false
    }
    if (outcome.kind === 'empty-floating-panel') {
      window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
      return true
    }
    if (outcome.kind === 'browser-workspace') {
      const whenEmptied = captureWorkspaceEmptiedReaction(outcome.worktreeId)
      const plan = closeWorkspaceBrowserTab(outcome.worktreeId, outcome.browserWorkspaceId)
      if (
        plan.closesLocally &&
        plan.localCloseReason !== 'cleanup' &&
        !command.skipEmptyCheck &&
        !command.bulk
      ) {
        whenEmptied()
      }
      return true
    }
    const { tab, worktreeId } = outcome
    const commands = createWorkspaceTabCloseCommands({
      worktreeId,
      groupTabs: state.unifiedTabsByWorktree[worktreeId] ?? []
    })
    if ((command.bulk || command.skipEmptyCheck) && tab.isPinned) {
      return true
    }
    // Why before the pin guard: its prompt takes focus, and the floating panel's reaction reads focus.
    const whenEmptied =
      command.bulk || command.skipEmptyCheck
        ? undefined
        : captureWorkspaceEmptiedReaction(worktreeId, {
            floatingPanelGuestOwned: command.floatingPanelGuestOwned
          })
    const close = () =>
      commands.closeItem(tab.id, { whenEmptied, skipRunningProcessConfirm: command.bulk })
    if (tab.contentType === 'terminal' || command.bulk) {
      close()
    } else {
      guardPinnedTabClose({
        isPinned: tab.isPinned === true,
        tabLabel: resolvePinnedTabLabel(state, worktreeId, tab.id),
        onClose: close
      })
    }
    return true
  }
  if (command.type === 'previous-recent') {
    if (isFloatingWorkspacePanelFocused()) {
      return false
    }
    return handleSwitchRecentTab()
  }
  if (isFloatingWorkspacePanelFocused()) {
    switchFloatingWorkspaceTab(state, command.direction, command.scope)
    return true
  }
  switch (command.scope) {
    case 'same-type':
      return handleSwitchTab(command.direction)
    case 'all-types':
      return handleSwitchTabAcrossAllTypes(command.direction)
    case 'terminal':
      return handleSwitchTerminalTab(command.direction)
  }
}
