import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type AgentCapabilities, type ChatItem, type PermissionModeName, type PlanItem, type Session, type StructuredMessage } from '@quirky/protocol'
import { currentMode, planVersions, previousMode } from '../src/window/chat/plan'
import { groupChatTurns, groupTurns, summarizeActivity, type ActivityCall } from '../src/window/chat/turns'
import { agentInfo, agentListing, fakeContext, session, settle, type FakeContext } from './ui-fake'

type Handler = (params: Record<string, any>) => unknown

const OK = { ok: true } as const
const CLAUDE: AgentCapabilities = {
  agent: 'claude',
  steer: OK,
  model: OK,
  planMode: OK,
  permissionModes: { ok: true, modes: ['default', 'acceptEdits', 'plan', 'auto'] },
  images: OK,
  effort: OK,
  approveForSession: OK,
  resume: OK,
  fork: OK
}
const PI: AgentCapabilities = {
  agent: 'pi',
  steer: { ok: false, reason: 'pi steers only between tool calls' },
  model: { ok: false, reason: 'Set when the chat starts' },
  planMode: { ok: false, reason: 'pi has no plan mode' },
  permissionModes: { ok: false, reason: 'pi has no permission modes' },
  images: OK,
  effort: { ok: false, reason: 'pi takes no effort setting' },
  approveForSession: { ok: false, reason: 'pi has no session approvals' },
  resume: { ok: false, reason: 'pi cannot resume a conversation' },
  fork: { ok: false, reason: 'pi cannot fork a conversation' }
}

const T0 = 1_700_000_000_000
const msg = (seq: number, item: ChatItem | undefined, over: Partial<StructuredMessage> = {}): StructuredMessage => ({
  sessionId: 'chat',
  seq,
  role: 'assistant',
  text: '',
  at: T0 + seq * 1000,
  ...(item ? { item } : {}),
  ...over
})
const user = (seq: number, text: string) => msg(seq, { kind: 'user', text }, { role: 'user', text })
const prose = (seq: number, text: string, streaming?: boolean) => msg(seq, { kind: 'prose', text, ...(streaming ? { streaming } : {}) })
const act1 = (seq: number, callId: string, tool: string, summary: string, state: 'running' | 'done' | 'failed' | 'stopped' = 'done', at?: number) =>
  msg(seq, { kind: 'activity', callId, tool, summary, state }, at === undefined ? {} : { at })
const end = (seq: number, state: 'done' | 'stopped' | 'failed', durationMs?: number) =>
  msg(seq, { kind: 'turn-end', state, ...(durationMs === undefined ? {} : { durationMs }) })

const planMsg = (seq: number, version: number, status: PlanItem['status'], over: Partial<PlanItem> = {}) =>
  msg(seq, { kind: 'plan', version, status, text: `Plan text v${version}`, ...over })
const modeMsg = (seq: number, mode: PermissionModeName, autoAvailable?: boolean) =>
  msg(seq, { kind: 'mode', mode, ...(autoAvailable === undefined ? {} : { autoAvailable }) })

describe('plan versions and mode', () => {
  test('planVersions keeps the last item per version, ordered by version, with its first and last seq', () => {
    const versions = planVersions([
      user(1, 'plan it'),
      planMsg(2, 1, 'waiting', { askId: 'a1' }),
      planMsg(3, 1, 'revised'),
      planMsg(4, 2, 'waiting', { askId: 'a2' }),
      planMsg(5, 2, 'approved', { approvedMode: 'auto' })
    ])
    expect(versions.map((entry) => [entry.version, entry.status, entry.firstSeq, entry.lastSeq])).toEqual([
      [1, 'revised', 2, 3],
      [2, 'approved', 4, 5]
    ])
    expect(versions[1]).toMatchObject({ kind: 'plan', approvedMode: 'auto', text: 'Plan text v2' })
    expect(versions[1]!.askId).toBeUndefined()
  })

  test('planVersions is empty without plan items', () => {
    expect(planVersions([user(1, 'hi'), prose(2, 'hello')])).toEqual([])
  })

  test('currentMode is the newest mode item, or null', () => {
    expect(currentMode([user(1, 'hi')])).toBeNull()
    expect(currentMode([modeMsg(1, 'default', false), modeMsg(2, 'plan', true), prose(3, 'x')])).toMatchObject({ mode: 'plan', autoAvailable: true })
  })

  test('previousMode is the mode before the newest run of plan items, or default', () => {
    expect(previousMode([])).toBe('default')
    expect(previousMode([modeMsg(1, 'plan')])).toBe('default')
    expect(previousMode([modeMsg(1, 'default'), modeMsg(2, 'acceptEdits'), modeMsg(3, 'plan'), modeMsg(4, 'plan', true)])).toBe('acceptEdits')
    expect(previousMode([modeMsg(1, 'auto'), modeMsg(2, 'plan'), modeMsg(3, 'acceptEdits'), modeMsg(4, 'plan')])).toBe('acceptEdits')
    expect(previousMode([modeMsg(1, 'auto'), modeMsg(2, 'plan'), modeMsg(3, 'default')])).toBe('auto')
  })
})

describe('plan blocks', () => {
  test('one plan block per version shows its latest state where the version first appeared, even across turns', () => {
    const turns = groupTurns([
      user(1, 'plan it'),
      planMsg(2, 1, 'waiting', { askId: 'a1' }),
      end(3, 'done'),
      user(4, 'change it'),
      planMsg(5, 1, 'revised'),
      planMsg(6, 2, 'waiting', { askId: 'a2' })
    ])
    expect(turns).toHaveLength(2)
    const first = turns[0]!.blocks.find((block) => block.kind === 'plan')
    expect(first?.kind === 'plan' && [first.item.version, first.item.status]).toEqual([1, 'revised'])
    const second = turns[1]!.blocks.filter((block) => block.kind === 'plan')
    expect(second.map((block) => (block.kind === 'plan' ? block.item.version : 0))).toEqual([2])
  })

  test('across resumed chats a plan version renders once, in the earlier chat, in its latest state', () => {
    const [earlier, current] = groupChatTurns([
      [user(1, 'plan it'), planMsg(2, 2, 'waiting', { askId: 'dead' })],
      [planMsg(1, 2, 'not-answered', { reason: 'restarted' }), user(2, 'again'), planMsg(3, 3, 'waiting', { askId: 'live' })]
    ])
    const plans = (turns: typeof earlier) => turns!.flatMap((turn) => turn.blocks).flatMap((block) => (block.kind === 'plan' ? [[block.item.version, block.item.status]] : []))
    expect(plans(earlier)).toEqual([[2, 'not-answered']])
    expect(plans(current)).toEqual([[3, 'waiting']])
    expect(current!.map((turn) => turn.user?.text ?? null)).toEqual(['again'])
  })

  // the daemon journals the newest plan again at the start of a resumed chat; only the plan panel needs it
  test('a resumed chat whose earlier chat is not loaded opens no turn for the carried-over plan', () => {
    const turns = groupTurns([planMsg(1, 2, 'not-answered', { reason: 'restarted' }), modeMsg(2, 'default'), user(3, 'Status?'), prose(4, 'fine')])
    expect(turns.map((turn) => turn.user?.text ?? null)).toEqual(['Status?'])
    expect(turns[0]!.blocks.map((block) => block.kind)).toEqual(['prose'])
  })

  test('a plan before any user message still shows when agent output follows it in the same turn', () => {
    const turns = groupTurns([planMsg(1, 1, 'approved'), prose(2, 'building it'), user(3, 'next')])
    expect(turns.map((turn) => [turn.key, turn.user?.text ?? null, turn.blocks.map((block) => block.kind)])).toEqual([
      ['turn-1', null, ['plan', 'prose']],
      ['turn-3', 'next', []]
    ])
  })

  test('mode items never open a turn or render', () => {
    const turns = groupTurns([modeMsg(1, 'plan', true), user(2, 'hi'), modeMsg(3, 'acceptEdits')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.blocks).toEqual([])
  })
})

describe('turn grouping', () => {
  test('a user item starts a turn and everything after it belongs to that turn', () => {
    const turns = groupTurns([user(1, 'first'), prose(2, 'one'), user(3, 'second'), prose(4, 'two'), end(5, 'done')])
    expect(turns.map((turn) => turn.user?.text)).toEqual(['first', 'second'])
    expect(turns.map((turn) => turn.blocks.map((block) => block.kind))).toEqual([['prose'], ['prose']])
    expect(turns[0]!.end).toBeNull()
    expect(turns[1]!.end).toEqual({ state: 'done' })
  })

  // claude journals a zero-turn result on resume, e.g. while reporting a background task the old session left
  test('a turn end before any user item opens no empty turn', () => {
    const [earlier, current] = groupChatTurns([
      [user(1, 'first'), prose(2, 'one'), end(3, 'done')],
      [modeMsg(1, 'bypassPermissions'), end(2, 'done', 100), user(3, 'Status?'), prose(4, 'fine')]
    ])
    expect(earlier!.map((turn) => turn.end)).toEqual([{ state: 'done' }])
    expect(current!.map((turn) => [turn.user?.text ?? null, turn.end])).toEqual([['Status?', null]])
  })

  test('a turn end of a stopped turn before any user item in a resumed chat opens no turn', () => {
    const turns = groupTurns([end(1, 'stopped'), user(2, 'go on')])
    expect(turns.map((turn) => turn.user?.text ?? null)).toEqual(['go on'])
  })

  test('messages before any user item share a turn with no user message', () => {
    const turns = groupTurns([prose(1, 'welcome'), user(2, 'hi')])
    expect(turns).toHaveLength(2)
    expect(turns[0]!.user).toBeNull()
    expect(turns[0]!.blocks).toHaveLength(1)
  })

  test('keeps the last item per callId, where the call first appeared', () => {
    const turns = groupTurns([
      user(1, 'go'),
      msg(2, { kind: 'file-change', callId: 'c1', path: 'a.ts', state: 'running' }),
      prose(3, 'meanwhile'),
      msg(4, { kind: 'file-change', callId: 'c1', path: 'a.ts', added: 18, removed: 4, state: 'done' })
    ])
    expect(turns[0]!.blocks.map((block) => block.kind)).toEqual(['file-change', 'prose'])
    const card = turns[0]!.blocks[0]!
    expect(card.kind === 'file-change' && card.item).toMatchObject({ added: 18, removed: 4, state: 'done' })
  })

  test('folds consecutive activity into one group and breaks it at anything else', () => {
    const turns = groupTurns([
      user(1, 'go'),
      act1(2, 'a', 'Read', 'Read a'),
      act1(3, 'b', 'Read', 'Read b'),
      prose(4, 'thinking'),
      act1(5, 'c', 'Bash', 'Ran ls')
    ])
    const groups = turns[0]!.blocks.filter((block) => block.kind === 'activity')
    expect(groups.map((block) => (block.kind === 'activity' ? block.calls.length : 0))).toEqual([2, 1])
  })

  test('a streaming prose partial is replaced by the next prose item of its turn', () => {
    const proseBlocks = (messages: StructuredMessage[]) =>
      groupTurns(messages)[0]!.blocks.flatMap((block) => (block.kind === 'prose' ? [`${block.text}|${block.streaming}`] : []))
    const partial = (seq: number, body: string) => msg(seq, { kind: 'prose', text: body, streaming: true }, { role: 'system' })
    expect(proseBlocks([user(1, 'go'), partial(2, 'Hel'), partial(3, 'Hello wor')])).toEqual(['Hello wor|true'])
    expect(proseBlocks([user(1, 'go'), partial(2, 'Hel'), partial(3, 'Hello wor'), prose(4, 'Hello world')])).toEqual(['Hello world|false'])
    expect(proseBlocks([user(1, 'go'), prose(2, 'first'), act1(3, 'a', 'Read', 'Read a'), partial(4, 'sec')])).toEqual(['first|false', 'sec|true'])
  })

  test('status items and diagnostics stay hidden until Show all events', () => {
    const items = [user(1, 'go'), msg(2, { kind: 'status', text: 'rate limit' }), msg(3, undefined, { role: 'system', text: 'hook_started: x' })]
    expect(groupTurns(items)[0]!.blocks).toEqual([])
    expect(groupTurns(items, { showAll: true })[0]!.blocks.map((block) => block.kind)).toEqual(['status', 'legacy'])
  })

  test('a user item journaled from content the agent added itself neither shows nor starts a turn', () => {
    // older journals stored the SKILL.md the Claude CLI injects after a Skill call as a user item
    const injected = msg(3, { kind: 'user', text: 'Base directory for this skill: /s' }, { role: 'user', data: { type: 'user', isSynthetic: true } })
    const turns = groupTurns([user(1, 'go'), act1(2, 's1', 'Skill', 'probe'), injected, prose(4, 'done')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.user?.text).toBe('go')
    expect(turns[0]!.blocks.map((block) => block.kind)).toEqual(['activity', 'prose'])
  })

  test('a message with no item becomes a legacy block', () => {
    const turns = groupTurns([msg(1, undefined, { role: 'user', text: 'old' }), msg(2, undefined, { text: 'old reply' })])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.blocks.map((block) => block.kind)).toEqual(['legacy', 'legacy'])
  })
})

describe('activity folding text', () => {
  const calls = (...specs: [string, string, number, number][]): ActivityCall[] =>
    specs.map(([tool, summary, startAt, endAt], index) => ({
      seq: index,
      item: { kind: 'activity', callId: String(index), tool, summary, state: 'done' },
      startAt: T0 + startAt * 1000,
      endAt: T0 + endAt * 1000
    }))

  test('counts reads and searches and ends with the span of the group', () => {
    const line = summarizeActivity(
      calls(['Read', 'a', 0, 1], ['Read', 'b', 1, 2], ['Read', 'c', 2, 3], ['Read', 'd', 3, 4], ['Grep', 'x', 4, 8], ['Grep', 'y', 8, 12])
    )
    expect(line).toBe('Read 4 files · searched 2 patterns · 12s')
  })

  test('says one file and one command in the singular, and shows minutes', () => {
    expect(summarizeActivity(calls(['Read', 'a', 0, 0], ['Bash', 'ls', 0, 65]))).toBe('Read 1 file · ran 1 command · 1m 05s')
  })

  test('a call still running reads as running and carries no time', () => {
    const group = calls(['Read', 'a', 0, 1], ['Read', 'b', 1, 2], ['Bash', 'bun run db:types', 2, 2])
    group[2]!.item = { ...group[2]!.item, state: 'running' }
    expect(summarizeActivity(group)).toBe('Read 2 files · running 1 command')
  })

  test('failed and stopped calls are counted at the end', () => {
    const group = calls(['Bash', 'a', 0, 0], ['Bash', 'b', 0, 0], ['Bash', 'c', 0, 0])
    group[1]!.item = { ...group[1]!.item, state: 'failed' }
    group[2]!.item = { ...group[2]!.item, state: 'stopped' }
    expect(summarizeActivity(group)).toBe('Ran 3 commands · 1 failed · 1 stopped')
  })

  test('tools of any spelling land in the same family', () => {
    expect(summarizeActivity(calls(['read_file', 'a', 0, 0], ['commandExecution', 'b', 0, 0], ['WebFetch', 'c', 0, 0], ['Mystery', 'd', 0, 0]))).toBe(
      'Read 1 file · ran 1 command · fetched 1 page · used 1 other tool'
    )
  })
})

describe('stopped derivation', () => {
  test('calls still running in a stopped turn render as stopped, in a finished turn they stay as they are', () => {
    const running = (seq: number) => [
      act1(seq, `a${seq}`, 'Bash', 'Ran x', 'running'),
      msg(seq + 1, { kind: 'file-change', callId: `f${seq}`, path: 'a.ts', state: 'running' }),
      msg(seq + 2, { kind: 'tests', callId: `t${seq}`, command: 'bun test', state: 'running' })
    ]
    const stopped = groupTurns([user(1, 'go'), ...running(2), end(10, 'stopped')])[0]!
    const states = stopped.blocks.map((block) =>
      block.kind === 'activity' ? block.calls[0]!.item.state : block.kind === 'file-change' || block.kind === 'tests' ? block.item.state : block.kind
    )
    expect(states).toEqual(['stopped', 'stopped', 'stopped'])

    const open = groupTurns([user(1, 'go'), ...running(2)])[0]!
    expect(open.blocks[0]!.kind === 'activity' && open.blocks[0]!.calls[0]!.item.state).toBe('running')
  })

  test('a call that finished before the stop keeps its own state', () => {
    const turn = groupTurns([user(1, 'go'), act1(2, 'a', 'Bash', 'Ran x', 'done'), act1(3, 'b', 'Bash', 'Ran y', 'running'), end(4, 'stopped')])[0]!
    const group = turn.blocks[0]!
    expect(group.kind === 'activity' && group.calls.map((call) => call.item.state)).toEqual(['done', 'stopped'])
  })

  test('a steps card is stopped when its turn stopped with work left, and done when every step is', () => {
    const steps = (state: 'pending' | 'active' | 'done') => msg(2, { kind: 'steps', callId: 's', steps: [{ text: 'one', state: 'done' }, { text: 'two', state }] })
    const stateOf = (messages: StructuredMessage[]) => {
      const block = groupTurns(messages)[0]!.blocks[0]!
      return block.kind === 'steps' ? block.state : block.kind
    }
    expect(stateOf([user(1, 'go'), steps('active')])).toBe('running')
    expect(stateOf([user(1, 'go'), steps('active'), end(3, 'stopped')])).toBe('stopped')
    expect(stateOf([user(1, 'go'), steps('done'), end(3, 'stopped')])).toBe('done')
  })
})

let createRoot: typeof import('react-dom/client').createRoot
let ChatView: typeof import('../src/window/chat/ChatView').ChatView
let AgentPicker: typeof import('../src/window/chat/AgentPicker').AgentPicker
let CMView: typeof import('@codemirror/view').EditorView
let fake: FakeContext
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatView } = await import('../src/window/chat/ChatView'))
  ;({ AgentPicker } = await import('../src/window/chat/AgentPicker'))
  ;({ EditorView: CMView } = await import('@codemirror/view'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host = null
  document.body.innerHTML = ''
})

type Mount = { messages?: StructuredMessage[]; capabilities?: AgentCapabilities; session?: Partial<Session>; handlers?: Record<string, Handler> }

/** `count` messages where only the `shown` seqs render ("line N."); the rest are status items, hidden without Show all events, so the test stays fast. */
function longChat(count: number, shown: number[]): StructuredMessage[] {
  return Array.from({ length: count }, (_, index) =>
    shown.includes(index + 1) ? prose(index + 1, `line ${index + 1}.`) : msg(index + 1, { kind: 'status', text: `status ${index + 1}` })
  )
}

/** Answers `quirky.structured/messages` like the daemon: afterSeq/beforeSeq bounds, then limit from the start or, with tail, the end. */
function pageOf(all: StructuredMessage[], params: Record<string, any>): StructuredMessage[] {
  const inRange = all.filter((message) => message.seq > (params.afterSeq ?? 0) && (params.beforeSeq === undefined || message.seq < params.beforeSeq))
  if (params.limit === undefined) return inRange
  return params.tail ? inRange.slice(-params.limit) : inRange.slice(0, params.limit)
}

/** happy-dom has no layout, so every element measures wider than its box while `mount` runs; the clipped state sticks after. */
async function withClippedLines(mount: () => Promise<void>) {
  const proto = HTMLElement.prototype
  const own = { scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth') }
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 500 })
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 100 })
  try {
    await mount()
  } finally {
    for (const key of ['scrollWidth', 'clientWidth'] as const) {
      const descriptor = own[key]
      if (descriptor) Object.defineProperty(proto, key, descriptor)
      else delete (proto as unknown as Record<string, unknown>)[key]
    }
  }
}

async function mountChat({ messages = [], capabilities = CLAUDE, session: over = {}, handlers = {} }: Mount = {}) {
  fake = fakeContext({
    'quirky.structured/messages': () => messages,
    'quirky.structured/capabilities': () => capabilities,
    'quirky.structured/queue': () => [],
    'quirky.view/list': () => [],
    'quirky.session/draft': () => null,
    'quirky.structured/commands': () => ({ commands: [] }),
    ...handlers
  })
  const chat = session({ id: 'chat', kind: 'structured', agent: capabilities.agent, status: 'done', title: 'Add backoff', ...over })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(ChatView, { context: fake.context, session: chat }))
  })
  await settle()
  return chat
}

const text = () => host!.textContent ?? ''
const byLabel = (label: string) => host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const buttonNamed = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name)
const click = (element: Element | null | undefined) => act(async () => void element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const push = (message: StructuredMessage) => fake.emit({ type: 'quirky.structured/message', data: { message } })

describe('the chat view', () => {
  test('loads the messages, asks for the agent capabilities and shows the turn', async () => {
    await mountChat({ messages: [user(1, 'Add backoff'), prose(2, 'On it.'), end(3, 'done')] })
    expect(fake.callsTo('quirky.structured/messages')[0]!.params).toEqual({ session: 'chat', tail: true, limit: 1000 })
    expect(fake.callsTo('quirky.structured/capabilities')[0]!.params).toEqual({ agent: 'claude' })
    expect(byLabel('Your message')!.textContent).toBe('Add backoff')
    expect(text()).toContain('On it.')
    expect(host!.querySelector('[role="log"]')).not.toBeNull()
  })

  test('shows a note when nothing was said yet', async () => {
    await mountChat()
    expect(text()).toContain('No messages yet.')
  })

  test('new messages arrive over the event, other sessions are ignored and settling reloads', async () => {
    const messages = [user(1, 'go')]
    await mountChat({ handlers: { 'quirky.structured/messages': () => messages } })
    await push(prose(2, 'streamed in'))
    expect(text()).toContain('streamed in')
    await push({ ...prose(3, 'elsewhere'), sessionId: 'other' })
    expect(text()).not.toContain('elsewhere')

    messages.push(prose(2, 'streamed in'), prose(4, 'caught up'))
    await fake.emit({ type: 'quirky.structured/settled', data: { sessionId: 'chat', state: 'done' } })
    await settle()
    expect(fake.callsTo('quirky.structured/messages')).toHaveLength(2)
    expect(fake.callsTo('quirky.structured/messages')[1]!.params).toEqual({ session: 'chat', afterSeq: 2, limit: 1000 })
    expect(text()).toContain('caught up')
  })

  test('reloads the messages on reconnect', async () => {
    await mountChat({ messages: [user(1, 'go')] })
    await fake.setConnection('reconnecting')
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.structured/messages')).toHaveLength(2)
  })

  test('says so when quirky.structured is off', async () => {
    await mountChat({ handlers: { 'quirky.structured/messages': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'unknown method') } } })
    expect(text()).toContain('Structured sessions are off')
  })

  test('messages without an item fall back to the plain rows', async () => {
    await mountChat({ messages: [msg(1, undefined, { role: 'user', text: 'old question' }), msg(2, undefined, { text: 'old answer' })] })
    expect(byLabel('user message')!.textContent).toContain('old question')
    expect(byLabel('assistant message')!.textContent).toContain('old answer')
  })

  test('Show all events reveals status items and diagnostics', async () => {
    await mountChat({ messages: [user(1, 'go'), msg(2, { kind: 'status', text: 'rate limit hit' })] })
    expect(text()).not.toContain('rate limit hit')
    await click(byLabel('More actions'))
    const item = [...host!.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((entry) => entry.textContent?.includes('Show all events'))!
    expect(item.getAttribute('aria-checked')).toBe('false')
    await click(item)
    expect(text()).toContain('rate limit hit')
  })

  test('the composer sits below the transcript and sends through the daemon', async () => {
    await mountChat({ messages: [user(1, 'go')], handlers: { 'quirky.structured/send': () => ({ ok: true }) } })
    expect(host!.querySelector('[role="textbox"][aria-label="Message"]')).not.toBeNull()
    const editor = CMView.findFromDOM(host!)!
    await act(async () => editor.dispatch({ changes: { from: 0, insert: 'next' } }))
    await click(host!.querySelector('button[aria-label="Send"]'))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'chat', text: 'next', when: 'now' })
  })

  test('a working session passes working to the composer, so Enter would queue', async () => {
    await mountChat({ messages: [user(1, 'go')], session: { status: 'working' }, handlers: { 'quirky.structured/send': () => ({ ok: true }) } })
    expect(host!.querySelector('button[aria-label="Stop"]')).not.toBeNull()
    expect(host!.querySelector('.cm-placeholder')!.textContent).toContain('Queue a follow-up')
    const editor = CMView.findFromDOM(host!)!
    await act(async () => editor.dispatch({ changes: { from: 0, insert: 'next' } }))
    await click(host!.querySelector('button[aria-label="Send"]'))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toMatchObject({ text: 'next', when: 'idle' })
  })

  test('a resumed chat shows the conversation from every session it was resumed from, oldest first', async () => {
    // journals are per Quirky session, so both chains start at seq 1 and must not collide
    const journals: Record<string, StructuredMessage[]> = {
      first: [{ ...user(1, 'side panel?'), sessionId: 'first' }, { ...prose(2, 'Yes, there is one.'), sessionId: 'first' }],
      second: [{ ...user(1, 'something simple'), sessionId: 'second' }, { ...prose(2, 'Done.'), sessionId: 'second' }],
      chat: [user(1, 'what does resume do?'), prose(2, 'It picks the chat back up.')]
    }
    const records: Record<string, Session> = {
      first: session({ id: 'first', kind: 'structured', agent: 'claude', status: 'exited', resumedFrom: null }),
      second: session({ id: 'second', kind: 'structured', agent: 'claude', status: 'exited', resumedFrom: 'first' })
    }
    await mountChat({
      session: { resumedFrom: 'second' },
      handlers: {
        'quirky.structured/messages': ({ session: id }) => journals[id] ?? [],
        'quirky.session/get': ({ session: id }) => records[id]
      }
    })
    const said = [...host!.querySelectorAll('[aria-label="Your message"]')].map((element) => element.textContent)
    expect(said).toEqual(['side panel?', 'something simple', 'what does resume do?'])
    expect(text()).toContain('Yes, there is one.')
    expect(text()).toContain('It picks the chat back up.')
    expect([...host!.querySelectorAll('section[aria-label^="Turn "]')].map((element) => element.getAttribute('aria-label'))).toEqual([
      'Turn 1',
      'Turn 2',
      'Turn 3'
    ])
  })

  test('a long chat opens on its newest page and Load earlier messages pages back to the start', async () => {
    const all = longChat(2_200, [1, 200, 201, 1200, 1201, 2200])
    await mountChat({ handlers: { 'quirky.structured/messages': (params) => pageOf(all, params) } })
    expect(fake.callsTo('quirky.structured/messages').map((call) => call.params)).toEqual([{ session: 'chat', tail: true, limit: 1000 }])
    expect(text()).toContain('line 2200.')
    expect(text()).toContain('line 1201.')
    expect(text()).not.toContain('line 1200.')

    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(fake.callsTo('quirky.structured/messages').at(-1)!.params).toEqual({ session: 'chat', tail: true, limit: 1000, beforeSeq: 1201 })
    expect(text()).toContain('line 201.')
    expect(text()).not.toContain('line 200.')

    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(text()).toContain('line 1.')
    expect(buttonNamed('Load earlier messages')).toBeUndefined()
  })

  test('a resumed chat whose own history fills a page reaches the earlier session through Load earlier messages', async () => {
    const own = longChat(1_000, [1_000])
    const before = [{ ...user(1, 'from before'), sessionId: 'before' }]
    await mountChat({
      session: { resumedFrom: 'before' },
      handlers: {
        'quirky.structured/messages': (params) => params.session === 'before' ? pageOf(before, params) : pageOf(own, params),
        'quirky.session/get': () => session({ id: 'before', kind: 'structured', agent: 'claude', status: 'exited', resumedFrom: null })
      }
    })
    expect(fake.callsTo('quirky.session/get')).toEqual([])
    expect(text()).not.toContain('from before')

    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(byLabel('Your message')!.textContent).toBe('from before')
    expect(buttonNamed('Load earlier messages')).toBeUndefined()
  })

  test('a fork shows its source only up to the moment it was forked', async () => {
    const own = longChat(1_000, [1_000])
    const forkedAt = T0 + 5_500
    const source = [
      { ...user(1, 'before the fork'), sessionId: 'before' },
      { ...user(5, 'also before the fork'), sessionId: 'before' },
      { ...user(6, 'after the fork'), sessionId: 'before' }
    ]
    await mountChat({
      session: { resumedFrom: 'before', forked: true, createdAt: forkedAt },
      handlers: {
        'quirky.structured/messages': (params) => params.session === 'before' ? pageOf(source, params) : pageOf(own, params),
        'quirky.session/get': () => session({ id: 'before', kind: 'structured', agent: 'claude', status: 'exited', resumedFrom: null })
      }
    })
    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(text()).toContain('before the fork')
    expect(text()).toContain('also before the fork')
    expect(text()).not.toContain('after the fork')
  })

  test('a failed earlier page offers a retry and keeps what is shown', async () => {
    const all = longChat(1_500, [1, 1_500])
    let refuse = true
    await mountChat({
      handlers: {
        'quirky.structured/messages': (params) => {
          if (params.beforeSeq !== undefined && refuse) throw new RpcError(RpcErrorCode.Internal, 'reply too large')
          return pageOf(all, params)
        }
      }
    })
    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(text()).toContain('Could not load earlier messages: reply too large')
    expect(text()).toContain('line 1500.')

    refuse = false
    await click(buttonNamed('Retry'))
    await settle()
    expect(text()).toContain('line 1.')
    expect(text()).not.toContain('Could not load earlier messages')
  })

  test('a page the daemon says is too large to send is asked for again in halves', async () => {
    const all = longChat(1_200, [1, 700, 701, 1_200])
    const tooLarge = new RpcError(RpcErrorCode.Internal, 'too large', { reason: 'reply_too_large', bytes: 9e6, limit: 8e6 })
    await mountChat({
      handlers: {
        'quirky.structured/messages': (params) => {
          if (params.limit > 500) throw tooLarge
          return pageOf(all, params)
        }
      }
    })
    expect(fake.callsTo('quirky.structured/messages').map((call) => call.params.limit)).toEqual([1000, 500])
    expect(text()).toContain('line 1200.')
    expect(text()).toContain('line 701.')
    expect(text()).not.toContain('line 700.')
    await click(buttonNamed('Load earlier messages'))
    await settle()
    expect(text()).toContain('line 700.')
  })

  test('a turn that settles while an earlier page loads leaves Load earlier messages usable', async () => {
    const all = longChat(2_500, [1, 1_500, 1_501, 2_500])
    let release: (() => void) | null = null
    await mountChat({
      handlers: {
        'quirky.structured/messages': async (params) => {
          if (params.beforeSeq !== undefined && release === null) await new Promise<void>((resolve) => { release = resolve })
          return pageOf(all, params)
        }
      }
    })
    await click(buttonNamed('Load earlier messages'))
    expect(buttonNamed('Loading earlier messages…')!.disabled).toBe(true)
    await fake.emit({ type: 'quirky.structured/settled', data: { sessionId: 'chat', state: 'done' } })
    await settle()
    await act(async () => release!())
    await settle()
    expect(text()).toContain('line 1500.')
    expect(buttonNamed('Load earlier messages')!.disabled).toBe(false)
  })

  test('a resumed chat still shows its own messages when an earlier session cannot be read', async () => {
    await mountChat({
      messages: [user(1, 'still here')],
      session: { resumedFrom: 'gone' },
      handlers: { 'quirky.session/get': () => { throw new RpcError(RpcErrorCode.InvalidParams, 'no such session') } }
    })
    expect(byLabel('Your message')!.textContent).toBe('still here')
  })

  test('Stop interrupts the turn instead of stopping the session', async () => {
    await mountChat({ messages: [user(1, 'go')], session: { status: 'working' }, handlers: { 'quirky.structured/interrupt': () => ({ ok: true }) } })
    await click(host!.querySelector('button[aria-label="Stop"]'))
    expect(fake.callsTo('quirky.structured/interrupt')[0]!.params).toEqual({ session: 'chat' })
    expect(fake.callsTo('quirky.structured/stop')).toEqual([])
  })
})

describe('the cards', () => {
  test('a file change inside the worktree shows its relative path and one outside stays absolute', async () => {
    await mountChat({
      session: { cwd: '/work/repo' },
      messages: [
        user(1, 'go'),
        msg(2, { kind: 'file-change', callId: 'c1', path: '/work/repo/src/a.ts', state: 'done' }),
        msg(3, { kind: 'file-change', callId: 'c2', path: '/work/repo-other/b.ts', state: 'done' })
      ]
    })
    expect(byLabel('Edited src/a.ts')!.textContent).toContain('src/a.ts')
    expect(byLabel('Edited src/a.ts')!.textContent).not.toContain('/work/repo')
    expect(byLabel('Edited /work/repo-other/b.ts')).not.toBeNull()
  })

  test('the chat header shows the full session title', async () => {
    await mountChat({ session: { title: 'Claude 2' } })
    const heading = host!.querySelector('h2')!
    expect(heading.textContent).toBe('Claude 2')
    expect(heading.querySelector('button')!.getAttribute('aria-label')).toBe('Rename chat: Claude 2')
    expect(heading.style.textTransform).toBe('')
  })

  test('a file change shows its path and line counts, and running until its call returns', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        msg(2, { kind: 'file-change', callId: 'c1', path: 'src/webhooks/retry.ts', state: 'running' }),
        msg(3, { kind: 'file-change', callId: 'c2', path: 'src/config.ts', added: 18, removed: 4, state: 'done' })
      ]
    })
    const running = byLabel('Editing src/webhooks/retry.ts')!
    expect(running.textContent).toContain('Running')
    const done = byLabel('Edited src/config.ts')!
    expect(done.textContent).toContain('src/config.ts')
    expect(done.textContent).toContain('+18')
    expect(done.textContent).toContain('−4')
    expect(done.textContent).not.toContain('Running')
  })

  test('test results show the counts, the command and the output tail of a failure', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        msg(2, { kind: 'tests', callId: 't', command: 'bun test src/webhooks', passed: 41, failed: 1, state: 'done', tail: 'expected 5 calls, received 6' })
      ]
    })
    const card = byLabel('Tests: bun test src/webhooks')!
    expect(card.textContent).toContain('41 passed')
    expect(card.textContent).toContain('1 failed')
    expect(card.textContent).toContain('42 total')
    expect(card.querySelector('pre')!.textContent).toBe('expected 5 calls, received 6')
  })

  test('test results with no counts yet read as running', async () => {
    await mountChat({ messages: [user(1, 'go'), msg(2, { kind: 'tests', callId: 't', command: 'pytest', state: 'running' })] })
    expect(byLabel('Tests: pytest')!.textContent).toContain('Running tests')
  })

  test('a test card keeps a long command on one clipped line and expands it', async () => {
    const command = `bun test ${'test/long-path/'.repeat(30)}a.test.ts`
    await withClippedLines(async () => {
      await mountChat({ messages: [user(1, 'go'), msg(2, { kind: 'tests', callId: 't', command, state: 'running' })] })
    })
    const card = byLabel(`Tests: ${command}`)!
    const text = card.querySelector<HTMLElement>('[data-command-text]')!
    expect(text.style.whiteSpace).toBe('nowrap')
    expect(text.style.textOverflow).toBe('ellipsis')
    expect(card.querySelector<HTMLElement>('div')!.style.flexWrap).toBe('')
    const toggle = card.querySelector('button')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(text.style.whiteSpace).toBe('pre-wrap')
  })

  test('a steps card lists each step with its state and how many are done', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        msg(2, {
          kind: 'steps',
          callId: 's',
          steps: [
            { text: 'Add backoffDelay', state: 'done' },
            { text: 'Use it in retryDelivery', state: 'done' },
            { text: 'Fix the off-by-one', state: 'active' },
            { text: 'Update docs', state: 'pending' }
          ]
        })
      ]
    })
    const card = byLabel('Plan')!
    expect(card.textContent).toContain('2 of 4 done')
    expect([...card.querySelectorAll('li')].map((row) => row.getAttribute('data-step-state'))).toEqual(['done', 'done', 'active', 'pending'])
    expect(card.textContent).toContain('Running')
  })

  test('cards still running in a stopped turn show stopped', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        msg(2, { kind: 'file-change', callId: 'c1', path: 'a.ts', state: 'running' }),
        msg(3, { kind: 'steps', callId: 's', steps: [{ text: 'one', state: 'active' }] }),
        end(4, 'stopped', 42_000)
      ]
    })
    expect(byLabel('Edited a.ts')!.textContent).toContain('Stopped')
    expect(byLabel('Plan')!.textContent).toContain('Stopped')
    expect(text()).toContain('Stopped after 42s')
  })

  test('a refused view shows its title, couldn\'t show, the errors and a Show source disclosure', async () => {
    const source = '{ "root": { "type": "Treemap" } }'
    await mountChat({
      messages: [user(1, 'go'), msg(2, { kind: 'view-error', title: 'Module map', errors: ['root.type: unknown component "Treemap"'], source })]
    })
    const card = byLabel('View failed: Module map')!
    expect(card.textContent).toContain('Module map')
    expect(card.textContent).toContain("couldn't show")
    expect(card.textContent).toContain('root.type: unknown component "Treemap"')
    expect(card.textContent).toContain('by claude')
    const disclosure = card.querySelector('details')!
    expect(disclosure.querySelector('summary')!.textContent).toBe('Show source')
    expect(disclosure.querySelector('pre')!.textContent).toBe(source)
  })

  test('folded activity shows one summary line and expands to one row per call', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        act1(2, 'a', 'Read', 'Read src/a.ts', 'done', T0 + 1000),
        act1(3, 'b', 'Read', 'Read src/b.ts', 'done', T0 + 4000),
        act1(4, 'c', 'Grep', 'Searched "maxAttempts"', 'done', T0 + 13000)
      ]
    })
    const group = byLabel('Tool activity') as HTMLDetailsElement
    expect(group.querySelector('summary')!.textContent).toContain('Read 2 files · searched 1 pattern · 12s')
    expect(group.open).toBe(false)
    expect([...group.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['Read src/a.ts', 'Read src/b.ts', 'Searched "maxAttempts"'])
    await act(async () => {
      group.open = true
      group.dispatchEvent(new Event('toggle'))
    })
    expect(group.open).toBe(true)
  })

  test('an activity row keeps the dot and the command on one clipped line, with the full command as its hover title', async () => {
    const command = `rg -n ${'x'.repeat(300)}`
    await mountChat({ messages: [user(1, 'go'), act1(2, 'a', 'Bash', command, 'running')] })
    const row = byLabel('Tool activity')!.querySelector('li')!
    const text = row.querySelector<HTMLElement>('[data-command-text]')!
    expect(text.getAttribute('title')).toBe(command)
    expect(text.style.whiteSpace).toBe('nowrap')
    expect(text.style.overflow).toBe('hidden')
    expect(text.style.textOverflow).toBe('ellipsis')
    const line = text.closest('button')?.parentElement ?? text.parentElement!
    expect(line.style.display).toBe('flex')
    expect(line.style.flexWrap).toBe('')
    expect(line.querySelector('[aria-label="Running"]')).not.toBeNull()
  })

  test('a short activity row with no output has nothing to expand', async () => {
    await mountChat({ messages: [user(1, 'go'), act1(2, 'a', 'Read', 'Read src/a.ts', 'running')] })
    expect(byLabel('Tool activity')!.querySelector('li button')).toBeNull()
  })

  test('a clipped activity row expands in place to the whole command and collapses again', async () => {
    const command = `rg -n ${'x'.repeat(300)}`
    await withClippedLines(async () => {
      await mountChat({ messages: [user(1, 'go'), act1(2, 'a', 'Bash', command, 'running')] })
    })
    const row = byLabel('Tool activity')!.querySelector('li')!
    const toggle = row.querySelector('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    const text = row.querySelector<HTMLElement>('[data-command-text]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(text.textContent).toBe(command)
    expect(text.style.whiteSpace).toBe('pre-wrap')
    expect(text.hasAttribute('title')).toBe(false)
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(text.style.whiteSpace).toBe('nowrap')
  })

  test('an activity row with output opens to the full command and the output together', async () => {
    await mountChat({
      messages: [user(1, 'go'), msg(2, { kind: 'activity', callId: 'a', tool: 'Bash', summary: 'git status', state: 'done', detail: 'nothing to commit' })]
    })
    const row = byLabel('Tool activity')!.querySelector('li')!
    expect(row.querySelector('pre')).toBeNull()
    const toggle = row.querySelector('button')!
    expect(toggle.textContent).toBe('git status')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('pre')!.textContent).toBe('nothing to commit')
  })

  test('an activity group with a running call starts open', async () => {
    await mountChat({ messages: [user(1, 'go'), act1(2, 'a', 'Bash', 'Running bun run db:types', 'running')] })
    expect((byLabel('Tool activity') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('markdown prose', () => {
  test('renders markdown, shows raw html as text, and drops unsafe links', async () => {
    const body = ['**bold** and `code`', '', '<script>alert(1)</script>', '', '<img src="x" onerror="alert(1)">', '', '[site](https://example.com) [bad](javascript:alert(1))'].join('\n')
    await mountChat({ messages: [user(1, 'go'), prose(2, body)] })
    expect(host!.querySelector('[data-streamdown="strong"]')!.textContent).toBe('bold')
    expect(host!.querySelector('code')!.textContent).toBe('code')
    expect(host!.querySelector('script')).toBeNull()
    expect(host!.querySelector('[role="log"] img')).toBeNull()
    expect(host!.querySelector('[onerror]')).toBeNull()
    expect(text()).toContain('<script>alert(1)</script>')
    const links = [...host!.querySelectorAll('a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.com'])
  })

  test('a link asks before opening and opens only when confirmed', async () => {
    await mountChat({
      messages: [user(1, 'go'), prose(2, '[site](https://example.com/docs)')],
      handlers: { 'quirky.terminal/openExternal': () => ({ ok: true }) }
    })
    fake.state.confirmAnswer = false
    await click(host!.querySelector('a'))
    await settle()
    expect(fake.confirms).toHaveLength(1)
    expect(fake.confirms[0]).toMatchObject({ title: 'Open link', body: 'https://example.com/docs' })
    expect(fake.callsTo('quirky.terminal/openExternal')).toEqual([])

    fake.state.confirmAnswer = true
    await click(host!.querySelector('a'))
    await settle()
    expect(fake.callsTo('quirky.terminal/openExternal')[0]!.params).toEqual({ target: 'https://example.com/docs' })
  })

  test('a streaming reply ends in a caret', async () => {
    await mountChat({ messages: [user(1, 'go'), prose(2, 'partial', true)] })
    expect(text()).toContain('partial')
    expect(text()).toContain('▍')
    expect(host!.querySelector('.qmd-caret')!.getAttribute('aria-hidden')).toBe('true')
  })

  test('a file that exists becomes a chip that opens the editor at its line, and one that does not stays code', async () => {
    await mountChat({
      messages: [user(1, 'go'), prose(2, 'See `chat/turns.ts:119` and `src/missing.ts`.')],
      handlers: {
        'quirky.session/markdownAssets': () => ({
          files: { 'chat/turns.ts:119': { path: 'plugins/quirky.session/src/window/chat/turns.ts', line: 119 }, 'src/missing.ts': null },
          images: {}
        }),
        'quirky.editor/open': () => ({ ok: true })
      }
    })
    await settle()
    expect(fake.callsTo('quirky.session/markdownAssets').map((call) => call.params)).toEqual([{ session: 'chat', files: ['chat/turns.ts:119', 'src/missing.ts'] }])
    const chips = [...host!.querySelectorAll<HTMLElement>('[data-path-chip]')]
    expect(chips).toHaveLength(1)
    expect(host!.querySelector('code')!.textContent).toBe('src/missing.ts')
    await click(chips[0])
    expect(fake.callsTo('quirky.editor/open').map((call) => call.params)).toEqual([
      { worktree: 'wt-main', path: 'plugins/quirky.session/src/window/chat/turns.ts', line: 119, focus: true }
    ])
  })

  test('a chip opens the worktree-relative path the daemon answered, not the path as written', async () => {
    await mountChat({
      messages: [user(1, 'go'), prose(2, 'See `src/markdown/index.ts:8`.')],
      handlers: {
        'quirky.session/markdownAssets': () => ({ files: { 'src/markdown/index.ts:8': { path: 'packages/ui/src/markdown/index.ts', line: 8 } }, images: {} }),
        'quirky.editor/open': () => ({ ok: true })
      }
    })
    await settle()
    await click(host!.querySelector('[data-path-chip]'))
    expect(fake.callsTo('quirky.editor/open').map((call) => call.params)).toEqual([
      { worktree: 'wt-main', path: 'packages/ui/src/markdown/index.ts', line: 8, focus: true }
    ])
  })

  test('a chip says so when the editor cannot open the file', async () => {
    await mountChat({
      messages: [user(1, 'go'), prose(2, 'See `src/a.ts`.')],
      handlers: {
        'quirky.session/markdownAssets': () => ({ files: { 'src/a.ts': { path: 'src/a.ts' } }, images: {} }),
        'quirky.editor/open': () => {
          throw new Error('no editor')
        }
      }
    })
    await settle()
    await click(host!.querySelector('[data-path-chip]'))
    await settle()
    expect(fake.toasts).toEqual([{ title: 'Could not open file in editor', body: 'no editor' }])
  })

  test('asks for no paths while the reply is still streaming', async () => {
    await mountChat({ messages: [user(1, 'go'), prose(2, 'See `src/a.ts`', true)], handlers: { 'quirky.session/markdownAssets': () => ({ files: {}, images: {} }) } })
    await settle()
    expect(fake.callsTo('quirky.session/markdownAssets')).toEqual([])
  })

  test('a worktree image shows with its path and a remote one never loads', async () => {
    await mountChat({
      messages: [user(1, 'go'), prose(2, '![shot](docs/shot.png)\n\n![track](https://x.io/p.gif)')],
      handlers: { 'quirky.session/markdownAssets': () => ({ files: {}, images: { 'docs/shot.png': '/resource/1' } }) }
    })
    await settle()
    expect(fake.callsTo('quirky.session/markdownAssets').map((call) => call.params)).toEqual([{ session: 'chat', images: ['docs/shot.png'] }])
    expect([...host!.querySelectorAll('[role="log"] img')].map((image) => image.getAttribute('src'))).toEqual(['/resource/1'])
    expect(host!.querySelector('figcaption')!.textContent).toBe('docs/shot.png')
  })

  test('the reply still renders when the daemon has no markdownAssets', async () => {
    await mountChat({ messages: [user(1, 'go'), prose(2, 'See `src/a.ts` **now**')] })
    await settle()
    expect(host!.querySelector('[data-streamdown="strong"]')!.textContent).toBe('now')
    expect(host!.querySelector('[data-path-chip]')).toBeNull()
    expect(host!.querySelector('code')!.textContent).toBe('src/a.ts')
  })
})

describe('embedded views', () => {
  const embedded = (viewId: string) => fake.mounted.filter((mount) => mount.viewId === viewId)

  test('an approval ask mounts the ask card with the session-approval reason of the agent', async () => {
    await mountChat({ capabilities: PI, messages: [user(1, 'go'), msg(2, { kind: 'ask', askId: 'ask-1', variant: 'approval' })] })
    expect(embedded('view:quirky.ask/card').map((mount) => mount.input)).toEqual([{ askId: 'ask-1', sessionApproveDisabled: 'pi has no session approvals' }])
  })

  test('the ask card gets no disabled reason when the agent can approve for a session', async () => {
    await mountChat({ capabilities: CLAUDE, messages: [user(1, 'go'), msg(2, { kind: 'ask', askId: 'ask-2', variant: 'question' })] })
    expect(embedded('view:quirky.ask/card').map((mount) => mount.input)).toEqual([{ askId: 'ask-2' }])
  })

  test('a view item mounts quirky.view/render and a changes item mounts quirky.git/turn-changes', async () => {
    await mountChat({
      messages: [
        user(1, 'go'),
        msg(2, { kind: 'view', viewId: 'v1' }),
        msg(3, { kind: 'changes', worktree: 'wt-main', fromTree: 'aaa', toTree: 'bbb', files: 3 })
      ]
    })
    expect(embedded('view:quirky.view/render').map((mount) => mount.input)).toEqual([{ viewId: 'v1' }])
    expect(embedded('view:quirky.git/turn-changes').map((mount) => mount.input)).toEqual([{ worktree: 'wt-main', fromTree: 'aaa', toTree: 'bbb' }])
  })

  test('the Views pane mounts beside the transcript only while a view is placed there', async () => {
    const records = [{ viewId: 'v1', placement: 'inline', closed: false }]
    await mountChat({ handlers: { 'quirky.view/list': () => records } })
    expect(fake.callsTo('quirky.view/list')[0]!.params).toEqual({ session: 'chat' })
    expect(embedded('view:quirky.view/pane')).toEqual([])

    records[0]!.placement = 'pane'
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 'chat', viewId: 'v1' } })
    await settle()
    expect(embedded('view:quirky.view/pane').map((mount) => mount.input)).toEqual([{ session: 'chat' }])
    expect(host!.querySelector('aside[aria-label="Views"]')).not.toBeNull()
  })

  test('a view change in another session leaves the pane alone', async () => {
    await mountChat()
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 'other', viewId: 'v1' } })
    expect(fake.callsTo('quirky.view/list')).toHaveLength(1)
  })

  test('an embedded view unmounts with its turn and when the chat goes away', async () => {
    await mountChat({ messages: [user(1, 'go'), msg(2, { kind: 'view', viewId: 'v1' })] })
    const [mount] = embedded('view:quirky.view/render')
    expect(mount!.unmounted).toBe(false)
    await act(async () => root!.unmount())
    await settle()
    root = null
    expect(mount!.unmounted).toBe(true)
  })

  test('a view the window does not have leaves a quiet fallback and the rest of the transcript intact', async () => {
    const changes = msg(2, { kind: 'changes', worktree: 'wt', fromTree: 'a', toTree: 'b', files: 2 })
    fake = fakeContext({
      'quirky.structured/messages': () => [user(1, 'go'), changes, prose(3, 'still here')],
      'quirky.structured/capabilities': () => CLAUDE,
      'quirky.view/list': () => []
    })
    fake.missingViews.add('view:quirky.git/turn-changes')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(ChatView, { context: fake.context, session: session({ id: 'chat', kind: 'structured', agent: 'claude', status: 'done' }) }))
    })
    await settle()
    expect(text()).toContain('This turn changed 2 files.')
    expect(text()).toContain('still here')
    expect(embedded('view:quirky.git/turn-changes')).toEqual([])
  })
})

describe('the error row', () => {
  const errorMessages = (resumable: boolean) => [
    user(1, 'go'),
    msg(2, { kind: 'error', reason: 'exited', stderrTail: ['Error: API overloaded (529)', 'Session saved: 7f3c'], resumable })
  ]

  test('shows the last stderr lines with Restart and Open in terminal', async () => {
    await mountChat({ messages: errorMessages(true) })
    const row = host!.querySelector('[role="alert"]')!
    expect(row.textContent).toContain('claude stopped unexpectedly')
    expect(row.querySelector('pre')!.textContent).toBe('Error: API overloaded (529)\nSession saved: 7f3c')
    expect(buttonNamed('Restart')!.disabled).toBe(false)
    expect(buttonNamed('Open in terminal')).toBeDefined()
  })

  test('Restart resumes the session and opens the new one', async () => {
    await mountChat({
      messages: errorMessages(true),
      handlers: { 'quirky.structured/resume': () => session({ id: 'resumed', kind: 'structured', agent: 'claude' }) }
    })
    await click(buttonNamed('Restart'))
    await settle()
    expect(fake.callsTo('quirky.structured/resume')[0]!.params).toEqual({ session: 'chat' })
    expect(fake.opened[0]).toEqual({ id: 'view:quirky.session/worktree', input: { worktree: 'wt-main', session: 'resumed' } })
  })

  test('Restart is disabled with the reason when the conversation cannot resume', async () => {
    await mountChat({ capabilities: PI, messages: errorMessages(false) })
    const restart = buttonNamed('Restart')!
    expect(restart.disabled).toBe(true)
    expect(restart.getAttribute('title')).toBe('pi cannot resume a conversation')
    expect(text()).toContain('pi cannot resume a conversation')
    await click(restart)
    expect(fake.callsTo('quirky.structured/resume')).toEqual([])
  })

  test('Restart falls back to a general reason while capabilities are unknown', async () => {
    await mountChat({ messages: errorMessages(false), handlers: { 'quirky.structured/capabilities': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'x') } } })
    expect(buttonNamed('Restart')!.getAttribute('title')).toBe('This conversation cannot be resumed')
  })

  test('a failed restart shows a toast', async () => {
    await mountChat({ messages: errorMessages(true), handlers: { 'quirky.structured/resume': () => { throw new Error('lease held') } } })
    await click(buttonNamed('Restart'))
    await settle()
    expect(fake.toasts[0]).toEqual({ title: 'Could not restart', body: 'lease held' })
  })

  test('Open in terminal starts a tab for the same agent and worktree', async () => {
    await mountChat({ messages: errorMessages(false), handlers: { 'quirky.terminal/newTab': () => ({}) } })
    await click(buttonNamed('Open in terminal'))
    await settle()
    expect(fake.callsTo('quirky.terminal/newTab')[0]!.params).toEqual({ workspace: 'wt-main', agent: 'claude' })
  })
})

describe('auto-scroll', () => {
  type Geometry = { height: number; top: number; client: number }

  function pretend(element: HTMLElement, geometry: Geometry) {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => geometry.height })
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => geometry.client })
    Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => geometry.top, set: (value: number) => void (geometry.top = value) })
  }
  const scrolled = (element: HTMLElement) => act(async () => void element.dispatchEvent(new Event('scroll')))

  test('follows new messages while at the bottom and stays put once scrolled up', async () => {
    await mountChat({ messages: [user(1, 'go')] })
    const log = host!.querySelector<HTMLElement>('[role="log"]')!
    const geometry: Geometry = { height: 1000, top: 800, client: 200 }
    pretend(log, geometry)
    await scrolled(log)

    geometry.height = 1100
    await push(prose(2, 'one more'))
    expect(geometry.top).toBe(1100)

    geometry.top = 100
    await scrolled(log)
    geometry.height = 1300
    await push(prose(3, 'and another'))
    expect(geometry.top).toBe(100)

    geometry.top = 1100
    await scrolled(log)
    geometry.height = 1500
    await push(prose(4, 'back at the bottom'))
    expect(geometry.top).toBe(1500)
  })

  describe('as the content resizes', () => {
    type Observer = { callback: () => void; targets: Element[] }
    let observers: Observer[]
    let original: typeof ResizeObserver
    beforeEach(() => {
      observers = []
      original = globalThis.ResizeObserver
      globalThis.ResizeObserver = class {
        entry: Observer
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.push(target)
        }
        unobserve() {}
        disconnect() {
          this.entry.targets = []
        }
      } as unknown as typeof ResizeObserver
    })
    afterEach(() => {
      globalThis.ResizeObserver = original
    })
    const resized = () => act(async () => void observers.forEach((observer) => observer.targets.length > 0 && observer.callback()))
    const rect = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

    test('stays at the bottom while a block grows and nothing was pushed', async () => {
      await mountChat({ messages: [user(1, 'go'), prose(2, 'one')] })
      const log = host!.querySelector<HTMLElement>('[role="log"]')!
      const geometry: Geometry = { height: 1000, top: 800, client: 200 }
      pretend(log, geometry)
      await scrolled(log)
      geometry.height = 1240
      await resized()
      expect(geometry.top).toBe(1240)
    })

    test('holds the reading position when a block above it grows', async () => {
      await mountChat({ messages: [user(1, 'a'), prose(2, 'one'), user(3, 'b'), prose(4, 'two')] })
      const log = host!.querySelector<HTMLElement>('[role="log"]')!
      const turns = [...host!.querySelectorAll<HTMLElement>('section')]
      expect(turns).toHaveLength(2)
      const geometry: Geometry = { height: 1200, top: 700, client: 200 }
      const content = { second: 600 }
      pretend(log, geometry)
      log.getBoundingClientRect = rect(0, 200)
      turns[0]!.getBoundingClientRect = () => rect(-geometry.top, content.second - geometry.top)()
      turns[1]!.getBoundingClientRect = () => rect(content.second - geometry.top, 1200 - geometry.top)()
      geometry.top = 1000
      await scrolled(log)
      geometry.top = 700
      await scrolled(log)

      content.second = 680
      geometry.height = 1280
      await resized()
      expect(geometry.top).toBe(780)

      content.second = 660
      geometry.height = 1260
      await resized()
      expect(geometry.top).toBe(760)
    })

    test('does not move a reader who is following when the content above resizes', async () => {
      await mountChat({ messages: [user(1, 'a'), prose(2, 'one'), user(3, 'b'), prose(4, 'two')] })
      const log = host!.querySelector<HTMLElement>('[role="log"]')!
      const geometry: Geometry = { height: 1200, top: 1000, client: 200 }
      pretend(log, geometry)
      await scrolled(log)
      geometry.height = 1300
      await resized()
      expect(geometry.top).toBe(1300)
    })

    test('observes the transcript column', async () => {
      await mountChat({ messages: [user(1, 'go')] })
      const targets = observers.flatMap((observer) => observer.targets)
      expect(targets.some((target) => target.closest('[role="log"]') !== null)).toBe(true)
    })
  })

  describe('the Jump to latest pill', () => {
    const geometry: Geometry = { height: 1000, top: 800, client: 200 }
    async function mountScrolled(top: number) {
      Object.assign(geometry, { height: 1000, top: 800, client: 200 })
      await mountChat({ messages: [user(1, 'go'), prose(2, 'one')] })
      const log = host!.querySelector<HTMLElement>('[role="log"]')!
      pretend(log, geometry)
      log.scrollTo = ((options: ScrollToOptions) => {
        geometry.top = options.top ?? geometry.top
        scrollTo.push(options)
      }) as typeof log.scrollTo
      await scrolled(log)
      geometry.top = top
      await scrolled(log)
      return log
    }
    const scrollTo: ScrollToOptions[] = []
    beforeEach(() => void (scrollTo.length = 0))

    test('is hidden while the transcript is at the bottom', async () => {
      await mountScrolled(800)
      expect(byLabel('Jump to latest')).toBeNull()
    })

    test('appears once scrolled up, and a click scrolls smoothly to the end and hides it', async () => {
      const log = await mountScrolled(100)
      const pill = byLabel('Jump to latest')
      expect(pill).not.toBeNull()
      expect(pill!.tagName).toBe('BUTTON')
      expect(pill!.textContent).toBe('Jump to latest')
      await click(pill)
      expect(scrollTo).toEqual([{ top: 1000, behavior: 'smooth' }])
      expect(geometry.top).toBe(1000)
      await scrolled(log)
      expect(byLabel('Jump to latest')).toBeNull()

      geometry.height = 1200
      await push(prose(3, 'follows again'))
      expect(geometry.top).toBe(1200)
    })

    test('the smooth scroll passing through the middle does not bring the pill back', async () => {
      const log = await mountScrolled(100)
      await click(byLabel('Jump to latest'))
      geometry.top = 500
      await scrolled(log)
      expect(byLabel('Jump to latest')).toBeNull()
      geometry.top = 800
      await scrolled(log)
      expect(byLabel('Jump to latest')).toBeNull()
    })

    test('goes away when the reader scrolls back to the bottom by hand', async () => {
      const log = await mountScrolled(100)
      expect(byLabel('Jump to latest')).not.toBeNull()
      geometry.top = 790
      await scrolled(log)
      expect(byLabel('Jump to latest')).toBeNull()
    })

    test('stays while new text arrives and the reader is scrolled up', async () => {
      await mountScrolled(100)
      geometry.height = 1400
      await push(prose(3, 'more'))
      expect(byLabel('Jump to latest')).not.toBeNull()
      expect(geometry.top).toBe(100)
    })
  })
})

const PLAN_TEXT = '# Handle ExitPlanMode\n\n1. Read the plan file\n2. Journal the plan item'
const waiting = (seq: number, version: number, over: Partial<PlanItem> = {}) =>
  planMsg(seq, version, 'waiting', { askId: `ask-${version}`, text: PLAN_TEXT, ...over })
const panel = () => host!.querySelector<HTMLElement>('aside[aria-label="Plan"]')
const chip = () => [...host!.querySelectorAll<HTMLButtonElement>('header button')].find((button) => button.textContent?.startsWith('Plan'))
const within = (scope: ParentNode | null, name: string) =>
  [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim().startsWith(name))
const answers = () => fake.callsTo('quirky.ask/answer').map((call) => call.params)
const answerHandlers = { 'quirky.ask/answer': () => ({ ok: true }), 'quirky.structured/send': () => ({ ok: true }) }

describe('the plan panel', () => {
  test('a chat with no plan has no chip and no panel', async () => {
    await mountChat({ messages: [user(1, 'hi'), prose(2, 'hello')] })
    expect(chip()).toBeUndefined()
    expect(panel()).toBeNull()
  })

  test('a waiting plan opens the panel on load with the rendered plan, the marker and the three exits', async () => {
    await mountChat({ messages: [user(1, 'plan it'), modeMsg(2, 'plan', true), waiting(3, 1)], handlers: answerHandlers })
    expect(chip()!.textContent).toBe('Plan · v1 waiting')
    const open = panel()!
    expect(open.querySelector('h1, h2, h3')!.textContent).toBe('Handle ExitPlanMode')
    expect(open.textContent).toContain('Journal the plan item')
    expect(open.textContent).toContain('v1 · waiting')
    expect([...open.querySelectorAll('button')].map((button) => button.textContent?.trim()).filter((name) => /^(Approve|Keep)/.test(name!))).toEqual([
      expect.stringMatching(/^Approve, auto mode/),
      expect.stringMatching(/^Approve, review edits/),
      expect.stringMatching(/^Keep planning/)
    ])
    expect(within(open, 'Approve, auto mode')!.className).toContain('ui-button--primary')
    expect(byLabel('Turn off Plan mode')).not.toBeNull()
  })

  test('the transcript has one row per version showing its latest state', async () => {
    await mountChat({
      messages: [user(1, 'plan it'), waiting(2, 1), planMsg(3, 1, 'revised', { text: PLAN_TEXT }), user(4, 'change it'), waiting(5, 2, { unchanged: false }), planMsg(6, 2, 'approved', { text: PLAN_TEXT, approvedMode: 'auto' }), modeMsg(7, 'auto', true)]
    })
    const rows = [...host!.querySelectorAll<HTMLButtonElement>('section[aria-label^="Turn"] button')].map((button) => button.textContent?.trim())
    expect(rows).toEqual(['Plan v1 · revised', 'Plan approved (v2) · auto mode'])
  })

  test('the transcript row of a waiting version reads Plan ready, and a not answered one says so', async () => {
    await mountChat({ messages: [user(1, 'plan it'), waiting(2, 1), planMsg(3, 1, 'not-answered', { text: PLAN_TEXT, reason: 'stopped' })] })
    expect(host!.querySelector('section[aria-label^="Turn"] button')!.textContent).toBe('Plan v1 · not answered')
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mountChat({ messages: [user(1, 'plan it'), waiting(2, 1)] })
    expect(host!.querySelector('section[aria-label^="Turn"] button')!.textContent).toBe('Plan ready (v1) · view in panel')
  })

  test('the chip text follows the newest version', async () => {
    const chipFor = async (messages: StructuredMessage[]) => {
      await mountChat({ messages })
      const text = chip()!.textContent
      await act(async () => root!.unmount())
      document.body.innerHTML = ''
      return text
    }
    expect(await chipFor([user(1, 'go'), waiting(2, 2)])).toBe('Plan · v2 waiting')
    expect(await chipFor([user(1, 'go'), planMsg(2, 1, 'not-answered', { reason: 'feedback' })])).toBe('Plan · waiting for Claude')
    expect(await chipFor([user(1, 'go'), planMsg(2, 1, 'not-answered', { reason: 'mode-switch' })])).toBe('Plan · not answered')
    expect(await chipFor([user(1, 'go'), planMsg(2, 1, 'not-answered', { reason: 'restarted' })])).toBe('Plan · not answered')
    expect(await chipFor([user(1, 'go'), planMsg(2, 1, 'approved', { approvedMode: 'auto' })])).toBe('Plan')
    expect(await chipFor([user(1, 'go'), planMsg(2, 1, 'revised')])).toBe('Plan')
  })

  test('a plan that is not waiting does not open the panel on load; the chip opens and closes it', async () => {
    await mountChat({ messages: [user(1, 'go'), planMsg(2, 3, 'approved', { text: PLAN_TEXT, approvedMode: 'auto' })] })
    expect(panel()).toBeNull()
    await click(chip())
    expect(panel()!.textContent).toContain('v3 · approved · auto mode')
    expect([...panel()!.querySelectorAll('button')].map((button) => button.textContent?.trim()).some((name) => /^(Approve|Keep)/.test(name!))).toBe(false)
    await click(chip())
    expect(panel()).toBeNull()
  })

  test('the panel has a close button, a new version always reopens it, and the chip reopens it', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)] })
    await click(byLabel('Close plan'))
    expect(panel()).toBeNull()
    await click(chip())
    expect(panel()).not.toBeNull()
    await click(byLabel('Close plan'))
    await push(planMsg(3, 1, 'revised', { text: PLAN_TEXT }))
    expect(panel()).toBeNull()
    await push(waiting(4, 2, { text: '# Second plan' }))
    expect(panel()!.textContent).toContain('Second plan')
    expect(panel()!.textContent).toContain('v2 · waiting · revised')
  })

  test('a live first version opens the panel in a chat that had none', async () => {
    await mountChat({ messages: [user(1, 'plan it')] })
    expect(panel()).toBeNull()
    await push(waiting(2, 1))
    expect(panel()).not.toBeNull()
    expect(chip()!.textContent).toBe('Plan · v1 waiting')
  })

  test('a version marked unchanged says so', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 2, { unchanged: true })] })
    expect(panel()!.textContent).toContain('v2 · waiting · unchanged')
  })

  test('after approval the panel stays open on the version without exits and shows the mode', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 3)], handlers: answerHandlers })
    await click(within(panel(), 'Approve, auto mode'))
    expect(answers()).toHaveLength(1)
    await push(planMsg(3, 3, 'approved', { text: PLAN_TEXT, approvedMode: 'auto' }))
    await push(modeMsg(4, 'auto', true))
    expect(panel()!.textContent).toContain('v3 · approved · auto mode')
    expect(within(panel(), 'Approve')).toBeUndefined()
    expect(within(panel(), 'Keep')).toBeUndefined()
    expect(chip()!.textContent).toBe('Plan')
    expect(byLabel('Return permissions to Default')!.textContent).toContain('Auto')
  })

  test('Approve, auto mode and Approve, review edits answer the plan ask with the matching option', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)], handlers: answerHandlers })
    await click(within(panel(), 'Approve, auto mode'))
    await click(within(panel(), 'Approve, review edits'))
    expect(answers()).toEqual([
      { askId: 'ask-1', answers: { decision: { value: 'approve-auto', label: 'Approve, auto mode', source: 'option' } }, skipped: [] },
      { askId: 'ask-1', answers: { decision: { value: 'approve-review', label: 'Approve, review edits', source: 'option' } }, skipped: [] }
    ])
  })

  test('the exits are disabled while an answer is in flight', async () => {
    let finish: (value: unknown) => void = () => {}
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)], handlers: { 'quirky.ask/answer': () => new Promise((resolve) => (finish = resolve)) } })
    await click(within(panel(), 'Approve, auto mode'))
    expect(within(panel(), 'Approve, auto mode')!.disabled).toBe(true)
    expect(within(panel(), 'Keep planning')!.disabled).toBe(true)
    await act(async () => finish({ ok: true }))
    expect(within(panel(), 'Approve, auto mode')!.disabled).toBe(false)
  })

  test('a failed answer shows the error and re-enables the exits', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)], handlers: { 'quirky.ask/answer': () => { throw new Error('ask is gone') } } })
    await click(within(panel(), 'Approve, review edits'))
    await settle()
    expect(panel()!.querySelector('[role="alert"]')!.textContent).toContain('ask is gone')
    expect(within(panel(), 'Approve, review edits')!.disabled).toBe(false)
  })

  test('Keep planning swaps the exits for a feedback box and sends the text as the reason', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 2)], handlers: answerHandlers })
    await click(within(panel(), 'Keep planning'))
    expect(within(panel(), 'Approve, auto mode')).toBeUndefined()
    const box = panel()!.querySelector<HTMLTextAreaElement>('textarea')!
    expect(panel()!.querySelector('label')!.textContent).toBe('What should Claude change?')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Split step 2')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(within(panel(), 'Send to Claude'))
    expect(answers()).toEqual([
      { askId: 'ask-2', answers: { decision: { value: 'keep', label: 'Keep planning', source: 'option' }, reason: { value: 'Split step 2', source: 'input' } }, skipped: [] }
    ])
  })

  test('Keep planning with no text sends no reason, and Cancel brings the exits back', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 2)], handlers: answerHandlers })
    await click(within(panel(), 'Keep planning'))
    await click(within(panel(), 'Cancel'))
    expect(within(panel(), 'Approve, auto mode')).toBeDefined()
    expect(answers()).toEqual([])
    await click(within(panel(), 'Keep planning'))
    await click(within(panel(), 'Send to Claude'))
    expect(answers()).toEqual([{ askId: 'ask-2', answers: { decision: { value: 'keep', label: 'Keep planning', source: 'option' } }, skipped: [] }])
  })

  test('an empty plan says so and offers only Keep planning', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1, { text: '', empty: true })] })
    expect(panel()!.textContent).toContain('Claude sent an empty plan')
    expect(within(panel(), 'Approve')).toBeUndefined()
    expect(within(panel(), 'Keep planning')).toBeDefined()
  })

  test('a plan not answered because Quirky restarted says so and can ask Claude to present it again', async () => {
    await mountChat({ messages: [user(1, 'go'), planMsg(2, 2, 'not-answered', { text: PLAN_TEXT, reason: 'restarted' })], handlers: answerHandlers })
    await click(chip())
    expect(panel()!.textContent).toContain('Quirky restarted before you answered. Claude is no longer waiting on this plan.')
    expect(within(panel(), 'Approve')).toBeUndefined()
    await click(within(panel(), 'Ask Claude to present it again'))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'chat', text: 'Please present the plan again.' })
    expect(answers()).toEqual([])
  })

  test('other not answered versions show no actions and no restart notice', async () => {
    await mountChat({ messages: [user(1, 'go'), planMsg(2, 2, 'not-answered', { text: PLAN_TEXT, reason: 'feedback' })] })
    await click(chip())
    expect(panel()!.textContent).not.toContain('Quirky restarted')
    expect(panel()!.textContent).toContain('v2 · not answered')
    expect(within(panel(), 'Ask Claude')).toBeUndefined()
    expect(within(panel(), 'Approve')).toBeUndefined()
  })

  test('a transcript row opens that version read-only, and the newest keeps its exits', async () => {
    await mountChat({
      messages: [user(1, 'go'), waiting(2, 1, { text: '# Old plan' }), planMsg(3, 1, 'revised', { text: '# Old plan' }), waiting(4, 2, { text: '# New plan' })]
    })
    expect(panel()!.textContent).toContain('New plan')
    await click(host!.querySelector('section[aria-label^="Turn"] button'))
    expect(panel()!.textContent).toContain('Old plan')
    expect(panel()!.textContent).toContain('v1 · revised')
    expect(within(panel(), 'Approve')).toBeUndefined()
    await push(waiting(5, 3, { text: '# Newest plan' }))
    expect(panel()!.textContent).toContain('Newest plan')
    expect(within(panel(), 'Approve, auto mode')).toBeDefined()
  })

  test('Open plan file asks first, then opens the absolute path; it is absent without a file', async () => {
    await mountChat({
      messages: [user(1, 'go'), waiting(2, 1, { filePath: '/Users/me/.claude/plans/plan.md' })],
      handlers: { 'quirky.terminal/openExternal': () => ({ ok: true }) }
    })
    await click(within(panel(), 'Open plan file'))
    await settle()
    expect(fake.confirms).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/openExternal')[0]!.params).toEqual({ target: '/Users/me/.claude/plans/plan.md' })
    fake.state.confirmAnswer = false
    await click(within(panel(), 'Open plan file'))
    await settle()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(1)
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)] })
    expect(within(panel(), 'Open plan file')).toBeUndefined()
  })

  test('no key chooses an exit: Enter, Shift+Tab, 1, 2 and 3 in the composer answer nothing and keep the text', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)], handlers: { ...answerHandlers, 'quirky.structured/configure': () => ({ ok: true }) } })
    const editor = CMView.findFromDOM(host!)!
    await act(async () => editor.dispatch({ changes: { from: 0, insert: 'thinking' } }))
    for (const key of ['1', '2', '3', 'Tab']) {
      await act(async () => void editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === 'Tab', bubbles: true, cancelable: true })))
    }
    expect(answers()).toEqual([])
    expect(editor.state.doc.toString()).toBe('thinking')
    expect(panel()).not.toBeNull()
  })

  test('a message typed while a plan waits goes through quirky.structured/send unchanged', async () => {
    await mountChat({ messages: [user(1, 'go'), waiting(2, 1)], session: { status: 'waiting' }, handlers: answerHandlers })
    const editor = CMView.findFromDOM(host!)!
    await act(async () => editor.dispatch({ changes: { from: 0, insert: 'Does this survive a restart?' } }))
    await click(host!.querySelector('button[aria-label="Send"]'))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'chat', text: 'Does this survive a restart?', when: 'idle' })
    expect(answers()).toEqual([])
  })
})

describe('the composer in a chat with modes', () => {
  const settingsButton = () => host!.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
  const popup = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Turn settings"]')!
  const modeRows = () => [...popup().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const autoRow = () => modeRows().find((row) => row.querySelector('.qt-menu-label')?.childNodes[0]?.textContent === 'Auto')!
  const openModes = async () => {
    await click(settingsButton())
    await click(popup().querySelector<HTMLElement>('[data-settings-row="mode"]'))
  }

  test('the badge and Mode list follow the mode items, and Auto follows autoAvailable', async () => {
    await mountChat({ messages: [user(1, 'go'), modeMsg(2, 'plan', false)] })
    expect(byLabel('Turn off Plan mode')).not.toBeNull()
    await openModes()
    expect(autoRow().getAttribute('aria-disabled')).toBe('true')
    expect(autoRow().title).toBe("Auto mode isn't available for this model")
    await push(modeMsg(3, 'plan', true))
    expect(autoRow().getAttribute('aria-disabled')).toBeNull()
    await push(modeMsg(4, 'acceptEdits', true))
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(byLabel('Return permissions to Default')!.textContent).toContain('Accept edits')
  })

  test('Auto is on offer in a chat that has not started, and off once it has without ever reporting it', async () => {
    await mountChat({ messages: [] })
    await openModes()
    expect(autoRow().getAttribute('aria-disabled')).toBeNull()
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mountChat({ messages: [user(1, 'go')] })
    await openModes()
    expect(autoRow().getAttribute('aria-disabled')).toBe('true')
  })

  test('/plan from Plan goes back to the mode before it', async () => {
    await mountChat({
      messages: [user(1, 'go'), modeMsg(2, 'acceptEdits', true), modeMsg(3, 'plan', true)],
      handlers: { 'quirky.structured/configure': () => ({ ok: true }) }
    })
    const editor = CMView.findFromDOM(host!)!
    await act(async () => editor.dispatch({ changes: { from: 0, insert: '/plan' }, selection: { anchor: 5 } }))
    await settle()
    await click(host!.querySelector('[role="option"]'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure')[0]!.params).toEqual({ session: 'chat', permissionMode: 'acceptEdits' })
  })
})

describe('the plan panel in a narrow chat', () => {
  type Observer = { callback: () => void }
  let observers: Observer[] = []
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const bodyOf = () => host!.querySelector<HTMLElement>('[role="log"]')!.parentElement!.parentElement!
  const resize = async (width: number) => {
    const element = bodyOf()
    element.getBoundingClientRect = () => ({ width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) })
    await act(async () => void observers.forEach((observer) => observer.callback()))
  }

  afterEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = original
    observers = []
  })

  async function mountNarrow(messages: StructuredMessage[]) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push({ callback })
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    await mountChat({ messages, handlers: answerHandlers })
  }

  test('below the width of the transcript plus the panel the plan opens in a sheet, above it in an aside', async () => {
    await mountNarrow([user(1, 'go'), waiting(2, 1)])
    expect(panel()).not.toBeNull()
    await resize(900)
    expect(panel()).toBeNull()
    const open = host!.querySelector<HTMLElement>('[role="dialog"]')!
    expect(open.textContent).toContain('Handle ExitPlanMode')
    expect(within(open, 'Approve, auto mode')).toBeDefined()
    await resize(1100)
    expect(host!.querySelector('[role="dialog"]')).toBeNull()
    expect(panel()).not.toBeNull()
  })

  test('the sheet closes with its close button and the chip reopens it', async () => {
    await mountNarrow([user(1, 'go'), waiting(2, 1)])
    await resize(800)
    await click(host!.querySelector('[role="dialog"] .ui-dialog__close'))
    expect(host!.querySelector('[role="dialog"]')).toBeNull()
    await click(chip())
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe('the agent picker', () => {
  const listing = agentListing([
    agentInfo('claude', 'Claude Code'),
    agentInfo('codex', 'Codex', { signedIn: false } as never),
    agentInfo('pi', 'pi', { installed: false }),
    agentInfo('omp', 'omp')
  ])
  const effort = { id: 'effort', label: 'Effort', type: 'select', choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], default: 'high' }
  // claude declares a default; omp lists a model but declares none, so it must not read as its default
  const options = (agent: string) =>
    agent === 'omp'
      ? { models: [{ id: 'sonnet-5.5', label: 'sonnet-5.5', options: [] }], defaultModel: null }
      : {
          models: [{ id: 'fable', label: 'Fable', options: [effort] }, { id: 'opus', label: 'Opus 5.5', options: [effort] }, { id: 'haiku', label: 'Haiku', options: [] }],
          defaultModel: 'opus'
        }

  async function mountPicker(handlers: Record<string, Handler> = {}, props: Partial<Parameters<typeof AgentPicker>[0]> = {}) {
    const created: Session[] = []
    fake = fakeContext({
      'quirky.agents/list': () => listing,
      'quirky.agents/options': (params) => options(params.agent),
      'quirky.structured/create': () => session({ id: 'new', kind: 'structured', agent: 'claude' }),
      ...handlers
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(AgentPicker, { context: fake.context, worktree: 'wt-main', onCreated: (next: Session) => void created.push(next), ...props }))
    })
    await settle()
    return created
  }
  const card = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.querySelector('strong')?.textContent === name)!

  test('titles itself only when the host does not', async () => {
    await mountPicker()
    expect(host!.querySelector('h3')?.textContent).toBe('New chat')
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mountPicker({}, { heading: false })
    expect(host!.querySelector('h3')).toBeNull()
    expect(byLabel('New chat')).not.toBeNull()
  })

  test('shows the four agents with their default model and why one is not ready', async () => {
    await mountPicker()
    expect([...host!.querySelectorAll('button')].map((button) => button.querySelector('strong')!.textContent)).toEqual(['Claude Code', 'Codex', 'pi', 'omp'])
    expect(card('Claude Code').textContent).toContain('Opus 5.5 · ready')
    expect(card('Claude Code').disabled).toBe(false)
    expect(card('Codex').textContent).toContain('not signed in')
    expect(card('Codex').disabled).toBe(true)
    expect(card('pi').textContent).toContain('not installed')
    expect(card('pi').disabled).toBe(true)
    expect(card('omp').textContent).toContain('Default model · ready')
  })

  test('reads ready with the default model when the model list cannot be read', async () => {
    await mountPicker({ 'quirky.agents/options': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'x') } })
    expect(card('Claude Code').textContent).toContain('Default model · ready')
  })

  test('with the agents plugin missing every agent reads as not installed', async () => {
    await mountPicker({ 'quirky.agents/list': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'x') } })
    expect([...host!.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
    expect(card('omp').textContent).toContain('not installed')
  })

  test('picking an agent creates the chat in the worktree on its declared default model and effort', async () => {
    const created = await mountPicker()
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({
      agent: 'claude',
      worktree: 'wt-main',
      deferStart: true,
      model: 'opus',
      options: { effort: 'high' }
    })
    expect(created.map((entry) => entry.id)).toEqual(['new'])
  })

  test('the agent settings in the worktree name the card and the create call ahead of the catalog default', async () => {
    await mountPicker({ 'quirky.structured/defaults': (params) => (params.agent === 'claude' ? { model: 'fable', effort: 'low' } : { model: null, effort: null }) })
    expect(fake.callsTo('quirky.structured/defaults').map((call) => call.params)).toContainEqual({ agent: 'claude', worktree: 'wt-main' })
    expect(card('Claude Code').textContent).toContain('Fable · ready')
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({
      agent: 'claude',
      worktree: 'wt-main',
      deferStart: true,
      model: 'fable',
      options: { effort: 'low' }
    })
  })

  test('an agent with no declared default launches on its own choice', async () => {
    await mountPicker()
    await click(card('omp'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'omp', worktree: 'wt-main', deferStart: true })
  })

  test('a picked model without effort gets no default effort, and a picked effort applies to the default model', async () => {
    await mountPicker({}, { picks: { model: 'haiku', effort: null, mode: null } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'claude', worktree: 'wt-main', deferStart: true, model: 'haiku' })
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mountPicker({}, { picks: { model: null, effort: 'low', mode: null } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toMatchObject({ model: 'opus', options: { effort: 'low' } })
  })

  test('creates with the picks alone when the model list cannot be read', async () => {
    await mountPicker({ 'quirky.agents/options': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'x') } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'claude', worktree: 'wt-main', deferStart: true })
  })

  test('the composer picks reach the create call', async () => {
    await mountPicker({}, { picks: { model: 'opus', effort: 'high', mode: 'yolo' } })
    await click(card('omp'))
    await settle()
    // the permission pick is a structured create param, not a catalog launch option
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({
      agent: 'omp',
      worktree: 'wt-main',
      deferStart: true,
      model: 'opus',
      options: { effort: 'high' },
      permissionMode: 'yolo'
    })
  })

  test('a Plan pick reaches the create call as the permission mode', async () => {
    await mountPicker({}, { picks: { model: null, effort: null, mode: 'plan' } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'claude', worktree: 'wt-main', deferStart: true, model: 'opus', options: { effort: 'high' }, permissionMode: 'plan' })
  })

  test('a Default pick is sent, so it beats the terminal preset', async () => {
    await mountPicker({}, { picks: { model: null, effort: null, mode: 'default' } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'claude', worktree: 'wt-main', deferStart: true, model: 'opus', options: { effort: 'high' }, permissionMode: 'default' })
  })

  test('a failed create shows a toast and reports nothing', async () => {
    const created = await mountPicker({ 'quirky.structured/create': () => { throw new Error('agent missing') } })
    await click(card('Claude Code'))
    await settle()
    expect(fake.toasts[0]).toEqual({ title: 'Could not start chat', body: 'agent missing' })
    expect(created).toEqual([])
  })
})
