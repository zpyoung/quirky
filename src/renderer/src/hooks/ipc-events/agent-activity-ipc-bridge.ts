import { AGENT_TAB_TOUCH_METHODS, recordAgentActivity } from '@/lib/agent-activity-trail-store'
import { useAppStore } from '../../store'
import { readActiveTab } from './ui-action-ipc-bridge'

/**
 * Feeds the renderer's activity ring from main's `activity:recorded` pushes. The entry's `tabId`
 * is used when main sent one. Hosts that predate it send none, so a tab-touching call with a
 * workspace is then credited to that workspace's active tab, a guess at where focus was left.
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
          ? readActiveTab(useAppStore.getState(), workspaceId)?.id
          : entry.tabId
      recordAgentActivity(tabId === undefined ? entry : { ...entry, tabId })
    })
  )
}
