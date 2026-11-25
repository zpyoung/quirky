import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { FOLD_AT, projectChatTurns } from './chat-turns'

let sequence = 0

function row(
  itemId: string,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 1, body, sequence, observedAt: 1000 + sequence, ...extra }
}

const user = (itemId: string, text = 'fix the date parser') =>
  row(itemId, { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] })

const reply = (itemId: string, text: string, state?: 'running' | 'completed') =>
  row(itemId, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    ...(state ? { state } : {})
  })

const call = (
  itemId: string,
  callId: string,
  state: 'running' | 'completed' | 'failed',
  name = 'Read'
) => row(itemId, { kind: 'tool-call', name, input: { file_path: '/a.ts' }, callId, state })

const options = { sessionAgent: 'claude' }

describe('projectChatTurns', () => {
  beforeEach(() => {
    sequence = 0
  })

  it('shapes a turn as message, folded activity, prose, changes and test result in order', () => {
    const items = [
      user('u1'),
      call('c1', 'call-1', 'completed'),
      call('c2', 'call-2', 'completed'),
      row('d1', { kind: 'diff', path: 'parse-date.ts', patch: patch() }),
      row('t1', {
        kind: 'test-result',
        callId: 'call-3',
        command: 'pnpm test',
        state: 'passed',
        passed: 41,
        failed: 0
      }),
      reply('a1', 'Fixed it.'),
      row('tc1', {
        kind: 'turn-changes',
        turnId: 'turn-1',
        source: 'git-tree',
        fromTree: 'A',
        toTree: 'B',
        files: [{ path: 'parse-date.ts', status: 'modified', added: 3, removed: 1 }]
      }),
      row('turn-1', { kind: 'turn', turnId: 'turn-1', state: 'completed', userItemId: 'u1' })
    ]
    const turns = projectChatTurns(items, options)
    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn?.user?.itemId).toBe('u1')
    expect(turn?.blocks.map((block) => block.type)).toEqual([
      'activity',
      'file-change',
      'test-result',
      'prose',
      'changes'
    ])
    const activity = turn?.blocks[0]
    expect(activity?.type === 'activity' && activity.calls).toHaveLength(2)
    expect(turn?.end).toEqual({ state: 'done' })
  })

  it('merges a running call with its completion by callId', () => {
    const items = [
      user('u1'),
      call('c1', 'call-1', 'running'),
      call('c1-done', 'call-1', 'completed')
    ]
    const [turn] = projectChatTurns(items, options)
    expect(turn?.blocks).toHaveLength(1)
    const block = turn?.blocks[0]
    if (block?.type !== 'activity') {
      throw new Error('expected an activity block')
    }
    expect(block.calls).toHaveLength(1)
    expect(block.calls[0]?.itemId).toBe('c1-done')
  })

  it('hides a plan approval a plan item names and keeps other asks', () => {
    const approval = (itemId: string) =>
      row(itemId, {
        kind: 'approval',
        title: 'Plan',
        detail: null,
        options: [],
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      })
    const items = [
      user('u1'),
      approval('appr-plan'),
      approval('appr-bash'),
      row('p1', {
        kind: 'plan',
        version: 1,
        status: 'waiting',
        text: 'step 1',
        approvalItemId: 'appr-plan'
      })
    ]
    const [turn] = projectChatTurns(items, options)
    expect(turn?.blocks.map((block) => block.type)).toEqual(['ask', 'plan'])
    const ask = turn?.blocks[0]
    expect(ask?.type === 'ask' && ask.item.itemId).toBe('appr-bash')
  })

  it('ends an interrupted turn with the interrupted state', () => {
    const items = [
      user('u1'),
      reply('a1', 'working on'),
      row('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        userItemId: 'u1',
        startedAt: 1000,
        completedAt: 4000
      })
    ]
    const [turn] = projectChatTurns(items, options)
    expect(turn?.end).toEqual({ state: 'interrupted', durationMs: 3000 })
  })

  it('maps failures and stops to their own end states and leaves a running turn open', () => {
    const turnWith = (state: 'completed' | 'running', outcome?: 'failure' | 'cancellation') =>
      projectChatTurns(
        [
          user('u1'),
          row('turn-1', {
            kind: 'turn',
            turnId: 'turn-1',
            state,
            userItemId: 'u1',
            ...(outcome ? { outcome } : {})
          })
        ],
        options
      )[0]?.end
    expect(turnWith('completed', 'failure')).toEqual({ state: 'failed' })
    expect(turnWith('completed', 'cancellation')).toEqual({ state: 'stopped' })
    expect(turnWith('running')).toBeNull()
  })

  it('puts items before the first user message in a turn without a user', () => {
    const items = [reply('a0', 'resumed chat note'), user('u1'), reply('a1', 'hello')]
    const turns = projectChatTurns(items, options)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.user).toBeNull()
    expect(turns[0]?.blocks.map((block) => block.type)).toEqual(['prose'])
    expect(turns[1]?.user?.itemId).toBe('u1')
  })

  it('keeps the newest revision of a visual once', () => {
    const visual = (itemId: string, revision: number, version: number, title: string) =>
      row(
        itemId,
        {
          kind: 'visual',
          viewId: 'view-1',
          version,
          title,
          placement: 'pane',
          spec: { head: '{}', byteLength: 2, digest: 'x', truncated: false }
        },
        { revision }
      )
    const items = [
      user('u1'),
      visual('v-new', 2, 2, 'Second'),
      reply('a1', 'look'),
      visual('v-old', 1, 1, 'First')
    ]
    const [turn] = projectChatTurns(items, options)
    const visuals = turn?.blocks.filter((block) => block.type === 'visual') ?? []
    expect(visuals).toHaveLength(1)
    const only = visuals[0]
    expect(
      only?.type === 'visual' && only.item.body.kind === 'visual' && only.item.body.title
    ).toBe('Second')
  })

  it('draws one agents block per turn and leaves background tasks out', () => {
    const spawn = (itemId: string, id: string) =>
      row(itemId, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'subagent', id, label: id, state: 'working', groupId: 'g1' }]
      })
    const task = row('bg', {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'background-task',
          taskId: 't1',
          kind: 'command',
          label: 'sleep',
          state: 'working'
        }
      ]
    })
    const [turn] = projectChatTurns(
      [user('u1'), spawn('s1', 'agent-a'), task, spawn('s2', 'agent-b')],
      options
    )
    expect(turn?.blocks).toEqual([{ type: 'agents', agentIds: ['agent-a', 'agent-b'] }])
  })

  it('ignores rows a subagent produced apart from the roster', () => {
    const items = [
      user('u1'),
      row(
        'child',
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'child text' }]
        },
        { agentId: 'agent-a' }
      ),
      reply('a1', 'parent text')
    ]
    const [turn] = projectChatTurns(items, options)
    expect(turn?.blocks).toHaveLength(1)
    expect(turn?.blocks[0]?.type === 'prose' && turn.blocks[0].text).toBe('parent text')
  })

  it('exports the fold threshold the agents card shares with the projection', () => {
    expect(FOLD_AT).toBe(4)
  })
})

function patch() {
  return { head: '@@ -1 +1 @@', byteLength: 11, digest: 'x', truncated: false }
}
