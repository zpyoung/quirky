import type { DestructiveSpec } from '../public-rpc/public-method-spec'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../tui-agent-display-names'
import { agentTabActionId } from './definitions'
import type { AgentTabActionId, KeybindingActionId, PluginKeybindingActionId } from './types'

/**
 * One keybinding action as the public CLI sees it. `rpc` actions have a handler in the renderer's
 * app command map and run through `ui.runAction`; `ui-only` actions need DOM focus inside one
 * specific editor, terminal or browser instance, so `uiOnlyReason` names the typed command to use.
 */
export type ActionCatalogEntry = {
  description: string
  dispatch: 'rpc' | 'ui-only'
  uiOnlyReason?: string
  destructive?: DestructiveSpec
  takesWorkspace?: boolean
}

/** Plugin command ids are minted at runtime by installed plugins and are not cataloged. */
export type CatalogedActionId = Exclude<KeybindingActionId, PluginKeybindingActionId>

type RpcOptions = Pick<ActionCatalogEntry, 'destructive' | 'takesWorkspace'>

function rpc(description: string, options: RpcOptions = {}): ActionCatalogEntry {
  return { description, dispatch: 'rpc', ...options }
}

function uiOnly(
  description: string,
  uiOnlyReason: string,
  options: RpcOptions = {}
): ActionCatalogEntry {
  return { description, dispatch: 'ui-only', uiOnlyReason, ...options }
}

const BROWSER_PAGE = 'acts on a focused browser page; use the `quirky browser` commands'
const EDITOR_LOCAL = 'acts on the focused editor instance; use `quirky file ...`'
const TERMINAL_PANE = 'acts on the focused terminal pane; use `quirky terminal ...`'
const DIGIT_CHORD = 'a digit chord that carries no index over RPC; use `quirky worktree set`'

function buildAgentTabEntries(): Record<AgentTabActionId, ActionCatalogEntry> {
  const entries: Partial<Record<AgentTabActionId, ActionCatalogEntry>> = {}
  for (const agent of ALL_TUI_AGENTS) {
    entries[agentTabActionId(agent)] = rpc(
      `Open a new ${TUI_AGENT_DISPLAY_NAMES[agent]} agent tab.`
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loop above sets one entry for every TuiAgent, which is exactly the AgentTabActionId union.
  return entries as Record<AgentTabActionId, ActionCatalogEntry>
}

export const ACTION_CATALOG: Readonly<Record<CatalogedActionId, ActionCatalogEntry>> = {
  'worktree.quickOpen': rpc('Open Go to File for the active workspace.'),
  'worktree.palette': rpc('Toggle the workspace switcher palette.'),
  'worktree.navigateUp': uiOnly(
    'Select the previous workspace in the sidebar list.',
    'list-local to the focused sidebar list; use `quirky worktree set`'
  ),
  'worktree.navigateDown': uiOnly(
    'Select the next workspace in the sidebar list.',
    'list-local to the focused sidebar list; use `quirky worktree set`'
  ),
  'app.settings': rpc('Open the Settings page.'),
  'app.forceReload': uiOnly(
    'Reload the app window.',
    'reloads the renderer and drops its in-memory state; relaunch the app instead'
  ),
  'workspace.create': rpc('Open the new workspace composer.'),
  'workspace.rename': rpc('Rename the active workspace inline in the sidebar.'),
  'workspace.delete': rpc(
    'Delete a workspace; takes an explicit workspace, never the hovered one.',
    {
      destructive: { category: 'workspace-delete' },
      takesWorkspace: true
    }
  ),
  'workspace.openBoard': rpc('Toggle the workspace board.'),
  'workspace.selectByIndex': uiOnly('Select workspace 1 to 9 in the sidebar list.', DIGIT_CHORD),
  'dashboard.toggle': rpc('Toggle the agent dashboard.'),
  'voice.dictation': uiOnly(
    'Hold to dictate into the focused field.',
    'a hold gesture that needs a focused text field; use `quirky terminal send`'
  ),
  'view.tasks': rpc('Open the Tasks page.'),
  'view.ledger': rpc('Open the Ledger page.'),

  'sidebar.left.toggle': rpc('Toggle the left sidebar.'),
  'sidebar.right.toggle': rpc('Toggle the right sidebar.'),
  'sidebar.explorer.toggle': rpc('Show the file explorer in the right sidebar.'),
  'sidebar.search.toggle': rpc('Show search in the right sidebar.'),
  'sidebar.sourceControl.toggle': rpc('Show source control in the right sidebar.'),
  'sidebar.checks.toggle': rpc('Show checks in the right sidebar.'),
  'sidebar.ports.toggle': rpc('Show ports in the right sidebar.'),
  'sidebar.sleepingWorkspaces.toggle': rpc('Show or hide sleeping workspaces in the sidebar.'),
  'sidebar.childWorkspaces.toggle': rpc(
    'Expand or collapse the child workspaces of the active workspace.'
  ),
  'sidebar.focusWorktreeList': uiOnly(
    'Move keyboard focus to the workspace list.',
    'moves DOM focus only; use `quirky worktree set` to change the workspace'
  ),

  'floatingTerminal.toggle': rpc('Show or hide the floating terminal.'),
  'floatingWorkspace.maximize': rpc('Open the floating workspace panel maximized.'),
  'floatingWorkspace.minimize': rpc('Hide the floating workspace panel.'),

  'zoom.in': rpc('Zoom the focused surface in.'),
  'zoom.out': rpc('Zoom the focused surface out.'),
  'zoom.reset': rpc('Reset the focused surface zoom.'),

  'worktree.history.back': rpc('Go back in workspace history.'),
  'worktree.history.forward': rpc('Go forward in workspace history.'),

  'tab.newTerminal': rpc('Open a new terminal tab in the active workspace.'),
  'tab.newAgent': rpc('Open a new tab with the default agent.'),
  ...buildAgentTabEntries(),
  'tab.newBrowser': rpc('Open a new browser tab in the active workspace.'),
  'tab.newSimulator': uiOnly(
    'Open a new mobile emulator tab.',
    'gated on the emulator being enabled in the window; use `quirky emulator ...`'
  ),
  'tab.newMarkdown': rpc('Open a new untitled markdown tab in the active workspace.'),
  'tab.openMarkdown': uiOnly(
    'Open a markdown file in a tab.',
    'opens a file picker; use `quirky file open`'
  ),
  'tab.close': rpc('Close the active tab.', { takesWorkspace: true }),
  'tab.closeAll': uiOnly(
    'Close all editor tabs.',
    'asks for confirmation in the tab bar; close tabs with `quirky tab close`'
  ),
  'tab.rename': rpc('Rename the active tab inline.'),
  'tab.reopenClosed': rpc('Reopen the most recently closed tab.', { takesWorkspace: true }),
  'tab.nextSameType': rpc('Switch to the next tab of the same type.'),
  'tab.previousSameType': rpc('Switch to the previous tab of the same type.'),
  'tab.nextAllTypes': rpc('Switch to the next tab of any type.'),
  'tab.previousAllTypes': rpc('Switch to the previous tab of any type.'),
  'tab.previousRecent': rpc('Switch to the previously used tab.'),
  'tab.nextTerminal': rpc('Switch to the next terminal tab.'),
  'tab.previousTerminal': rpc('Switch to the previous terminal tab.'),
  'tab.selectByIndex': uiOnly(
    'Select tab 1 to 9.',
    'a digit chord that carries no index over RPC; use `quirky tab switch`'
  ),
  'tab.openQuickCommandsMenu': rpc('Toggle the quick commands menu.'),

  'browser.find': uiOnly('Find text in the browser page.', BROWSER_PAGE),
  'chat.find': uiOnly(
    'Find text in the chat.',
    'acts on the focused chat view; use `quirky agent session ...`'
  ),
  'browser.back': uiOnly('Go back in the browser page.', BROWSER_PAGE),
  'browser.forward': uiOnly('Go forward in the browser page.', BROWSER_PAGE),
  'browser.reload': uiOnly('Reload the browser page.', BROWSER_PAGE),
  'browser.hardReload': uiOnly('Hard reload the browser page.', BROWSER_PAGE),
  'browser.focusAddressBar': uiOnly('Focus the browser address bar.', BROWSER_PAGE),
  'browser.grabElement': uiOnly('Grab an element from the browser page.', BROWSER_PAGE),
  'browser.annotateElement': uiOnly('Annotate an element on the browser page.', BROWSER_PAGE),

  'editor.find': uiOnly('Find text in the editor.', EDITOR_LOCAL),
  'editor.replace': uiOnly('Find and replace text in the editor.', EDITOR_LOCAL),
  'editor.save': uiOnly('Save the active file.', EDITOR_LOCAL),
  'editor.markdownPreview': uiOnly('Show the markdown preview.', EDITOR_LOCAL),
  'editor.toggleWordWrap': uiOnly('Toggle word wrap in the editor.', EDITOR_LOCAL),
  'editor.copyContext': uiOnly('Copy the editor selection with its file context.', EDITOR_LOCAL),
  'editor.previousChange': uiOnly('Go to the previous change in the editor.', EDITOR_LOCAL),
  'editor.nextChange': uiOnly('Go to the next change in the editor.', EDITOR_LOCAL),
  'editor.addReviewNote': uiOnly('Add a review note at the editor cursor.', EDITOR_LOCAL),
  'sourceControl.sendReviewNotes': rpc('Open the send menu for unsent review notes.'),

  'fileExplorer.undo': uiOnly(
    'Undo the last file explorer operation.',
    'focus-local to the file explorer; use `quirky file ...`'
  ),
  'fileExplorer.redo': uiOnly(
    'Redo the last file explorer operation.',
    'focus-local to the file explorer; use `quirky file ...`'
  ),
  'fileExplorer.copyPath': uiOnly(
    'Copy the selected file path.',
    'focus-local to the file explorer selection; use `quirky file ...`'
  ),
  'fileExplorer.copyRelativePath': uiOnly(
    'Copy the selected file path relative to the workspace.',
    'focus-local to the file explorer selection; use `quirky file ...`'
  ),
  'fileExplorer.delete': uiOnly(
    'Delete the selected file.',
    'acts on the focused explorer selection; use `quirky file ...`',
    { destructive: { category: 'file-overwrite-delete' } }
  ),

  'settings.search': uiOnly(
    'Search settings.',
    'focus-local to the Settings page; use `quirky settings ...`'
  ),

  'terminal.copySelection': uiOnly('Copy the terminal selection.', TERMINAL_PANE),
  'terminal.selectAll': uiOnly('Select all terminal text.', TERMINAL_PANE),
  'terminal.paste': uiOnly('Paste into the terminal.', TERMINAL_PANE),
  'terminal.search': uiOnly('Search the active terminal pane.', TERMINAL_PANE),
  'terminal.clear': uiOnly('Clear the active terminal pane.', TERMINAL_PANE),
  'terminal.focusNextPane': uiOnly('Focus the next terminal pane.', TERMINAL_PANE),
  'terminal.focusPreviousPane': uiOnly('Focus the previous terminal pane.', TERMINAL_PANE),
  'terminal.equalizePaneSizes': uiOnly('Equalize terminal pane sizes.', TERMINAL_PANE),
  'terminal.expandPane': uiOnly('Expand or collapse the active terminal pane.', TERMINAL_PANE),
  'terminal.setTitle': uiOnly('Set the title of the active terminal pane.', TERMINAL_PANE),
  'terminal.clearPaneTitle': uiOnly('Clear the active pane title.', TERMINAL_PANE),
  'terminal.closePane': uiOnly('Close the active terminal pane.', TERMINAL_PANE),
  'terminal.splitRight': uiOnly('Split the active terminal pane to the right.', TERMINAL_PANE),
  'terminal.splitDown': uiOnly('Split the active terminal pane downward.', TERMINAL_PANE),
  'terminal.switchInputSource': uiOnly(
    'Switch the native input source.',
    'a native input method switch with no typed equivalent'
  ),
  'terminal.dock.toggle': uiOnly('Toggle the agent composer dock.', TERMINAL_PANE),
  'terminal.dock.passthrough': uiOnly('Toggle terminal passthrough mode.', TERMINAL_PANE)
}

export function isCatalogedActionId(value: string): value is CatalogedActionId {
  return Object.hasOwn(ACTION_CATALOG, value)
}
