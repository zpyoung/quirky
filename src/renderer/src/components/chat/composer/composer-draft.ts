import { useCallback, useSyncExternalStore } from 'react'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'

/**
 * The unsent text of one draft scope, kept in the shared draft store so a reload, a remount and a
 * queued-message edit all see the same draft. Typing writes with the store's coalesced persistence;
 * the editor's own document never carries a rich-text tree, so a write drops any stored one.
 */
export function useComposerDraftText(scopeKey: string): {
  text: string
  setText: (next: string) => void
  /** Calls `listener` whenever the scope's draft changes, whoever changed it. */
  subscribe: (listener: () => void) => () => void
} {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  const text = useSyncExternalStore(subscribe, () => readNativeChatComposerDraft(scopeKey).text)
  const setText = useCallback(
    (next: string) =>
      updateNativeChatComposerDraft(scopeKey, { text: next, document: undefined }, 'deferred'),
    [scopeKey]
  )
  return { text, setText, subscribe }
}
