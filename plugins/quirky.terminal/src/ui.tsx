import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { SessionsPanel, type SessionsReport } from './window/SessionsPanel'
import { paneMenuContributions, paneMenuQuickCommands, reportQuickCommandsMenu, sessionCommands, tabMenuContributions, terminalCommands, watchMenuContributions, watchQuickCommands, type MenuContributionSource, type QuickCommandSource } from './window/commands'
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
  const menu = useSyncExternalStore(source.subscribe, source.menu)
  return (
    <QuickCommandsStripButton
      context={context}
      workspace={workspace}
      group={group}
      repo={repo}
      menuOpen={menu === group.id}
      onMenuOpenChange={(open) => (open ? source.openMenu(group.id) : source.closeMenu(group.id))}
    />
  )
}

/** The slots beyond the tab area: strip quick commands and menu rows from public contributions. */
function workspaceSlots(context: UiPluginContext, workspace: string, source: QuickCommandSource, contributions: MenuContributionSource): WorkspaceOptions {
  return {
    ...(workspace === FLOATING_WORKSPACE
      ? {}
      : {
          stripExtras: (group: Group) => <StripQuickCommands context={context} workspace={workspace} group={group} source={source} />,
          plusMenuContributions: (group, workspaceId) => tabMenuContributions(context, contributions, workspace, workspaceId, group),
          subscribeMenuContributions: contributions.subscribe
        }),
    paneMenuExtras: (pane) => paneMenuQuickCommands(context, source, pane.id),
    paneMenuContributions: (pane, session) => paneMenuContributions(context, contributions, pane, session)
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
  const menuContributions = watchMenuContributions(context)
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
    const reporting = source ? reportQuickCommandsMenu(source, (state) => props.report?.(state)) : null
    const unmount = mountWorkspace(context, element, reporting ? { ...props, report: reporting.report } : props, worktree !== null && source ? workspaceSlots(context, worktree, source, menuContributions) : {})
    return () => {
      unmount()
      reporting?.stop()
      source?.dispose()
    }
  })

  context.provide(QUICK_COMMANDS_PANEL, (element: HTMLElement, props: MountProps) => mountQuickCommandsPanel(context, element, { report: props.report }))

  context.provide(FLOATING_OVERLAY, (element: HTMLElement, props: MountProps) => {
    const source = watchQuickCommands(context, FLOATING_WORKSPACE)
    const unmount = mountFloatingOverlay(context, element, props, () => workspaceSlots(context, FLOATING_WORKSPACE, source, menuContributions))
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
