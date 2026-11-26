import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { RetainedBrowserPaneOverlayLayer } from './browser-pane/assemble-chrome/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import StructuredAgentSessionPaneOverlayLayer from './native-chat/StructuredAgentSessionPaneOverlayLayer'
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'

/**
 * The retained pane hosts for one workspace: terminal, browser, emulator and structured-chat
 * panes anchored onto the group tree's pane bodies, plus the vault drop layer. Shared by every
 * host of the group tree so pane lifecycle (retention, parking, guest paint) has one owner.
 */
export function WorkspacePaneOverlayLayers({
  worktreeId,
  worktreePath,
  isVisible,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds,
  mountRetainedBrowserOverlay,
  mountEmulatorOverlay
}: {
  worktreeId: string
  worktreePath: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
  mountRetainedBrowserOverlay: boolean
  mountEmulatorOverlay: boolean
  /** No longer read: the chat view toggle it gated is gone. Callers outside this task still pass it. */
  ownsNativeChatToggleShortcut?: boolean
}): React.JSX.Element {
  return (
    <>
      <TerminalPaneOverlayLayer
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isWorktreeActive={isVisible}
        coldParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
      />
      <RetainedBrowserPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
        mountEligible={mountRetainedBrowserOverlay}
      />
      {mountEmulatorOverlay ? (
        <EmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
      ) : null}
      <StructuredAgentSessionPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
      />
      <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
    </>
  )
}
