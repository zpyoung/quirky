import { useShallow } from 'zustand/react/shallow'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { requestScrollToCurrentWorkspaceRevealAndRename } from '@/lib/scroll-to-current-workspace-status'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import type { AppCommandDispatchResult, AppCommandSource } from '@/lib/app-command-dispatch'
import { openNewWorkspaceFromShortcut } from '../hooks/ipc-events/new-workspace-command'
import { toggleAgentDashboardFromShortcut } from '../hooks/ipc-events/agent-dashboard-command'
import { shouldShowWorktreeHistoryControls } from '../lib/titlebar-worktree-history-controls'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '../components/sidebar/useWorkspaceBoardPanel'
import {
  getRenderedLineageChipKeys,
  resolveChildWorkspacesToggleGroupKey
} from '../components/sidebar/child-workspaces-toggle-target'
import { requestTerminalTabRename } from '../components/tab-bar/terminal-tab-rename-request'
import {
  deleteConfirmedWorkspace,
  deleteHoveredWorkspaceImmediately,
  resolveHoveredWorkspaceDeleteTarget
} from '../components/sidebar/hovered-workspace-delete'
import { useAppStore } from '../store'
import { hasUnsentDiffNotesForActiveWorktree } from '../store/slices/ui/ui-slice-agent-actions'
import type { usePluginCommands } from '@/store/plugin-panels'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  isKeybindingActionId,
  type KeybindingActionId,
  type KeybindingContext,
  type PhysicalModifierToken
} from '../../../shared/keybindings'
import { shortcutPlatform } from './app-window-chrome'
import {
  TAB_COMMAND_FACTORIES,
  resolveExplicitWorkspaceDeleteTarget
} from './app-command-tab-handlers'
import { ZOOM_COMMAND_FACTORIES } from './app-command-zoom'

type AppStoreState = ReturnType<typeof useAppStore.getState>

// Abstraction over a real KeyboardEvent and a synthetic double-tap gesture so one dispatch path serves both; KeybindingInput-compatible.
export type ShortcutDispatchInput = {
  isComposing?: boolean
  altGraph?: boolean
  key?: string
  code?: string
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  doubleTapModifier?: PhysicalModifierToken
  target: EventTarget | null
  defaultPrevented: boolean
  preventDefault: () => void
}

export type AppShortcutActions = ReturnType<typeof useAppShortcutActions>

export type AppShortcutState = {
  activeView: AppStoreState['activeView']
  activeWorktreeId: AppStoreState['activeWorktreeId']
  actions: AppShortcutActions
  creationLayoutActive: boolean
  floatingTerminalEnabled: boolean
  floatingTerminalOpen: boolean
  floatingVisibleTabCount: number
  keybindings: AppStoreState['keybindings']
  openFloatingWorkspaceMaximized: () => void
  pluginCommands: ReturnType<typeof usePluginCommands>
  setFloatingTerminalOpen: (open: boolean) => void
  terminalShortcutPolicy: NonNullable<AppStoreState['settings']>['terminalShortcutPolicy']
  workspaceChromeActive: boolean
}

/** Per-call switches for a handler map built for something other than a key event. */
export type AppCommandHandlerOptions = {
  source?: AppCommandSource
  /** Workspace named by an RPC caller. */
  worktreeId?: string
  /** Host that owns `worktreeId` when several hosts publish the same workspace id. */
  hostId?: ExecutionHostId
  /** Answer whether the handler would claim, without running it. */
  probeOnly?: boolean
  /** Receives why a handler declined, keyed by action id. */
  declines?: Map<KeybindingActionId, string>
}

export function useAppShortcutActions() {
  // Why: consolidate action refs into one useShallow subscription so React runs one equality check per store mutation instead of one per action.
  return useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      showRightSidebarFiles: s.showRightSidebarFiles,
      showRightSidebarSearch: s.showRightSidebarSearch,
      openDiffNotesSendMenuForActiveWorktree: s.openDiffNotesSendMenuForActiveWorktree
    }))
  )
}

export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

/**
 * The tab id the inline rename editor listens on, which differs per tab kind: a terminal tab is
 * addressed by its backing terminal id (`activeTabId`), a structured chat tab by its unified tab
 * id. `activeTabId` is terminal-only state and never moves for a structured tab, so reading it
 * there targets whichever terminal was last active. Mirrors TabGroupPanel's tab-strip resolution.
 */
function resolveRenameTargetTabId(activeWorktreeId: string | null): string | null {
  const store = useAppStore.getState()
  if (store.activeTabType === 'terminal') {
    return store.activeTabId
  }
  if (store.activeTabType !== 'agent-session' || !activeWorktreeId) {
    return null
  }
  const activeTab = store.getActiveTab(activeWorktreeId)
  return activeTab?.contentType === 'agent-session' ? activeTab.id : null
}

/** A command that only sometimes applies: `check` reads state, `run` acts and reports whether it did. */
type ConditionalAction = { check: () => boolean; run: () => boolean }

type HandlerContext = {
  state: AppShortcutState
  options: AppCommandHandlerOptions
  floatingWorkspaceFocused: boolean
  canRevealRightSidebar: boolean
  /** Records why the handler declined and returns false so callers can `return decline(...)`. */
  decline: (actionId: KeybindingActionId, reason: string) => false
  /** Claims the command and runs it; a key event is consumed and may show the capture notice. */
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
  claimWhen: (actionId: KeybindingActionId, action: ConditionalAction, reason: string) => boolean
  revealRightSidebarTab: (
    actionId: KeybindingActionId,
    tab: Parameters<AppShortcutActions['setRightSidebarTab']>[0]
  ) => boolean
  /** The workspace an active-workspace action acts on, or null after recording why it cannot. */
  requireActiveWorkspace: (actionId: KeybindingActionId) => string | null
}

type HandlerFactory = (context: HandlerContext) => () => boolean

/**
 * Every store-level app command, keyed by action id. The keyboard path and `ui.runAction` build
 * the same map, so a command behaves the same whichever way it is invoked. Component-local
 * actions (needing DOM focus in one editor, terminal or browser instance) are not here; the
 * action catalog marks them ui-only.
 */
const STORE_FACTORIES: Partial<Record<KeybindingActionId, HandlerFactory>> = {
  'worktree.history.back': (context) => () => {
    const { creationLayoutActive, activeView } = context.state
    if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
      return context.decline(
        'worktree.history.back',
        'worktree history is only available in the terminal view'
      )
    }
    return context.claim('worktree.history.back', () => useAppStore.getState().goBackWorktree())
  },
  'worktree.history.forward': (context) => () => {
    const { creationLayoutActive, activeView } = context.state
    if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
      return context.decline(
        'worktree.history.forward',
        'worktree history is only available in the terminal view'
      )
    }
    return context.claim('worktree.history.forward', () =>
      useAppStore.getState().goForwardWorktree()
    )
  },
  'worktree.quickOpen': (context) => () => {
    const store = useAppStore.getState()
    if (store.activeView !== 'terminal' || store.activeWorktreeId === null) {
      return context.decline(
        'worktree.quickOpen',
        'Go to File needs an active workspace in the terminal view'
      )
    }
    return context.claim('worktree.quickOpen', () => store.openModal('quick-open'))
  },
  'worktree.palette': (context) => () =>
    context.claim('worktree.palette', () => {
      const store = useAppStore.getState()
      if (store.activeModal === 'worktree-palette') {
        store.closeModal()
        return
      }
      store.openModal('worktree-palette')
    }),
  'app.settings': (context) => () =>
    context.claim('app.settings', () => useAppStore.getState().openSettingsPage()),
  'sidebar.left.toggle': (context) => () =>
    context.claim('sidebar.left.toggle', () => context.state.actions.toggleSidebar()),
  'sidebar.sleepingWorkspaces.toggle': (context) => () =>
    context.claim('sidebar.sleepingWorkspaces.toggle', () => {
      const store = useAppStore.getState()
      const nextShowSleeping = !store.showSleepingWorkspaces
      store.setShowSleepingWorkspaces(nextShowSleeping)
      if (nextShowSleeping) {
        store.setSidebarOpen(true)
      }
    }),
  'sidebar.childWorkspaces.toggle': (context) => () => {
    const store = useAppStore.getState()
    // Locally controlled dialogs do not set activeModal.
    if (
      store.activeModal !== 'none' ||
      context.floatingWorkspaceFocused ||
      hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' })
    ) {
      return context.decline(
        'sidebar.childWorkspaces.toggle',
        'a dialog, overlay or the floating workspace has focus'
      )
    }
    const groupKey = resolveChildWorkspacesToggleGroupKey(store, getRenderedLineageChipKeys(store))
    if (!groupKey) {
      return context.decline(
        'sidebar.childWorkspaces.toggle',
        'the active workspace has no child workspaces to toggle'
      )
    }
    return context.claim('sidebar.childWorkspaces.toggle', () => {
      const expanding = store.collapsedGroups.has(groupKey)
      // Why: same scroll anchoring as the chip click, so the viewport does not jump.
      requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')
      store.toggleCollapsedGroup(groupKey)
      if (expanding) {
        store.setSidebarOpen(true)
      }
    })
  },
  'floatingTerminal.toggle': (context) => () =>
    context.state.floatingTerminalEnabled
      ? context.claim('floatingTerminal.toggle', () =>
          window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
        )
      : context.decline('floatingTerminal.toggle', 'the floating terminal is disabled in Settings'),
  'floatingWorkspace.maximize': (context) => () => {
    const { floatingTerminalOpen, floatingTerminalEnabled, openFloatingWorkspaceMaximized } =
      context.state
    if (floatingTerminalOpen) {
      return context.decline(
        'floatingWorkspace.maximize',
        'the floating workspace panel is already open'
      )
    }
    if (!floatingTerminalEnabled) {
      return context.decline(
        'floatingWorkspace.maximize',
        'the floating terminal is disabled in Settings'
      )
    }
    return context.claim('floatingWorkspace.maximize', openFloatingWorkspaceMaximized)
  },
  'floatingWorkspace.minimize': (context) => () =>
    context.state.floatingTerminalOpen
      ? context.claim('floatingWorkspace.minimize', () =>
          context.state.setFloatingTerminalOpen(false)
        )
      : context.decline('floatingWorkspace.minimize', 'the floating workspace panel is not open'),
  'tab.rename': (context) => () => {
    const { workspaceChromeActive } = context.state
    if (!workspaceChromeActive || context.floatingWorkspaceFocused) {
      return context.decline('tab.rename', 'no workspace tab strip is focused')
    }
    const worktreeId = context.requireActiveWorkspace('tab.rename')
    if (worktreeId === null) {
      return false
    }
    // Why: a structured chat tab is renamed through the same inline editor, so gating on
    // 'terminal' alone left the shortcut a silent no-op there.
    const tabId = resolveRenameTargetTabId(worktreeId)
    if (!tabId) {
      return context.decline('tab.rename', `no focused tab in workspace ${worktreeId}`)
    }
    return context.claim('tab.rename', () => requestTerminalTabRename(tabId))
  },
  'workspace.create': (context) => () =>
    context.claim('workspace.create', () => openNewWorkspaceFromShortcut(useAppStore.getState())),
  'workspace.rename': (context) => () => {
    const { workspaceChromeActive, activeWorktreeId } = context.state
    if (!workspaceChromeActive || context.floatingWorkspaceFocused || !activeWorktreeId) {
      return context.decline('workspace.rename', 'no active workspace to rename')
    }
    if (context.requireActiveWorkspace('workspace.rename') === null) {
      return false
    }
    return context.claim('workspace.rename', () => {
      useAppStore.getState().setSidebarOpen(true)
      requestScrollToCurrentWorkspaceRevealAndRename()
    })
  },
  'workspace.delete': (context) => () => {
    const store = useAppStore.getState()
    if (context.options.source === 'rpc') {
      if (!context.options.worktreeId) {
        return context.decline(
          'workspace.delete',
          'workspace.delete requires an explicit workspace'
        )
      }
      const resolved = resolveExplicitWorkspaceDeleteTarget(
        store,
        context.options.worktreeId,
        context.options.hostId
      )
      if ('reason' in resolved) {
        return context.decline('workspace.delete', resolved.reason)
      }
      // the public gate already handled preview, --yes and approval, so the legacy confirm modal must not reopen
      return context.claim('workspace.delete', () => {
        deleteConfirmedWorkspace(store, resolved.target)
      })
    }
    if (context.floatingWorkspaceFocused) {
      return context.decline('workspace.delete', 'the floating workspace has focus')
    }
    const target = resolveHoveredWorkspaceDeleteTarget(store)
    if (!target) {
      return context.decline('workspace.delete', 'no workspace row is hovered')
    }
    return context.claim('workspace.delete', () => {
      deleteHoveredWorkspaceImmediately(store, target)
    })
  },
  'workspace.openBoard': (context) => () => {
    if (context.state.activeView === 'settings') {
      return context.decline('workspace.openBoard', 'the board is not available in Settings')
    }
    return context.claim('workspace.openBoard', () => {
      useAppStore.getState().setSidebarOpen(true)
      window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
    })
  },
  'dashboard.toggle': (context) => () => {
    const store = useAppStore.getState()
    if (
      context.state.activeView === 'settings' ||
      store.settings?.experimentalAgentDashboardPopout !== true
    ) {
      return context.decline('dashboard.toggle', 'the agent dashboard is not enabled in Settings')
    }
    return context.claim('dashboard.toggle', () =>
      toggleAgentDashboardFromShortcut(store, () => {
        void window.api.dashboard.openPopout()
      })
    )
  },
  'view.tasks': (context) => () => {
    const store = useAppStore.getState()
    if (
      context.state.activeView === 'settings' ||
      !store.repos.some((repo) => isGitRepoKind(repo))
    ) {
      return context.decline('view.tasks', 'Tasks needs a git repository and a non-Settings view')
    }
    return context.claim('view.tasks', () => store.openTaskPage())
  },
  'view.ledger': (context) => () =>
    context.claim('view.ledger', () => useAppStore.getState().openLedgerPage()),
  'sidebar.right.toggle': (context) => () =>
    context.canRevealRightSidebar
      ? context.claim('sidebar.right.toggle', () => context.state.actions.toggleRightSidebar())
      : context.decline('sidebar.right.toggle', 'the right sidebar is not available in this view'),
  'sidebar.explorer.toggle': (context) => () =>
    context.canRevealRightSidebar
      ? context.claim('sidebar.explorer.toggle', () =>
          context.state.actions.showRightSidebarFiles()
        )
      : context.decline(
          'sidebar.explorer.toggle',
          'the right sidebar is not available in this view'
        ),
  'sidebar.search.toggle': (context) => () =>
    context.canRevealRightSidebar
      ? context.claim('sidebar.search.toggle', () => context.state.actions.showRightSidebarSearch())
      : context.decline('sidebar.search.toggle', 'the right sidebar is not available in this view'),
  'sidebar.sourceControl.toggle': (context) => () =>
    // Why: the terminal's own find bar owns this chord while it is open.
    document.querySelector('[data-terminal-search-root]')
      ? context.decline('sidebar.sourceControl.toggle', 'the terminal find bar is open')
      : context.revealRightSidebarTab('sidebar.sourceControl.toggle', 'source-control'),
  'sidebar.checks.toggle': (context) => () =>
    context.revealRightSidebarTab('sidebar.checks.toggle', 'checks'),
  'sidebar.ports.toggle': (context) => () =>
    context.revealRightSidebarTab('sidebar.ports.toggle', 'ports'),
  'sourceControl.sendReviewNotes': (context) => () =>
    context.canRevealRightSidebar
      ? context.claimWhen(
          'sourceControl.sendReviewNotes',
          {
            check: () => hasUnsentDiffNotesForActiveWorktree(() => useAppStore.getState()),
            run: () => context.state.actions.openDiffNotesSendMenuForActiveWorktree()
          },
          'the active workspace has no unsent review notes'
        )
      : context.decline(
          'sourceControl.sendReviewNotes',
          'the right sidebar is not available in this view'
        )
}

const HANDLER_FACTORIES: Partial<Record<KeybindingActionId, HandlerFactory>> = {
  ...STORE_FACTORIES,
  ...ZOOM_COMMAND_FACTORIES,
  ...TAB_COMMAND_FACTORIES
}

/** The ids `createAppCommandHandlers` produces a handler for; the action catalog's `rpc` entries must all be here. */
export const APP_COMMAND_HANDLER_IDS: readonly KeybindingActionId[] =
  Object.keys(HANDLER_FACTORIES).filter(isKeybindingActionId)

/**
 * Builds the app-level handlers for every store-level keybindable action. Each returns whether it
 * claimed the command, so an unavailable surface (settings view, closed floating panel) falls
 * through to the terminal or the next handler instead of silently no-opping.
 *
 * `input` is absent when a command is invoked from the palette, menu or RPC rather than a key
 * event. `options.declines` receives the reason each declined handler gives.
 */
export function createAppCommandHandlers(
  state: AppShortcutState,
  input?: ShortcutDispatchInput,
  keybindingContext: KeybindingContext = 'app',
  options: AppCommandHandlerOptions = {}
): Map<KeybindingActionId, () => boolean> {
  const {
    activeView,
    activeWorktreeId,
    creationLayoutActive,
    keybindings,
    terminalShortcutPolicy
  } = state
  const consumeKey = (actionId: KeybindingActionId): void => {
    input?.preventDefault()
    if (
      input &&
      keybindingContext === 'terminal' &&
      (terminalShortcutPolicy ?? 'quirky-first') === 'quirky-first'
    ) {
      showTerminalShortcutCaptureNotification({
        actionId,
        platform: shortcutPlatform,
        keybindings
      })
    }
  }
  const decline = (actionId: KeybindingActionId, reason: string): false => {
    options.declines?.set(actionId, reason)
    return false
  }
  const claim = (actionId: KeybindingActionId, run: () => void): boolean => {
    if (options.probeOnly) {
      return true
    }
    consumeKey(actionId)
    run()
    return true
  }
  const claimWhen = (
    actionId: KeybindingActionId,
    action: ConditionalAction,
    reason: string
  ): boolean => {
    if (!action.check()) {
      return decline(actionId, reason)
    }
    if (options.probeOnly) {
      return true
    }
    if (!action.run()) {
      return decline(actionId, reason)
    }
    consumeKey(actionId)
    return true
  }
  const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)
  const context: HandlerContext = {
    state,
    options,
    floatingWorkspaceFocused: isFloatingWorkspacePanelFocused(),
    canRevealRightSidebar,
    decline,
    claim,
    claimWhen,
    revealRightSidebarTab: (actionId, tab) =>
      canRevealRightSidebar
        ? claim(actionId, () => {
            state.actions.setRightSidebarTab(tab)
            state.actions.setRightSidebarOpen(true)
          })
        : decline(actionId, 'the right sidebar is not available in this view'),
    requireActiveWorkspace: (actionId) => {
      if (!activeWorktreeId) {
        decline(actionId, 'no active workspace')
        return null
      }
      if (options.worktreeId && options.worktreeId !== activeWorktreeId) {
        decline(actionId, `workspace ${options.worktreeId} is not the active workspace`)
        return null
      }
      return activeWorktreeId
    }
  }

  const handlers = new Map<KeybindingActionId, () => boolean>()
  for (const [actionId, factory] of Object.entries(HANDLER_FACTORIES)) {
    if (factory && isKeybindingActionId(actionId)) {
      handlers.set(actionId, factory(context))
    }
  }
  return handlers
}

/**
 * Runs one command for a caller that wants the outcome (RPC, palette) and, when it is declined,
 * the reason, instead of a bare boolean.
 */
export function runAppCommand(
  state: AppShortcutState,
  actionId: KeybindingActionId,
  options: AppCommandHandlerOptions = {}
): AppCommandDispatchResult {
  const declines = new Map<KeybindingActionId, string>()
  const handler = createAppCommandHandlers(state, undefined, 'app', { ...options, declines }).get(
    actionId
  )
  if (!handler) {
    return { claimed: false, reason: `${actionId} has no handler in the app window` }
  }
  if (handler()) {
    return { claimed: true }
  }
  return {
    claimed: false,
    reason: declines.get(actionId) ?? `${actionId} is not available in the current view`
  }
}
