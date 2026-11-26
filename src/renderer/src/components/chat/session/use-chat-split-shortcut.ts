import { useCallback, type KeyboardEventHandler } from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { runNativeChatSplitTarget } from '@/components/native-chat/native-chat-layout-actions'
import { matchNativeChatSplitShortcut } from '@/components/native-chat/native-chat-split-shortcut'

/** Split-right and split-down shortcuts pressed inside a chat tab split its workspace group. */
export function useChatSplitShortcut(
  tabId: string,
  groupId: string | undefined
): KeyboardEventHandler<HTMLDivElement> {
  const keybindings = useAppStore((state) => state.keybindings)
  return useCallback(
    (event) => {
      if (event.repeat || !groupId) {
        return
      }
      const direction = matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
      if (!direction) {
        return
      }
      const handled = runNativeChatSplitTarget(
        { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
        direction
      )
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [groupId, keybindings, tabId]
  )
}
