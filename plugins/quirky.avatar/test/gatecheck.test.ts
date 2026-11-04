import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeState } from '../src/contracts'
import { createGateChecker } from '../src/gatecheck'
import {
  claudeGateSettings, hasMarkerFile, installCodexHooks, installPiExtensions, piExtensionPath, writeHookedRecord, writeMarkerFile, type AgentEnv
} from '../src/hooks/install'
import { makeTestApp } from './support'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Session = { agent: string; createdAt?: number; launch?: { args?: unknown[] | string; env?: Record<string, string> } | null }

function setup(options: { session?: Session; version?: string | null; state?: WorktreeState; graceMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'avatar-gatecheck-'))
  dirs.push(home)
  const agentEnv: AgentEnv = { home, env: {} }
  const session: Session = options.session ?? { agent: 'claude', createdAt: 5_000, launch: { args: ['--settings', JSON.stringify(claudeGateSettings({}, 55))] } }
  const t = makeTestApp({ fakeCalls: { 'quirky.session/get': () => session } })
  const states: [string, WorktreeState, string][] = []
  t.app.services.handoff.setState = (worktreeId, state, note) => {
    states.push([worktreeId, state, note])
    const row = t.app.store.handoffs.get(worktreeId)
    if (row !== null) t.app.store.handoffs.put({ ...row, state })
  }
  const handedOffAt = t.app.now() - 1000
  for (const id of ['wt-1', 'wt-2']) {
    t.app.store.handoffs.put({ worktreeId: id, state: options.state ?? 'checking', sessionId: id === 'wt-1' ? 's-1' : 's-2', active: true, handedOffAt, takenBackAt: null })
    writeMarkerFile(t.context.home, id === 'wt-1' ? 's-1' : 's-2', { worktreeId: id, level: 'full' })
  }
  const version = options.version === undefined ? '2.1.300' : options.version
  const checker = createGateChecker({ app: t.app, agentEnv, claudeVersion: async () => version, graceMs: options.graceMs ?? 40 })
  const receive = (sessionId = 's-1', fingerprint = 'fp-1', at = Date.now()) => {
    t.app.store.receipts.put({ id: `${sessionId}-${fingerprint}-${at}`, fingerprint, sessionId, toolName: 'Read', at, outcome: 'allow', step: 'fixed-rules' })
    checker.noteReceipt(sessionId)
  }
  const needs = () => t.app.needs.list({ worktreeId: 'wt-1', open: true })
  return { ...t, agentEnv, session, states, checker, receive, needs, home }
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`

const marked = (s: ReturnType<typeof setup>, sessionId: string) => hasMarkerFile(s.context.home, sessionId)

describe('Claude', () => {
  test('passes once the first call reaches the gate, and the worktree moves from checking to briefing', async () => {
    const s = setup()
    const check = s.checker.check('wt-1')
    await Bun.sleep(20)
    expect(s.states).toEqual([])
    s.receive()
    expect(await check).toEqual({ ok: true, reason: '' })
    expect(s.states).toEqual([['wt-1', 'briefing', 'the gate check passed']])
    expect(marked(s, 's-1')).toBe(true)
    expect(s.needs()).toEqual([])
  })

  test('passes with the launch args recorded as one shell-quoted string, as the session store keeps them', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: `--model x --settings ${shellQuote(JSON.stringify(claudeGateSettings({}, 55)))}` } } })
    const check = s.checker.check('wt-1')
    s.receive()
    expect(await check).toEqual({ ok: true, reason: '' })
  })

  test('passes on the launch hook record when the string-form launch args lack --settings', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: '--model x' } } })
    writeHookedRecord(s.context.dataDir, 's-1', { agent: 'claude', at: 1, claudeVersion: '2.1.300' })
    const check = s.checker.check('wt-1')
    s.receive()
    expect(await check).toEqual({ ok: true, reason: '' })
  })

  test('fails without the launch hook record when the string-form launch args lack --settings', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: '--model x' } } })
    writeHookedRecord(s.context.dataDir, 's-2', { agent: 'claude', at: 1, claudeVersion: '2.1.300' })
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: "started before the avatar's hook was installed" })
  })

  test('the launch hook record does not excuse a Claude too old to fail closed', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: '' } }, version: '2.1.294' })
    writeHookedRecord(s.context.dataDir, 's-1', { agent: 'claude', at: 1, claudeVersion: '2.1.294' })
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: 'Claude is too old to fail closed; update Claude' })
  })

  test('fails when the recorded launch args string has no avatar --settings', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: `--model x --settings ${shellQuote('{"hooks":{}}')}` } } })
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: "started before the avatar's hook was installed" })
  })

  test('fails when the launch record has no avatar --settings, with the reason an old agent gets', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: ['--model', 'x'] } } })
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: "started before the avatar's hook was installed" })
  })

  test('fails for a Claude too old to fail closed, even with the hook in its args', async () => {
    const s = setup({ version: '2.1.294' })
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: 'Claude is too old to fail closed; update Claude' })
  })

  test('a failure removes the marker, sets gate-failed and queues restart-to-handoff for that worktree only', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: [] } } })
    await s.checker.check('wt-1')
    expect(marked(s, 's-1')).toBe(false)
    expect(marked(s, 's-2')).toBe(true)
    expect(s.states).toEqual([['wt-1', 'gate-failed', "started before the avatar's hook was installed"]])
    expect(s.needs()).toHaveLength(1)
    expect(s.needs()[0]).toMatchObject({ kind: 'gate-failed', actions: ['restart-to-handoff'] })
    expect(s.app.needs.list({ worktreeId: 'wt-2' })).toEqual([])
    expect(s.app.store.handoffs.get('wt-2')!.state).toBe('checking')
  })

  test('failing again does not queue a second item', async () => {
    const s = setup({ session: { agent: 'claude', launch: { args: [] } } })
    await s.checker.check('wt-1')
    await s.checker.check('wt-1')
    expect(s.needs()).toHaveLength(1)
  })

  test('an unreadable session fails the check', async () => {
    const s = setup()
    s.fakeCalls['quirky.session/get'] = () => {
      throw new Error('gone')
    }
    const result = await s.checker.check('wt-1')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('gone')
  })
})

describe('the dynamic step', () => {
  test('a call seen in the session record with no receipt fails the check after the grace period', async () => {
    const s = setup({ graceMs: 30 })
    const check = s.checker.check('wt-1')
    await Bun.sleep(10)
    s.checker.noteObserved('s-1', 'fp-seen', Date.now())
    expect(await check).toEqual({ ok: false, reason: 'tool calls are not reaching the gate' })
    expect(s.states.at(-1)).toEqual(['wt-1', 'gate-failed', 'tool calls are not reaching the gate'])
    expect(marked(s, 's-1')).toBe(false)
  })

  test('an observed call that has its receipt does not fail the check', async () => {
    const s = setup({ graceMs: 30 })
    const check = s.checker.check('wt-1')
    await Bun.sleep(10)
    s.checker.noteObserved('s-1', 'fp-seen', Date.now())
    s.receive('s-1', 'fp-seen')
    expect((await check).ok).toBe(true)
  })

  test('an unmatched call fails the check even when another call from the session has a receipt', async () => {
    const s = setup({ graceMs: 30 })
    const check = s.checker.check('wt-1')
    await Bun.sleep(10)
    s.checker.noteObserved('s-1', 'fp-ungated', Date.now())
    s.receive('s-1', 'fp-other')
    expect(await check).toEqual({ ok: false, reason: 'tool calls are not reaching the gate' })
    expect(s.states.at(-1)).toEqual(['wt-1', 'gate-failed', 'tool calls are not reaching the gate'])
  })

  test('every observed call matched by its own receipt passes', async () => {
    const s = setup({ graceMs: 30 })
    const check = s.checker.check('wt-1')
    await Bun.sleep(10)
    s.checker.noteObserved('s-1', 'fp-a', Date.now())
    s.checker.noteObserved('s-1', 'fp-b', Date.now())
    s.receive('s-1', 'fp-a')
    s.receive('s-1', 'fp-b')
    expect((await check).ok).toBe(true)
  })

  test('a call seen long ago with no receipt fails at once', async () => {
    const s = setup({ graceMs: 1000 })
    const check = s.checker.check('wt-1')
    s.checker.noteObserved('s-1', 'fp-old', Date.now() - 5000)
    expect((await check).reason).toBe('tool calls are not reaching the gate')
  })

  test('while no call has been made the state stays checking and the marker stays', async () => {
    const s = setup()
    const check = s.checker.check('wt-1')
    await Bun.sleep(40)
    expect(s.app.store.handoffs.get('wt-1')!.state).toBe('checking')
    expect(marked(s, 's-1')).toBe(true)
    s.receive()
    await check
  })

  test('a receipt from before the hand-off does not satisfy it', async () => {
    const s = setup()
    s.receive('s-1', 'fp-0', Date.now() - 60_000)
    const check = s.checker.check('wt-1')
    const early = await Promise.race([check, Bun.sleep(40).then(() => 'waiting')])
    expect(early).toBe('waiting')
    s.receive()
    expect((await check).ok).toBe(true)
  })

  test('another session id does not satisfy it', async () => {
    const s = setup()
    const check = s.checker.check('wt-1')
    s.receive('s-2')
    expect(await Promise.race([check, Bun.sleep(40).then(() => 'waiting')])).toBe('waiting')
    s.receive('s-1')
    await check
  })

  test('a re-check of a worker that is already working passes on its existing receipts and keeps its state', async () => {
    const s = setup({ state: 'working' })
    s.receive('s-1', 'fp-1', Date.now() - 500)
    expect((await s.checker.check('wt-1')).ok).toBe(true)
    expect(s.states).toEqual([])
  })

  test('handing the worktree back ends a waiting check without failing it', async () => {
    const s = setup()
    const check = s.checker.check('wt-1')
    await Bun.sleep(10)
    s.app.store.handoffs.put({ ...s.app.store.handoffs.get('wt-1')!, active: false })
    s.checker.cancel('wt-1')
    expect(await check).toEqual({ ok: false, reason: 'no longer supervised' })
    expect(s.states).toEqual([])
    expect(s.needs()).toEqual([])
  })

  test('a worktree that is not handed off is not checked', async () => {
    const s = setup()
    expect((await s.checker.check('wt-unknown')).ok).toBe(false)
    expect(s.states).toEqual([])
  })

  test('calls for one worktree share one run', async () => {
    const s = setup()
    const first = s.checker.check('wt-1')
    expect(s.checker.check('wt-1')).toBe(first)
    s.receive()
    await first
    expect(s.calls.filter((call) => call.method === 'quirky.session/get')).toHaveLength(1)
  })
})

describe('Codex', () => {
  test('fails when the avatar entries are not in hooks.json, and passes with them', async () => {
    const s = setup({ session: { agent: 'codex' } })
    expect((await s.checker.check('wt-1')).ok).toBe(false)
    installCodexHooks(s.agentEnv, 55)
    s.app.store.handoffs.put({ ...s.app.store.handoffs.get('wt-1')!, state: 'checking' })
    writeMarkerFile(s.context.home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    const check = s.checker.check('wt-1')
    s.receive()
    expect((await check).ok).toBe(true)
  })
})

describe('pi and omp', () => {
  const withExtension = (agent: 'pi' | 'omp', session: Omit<Session, 'agent'>) => {
    const s = setup({ session: { agent, ...session } })
    mkdirSync(join(s.home, agent === 'pi' ? '.pi' : '.omp', 'agent'), { recursive: true })
    installPiExtensions(s.agentEnv)
    return s
  }

  test.each(['pi', 'omp'] as const)('%s passes when the extension is older than the session', async (agent) => {
    const s = withExtension(agent, { createdAt: Date.now() + 10_000 })
    const check = s.checker.check('wt-1')
    s.receive()
    expect((await check).ok).toBe(true)
  })

  test.each(['pi', 'omp'] as const)('%s fails when the session started before the extension was installed', async (agent) => {
    const s = withExtension(agent, { createdAt: 1_000 })
    utimesSync(piExtensionPath(agent, s.agentEnv), new Date(2_000), new Date(2_000))
    expect(await s.checker.check('wt-1')).toEqual({ ok: false, reason: "started before the avatar's hook was installed" })
  })

  test('fails when the extension is not installed', async () => {
    const s = setup({ session: { agent: 'pi', createdAt: Date.now() } })
    const result = await s.checker.check('wt-1')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not installed')
  })

  test("follows the session's own PI_CODING_AGENT_DIR", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avatar-pi-dir-'))
    dirs.push(dir)
    const s = setup({ session: { agent: 'pi', createdAt: Date.now() + 10_000, launch: { env: { PI_CODING_AGENT_DIR: dir } } } })
    installPiExtensions({ home: s.home, env: { PI_CODING_AGENT_DIR: dir } })
    const check = s.checker.check('wt-1')
    s.receive()
    expect((await check).ok).toBe(true)
  })
})

test('an agent with no permission hook fails the check', async () => {
  const s = setup({ session: { agent: 'gemini' } })
  expect((await s.checker.check('wt-1')).reason).toBe('gemini has no permission hook')
})
