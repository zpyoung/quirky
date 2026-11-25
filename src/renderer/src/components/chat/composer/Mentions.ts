import { useNativeChatMentionFiles } from '@/components/native-chat/use-native-chat-mention-files'

export type FileSearch = { items: readonly string[]; unavailable: boolean }

/**
 * Searches the workspace's files for `query` through the workspace file list the chat already uses.
 * `query` null means no search is wanted; `unavailable` is true when the list cannot be read.
 */
export function useFileSearch(
  workspace: { worktreeId?: string; terminalTabId: string },
  query: string | null
): FileSearch {
  const found = useNativeChatMentionFiles({
    query,
    terminalTabId: workspace.terminalTabId,
    ...(workspace.worktreeId === undefined ? {} : { structuredWorktreeId: workspace.worktreeId })
  })
  return { items: found.files, unavailable: found.failed }
}
