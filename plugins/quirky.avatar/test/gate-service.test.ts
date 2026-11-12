import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchHook, ToolGateDecision, ToolGateProvider, ToolGateRequest } from '@quirky/protocol'
import type { Level, Mandate } from '../src/contracts'
import { parseProviderTranscriptLine } from '../../quirky.agent-status/src/transcript'
import { callFingerprint } from '../src/fingerprint'
import { register } from '../src/gate/service'
import { codexHooksInstalled, codexHooksPath, hasMarkerFile, markerDir, piExtensionPath, writeMarkerFile } from '../src/hooks/install'
import { makeTestApp, sampleMandate } from './support'

const dirs: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'avatar-gate-')))
  dirs.push(dir)
  return dir
}
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type BrainReply = Awaited<ReturnType<ReturnType<typeof setup>['app']['services']['brain']['judge']>>
type Options = { level?: Level; switches?: Partial<Mandate['switches']>; brain?: (budgetMs: number) => Promise<BrainReply> | BrainReply; agent?: string; agentList?: unknown }

function setup(options: Options = {}) {
  const home = scratch()
  const worktreePath = join(scratch(), 'wt-1')
  const mainPath = join(scratch(), 'main')
  mkdirSync(worktreePath)
  mkdirSync(mainPath)
  const t = makeTestApp({
    fakeCalls: {
      'quirky.worktree/list': () => [
        { id: 'wt-1', path: worktreePath, branch: 'feature', repoId: 'repo', isMain: false },
        { id: 'main', path: mainPath, branch: 'main', repoId: 'repo', isMain: true }
      ],
      ...(options.agentList === undefined ? {} : { 'quirky.agents/list': () => options.agentList })
    }
  })
  const mandate = sampleMandate({ level: options.level ?? 'own-branch', switches: { messaging: false, historyRewrite: false, deploys: false, ...options.switches } })
  t.app.store.mandates.put(mandate)
  t.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: 's-1', active: true, handedOffAt: 1, takenBackAt: null })
  t.app.services.handoff.active = () =>
    t.app.store.handoffs.list({ active: true }).flatMap((row) => {
      const stored = t.app.store.mandates.get(row.worktreeId)
      return stored === null ? [] : [{ worktreeId: row.worktreeId, sessionId: row.sessionId, state: row.state, mandate: stored }]
    })
  const brainCalls: { toolName: string; toolInput: unknown; budgetMs: number }[] = []
  t.app.services.brain.judge = async (call, _mandate, budgetMs) => {
    brainCalls.push({ toolName: call.toolName, toolInput: call.toolInput, budgetMs })
    return options.brain ? options.brain(budgetMs) : { decision: 'deny', reliedOn: 'guideline 1', reason: 'denied by guideline 1' }
  }
  const denials: [string, boolean][] = []
  t.app.services.supervisor.recordDenial = (worktreeId, counts) => void denials.push([worktreeId, counts])

  const agentEnv = { home, env: {} as Record<string, string> }
  const dispose = register(t.app, { agentEnv, claudeVersion: async () => '2.1.300', graceMs: 50 })
  disposers.push(dispose)
  t.app.services.gate.writeMarker('s-1', 'wt-1', mandate.level)
  const provider = t.provided.get('tool-gate:quirky.avatar/gate') as ToolGateProvider

  async function ask(payload: Record<string, unknown>, request: Partial<ToolGateRequest> = {}): Promise<ToolGateDecision> {
    return provider(
      { agent: options.agent ?? 'claude', sessionId: 's-1', event: 'PreToolUse', deadlineMs: 60_000, payload: { hook_event_name: request.event ?? 'PreToolUse', cwd: worktreePath, ...payload }, ...request },
      new AbortController().signal
    )
  }

  const gateEntries = () => t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'gate').reverse()
  const bash = (command: string) => ask({ tool_name: 'Bash', tool_input: { command } })
  const read = (name = 'src/a.ts') => ask({ tool_name: 'Read', tool_input: { file_path: join(worktreePath, name) } })
  const sshWrite = () => ask({ tool_name: 'Write', tool_input: { file_path: join(homedir(), '.ssh', 'config'), content: 'x' } })

  return { ...t, home, worktreePath, agentEnv, brainCalls, denials, provider, ask, bash, read, sshWrite, gateEntries, mandate }
}

type Setup = ReturnType<typeof setup>
const claudeJson = (decision: ToolGateDecision) => JSON.parse(decision.encoded ?? 'null') as { hookSpecificOutput: Record<string, unknown> }
const waitFor = async <T>(check: () => T | undefined | false | null, ms = 2000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}
const STOPPING = 'The avatar is stopping; try the same call again shortly.'
const SHADOW = 'Shadow: the avatar only logs what it would have decided.'
const HANDED_BACK = 'Handed back to the user, so the call is not gated.'

const agentListing = (...ids: string[]) => ({
  defaultAgent: 'claude',
  agents: ids.map((id) => ({ id, installed: true, enabled: true }))
})

describe('disposing the registration', () => {
  test('stops an in-flight gate check quietly without touching the store afterwards', async () => {
    const s = setup()
    let release: () => void = () => undefined
    s.fakeCalls['quirky.session/get'] = () => new Promise((resolve) => { release = () => resolve({ agent: 'claude' }) })
    const check = s.app.services.gate.gateCheck('wt-1')
    await Bun.sleep(10)
    disposers.splice(0).forEach((dispose) => dispose())
    const closed = () => { throw new Error('store is closed') }
    s.app.store.handoffs.get = closed
    s.app.store.receipts.list = closed
    s.app.journal = closed
    s.app.needs.add = closed
    release()
    expect(await check).toEqual({ ok: false, reason: 'the gate check was stopped' })
  })
})

describe('supervision lookup', () => {
  test('a session with no marker is passthrough and leaves no trace', async () => {
    const s = setup()
    const decision = await s.provider({ agent: 'claude', sessionId: 'other', event: 'PreToolUse', deadlineMs: 60_000, payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } }, new AbortController().signal)
    expect(decision).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    expect(s.gateEntries()).toEqual([])
    expect(s.app.store.receipts.list()).toEqual([])
  })

  test('a marker with no active hand-off is passthrough', async () => {
    const s = setup()
    s.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: 's-1', active: false, handedOffAt: 1, takenBackAt: 2 })
    expect((await s.read()).decision).toBe('passthrough')
  })

  test('falls back to the marker when the hand-off row has a different session id', async () => {
    const s = setup()
    s.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: 'older', active: true, handedOffAt: 1, takenBackAt: null })
    expect((await s.read()).decision).toBe('allow')
  })

  test('an event that is not a tool event is passthrough, and an agent the avatar does not gate is unavailable', async () => {
    const s = setup()
    expect((await s.ask({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { event: 'Stop', payload: { hook_event_name: 'Stop' } })).decision).toBe('passthrough')
    const other = await s.provider({ agent: 'cursor', sessionId: 's-1', event: 'PreToolUse', deadlineMs: 1000, payload: {} }, new AbortController().signal)
    expect(other).toMatchObject({ decision: 'unavailable', encoded: null })
  })

  test('a payload with no tool name is refused and journaled', async () => {
    const s = setup()
    const decision = await s.ask({ tool_input: {} })
    expect(decision.decision).toBe('deny')
    expect(claudeJson(decision).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'deny', sawWorkerExplanation: false })
  })
})

describe('the decision path', () => {
  test('a read inside the worktree is allowed without asking the brain, with a receipt and a full journal entry', async () => {
    const s = setup()
    const decision = await s.read()
    expect(decision.decision).toBe('allow')
    expect(claudeJson(decision).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
    expect(s.brainCalls).toEqual([])
    const input = { file_path: join(s.worktreePath, 'src/a.ts') }
    const fingerprint = callFingerprint('claude', 'wt-1', 'Read', input)
    const [receipt] = s.app.store.receipts.list({ sessionId: 's-1' })
    expect(receipt).toMatchObject({ fingerprint, toolName: 'Read', outcome: 'allow' })
    const [entry] = s.gateEntries()
    expect(entry!.data).toMatchObject({ outcome: 'allow', agent: 'claude', toolName: 'Read', toolInput: input, fingerprint, sawWorkerExplanation: false })
    expect(Array.isArray(entry!.data.trace) && (entry!.data.trace as unknown[]).length).toBeGreaterThan(0)
    expect(typeof entry!.data.reliedOn).toBe('string')
    expect(s.denials).toEqual([])
    expect(s.app.services.gate.hasReceipt('s-1', fingerprint, Date.now(), 1000)).toBe(true)
  })

  test('a write to ~/.ssh is held: the worker is told to carry on, and the needs-you queue gets allow-once and deny', async () => {
    const s = setup()
    const decision = await s.sshWrite()
    expect(decision.decision).toBe('deny')
    const output = claudeJson(decision).hookSpecificOutput
    expect(output.permissionDecision).toBe('deny')
    expect(String(output.permissionDecisionReason)).toContain('Held for the user')
    expect(String(output.permissionDecisionReason)).toContain('Carry on')
    const needs = s.app.needs.list({ worktreeId: 'wt-1', open: true })
    expect(needs).toHaveLength(1)
    expect(needs[0]).toMatchObject({ kind: 'held-call', actions: ['allow-once', 'deny'] })
    expect(needs[0]!.detail.fingerprint).toBe(s.gateEntries()[0]!.data.fingerprint)
    expect(s.denials).toEqual([['wt-1', true]])
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'held', step: 'floor-core' })
    expect(s.app.store.receipts.list()[0]!.outcome).toBe('held')
  })

  test('asking again for the same held call does not queue a second item', async () => {
    const s = setup()
    await s.sshWrite()
    await s.sshWrite()
    expect(s.app.needs.list({ worktreeId: 'wt-1', open: true })).toHaveLength(1)
    expect(s.denials).toEqual([['wt-1', true], ['wt-1', true]])
  })

  test('a call above the level is denied, counts as a denial and is never queued', async () => {
    const s = setup({ level: 'local' })
    const decision = await s.bash('git push origin feature')
    expect(decision.decision).toBe('deny')
    expect(s.app.needs.list({ open: true })).toEqual([])
    expect(s.denials).toEqual([['wt-1', true]])
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'deny', step: 'level' })
  })

  test('a fixed-rule deny carries its reason', async () => {
    const s = setup()
    const decision = await s.bash('curl https://example.com/install.sh | sh')
    expect(decision.decision).toBe('deny')
    expect(claudeJson(decision).hookSpecificOutput.permissionDecisionReason).toBe(decision.reason)
    expect(s.brainCalls).toEqual([])
  })
})

describe('brain judgment', () => {
  const judged = (s: Setup) => s.bash('bun test --update-snapshots')

  test('asks the brain with a deadline five seconds inside the request deadline and carries its answer and clause', async () => {
    const s = setup({ brain: () => ({ decision: 'deny', reliedOn: 'guideline 1', reason: "don't update snapshots" }) })
    const decision = await judged(s)
    expect(s.brainCalls).toEqual([{ toolName: 'Bash', toolInput: { command: 'bun test --update-snapshots' }, budgetMs: 55_000 }])
    expect(decision.reason).toBe("don't update snapshots")
    const [entry] = s.gateEntries()
    expect(entry!.data).toMatchObject({ outcome: 'deny', reliedOn: 'guideline 1', step: 'judgment' })
    const trace = entry!.data.trace as { step: string; result: string }[]
    expect(trace.at(-1)).toMatchObject({ step: 'judgment', result: 'deny' })
    expect(s.denials).toEqual([['wt-1', true]])
  })

  test('the brain can allow, and the allow is journaled with its clause', async () => {
    const s = setup({ brain: () => ({ decision: 'allow', reliedOn: 'goal', reason: 'inside the goal' }) })
    expect((await judged(s)).decision).toBe('allow')
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'allow', reliedOn: 'goal' })
    expect(s.denials).toEqual([])
  })

  test('a brain hold queues the call for the user', async () => {
    const s = setup({ brain: () => ({ decision: 'held', reliedOn: 'goal', reason: 'not in the mandate' }) })
    const decision = await judged(s)
    expect(decision.decision).toBe('deny')
    expect(s.app.needs.list({ open: true })[0]).toMatchObject({ kind: 'held-call', actions: ['allow-once', 'deny'] })
  })

  test('no answer in time is a retry, not a denial that counts toward stuck detection', async () => {
    const s = setup({ brain: () => 'timeout' })
    const decision = await judged(s)
    expect(decision.decision).toBe('deny')
    expect(String(claudeJson(decision).hookSpecificOutput.permissionDecisionReason)).toContain('try the same call again')
    expect(s.denials).toEqual([['wt-1', false]])
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'retry', pending: true })
    expect(s.app.needs.list({ open: true })).toEqual([])
    expect(s.app.store.receipts.list()[0]!.outcome).toBe('retry')
  })

  test.each([['unavailable' as const], ['garbage' as never]])('a brain that answers %p is a retry and never an allow', async (answer) => {
    const s = setup({ brain: () => answer })
    const decision = await judged(s)
    expect(decision.decision).toBe('deny')
    expect(s.denials).toEqual([['wt-1', false]])
    expect(s.gateEntries()[0]!.data.outcome).toBe('retry')
  })

  test('a brain that throws is a retry', async () => {
    const s = setup({
      brain: () => {
        throw new Error('boom')
      }
    })
    const decision = await judged(s)
    expect(decision.decision).toBe('deny')
    expect(s.gateEntries()[0]!.data.outcome).toBe('retry')
  })

  test('a brain that never answers is cut off at its deadline', async () => {
    const s = setup({ brain: () => new Promise(() => {}) })
    const started = Date.now()
    const decision = await s.ask({ tool_name: 'Bash', tool_input: { command: 'bun test --update-snapshots' } }, { deadlineMs: 5_500 })
    expect(decision.decision).toBe('deny')
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'retry', pending: true })
  })

  test('the deadline passed down to the brain never drops under one second', async () => {
    const s = setup({ brain: () => ({ decision: 'allow', reliedOn: 'x', reason: 'x' }) })
    await s.ask({ tool_name: 'Bash', tool_input: { command: 'bun test --update-snapshots' } }, { deadlineMs: 2_000 })
    expect(s.brainCalls[0]!.budgetMs).toBe(1_000)
  })
})

describe('allow once (SC-14)', () => {
  const push = (s: Setup) => s.bash('git push --force-with-lease origin feature')

  test('approves exactly that call one time', async () => {
    const s = setup()
    expect((await push(s)).decision).toBe('deny')
    const need = s.app.needs.list({ open: true })[0]!
    s.app.services.gate.approveOnce(need.id)
    expect((await push(s)).decision).toBe('allow')
    const [approval] = s.app.store.approvals.list()
    expect(approval!.usedAt).not.toBeNull()
    const again = await push(s)
    expect(again.decision).toBe('deny')
    expect(s.gateEntries().map((entry) => entry.data.outcome)).toEqual(['held', 'allow', 'held'])
    expect(s.gateEntries()[1]!.data.reliedOn).toBe('allow-once approval')
  })

  test('does not cover a different command in the same worktree', async () => {
    const s = setup()
    await push(s)
    s.app.services.gate.approveOnce(s.app.needs.list({ open: true })[0]!.id)
    expect((await s.bash('git push --force-with-lease origin other')).decision).toBe('deny')
    expect(s.app.store.approvals.list()[0]!.usedAt).toBeNull()
  })

  test('approving twice does not make a second use', async () => {
    const s = setup()
    await push(s)
    const id = s.app.needs.list({ open: true })[0]!.id
    s.app.services.gate.approveOnce(id)
    s.app.services.gate.approveOnce(id)
    expect(s.app.store.approvals.list()).toHaveLength(1)
  })

  test('an unknown need, or one with no call attached, approves nothing', () => {
    const s = setup()
    s.app.services.gate.approveOnce('missing')
    const need = s.app.needs.add({ worktreeId: 'wt-1', kind: 'question', title: 'q', detail: {}, actions: ['answer'] })
    s.app.services.gate.approveOnce(need.id)
    expect(s.app.store.approvals.list()).toEqual([])
  })
})

describe('late answers (SC-12)', () => {
  const judged = (s: Setup) => s.bash('bun test --update-snapshots')
  const fingerprintOf = (command: string) => callFingerprint('claude', 'wt-1', 'Bash', { command })

  test('a remembered answer settles the retry at once, without asking the brain again', async () => {
    const s = setup({ brain: () => 'timeout' })
    expect((await judged(s)).decision).toBe('deny')
    expect(s.brainCalls).toHaveLength(1)
    s.app.store.lateAnswers.put({ fingerprint: fingerprintOf('bun test --update-snapshots'), worktreeId: 'wt-1', decision: 'allow', reason: 'fine after all', createdAt: 1, usedAt: null })
    const retry = await judged(s)
    expect(retry.decision).toBe('allow')
    expect(s.brainCalls).toHaveLength(1)
    expect(s.app.store.lateAnswers.get(fingerprintOf('bun test --update-snapshots'))!.usedAt).not.toBeNull()
    expect(s.gateEntries().at(-1)!.data).toMatchObject({ outcome: 'allow', reliedOn: "the brain's earlier answer to this call" })
  })

  test('a late deny is used the same way and carries its reason', async () => {
    const s = setup()
    s.app.store.lateAnswers.put({ fingerprint: fingerprintOf('bun test --update-snapshots'), worktreeId: 'wt-1', decision: 'deny', reason: 'snapshots stay as they are', createdAt: 1, usedAt: null })
    const decision = await judged(s)
    expect(decision.decision).toBe('deny')
    expect(decision.reason).toBe('snapshots stay as they are')
    expect(s.brainCalls).toEqual([])
  })

  test('is spent by the first retry', async () => {
    const s = setup({ brain: () => 'timeout' })
    s.app.store.lateAnswers.put({ fingerprint: fingerprintOf('bun test --update-snapshots'), worktreeId: 'wt-1', decision: 'allow', reason: 'ok', createdAt: 1, usedAt: null })
    await judged(s)
    await judged(s)
    expect(s.brainCalls).toHaveLength(1)
  })
})

describe('Shadow (SC-13)', () => {
  test('answers passthrough, journals what it would have done and queues nothing', async () => {
    const s = setup({ level: 'shadow' })
    const decision = await s.sshWrite()
    expect(decision).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    expect(s.app.needs.list({ open: true })).toEqual([])
    expect(s.denials).toEqual([])
    const [entry] = s.gateEntries()
    expect(entry!.data).toMatchObject({ outcome: 'passthrough', wouldHave: { outcome: 'held' }, fingerprint: expect.any(String), sawWorkerExplanation: false })
    expect((entry!.data.trace as unknown[]).length).toBeGreaterThan(0)
  })

  test('an allowed call journals a would-have allow', async () => {
    const s = setup({ level: 'shadow' })
    expect((await s.read()).decision).toBe('passthrough')
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'passthrough', wouldHave: { outcome: 'allow' } })
  })

  test('does not spend an approval', async () => {
    const s = setup({ level: 'shadow' })
    s.app.store.approvals.put({ id: 'n1', worktreeId: 'wt-1', fingerprint: callFingerprint('claude', 'wt-1', 'Bash', { command: 'ls' }), usedAt: null })
    await s.bash('ls')
    expect(s.app.store.approvals.get('n1')!.usedAt).toBeNull()
  })

  test('a judgment call is answered at once and the brain verdict is journaled when it arrives', async () => {
    let release: (reply: BrainReply) => void = () => {}
    const s = setup({ level: 'shadow', brain: () => new Promise<BrainReply>((resolve) => (release = resolve)) })
    const started = Date.now()
    const decision = await s.bash('bun test --update-snapshots')
    expect(decision.decision).toBe('passthrough')
    expect(Date.now() - started).toBeLessThan(500)
    expect(s.gateEntries()).toEqual([])
    expect(s.app.store.receipts.list()[0]!.outcome).toBe('passthrough')
    release({ decision: 'deny', reliedOn: 'guideline 1', reason: 'no' })
    const entry = await waitFor(() => s.gateEntries()[0])
    expect(entry.data).toMatchObject({ outcome: 'passthrough', wouldHave: { outcome: 'deny', reliedOn: 'guideline 1' } })
    expect(s.denials).toEqual([])
  })

  test('a brain failure in Shadow journals a would-have retry and never blocks', async () => {
    const s = setup({ level: 'shadow', brain: () => 'unavailable' })
    expect((await s.bash('bun test --update-snapshots')).decision).toBe('passthrough')
    const entry = await waitFor(() => s.gateEntries()[0])
    expect(entry.data).toMatchObject({ outcome: 'passthrough', wouldHave: { outcome: 'retry' } })
  })
})

describe('take-back with a request in flight', () => {
  test('resolves the waiting request as passthrough and ignores the brain when it finally answers', async () => {
    let release: (reply: BrainReply) => void = () => {}
    const s = setup({ brain: () => new Promise<BrainReply>((resolve) => (release = resolve)) })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)
    s.app.services.gate.resolveInFlight('wt-1', 'passthrough')
    const decision = await pending
    expect(decision).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    release({ decision: 'deny', reliedOn: 'x', reason: 'late' })
    await Bun.sleep(20)
    const entries = s.gateEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.data).toMatchObject({ outcome: 'passthrough', reliedOn: 'take-back' })
    expect(s.app.needs.list({ open: true })).toEqual([])
    expect(s.denials).toEqual([])
    expect(s.app.store.receipts.list()[0]!.outcome).toBe('passthrough')
  })

  test('leaves other worktrees alone', async () => {
    let release: (reply: BrainReply) => void = () => {}
    const s = setup({ brain: () => new Promise<BrainReply>((resolve) => (release = resolve)) })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)
    s.app.services.gate.resolveInFlight('wt-other', 'passthrough')
    release({ decision: 'allow', reliedOn: 'goal', reason: 'ok' })
    expect((await pending).decision).toBe('allow')
  })
})

describe('per-agent translation', () => {
  test('Codex PreToolUse allow is an empty object, and the allow is completed at PermissionRequest from the receipt', async () => {
    const s = setup({ agent: 'codex' })
    const pre = await s.read()
    expect(pre).toMatchObject({ decision: 'allow', encoded: '{}' })
    const input = { file_path: join(s.worktreePath, 'src/a.ts') }
    const permission = await s.ask({ tool_name: 'Read', tool_input: input }, { event: 'PermissionRequest' })
    expect(permission.decision).toBe('allow')
    expect(JSON.parse(permission.encoded!)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(s.gateEntries()).toHaveLength(1)
  })

  test('PermissionRequest after a refused PreToolUse is answered deny with a message', async () => {
    const s = setup({ agent: 'codex' })
    const input = { file_path: join(homedir(), '.ssh', 'config'), content: 'x' }
    expect((await s.ask({ tool_name: 'Write', tool_input: input })).decision).toBe('deny')
    const permission = await s.ask({ tool_name: 'Write', tool_input: input }, { event: 'PermissionRequest' })
    expect(permission.decision).toBe('deny')
    expect(JSON.parse(permission.encoded!).hookSpecificOutput.decision.behavior).toBe('deny')
    expect(s.app.needs.list({ open: true })).toHaveLength(1)
  })

  test('PermissionRequest with no earlier receipt goes through the full path', async () => {
    const s = setup()
    const decision = await s.ask({ tool_name: 'Read', tool_input: { file_path: join(s.worktreePath, 'a') } }, { event: 'PermissionRequest' })
    expect(decision.decision).toBe('allow')
    expect(JSON.parse(decision.encoded!).hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(s.gateEntries()).toHaveLength(1)
  })

  test.each(['pi', 'omp'])('%s tool_call: allow is empty and a hold blocks with the reason', async (agent) => {
    const s = setup({ agent })
    const piCall = (toolName: string, input: Record<string, unknown>) => s.ask({ tool_name: toolName, tool_input: input }, { event: 'tool_call' })
    const allowed = await piCall('read', { path: join(s.worktreePath, 'a.ts') })
    expect(allowed).toMatchObject({ decision: 'allow', encoded: '' })
    const held = await piCall('write', { path: join(homedir(), '.ssh', 'config'), content: 'x' })
    expect(held.decision).toBe('deny')
    expect(JSON.parse(held.encoded!)).toEqual({ block: true, reason: held.reason })
  })

  test('pi extension payload names (toolName and input) are understood', async () => {
    const s = setup({ agent: 'pi' })
    const decision = await s.provider(
      { agent: 'pi', sessionId: 's-1', event: 'tool_call', deadlineMs: 25_000, payload: { toolName: 'read', input: { path: join(s.worktreePath, 'a.ts') }, cwd: s.worktreePath } },
      new AbortController().signal
    )
    expect(decision.decision).toBe('allow')
  })

  test('a call carries the session cwd, and falls back to the worktree path', async () => {
    const s = setup()
    await s.provider({ agent: 'claude', sessionId: 's-1', event: 'PreToolUse', deadlineMs: 60_000, payload: { tool_name: 'Read', tool_input: { file_path: 'a.ts' } } }, new AbortController().signal)
    expect(s.gateEntries()[0]!.data.outcome).toBe('allow')
  })

  test('a failed worktree lookup is a retry, never an allow, even for a write outside the real worktree', async () => {
    const s = setup()
    s.fakeCalls['quirky.worktree/list'] = () => {
      throw new Error('worktree service down')
    }
    const outside = scratch()
    const decision = await s.ask({ tool_name: 'Write', tool_input: { file_path: join(outside, 'evil.ts'), content: 'x' } }, {})
    expect(decision.decision).toBe('deny')
    expect(String(claudeJson(decision).hookSpecificOutput.permissionDecisionReason)).toBe("Quirky's avatar gate couldn't confirm the worktree; try again shortly.")
    expect(s.denials).toEqual([['wt-1', false]])
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'retry' })
    expect(s.app.store.receipts.list()[0]!.outcome).toBe('retry')
    expect(s.brainCalls).toEqual([])
  })

  test('a worktree list that omits the call\'s worktree is a retry, even for a read', async () => {
    const s = setup()
    s.fakeCalls['quirky.worktree/list'] = () => [{ id: 'other', path: scratch(), branch: 'main', repoId: 'repo', isMain: true }]
    const decision = await s.ask({ tool_name: 'Read', tool_input: { file_path: join(s.worktreePath, 'a.ts') } })
    expect(decision.decision).toBe('deny')
    expect(s.denials).toEqual([['wt-1', false]])
    expect(s.gateEntries()[0]!.data).toMatchObject({ outcome: 'retry', reliedOn: 'an unconfirmed worktree' })
  })

  test('an edit outside every handed-off worktree is held', async () => {
    const s = setup()
    const decision = await s.ask({ tool_name: 'Edit', tool_input: { file_path: join(scratch(), 'elsewhere.ts'), old_string: 'a', new_string: 'b' } })
    expect(decision.decision).toBe('deny')
    expect(s.gateEntries()[0]!.data.outcome).toBe('held')
  })
})

describe('receipt fingerprints match the session record', () => {
  const recordedFingerprint = (line: object): string => {
    const [record] = parseProviderTranscriptLine('codex', JSON.stringify(line), new Map())
    if (record?.kind !== 'event') throw new Error('the rollout line did not parse to a tool event')
    const payload = record.payload as { tool_name: string; tool_input: unknown }
    return callFingerprint('codex', 'wt-1', payload.tool_name, payload.tool_input)
  }

  test('a Codex hook payload and the rollout function_call for the same call hash alike', async () => {
    const s = setup({ agent: 'codex' })
    await s.ask({ tool_name: 'shell_command', tool_input: { command: 'make', workdir: s.worktreePath } })
    const line = { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ workdir: s.worktreePath, command: 'make' }), call_id: 'c1' } }
    expect(s.app.services.gate.hasReceipt('s-1', recordedFingerprint(line), Date.now(), 5000)).toBe(true)
  })

  test('a hook input delivered as a JSON string is compared as the parsed value the record shows', async () => {
    const s = setup({ agent: 'codex' })
    await s.ask({ tool_name: 'shell_command', tool_input: '{"command":"make"}' })
    const line = { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"make"}', call_id: 'c2' } }
    expect(s.app.services.gate.hasReceipt('s-1', recordedFingerprint(line), Date.now(), 5000)).toBe(true)
  })
})

describe('gate check', () => {
  test('is idempotent while a check is in progress', async () => {
    const s = setup()
    s.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'checking', sessionId: 's-1', active: true, handedOffAt: s.app.now(), takenBackAt: null })
    s.fakeCalls['quirky.session/get'] = () => ({ agent: 'claude', launch: { args: [] } })
    const first = s.app.services.gate.gateCheck('wt-1')
    const second = s.app.services.gate.gateCheck('wt-1')
    expect(second).toBe(first)
    expect((await first).ok).toBe(false)
    expect(s.calls.filter((call) => call.method === 'quirky.session/get')).toHaveLength(1)
  })
})

describe('markers and the gate service surface', () => {
  test('writeMarker and removeMarker manage the 0600 marker file under the Quirky home', () => {
    const s = setup()
    s.app.services.gate.writeMarker('s-9', 'wt-1', 'full')
    const path = join(markerDir(s.context.home), 's-9')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ worktreeId: 'wt-1', level: 'full' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    s.app.services.gate.removeMarker('s-9')
    expect(existsSync(path)).toBe(false)
    expect(hasMarkerFile(s.context.home, 's-1')).toBe(true)
  })

  test('hasReceipt matches by session, fingerprint and time window', async () => {
    const s = setup()
    await s.read()
    const fingerprint = callFingerprint('claude', 'wt-1', 'Read', { file_path: join(s.worktreePath, 'src/a.ts') })
    const at = s.app.store.receipts.list()[0]!.at
    const gate = s.app.services.gate
    expect(gate.hasReceipt('s-1', fingerprint, at + 500, 1000)).toBe(true)
    expect(gate.hasReceipt('s-1', fingerprint, at + 5000, 1000)).toBe(false)
    expect(gate.hasReceipt('s-2', fingerprint, at, 1000)).toBe(false)
    expect(gate.hasReceipt('s-1', 'other', at, 1000)).toBe(false)
  })

  test('decideCall decides a call directly and passes through a worktree that is not handed off', async () => {
    const s = setup()
    const call = { agent: 'claude' as const, sessionId: 's-1', worktreeId: 'wt-1', cwd: s.worktreePath, toolName: 'Read', toolInput: { file_path: join(s.worktreePath, 'a') }, event: 'PreToolUse' as const }
    expect((await s.app.services.gate.decideCall(call, 60_000, new AbortController().signal)).outcome).toBe('allow')
    expect((await s.app.services.gate.decideCall({ ...call, worktreeId: 'nope' }, 60_000, new AbortController().signal)).outcome).toBe('passthrough')
  })
})

describe('activation and deactivation', () => {
  test('provides the tool gate and the launch hook', () => {
    const s = setup()
    expect(typeof s.provided.get('tool-gate:quirky.avatar/gate')).toBe('function')
    expect(typeof s.provided.get('launch-hook:quirky.avatar/gate-hooks')).toBe('function')
  })

  test('activation installs hooks for present agents and leaves them on disposal', async () => {
    const home = scratch()
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    const t = makeTestApp({ fakeCalls: { 'quirky.agents/list': () => agentListing('codex', 'pi') } })
    dirs.push(t.context.home)
    const agentEnv = { home, env: {} }
    const dispose = register(t.app, { agentEnv })
    disposers.push(dispose)

    await waitFor(() => codexHooksInstalled(agentEnv) && existsSync(piExtensionPath('pi', agentEnv)))
    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(1)
    disposers.pop()!()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
    expect(existsSync(piExtensionPath('pi', agentEnv))).toBe(true)
  })

  test('activation leaves the agent home empty when no agents are present', async () => {
    const home = scratch()
    const t = makeTestApp({ fakeCalls: { 'quirky.agents/list': () => agentListing() } })
    dirs.push(t.context.home)
    const dispose = register(t.app, { agentEnv: { home, env: {} } })
    disposers.push(dispose)

    await waitFor(() => t.calls.some((call) => call.method === 'quirky.agents/list'))
    // A real delay is needed to catch writes from fire-and-forget activation sync.
    await Bun.sleep(50)

    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(1)
    expect(readdirSync(home)).toEqual([])
  })

  test('passes the launch home and session identity without QUIRKY environment variables', async () => {
    const s = setup()
    dirs.push(s.context.home)
    const launchHook = s.provided.get('launch-hook:quirky.avatar/gate-hooks') as LaunchHook
    const patch = await launchHook({
      sessionId: 's-9',
      worktreeId: 'wt-1',
      repoId: 'repo',
      cwd: s.worktreePath,
      agent: 'claude',
      env: {},
      args: [],
      jsonArgs: {}
    } as never) as {
      jsonArgs: { '--settings': { hooks: Record<string, { hooks: { command: string }[] }[]> } }
    }
    const command = patch.jsonArgs['--settings'].hooks.PreToolUse![0]!.hooks[0]!.command
    mkdirSync(join(s.context.home, 'bin'), { recursive: true })
    writeMarkerFile(s.context.home, 's-9', { worktreeId: 'wt-1', level: 'own-branch' })
    writeFileSync(join(s.context.home, 'bin', 'quirky-gate'), '#!/bin/sh\nprintf "%s|%s\\n" "$QUIRKY_HOME" "$QUIRKY_SESSION_ID"\n', { mode: 0o755 })

    const result = Bun.spawnSync(['sh', '-c', command], {
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe'
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`${s.context.home}|s-9\n`)
  })

  test('gate checks reinstall Codex hooks during prepare', async () => {
    const s = setup({ agent: 'codex', agentList: agentListing('codex') })
    dirs.push(s.context.home)
    await waitFor(() => codexHooksInstalled(s.agentEnv))
    rmSync(codexHooksPath(s.agentEnv))
    s.fakeCalls['quirky.session/get'] = () => ({ agent: 'codex' })
    s.app.store.receipts.put({
      id: 'gate-check-prepare',
      fingerprint: 'fp-1',
      sessionId: 's-1',
      toolName: 'Read',
      at: s.app.now(),
      outcome: 'allow',
      step: 'fixed-rules'
    })

    expect(await s.app.services.gate.gateCheck('wt-1')).toEqual({ ok: true, reason: '' })
    await waitFor(() => codexHooksInstalled(s.agentEnv))
  })


  test.each(['setting:quirky.avatar/agent-hooks', 'setting:quirky.avatar/judgment-timeout-seconds'])(
    'after the disposer, a change to %s neither lists agents nor writes agent files',
    async (id) => {
      const s = setup({ agent: 'codex', agentList: agentListing('codex') })
      dirs.push(s.context.home)
      await waitFor(() => codexHooksInstalled(s.agentEnv))
      expect(s.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(1)

      disposers.pop()!()
      rmSync(codexHooksPath(s.agentEnv))
      await s.deliver({
        type: 'setting.changed',
        id,
        value: id === 'setting:quirky.avatar/agent-hooks' ? true : 30
      })

      expect(s.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(1)
      expect(existsSync(codexHooksPath(s.agentEnv))).toBe(false)
    }
  )

  test('the disposer keeps every supervision marker', () => {
    const s = setup()
    s.app.services.gate.writeMarker('s-2', 'wt-1', 'full')
    const paths = ['s-1', 's-2'].map((sessionId) => join(markerDir(s.context.home), sessionId))
    const before = paths.map((path) => readFileSync(path, 'utf8'))
    expect(before.map((text) => JSON.parse(text))).toEqual([
      { worktreeId: 'wt-1', level: 'own-branch' },
      { worktreeId: 'wt-1', level: 'full' }
    ])

    disposers.pop()!()

    expect(paths.every(existsSync)).toBe(true)
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('the disposer refuses a waiting request with a retry reason', async () => {
    const s = setup({ brain: () => Promise.withResolvers<BrainReply>().promise })

    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)

    disposers.pop()!()

    const decision = await pending
    expect(decision).toMatchObject({ decision: 'deny', reason: STOPPING })
    expect(decision.encoded).toBe(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: STOPPING
      }
    }))
    expect(s.app.store.receipts.list({ sessionId: 's-1' }).at(-1)).toMatchObject({ outcome: 'retry', step: null })
    expect(s.gateEntries().at(-1)!.data).toMatchObject({
      outcome: 'retry',
      reason: STOPPING,
      reliedOn: 'the avatar stopping',
      trace: [],
      step: null
    })
    expect(s.denials).toEqual([])
    expect(s.app.needs.list({ open: true })).toEqual([])
  })

  test('a late brain answer after stopping writes nothing', async () => {
    const brain = Promise.withResolvers<BrainReply>()
    const s = setup({ brain: () => brain.promise })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)

    disposers.pop()!()

    expect(await pending).toMatchObject({ decision: 'deny', reason: STOPPING })
    const entries = s.gateEntries()
    brain.resolve({ decision: 'allow', reliedOn: 'guideline 1', reason: 'late answer' })
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise

    expect(s.gateEntries()).toEqual(entries)
    expect(s.app.store.receipts.list({ sessionId: 's-1' }).at(-1)).toMatchObject({ outcome: 'retry' })
  })

  test('a Shadow provider call stays passthrough when its held worktree lookup returns after stopping', async () => {
    const s = setup({ level: 'shadow' })
    const worktreeList = Promise.withResolvers<unknown>()
    let lookups = 0
    s.fakeCalls['quirky.worktree/list'] = () => {
      lookups += 1
      if (lookups === 1) throw new Error('lookup failed')
      return worktreeList.promise
    }
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => lookups === 2)
    let settled = false
    void pending.then(() => { settled = true })

    disposers.pop()!()
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise
    const settledOnStop = settled
    worktreeList.resolve([{ id: 'wt-1', path: s.worktreePath, branch: 'feature', repoId: 'repo', isMain: false }])

    const decision = await pending
    expect(settledOnStop).toBe(true)
    expect(decision).toMatchObject({ decision: 'passthrough', reason: SHADOW, encoded: '{}' })
    expect(lookups).toBe(2)
  })

  test('a Shadow service call blocked during classification settles passthrough on stop', async () => {
    const s = setup({ level: 'shadow' })
    const worktreeList = Promise.withResolvers<unknown>()
    const lookupStarted = Promise.withResolvers<void>()
    s.fakeCalls['quirky.worktree/list'] = () => {
      lookupStarted.resolve()
      return worktreeList.promise
    }
    const pending = s.app.services.gate.decideCall({
      agent: 'claude',
      sessionId: 's-1',
      worktreeId: 'wt-1',
      cwd: s.worktreePath,
      toolName: 'Bash',
      toolInput: { command: 'bun test --update-snapshots' },
      event: 'PreToolUse'
    }, 60_000, new AbortController().signal)
    await lookupStarted.promise
    let settled = false
    void pending.then(() => { settled = true })

    disposers.pop()!()
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise
    const settledOnStop = settled
    worktreeList.resolve([{ id: 'wt-1', path: s.worktreePath, branch: 'feature', repoId: 'repo', isMain: false }])

    const result = await pending
    const afterLookup = Promise.withResolvers<void>()
    setImmediate(afterLookup.resolve)
    await afterLookup.promise

    expect(settledOnStop).toBe(true)
    expect(result.outcome).toBe('passthrough')
    expect(result.reason).toBe(SHADOW)
    expect(s.gateEntries()).toEqual([])
    expect(s.app.store.receipts.list({ sessionId: 's-1' }).at(-1)).toMatchObject({ outcome: 'passthrough', step: null })
  })

  test('a request taken back in the same tick as the stop stays passed through', async () => {
    const s = setup({ brain: () => Promise.withResolvers<BrainReply>().promise })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)

    s.app.services.gate.resolveInFlight('wt-1', 'passthrough')
    disposers.pop()!()

    expect(await pending).toMatchObject({ decision: 'passthrough', reason: HANDED_BACK })
    expect(s.app.store.receipts.list({ sessionId: 's-1' }).at(-1)).toMatchObject({ outcome: 'passthrough', step: null })
    expect(s.gateEntries().map((entry) => [entry.data.outcome, entry.data.reliedOn])).toEqual([['passthrough', 'take-back']])
  })

  test('a take-back in the same tick after the stop leaves the refusal as it was', async () => {
    const s = setup({ brain: () => Promise.withResolvers<BrainReply>().promise })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)

    disposers.pop()!()
    s.app.services.gate.resolveInFlight('wt-1', 'passthrough')

    expect(await pending).toMatchObject({ decision: 'deny', reason: STOPPING })
    expect(s.app.store.receipts.list({ sessionId: 's-1' }).at(-1)).toMatchObject({ outcome: 'retry', step: null })
    expect(s.gateEntries().map((entry) => [entry.data.outcome, entry.data.reliedOn])).toEqual([['retry', 'the avatar stopping']])
  })

  test('a journal failure does not stop the disposer refusing a waiting request', async () => {
    const s = setup({ brain: () => Promise.withResolvers<BrainReply>().promise })
    const pending = s.bash('bun test --update-snapshots')
    await waitFor(() => s.brainCalls.length > 0)
    s.app.journal = () => { throw new Error('journal write failed') }

    const dispose = disposers.pop()!
    expect(dispose).not.toThrow()
    expect(await pending).toMatchObject({ decision: 'deny', reason: STOPPING })
  })

  test('does not touch the real home or overridden agent directories while tests run', async () => {
    const codexHome = scratch()
    const piHome = scratch()
    const t = makeTestApp({ fakeCalls: { 'quirky.agents/list': () => agentListing('codex', 'pi') } })
    dirs.push(t.context.home)
    const dispose = register(t.app, {
      agentEnv: {
        home: homedir(),
        env: { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piHome }
      }
    })
    disposers.push(dispose)
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise

    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
    expect(readdirSync(codexHome)).toEqual([])
    expect(readdirSync(piHome)).toEqual([])
  })
})
