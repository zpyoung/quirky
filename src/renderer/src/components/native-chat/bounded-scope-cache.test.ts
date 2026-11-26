import { afterEach, describe, it, expect } from 'vitest'
import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  clearScopeCachePinsForTests,
  pinScopeCacheKey,
  setBoundedScopeCacheEntry
} from './bounded-scope-cache'

describe('setBoundedScopeCacheEntry', () => {
  it('bounds the cache with LRU eviction, keeping re-set keys', () => {
    const cache = new Map<string, number>()
    setBoundedScopeCacheEntry(cache, 'keep', 1)

    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 20
    for (let i = 0; i < total; i += 1) {
      setBoundedScopeCacheEntry(cache, `scope-${i}`, i)
      if (i % 10 === 0) {
        setBoundedScopeCacheEntry(cache, 'keep', 1)
      }
    }

    expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    expect(cache.has('scope-0')).toBe(false) // oldest untouched entry evicted
    expect(cache.has('keep')).toBe(true) // periodically re-set → retained
    expect(cache.has(`scope-${total - 1}`)).toBe(true) // most recent retained
  })

  it('moves a re-set key to most-recent and updates its value', () => {
    const cache = new Map<string, number>()
    setBoundedScopeCacheEntry(cache, 'a', 1)
    setBoundedScopeCacheEntry(cache, 'b', 2)
    setBoundedScopeCacheEntry(cache, 'a', 3)

    expect([...cache.keys()]).toEqual(['b', 'a'])
    expect(cache.get('a')).toBe(3)
  })
})

describe('setBoundedScopeCacheEntry pinning', () => {
  afterEach(() => {
    clearScopeCachePinsForTests()
  })

  function fillToCapacity(cache: Map<string, number>): void {
    for (let i = 0; i < NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX; i += 1) {
      setBoundedScopeCacheEntry(cache, `scope-${i}`, i)
    }
  }

  it('evicts the oldest unsubscribed scope and never a pinned one', () => {
    const cache = new Map<string, number>()
    fillToCapacity(cache)
    const unpin = pinScopeCacheKey('scope-0')

    setBoundedScopeCacheEntry(cache, 'newcomer', 999)

    expect(cache.has('scope-0')).toBe(true)
    expect(cache.has('scope-1')).toBe(false) // oldest unpinned entry evicted instead
    expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    unpin()
  })

  it('grows past the cap rather than evicting live state when every entry is pinned', () => {
    const cache = new Map<string, number>()
    fillToCapacity(cache)
    const unpins = Array.from({ length: NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX }, (_, i) =>
      pinScopeCacheKey(`scope-${i}`)
    )

    setBoundedScopeCacheEntry(cache, 'newcomer', 999)

    expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 1)
    for (let i = 0; i < NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX; i += 1) {
      expect(cache.has(`scope-${i}`)).toBe(true)
    }
    unpins.forEach((unpin) => unpin())
  })

  it('makes a scope evictable again once its pin is released', () => {
    const cache = new Map<string, number>()
    fillToCapacity(cache)
    const unpin = pinScopeCacheKey('scope-0')
    unpin()

    setBoundedScopeCacheEntry(cache, 'newcomer', 999)

    expect(cache.has('scope-0')).toBe(false)
  })
})
