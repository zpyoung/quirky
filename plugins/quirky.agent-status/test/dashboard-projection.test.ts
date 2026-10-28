import { describe, expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { ActivityFeed } from '../src/activity'
import type { ActivityThread } from '../src/activity-types'
import { DashboardService } from '../src/dashboard'

const thread = (sessionId: string, display: ActivityThread['display'], unread = false): ActivityThread => ({
  sessionId,
  worktreeId: 'wt1',
  worktreeName: 'main',
  sessionName: sessionId,
  agent: 'claude',
  turn: `turn-${sessionId}`,
  turnStartedAt: 1,
  updatedAt: 2,
  display,
  label: display,
  prompt: '',
  detail: '',
  children: [],
  unread,
  live: true
})

describe('Dashboard Activity projection', () => {
  test('keeps acknowledged completions Done and discloses hidden idle in the total', async () => {
    const activity: Pick<ActivityFeed, 'query'> = {
      async query() {
        return { threads: [thread('wait', 'waiting', true), thread('work', 'working'), thread('done', 'done'), thread('idle', 'idle')] }
      }
    }
    const context = { call: async () => { throw new Error('unfiltered dashboard must not fetch optional metadata') } } as unknown as PluginContext
    const dashboard = new DashboardService(context, activity)

    const hidden = await dashboard.query({})
    expect(hidden).toMatchObject({ total: 4, hiddenIdle: 1, unavailable: [] })
    expect(hidden.cards.map(({ thread: entry, bucket }) => [entry.sessionId, bucket])).toEqual([
      ['wait', 'attention'],
      ['work', 'working'],
      ['done', 'done']
    ])

    const revealed = await dashboard.query({ showIdle: true })
    expect(revealed).toMatchObject({ total: 4, hiddenIdle: 0 })
    expect(revealed.cards.map(({ thread: entry, bucket }) => [entry.sessionId, bucket])).toEqual([
      ['wait', 'attention'],
      ['work', 'working'],
      ['done', 'done'],
      ['idle', 'idle']
    ])
  })
})
