// Shared LRU bound for the composer's per-scope caches (draft text, history,
// and image attachments), all keyed by stable pane identity. The
// caches exist so an in-progress message survives the composer unmounting on a
// TUI/GUI toggle, but a scope key for a permanently-removed pane is never
// revisited, so without a bound its unsent entry would linger for the renderer's
// whole session. delete-then-set keeps the actively-edited scope most-recent so
// eviction only sheds the oldest untouched scopes.
//
// A scope with a live subscriber (any per-scope cache) is pinned and skipped by
// eviction: mounted React state can mask a bounded cache silently dropping a
// still-open pane's payload, so eviction must only ever shed dead scopes.
export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128

const pinnedScopeCounts = new Map<string, number>()

/** Pins `scopeKey` against eviction while at least one caller holds a pin. Returns the unpin function. */
export function pinScopeCacheKey(scopeKey: string): () => void {
  pinnedScopeCounts.set(scopeKey, (pinnedScopeCounts.get(scopeKey) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = pinnedScopeCounts.get(scopeKey) ?? 0
    if (count <= 1) {
      pinnedScopeCounts.delete(scopeKey)
    } else {
      pinnedScopeCounts.set(scopeKey, count - 1)
    }
  }
}

function isScopeCacheKeyPinned(scopeKey: string): boolean {
  return (pinnedScopeCounts.get(scopeKey) ?? 0) > 0
}

function oldestUnpinnedKey<T>(cache: Map<string, T>, excludeKey: string): string | undefined {
  for (const key of cache.keys()) {
    // never evict the entry this write just landed, even if it isn't itself pinned yet
    if (key !== excludeKey && !isScopeCacheKeyPinned(key)) {
      return key
    }
  }
  return undefined
}

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T
): void {
  cache.delete(scopeKey)
  cache.set(scopeKey, value)
  while (cache.size > NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
    const oldest = oldestUnpinnedKey(cache, scopeKey)
    if (oldest === undefined) {
      // every entry is pinned (live) — grow past the cap rather than evict live state
      break
    }
    cache.delete(oldest)
  }
}

export function clearScopeCachePinsForTests(): void {
  pinnedScopeCounts.clear()
}

type SubscribableScopeCacheOptions<T> = {
  createEmptyValue: () => T
  isEmpty: (value: T) => boolean
  copyValue?: (value: T) => T
}

export type SubscribableScopeCache<T> = {
  read: (scopeKey: string) => T
  write: (scopeKey: string, value: T) => void
  subscribe: (scopeKey: string, listener: (value: T) => void) => () => void
  clearForTests: () => void
}

/** Creates a bounded per-scope cache whose subscribers receive the current value and every write. */
export function createSubscribableScopeCache<T>({
  createEmptyValue,
  isEmpty,
  copyValue
}: SubscribableScopeCacheOptions<T>): SubscribableScopeCache<T> {
  const cache = new Map<string, T>()
  const listenersByScopeKey = new Map<string, Set<(value: T) => void>>()
  const copy = copyValue ?? ((value: T): T => value)

  const read = (scopeKey: string): T =>
    copy(cache.has(scopeKey) ? cache.get(scopeKey)! : createEmptyValue())

  const notify = (scopeKey: string, value: T): void => {
    const listeners = listenersByScopeKey.get(scopeKey)
    if (!listeners) {
      return
    }
    const notificationValue = copy(value)
    for (const listener of Array.from(listeners)) {
      try {
        listener(notificationValue)
      } catch {
        // a subscriber's exception must never block the other listeners
      }
    }
  }

  return {
    read,
    write: (scopeKey, value) => {
      if (isEmpty(value)) {
        cache.delete(scopeKey)
      } else {
        setBoundedScopeCacheEntry(cache, scopeKey, copy(value))
      }
      notify(scopeKey, value)
    },
    subscribe: (scopeKey, listener) => {
      const listeners = listenersByScopeKey.get(scopeKey) ?? new Set<(value: T) => void>()
      listenersByScopeKey.set(scopeKey, listeners)
      listeners.add(listener)
      const unpin = pinScopeCacheKey(scopeKey)
      try {
        listener(read(scopeKey))
      } catch {
        // a subscriber's exception must never stop this subscribe call from completing
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          listenersByScopeKey.delete(scopeKey)
        }
        unpin()
      }
    },
    clearForTests: () => {
      cache.clear()
      listenersByScopeKey.clear()
    }
  }
}
