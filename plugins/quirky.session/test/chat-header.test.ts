import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test, vi } from 'bun:test'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type AgentCapabilities, type AgentKey, type CacheTier, type Session, type StructuredMessage, type UsageResult } from '@quirky/protocol'
import { deriveAgents, type AgentView } from '../src/window/chat/agents'
import { cacheDisplay, ChatHeader, compactTokens, tokenBreakdown } from '../src/window/chat/ChatHeader'
import type { WorktreeSessions } from '../src/window/model'
import { SessionTabs } from '../src/window/SessionTabs'
import { fakeContext, session, WORKTREE, type FakeContext } from './ui-fake'

type Handler = (params: Record<string, any>) => unknown

const OK = { ok: true } as const
const CLAUDE: AgentCapabilities = {
  agent: 'claude',
  steer: OK,
  model: OK,
  planMode: OK,
  permissionModes: { ok: true, modes: ['default'] },
  images: OK,
  effort: OK,
  approveForSession: OK,
  resume: OK,
  fork: OK
}
const PI: AgentCapabilities = { ...CLAUDE, agent: 'pi', fork: { ok: false, reason: 'pi cannot fork a conversation' } }

const NOW = 1_800_000_000_000
const FIVE = 300_000 as const
const HOUR = 3_600_000 as const
const TOTALS = { input: 12_400, output: 9_800, cacheRead: 141_200, cacheWrite: 20_600, total: 184_000 }
const usageOf = (cache: CacheTier[] | null, totals: typeof TOTALS | null = TOTALS): UsageResult => ({
  own: totals,
  conversation: totals,
  turns: totals === null ? 0 : 1,
  cache: cache === null ? null : { tiers: cache }
})
const both = (anchorAt: number): CacheTier[] => [{ ttlMs: FIVE, anchorAt }, { ttlMs: HOUR, anchorAt }]

let host: HTMLDivElement | null = null
let root: Root | null = null
let fake: FakeContext
let usage: UsageResult | (() => UsageResult)

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  vi.useFakeTimers()
  setSystemTime(new Date(NOW))
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  setSystemTime()
})

const timers = vi as unknown as { advanceTimersByTime(ms: number): void }

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await act(async () => void (await Promise.resolve()))
}

/** Moves the clock forward and runs the intervals that fall due, as one act. */
const advance = (ms: number) =>
  act(async () => {
    timers.advanceTimersByTime(ms)
  })

type Mount = {
  session?: Partial<Session>
  capabilities?: AgentCapabilities | null
  messages?: StructuredMessage[]
  showAll?: boolean
  planChip?: ReactNode
  handlers?: Record<string, Handler>
  settings?: Record<string, unknown>
  agents?: Map<AgentKey, AgentView>
}
let props: Required<Pick<Mount, 'capabilities' | 'messages' | 'showAll'>> & { session: Session; planChip?: ReactNode; agents?: Map<AgentKey, AgentView> }

const render = () =>
  act(async () => {
    root!.render(createElement(ChatHeader, { context: fake.context, ...props }))
  })

async function mount(options: Mount = {}) {
  fake = fakeContext({
    'quirky.structured/usage': () => (typeof usage === 'function' ? usage() : usage),
    ...options.handlers
  }, options.settings)
  props = {
    session: session({ id: 'chat', kind: 'structured', agent: 'claude', status: 'done', title: 'Fix flaky worktree window test', ...options.session }),
    capabilities: options.capabilities === undefined ? CLAUDE : options.capabilities,
    messages: options.messages ?? [],
    showAll: options.showAll ?? false,
    planChip: options.planChip,
    ...(options.agents === undefined ? {} : { agents: options.agents })
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await render()
  await flush()
}

const withSession = async (over: Partial<Session>) => {
  props = { ...props, session: { ...props.session, ...over } }
  await render()
  await flush()
}

const userMsg = (seq: number, at: number): StructuredMessage => ({ sessionId: 'chat', seq, role: 'user', text: 'go', item: { kind: 'user', text: 'go' }, at })
const errorMsg = (seq: number, at: number): StructuredMessage => ({
  sessionId: 'chat',
  seq,
  role: 'system',
  text: 'died',
  item: { kind: 'error', reason: 'exited', stderrTail: [], resumable: true },
  at
})

const header = () => host!.querySelector('header')!
const text = () => header().textContent ?? ''
const click = (element: Element | null | undefined) => act(async () => void element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const label = (name: string) => host!.querySelector<HTMLElement>(`[aria-label="${name}"]`)
const live = () => host!.querySelector<HTMLElement>('[aria-live="polite"]')!
const dot = () => header().querySelector('.ui-status-dot')!
const figureByText = (needle: string) => [...header().querySelectorAll<HTMLElement>('span')].find((span) => span.children.length === 0 && span.textContent?.includes(needle))
const openMenu = async () => {
  await click(label('More actions'))
  return host!.querySelector('[role="menu"]')!
}
const menuItem = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((item) => item.textContent?.replace(/^✓ |^　/, '').startsWith(name))!
const titleField = () => host!.querySelector<HTMLInputElement>('input[aria-label="Chat title"], input')

describe('formatting', () => {
  test('tokens are compact with at most one decimal', () => {
    expect([842, 12_400, 141_200, 184_000, 184_300, 1_250_000].map(compactTokens)).toEqual(['842', '12.4k', '141.2k', '184k', '184.3k', '1.3M'])
  })

  test('the cache display hands off from the 5-minute tier to the 1-hour tier and then goes cold', () => {
    const tiers = both(NOW)
    const at = (ms: number) => cacheDisplay(tiers, NOW + ms)
    expect(at(48_000)).toMatchObject({ kind: 'warm', text: 'Cache 4:12', amber: false })
    expect(at(252_000)).toMatchObject({ text: 'Cache 0:48', amber: true })
    expect(at(301_000)).toMatchObject({ text: 'Cache 55m', amber: false })
    expect(at(HOUR)).toEqual({ kind: 'cold' })
    expect(cacheDisplay([], NOW)).toBeNull()
    expect(cacheDisplay(undefined, NOW)).toBeNull()
  })

  test('a 5-minute-only cache is amber in its last minute and cold at 5:00', () => {
    const tiers: CacheTier[] = [{ ttlMs: FIVE, anchorAt: NOW }]
    expect(cacheDisplay(tiers, NOW + 240_000)).toMatchObject({ text: 'Cache 1:00', amber: true })
    expect(cacheDisplay(tiers, NOW + 300_000)).toEqual({ kind: 'cold' })
  })

  test('a 1-hour-only cache never turns amber', () => {
    const tiers: CacheTier[] = [{ ttlMs: HOUR, anchorAt: NOW }]
    expect(cacheDisplay(tiers, NOW + HOUR - 30_000)).toMatchObject({ text: 'Cache 1m', amber: false })
  })
})

describe('Chat with header', () => {
  test('working: pulsing dot, elapsed time from the newest user message ticking each second, tokens, no cache timer', async () => {
    usage = usageOf(both(NOW - 10_000))
    await mount({ session: { status: 'working' }, messages: [userMsg(1, NOW - 100_000), userMsg(2, NOW - 72_000)] })
    expect(dot().classList.contains('ui-status-dot--working')).toBe(true)
    expect(text()).toContain('Working · 1m 12s')
    expect(text()).toContain('184k tokens')
    expect(text()).not.toContain('Cache')
    await advance(3000)
    expect(text()).toContain('Working · 1m 15s')
  })

  test('idle-warm: Done, tokens with the breakdown on hover, Cache 4:12 counting down with both tiers on hover', async () => {
    usage = usageOf(both(NOW - 48_000))
    await mount()
    expect(dot().classList.contains('ui-status-dot--done')).toBe(true)
    expect(text()).toContain('Done')
    expect(figureByText('184k tokens')!.getAttribute('title')).toBe('Input 12.4k · Output 9.8k · Cache read 141.2k · Cache write 20.6k · Total 184k')
    const cache = figureByText('Cache 4:12')!
    expect(cache.getAttribute('title')).toBe('5-minute cache: 4:12 left · 1-hour cache: 60m left')
    await advance(1000)
    expect(figureByText('Cache 4:11')).toBeDefined()
  })

  test('cache-expiring: amber in the last minute of the 5-minute tier, then normal with whole minutes', async () => {
    usage = usageOf(both(NOW - 252_000))
    await mount()
    expect(figureByText('Cache 0:48')!.getAttribute('style')).toContain('var(--ui-needs-you)')
    await advance(49_000)
    const minutes = figureByText('Cache 55m')!
    expect(minutes.getAttribute('style') ?? '').not.toContain('var(--ui-needs-you)')
  })

  test('cache-cold: a Cache cold chip once every tier has expired', async () => {
    usage = usageOf(both(NOW - HOUR - 1000))
    await mount()
    expect(text()).toContain('Cache cold')
    expect(header().querySelector('.ui-badge')!.textContent).toBe('Cache cold')
  })

  test('cache-cold follows the clock past the last tier', async () => {
    usage = usageOf([{ ttlMs: FIVE, anchorAt: NOW - 299_000 }])
    await mount()
    expect(text()).toContain('Cache 0:01')
    await advance(2000)
    expect(text()).toContain('Cache cold')
  })

  test('waiting: amber dot, Waiting on you, and the 1-hour timer in minutes', async () => {
    usage = usageOf([{ ttlMs: HOUR, anchorAt: NOW - 600_000 }])
    await mount({ session: { status: 'waiting' } })
    expect(dot().classList.contains('ui-status-dot--needs-you')).toBe(true)
    expect(text()).toContain('Waiting on you')
    expect(text()).toContain('Cache 50m')
  })

  test('new-chat: Ready, no tokens, no cache timer', async () => {
    usage = usageOf(null, null)
    await mount()
    expect(dot().classList.contains('ui-status-dot--idle')).toBe(true)
    expect(text()).toContain('Ready')
    expect(text()).not.toContain('tokens')
    expect(text()).not.toContain('Cache')
  })

  test('five-only: amber in the last minute and cold at 5:00', async () => {
    usage = usageOf([{ ttlMs: FIVE, anchorAt: NOW - 239_000 }])
    await mount()
    expect(figureByText('Cache 1:01')!.getAttribute('style') ?? '').not.toContain('var(--ui-needs-you)')
    await advance(2000)
    expect(figureByText('Cache 0:59')!.getAttribute('style')).toContain('var(--ui-needs-you)')
    await advance(60_000)
    expect(text()).toContain('Cache cold')
  })

  test('codex-idle: tokens and no cache timer', async () => {
    usage = usageOf(null)
    await mount({ session: { agent: 'codex' } })
    expect(text()).toContain('184k tokens')
    expect(text()).not.toContain('Cache')
  })

  test('the usage query and its change event refresh the figures', async () => {
    usage = usageOf(null, { ...TOTALS, total: 100_000 })
    await mount()
    expect(fake.callsTo('quirky.structured/usage')[0]!.params).toEqual({ session: 'chat' })
    expect(text()).toContain('100k tokens')
    usage = usageOf(null, TOTALS)
    await fake.emit({ type: 'quirky.structured/usageChanged', data: { sessionId: 'other', summary: {} } })
    await flush()
    expect(fake.callsTo('quirky.structured/usage')).toHaveLength(1)
    await fake.emit({ type: 'quirky.structured/usageChanged', data: { sessionId: 'chat', summary: {} } })
    await flush()
    expect(text()).toContain('184k tokens')
  })

  test('the header is a row above the transcript, never positioned over it', async () => {
    usage = usageOf(null)
    await mount()
    expect(header().getAttribute('style')).not.toContain('position')
    expect(header().getAttribute('style')).toContain('display: flex')
  })
})

describe('Ended, crashed, offline, failed', () => {
  test('ended: a grey dot and Ended, with tokens and the cache timer still counting', async () => {
    usage = usageOf(both(NOW - 48_000))
    await mount({ session: { status: 'exited' }, messages: [userMsg(1, NOW - 90_000), errorMsg(2, NOW - 100_000 + 20_000)].slice(0, 1) })
    expect(dot().classList.contains('ui-status-dot--idle')).toBe(true)
    expect(text()).toContain('Ended')
    expect(text()).toContain('184k tokens')
    expect(text()).toContain('Cache 4:12')
    await advance(2000)
    expect(text()).toContain('Cache 4:10')
  })

  test('crashed: a red dot and Stopped unexpectedly when an error follows the newest user message', async () => {
    usage = usageOf(null)
    await mount({ session: { status: 'exited' }, messages: [userMsg(1, NOW - 90_000), errorMsg(2, NOW - 80_000)] })
    expect(dot().classList.contains('ui-status-dot--failing')).toBe(true)
    expect(text()).toContain('Stopped unexpectedly')
    expect(host!.textContent).not.toContain('Resume')
    expect(host!.textContent).not.toContain('Restart')
  })

  test('an error before the newest user message does not make a later clean exit a crash', async () => {
    usage = usageOf(null)
    await mount({ session: { status: 'exited' }, messages: [errorMsg(1, NOW - 90_000), userMsg(2, NOW - 80_000)] })
    expect(text()).toContain('Ended')
  })

  test('offline: Reconnecting…, figures dimmed and frozen, Rename and Fork disabled with the reason, refreshed on return', async () => {
    usage = usageOf(both(NOW - 48_000))
    await mount()
    await fake.setConnection('reconnecting')
    expect(text()).toContain('Reconnecting…')
    expect(dot().classList.contains('ui-status-dot--needs-you')).toBe(true)
    expect(figureByText('Cache 4:12')!.getAttribute('style')).toContain('opacity')
    expect(figureByText('184k tokens')!.getAttribute('style')).toContain('opacity')
    await advance(10_000)
    expect(figureByText('Cache 4:12')).toBeDefined()
    await openMenu()
    for (const name of ['Rename', 'Fork chat']) {
      const item = menuItem(name)
      expect(item.disabled).toBe(true)
      expect(item.textContent).toContain('Reconnecting…')
    }
    expect(menuItem('Session info').disabled).toBe(false)
    expect(label('Rename chat: Fix flaky worktree window test')).not.toBeNull()
    expect((label('Rename chat: Fix flaky worktree window test') as HTMLButtonElement).disabled).toBe(true)

    usage = usageOf(both(NOW + 5000))
    await fake.setConnection('connected')
    await flush()
    expect(fake.callsTo('quirky.structured/usage')).toHaveLength(2)
    expect(text()).not.toContain('Reconnecting…')
    expect(text()).toContain('Cache')
  })

  test('no token total and a Ready label until a turn has ended, even when mid-turn counts arrived', async () => {
    usage = { ...usageOf(null), turns: 0 }
    await mount()
    expect(text()).toContain('Ready')
    expect(text()).not.toContain('tokens')
  })

  test('a cache that expired while offline shows cold after reconnecting', async () => {
    usage = usageOf([{ ttlMs: FIVE, anchorAt: NOW - 48_000 }])
    await mount()
    expect(figureByText('Cache 4:12')).toBeDefined()
    await fake.setConnection('reconnecting')
    setSystemTime(new Date(NOW + FIVE))
    await fake.setConnection('connected')
    await flush()
    expect(text()).toContain('Cache cold')
    expect(text()).not.toContain('Cache 4:')
  })

  test('fork-failed: an error row under the header with Retry; Retry forks again and clears the row', async () => {
    usage = usageOf(null)
    let attempts = 0
    await mount({
      handlers: {
        'quirky.structured/fork': () => {
          attempts += 1
          if (attempts === 1) throw new RpcError(RpcErrorCode.Conflict, 'the agent refused')
          return session({ id: 'forked', kind: 'structured', worktreeId: WORKTREE.id })
        }
      }
    })
    await openMenu()
    await click(menuItem('Fork chat'))
    await flush()
    const row = header().nextElementSibling as HTMLElement
    expect(row.textContent).toContain('Could not fork: the agent refused')
    expect(fake.opened).toEqual([])
    const retry = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await click(retry)
    await flush()
    expect(fake.callsTo('quirky.structured/fork')).toHaveLength(2)
    expect(host!.textContent).not.toContain('Could not fork')
    expect(fake.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: WORKTREE.id, session: 'forked' } }])
  })
})

const T = 1_800_000_000_000
const agentAt = (seq: number, id: string, over: Record<string, unknown> = {}): StructuredMessage => ({
  sessionId: 'chat',
  seq,
  role: 'assistant',
  text: '',
  at: T - 1000,
  item: { kind: 'agent', id, name: id, task: 'task', state: 'working', startedAt: T - 5000, steps: 'full', ...over } as StructuredMessage['item']
})
const agentsOf = (...messages: StructuredMessage[]) => deriveAgents(messages, T)

describe('Agents in the header', () => {
  test('with agents still running a finished turn reads Ready · N agents running, replacing Done', async () => {
    usage = usageOf(null)
    await mount({ agents: agentsOf(agentAt(1, 'a'), agentAt(2, 'b', { background: true })) })
    expect(text()).toContain('Ready · 2 agents running')
    expect(text()).not.toContain('Done')
    expect(dot().classList.contains('ui-status-dot--idle')).toBe(true)
  })

  test('one agent reads in the singular, and a brand new chat says it too', async () => {
    usage = usageOf(null, null)
    await mount({ agents: agentsOf(agentAt(1, 'a')) })
    expect(text()).toContain('Ready · 1 agent running')
    expect(text()).not.toContain('agents')
  })

  test('only top-level live agents count; ended, refused and nested ones do not', async () => {
    usage = usageOf(null)
    await mount({
      agents: agentsOf(
        agentAt(1, 'a'),
        agentAt(2, 'nested', { agent: 'a' }),
        agentAt(3, 'finished', { state: 'done' }),
        agentAt(4, 'refused', { state: 'failed', refused: 'limit' })
      )
    })
    expect(text()).toContain('Ready · 1 agent running')
  })

  test('with none running the label is Done again', async () => {
    usage = usageOf(null)
    await mount({ agents: agentsOf(agentAt(1, 'a', { state: 'done' })) })
    expect(text()).toContain('Done')
    expect(text()).not.toContain('running')
  })

  test('while the turn works or waits, the status keeps its own label', async () => {
    usage = usageOf(null)
    await mount({ session: { status: 'working' }, agents: agentsOf(agentAt(1, 'a')) })
    expect(text()).toContain('Working')
    expect(text()).not.toContain('agent running')
    await withSession({ status: 'waiting' })
    expect(text()).toContain('Waiting on you')
  })

  test('the token tooltip splits main from subagents when subagents used tokens', async () => {
    usage = { ...usageOf(null, { ...TOTALS, total: 59_400 }), subagentTokens: 28_000 }
    await mount()
    expect(figureByText('59.4k tokens')!.getAttribute('title')).toContain('Total 59.4k · Main 31.4k · Subagents 28k')
  })

  test('the split is left out without subagent tokens, and Main never goes negative', () => {
    expect(tokenBreakdown(TOTALS)).toBe('Input 12.4k · Output 9.8k · Cache read 141.2k · Cache write 20.6k · Total 184k')
    expect(tokenBreakdown(TOTALS, 0)).not.toContain('Subagents')
    expect(tokenBreakdown({ ...TOTALS, total: 1000 }, 5000)).toContain('Main 0 · Subagents 5k')
  })

  test('the menu offers AI-written and Latest tool call, checked from the setting, and a pick writes it', async () => {
    usage = usageOf(null)
    await mount({ settings: { 'setting:quirky.structured/agent-summaries': 'latest-tool' }, handlers: { 'setting.set': () => ({}) } })
    await openMenu()
    expect(menuItem('AI-written').getAttribute('aria-checked')).toBe('false')
    expect(menuItem('Latest tool call').getAttribute('aria-checked')).toBe('true')
    await click(menuItem('AI-written'))
    expect(fake.callsTo('setting.set').at(-1)!.params).toEqual({ id: 'setting:quirky.structured/agent-summaries', value: 'ai' })
  })

  test('the check follows a setting change and defaults to AI-written', async () => {
    usage = usageOf(null)
    await mount()
    await openMenu()
    expect(menuItem('AI-written').getAttribute('aria-checked')).toBe('true')
    await fake.emit({ type: 'setting.changed', id: 'setting:quirky.structured/agent-summaries', value: 'latest-tool' })
    expect(menuItem('Latest tool call').getAttribute('aria-checked')).toBe('true')
  })
})

describe('Overflow menu', () => {
  test('default: Rename, Fork chat, Session info, Show all events as a checked item, then the chat width and alignment', async () => {
    usage = usageOf(null)
    await mount({ showAll: true })
    expect(label('More actions')!.getAttribute('aria-haspopup')).toBe('menu')
    const menu = await openMenu()
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim())).toEqual([
      'Rename', 'Fork chat', 'Session info', '✓ Show all events',
      'Narrow', '✓ Comfortable', 'Wide', 'Full width',
      'Left', '✓ Center', 'Right',
      '✓ AI-written', 'Latest tool call'
    ])
    expect([...menu.querySelectorAll('.ui-menu__note')].map((note) => note.textContent)).toEqual(['Width', 'Alignment', 'Agent status summaries'])
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(3)
    expect(menuItem('Show all events').getAttribute('role')).toBe('menuitemcheckbox')
    expect(menuItem('Show all events').getAttribute('aria-checked')).toBe('true')
  })

  test('Show all events toggles through the command and Session info opens its panel', async () => {
    usage = usageOf(null)
    await mount({ showAll: false })
    await openMenu()
    expect(menuItem('Show all events').getAttribute('aria-checked')).toBe('false')
    await click(menuItem('Show all events'))
    expect(fake.executed.at(-1)).toEqual({
      id: 'command:quirky.session/show-all-events',
      args: { session: 'chat', enabled: true },
      options: { activateOwner: false }
    })
    await openMenu()
    await click(menuItem('Session info'))
    expect(fake.executed.at(-1)).toEqual({ id: 'command:quirky.session-info/open', args: { session: 'chat' } })
  })

  test('working or waiting: Fork chat is disabled until the turn ends', async () => {
    usage = usageOf(null)
    await mount({ session: { status: 'working' } })
    await openMenu()
    expect(menuItem('Fork chat').disabled).toBe(true)
    expect(menuItem('Fork chat').textContent).toContain('Available when the turn ends')
    await withSession({ status: 'waiting' })
    expect(menuItem('Fork chat').textContent).toContain('Available when the turn ends')
  })

  test('an agent without fork shows its capability reason', async () => {
    usage = usageOf(null)
    await mount({ capabilities: PI, session: { agent: 'pi' } })
    await openMenu()
    expect(menuItem('Fork chat').disabled).toBe(true)
    expect(menuItem('Fork chat').textContent).toContain('pi cannot fork a conversation')
  })

  test('Fork chat forks through the daemon and opens the new chat in a tab', async () => {
    usage = usageOf(null)
    await mount({ handlers: { 'quirky.structured/fork': () => session({ id: 'forked', kind: 'structured', worktreeId: 'wt-x' }) } })
    await openMenu()
    await click(menuItem('Fork chat'))
    await flush()
    expect(fake.callsTo('quirky.structured/fork')[0]!.params).toEqual({ session: 'chat' })
    expect(fake.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'wt-x', session: 'forked' } }])
  })
})

describe('Rename in place', () => {
  const type = async (value: string) => {
    await act(async () => {
      const input = titleField()!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
  }
  const press = (key: string) => act(async () => void titleField()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  const start = () => click(label('Rename chat: Fix flaky worktree window test'))

  test('the title button names the action and opens a field with the title selected and the key hint', async () => {
    usage = usageOf(null)
    await mount()
    await start()
    const input = titleField()!
    expect(input.value).toBe('Fix flaky worktree window test')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(document.activeElement).toBe(input)
    expect(host!.textContent).toContain('Enter to save · Esc to cancel')
  })

  test('Rename in the menu opens the same field', async () => {
    usage = usageOf(null)
    await mount()
    await openMenu()
    await click(menuItem('Rename'))
    expect(titleField()).not.toBeNull()
  })

  test('Enter saves the trimmed title and the new title shows at once', async () => {
    usage = usageOf(null)
    await mount({ handlers: { 'quirky.session/setTitle': (params) => session({ id: 'chat', title: params.title }) } })
    await start()
    await type('  Worktree test flake: wait on view event  ')
    await press('Enter')
    await flush()
    expect(fake.callsTo('quirky.session/setTitle')[0]!.params).toEqual({ session: 'chat', title: 'Worktree test flake: wait on view event' })
    expect(titleField()).toBeNull()
    expect(label('Rename chat: Worktree test flake: wait on view event')).not.toBeNull()
  })

  test('Esc restores the old title without a call', async () => {
    usage = usageOf(null)
    await mount()
    await start()
    await type('Something else')
    await press('Escape')
    expect(titleField()).toBeNull()
    expect(label('Rename chat: Fix flaky worktree window test')).not.toBeNull()
    expect(fake.callsTo('quirky.session/setTitle')).toEqual([])
  })

  test('an empty or unchanged title restores the old one without a call', async () => {
    usage = usageOf(null)
    await mount()
    await start()
    await type('   ')
    await press('Enter')
    expect(titleField()).toBeNull()
    await start()
    await press('Enter')
    expect(titleField()).toBeNull()
    expect(fake.callsTo('quirky.session/setTitle')).toEqual([])
  })

  test('clicking away saves the typed title', async () => {
    usage = usageOf(null)
    await mount({ handlers: { 'quirky.session/setTitle': (params) => session({ id: 'chat', title: params.title }) } })
    await start()
    await type('Renamed on blur')
    await act(async () => void titleField()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()
    expect(fake.callsTo('quirky.session/setTitle')[0]!.params.title).toBe('Renamed on blur')
  })

  test('a failed save keeps the typed text with the error under it, and Enter tries again', async () => {
    usage = usageOf(null)
    let fail = true
    await mount({
      handlers: {
        'quirky.session/setTitle': (params) => {
          if (fail) throw new RpcError(RpcErrorCode.Internal, 'disk full')
          return session({ id: 'chat', title: params.title })
        }
      }
    })
    await start()
    await type('Kept text')
    await press('Enter')
    await flush()
    expect(titleField()!.value).toBe('Kept text')
    expect(host!.textContent).toContain('disk full')
    fail = false
    await press('Enter')
    await flush()
    expect(fake.callsTo('quirky.session/setTitle')).toHaveLength(2)
    expect(titleField()).toBeNull()
    expect(label('Rename chat: Kept text')).not.toBeNull()
  })
})

describe('Narrow pane', () => {
  let callback: ResizeObserverCallback | null = null
  let original: typeof ResizeObserver | undefined
  beforeEach(() => {
    original = globalThis.ResizeObserver
    callback = null
    globalThis.ResizeObserver = class {
      constructor(listener: ResizeObserverCallback) {
        callback = listener
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = original as typeof ResizeObserver
  })
  const resize = (width: number) => act(async () => void callback!([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver))

  test('items drop in order: tokens, then the cache timer, then the label, with the dot and menu always there', async () => {
    usage = usageOf(both(NOW - 48_000))
    await mount({ planChip: createElement('span', null, 'Plan · v1') })
    await resize(520)
    expect(text()).toContain('Done')
    expect(text()).toContain('184k tokens')
    expect(text()).toContain('Cache 4:12')

    await resize(420)
    expect(text()).not.toContain('184k tokens')
    expect(text()).toContain('Cache 4:12')
    expect(text()).toContain('Done')

    await resize(380)
    expect(text()).not.toContain('Cache 4:12')
    expect(text()).toContain('Done')

    await resize(260)
    expect(text()).not.toContain('Done')
    expect(dot().getAttribute('aria-label')).toBe('Done')
    expect(text()).toContain('Plan · v1')
    expect(label('More actions')).not.toBeNull()
  })

  test('dropped figures lead the menu as a note followed by a separator, in header order', async () => {
    usage = usageOf(both(NOW - 48_000))
    await mount()
    await resize(240)
    const menu = await openMenu()
    const entries = [...menu.children]
    expect(entries[0]!.textContent).toBe('184k tokens · Cache 4:12')
    expect(entries[1]!.getAttribute('role')).toBe('separator')
    expect(entries[2]!.textContent).toContain('Rename')

    await click(menuItem('Rename'))
    await resize(2000)
    const wide = await openMenu()
    expect(wide.children[0]!.textContent).toContain('Rename')
  })
})

describe('live region', () => {
  test('one mounted region announces status label changes without the elapsed time ticking into it', async () => {
    usage = usageOf(null, TOTALS)
    await mount({ session: { status: 'working' }, messages: [userMsg(1, NOW - 5000)] })
    expect(host!.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(live().classList.contains('ui-visually-hidden')).toBe(true)
    expect(live().textContent).toBe('')
    await advance(5000)
    expect(live().textContent).toBe('')
    const region = live()
    await withSession({ status: 'waiting' })
    expect(live()).toBe(region)
    expect(live().textContent).toBe('Waiting on you')
    await withSession({ status: 'done' })
    expect(live().textContent).toBe('Done')
  })

  test('the cache turning amber and going cold are each announced once and the ticks are not', async () => {
    usage = usageOf([{ ttlMs: FIVE, anchorAt: NOW - 238_000 }])
    await mount()
    expect(live().textContent).toBe('')
    await advance(1000)
    expect(live().textContent).toBe('')
    await advance(2000)
    expect(live().textContent).toBe('Cache expires in under a minute')
    await advance(10_000)
    expect(live().textContent).toBe('Cache expires in under a minute')
    await advance(60_000)
    expect(live().textContent).toBe('Cache cold')
  })
})

describe('session tab tooltip', () => {
  const tabs = () => [...host!.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('title'))
  const settleTabs = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))

  test('a structured tab shows the conversation total, refreshed on usageChanged, and a terminal tab shows none', async () => {
    vi.useRealTimers()
    const chat = session({ id: 'chat-1', kind: 'structured', agent: 'claude', status: 'done', title: 'Chat one' })
    const shell = session({ id: 'shell-1', kind: 'terminal', title: 'zsh' })
    let total = 184_000
    fake = fakeContext({
      'quirky.structured/usage': () => ({ own: null, conversation: { ...TOTALS, total }, turns: 1, cache: null }),
      'quirky.agents/list': () => ({ agents: [], defaultAgent: 'auto' })
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SessionTabs, { context: fake.context, store: {} as WorktreeSessions, sessions: [chat, shell], active: chat }))
    })
    await settleTabs()
    expect(tabs()).toEqual(['184k tokens', null])
    expect(fake.callsTo('quirky.structured/usage').every((call) => call.params.session === 'chat-1')).toBe(true)

    total = 190_500
    await fake.emit({ type: 'quirky.structured/usageChanged', data: { sessionId: 'chat-1', summary: {} } })
    await settleTabs()
    expect(tabs()[0]).toBe('190.5k tokens')
  })

  test('a structured tab re-queries its total on reconnect', async () => {
    vi.useRealTimers()
    const chat = session({ id: 'chat-1', kind: 'structured', agent: 'claude', status: 'done', title: 'Chat one' })
    let total = 184_000
    fake = fakeContext({
      'quirky.structured/usage': () => ({ own: null, conversation: { ...TOTALS, total }, turns: 1, cache: null }),
      'quirky.agents/list': () => ({ agents: [], defaultAgent: 'auto' })
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SessionTabs, { context: fake.context, store: {} as WorktreeSessions, sessions: [chat], active: chat }))
    })
    await settleTabs()
    expect(tabs()).toEqual(['184k tokens'])
    total = 250_000
    await fake.setConnection('reconnecting')
    await fake.setConnection('connected')
    await settleTabs()
    expect(tabs()).toEqual(['250k tokens'])
  })

  test('a structured tab without usage data has no tooltip', async () => {
    vi.useRealTimers()
    const chat = session({ id: 'chat-1', kind: 'structured', agent: 'claude', status: 'done', title: 'Chat one' })
    fake = fakeContext({ 'quirky.structured/usage': () => ({ own: null, conversation: null, turns: 0, cache: null }), 'quirky.agents/list': () => ({ agents: [], defaultAgent: 'auto' }) })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SessionTabs, { context: fake.context, store: {} as WorktreeSessions, sessions: [chat], active: chat }))
    })
    await settleTabs()
    expect(tabs()).toEqual([null])
  })
})
