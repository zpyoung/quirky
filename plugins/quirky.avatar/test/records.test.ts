import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AvatarApp, ClassifyContext, Level, RecordCursor, WorktreeState } from '../src/contracts'
import type { AgentEnv } from '../src/hooks/install'
import { callFingerprint } from '../src/fingerprint'
import { createRecords } from '../src/supervisor/records'
import { createEvidence } from '../src/supervisor/stuck'
import { makeTestApp, sampleMandate } from './support'

let dir = ''
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'avatar-records-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.parse('2026-11-04T10:00:00Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

const claudeCall = (name: string, input: unknown, at = 1_000) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: `tu-${at}`, name, input }] } }) + '\n'

type Options = { agent?: string; level?: Level; state?: WorktreeState; graceMs?: number; sessionCreatedAt?: number | null; agentEnv?: AgentEnv }

function setup({ agent = 'claude', level = 'own-branch', state = 'working', graceMs = 0, sessionCreatedAt = T0, agentEnv }: Options = {}) {
  const t = makeTestApp()
  const worktree = join(dir, 'wt')
  mkdirSync(worktree, { recursive: true })
  const userHome = join(dir, 'agent-home')
  mkdirSync(userHome, { recursive: true })
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, '')
  t.app.now = () => T0 + 10 * 60_000
  const mandate = sampleMandate({ level })
  t.app.store.mandates.put(mandate)
  t.app.store.handoffs.put({ worktreeId: 'wt-1', state, sessionId: 's-1', active: true, handedOffAt: T0, takenBackAt: null })
  const current = { state }
  t.app.services.handoff.active = () => [{ worktreeId: 'wt-1', sessionId: 's-1', state: current.state, mandate }]
  t.app.services.handoff.setState = (_worktreeId, next) => void (current.state = next)
  const settings = t.app.settings()
  const context: ClassifyContext = {
    worktreePath: worktree, handedOffPaths: [worktree], defaultBranch: 'main', ownBranch: 'avatar/wt-1',
    home: userHome, allowCommands: settings.allowCommands, denyCommands: settings.denyCommands, deployCommands: settings.deployCommands
  }
  let gateContext: ClassifyContext | null = context
  const contextCalls: string[] = []

  const observed: { sessionId: string; fingerprint: string; at: number }[] = []
  const receipts = new Set<string>()
  t.app.services.gate = {
    ...t.app.services.gate,
    classifyContext: async (worktreeId) => {
      contextCalls.push(worktreeId)
      return gateContext
    },
    noteObservedCall: (sessionId, fingerprint, at) => void observed.push({ sessionId, fingerprint, at }),
    hasReceipt: (_sessionId, fingerprint) => receipts.has(fingerprint),
    gateCheck: async () => ({ ok: true, reason: '' })
  }
  const steps: { worktreeId: string; text: string }[] = []
  t.app.services.supervisor = {
    ...t.app.services.supervisor,
    stepIn: async (worktreeId, text) => {
      steps.push({ worktreeId, text })
      return { sent: true }
    }
  }
  let wakes = 0
  t.app.services.brain = { ...t.app.services.brain, wake: () => void wakes++ }

  t.fakeCalls['quirky.session/get'] = () => ({ id: 's-1', agent, cwd: worktree, createdAt: sessionCreatedAt, providerSession: { id: 'p-1', transcriptPath: transcript } })

  let evidence = createEvidence()
  const watched: { dir: string; fire: (filename: string | null) => void; stopped: boolean }[] = []
  const start = () => createRecords(t.app, {
    evidence,
    graceMs,
    debounceMs: 0,
    agentEnv: agentEnv ?? { home: userHome, env: {} },
    watch: (watchDir, fire) => {
      const entry = { dir: watchDir, fire, stopped: false }
      watched.push(entry)
      return () => void (entry.stopped = true)
    }
  })
  let records = start()
  const fingerprint = (name: string, input: unknown) => callFingerprint(agent, 'wt-1', name, input)
  const skipped = () => t.app.store.journalSince(0).filter((entry) => entry.kind === 'skipped-call')
  return {
    ...t,
    worktree,
    userHome,
    contextCalls,
    get gateContext() { return gateContext },
    set gateContext(value: ClassifyContext | null) { gateContext = value },
    transcript,
    observed,
    receipts,
    steps,
    get evidence() { return evidence },
    get records() { return records },
    restart() {
      records.dispose()
      evidence = createEvidence()
      records = start()
    },
    watched,
    fingerprint,
    skipped,
    wakes: () => wakes,
    append: (text: string) => appendFileSync(transcript, text),
    current
  }
}

describe('tailing the session record', () => {
  test('reports every Claude tool call to the gate with its fingerprint and time', async () => {
    const t = setup()
    t.append(claudeCall('Read', { file_path: 'a.ts' }, 1_000))
    await t.records.check()
    expect(t.observed).toEqual([{ sessionId: 's-1', fingerprint: t.fingerprint('Read', { file_path: 'a.ts' }), at: T0 + 1_000 }])
  })

  test('reads only new lines on the next pass and waits for a line to be finished', async () => {
    const t = setup()
    t.append(claudeCall('Read', { file_path: 'a.ts' }, 1_000))
    await t.records.check()
    await t.records.check()
    expect(t.observed).toHaveLength(1)

    const next = claudeCall('Read', { file_path: 'b.ts' }, 2_000)
    t.append(next.slice(0, 40))
    await t.records.check()
    expect(t.observed).toHaveLength(1)
    t.append(next.slice(40))
    await t.records.check()
    expect(t.observed).toHaveLength(2)
  })

  test('calls from before the hand-off are not the avatar business', async () => {
    const t = setup()
    t.append(claudeCall('Bash', { command: 'git push origin main' }, -5_000))
    await t.records.check()
    expect(t.observed).toEqual([])
  })

  test('reads Codex function calls and gives their tool name as the transcript has it', async () => {
    const t = setup({ agent: 'codex' })
    t.append(JSON.stringify({ timestamp: iso(1_000), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' } }) + '\n')
    await t.records.check()
    expect(t.observed.map((call) => call.fingerprint)).toEqual([t.fingerprint('shell', { command: ['ls'] })])
  })

  test('reads pi and omp toolCall entries', async () => {
    for (const agent of ['pi', 'omp']) {
      const t = setup({ agent })
      t.append(JSON.stringify({ type: 'message', timestamp: iso(1_000), message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] } }) + '\n')
      await t.records.check()
      expect(t.observed.map((call) => call.fingerprint)).toEqual([t.fingerprint('bash', { command: 'ls' })])
    }
  })

  test('feeds the stuck evidence with calls and activity', async () => {
    const t = setup()
    t.append(claudeCall('Read', { file_path: 'a.ts' }, 1_000))
    await t.records.check()
    expect(t.evidence.calls('wt-1')).toMatchObject([{ toolName: 'Read', at: T0 + 1_000 }])
    expect(t.evidence.lastActivity('wt-1')).toBe(T0 + 1_000)
  })

  test('notes edit states so an edit and its undo show up as a revert', async () => {
    const t = setup()
    t.append(claudeCall('Edit', { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' }, 1_000))
    t.append(claudeCall('Edit', { file_path: 'a.ts', old_string: 'bar', new_string: 'foo' }, 2_000))
    await t.records.check()
    const hashes = t.evidence.edits('wt-1').map((edit) => edit.contentHash)
    expect(hashes).toHaveLength(3)
    expect(hashes[0]).toBe(hashes[2])
  })

  test('hashes the file on disk after a Write', async () => {
    const t = setup()
    writeFileSync(join(t.worktree, 'w.ts'), 'one')
    t.append(claudeCall('Write', { file_path: 'w.ts', content: 'one' }, 1_000))
    await t.records.check()
    expect(t.evidence.edits('wt-1')).toMatchObject([{ path: 'w.ts' }])
  })
})

describe('matching receipts', () => {
  test('a call with a receipt is not skipped', async () => {
    const t = setup()
    const input = { command: 'git push origin main' }
    t.receipts.add(t.fingerprint('Bash', input))
    t.append(claudeCall('Bash', input))
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
  })

  test('a skipped call the fixed rules would allow is only logged', async () => {
    const t = setup()
    t.append(claudeCall('Read', { file_path: 'a.ts' }))
    await t.records.check()
    expect(t.steps).toEqual([])
    expect(t.skipped()).toMatchObject([
      { worktreeId: 'wt-1', data: { wouldHaveStopped: false, outcome: 'allow', toolName: 'Read', toolInput: { file_path: 'a.ts' }, fingerprint: t.fingerprint('Read', { file_path: 'a.ts' }) } }
    ])
    expect(t.skipped()[0].data.top).toBeUndefined()
  })

  test('a skipped push to main steps the worker in and heads the report', async () => {
    const t = setup()
    t.append(claudeCall('Bash', { command: 'git push origin main' }))
    await t.records.check()
    expect(t.steps).toHaveLength(1)
    expect(t.steps[0].worktreeId).toBe('wt-1')
    expect(t.steps[0].text).toContain('git push origin main')
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true, top: true, toolName: 'Bash', toolInput: { command: 'git push origin main' }, trace: expect.any(Array) } }])
    expect(['deny', 'held']).toContain(t.skipped()[0].data.outcome as string)
  })

  test('both calls of the SC-33 walkthrough: tests are logged, the push interrupts', async () => {
    const t = setup()
    t.append(claudeCall('Bash', { command: 'bun test' }, 1_000))
    t.append(claudeCall('Bash', { command: 'git push origin main' }, 2_000))
    await t.records.check()
    expect(t.skipped().map((entry) => entry.data.wouldHaveStopped)).toEqual([false, true])
    expect(t.steps).toHaveLength(1)
  })

  test('a refused step-in is journaled so it is not lost', async () => {
    const t = setup()
    t.app.services.supervisor.stepIn = async () => ({ sent: false, reason: 'user-typing' })
    t.append(claudeCall('Bash', { command: 'git push origin main' }))
    await t.records.check()
    expect(t.app.store.journalSince(0).some((entry) => entry.data.type === 'step-in-refused' && entry.data.reason === 'user-typing')).toBe(true)
  })

  test('a call still inside the grace period waits for its receipt instead of being judged', async () => {
    const t = setup({ graceMs: 5 * 60_000 })
    const input = { command: 'git push origin main' }
    t.append(claudeCall('Bash', input, 9 * 60_000 + 30_000))
    await t.records.check()
    expect(t.skipped()).toEqual([])

    t.receipts.add(t.fingerprint('Bash', input))
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
  })

  test('a call whose grace ran out without a receipt is judged on the next pass', async () => {
    const t = setup({ graceMs: 5 * 60_000 })
    t.append(claudeCall('Bash', { command: 'git push origin main' }, 9 * 60_000))
    await t.records.check()
    expect(t.steps).toEqual([])
    t.app.now = () => T0 + 15 * 60_000
    await t.records.check()
    expect(t.steps).toHaveLength(1)
  })

  test('the receipt window around the call is ±60 s', async () => {
    const t = setup()
    const windows: [number, number][] = []
    t.app.services.gate.hasReceipt = (_sessionId, _fingerprint, around, window) => {
      windows.push([around, window])
      return true
    }
    t.append(claudeCall('Read', { file_path: 'a.ts' }, 1_000))
    await t.records.check()
    expect(windows).toEqual([[T0 + 1_000, 60_000]])
  })
})

describe('Codex hosted tools', () => {
  const hosted = (type: string, extra: Record<string, unknown>, at = 1_000) =>
    JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type, status: 'completed', ...extra } }) + '\n'

  test('logs every use and wakes the brain without matching a receipt', async () => {
    const t = setup({ agent: 'codex' })
    t.append(hosted('web_search_call', { action: { type: 'search', query: 'bun sqlite' } }, 1_000))
    t.append(hosted('image_generation_call', { revised_prompt: 'a cat' }, 2_000))
    await t.records.check()
    expect(t.skipped()).toMatchObject([
      { data: { hosted: true, wouldHaveStopped: false, toolName: 'web_search', toolInput: { type: 'search', query: 'bun sqlite' } } },
      { data: { hosted: true, toolName: 'image_generation' } }
    ])
    expect(t.wakes()).toBe(2)
    expect(t.observed).toEqual([])
    expect(t.steps).toEqual([])
  })

  test('only Codex has hosted tools', async () => {
    const t = setup({ agent: 'claude' })
    t.append(hosted('web_search_call', {}))
    await t.records.check()
    expect(t.skipped()).toEqual([])
  })
})

describe('hook-config watch', () => {
  const claudeDir = (t: ReturnType<typeof setup>) => join(t.worktree, '.claude')

  test('watches the user-home defaults for Codex, pi, and omp', async () => {
    const home = join(dir, 'agent-home')
    const worktree = join(dir, 'wt')
    const cases = [
      ['codex', join(home, '.codex'), join(worktree, '.codex')],
      ['pi', join(home, '.pi', 'agent', 'extensions'), join(worktree, '.pi', 'extensions')],
      ['omp', join(home, '.omp', 'agent', 'extensions'), join(worktree, '.omp', 'extensions')]
    ] as const
    for (const [agent, ...paths] of cases) {
      for (const path of paths) mkdirSync(path, { recursive: true })
      const t = setup({ agent, agentEnv: { home, env: {} } })
      await t.records.check()
      expect(t.watched.map((entry) => entry.dir)).toEqual(paths)
      expect(t.watched.some((entry) => entry.dir.startsWith(t.context.home))).toBe(false)
      t.records.dispose()
    }
  })

  test('watches absolute Codex and shared pi/omp overrides', async () => {
    const home = join(dir, 'agent-home')
    const codexHome = join(dir, 'codex-home')
    const agentDir = join(dir, 'agent-dir')
    const worktree = join(dir, 'wt')
    const env = { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: agentDir }
    const cases = [
      ['codex', [codexHome, join(worktree, '.codex')]],
      ['pi', [join(agentDir, 'extensions'), join(worktree, '.pi', 'extensions')]],
      ['omp', [join(agentDir, 'extensions'), join(worktree, '.omp', 'extensions')]]
    ] as const
    for (const [agent, paths] of cases) {
      for (const path of paths) mkdirSync(path, { recursive: true })
      const t = setup({ agent, agentEnv: { home, env } })
      await t.records.check()
      expect(t.watched.map((entry) => entry.dir)).toEqual([...paths])
      expect(t.watched.some((entry) => entry.dir.startsWith(t.context.home))).toBe(false)
      t.records.dispose()
    }
  })

  test('ignores a relative Codex home override', async () => {
    const home = join(dir, 'agent-home')
    const worktree = join(dir, 'wt')
    const paths = [join(home, '.codex'), join(worktree, '.codex')]
    for (const path of paths) mkdirSync(path, { recursive: true })
    const t = setup({ agent: 'codex', agentEnv: { home, env: { CODEX_HOME: 'relative/path' } } })
    await t.records.check()
    expect(t.watched.map((entry) => entry.dir)).toEqual(paths)
    t.records.dispose()
  })

  test('a changed settings file re-runs the gate check; a passing check leaves the worker alone', async () => {
    const t = setup()
    mkdirSync(claudeDir(t))
    let checks = 0
    t.app.services.gate.gateCheck = async () => (checks++, { ok: true, reason: '' })
    await t.records.check()
    t.watched[0].fire('settings.local.json')
    await Bun.sleep(20)
    expect(checks).toBe(1)
    expect(t.steps).toEqual([])
    expect(t.current.state).toBe('working')
  })

  test('other files in the watched directory are ignored', async () => {
    const t = setup()
    mkdirSync(claudeDir(t))
    let checks = 0
    t.app.services.gate.gateCheck = async () => (checks++, { ok: true, reason: '' })
    await t.records.check()
    t.watched[0].fire('notes.md')
    await Bun.sleep(20)
    expect(checks).toBe(0)
  })

  test('a failing check steps the worker in, moves it to gate-failed and asks for a restart', async () => {
    const t = setup()
    t.app.services.gate.gateCheck = async () => ({ ok: false, reason: 'tool calls are not reaching the gate' })
    await t.records.configChanged('wt-1')
    expect(t.current.state).toBe('gate-failed')
    expect(t.steps).toHaveLength(1)
    expect(t.steps[0].text).toContain('tool calls are not reaching the gate')
    expect(t.app.needs.list({ worktreeId: 'wt-1', open: true })).toMatchObject([{ kind: 'gate-failed', actions: ['restart-to-handoff', 'take-back'] }])
  })

  test('a failure the gate service already recorded is not recorded twice', async () => {
    const t = setup()
    t.app.needs.add({ worktreeId: 'wt-1', kind: 'gate-failed', title: 'x', detail: {}, actions: ['restart-to-handoff'] })
    t.app.services.gate.gateCheck = async () => ({ ok: false, reason: 'no' })
    await t.records.configChanged('wt-1')
    expect(t.app.needs.list({ worktreeId: 'wt-1', open: true })).toHaveLength(1)
  })

  test('a config directory that appears after the first pass counts as a change', async () => {
    const t = setup()
    let checks = 0
    t.app.services.gate.gateCheck = async () => (checks++, { ok: true, reason: '' })
    await t.records.check()
    expect(t.watched).toEqual([])
    mkdirSync(claudeDir(t))
    await t.records.check()
    await Bun.sleep(20)
    expect(t.watched).toHaveLength(1)
    expect(checks).toBe(1)
  })

  test('watchers stop when the worktree is taken back', async () => {
    const t = setup()
    mkdirSync(claudeDir(t))
    await t.records.check()
    t.app.services.handoff.active = () => []
    await t.records.check()
    expect(t.watched[0].stopped).toBe(true)
  })
  test('a config change after disposal runs no gate check', async () => {
    const t = setup()
    let checks = 0
    t.app.services.gate.gateCheck = async () => (checks++, { ok: false, reason: 'no' })
    t.records.dispose()
    await t.records.configChanged('wt-1')
    expect(checks).toBe(0)
    expect(t.steps).toEqual([])
    expect(t.current.state).toBe('working')
    expect(t.app.needs.list({ worktreeId: 'wt-1', open: true })).toEqual([])
  })

  test('a gate check that fails after disposal changes nothing', async () => {
    const t = setup()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<{ ok: boolean; reason: string }>()
    t.app.services.gate.gateCheck = () => {
      entered.resolve()
      return held.promise
    }
    const run = t.records.configChanged('wt-1')
    await entered.promise
    t.records.dispose()
    held.resolve({ ok: false, reason: 'no' })
    await run
    expect(t.steps).toEqual([])
    expect(t.current.state).toBe('working')
    expect(t.app.needs.list({ worktreeId: 'wt-1', open: true })).toEqual([])
  })
})

type RecordFixture = {
  app: AvatarApp
  worktree: string
  transcript: string
  receipts: Set<string>
  fingerprint(name: string, input: unknown): string
  append(text: string): void
}
const PUSH = { command: 'git push origin main' }
const READ = { file_path: 'a.ts' }
const waitingCall = (t: RecordFixture, input = PUSH, at = T0 + 540_000) => ({
  agent: 'claude', cwd: t.worktree, toolName: 'Bash', toolInput: input, at, fingerprint: t.fingerprint('Bash', input)
})
const seedCursor = (t: RecordFixture, overrides: Partial<RecordCursor> = {}) => t.app.store.recordCursors.put({
  sessionId: 's-1', worktreeId: 'wt-1', path: t.transcript, readOffset: 0, pending: [], updatedAt: T0, ...overrides
})
const appendReceiptedRead = (t: RecordFixture, input = READ, at = 1_000) => {
  t.receipts.add(t.fingerprint('Read', input))
  t.append(claudeCall('Read', input, at))
}

describe('durable record positions', () => {
  test('the first pass stores the finished byte position', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toEqual({
      sessionId: 's-1', worktreeId: 'wt-1', path: t.transcript, readOffset: statSync(t.transcript).size, pending: [], updatedAt: T0 + 600_000
    })
  })

  test('the stored position stops at the last finished line', async () => {
    const t = setup()
    appendReceiptedRead(t)
    t.append(claudeCall('Read', { file_path: 'b.ts' }, 2_000).slice(0, 40))
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')?.readOffset).toBe(Buffer.byteLength(claudeCall('Read', READ)))
  })

  test('the stored position counts bytes rather than characters', async () => {
    const t = setup()
    appendReceiptedRead(t, { file_path: 'é.ts' })
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')?.readOffset).toBe(215)
  })

  test('a quiet pass leaves the saved timestamp unchanged', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    t.app.now = () => T0 + 660_000
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')?.updatedAt).toBe(T0 + 600_000)
  })

  test('a session with no transcript has no cursor row', async () => {
    const t = setup()
    const logs: string[] = []
    t.context.log = (line) => void logs.push(line)
    t.fakeCalls['quirky.session/get'] = () => ({ agent: 'claude', cwd: t.worktree })
    await t.records.check()
    expect(t.app.store.recordCursors.list()).toEqual([])
    expect(logs).toEqual([])
  })

  test('a stopped skipped call is not observed or judged twice after restart', async () => {
    const t = setup()
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true } }])
    expect(t.steps).toHaveLength(1)
    t.restart()
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.steps).toHaveLength(1)
    expect(t.observed).toHaveLength(1)
  })

  test('an allowed skipped call is not logged twice after restart', async () => {
    const t = setup()
    t.append(claudeCall('Read', READ))
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: false } }])
    t.restart()
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
  })

  test('a hosted call is not logged or woken twice after restart', async () => {
    const t = setup({ agent: 'codex' })
    t.append(JSON.stringify({ timestamp: iso(1_000), type: 'response_item', payload: { type: 'web_search_call', action: { query: 'bun' } } }) + '\n')
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { hosted: true } }])
    expect(t.wakes()).toBe(1)
    t.restart()
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.wakes()).toBe(1)
  })

  test('new lines after restart are read once', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    t.restart()
    const input = { file_path: 'b.ts' }
    appendReceiptedRead(t, input, 2_000)
    await t.records.check()
    expect(t.observed.map((call) => call.fingerprint)).toEqual([t.fingerprint('Read', READ), t.fingerprint('Read', input)])
  })

  test('a partial line completed after restart is read once', async () => {
    const t = setup()
    appendReceiptedRead(t)
    const next = claudeCall('Read', { file_path: 'b.ts' }, 2_000)
    t.append(next.slice(0, 40))
    await t.records.check()
    t.restart()
    t.append(next.slice(40))
    await t.records.check()
    expect(t.observed).toHaveLength(2)
  })

  test('lines written while stopped are judged on restart', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    t.records.dispose()
    t.append(claudeCall('Bash', PUSH, 2_000))
    t.restart()
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true, top: true } }])
    expect(t.steps).toHaveLength(1)
    expect(t.steps[0].text).toContain(PUSH.command)
  })
  test('a quiet first pass after restart leaves the stored row as it was', async () => {
    const t = setup({ graceMs: 300_000 })
    appendReceiptedRead(t)
    t.append(claudeCall('Bash', PUSH, 540_000))
    await t.records.check()
    const before = t.app.store.recordCursors.get('s-1')
    expect(before).toMatchObject({ pending: [waitingCall(t)], updatedAt: T0 + 600_000 })
    t.restart()
    t.app.now = () => T0 + 660_000
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toEqual(before)
    expect(t.observed).toHaveLength(2)
  })
})

describe('durable waiting calls', () => {
  test('a waiting call is saved with its whole input', async () => {
    const t = setup({ graceMs: 300_000 })
    t.append(claudeCall('Bash', PUSH, 540_000))
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t)])
  })

  test('a waiting call is judged once its grace expires after restart', async () => {
    const t = setup({ graceMs: 300_000 })
    t.append(claudeCall('Bash', PUSH, 540_000))
    await t.records.check()
    t.restart()
    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true } }])
    expect(t.steps).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })

  test('a receipt arriving after restart settles the waiting call', async () => {
    const t = setup({ graceMs: 300_000 })
    t.append(claudeCall('Bash', PUSH, 540_000))
    await t.records.check()
    t.restart()
    t.receipts.add(t.fingerprint('Bash', PUSH))
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })

  test('a waiting call inside its grace keeps waiting after restart', async () => {
    const t = setup({ graceMs: 300_000 })
    t.append(claudeCall('Bash', PUSH, 540_000))
    await t.records.check()
    t.restart()
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t)])
  })

  test('long pending inputs survive restart whole and are bounded only in the journal', async () => {
    const t = setup({ graceMs: 300_000 })
    const input = { command: `echo ${'x'.repeat(5000)}; git push origin main` }
    t.append(claudeCall('Bash', input, 540_000))
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')?.pending[0].toolInput).toEqual(input)
    t.restart()
    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true, fingerprint: t.fingerprint('Bash', input), toolInput: { truncated: JSON.stringify(input).slice(0, 4000) } } }])
    expect(t.skipped()).toHaveLength(1)
  })

  test('waiting calls older than the hand-off are dropped on load', async () => {
    const t = setup()
    seedCursor(t, { pending: [waitingCall(t, PUSH, T0 - 5_000)] })
    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })

  test('each supervised session stores its own waiting calls', async () => {
    const t = setup({ graceMs: 300_000 })
    const otherTranscript = join(dir, 'other.jsonl')
    const otherWorktree = join(dir, 'wt-2')
    const input = { command: 'git push origin other' }
    writeFileSync(otherTranscript, claudeCall('Bash', input, 540_000))
    t.append(claudeCall('Bash', PUSH, 540_000))
    const first = t.app.services.handoff.active()[0]
    t.app.services.handoff.active = () => [first, { ...first, worktreeId: 'wt-2', sessionId: 's-2' }]
    t.app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: 's-2', active: true, handedOffAt: T0, takenBackAt: null })
    t.fakeCalls['quirky.session/get'] = (params) => ({
      agent: 'claude', cwd: params.session === 's-1' ? t.worktree : otherWorktree, createdAt: T0,
      providerSession: { transcriptPath: params.session === 's-1' ? t.transcript : otherTranscript }
    })
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({ worktreeId: 'wt-1', pending: [waitingCall(t)] })
    expect(t.app.store.recordCursors.get('s-2')).toMatchObject({
      worktreeId: 'wt-2', pending: [{ agent: 'claude', cwd: otherWorktree, toolName: 'Bash', toolInput: input, at: T0 + 540_000, fingerprint: callFingerprint('claude', 'wt-2', 'Bash', input) }]
    })
  })
  test('a waiting call stamped at the hand-off time is kept on load', async () => {
    const t = setup()
    seedCursor(t, { pending: [waitingCall(t, PUSH, T0)] })
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true, fingerprint: t.fingerprint('Bash', PUSH) } }])
    expect(t.steps).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })
})

describe('classifying skipped calls from the gate context', () => {
  test('uses the user home when recognizing credentials', async () => {
    const t = setup()
    const credential = { file_path: join(t.userHome, '.ssh', 'id_ed25519') }
    t.append(claudeCall('Read', credential))
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { classes: ['credential'], outcome: 'held', wouldHaveStopped: true } }])
    expect(t.steps).toHaveLength(1)
  })

  test('judges pushes against the gate context default branch', async () => {
    const t = setup({ level: 'full' })
    t.gateContext = { ...t.gateContext!, defaultBranch: 'trunk' }
    const input = { command: 'git push origin HEAD:trunk' }
    t.append(claudeCall('Bash', input))
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { classes: ['push-default'], outcome: 'deny', wouldHaveStopped: true } }])
    expect(t.contextCalls).toEqual(['wt-1'])
  })

  test('uses the gate handed-off paths even without another session', async () => {
    const t = setup()
    const otherWorktree = join(dir, 'wt2')
    mkdirSync(otherWorktree)
    t.gateContext = { ...t.gateContext!, handedOffPaths: [otherWorktree] }
    const input = { file_path: join(otherWorktree, 'a.ts'), content: 'export {}' }
    t.append(claudeCall('Write', input))
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ data: { classes: ['edit-inside'], outcome: 'allow', wouldHaveStopped: false } }])
    expect(t.steps).toEqual([])
  })

  test('keeps a skipped call pending until its worktree gets confirmed', async () => {
    const t = setup()
    const context = t.gateContext!
    t.gateContext = null
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(t.skipped()).toEqual([])
    expect(t.app.store.journalSince(0).filter((entry) => entry.kind === 'event' && entry.data.type === 'skipped-call-error')).toEqual([])
    expect(t.steps).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t, PUSH, T0 + 1_000)])

    t.gateContext = context
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.contextCalls).toEqual(['wt-1', 'wt-1'])
  })

  test('lets a call go after exactly five minutes without a confirmed worktree', async () => {
    const t = setup()
    const context = t.gateContext!
    t.gateContext = null
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(t.skipped()).toEqual([])

    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.app.store.journalSince(0).filter((entry) => entry.kind === 'event' && entry.data.type === 'skipped-call-error').map((entry) => entry.data)).toEqual([
      { type: 'skipped-call-error', error: 'the worktree could not be confirmed', fingerprint: t.fingerprint('Bash', PUSH) }
    ])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
    const checksAtExpiry = t.contextCalls.length
    t.gateContext = context
    await t.records.check()
    expect(t.contextCalls).toHaveLength(checksAtExpiry)
    expect(t.skipped()).toEqual([])
  })

  test('starts the timeout when a restored call first gets a null context', async () => {
    const t = setup()
    seedCursor(t, { pending: [waitingCall(t, PUSH, T0 + 540_000)] })
    t.gateContext = null
    await t.records.check()
    expect(t.skipped()).toEqual([])

    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.app.store.journalSince(0).filter((entry) => entry.kind === 'event' && entry.data.type === 'skipped-call-error')).toMatchObject([
      { data: { error: 'the worktree could not be confirmed', fingerprint: t.fingerprint('Bash', PUSH) } }
    ])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })
})

describe('cursor lifecycle and failures', () => {
  test('a changed path resets the position but keeps waiting calls', async () => {
    const t = setup()
    seedCursor(t, { path: join(dir, 'old.jsonl'), readOffset: 10, pending: [waitingCall(t, PUSH, T0 + 1_000)] })
    appendReceiptedRead(t)
    await t.records.check()
    expect(statSync(t.transcript).size).toBeGreaterThan(10)
    expect(t.observed.map((call) => call.fingerprint)).toEqual([t.fingerprint('Read', READ)])
    expect(t.skipped()).toMatchObject([{ data: { wouldHaveStopped: true } }])
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({ path: t.transcript, readOffset: statSync(t.transcript).size, pending: [] })
  })

  test('a shorter transcript is read from its start', async () => {
    const t = setup()
    seedCursor(t, { readOffset: 100_000 })
    appendReceiptedRead(t)
    await t.records.check()
    expect(t.observed).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.readOffset).toBe(statSync(t.transcript).size)
  })

  test('an unreadable cursor is logged and rebuilt from the transcript', async () => {
    const t = setup()
    const logs: string[] = []
    t.context.log = (line) => void logs.push(line)
    t.app.store.recordCursors.get = () => { throw new Error('bad row') }
    appendReceiptedRead(t)
    await t.records.check()
    expect(t.observed).toHaveLength(1)
    expect(logs).toContain('avatar record cursor for s-1 could not be read: bad row')
    expect(t.app.store.recordCursors.list()[0].readOffset).toBe(statSync(t.transcript).size)
  })

  test('take-back removes the stored row', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    t.app.services.handoff.active = () => []
    await t.records.check()
    expect(t.app.store.recordCursors.list()).toEqual([])
  })

  test('a replaced session loses its row and the new session gets one', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    const first = t.app.services.handoff.active()[0]
    t.app.services.handoff.active = () => [{ ...first, sessionId: 's-2' }]
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toBeNull()
    expect(t.app.store.recordCursors.get('s-2')).toMatchObject({ sessionId: 's-2' })
  })

  test('an orphan row is pruned on the first pass', async () => {
    const t = setup()
    seedCursor(t, { sessionId: 's-gone', worktreeId: 'wt-9' })
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-gone')).toBeNull()
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({ sessionId: 's-1' })
  })

  test('an unreadable session keeps its saved row', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    const row = t.app.store.recordCursors.get('s-1')
    t.fakeCalls['quirky.session/get'] = () => { throw new Error('session gone') }
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toEqual(row)
  })

  test('failed saves are logged without losing the in-memory position', async () => {
    const t = setup()
    const logs: string[] = []
    t.context.log = (line) => void logs.push(line)
    t.app.store.recordCursors.put = () => { throw new Error('disk') }
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.steps).toHaveLength(1)
    expect(logs).toContain('avatar record cursor for s-1 could not be saved: disk')
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.steps).toHaveLength(1)
  })

  test('failed deletes are logged and do not prevent watcher cleanup', async () => {
    const t = setup()
    mkdirSync(join(t.worktree, '.claude'))
    appendReceiptedRead(t)
    await t.records.check()
    const logs: string[] = []
    t.context.log = (line) => void logs.push(line)
    t.app.store.recordCursors.delete = () => { throw new Error('disk') }
    t.app.services.handoff.active = () => []
    await t.records.check()
    expect(logs).toContain('avatar record cursor for s-1 could not be saved: disk')
    expect(t.watched[0].stopped).toBe(true)
  })
  test('a path that changes between two passes is read from its start', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    const moved = join(dir, 'moved.jsonl')
    const b = { file_path: 'b.ts' }
    const c = { file_path: 'c.ts' }
    writeFileSync(moved, claudeCall('Read', b, 2_000) + claudeCall('Read', c, 3_000))
    t.receipts.add(t.fingerprint('Read', b))
    t.receipts.add(t.fingerprint('Read', c))
    t.fakeCalls['quirky.session/get'] = () => ({ agent: 'claude', cwd: t.worktree, createdAt: T0, providerSession: { transcriptPath: moved } })
    await t.records.check()
    expect(t.observed.map((call) => call.fingerprint)).toEqual([
      t.fingerprint('Read', READ),
      t.fingerprint('Read', b),
      t.fingerprint('Read', c)
    ])
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({ path: moved, readOffset: statSync(moved).size })
  })

  test('a path that changes to an empty record is stored on that pass', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    const moved = join(dir, 'moved.jsonl')
    writeFileSync(moved, '')
    t.fakeCalls['quirky.session/get'] = () => ({ agent: 'claude', cwd: t.worktree, createdAt: T0, providerSession: { transcriptPath: moved } })
    t.app.now = () => T0 + 660_000
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toEqual({
      sessionId: 's-1', worktreeId: 'wt-1', path: moved, readOffset: 0, pending: [], updatedAt: T0 + 660_000
    })
  })

  test('a stored row with another path is rewritten even when the new record is empty', async () => {
    const t = setup()
    seedCursor(t, { path: join(dir, 'old.jsonl'), readOffset: 10 })
    await t.records.check()
    expect(t.app.store.recordCursors.get('s-1')).toEqual({
      sessionId: 's-1', worktreeId: 'wt-1', path: t.transcript, readOffset: 0, pending: [], updatedAt: T0 + 600_000
    })
  })

  test('a stored row from another worktree is taken over by the current one', async () => {
    const t = setup({ graceMs: 300_000 })
    appendReceiptedRead(t)
    const size = statSync(t.transcript).size
    seedCursor(t, { worktreeId: 'wt-old', readOffset: size, pending: [waitingCall(t)] })
    await t.records.check()
    expect(t.observed).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')).toEqual({
      sessionId: 's-1', worktreeId: 'wt-1', path: t.transcript, readOffset: size, pending: [waitingCall(t)], updatedAt: T0 + 600_000
    })
    t.app.now = () => T0 + 900_000
    await t.records.check()
    expect(t.skipped()).toMatchObject([{ worktreeId: 'wt-1', data: { wouldHaveStopped: true } }])
    expect(t.steps.map((step) => step.worktreeId)).toEqual(['wt-1'])
  })

  test('a failed listing in the prune is logged and the rest of the pass still runs', async () => {
    const t = setup()
    const logs: string[] = []
    t.context.log = (line) => void logs.push(line)
    t.app.store.recordCursors.list = () => { throw new Error('db closed') }
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(logs).toEqual(['avatar record cursor for all sessions could not be read: db closed'])
    expect(t.skipped()).toHaveLength(1)
    expect(t.steps).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({ readOffset: statSync(t.transcript).size, pending: [] })
  })

  test('a session handed off again after a take-back gets its row back', async () => {
    const t = setup()
    appendReceiptedRead(t)
    await t.records.check()
    const active = t.app.services.handoff.active
    t.app.services.handoff.active = () => []
    await t.records.check()
    expect(t.app.store.recordCursors.list()).toEqual([])
    t.app.store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: 's-1', active: true, handedOffAt: T0 + 5_000, takenBackAt: null })
    t.app.services.handoff.active = active
    await t.records.check()
    expect(t.observed).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')).toMatchObject({
      sessionId: 's-1', worktreeId: 'wt-1', path: t.transcript, readOffset: statSync(t.transcript).size, pending: []
    })
  })
})

describe('stopping during a record pass', () => {
  test('a call not yet journaled remains pending when disposed during classification', async () => {
    const t = setup()
    const entered = Promise.withResolvers<void>()
    const context = t.gateContext!
    const held = Promise.withResolvers<ClassifyContext | null>()
    t.app.services.gate.classifyContext = () => {
      entered.resolve()
      return held.promise
    }
    t.append(claudeCall('Bash', PUSH))
    const pass = t.records.check()
    await entered.promise
    t.records.dispose()
    held.resolve(context)
    await pass
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t, PUSH, T0 + 1_000)])
    t.app.services.gate.classifyContext = async () => context
    t.restart()
    await t.records.check()
    expect(t.skipped()).toHaveLength(1)
    expect(t.steps).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })

  test('an in-flight step-in stays pending and is deliberately repeated after restart', async () => {
    const t = setup()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<{ sent: boolean }>()
    t.app.services.supervisor.stepIn = (worktreeId, text) => {
      t.steps.push({ worktreeId, text })
      entered.resolve()
      return held.promise
    }
    t.append(claudeCall('Bash', PUSH))
    const pass = t.records.check()
    await entered.promise
    t.records.dispose()
    held.resolve({ sent: true })
    await pass
    expect(t.skipped()).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t, PUSH, T0 + 1_000)])
    t.app.services.supervisor.stepIn = async (worktreeId, text) => {
      t.steps.push({ worktreeId, text })
      return { sent: true }
    }
    t.restart()
    await t.records.check()
    expect(t.skipped()).toHaveLength(2)
    expect(t.steps).toHaveLength(2)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
  })

  test('a pass started after disposal does nothing', async () => {
    const t = setup()
    appendReceiptedRead(t)
    t.records.dispose()
    await t.records.check()
    expect(t.observed).toEqual([])
    expect(t.app.store.recordCursors.list()).toEqual([])
  })
  test('a pass started after disposal deletes no row', async () => {
    const t = setup()
    seedCursor(t, { sessionId: 's-gone', worktreeId: 'wt-9' })
    t.app.services.handoff.active = () => []
    t.records.dispose()
    await t.records.check()
    expect(t.app.store.recordCursors.list().map((row) => row.sessionId)).toEqual(['s-gone'])
  })

  const events = (t: { app: AvatarApp }, type: string) =>
    t.app.store.journalSince(0)
      .filter((entry) => entry.kind === 'event' && entry.data.type === type)
      .map((entry) => entry.data)

  const heldStepIn = (t: { app: AvatarApp; steps: { worktreeId: string; text: string }[] }) => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<{ sent: boolean; reason?: string }>()
    t.app.services.supervisor.stepIn = (worktreeId, text) => {
      t.steps.push({ worktreeId, text })
      entered.resolve()
      return held.promise
    }
    return { entered: entered.promise, resolve: held.resolve, reject: held.reject }
  }

  test('a judgment that fails is journaled once and the call leaves the list', async () => {
    const t = setup()
    t.app.services.supervisor.stepIn = async () => { throw new Error('terminal gone') }
    t.append(claudeCall('Bash', PUSH))
    await t.records.check()
    expect(events(t, 'skipped-call-error')).toEqual([
      { type: 'skipped-call-error', error: 'terminal gone', fingerprint: t.fingerprint('Bash', PUSH) }
    ])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([])
    await t.records.check()
    expect(events(t, 'skipped-call-error')).toHaveLength(1)
    expect(t.skipped()).toHaveLength(1)
  })

  test('a judgment that fails after disposal is not journaled and stays pending', async () => {
    const t = setup()
    const { entered, reject } = heldStepIn(t)
    t.append(claudeCall('Bash', PUSH))
    const pass = t.records.check()
    await entered
    t.records.dispose()
    reject(new Error('terminal gone'))
    await pass
    expect(events(t, 'skipped-call-error')).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t, PUSH, T0 + 1_000)])
  })

  test('a step-in refused after disposal is not journaled and stays pending', async () => {
    const t = setup()
    const { entered, resolve } = heldStepIn(t)
    t.append(claudeCall('Bash', PUSH))
    const pass = t.records.check()
    await entered
    t.records.dispose()
    resolve({ sent: false, reason: 'user-typing' })
    await pass
    expect(events(t, 'step-in-refused')).toEqual([])
    expect(t.skipped()).toHaveLength(1)
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([waitingCall(t, PUSH, T0 + 1_000)])
  })

  test('a stop during the first of two waiting calls starts no judgment of the second', async () => {
    const t = setup()
    const entered = Promise.withResolvers<void>()
    const context = t.gateContext!
    const held = Promise.withResolvers<ClassifyContext | null>()
    let checks = 0
    t.app.services.gate.classifyContext = () => {
      checks++
      entered.resolve()
      return held.promise
    }
    const other = { command: 'git push origin other' }
    t.append(claudeCall('Bash', PUSH, 1_000))
    t.append(claudeCall('Bash', other, 2_000))
    const pass = t.records.check()
    await entered.promise
    t.records.dispose()
    held.resolve(context)
    await pass
    expect(checks).toBe(1)
    expect(t.skipped()).toEqual([])
    expect(t.steps).toEqual([])
    expect(t.app.store.recordCursors.get('s-1')?.pending).toEqual([
      waitingCall(t, PUSH, T0 + 1_000),
      waitingCall(t, other, T0 + 2_000)
    ])
  })

  test('a pass disposed while it reads a session reads nothing more', async () => {
    const t = setup()
    mkdirSync(join(t.worktree, '.claude'))
    appendReceiptedRead(t)
    const first = t.app.services.handoff.active()[0]
    t.app.services.handoff.active = () => [first, { ...first, worktreeId: 'wt-2', sessionId: 's-2' }]
    t.app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: 's-2', active: true, handedOffAt: T0, takenBackAt: null })
    const sessions: unknown[] = []
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<unknown>()
    t.fakeCalls['quirky.session/get'] = (params) => {
      sessions.push(params.session)
      entered.resolve()
      return held.promise
    }
    const pass = t.records.check()
    await entered.promise
    t.records.dispose()
    held.resolve({ agent: 'claude', cwd: t.worktree, createdAt: T0, providerSession: { transcriptPath: t.transcript } })
    await pass
    expect(sessions).toEqual(['s-1'])
    expect(t.observed).toEqual([])
    expect(t.watched).toEqual([])
    expect(t.app.store.recordCursors.list()).toEqual([])
  })
})
