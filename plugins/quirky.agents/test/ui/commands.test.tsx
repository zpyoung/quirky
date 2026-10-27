import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type Session } from '@quirky/protocol'
import { fakeAgentsContext, FakeAgents, SESSION_VIEW_ID, VIEW_ID, type FakeContext } from './fake'

let activate: (context: FakeContext['context']) => void
let agents: FakeAgents
let fake: FakeContext

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ activate } = await import('../../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const created: Record<string, unknown>[] = []

function start(installed?: string[], configure?: (agents: FakeAgents) => void, worktree: string | null = 'main') {
  created.length = 0
  agents = new FakeAgents(installed)
  configure?.(agents)
  fake = fakeAgentsContext(agents, {
    'quirky.session/create': (params) => {
      created.push(params)
      return { id: `s-${created.length}`, agent: params.agent } as Session
    }
  })
  if (worktree !== null) fake.layout.view = { id: SESSION_VIEW_ID, input: { worktree } }
  activate(fake.context)
}

beforeEach(() => void (created.length = 0))

describe('SC-9: "New agent tab" never opens a plain shell', () => {
  test('SC-9: with the default agent shell and codex installed, a codex tab opens', async () => {
    start(['codex'], (a) => void (a.default = 'shell'))
    await fake.command('new-agent-tab')
    expect(fake.callsTo('quirky.agents/pick')[0]!.params).toEqual({ forAgentTab: true })
    expect(created).toEqual([{ worktree: 'main', agent: 'codex' }])
    expect(fake.opened).toEqual([{ id: SESSION_VIEW_ID, input: { worktree: 'main', session: 's-1' } }])
    expect(fake.toasts).toEqual([])
  })

  test('SC-9: with no agent installed nothing opens and the pick error is shown', async () => {
    start([])
    await fake.command('new-agent-tab')
    expect(created).toEqual([])
    expect(fake.opened).toEqual([])
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['No installed agent is enabled.'])
  })

  test('SC-43: the default agent tab uses the first installed agent in auto-pick order', async () => {
    start(['gemini', 'claude', 'codex'])
    await fake.command('new-agent-tab')
    expect(created).toEqual([{ worktree: 'main', agent: 'claude' }])
  })

  test('a failed create is shown and opens nothing', async () => {
    start(['codex'])
    fake.context.call = async (method, params = {}) => {
      if (method === 'quirky.session/create') throw new RpcError(RpcErrorCode.InvalidParams, 'agent codex is disabled')
      return agents.handlers()[method]!(params)
    }
    await fake.command('new-agent-tab')
    expect(fake.opened).toEqual([])
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['agent codex is disabled'])
  })
})

describe('SC-43: the agent commands', () => {
  test('SC-43: "New Codex tab" creates a codex session in the open worktree and opens it', async () => {
    start(['claude', 'codex'])
    await fake.command('new-codex-tab')
    expect(created).toEqual([{ worktree: 'main', agent: 'codex' }])
    expect(fake.opened).toEqual([{ id: SESSION_VIEW_ID, input: { worktree: 'main', session: 's-1' } }])
    expect(fake.callsTo('quirky.agents/pick')).toEqual([])
  })

  test('SC-43: a disabled agent shows "<Label> is disabled" and starts nothing', async () => {
    start(['claude', 'codex'])
    await agents.handlers()['quirky.agents/setEnabled']!({ agent: 'claude-agent-teams', enabled: false })
    await fake.command('new-claude-agent-teams-tab')
    expect(created).toEqual([])
    expect(fake.opened).toEqual([])
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['Claude Agent Teams is disabled'])
  })

  test('SC-43: with no worktree view open, both commands say to open one first', async () => {
    start(['codex'], undefined, null)
    await fake.command('new-agent-tab')
    await fake.command('new-codex-tab')
    expect(fake.calls.filter((call) => call.method.startsWith('quirky.session/'))).toEqual([])
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['Open a worktree first', 'Open a worktree first'])
  })

  test('a layout showing another view counts as no worktree', async () => {
    start(['codex'], undefined, null)
    fake.layout.view = { id: VIEW_ID }
    await fake.command('new-agent-tab')
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['Open a worktree first'])
  })

  test('an unknown agent error from the daemon is shown', async () => {
    start(['codex'])
    fake.context.call = async () => {
      throw new RpcError(RpcErrorCode.NotFound, 'unknown agent: codex')
    }
    await fake.command('new-codex-tab')
    expect(fake.toasts.map((toast) => toast.body)).toEqual(['unknown agent: codex'])
  })

  test('"Open agent settings" opens the Agents view', async () => {
    start()
    await fake.command('open-settings')
    expect(fake.opened).toEqual([{ id: VIEW_ID, input: undefined }])
  })
})
