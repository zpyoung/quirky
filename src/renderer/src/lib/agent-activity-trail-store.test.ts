import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'
import {
  AGENT_ACTIVITY_MAX_ENTRIES,
  AGENT_TOUCH_WINDOW_MS,
  clearAgentActivity,
  entriesFor,
  getAgentActivitySnapshot,
  latestTouchFor,
  recentTouches,
  recordAgentActivity,
  subscribeAgentActivity,
  type AgentActivityEntry
} from './agent-activity-trail-store'

const BRAIN: AttributedCaller = { kind: 'brain', label: 'brain' }
const SCRIPT: AttributedCaller = { kind: 'script', label: 'script' }
const NOW = 1_000_000

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    caller: BRAIN,
    method: 'session.tabs.activate',
    summary: 'Activate a tab',
    at: NOW,
    ...overrides
  }
}

beforeEach(() => {
  clearAgentActivity()
})

afterEach(() => {
  clearAgentActivity()
})

describe('agent activity trail store', () => {
  it('keeps only the newest 500 entries', () => {
    for (let i = 0; i < AGENT_ACTIVITY_MAX_ENTRIES + 25; i += 1) {
      recordAgentActivity(entry({ summary: `entry ${i}`, at: i }))
    }

    const snapshot = getAgentActivitySnapshot()
    expect(snapshot).toHaveLength(AGENT_ACTIVITY_MAX_ENTRIES)
    expect(snapshot[0]?.summary).toBe('entry 25')
    expect(snapshot.at(-1)?.summary).toBe(`entry ${AGENT_ACTIVITY_MAX_ENTRIES + 24}`)
  })

  it('hands out a new snapshot per write and notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAgentActivity(listener)
    const before = getAgentActivitySnapshot()

    recordAgentActivity(entry())

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getAgentActivitySnapshot()).not.toBe(before)

    unsubscribe()
    recordAgentActivity(entry())
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('returns entries newest first, optionally for one workspace', () => {
    recordAgentActivity(entry({ summary: 'a', workspaceId: 'w1', at: 1 }))
    recordAgentActivity(entry({ summary: 'b', workspaceId: 'w2', at: 2 }))
    recordAgentActivity(entry({ summary: 'c', workspaceId: 'w1', at: 3 }))

    expect(entriesFor().map((e) => e.summary)).toEqual(['c', 'b', 'a'])
    expect(entriesFor({ workspaceId: 'w1' }).map((e) => e.summary)).toEqual(['c', 'a'])
    expect(entriesFor({ workspaceId: 'missing' })).toEqual([])
  })

  describe('recentTouches', () => {
    it('maps tab ids touched inside the window to their caller', () => {
      recordAgentActivity(entry({ tabId: 'tab-1', at: NOW - 1000 }))
      recordAgentActivity(
        entry({ tabId: 'tab-2', caller: SCRIPT, method: 'ui.runAction', at: NOW - 100 })
      )

      const touches = recentTouches(NOW)

      expect([...touches.keys()].sort()).toEqual(['tab-1', 'tab-2'])
      expect(touches.get('tab-2')).toEqual(SCRIPT)
    })

    it('drops a touch once the window has elapsed', () => {
      recordAgentActivity(entry({ tabId: 'tab-1', at: NOW - AGENT_TOUCH_WINDOW_MS - 1 }))
      recordAgentActivity(entry({ tabId: 'tab-2', at: NOW - AGENT_TOUCH_WINDOW_MS }))

      expect([...recentTouches(NOW).keys()]).toEqual(['tab-2'])
    })

    it('ignores methods that do not open or focus a tab, and entries with no tab id', () => {
      recordAgentActivity(entry({ tabId: 'tab-1', method: 'session.tabs.close' }))
      recordAgentActivity(entry({ method: 'session.tabs.createTerminal' }))

      expect(recentTouches(NOW).size).toBe(0)
    })

    it('credits the newest caller when several touch the same tab', () => {
      recordAgentActivity(entry({ tabId: 'tab-1', caller: BRAIN, at: NOW - 2000 }))
      recordAgentActivity(entry({ tabId: 'tab-1', caller: SCRIPT, at: NOW - 500 }))

      expect(recentTouches(NOW).get('tab-1')).toEqual(SCRIPT)
    })

    it('reads the clock when no time is given', () => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      recordAgentActivity(entry({ tabId: 'tab-1', at: NOW - 1000 }))

      expect(recentTouches().has('tab-1')).toBe(true)

      vi.setSystemTime(NOW + AGENT_TOUCH_WINDOW_MS)
      expect(recentTouches().has('tab-1')).toBe(false)
      vi.useRealTimers()
    })
  })

  it('finds the latest touch for a tab known by any of its ids, regardless of age', () => {
    recordAgentActivity(entry({ tabId: 'tab-1', at: 1 }))
    recordAgentActivity(entry({ tabId: 'tab-1', caller: SCRIPT, at: 2 }))
    recordAgentActivity(entry({ tabId: 'tab-2', at: 3 }))

    expect(latestTouchFor(getAgentActivitySnapshot(), ['tab-1'])?.caller).toEqual(SCRIPT)
    expect(latestTouchFor(getAgentActivitySnapshot(), ['tab-2', 'tab-1'])?.at).toBe(3)
    expect(latestTouchFor(getAgentActivitySnapshot(), ['tab-9'])).toBeNull()
  })
})
