import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Level, WorktreeState } from '../src/contracts'
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

type Options = { agent?: string; level?: Level; state?: WorktreeState; graceMs?: number; sessionCreatedAt?: number | null }

function setup({ agent = 'claude', level = 'own-branch', state = 'working', graceMs = 0, sessionCreatedAt = T0 }: Options = {}) {
  const t = makeTestApp()
  const worktree = join(dir, 'wt')
  mkdirSync(worktree, { recursive: true })
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, '')
  t.app.now = () => T0 + 10 * 60_000
  const mandate = sampleMandate({ level })
  t.app.store.mandates.put(mandate)
  t.app.store.handoffs.put({ worktreeId: 'wt-1', state, sessionId: 's-1', active: true, handedOffAt: T0, takenBackAt: null })
  const current = { state }
  t.app.services.handoff.active = () => [{ worktreeId: 'wt-1', sessionId: 's-1', state: current.state, mandate }]
  t.app.services.handoff.setState = (_worktreeId, next) => void (current.state = next)

  const observed: { sessionId: string; fingerprint: string; at: number }[] = []
  const receipts = new Set<string>()
  t.app.services.gate = {
    ...t.app.services.gate,
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
  t.fakeCalls['quirky.git/status'] = () => ({ head: 'sha', branch: 'avatar/wt-1' })
  t.fakeCalls['quirky.git/compare'] = () => ({ status: 'ready', base: 'origin/main', entries: [] })

  const evidence = createEvidence()
  const watched: { dir: string; fire: (filename: string | null) => void; stopped: boolean }[] = []
  const records = createRecords(t.app, {
    evidence,
    graceMs,
    debounceMs: 0,
    env: { CODEX_HOME: join(dir, 'codex-home') },
    watch: (watchDir, fire) => {
      const entry = { dir: watchDir, fire, stopped: false }
      watched.push(entry)
      return () => void (entry.stopped = true)
    }
  })
  const fingerprint = (name: string, input: unknown) => callFingerprint(agent, 'wt-1', name, input)
  const skipped = () => t.app.store.journalSince(0).filter((entry) => entry.kind === 'skipped-call')
  return {
    ...t,
    worktree,
    transcript,
    observed,
    receipts,
    steps,
    evidence,
    records,
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

  test('watches the directories that hold the agent hook files for each agent', async () => {
    const cases: [string, string[]][] = [
      ['claude', ['.claude']],
      ['codex', ['codex-home', '.codex']],
      ['pi', ['extensions']],
      ['omp', ['extensions']]
    ]
    for (const [agent, dirs] of cases) {
      const t = setup({ agent })
      for (const name of dirs) mkdirSync(name.startsWith('.') ? join(t.worktree, name) : join(dir, name === 'extensions' ? join('agent-dir', 'extensions') : name), { recursive: true })
      t.records.dispose()
      const again = createRecords(t.app, { evidence: t.evidence, debounceMs: 0, env: { CODEX_HOME: join(dir, 'codex-home'), PI_CODING_AGENT_DIR: join(dir, 'agent-dir') }, watch: (watchDir, fire) => (t.watched.push({ dir: watchDir, fire, stopped: false }), () => {}) })
      await again.check()
      expect(t.watched.map((entry) => entry.dir.replace(`${dir}/`, '').replace('wt/', ''))).toEqual(dirs.map((name) => (name === 'extensions' ? 'agent-dir/extensions' : name)))
      again.dispose()
    }
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
})
