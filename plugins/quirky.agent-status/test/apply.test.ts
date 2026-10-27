import { describe, expect, test } from 'bun:test'
import { applyEvent, type ApplyEvent } from '../src/apply'
import { decideIdentity, type IdentityEvent } from '../src/identity'
import type { AgentRow, Normalized } from '../src/types'

const base: ApplyEvent = { sessionId: 's1', source: 'claude', at: 1000, replay: false }

function event(n: Partial<Normalized> = {}): Normalized {
  return { eventName: 'PreToolUse', state: null, newTurn: false, fields: {}, ...n }
}

/** Applies events in order, each at `start + 1000 * index`, and returns every result. */
function run(steps: [Partial<Normalized>, Partial<ApplyEvent>?][], start = 1000) {
  let row: AgentRow | null = null
  return steps.map(([n, ev], index) => {
    const result = applyEvent(row, event(n), { ...base, at: start + index * 1000, ...ev })
    row = result.row
    return result
  })
}

const prompt = (text = 'fix the tests'): Partial<Normalized> => ({
  eventName: 'UserPromptSubmit',
  state: 'working',
  newTurn: true,
  fields: { prompt: text }
})
const tool = (name: string, input?: string, extra: Partial<Normalized> = {}): Partial<Normalized> => ({
  state: 'working',
  fields: { toolName: name, ...(input ? { toolInput: input } : {}) },
  ...extra
})
const stop = (extra: Partial<Normalized> = {}): Partial<Normalized> => ({ eventName: 'Stop', state: 'done', outcome: 'success', ...extra })
const permission = (name: string, input: string, toolUseId?: string): Partial<Normalized> => ({
  eventName: 'PermissionRequest',
  state: 'waiting',
  permissionRequest: true,
  fields: { toolName: name, toolInput: input, ...(toolUseId ? { toolUseId } : {}) }
})

describe('timing', () => {
  test('repeated working events keep the state clock and move the evidence clock', () => {
    const [first, second, third] = run([[prompt()], [tool('Bash')], [tool('Read')]], 0)
    expect(first!.row).toMatchObject({ state: 'working', stateStartedAt: 0, evidenceAt: 0, turnStartedAt: 0 })
    expect(second!.row).toMatchObject({ stateStartedAt: 0, evidenceAt: 1000, turnStartedAt: 0, toolName: 'Bash' })
    expect(third!.row).toMatchObject({ stateStartedAt: 0, evidenceAt: 2000, toolName: 'Read', prompt: 'fix the tests' })
  })

  test('the lead clock follows the lead, the row clock follows the fold', () => {
    const results = run([
      [prompt()],
      [{ eventName: 'SubagentStart', childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }],
      [stop()],
      [{ eventName: 'SubagentStop', childOps: [{ op: 'stop', id: 'a1' }] }]
    ])
    const [turn, , leadDone, drained] = results.map((r) => r.row!)
    expect(leadDone).toMatchObject({ state: 'working', stateStartedAt: 1000, lead: { state: 'done', stateStartedAt: 3000 } })
    expect(drained).toMatchObject({ state: 'done', stateStartedAt: 4000, lead: { stateStartedAt: 3000 } })
    expect(turn!.lead.stateStartedAt).toBe(1000)
  })

  test('a new turn stamps the turn start; other events do not', () => {
    const rows = run([[prompt()], [stop()], [tool('Bash')], [prompt('again')]]).map((r) => r.row!)
    expect(rows.map((r) => r.turnStartedAt)).toEqual([1000, 1000, 1000, 4000])
  })

  test('hooks and replays stamp lastHookAt and the source', () => {
    const [hook, replay] = run([[prompt()], [stop(), { replay: true, at: 500 }]])
    expect(hook!.row).toMatchObject({ source: 'hook', lastHookAt: 1000 })
    expect(replay!.row).toMatchObject({ source: 'replay', lastHookAt: 500, evidenceAt: 500 })
  })

  test('an event confirms a row restored after a restart', () => {
    const [started] = run([[prompt()]])
    const restored = { ...started!.row!, restoredUnconfirmed: true }
    const { row } = applyEvent(restored, event(tool('Bash')), { ...base, at: 9000 })
    expect(row!.restoredUnconfirmed).toBeUndefined()
  })
})

describe('the fold', () => {
  test('a finished lead with a live subagent keeps the row working and its outcome is the lead\'s', () => {
    const rows = run([
      [prompt()],
      [{ eventName: 'SubagentStart', childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }],
      [stop()]
    ]).map((r) => r.row!)
    expect(rows[2]).toMatchObject({ state: 'working', outcome: 'success', lead: { state: 'done' } })
    expect(rows[2]!.children).toEqual([{ id: 'a1', kind: 'agent', state: 'working' }])
  })

  test('a child question makes the row wait, its next tool event restores working, its stop leaves done', () => {
    const rows = run([
      [prompt()],
      [{ eventName: 'SubagentStart', childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }],
      [stop()],
      [
        {
          eventName: 'PreToolUse',
          state: 'waiting',
          agentId: 'a1',
          fields: { toolName: 'AskUserQuestion', question: '{"questions":[{"question":"Which branch?"}]}' },
          childOps: [{ op: 'state', id: 'a1', state: 'waiting' }]
        }
      ],
      [{ state: 'working', agentId: 'a1', fields: {}, childOps: [{ op: 'state', id: 'a1', state: 'working' }] }],
      [{ eventName: 'SubagentStop', childOps: [{ op: 'stop', id: 'a1' }] }]
    ]).map((r) => r.row!)
    expect(rows[3]).toMatchObject({ state: 'waiting', detail: 'Which branch?', lead: { state: 'done' }, stashedState: 'done' })
    expect(rows[4]).toMatchObject({ state: 'working' })
    expect(rows[4]!.stashedState).toBeUndefined()
    expect(rows[5]).toMatchObject({ state: 'done', outcome: 'success' })
  })

  test('a child tool event with an unknown id creates the child', () => {
    const [, row] = run([[prompt()], [{ state: 'working', agentId: 'late', fields: {}, childOps: [{ op: 'state', id: 'late', state: 'working' }] }]]).map((r) => r.row!)
    expect(row!.children).toEqual([{ id: 'late', kind: 'agent', state: 'working' }])
  })

  test('a child event does not change the lead state', () => {
    const [, row] = run([[prompt()], [{ state: 'waiting', agentId: 'a1', fields: {}, childOps: [{ op: 'state', id: 'a1', state: 'waiting' }] }]]).map((r) => r.row!)
    expect(row!.lead.state).toBe('working')
    expect(row!.state).toBe('waiting')
  })

  test('a complete inventory of shells reads as monitoring, an empty one as done', () => {
    const [, monitoring, finished] = run([
      [prompt()],
      [stop({ inventory: { tasks: [{ id: 'sh1', kind: 'shell', running: true }], complete: true } })],
      [stop({ inventory: { tasks: [], complete: true } })]
    ]).map((r) => r.row!)
    expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(finished!.state).toBe('done')
    expect(finished!.workingMode).toBeUndefined()
  })

  test('a running subagent in the inventory is plain working', () => {
    const [, row] = run([[prompt()], [stop({ inventory: { tasks: [{ id: 'a9', kind: 'agent', running: true }], complete: true } })]]).map((r) => r.row!)
    expect(row!.workingMode).toBeUndefined()
    expect(row!.state).toBe('working')
  })

  test('an inventory that is not complete keeps children it does not list', () => {
    const [, , row] = run([
      [prompt()],
      [{ childOps: [{ op: 'start', id: 'sh1', kind: 'shell' }] }],
      [stop({ inventory: { tasks: [], complete: false } })]
    ]).map((r) => r.row!)
    expect(row!.children).toHaveLength(1)
  })

  test('active session crons hold the row as monitoring until cleared', () => {
    const [, monitoring, cleared] = run([[prompt()], [stop({ cronsActive: true })], [stop({ cronsActive: false })]]).map((r) => r.row!)
    expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(cleared!.state).toBe('done')
  })

  test('a session boundary clears children and the previous turn', () => {
    const [, , row] = run([
      [prompt()],
      [{ childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }],
      [{ eventName: 'SessionStart', state: 'done', newTurn: true, sessionBoundary: true }]
    ]).map((r) => r.row!)
    expect(row).toMatchObject({ state: 'done', sessionBoundary: true, prompt: '', children: [] })
  })
})

describe('Claude permission hold', () => {
  const held = () => run([[prompt()], [tool('Bash', 'npm test', { fields: { toolName: 'Bash', toolInput: 'npm test', toolUseId: 't1' } })], [permission('Bash', 'npm test', 't1')]])

  test('a request holds the row waiting with a readable detail', () => {
    const row = held()[2]!.row!
    expect(row).toMatchObject({ state: 'waiting', detail: 'Bash: npm test' })
    expect(row.heldPermission).toEqual({ toolUseId: 't1', toolName: 'Bash', input: 'npm test', childId: null })
  })

  test('an unrelated tool event leaves the row waiting and its detail alone', () => {
    let row = held()[2]!.row!
    const { row: after, notify } = applyEvent(row, event(tool('Read', 'a.ts', { eventName: 'PostToolUse', fields: { toolName: 'Read', toolInput: 'a.ts', toolUseId: 't2' } })), { ...base, at: 9000 })
    expect(after).toMatchObject({ state: 'waiting', toolName: 'Bash', detail: 'Bash: npm test', evidenceAt: 9000 })
    expect(notify).toBeNull()
  })

  test('the approved tool resuming with the same id and input releases it', () => {
    const row = held()[2]!.row!
    const { row: after } = applyEvent(row, event(tool('Bash', 'npm test', { eventName: 'PreToolUse', fields: { toolName: 'Bash', toolInput: 'npm test', toolUseId: 't1' } })), { ...base, at: 9000 })
    expect(after).toMatchObject({ state: 'working', stateStartedAt: 9000 })
    expect(after!.heldPermission).toBeUndefined()
  })

  test('a different tool use id of the same tool does not release it', () => {
    const row = held()[2]!.row!
    const { row: after } = applyEvent(row, event(tool('Bash', 'npm test', { eventName: 'PostToolUse', fields: { toolName: 'Bash', toolInput: 'npm test', toolUseId: 'other' } })), { ...base, at: 9000 })
    expect(after!.state).toBe('waiting')
  })

  test('a request that recorded no tool use id is settled by the same tool and input', () => {
    const [, , row] = run([[prompt()], [tool('Bash', 'npm test')], [permission('Bash', 'npm test')]]).map((r) => r.row!)
    const { row: after } = applyEvent(row!, event(tool('Bash', 'npm test', { eventName: 'PostToolUse', fields: { toolName: 'Bash', toolInput: 'npm test', toolUseId: 'x9' } })), { ...base, at: 9000 })
    expect(after!.state).toBe('working')
  })

  test('an explicit prompt releases it', () => {
    const row = held()[2]!.row!
    const { row: after } = applyEvent(row, event(prompt('next')), { ...base, at: 9000 })
    expect(after).toMatchObject({ state: 'working', prompt: 'next' })
    expect(after!.heldPermission).toBeUndefined()
  })

  test('a failure of the approved tool settles it only by its exact id', () => {
    const row = held()[2]!.row!
    const failure = (id: string) => applyEvent(row, event({ eventName: 'PostToolUseFailure', state: 'working', fields: { toolUseId: id } }), { ...base, at: 9000 }).row!
    expect(failure('other').state).toBe('waiting')
    expect(failure('t1').state).toBe('working')
  })

  test('the lead stopping ends the hold', () => {
    const row = held()[2]!.row!
    const { row: after } = applyEvent(row, event(stop()), { ...base, at: 9000 })
    expect(after).toMatchObject({ state: 'done' })
    expect(after!.heldPermission).toBeUndefined()
  })

  test('a child permission holds that child; the child ending releases it', () => {
    const childPermission: Partial<Normalized> = {
      ...permission('Bash', 'ls', 'c1'),
      agentId: 'a1',
      childOps: [{ op: 'state', id: 'a1', state: 'waiting' }]
    }
    const [, , waiting] = run([[prompt()], [{ childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }], [childPermission]]).map((r) => r.row!)
    expect(waiting).toMatchObject({ state: 'waiting', lead: { state: 'working' }, heldPermission: { childId: 'a1' } })

    const unrelated = applyEvent(waiting!, event({ state: 'working', agentId: 'a1', fields: { toolName: 'Read', toolUseId: 'z' }, childOps: [{ op: 'state', id: 'a1', state: 'working' }] }), { ...base, at: 9000 }).row!
    expect(unrelated.state).toBe('waiting')

    const ended = applyEvent(waiting!, event({ eventName: 'SubagentStop', childOps: [{ op: 'stop', id: 'a1' }] }), { ...base, at: 9000 }).row!
    expect(ended).toMatchObject({ state: 'working', children: [] })
    expect(ended.heldPermission).toBeUndefined()
  })

  test('a question tool is never held', () => {
    const asked: Partial<Normalized> = {
      ...permission('AskUserQuestion', ''),
      fields: { toolName: 'AskUserQuestion', question: '{"questions":[{"question":"Which?"}]}' }
    }
    const [, row] = run([[prompt()], [asked]]).map((r) => r.row!)
    expect(row).toMatchObject({ state: 'waiting', detail: 'Which?' })
    expect(row!.heldPermission).toBeUndefined()
  })

  test('other agents are not held', () => {
    const [, , row] = run([[prompt(), { source: 'qwen-code' }], [permission('Bash', 'ls'), { source: 'qwen-code' }], [tool('Read'), { source: 'qwen-code' }]]).map((r) => r.row!)
    expect(row).toMatchObject({ state: 'working' })
    expect(row!.heldPermission).toBeUndefined()
  })
})

describe('notifications', () => {
  const notifies = (steps: [Partial<Normalized>, Partial<ApplyEvent>?][]) => run(steps).map((r) => r.notify)

  test('the first row event, then waiting and the final done notify; a boundary and working do not', () => {
    expect(
      notifies([
        [{ eventName: 'SessionStart', state: 'done', newTurn: true, sessionBoundary: true }],
        [prompt()],
        [tool('Bash')],
        [permission('Bash', 'npm test')],
        [tool('Bash', 'npm test', { eventName: 'PostToolUse', fields: { toolName: 'Bash', toolInput: 'npm test', toolUseId: 't' } })],
        [stop()]
      ])
    ).toEqual([null, null, null, 'waiting', null, 'done'])
  })

  test('a repeated done does not notify again', () => {
    expect(notifies([[prompt()], [stop()], [stop()]])).toEqual([null, 'done', null])
  })

  test('a replay never notifies', () => {
    expect(notifies([[prompt()], [stop(), { replay: true }]])).toEqual([null, null])
  })

  test('blocked notifies as waiting', () => {
    expect(notifies([[prompt()], [{ state: 'blocked' }]])).toEqual([null, 'waiting'])
  })

  test('waiting to blocked is a new change into an attention state', () => {
    expect(notifies([[prompt()], [permission('Bash', 'ls')], [{ state: 'blocked' }]])).toEqual([null, 'waiting', 'waiting'])
  })

  test('a Stop that starts a row notifies', () => {
    expect(notifies([[stop()]])).toEqual(['done'])
  })

  test('a done reached when the last child ends notifies once', () => {
    expect(
      notifies([
        [prompt()],
        [{ childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }],
        [stop()],
        [{ eventName: 'SubagentStop', childOps: [{ op: 'stop', id: 'a1' }] }]
      ])
    ).toEqual([null, null, null, 'done'])
  })
})

describe('what changes nothing', () => {
  test('an event that ends the process removes the row', () => {
    const [, ended] = run([[prompt()], [{ eventName: 'SessionEnd', endsProcess: true }]])
    expect(ended).toEqual({ row: null, notify: null })
  })

  test('an event with no meaning leaves the row as it was', () => {
    const [started] = run([[prompt()]])
    expect(applyEvent(started!.row, event(), { ...base, at: 5000 }).row).toBe(started!.row)
  })

  test('without a row, only a lead event with a state starts one', () => {
    expect(applyEvent(null, event({ childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] }), base).row).toBeNull()
    expect(applyEvent(null, event({ state: 'working', agentId: 'a1' }), base).row).toBeNull()
    expect(applyEvent(null, event({ state: 'working' }), base).row).toMatchObject({ sessionId: 's1', agent: 'claude', state: 'working' })
  })

  test('the input is not mutated', () => {
    const [started] = run([[prompt()]])
    const frozen = structuredClone(started!.row!)
    applyEvent(started!.row, event(stop({ childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] })), { ...base, at: 5000 })
    expect(started!.row).toEqual(frozen)
  })
})

describe('fields', () => {
  test('lead identity: pid and provider session are recorded once and moved by movesLead', () => {
    const [first, same, moved] = run([
      [{ eventName: 'SessionStart', state: 'done', newTurn: true, sessionBoundary: true, providerSession: { id: 'abc', transcriptPath: null } }, { agentPid: 10, agentStart: 'x' }],
      [prompt(), { agentPid: 99, agentStart: 'y' }],
      [{ eventName: 'SessionStart', state: 'done', newTurn: true, sessionBoundary: true, movesLead: true, providerSession: { id: 'def', transcriptPath: null } }, { agentPid: 11, agentStart: 'z' }]
    ]).map((r) => r.row!)
    expect(first!.lead).toMatchObject({ providerSession: 'abc', agentPid: 10, agentStart: 'x', ended: false })
    expect(same!.lead).toMatchObject({ providerSession: 'abc', agentPid: 10 })
    expect(moved!.lead).toMatchObject({ providerSession: 'def', agentPid: 11, agentStart: 'z' })
  })

  test('text fields are capped and the detail is one readable line', () => {
    const long = 'x'.repeat(500)
    const [, row] = run([[prompt(long)], [tool('Bash', `{"command":"${long}"}`)]]).map((r) => r.row!)
    expect(row!.prompt).toHaveLength(200)
    expect(row!.toolInput!.length).toBeLessThanOrEqual(160)
    expect(row!.detail.startsWith('{')).toBe(false)
  })

  test('a question is cleared by the lead\'s next status event', () => {
    const asked: Partial<Normalized> = { eventName: 'PreToolUse', state: 'waiting', fields: { toolName: 'AskUserQuestion', question: '{"questions":[{"question":"Which branch?"}]}' } }
    const [, waiting, working] = run([[prompt()], [asked], [tool('Bash')]]).map((r) => r.row!)
    expect(waiting).toMatchObject({ state: 'waiting', detail: 'Which branch?' })
    expect(working!.question).toBeUndefined()
  })

  test('a done with no verdict after a done keeps the verdict, a boundary does not', () => {
    const late: Partial<Normalized> = { eventName: 'afterAgentResponse', state: 'done', fields: { lastAssistantMessage: 'final' } }
    const [, , kept] = run([[prompt()], [stop({ outcome: undefined, interrupted: true })], [late]]).map((r) => r.row!)
    expect(kept).toMatchObject({ interrupted: true, lastAssistantMessage: 'final' })
    const [, , , reset] = run([[prompt()], [stop({ interrupted: true })], [late], [{ eventName: 'SessionStart', state: 'done', newTurn: true, sessionBoundary: true }]]).map((r) => r.row!)
    expect(reset!.interrupted).toBeUndefined()
  })

  test('a done row reads the last assistant message', () => {
    const [, row] = run([[prompt()], [stop({ fields: { lastAssistantMessage: 'All green' } })]]).map((r) => r.row!)
    expect(row).toMatchObject({ state: 'done', outcome: 'success', detail: 'All green' })
  })

  test('an interrupt is done with cancellation, and the next turn clears it', () => {
    const [, interrupted, again] = run([[prompt()], [stop({ outcome: 'cancellation', interrupted: true })], [prompt('next')]]).map((r) => r.row!)
    expect(interrupted).toMatchObject({ outcome: 'cancellation', interrupted: true })
    expect(again!.outcome).toBeUndefined()
    expect(again!.interrupted).toBeUndefined()
  })
})

describe('identity', () => {
  const NOW = 1_000_000
  const lead = (extra: Partial<AgentRow> = {}, leadExtra: Partial<AgentRow['lead']> = {}): AgentRow => ({
    sessionId: 's1',
    agent: 'claude',
    state: 'working',
    prompt: '',
    detail: '',
    lead: { providerSession: 'abc', agentPid: 10, agentStart: 'x', ended: false, state: 'working', stateStartedAt: NOW, ...leadExtra },
    children: [],
    stateStartedAt: NOW,
    evidenceAt: NOW,
    turnStartedAt: null,
    lastHookAt: NOW,
    source: 'hook',
    ...extra
  })
  const ev = (extra: Partial<IdentityEvent> = {}): IdentityEvent => ({ source: 'claude', providerSession: 'abc', movesLead: false, ...extra })
  const alive = () => true
  const dead = () => false
  const probes: [number, string | null][] = []
  const spy = (answer: boolean) => (pid: number, start: string | null) => {
    probes.push([pid, start])
    return answer
  }

  test('an event with no row is accepted', () => {
    expect(decideIdentity(null, ev(), NOW, alive)).toBe('accept')
  })

  test('the lead\'s own events are accepted without probing its process', () => {
    probes.length = 0
    expect(decideIdentity(lead(), ev(), NOW, spy(true))).toBe('accept')
    expect(probes).toEqual([])
  })

  test('another provider session of the same kind is nested while the lead lives and replaces it once it is gone', () => {
    probes.length = 0
    expect(decideIdentity(lead(), ev({ providerSession: 'zzz' }), NOW, spy(true))).toBe('ignore')
    expect(probes).toEqual([[10, 'x']])
    expect(decideIdentity(lead(), ev({ providerSession: 'zzz' }), NOW, dead)).toBe('replace')
  })

  test('clear and resume move the lead', () => {
    expect(decideIdentity(lead(), ev({ providerSession: 'def', movesLead: true }), NOW, alive)).toBe('accept')
  })

  test('without a lead pid, a finished row yields to a new provider session and an unfinished one does not', () => {
    const noPid = { agentPid: null, agentStart: null }
    expect(decideIdentity(lead({ state: 'done' }, noPid), ev({ providerSession: 'zzz' }), NOW, alive)).toBe('replace')
    expect(decideIdentity(lead({}, noPid), ev({ providerSession: 'zzz' }), NOW, alive)).toBe('ignore')
  })

  test('an event without a provider session is never foreign to the same kind', () => {
    expect(decideIdentity(lead(), ev({ providerSession: null }), NOW, alive)).toBe('accept')
  })

  test('a different agent kind is ignored while the row is unfinished and fresh, and yields when it is done', () => {
    expect(decideIdentity(lead(), ev({ source: 'gemini', providerSession: null }), NOW, alive)).toBe('ignore')
    expect(decideIdentity(lead({ state: 'done' }), ev({ source: 'gemini', providerSession: null }), NOW, alive)).toBe('replace')
  })

  test('a different agent replaces an unfinished row whose lead is gone, stale or unconfirmed', () => {
    const gemini = ev({ source: 'gemini', providerSession: null })
    expect(decideIdentity(lead(), gemini, NOW, dead)).toBe('replace')
    expect(decideIdentity(lead({ evidenceAt: NOW - 31 * 60_000 }), gemini, NOW, alive)).toBe('replace')
    expect(decideIdentity(lead({ restoredUnconfirmed: true }), gemini, NOW, alive)).toBe('replace')
    expect(decideIdentity(lead({}, { ended: true }), gemini, NOW, alive)).toBe('replace')
  })
})
