import type { AsksSlice } from '@/store/slices/fork-ask-question-tool/asks'
import { wireClaudeSuppressionVerdict } from './claude-suppression-verdict-bridge'

type AskStore = {
  getState: () => Pick<AsksSlice, 'hydrateAsks' | 'applyAskRegistryEvent'> &
    Partial<Pick<AsksSlice, 'resyncAsks'>>
}

/** Calls `onReturn` when the window becomes visible or focused again after being hidden or blurred. */
function watchWindowReturn(onReturn: () => void): () => void {
  if (typeof window.addEventListener !== 'function' || typeof document === 'undefined') {
    return () => {}
  }
  let away = document.visibilityState === 'hidden'
  const markAway = (): void => {
    away = true
  }
  const handleReturn = (): void => {
    if (away && document.visibilityState !== 'hidden') {
      away = false
      onReturn()
    }
  }
  const handleVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      markAway()
    } else {
      handleReturn()
    }
  }
  window.addEventListener('blur', markAway)
  window.addEventListener('focus', handleReturn)
  document.addEventListener('visibilitychange', handleVisibility)
  return () => {
    window.removeEventListener('blur', markAway)
    window.removeEventListener('focus', handleReturn)
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}

/**
 * Starts the asks slice's hydration and forwards every `ask:set` IPC event to it. Injecting
 * `store` (rather than importing `useAppStore` directly) keeps this testable without the full
 * app store. Returns the preload disposer for the caller's own unmount cleanup (tech.md § C8).
 */
export function wireAskIpcEvents(store: AskStore): () => void {
  const asksApi: typeof window.api.asks | undefined = window.api.asks
  const state: Partial<ReturnType<AskStore['getState']>> = store.getState()
  // upstream's useIpcEvents tests drive this bridge with partial store and preload doubles
  if (!asksApi || typeof state.hydrateAsks !== 'function') {
    return () => {}
  }
  void state.hydrateAsks()
  const stopVerdict = wireClaudeSuppressionVerdict(asksApi)
  const stopAskEvents = asksApi.onSet((event) => {
    store.getState().applyAskRegistryEvent(event)
  })
  const stopResync = watchWindowReturn(() => {
    void store.getState().resyncAsks?.()
  })
  return () => {
    stopResync()
    stopAskEvents()
    stopVerdict()
  }
}
