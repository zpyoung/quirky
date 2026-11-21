import { describe, expect, test } from 'bun:test'
import type { AgentItem, ChatItem, StructuredMessage } from '@quirky/protocol'
import { childNeedsYou, deriveAgents, dockSummary, runningOrder } from '../src/window/chat/agents'

const T0 = 1_700_000_000_000
const msg = (seq: number, item: ChatItem, at = T0 + seq * 1000): StructuredMessage => ({ sessionId: 'chat', seq, role: 'assistant', text: '', at, item })
const agent = (seq: number, id: string, over: Partial<AgentItem> & { agent?: string } = {}, at?: number) =>
  msg(seq, { kind: 'agent', id, name: id, task: `task of ${id}`, state: 'working', startedAt: T0, steps: 'full', ...over } as ChatItem, at)
const tool = (seq: number, owner: string, callId: string, summary: string, state: 'running' | 'done' = 'done', at?: number) =>
  msg(seq, { kind: 'activity', callId, tool: 'Grep', summary, state, agent: owner }, at)

describe('deriveAgents', () => {
  test('the newest snapshot of an id wins and keeps the seq it first appeared at', () => {
    const views = deriveAgents([agent(1, 'a'), agent(2, 'a', { state: 'done', report: 'ok', endedAt: T0 + 5000 })], T0 + 6000)
    expect(views.size).toBe(1)
    expect(views.get('a')).toMatchObject({ state: 'done', report: 'ok', spawnSeq: 1, endSeq: 2, endedAt: T0 + 5000, background: false })
  })

  test('line is the summary, else the latest tagged tool call, else the task', () => {
    const base = [agent(1, 'a')]
    expect(deriveAgents(base, T0).get('a')!.line).toBe('task of a')
    const withTool = [...base, tool(2, 'a', 'c1', 'Grep "refresh("'), tool(3, 'a', 'c2', 'Read session.ts'), tool(4, 'b', 'c3', 'someone else')]
    expect(deriveAgents(withTool, T0).get('a')!.line).toBe('Read session.ts')
    const tests = msg(5, { kind: 'tests', callId: 't', command: 'bun test src/auth', state: 'running', agent: 'a' })
    expect(deriveAgents([...withTool, tests], T0).get('a')!.line).toBe('bun test src/auth')
    expect(deriveAgents([...withTool, agent(6, 'a', { summary: 'Tracing where tokens refresh' })], T0).get('a')!.line).toBe('Tracing where tokens refresh')
  })

  test('items hold the tagged messages: own items and the agent items of its children', () => {
    const views = deriveAgents([agent(1, 'a'), agent(2, 'b', { agent: 'a' }), tool(3, 'a', 'c', 'x'), tool(4, 'b', 'd', 'y'), msg(5, { kind: 'prose', text: 'main' })], T0)
    expect(views.get('a')!.items.map((m) => m.seq)).toEqual([2, 3])
    expect(views.get('b')!.items.map((m) => m.seq)).toEqual([4])
  })

  test('depth and children follow the parent tag; an unknown parent makes a top-level agent', () => {
    const views = deriveAgents([agent(1, 'a'), agent(2, 'b', { agent: 'a' }), agent(3, 'c', { agent: 'b' }), agent(4, 'd', { agent: 'ghost' })], T0)
    expect([views.get('a')!.depth, views.get('b')!.depth, views.get('c')!.depth, views.get('d')!.depth]).toEqual([0, 1, 2, 0])
    expect(views.get('a')!.children).toEqual(['b'])
    expect(views.get('b')!.parent).toBe('a')
    expect(views.get('d')!.parent).toBeUndefined()
  })

  describe('quiet', () => {
    const events = [agent(1, 'a', {}, T0), tool(2, 'a', 'c', 'Read x', 'done', T0 + 10_000)]
    test('a working agent with nothing tagged for 120 s is quiet, and the next event clears it', () => {
      expect(deriveAgents(events, T0 + 129_000).get('a')!.state).toBe('working')
      expect(deriveAgents(events, T0 + 130_000).get('a')!.state).toBe('quiet')
      expect(deriveAgents([...events, tool(3, 'a', 'c2', 'Read y', 'done', T0 + 131_000)], T0 + 132_000).get('a')!.state).toBe('working')
    })

    test('an agent entry counts as activity', () => {
      expect(deriveAgents([...events, agent(3, 'a', { summary: 'still here' }, T0 + 100_000)], T0 + 200_000).get('a')!.state).toBe('working')
    })

    test('a tagged call still running keeps it working', () => {
      const running = [agent(1, 'a', {}, T0), tool(2, 'a', 'c', 'bun test', 'running', T0 + 1000)]
      expect(deriveAgents(running, T0 + 600_000).get('a')!.state).toBe('working')
    })

    test('an agent whose steps are not reported is never quiet', () => {
      expect(deriveAgents([agent(1, 'a', { steps: 'none' }, T0)], T0 + 600_000).get('a')!.state).toBe('working')
    })

    test('needs-you and ended agents are never quiet', () => {
      expect(deriveAgents([agent(1, 'a', { state: 'needs-you' }, T0)], T0 + 600_000).get('a')!.state).toBe('needs-you')
      expect(deriveAgents([agent(1, 'a', { state: 'done' }, T0)], T0 + 600_000).get('a')!.state).toBe('done')
    })
  })
})

describe('dockSummary', () => {
  const views = (items: StructuredMessage[], now = T0) => deriveAgents(items, now)

  test('is null when nothing is live', () => {
    expect(dockSummary(views([]))).toBeNull()
    expect(dockSummary(views([agent(1, 'a', { state: 'done' }), agent(2, 'b', { state: 'failed' })]))).toBeNull()
  })

  test('running counts top-level live agents and nested counts the deeper ones; attention counts every depth', () => {
    const summary = dockSummary(
      views([
        agent(1, 'a'),
        agent(2, 'b', { state: 'needs-you' }),
        agent(3, 'c', { agent: 'a', state: 'needs-you' }),
        agent(4, 'd', { agent: 'a' }),
        agent(5, 'e', { state: 'done' }),
        agent(6, 'f', { state: 'failed', agent: 'a' })
      ])
    )
    expect(summary).toEqual({ running: 2, nested: 2, needsYou: 2, quiet: 0, failed: 1 })
  })

  test('quiet agents count as running and as quiet', () => {
    expect(dockSummary(views([agent(1, 'a', {}, T0)], T0 + 300_000))).toMatchObject({ running: 1, quiet: 1 })
  })

  test('refused agents are never counted', () => {
    expect(dockSummary(views([agent(1, 'a', { state: 'failed', refused: 'Concurrent subagent limit reached' })]))).toBeNull()
    expect(dockSummary(views([agent(1, 'a'), agent(2, 'b', { state: 'failed', refused: 'limit' })]))).toEqual({ running: 1, nested: 0, needsYou: 0, quiet: 0, failed: 0 })
  })
})

describe('runningOrder and childNeedsYou', () => {
  const views = deriveAgents(
    [
      agent(1, 'w1', {}, T0 + 119_000),
      agent(2, 'q', {}, T0),
      agent(3, 'n', { state: 'needs-you' }, T0 + 119_000),
      agent(4, 'w2', {}, T0 + 119_000),
      agent(5, 'done', { state: 'done' }, T0 + 119_000),
      agent(6, 'kid', { agent: 'w1', state: 'needs-you' }, T0 + 119_000),
      agent(7, 'grandkid', { agent: 'kid' }, T0 + 119_000)
    ],
    T0 + 120_000
  )

  test('needs you first, then quiet, then working, ties by spawn order; ended agents are left out', () => {
    expect(runningOrder(views, ['w1', 'q', 'n', 'w2', 'done'])).toEqual(['n', 'q', 'w1', 'w2'])
  })

  test('childNeedsYou is true when any descendant needs you', () => {
    expect(childNeedsYou(views.get('w1')!, views)).toBe(true)
    expect(childNeedsYou(views.get('kid')!, views)).toBe(false)
    expect(childNeedsYou(views.get('n')!, views)).toBe(false)
  })

  test('a deeper descendant counts', () => {
    const deep = deriveAgents([agent(1, 'a'), agent(2, 'b', { agent: 'a' }), agent(3, 'c', { agent: 'b', state: 'needs-you' })], T0)
    expect(childNeedsYou(deep.get('a')!, deep)).toBe(true)
  })
})
