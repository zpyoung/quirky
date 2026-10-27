import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { SessionsPanel, type SessionsReport } from './window/SessionsPanel'
import {
  QUICK_COMMANDS_MENU,
  paneMenuQuickCommands,
  sessionCommands,
  stripQuickCommandItems,
  terminalCommands,
  watchQuickCommands,
  type QuickCommandSource
} from './window/commands'
import { mountFloatingOverlay } from './window/floating'
import { QuickCommandsStripButton, mountQuickCommandsPanel } from './window/quick-commands'
import { mountWorkspace, type WorkspaceOptions } from './window/workspace'
import { terminalSettingName } from './window/workspace/model'
import { FLOATING_WORKSPACE, type Group } from './layout/types'

const PANEL_ID = 'panel:quirky.terminal/sessions'
const WORKTREE_VIEW = 'view:quirky.session/worktree'
const QUICK_COMMANDS_PANEL = 'panel:quirky.terminal/quick-commands'
const FLOATING_OVERLAY = 'overlay:quirky.terminal/floating'

type MountProps = { input?: unknown; report?(state: unknown): void }

function StripQuickCommands({ context, workspace, group, source }: { context: UiPluginContext; workspace: string; group: Group; source: QuickCommandSource }) {
  const repo = useSyncExternalStore(source.subscribe, source.repo)
  return <QuickCommandsStripButton context={context} workspace={workspace} group={group} repo={repo} />
}

/** The slots a workspace view fills beyond the tab area: the strip's quick-command button (not in the floating workspace), the pane menu rows and the quick-commands menu. */
function workspaceSlots(context: UiPluginContext, workspace: string, source: QuickCommandSource): WorkspaceOptions {
  return {
    ...(workspace === FLOATING_WORKSPACE ? {} : { stripExtras: (group: Group) => <StripQuickCommands context={context} workspace={workspace} group={group} source={source} /> }),
    paneMenuExtras: (pane) => paneMenuQuickCommands(context, source, pane.id),
    extraMenus: { [QUICK_COMMANDS_MENU]: (target) => stripQuickCommandItems(context, source, workspace, target) }
  }
}

function worktreeOf(input: unknown): string | null {
  const worktree = (input as { worktree?: unknown } | null | undefined)?.worktree
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

/**
 * Provides the workspace view that replaces `quirky.session`'s, the Quick Commands panel, the
 * floating overlay, the Terminal Sessions panel, every window command, and the session commands
 * this plugin overrides. Keeps the `terminalKeysFirst` context key in step with the shortcut policy.
 */
export function activate(context: UiPluginContext): void {
  context.provide(PANEL_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    const report = (state: SessionsReport) => props.report?.(state)
    root.render(<SessionsPanel context={context} report={report} />)
    return () => root.unmount()
  })
  context.provide('command:quirky.terminal/manage-sessions', () => context.togglePanel(PANEL_ID, true))

  context.provide(WORKTREE_VIEW, (element: HTMLElement, props: MountProps) => {
    const worktree = worktreeOf(props.input)
    const source = worktree === null ? null : watchQuickCommands(context, worktree)
    const unmount = mountWorkspace(context, element, props, worktree !== null && source ? workspaceSlots(context, worktree, source) : {})
    return () => {
      unmount()
      source?.dispose()
    }
  })

  context.provide(QUICK_COMMANDS_PANEL, (element: HTMLElement, props: MountProps) => mountQuickCommandsPanel(context, element, { report: props.report }))

  context.provide(FLOATING_OVERLAY, (element: HTMLElement, props: MountProps) => {
    const source = watchQuickCommands(context, FLOATING_WORKSPACE)
    const unmount = mountFloatingOverlay(context, element, props, () => workspaceSlots(context, FLOATING_WORKSPACE, source))
    return () => {
      unmount()
      source.dispose()
    }
  })

  for (const [name, handler] of Object.entries(terminalCommands(context))) context.provide(`command:quirky.terminal/${name}`, handler)
  for (const [name, handler] of Object.entries(sessionCommands(context))) context.provide(`command:quirky.session/${name}`, handler)

  const keysFirst = (policy: unknown) => context.setContext('terminalKeysFirst', policy === 'terminal-first')
  try {
    keysFirst(context.getSetting('shortcut-policy'))
  } catch {
    keysFirst('app-first')
  }
  context.subscribe((event) => {
    if (event.type === 'setting.changed' && terminalSettingName(event.id) === 'shortcut-policy') keysFirst(event.value)
  })
}
