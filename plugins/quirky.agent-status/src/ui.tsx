import { createRoot } from 'react-dom/client'
import type { Methods, MountFunction, UiPluginContext } from '@quirky/protocol'
import { ActivityView } from './ActivityView'
import { DashboardNavigation, DashboardView, dashboardViewInput } from './DashboardView'
import { openActivityThread } from './activity-navigation'

const PLUGIN_ID = 'quirky.agent-status'
const ACTIVITY_VIEW_ID = `view:${PLUGIN_ID}/activity`
const ACTIVITY_SIDEBAR_ID = `sidebar-section:${PLUGIN_ID}/activity`
const DASHBOARD_VIEW_ID = `view:${PLUGIN_ID}/dashboard`
const DASHBOARD_SIDEBAR_ID = `sidebar-section:${PLUGIN_ID}/dashboard`
const OPEN_DASHBOARD_COMMAND = `command:${PLUGIN_ID}/openDashboard`
const TOGGLE_DASHBOARD_COMMAND = `command:${PLUGIN_ID}/toggleDashboard`
const GROUPS = ['status', 'worktree', 'provider', 'none'] as const

type ActivityGroup = (typeof GROUPS)[number]

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}

function activityInput(args: unknown): Record<string, unknown> {
  const value = objectArgs(args)
  const group = GROUPS.includes(value.group as ActivityGroup) ? (value.group as ActivityGroup) : 'status'
  const worktree = typeof value.worktree === 'string' ? value.worktree.trim() : ''
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  return {
    ...(worktree ? { worktree } : {}),
    ...(text ? { text } : {}),
    ...(typeof value.unreadOnly === 'boolean' ? { unreadOnly: value.unreadOnly } : {}),
    group
  }
}


/** Registers Activity and Dashboard views, sidebar entries, and scriptable window commands. */
export function activate(context: UiPluginContext): void {
  const mountView: MountFunction = (element, { input }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' })
    const root = createRoot(element, { identifierPrefix: 'quirky-agent-status-activity-view-' })
    root.render(<ActivityView context={context} input={input} />)
    return () => root.unmount()
  }
  const mountSidebar: MountFunction = (element) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' })
    const root = createRoot(element, { identifierPrefix: 'quirky-agent-status-activity-sidebar-' })
    root.render(<ActivityView context={context} embedded />)
    return () => root.unmount()
  }
  const mountDashboard: MountFunction = (element, { input }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' })
    const root = createRoot(element)
    root.render(<DashboardView context={context} input={input} />)
    return () => root.unmount()
  }
  const mountDashboardSidebar: MountFunction = (element) => {
    const root = createRoot(element)
    root.render(<DashboardNavigation context={context} />)
    return () => root.unmount()
  }

  context.provide(ACTIVITY_VIEW_ID, mountView)
  context.provide(ACTIVITY_SIDEBAR_ID, mountSidebar)
  context.provide(DASHBOARD_VIEW_ID, mountDashboard)
  context.provide(DASHBOARD_SIDEBAR_ID, mountDashboardSidebar)
  context.provide(`command:${PLUGIN_ID}/openActivity`, (args?: unknown) => context.openView(ACTIVITY_VIEW_ID, activityInput(args)))
  context.provide(`command:${PLUGIN_ID}/openActivityThread`, (args?: unknown) => openActivityThread(context, args))
  const openWindow = (args?: unknown) => context.call('desktop.window.open', {
    view: DASHBOARD_VIEW_ID, input: dashboardViewInput(args), title: 'Agent Dashboard'
  })
  const usePopout = () => {
    try { return context.getSetting('dashboard-open-as') === 'pop-out' } catch { return false }
  }
  context.provide(`command:${PLUGIN_ID}/openDashboardWindow`, openWindow)
  context.provide(OPEN_DASHBOARD_COMMAND, (args?: unknown) =>
    usePopout() ? openWindow(args) : context.openView(DASHBOARD_VIEW_ID, dashboardViewInput(args))
  )
  context.provide(TOGGLE_DASHBOARD_COMMAND, async (args?: unknown) => {
    if (usePopout()) {
      const windows = await context.call('desktop.window.list', {}) as Methods['desktop.window.list']['result']
      const matching = windows.filter((window) => window.view === DASHBOARD_VIEW_ID)
      if (matching.length > 1) throw new Error('More than one Dashboard window exists. Close the exact window through desktop.window.close.')
      if (matching.length === 1) return context.call('desktop.window.close', { windowId: matching[0]!.windowId })
      return openWindow(args)
    }
    if (context.getLayout().view?.id === DASHBOARD_VIEW_ID) context.closeView()
    else context.openView(DASHBOARD_VIEW_ID, dashboardViewInput(args))
  })
}
