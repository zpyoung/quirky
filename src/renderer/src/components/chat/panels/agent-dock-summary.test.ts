import { describe, expect, it } from 'vitest'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/structured-agent-session-subagent-roster'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat-types'
import { dockSummary, formatElapsed, formatTokens } from './agent-dock-summary'

function roster(...entries: NativeChatSubagentEntry[]): StructuredAgentSubagentRoster {
  return new Map(
    entries.map((entry) => [
      entry.id,
      {
        entry,
        rosterItemId: 'roster',
        rosterPosition: { sequence: 1, index: 0 },
        rosterRevision: 1
      }
    ])
  )
}

describe('dockSummary', () => {
  it('is null when nothing is running, even if some failed', () => {
    expect(dockSummary(roster())).toBeNull()
    expect(
      dockSummary(
        roster(
          { id: 'a', label: 'Explore', state: 'completed' },
          { id: 'b', label: 'Test', state: 'failed' }
        )
      )
    ).toBeNull()
  })

  it('lists running agents in start order with their elapsed time', () => {
    const summary = dockSummary(
      roster(
        { id: 'b', label: 'Second', state: 'working', startedAt: 2_000, tokens: 12_400 },
        { id: 'a', label: 'First', state: 'working', startedAt: 1_000 },
        { id: 'c', label: 'Done', state: 'completed', startedAt: 500 }
      ),
      11_000
    )
    expect(summary?.running.map((agent) => agent.name)).toEqual(['First', 'Second'])
    expect(summary?.running[0]).toMatchObject({ elapsed: '10s', statusLine: 'working' })
    expect(summary?.running[1]).toMatchObject({
      elapsed: '9s',
      statusLine: 'working · 12.4k tokens'
    })
  })

  it('counts failed and unverifiable agents beside the running ones', () => {
    const summary = dockSummary(
      roster(
        { id: 'a', label: 'A', state: 'working' },
        { id: 'b', label: 'B', state: 'failed' },
        { id: 'c', label: 'C', state: 'unverifiable' }
      ),
      0
    )
    expect(summary).toMatchObject({ failed: 1, unverifiable: 1 })
    expect(summary?.running[0]?.elapsed).toBeNull()
  })
})

describe('formatElapsed', () => {
  it('reads seconds, then minutes and padded seconds', () => {
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('formatTokens', () => {
  it('abbreviates thousands', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
  })
})
