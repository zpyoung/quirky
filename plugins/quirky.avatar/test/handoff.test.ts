import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, HandoffInput, LateAnswer, Level, NeedKind, NeedAction, WorktreeState } from '../src/contracts'
import { register } from '../src/handoff'
import { makeTestApp, type FakeCalls } from './support'

type Wt = Record<string, unknown>
type Sess = Record<string, unknown>

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'avatar-handoff-')))
const pathOf = (name: string) => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

const wt = (id: string, extra: Wt = {}): Wt => ({ id, name: id, repoId: 'repo-1', path: pathOf(id), kind: 'git', ...extra })
const session = (id: string, worktreeId: string, extra: Sess = {}): Sess => ({ id, kind: 'terminal', agent: 'claude', worktreeId, status: 'running', createdAt: 1, lastActivityAt: 2, exitCode: null, ...extra })

const input = (worktreeId: string, extra: Partial<HandoffInput> = {}): HandoffInput => ({
  worktreeId,
  goal: 'Fix the build',
  doneWhen: 'bun test',
  doneWhenKind: 'command',
  guidelines: [],
  level: 'own-branch',
  switches: { messaging: false, historyRewrite: false, deploys: false },
  agent: null,
  notes: '',
  allowSplit: false,
  ...extra
})

type Options = { worktrees?: Wt[]; sessions?: Sess[]; heimdall?: unknown[]; claudeVersion?: string | null; calls?: FakeCalls; settings?: Record<string, unknown> }

function setup(options: Options = {}) {
  const worktrees = options.worktrees ?? [wt('wt-1'), wt('wt-2')]
  const sessions = options.sessions ?? []
  const sent: { session: string; text: string }[] = []
  const t = makeTestApp({
    settings: options.settings,
    fakeCalls: {
      'quirky.worktree/list': () => worktrees,
      'quirky.repo/list': () => [{ id: 'repo-1', name: 'quirky', displayName: null, groupId: 'grp-1' }, { id: 'repo-2', name: 'solo', displayName: 'Solo', groupId: null }],
      'quirky.repo/groupList': () => [{ id: 'grp-1', name: 'Work' }],
      'quirky.session/list': () => sessions,
      'quirky.heimdall/inspect': () => options.heimdall ?? [],
      'quirky.agents/list': () => ({ defaultAgent: 'claude', agents: [{ id: 'claude', installed: true, enabled: true }] }),
      'quirky.agent-status/send': (params) => {
        sent.push({ session: String(params.session), text: String(params.text) })
        return { session: params.session, state: 'working', sentAt: 1, startedAt: 2 }
      },
      ...options.calls
    }
  })
  const frozenNow = 1_700_000_000_000
  t.app.now = () => frozenNow
  const gate = { markers: [] as unknown[][], removed: [] as string[], checks: [] as string[], approved: [] as string[], passthrough: [] as string[], checkResult: { ok: true, reason: '' } }
  t.app.services.gate.writeMarker = (...args) => void gate.markers.push(args)
  t.app.services.gate.removeMarker = (id) => void gate.removed.push(id)
  t.app.services.gate.gateCheck = async (id) => {
    gate.checks.push(id)
    return gate.checkResult
  }
  t.app.services.gate.approveOnce = (id) => void gate.approved.push(id)
  t.app.services.gate.resolveInFlight = (id) => void gate.passthrough.push(id)
  const sup = { sends: [] as [string, string][], started: [] as [string, string][], restarted: [] as [string, string][], startResult: { sessionId: 'new-session' as string | null, error: undefined as string | undefined }, restartResult: { sessionId: 'restart-session' as string | null, error: undefined as string | undefined } }
  t.app.services.supervisor.send = async (id, text) => {
    sup.sends.push([id, text])
    return { sent: true }
  }
  t.app.services.supervisor.startSession = async (id, note) => {
    sup.started.push([id, note])
    return sup.startResult
  }
  t.app.services.supervisor.restartWorker = async (id, note) => {
    sup.restarted.push([id, note])
    return sup.restartResult
  }
  let wakes = 0
  t.app.services.brain.wake = () => void wakes++
  const cancelled: string[] = []
  t.app.services.shipping.cancelOutbox = (id) => {
    cancelled.push(id)
    return 0
  }
  const version = options.claudeVersion === undefined ? '2.1.300' : options.claudeVersion
  const dispose = register(t.app, { claudeVersion: async () => version })
  return { ...t, worktrees, sessions, sent, gate, sup, wakes: () => wakes, cancelled, dispose: dispose as () => void, svc: t.app.services.handoff }
}

type Setup = ReturnType<typeof setup>

async function handOff(s: Setup, ...items: HandoffInput[]) {
  return s.svc.handoff(items)
}

function addNeed(s: Setup, worktreeId: string, kind: NeedKind, actions: NeedAction[], detail: Record<string, unknown> = {}, title = 'a need') {
  return s.app.needs.add({ worktreeId, kind, title, detail, actions })
}

const stateOf = (s: Setup, id: string): WorktreeState | undefined => s.app.store.handoffs.get(id)?.state

function seedDecisionRows(s: Setup): void {
  const lateAnswers: LateAnswer[] = [
    { fingerprint: 'f-late-1', worktreeId: 'wt-1', decision: 'allow', reason: 'answer 1', createdAt: 1, usedAt: null },
    { fingerprint: 'f-late-2', worktreeId: 'wt-2', decision: 'allow', reason: 'answer 2', createdAt: 1, usedAt: null }
  ]
  const approvals: Approval[] = [
    { id: 'a-unused', worktreeId: 'wt-1', fingerprint: 'f-approval-1', usedAt: null },
    { id: 'a-used', worktreeId: 'wt-1', fingerprint: 'f-approval-2', usedAt: 7 },
    { id: 'a-other', worktreeId: 'wt-2', fingerprint: 'f-approval-3', usedAt: null }
  ]
  for (const answer of lateAnswers) s.app.store.lateAnswers.put(answer)
  for (const approval of approvals) s.app.store.approvals.put(approval)
}

function decisionIds(s: Setup) {
  return {
    lateAnswers: s.app.store.lateAnswers.list().map((row) => row.fingerprint),
    approvals: s.app.store.approvals.list().map((row) => row.id)
  }
}

describe('stored decisions', () => {
  test('H1: take-back deletes this worktree’s late answers and unused approvals only', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1'), session('s2', 'wt-2')] })
    await handOff(s, input('wt-1'), input('wt-2'))
    seedDecisionRows(s)

    await s.svc.takeBack({ worktreeIds: ['wt-1'] })

    expect(decisionIds(s)).toEqual({ lateAnswers: ['f-late-2'], approvals: ['a-used', 'a-other'] })
  })

  test('H2: handing off again deletes this worktree’s late answers but keeps approvals', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1'), session('s2', 'wt-2')] })
    await handOff(s, input('wt-1'), input('wt-2'))
    seedDecisionRows(s)

    await handOff(s, input('wt-1', { level: 'local' }))

    expect(decisionIds(s)).toEqual({ lateAnswers: ['f-late-2'], approvals: ['a-unused', 'a-used', 'a-other'] })
  })

  test('H3: a first hand-off clears decision rows left behind beforehand', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    seedDecisionRows(s)

    await handOff(s, input('wt-1'))

    expect(decisionIds(s)).toEqual({ lateAnswers: ['f-late-2'], approvals: ['a-used', 'a-other'] })
  })

  test('H4: accepting a mandate edit deletes this worktree’s late answers but keeps approvals', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1'), session('s2', 'wt-2')] })
    await handOff(s, input('wt-1'), input('wt-2'))
    seedDecisionRows(s)
    const need = addNeed(s, 'wt-1', 'mandate-edit', ['review-accept'], { patch: { goal: 'Better goal' } })

    expect(await s.svc.resolveNeed(need.id, 'review-accept')).toEqual({ ok: true })
    expect(decisionIds(s)).toEqual({ lateAnswers: ['f-late-2'], approvals: ['a-unused', 'a-used', 'a-other'] })
  })

  test('H5: a refused hand-off and rejected mandate edit delete nothing', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    seedDecisionRows(s)
    const need = addNeed(s, 'wt-1', 'mandate-edit', ['review-reject'], { patch: { goal: 'Better goal' } })

    expect(await handOff(s, input('wt-1', { goal: ' ' }))).toMatchObject([{ worktreeId: 'wt-1', ok: false }])
    expect(await s.svc.resolveNeed(need.id, 'review-reject')).toEqual({ ok: true })
    expect(decisionIds(s)).toEqual({ lateAnswers: ['f-late-1', 'f-late-2'], approvals: ['a-unused', 'a-used', 'a-other'] })
  })
})

describe('eligibility', () => {
  test('lists every worktree with its project, group and running agent', async () => {
    const s = setup({
      worktrees: [wt('wt-1'), wt('wt-2', { repoId: 'repo-2', displayName: 'Second' }), wt('wt-3', { repoId: 'group:grp-1', name: 'parent' })],
      sessions: [session('s1', 'wt-1', { agent: 'codex' }), session('sh', 'wt-2', { agent: 'shell' }), session('x', 'wt-2', { agent: 'claude', status: 'exited' })]
    })
    expect(await s.svc.eligibility()).toEqual([
      { worktreeId: 'wt-1', name: 'wt-1', projectId: 'repo-1', projectName: 'quirky', groupId: 'grp-1', groupName: 'Work', agent: 'codex', running: true, handedOff: false, eligible: true, reason: null, ungatedNote: "Codex's hosted tools (web search, image generation) aren't gated" },
      { worktreeId: 'wt-2', name: 'Second', projectId: 'repo-2', projectName: 'Solo', groupId: null, groupName: null, agent: null, running: false, handedOff: false, eligible: true, reason: null, ungatedNote: null },
      { worktreeId: 'wt-3', name: 'parent', projectId: 'group:grp-1', projectName: 'Work', groupId: 'grp-1', groupName: 'Work', agent: null, running: false, handedOff: false, eligible: true, reason: null, ungatedNote: null }
    ])
  })

  test('a live Heimdall watcher on the same real path blocks the worktree', async () => {
    const link = join(scratch, 'link-to-wt-1')
    symlinkSync(pathOf('wt-1'), link)
    const watcher = (workspacePath: string, extra: Record<string, unknown> = {}) => ({ enrollment: { workspacePath, terminalAtMs: null, enabled: true, ...extra } })
    const s = setup({
      worktrees: [wt('wt-1'), wt('wt-2'), wt('wt-3'), wt('wt-4')],
      heimdall: [watcher(link), watcher(pathOf('wt-2'), { terminalAtMs: 5 }), watcher(pathOf('wt-3'), { enabled: false })]
    })
    const rows = await s.svc.eligibility()
    expect(rows.map((row) => [row.worktreeId, row.reason])).toEqual([
      ['wt-1', "Can't hand off: a Heimdall watcher supervises it"],
      ['wt-2', null],
      ['wt-3', null],
      ['wt-4', null]
    ])
    expect(rows[0]).toMatchObject({ eligible: false })
  })

  test('names the other reasons a row cannot be selected', async () => {
    const s = setup({
      worktrees: [wt('a'), wt('b', { kind: 'folder' }), wt('c', { hostId: 'host-2' }), wt('d'), wt('e')],
      sessions: [session('s1', 'a', { agent: 'gemini' }), session('s4', 'd', { agent: 'claude' }), session('s5', 'e', { agent: 'pi' })],
      claudeVersion: '2.1.294'
    })
    const rows = await s.svc.eligibility()
    expect(rows.map((row) => row.reason)).toEqual([
      "Can't hand off: Gemini has no permission hook",
      "Can't hand off: not a git worktree",
      "Can't hand off: it lives on another machine",
      'Claude is too old to fail closed; update Claude',
      null
    ])
    expect(rows.map((row) => row.eligible)).toEqual([false, false, false, false, true])
  })

  test('Claude at exactly 2.1.295 and an unreadable version are eligible', async () => {
    for (const claudeVersion of ['2.1.295 (Claude Code)', '3.0.0', null]) {
      const s = setup({ worktrees: [wt('a')], sessions: [session('s1', 'a')], claudeVersion })
      expect((await s.svc.eligibility())[0]).toMatchObject({ eligible: true, reason: null })
    }
  })

  test('an already handed-off worktree stays eligible and reports handedOff', async () => {
    const s = setup({ worktrees: [wt('a', { kind: 'folder' })] })
    s.app.store.handoffs.put({ worktreeId: 'a', state: 'working', sessionId: null, active: true, handedOffAt: 1, takenBackAt: null })
    expect((await s.svc.eligibility())[0]).toMatchObject({ handedOff: true, eligible: true, reason: null })
  })

  test('a taken-back worktree is no longer handed off', async () => {
    const s = setup({ worktrees: [wt('a')] })
    s.app.store.handoffs.put({ worktreeId: 'a', state: 'working', sessionId: null, active: false, handedOffAt: 1, takenBackAt: 2 })
    expect((await s.svc.eligibility())[0]).toMatchObject({ handedOff: false })
  })
})

describe('handoff', () => {
  test('stores the mandate with settings defaults, writes the marker, briefs an idle agent and starts the gate check', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')], settings: { 'default-level': 'local' } })
    const { level: _level, ...rest } = input('wt-1', { guidelines: [' keep commits small '] })
    const results = await s.svc.handoff([rest as unknown as HandoffInput])

    expect(results).toEqual([{ worktreeId: 'wt-1', ok: true }])
    expect(s.svc.mandate('wt-1')).toMatchObject({ worktreeId: 'wt-1', goal: 'Fix the build', level: 'local', guidelines: ['keep commits small'], sharedGoalId: null, updatedAt: s.app.now() })
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ state: 'checking', sessionId: 's1', active: true, takenBackAt: null })
    expect(s.gate.markers).toEqual([['s1', 'wt-1', 'local']])
    expect(s.gate.checks).toEqual(['wt-1'])
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toMatchObject({ session: 's1' })
    expect(s.sent[0]!.text).toContain('Fix the build')
    expect(s.sent[0]!.text).toContain('bun test')
    expect(s.sent[0]!.text).toContain('keep commits small')
    expect(s.sup.started).toEqual([])
    expect(s.app.store.journalSince(0).filter((entry) => entry.kind === 'handoff')).toHaveLength(1)
  })

  test('does not await the gate check', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    s.app.services.gate.gateCheck = () => new Promise(() => {})
    expect(await handOff(s, input('wt-1'))).toEqual([{ worktreeId: 'wt-1', ok: true }])
  })

  test('with no running agent it starts one with the mandate as its prompt and gates the new session', async () => {
    const s = setup()
    expect(await handOff(s, input('wt-1', { agent: 'claude' }))).toEqual([{ worktreeId: 'wt-1', ok: true }])
    expect(s.sup.started).toHaveLength(1)
    expect(s.sup.started[0]![0]).toBe('wt-1')
    expect(s.sup.started[0]![1]).toContain('Fix the build')
    expect(s.sent).toEqual([])
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ sessionId: 'new-session', active: true })
    expect(s.gate.markers).toEqual([['new-session', 'wt-1', 'own-branch']])
    expect(s.gate.checks).toEqual(['wt-1'])
  })

  test('starts the configured default agent when it is hooked', async () => {
    const s = setup({ calls: { 'quirky.agents/list': () => ({ defaultAgent: 'codex', agents: [{ id: 'codex', installed: true }] }) } })
    expect(await handOff(s, input('wt-1'))).toEqual([{ worktreeId: 'wt-1', ok: true }])
    expect(s.app.store.mandates.get('wt-1')?.agent).toBe('codex')
  })

  test('an unhookable default falls back to the first installed hooked agent', async () => {
    const agents = [{ id: 'rovodev', installed: true }, { id: 'pi', installed: false }, { id: 'codex', installed: true }]
    const s = setup({ calls: { 'quirky.agents/list': () => ({ defaultAgent: 'rovodev', agents }) } })
    expect(await handOff(s, input('wt-1'))).toEqual([{ worktreeId: 'wt-1', ok: true }])
    expect(s.app.store.mandates.get('wt-1')?.agent).toBe('codex')
  })

  test('refuses a row with no installed hooked agent instead of starting an unhookable one', async () => {
    const s = setup({ calls: { 'quirky.agents/list': () => ({ defaultAgent: 'rovodev', agents: [{ id: 'rovodev', installed: true }] }) } })
    const [result] = await handOff(s, input('wt-1'))
    expect(result).toMatchObject({ worktreeId: 'wt-1', ok: false })
    expect(result!.error).toContain('no installed agent has a permission hook')
    expect(s.sup.started).toEqual([])
    expect(s.svc.active()).toEqual([])
  })

  test('rejects an explicitly requested agent without a hook', async () => {
    const s = setup()
    const [result] = await handOff(s, input('wt-1', { agent: 'rovodev' }))
    expect(result).toEqual({ worktreeId: 'wt-1', ok: false, error: 'invalid: agent rovodev has no permission hook' })
    expect(s.sup.started).toEqual([])
  })

  test('a terminal running an agent the avatar did not launch makes the row ineligible', async () => {
    const live = { agent: 'shell', agentStatus: { state: 'waiting' }, status: 'waiting' }
    const s = setup({ sessions: [session('t1', 'wt-1', live), session('t2', 'wt-2', { agent: 'shell', agentStatus: { state: 'done' } }), session('t3', 'wt-3', { agent: 'shell', agentStatus: null })], worktrees: [wt('wt-1'), wt('wt-2'), wt('wt-3')] })
    const rows = await s.svc.eligibility()
    expect(rows[0]).toMatchObject({ worktreeId: 'wt-1', agent: null, running: true, eligible: false, reason: "Can't hand off: an agent is running in a terminal the avatar can't gate; start it from New agent" })
    expect(rows[1]).toMatchObject({ running: false, eligible: true })
    expect(rows[2]).toMatchObject({ running: false, eligible: true })
    const [result] = await handOff(s, input('wt-1'))
    expect(result).toMatchObject({ ok: false })
    expect(s.sup.started).toEqual([])
  })

  test('a start that fails ends the hand-off for that worktree and says why', async () => {
    const s = setup()
    s.sup.startResult = { sessionId: null, error: 'codex is not installed' }
    const [result] = await handOff(s, input('wt-1'))
    expect(result).toEqual({ worktreeId: 'wt-1', ok: false, error: "couldn't start the agent: codex is not installed" })
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ active: false })
    expect(s.gate.checks).toEqual([])
    expect(s.svc.active()).toEqual([])
  })

  test('never sends a brief mid-turn, and sends it when the agent next settles', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1', { status: 'working', agentStatus: { state: 'working' } })] })
    await handOff(s, input('wt-1'))
    expect(s.sent).toEqual([])
    expect(s.gate.markers).toHaveLength(1)

    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 'other', worktreeId: 'wt-2', state: 'done' } })
    expect(s.sent).toEqual([])
    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'done' } })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.text).toContain('Fix the build')
    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'done' } })
    expect(s.sent).toHaveLength(1)
  })

  test('keeps the brief pending while the agent is blocked, and a take-back discards it', async () => {
    let blocked = true
    const s = setup({
      sessions: [session('s1', 'wt-1')],
      calls: {
        'quirky.agent-status/send': () => {
          if (blocked) throw Object.assign(new Error('blocked'), { data: { reason: 'agent-blocked' } })
          return { session: 's1', state: 'working', sentAt: 1, startedAt: 2 }
        }
      }
    })
    await handOff(s, input('wt-1'))
    blocked = false
    const sends: unknown[] = []
    s.fakeCalls['quirky.agent-status/send'] = (params) => void sends.push(params)
    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'waiting' } })
    expect(sends).toHaveLength(1)

    s.dispose()
    const s2 = setup({ sessions: [session('s1', 'wt-1', { agentStatus: { state: 'working' } })] })
    await handOff(s2, input('wt-1'))
    await s2.svc.takeBack({ worktreeIds: ['wt-1'] })
    await s2.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'done' } })
    expect(s2.sent).toEqual([])
  })
  test('the disposer stops its settled listener without resolving in-flight gate requests', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1', { status: 'working', agentStatus: { state: 'working' } })] })
    await handOff(s, input('wt-1'))
    expect(s.sent).toEqual([])

    s.dispose()
    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'done' } })

    expect(s.gate.passthrough).toEqual([])
    expect(s.sent).toEqual([])
  })


  test('each item succeeds or fails on its own', async () => {
    const s = setup({ worktrees: [wt('wt-1'), wt('wt-2', { kind: 'folder' }), wt('wt-3')], sessions: [session('s1', 'wt-1'), session('s3', 'wt-3')] })
    const results = await handOff(s, input('wt-1'), input('wt-2'), input('wt-3', { goal: '  ' }), input('missing'), input('wt-3', { level: 'wild' as Level }))
    expect(results).toEqual([
      { worktreeId: 'wt-1', ok: true },
      { worktreeId: 'wt-2', ok: false, error: "not-eligible: Can't hand off: not a git worktree" },
      { worktreeId: 'wt-3', ok: false, error: 'invalid: goal' },
      { worktreeId: 'missing', ok: false, error: 'not-eligible: unknown worktree' },
      { worktreeId: 'wt-3', ok: false, error: 'invalid: level' }
    ])
    expect(s.svc.active().map((entry) => entry.worktreeId)).toEqual(['wt-1'])
  })

  test('re-handing off updates the mandate, returns to checking, reruns the gate check and re-briefs', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    s.svc.setState('wt-1', 'working', 'on it')
    s.gate.checks.length = 0
    s.sent.length = 0

    expect(await handOff(s, input('wt-1', { goal: 'New goal', level: 'full' }))).toEqual([{ worktreeId: 'wt-1', ok: true }])
    expect(s.svc.mandate('wt-1')).toMatchObject({ goal: 'New goal', level: 'full' })
    expect(stateOf(s, 'wt-1')).toBe('checking')
    expect(s.gate.checks).toEqual(['wt-1'])
    expect(s.gate.markers.at(-1)).toEqual(['s1', 'wt-1', 'full'])
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.text).toContain('New goal')
  })

  test('re-handing off an ineligible but handed-off worktree still works', async () => {
    const s = setup({ worktrees: [wt('wt-1', { kind: 'folder' })] })
    s.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: null, active: true, handedOffAt: 1, takenBackAt: null })
    expect(await handOff(s, input('wt-1', { agent: 'claude' }))).toEqual([{ worktreeId: 'wt-1', ok: true }])
  })

  test('a shared goal groups the worktrees given and nothing else (snapshot)', async () => {
    const s = setup({ worktrees: [wt('wt-1'), wt('wt-2'), wt('wt-3')], sessions: [session('s1', 'wt-1'), session('s2', 'wt-2'), session('s3', 'wt-3')] })
    await handOff(s, input('wt-1', { sharedGoal: { goal: 'Ship it' } }), input('wt-2', { sharedGoal: { goal: 'Ship it' } }))
    const goals = s.app.store.sharedGoals.list()
    expect(goals).toHaveLength(1)
    expect(goals[0]).toMatchObject({ goal: 'Ship it', worktreeIds: ['wt-1', 'wt-2'], mergeOrder: ['wt-1', 'wt-2'] })
    expect(s.svc.mandate('wt-1')!.sharedGoalId).toBe(goals[0]!.id)
    expect(s.svc.mandate('wt-3')).toBeNull()

    await handOff(s, input('wt-3', { sharedGoal: { id: goals[0]!.id, goal: 'Ship it' } }))
    expect(s.app.store.sharedGoals.get(goals[0]!.id)!.worktreeIds).toEqual(['wt-1', 'wt-2', 'wt-3'])

    await handOff(s, input('wt-3'))
    expect(s.app.store.sharedGoals.get(goals[0]!.id)!.worktreeIds).toEqual(['wt-1', 'wt-2'])
    expect(s.svc.mandate('wt-3')!.sharedGoalId).toBeNull()
  })

  test('a failing eligibility lookup fails every item without throwing', async () => {
    const s = setup({ calls: { 'quirky.worktree/list': () => { throw new Error('boom') } } })
    const results = await handOff(s, input('wt-1'))
    expect(results).toEqual([{ worktreeId: 'wt-1', ok: false, error: 'unavailable: boom' }])
  })
})

describe('state and active', () => {
  test('setState updates an active hand-off, journals it and emits state-changed', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    const events: unknown[] = []
    s.app.on((event) => void events.push(event))
    s.svc.setState('wt-1', 'briefing', 'gate passed')
    expect(stateOf(s, 'wt-1')).toBe('briefing')
    expect(events).toContainEqual({ type: 'state-changed', worktreeId: 'wt-1', state: 'briefing' })
    expect(s.app.store.journalSince(0).at(-1)).toMatchObject({ worktreeId: 'wt-1', kind: 'event', data: { type: 'state', state: 'briefing', note: 'gate passed' } })
    expect(s.svc.active()).toEqual([{ worktreeId: 'wt-1', sessionId: 's1', state: 'briefing', mandate: s.svc.mandate('wt-1')! }])
    s.svc.setState('unknown', 'working', 'x')
    expect(stateOf(s, 'unknown')).toBeUndefined()
  })
})

describe('takeBack', () => {
  test('stops gating, closes needs with what was handed back, cancels the outbox and keeps the mandate', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1'), session('s2', 'wt-2')] })
    await handOff(s, input('wt-1'), input('wt-2'))
    const one = addNeed(s, 'wt-1', 'held-call', ['allow-once', 'deny'], {}, 'held force-push')
    const two = addNeed(s, 'wt-1', 'question', ['answer'], {}, 'which db?')
    const other = addNeed(s, 'wt-2', 'question', ['answer'])
    const events: unknown[] = []
    s.app.on((event) => void events.push(event))

    const results = await s.svc.takeBack({ worktreeIds: ['wt-1', 'not-handed-off'] })

    expect(results).toEqual([{ worktreeId: 'wt-1', ok: true, handedBackWith: ['held force-push', 'which db?'] }])
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ active: false, takenBackAt: s.app.now() })
    expect(s.gate.removed).toEqual(['s1'])
    expect(s.gate.passthrough).toEqual(['wt-1'])
    expect(s.cancelled).toEqual(['wt-1'])
    expect(s.app.store.needs.get(one.id)).toMatchObject({ resolution: 'handed-back' })
    expect(s.app.store.needs.get(two.id)!.resolvedAt).not.toBeNull()
    expect(s.app.store.needs.get(other.id)!.resolvedAt).toBeNull()
    expect(s.svc.mandate('wt-1')).not.toBeNull()
    expect(s.svc.active().map((entry) => entry.worktreeId)).toEqual(['wt-2'])
    expect(events).toContainEqual({ type: 'handoffs-changed' })
    expect(s.app.store.journalSince(0).filter((entry) => entry.kind === 'take-back')).toMatchObject([{ worktreeId: 'wt-1', data: { handedBackWith: ['held force-push', 'which db?'] } }])
  })

  test('also removes the marker of every live agent session in the worktree', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    s.sessions.push(session('s9', 'wt-1', { agent: 'codex' }), session('gone', 'wt-1', { status: 'exited' }), session('sh', 'wt-1', { agent: 'shell' }))
    await s.svc.takeBack({ worktreeIds: ['wt-1'] })
    expect(s.gate.removed.sort()).toEqual(['s1', 's9'])
  })

  test('all takes back every active hand-off and nothing else', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1'), session('s2', 'wt-2')] })
    await handOff(s, input('wt-1'), input('wt-2'))
    await s.svc.takeBack({ worktreeIds: ['wt-2'] })
    expect(await s.svc.takeBack({ all: true })).toEqual([{ worktreeId: 'wt-1', ok: true, handedBackWith: [] }])
    expect(s.svc.active()).toEqual([])
    expect(await s.svc.takeBack({ all: true })).toEqual([])
  })

  test('a taken-back worktree can be handed off again with a fresh gate check', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    await s.svc.takeBack({ worktreeIds: ['wt-1'] })
    s.gate.checks.length = 0
    await handOff(s, input('wt-1'))
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ active: true, state: 'checking', takenBackAt: null })
    expect(s.gate.checks).toEqual(['wt-1'])
  })
})

describe('resolveNeed', () => {
  const closed = (s: Setup, id: string) => s.app.store.needs.get(id)!

  test('allow-once approves the call and tells the worker to retry it', async () => {
    const s = setup()
    const need = addNeed(s, 'wt-1', 'held-call', ['allow-once', 'deny'])
    expect(await s.svc.resolveNeed(need.id, 'allow-once')).toEqual({ ok: true })
    expect(s.gate.approved).toEqual([need.id])
    expect(s.sup.sends).toEqual([['wt-1', 'Your held call is approved once; retry it now.']])
    expect(closed(s, need.id)).toMatchObject({ resolution: 'allowed-once' })
    expect(closed(s, need.id).resolvedAt).not.toBeNull()
  })

  test('deny tells the worker to find another way', async () => {
    const s = setup()
    const need = addNeed(s, 'wt-1', 'held-call', ['allow-once', 'deny'])
    expect(await s.svc.resolveNeed(need.id, 'deny')).toEqual({ ok: true })
    expect(s.gate.approved).toEqual([])
    expect(s.sup.sends).toEqual([['wt-1', 'Held call denied; find another way.']])
    expect(closed(s, need.id)).toMatchObject({ resolution: 'denied' })
  })

  test('confirm and redo mark the guess and wake the brain', async () => {
    const s = setup()
    s.app.store.guesses.put({ id: 'g1', worktreeId: 'wt-1', question: 'q', choice: 'a', confirmedAt: null, redoneAt: null, commitsSince: [] })
    s.app.store.guesses.put({ id: 'g2', worktreeId: 'wt-1', question: 'q2', choice: 'b', confirmedAt: null, redoneAt: null, commitsSince: [] })
    const confirm = addNeed(s, 'wt-1', 'guess', ['confirm', 'redo'], { guessId: 'g1' })
    const redo = addNeed(s, 'wt-1', 'guess', ['confirm', 'redo'], { guessId: 'g2' })

    expect(await s.svc.resolveNeed(confirm.id, 'confirm')).toEqual({ ok: true })
    expect(s.app.store.guesses.get('g1')).toMatchObject({ confirmedAt: s.app.now(), redoneAt: null })
    expect(await s.svc.resolveNeed(redo.id, 'redo', 'use b instead')).toEqual({ ok: true })
    expect(s.app.store.guesses.get('g2')).toMatchObject({ confirmedAt: null, redoneAt: s.app.now() })
    expect(s.wakes()).toBe(2)
    expect(closed(s, confirm.id)).toMatchObject({ resolution: 'confirmed' })
    expect(closed(s, redo.id)).toMatchObject({ resolution: 'redone' })
  })

  test('a guess need without a known guess is refused and stays open', async () => {
    const s = setup()
    const need = addNeed(s, 'wt-1', 'guess', ['confirm'], { guessId: 'nope' })
    expect(await s.svc.resolveNeed(need.id, 'confirm')).toEqual({ ok: false, error: 'unknown guess' })
    expect(closed(s, need.id).resolvedAt).toBeNull()
  })

  test('review-accept edits the mandate text but never the level or switches, then wakes the brain', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1', { level: 'shadow' }))
    const need = addNeed(s, 'wt-1', 'mandate-edit', ['review-accept', 'review-reject'], { patch: { goal: 'Better goal', notes: 'n', level: 'full', switches: { deploys: true } }, why: 'scope grew' })

    expect(await s.svc.resolveNeed(need.id, 'review-accept')).toEqual({ ok: true })
    expect(s.svc.mandate('wt-1')).toMatchObject({ goal: 'Better goal', notes: 'n', level: 'shadow', switches: { messaging: false, historyRewrite: false, deploys: false } })
    expect(closed(s, need.id)).toMatchObject({ resolution: 'accepted' })
    expect(s.wakes()).toBe(1)
  })

  test('review-accept with a bad patch is refused', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    const need = addNeed(s, 'wt-1', 'mandate-edit', ['review-accept'], { patch: { goal: ' ' } })
    expect(await s.svc.resolveNeed(need.id, 'review-accept')).toEqual({ ok: false, error: 'invalid: goal' })
    expect(closed(s, need.id).resolvedAt).toBeNull()
    expect(await s.svc.resolveNeed(addNeed(s, 'wt-9', 'mandate-edit', ['review-accept'], { patch: { goal: 'x' } }).id, 'review-accept')).toEqual({ ok: false, error: 'no mandate' })
  })

  test('review-reject closes without waking; answer closes with the text and wakes', async () => {
    const s = setup()
    const reject = addNeed(s, 'wt-1', 'mandate-edit', ['review-accept', 'review-reject'], { patch: { goal: 'x' } })
    expect(await s.svc.resolveNeed(reject.id, 'review-reject')).toEqual({ ok: true })
    expect(closed(s, reject.id)).toMatchObject({ resolution: 'rejected' })
    expect(s.wakes()).toBe(0)

    const question = addNeed(s, 'wt-1', 'question', ['answer'])
    expect(await s.svc.resolveNeed(question.id, 'answer', '  postgres ')).toEqual({ ok: true })
    expect(closed(s, question.id)).toMatchObject({ resolution: 'answered' })
    expect(s.wakes()).toBe(1)
    expect(s.app.store.journalSince(0).at(-1)).toMatchObject({ worktreeId: 'wt-1', kind: 'ask', data: { needId: question.id, text: 'postgres' } })

    const empty = addNeed(s, 'wt-1', 'question', ['answer'])
    expect(await s.svc.resolveNeed(empty.id, 'answer', '  ')).toEqual({ ok: false, error: 'an answer needs text' })
    expect(closed(s, empty.id).resolvedAt).toBeNull()
  })

  test('question needs forward typed answers, reject empty answers, and defer event effects to onAskResolved', async () => {
    const questions = [
      { id: 'q1', type: 'select', question: 'Format?', required: true, options: [{ value: 'v1', label: 'Keep v1' }] },
      { id: 'q2', type: 'confirm', question: 'Migrate?', required: true }
    ]
    const s = setup({ calls: { 'quirky.ask/answer': () => ({ status: 'answered', askId: 'ask-42', answers: {}, skipped: [], summary: 'Format?: Keep v1\nMigrate?: true' }) } })
    const need = addNeed(s, 'wt-1', 'question', ['answer'], { askId: 'ask-42', questions, blocks: 'the schema' })
    const answers = {
      q1: { value: 'v1', label: 'Keep v1', source: 'option' },
      q2: { value: true, source: 'input' }
    }

    expect(await s.svc.resolveNeed(need.id, 'answer', undefined, {})).toEqual({ ok: false, error: 'an answer needs text' })
    expect(closed(s, need.id).resolvedAt).toBeNull()
    expect(s.calls.filter((call) => call.method === 'quirky.ask/answer')).toEqual([])

    expect(await s.svc.resolveNeed(need.id, 'answer', undefined, answers)).toEqual({ ok: true })
    const answerCalls = s.calls.filter((call) => call.method === 'quirky.ask/answer')
    expect(answerCalls).toEqual([{ method: 'quirky.ask/answer', params: { askId: 'ask-42', answers } }])
    expect(answerCalls[0]?.params.answers).toBe(answers)
    expect(closed(s, need.id)).toMatchObject({ resolution: 'answered' })
    expect(s.app.store.journalSince(0).filter((entry) => entry.kind === 'ask' || entry.data.type === 'need-resolved')).toEqual([])

    const eventAnswers = { q1: { value: 'v1', source: 'input' } }
    const need2 = addNeed(s, 'wt-1', 'question', ['answer'], { askId: 'ask-43', questions })
    s.fakeCalls['quirky.ask/answer'] = () => {
      const event = {
        type: 'ask-resolved',
        source: 'quirky.ask/resolved',
        askId: 'ask-43',
        status: 'answered',
        answers: eventAnswers,
        skipped: [],
        summary: 'q1: v1'
      }
      s.app.journal('wt-1', 'event', event)
      s.app.needs.close(need2.id, 'answered')
      s.app.services.brain.wake()
      return { status: 'answered', askId: 'ask-43', answers: {}, skipped: [], summary: 'q1: v1' }
    }

    expect(await s.svc.resolveNeed(need2.id, 'answer', undefined, eventAnswers)).toEqual({ ok: true })
    expect(closed(s, need2.id)).toMatchObject({ resolution: 'answered' })
    const resolvedRows = s.app.store.journalSince(0).filter((entry) => entry.data.askId === 'ask-43')
    expect(resolvedRows).toHaveLength(1)
    expect(resolvedRows[0]).toMatchObject({
      worktreeId: 'wt-1',
      kind: 'event',
      data: { type: 'ask-resolved', source: 'quirky.ask/resolved', askId: 'ask-43', status: 'answered', answers: eventAnswers, skipped: [], summary: 'q1: v1' }
    })
    expect(resolvedRows.filter((entry) => entry.kind === 'ask' || entry.data.type === 'need-resolved')).toEqual([])
    expect(s.wakes()).toBe(1)
  })

  test('legacy text answers use the first question ID or q1 when none is available', async () => {
    const s = setup({ calls: { 'quirky.ask/answer': () => ({ status: 'answered' }) } })
    const needs = [
      { askId: 'ask-first-id', questions: [{ id: 'first-question', type: 'text', question: 'First?' }], expectedId: 'first-question' },
      { askId: 'ask-no-id', questions: [], expectedId: 'q1' }
    ]

    for (const item of needs) {
      const need = addNeed(s, 'wt-1', 'question', ['answer'], { askId: item.askId, questions: item.questions })
      expect(await s.svc.resolveNeed(need.id, 'answer', '  legacy answer  ')).toEqual({ ok: true })
    }

    expect(s.calls.filter((call) => call.method === 'quirky.ask/answer').map((call) => call.params)).toEqual([
      { askId: 'ask-first-id', answers: { 'first-question': { value: 'legacy answer', source: 'input' } } },
      { askId: 'ask-no-id', answers: { q1: { value: 'legacy answer', source: 'input' } } }
    ])
  })

  test('stale asks close for every finished status and missing asks, while validation failures remain retryable', async () => {
    const statuses = ['answered', 'partial', 'declined', 'timed_out', 'unavailable'] as const
    const s = setup()

    for (const status of statuses) {
      const askId = `ask-${status}`
      const need = addNeed(s, 'wt-1', 'question', ['answer'], { askId })
      s.fakeCalls['quirky.ask/answer'] = () => {
        throw new Error(`ask ${askId} is already ${status}`)
      }

      expect(await s.svc.resolveNeed(need.id, 'answer', undefined, { q1: { value: 'x', source: 'input' } })).toEqual({
        ok: false,
        error: `ask ${askId} is already ${status}`
      })
      expect(closed(s, need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: status })
    }

    const missing = addNeed(s, 'wt-1', 'question', ['answer'], { askId: 'ask-missing' })
    s.fakeCalls['quirky.ask/answer'] = () => {
      throw new Error('no such ask: ask-missing')
    }
    expect(await s.svc.resolveNeed(missing.id, 'answer', 'answer')).toEqual({ ok: false, error: 'no such ask: ask-missing' })
    expect(closed(s, missing.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'unavailable' })

    const retryable = addNeed(s, 'wt-1', 'question', ['answer'], { askId: 'ask-validation' })
    let attempts = 0
    s.fakeCalls['quirky.ask/answer'] = () => {
      attempts++
      if (attempts === 1) throw new Error('answers.q1: value does not match the question pattern/format')
      return { status: 'partial' }
    }
    const answers = { q1: { value: 'bad value', source: 'input' } }

    expect(await s.svc.resolveNeed(retryable.id, 'answer', undefined, answers)).toEqual({
      ok: false,
      error: 'answers.q1: value does not match the question pattern/format'
    })
    expect(closed(s, retryable.id).resolvedAt).toBeNull()
    expect(await s.svc.resolveNeed(retryable.id, 'answer', undefined, answers)).toEqual({ ok: true })
    expect(closed(s, retryable.id)).toMatchObject({ resolution: 'partial' })
    expect(attempts).toBe(2)
  })

  test('concurrent restart, restart-to-handoff and answer calls are refused for the same need', async () => {
    const deferred = <T,>() => Promise.withResolvers<T>()

    const restartSetup = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(restartSetup, input('wt-1'))
    const parked = addNeed(restartSetup, 'wt-1', 'parked', ['restart'])
    const restart = deferred<{ sessionId: string | null; error?: string }>()
    restartSetup.app.services.supervisor.restartWorker = async (worktreeId, note) => {
      restartSetup.sup.restarted.push([worktreeId, note])
      return restart.promise
    }
    const firstRestart = restartSetup.svc.resolveNeed(parked.id, 'restart')
    const secondRestart = restartSetup.svc.resolveNeed(parked.id, 'restart')
    restart.resolve({ sessionId: 'restart-session' })
    const [firstRestartResult, secondRestartResult] = await Promise.all([firstRestart, secondRestart])
    expect(firstRestartResult).toEqual({ ok: true })
    expect(secondRestartResult).toEqual({ ok: false, error: 'need already resolved' })
    expect(restartSetup.sup.restarted).toHaveLength(1)

    const gateSetup = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(gateSetup, input('wt-1'))
    gateSetup.svc.setState('wt-1', 'gate-failed', 'tool calls are not reaching the gate')
    gateSetup.gate.checks.length = 0
    const gateNeed = addNeed(gateSetup, 'wt-1', 'gate-failed', ['restart-to-handoff'])
    const gatedRestart = deferred<{ sessionId: string | null; error?: string }>()
    gateSetup.app.services.supervisor.restartWorker = async (worktreeId, note) => {
      gateSetup.sup.restarted.push([worktreeId, note])
      return gatedRestart.promise
    }
    const firstGateRestart = gateSetup.svc.resolveNeed(gateNeed.id, 'restart-to-handoff')
    const secondGateRestart = gateSetup.svc.resolveNeed(gateNeed.id, 'restart-to-handoff')
    gatedRestart.resolve({ sessionId: 'restart-session' })
    const [firstGateResult, secondGateResult] = await Promise.all([firstGateRestart, secondGateRestart])
    expect(firstGateResult).toEqual({ ok: true })
    expect(secondGateResult).toEqual({ ok: false, error: 'need already resolved' })
    expect(gateSetup.sup.restarted).toHaveLength(1)
    expect(gateSetup.gate.checks).toHaveLength(1)

    const answerGate = deferred<unknown>()
    const answerSetup = setup({ calls: { 'quirky.ask/answer': () => answerGate.promise } })
    const question = addNeed(answerSetup, 'wt-1', 'question', ['answer'], { askId: 'ask-conc' })
    const firstAnswer = answerSetup.svc.resolveNeed(question.id, 'answer', undefined, { q1: { value: 'x', source: 'input' } })
    const secondAnswer = answerSetup.svc.resolveNeed(question.id, 'answer', undefined, { q1: { value: 'x', source: 'input' } })
    answerGate.resolve({ status: 'answered' })
    const [firstAnswerResult, secondAnswerResult] = await Promise.all([firstAnswer, secondAnswer])
    expect(firstAnswerResult).toEqual({ ok: true })
    expect(secondAnswerResult).toEqual({ ok: false, error: 'need already resolved' })
    expect(answerSetup.calls.filter((call) => call.method === 'quirky.ask/answer')).toHaveLength(1)
  })

  test('failed restart actions and answers release their claim for a retry', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    const restart = addNeed(s, 'wt-1', 'parked', ['restart'])
    s.sup.restartResult = { sessionId: null, error: 'no agent' }
    expect(await s.svc.resolveNeed(restart.id, 'restart')).toEqual({ ok: false, error: 'no agent' })
    expect(closed(s, restart.id).resolvedAt).toBeNull()
    s.sup.restartResult = { sessionId: 'restart-session', error: undefined }
    expect(await s.svc.resolveNeed(restart.id, 'restart')).toEqual({ ok: true })

    s.svc.setState('wt-1', 'gate-failed', 'tool calls are not reaching the gate')
    const gateNeed = addNeed(s, 'wt-1', 'gate-failed', ['restart-to-handoff'])
    s.sup.restartResult = { sessionId: null, error: 'restart failed' }
    expect(await s.svc.resolveNeed(gateNeed.id, 'restart-to-handoff')).toEqual({ ok: false, error: 'restart failed' })
    expect(closed(s, gateNeed.id).resolvedAt).toBeNull()
    s.sup.restartResult = { sessionId: 'retry-session', error: undefined }
    expect(await s.svc.resolveNeed(gateNeed.id, 'restart-to-handoff')).toEqual({ ok: true })
    expect(s.sup.restarted).toHaveLength(4)
  })


  test('restart restarts the worker and take-back takes the worktree back', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    const parked = addNeed(s, 'wt-1', 'parked', ['restart', 'take-back'])
    expect(await s.svc.resolveNeed(parked.id, 'restart', 'try again')).toEqual({ ok: true })
    expect(s.sup.restarted).toEqual([['wt-1', 'try again']])
    expect(closed(s, parked.id)).toMatchObject({ resolution: 'restarted' })

    s.sup.restartResult = { sessionId: null, error: 'no agent' }
    const again = addNeed(s, 'wt-1', 'parked', ['restart'])
    expect(await s.svc.resolveNeed(again.id, 'restart')).toEqual({ ok: false, error: 'no agent' })
    expect(closed(s, again.id).resolvedAt).toBeNull()

    const back = addNeed(s, 'wt-1', 'parked', ['restart', 'take-back'])
    expect(await s.svc.resolveNeed(back.id, 'take-back')).toEqual({ ok: true })
    expect(s.app.store.handoffs.get('wt-1')!.active).toBe(false)
  })

  test('restart-to-handoff restarts, gates the new session and re-runs the gate check', async () => {
    const s = setup({ sessions: [session('s1', 'wt-1')] })
    await handOff(s, input('wt-1'))
    s.svc.setState('wt-1', 'gate-failed', 'tool calls are not reaching the gate')
    s.gate.checks.length = 0
    s.gate.markers.length = 0
    const need = addNeed(s, 'wt-1', 'gate-failed', ['restart-to-handoff', 'take-back'])

    expect(await s.svc.resolveNeed(need.id, 'restart-to-handoff')).toEqual({ ok: true })
    expect(s.sup.restarted).toHaveLength(1)
    expect(s.gate.markers).toEqual([['restart-session', 'wt-1', 'own-branch']])
    expect(s.gate.checks).toEqual(['wt-1'])
    expect(s.app.store.handoffs.get('wt-1')).toMatchObject({ sessionId: 'restart-session', state: 'checking', active: true })
    expect(closed(s, need.id)).toMatchObject({ resolution: 'restarted' })
  })

  test('an unknown need, a resolved need and a disallowed action are refused', async () => {
    const s = setup()
    expect(await s.svc.resolveNeed('nope', 'deny')).toEqual({ ok: false, error: 'unknown need' })
    const need = addNeed(s, 'wt-1', 'held-call', ['allow-once', 'deny'])
    expect(await s.svc.resolveNeed(need.id, 'answer', 'x')).toEqual({ ok: false, error: 'action not allowed for this need: answer' })
    expect(await s.svc.resolveNeed(need.id, 'deny')).toEqual({ ok: true })
    expect(await s.svc.resolveNeed(need.id, 'deny')).toEqual({ ok: false, error: 'need already resolved' })
    expect(s.sup.sends).toHaveLength(1)
    expect(s.gate.approved).toEqual([])
  })
})

describe('register', () => {
  test('replaces the stub service and its disposer stops the settled listener', async () => {
    const stub = makeTestApp().app.services.handoff
    const s = setup({ sessions: [session('s1', 'wt-1', { agentStatus: { state: 'working' } })] })
    expect(s.svc).not.toBe(stub)
    await handOff(s, input('wt-1'))
    s.dispose()
    await s.deliver({ type: 'quirky.agent-status/settled', data: { sessionId: 's1', worktreeId: 'wt-1', state: 'done' } })
    expect(s.sent).toEqual([])
  })
})
