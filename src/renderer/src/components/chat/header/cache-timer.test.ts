import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import { cacheMsRemaining, formatCacheClock } from './cache-timer'

function turnRow(completedAt: number | undefined, cached: number): AgentJournalRenderItem {
  return {
    itemId: 'turn-1',
    revision: 1,
    sequence: 1,
    observedAt: 0,
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      ...(completedAt === undefined ? {} : { completedAt }),
      contextUsage: {
        used: {
          kind: 'estimate',
          capturedAt: 0,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: cached,
            cacheCreationInputTokens: 0
          }
        }
      }
    }
  }
}

describe('cacheMsRemaining', () => {
  it('counts down five minutes from the end of a Claude turn that used the cache', () => {
    expect(cacheMsRemaining([turnRow(1_000, 50)], 'claude', 61_000)).toBe(240_000)
  })

  it('shows nothing for other agents, an uncached turn, or an expired cache', () => {
    expect(cacheMsRemaining([turnRow(1_000, 50)], 'codex', 2_000)).toBeNull()
    expect(cacheMsRemaining([turnRow(1_000, 0)], 'claude', 2_000)).toBeNull()
    expect(cacheMsRemaining([turnRow(1_000, 50)], 'claude', 301_000)).toBeNull()
    expect(cacheMsRemaining([turnRow(undefined, 50)], 'claude', 2_000)).toBeNull()
  })

  it('ignores later subagent turns when counting the session agent cache', () => {
    const subagent = { ...turnRow(200_000, 50), itemId: 'turn-sub', agentId: 'sub-1', sequence: 2 }
    const nested = { ...turnRow(250_000, 50), itemId: 'turn-nested', parentAgentId: 'sub-1' }
    expect(cacheMsRemaining([turnRow(1_000, 50), subagent, nested], 'claude', 61_000)).toBe(240_000)
    expect(cacheMsRemaining([subagent], 'claude', 61_000)).toBeNull()
  })

  it('formats minutes and padded seconds', () => {
    expect(formatCacheClock(247_000)).toBe('4:07')
  })
})
