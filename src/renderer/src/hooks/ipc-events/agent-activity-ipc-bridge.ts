import { AGENT_TAB_TOUCH_METHODS, recordAgentActivity } from '@/lib/agent-activity-trail-store'
import { useAppStore } from '../../store'

/**
 * Feeds the renderer's activity ring from main's `activity:recorded` pushes. Main does not say
 * which tab a call touched, so a tab-touching call with a workspace is credited to that
 * workspace's active tab, which is where such a call leaves focus.
 */
export function registerAgentActivityIpcBridge(unsubs: (() => void)[]): void {
  const onActivityRecorded = window.api.ui.onActivityRecorded
  if (!onActivityRecorded) {
    return
  }
  unsubs.push(
    onActivityRecorded((entry) => {
      const { workspaceId } = entry
      const tabId =
        entry.tabId === undefined &&
        workspaceId !== undefined &&
        AGENT_TAB_TOUCH_METHODS.has(entry.method)
          ? useAppStore.getState().getActiveTab(workspaceId)?.id
          : entry.tabId
      recordAgentActivity(tabId === undefined ? entry : { ...entry, tabId })
    })
  )
}
