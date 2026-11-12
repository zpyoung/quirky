import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolGateProvider, ToolGateRequest } from '@quirky/protocol'
import type { HandoffRow, Mandate, WorktreeState } from '../src/contracts'
import { register as registerGate } from '../src/gate/service'
import { claudeGateSettings, listMarkerFiles, markerDir, readMarkerFile, writeMarkerFile, type AgentEnv } from '../src/hooks/install'
import { register as registerHandoff } from '../src/handoff'
import { restoreHandoffs, type RestoreResult } from '../src/restore'
import { runDisposers } from '../main'
import { makeTestApp, sampleMandate, type TestApp } from './support'

const dirs: string[] = []
const disposers: (() => void)[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose()
    } catch {
      continue
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function appSetup(fakeCalls: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const t = makeTestApp({ fakeCalls })
  dirs.push(t.context.home)
  return t
}

function gateSetup(t: TestApp) {
  const agentEnv: AgentEnv = { home: scratch('avatar-activation-agent-'), env: {} }
  const dispose = registerGate(t.app, { agentEnv, claudeVersion: async () => '2.1.300', graceMs: 25 })
  disposers.push(dispose)
  return {
    agentEnv,
    dispose,
    provider: t.provided.get('tool-gate:quirky.avatar/gate') as ToolGateProvider
  }
}

function handoffSetup(t: TestApp): () => void {
  const dispose = registerHandoff(t.app, { claudeVersion: async () => '2.1.300' })
  disposers.push(dispose)
  return dispose
}

type Runtime = { agentEnv: AgentEnv; dispose: () => void; provider: ToolGateProvider; disposers: (() => void)[] }

function runtimeSetup(t: TestApp): Runtime {
  const gate = gateSetup(t)
  const handoffDispose = handoffSetup(t)
  return { ...gate, disposers: [gate.dispose, handoffDispose] }
}

function stopRuntime(runtime: Runtime): void {
  const owned = new Set(runtime.disposers)
  for (let i = disposers.length - 1; i >= 0; i--) {
    if (owned.has(disposers[i]!)) disposers.splice(i, 1)
  }
  runDisposers(runtime.disposers, () => {})
}

function addHandoff(
  t: TestApp,
  options: {
    worktreeId?: string
    state?: WorktreeState
    sessionId?: string | null
    active?: boolean
    handedOffAt?: number
    mandate?: Mandate | null
  } = {}
): HandoffRow {
  const worktreeId = options.worktreeId ?? 'wt-1'
  const row: HandoffRow = {
    worktreeId,
    state: options.state ?? 'working',
    sessionId: options.sessionId === undefined ? 's-1' : options.sessionId,
    active: options.active ?? true,
    handedOffAt: options.handedOffAt ?? t.app.now() - 1_000,
    takenBackAt: options.active === false ? t.app.now() : null
  }
  t.app.store.handoffs.put(row)
  const mandate = options.mandate === undefined ? sampleMandate({ worktreeId }) : options.mandate
  if (mandate !== null) t.app.store.mandates.put(mandate)
  return row
}

function writeRawMarker(home: string, sessionId: string, text: string): void {
  mkdirSync(markerDir(home), { recursive: true })
  writeFileSync(join(markerDir(home), sessionId), text)
}

function restoredEntries(t: TestApp, worktreeId?: string) {
  return t.app.store.journalPage(worktreeId === undefined ? {} : { worktreeId })
    .filter((entry) => entry.kind === 'event' && entry.data.type === 'restored')
}


function gateRequest(sessionId: string, worktreePath: string, toolName: string, toolInput: Record<string, unknown>): ToolGateRequest {
  return {
    agent: 'claude',
    sessionId,
    event: 'PreToolUse',
    deadlineMs: 60_000,
    payload: {
      hook_event_name: 'PreToolUse',
      cwd: worktreePath,
      tool_name: toolName,
      tool_input: toolInput
    }
  }
}

function addRuntimeWorktree(t: TestApp) {
  const worktreePath = scratch('avatar-activation-worktree-')
  const mainPath = scratch('avatar-activation-main-')
  t.fakeCalls['quirky.worktree/list'] = () => [
    { id: 'wt-1', path: worktreePath, branch: 'feature', repoId: 'repo', isMain: false },
    { id: 'main', path: mainPath, branch: 'main', repoId: 'repo', isMain: true }
  ]
  return { worktreePath, mainPath }
}

test('writes a missing marker from an active hand-off', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t)

  const result = restoreHandoffs(t.app)

  expect(readMarkerFile(t.context.home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
  expect(result).toEqual({ markersWritten: ['s-1'], markersRemoved: [], checksResumed: [] })
  expect(restoredEntries(t, 'wt-1')[0]?.data).toEqual({
    type: 'restored', sessionId: 's-1', marker: 'written', gateCheck: false
  })
})

test('keeps a correct marker without journaling', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t)
  writeMarkerFile(t.context.home, 's-1', { worktreeId: 'wt-1', level: 'own-branch' })

  const result = restoreHandoffs(t.app)

  expect(result).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: [] })
  expect(restoredEntries(t)).toEqual([])
})

for (const [description, marker] of [
  ['a marker for another worktree', { worktreeId: 'wt-2', level: 'own-branch' }],
  ['a marker with the wrong level', { worktreeId: 'wt-1', level: 'local' }]
] as const) {
  test(`corrects ${description}`, () => {
    const t = appSetup()
    gateSetup(t)
    addHandoff(t)
    writeMarkerFile(t.context.home, 's-1', marker as { worktreeId: string; level: 'own-branch' | 'local' })

    const result = restoreHandoffs(t.app)

    expect(readMarkerFile(t.context.home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
    expect(result.markersWritten).toEqual(['s-1'])
    expect(restoredEntries(t, 'wt-1')[0]?.data).toEqual({
      type: 'restored', sessionId: 's-1', marker: 'written', gateCheck: false
    })
  })
}

test('corrects an unreadable marker', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t)
  writeRawMarker(t.context.home, 's-1', 'not json')

  const result = restoreHandoffs(t.app)

  expect(readMarkerFile(t.context.home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
  expect(result.markersWritten).toEqual(['s-1'])
  expect(restoredEntries(t, 'wt-1')[0]?.data).toEqual({
    type: 'restored', sessionId: 's-1', marker: 'written', gateCheck: false
  })
})

for (const state of ['parked', 'gate-failed'] as const) {
  test(`does not create a marker for a ${state} hand-off`, () => {
    const t = appSetup()
    gateSetup(t)
    addHandoff(t, { state })

    const result = restoreHandoffs(t.app)

    expect(result).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: [] })
    expect(listMarkerFiles(t.context.home)).toEqual([])
    expect(restoredEntries(t)).toEqual([])
  })

  test(`removes an existing marker for a ${state} hand-off`, () => {
    const t = appSetup()
    gateSetup(t)
    addHandoff(t, { state })
    writeMarkerFile(t.context.home, 's-1', { worktreeId: 'wt-1', level: 'own-branch' })

    const result = restoreHandoffs(t.app)

    expect(result.markersRemoved).toEqual(['s-1'])
    expect(listMarkerFiles(t.context.home)).toEqual([])
    expect(restoredEntries(t)).toEqual([])
  })
}

test('does not create or journal a marker without a session', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t, { sessionId: null })

  const result = restoreHandoffs(t.app)

  expect(result).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: [] })
  expect(restoredEntries(t)).toEqual([])
})

test('removes a marker when its active hand-off has no mandate', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t, { mandate: null })
  writeMarkerFile(t.context.home, 's-1', { worktreeId: 'wt-1', level: 'own-branch' })

  const result = restoreHandoffs(t.app)

  expect(result.markersRemoved).toEqual(['s-1'])
  expect(listMarkerFiles(t.context.home)).toEqual([])
  expect(restoredEntries(t)).toEqual([])
})

test('removes stale markers by worktree, sorts their names, and logs them once', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t)
  addHandoff(t, { worktreeId: 'wt-2', sessionId: 's-back', active: false })
  writeMarkerFile(t.context.home, 's-old', { worktreeId: 'wt-9', level: 'own-branch' })
  writeMarkerFile(t.context.home, 's-back', { worktreeId: 'wt-2', level: 'own-branch' })
  writeRawMarker(t.context.home, 's-bad', 'not json')
  const lines: string[] = []
  t.context.log = (message: string) => { lines.push(message) }

  const result = restoreHandoffs(t.app)

  expect(result.markersRemoved).toEqual(['s-back', 's-bad', 's-old'])
  expect(listMarkerFiles(t.context.home)).toEqual(['s-1'])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('s-back')
  expect(lines[0]).toContain('s-bad')
  expect(lines[0]).toContain('s-old')
  expect(t.app.store.journalPage().filter((entry) => entry.worktreeId !== 'wt-1')).toEqual([])
})

test('keeps a second marker for a worktree with an active hand-off', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t)
  writeMarkerFile(t.context.home, 's-1', { worktreeId: 'wt-1', level: 'own-branch' })
  writeMarkerFile(t.context.home, 's-2', { worktreeId: 'wt-1', level: 'own-branch' })

  const result = restoreHandoffs(t.app)

  expect(result).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: [] })
  expect(listMarkerFiles(t.context.home)).toEqual(['s-1', 's-2'])
  expect(restoredEntries(t)).toEqual([])
})

test('resumes a checking hand-off and journals its marker state', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t, { state: 'checking' })
  const checks: string[] = []
  t.app.services.gate.gateCheck = async (worktreeId) => {
    checks.push(worktreeId)
    return { ok: true, reason: '' }
  }

  const result = restoreHandoffs(t.app)

  expect(checks).toEqual(['wt-1'])
  expect(result).toEqual({ markersWritten: ['s-1'], markersRemoved: [], checksResumed: ['wt-1'] })
  expect(restoredEntries(t, 'wt-1')[0]?.data).toEqual({
    type: 'restored', sessionId: 's-1', marker: 'written', gateCheck: true
  })
})

test('does not resume gate checks outside the checking state', () => {
  const t = appSetup()
  gateSetup(t)
  const states: WorktreeState[] = [
    'briefing', 'working', 'waiting-on-you', 'checking-done', 'in-review', 'merge-ready', 'merged',
    'pr-ready', 'committed', 'done', 'parked', 'gate-failed'
  ]
  for (const [index, state] of states.entries()) {
    addHandoff(t, { worktreeId: `wt-${index}`, sessionId: `s-${index}`, state })
  }
  const checks: string[] = []
  t.app.services.gate.gateCheck = async (worktreeId) => {
    checks.push(worktreeId)
    return { ok: true, reason: '' }
  }

  const result = restoreHandoffs(t.app)

  expect(checks).toEqual([])
  expect(result.checksResumed).toEqual([])
})

test('a real resumed gate check that passes advances to briefing', async () => {
  const t = appSetup({
    'quirky.session/get': () => ({
      agent: 'claude',
      launch: { args: ['--settings', JSON.stringify(claudeGateSettings({}, 55))] }
    })
  })
  addHandoff(t, { state: 'checking' })
  t.app.store.receipts.put({
    id: 'receipt-s-1', fingerprint: 'fingerprint-s-1', sessionId: 's-1', toolName: 'Read',
    at: t.app.now(), outcome: 'allow', step: 'fixed-rules'
  })
  runtimeSetup(t)
  const gateCheck = t.app.services.gate.gateCheck.bind(t.app.services.gate)
  let resumedCheck: Promise<{ ok: boolean; reason: string }> | undefined
  t.app.services.gate.gateCheck = (worktreeId) => {
    resumedCheck = gateCheck(worktreeId)
    return resumedCheck
  }

  const result = restoreHandoffs(t.app)

  expect(result.checksResumed).toEqual(['wt-1'])
  expect(resumedCheck).toBeDefined()
  await resumedCheck
  expect(t.app.store.handoffs.get('wt-1')?.state).toBe('briefing')
  expect(readMarkerFile(t.context.home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
})

test('a real resumed gate check failure records a need and removes the marker', async () => {
  const t = appSetup({ 'quirky.session/get': async () => { throw new Error('session unavailable') } })
  addHandoff(t, { state: 'checking' })
  runtimeSetup(t)
  const gateCheck = t.app.services.gate.gateCheck.bind(t.app.services.gate)
  let resumedCheck: Promise<{ ok: boolean; reason: string }> | undefined
  t.app.services.gate.gateCheck = (worktreeId) => {
    resumedCheck = gateCheck(worktreeId)
    return resumedCheck
  }

  restoreHandoffs(t.app)

  expect(resumedCheck).toBeDefined()
  await resumedCheck
  const need = t.app.needs.list({ worktreeId: 'wt-1', open: true }).find((item) => item.kind === 'gate-failed')
  expect(t.app.store.handoffs.get('wt-1')?.state).toBe('gate-failed')
  expect(need?.actions).toContain('restart-to-handoff')
  expect(listMarkerFiles(t.context.home)).toEqual([])
})

test('a checking hand-off without a session fails through the real gate modules', async () => {
  const t = appSetup()
  addHandoff(t, { state: 'checking', sessionId: null })
  runtimeSetup(t)
  const gateCheck = t.app.services.gate.gateCheck.bind(t.app.services.gate)
  let resumedCheck: Promise<{ ok: boolean; reason: string }> | undefined
  t.app.services.gate.gateCheck = (worktreeId) => {
    resumedCheck = gateCheck(worktreeId)
    return resumedCheck
  }

  const result = restoreHandoffs(t.app)

  expect(result).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: ['wt-1'] })
  expect(resumedCheck).toBeDefined()
  await resumedCheck
  const need = t.app.needs.list({ worktreeId: 'wt-1', open: true }).find((item) => item.kind === 'gate-failed')
  expect(t.app.store.handoffs.get('wt-1')?.state).toBe('gate-failed')
  expect(need?.detail.reason).toBe('there is no session to check')
})

test('journals a rejected resumed check without an unhandled rejection', async () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t, { state: 'checking' })
  t.app.services.gate.gateCheck = async () => { throw new Error('boom') }

  restoreHandoffs(t.app)
  await Promise.resolve()

  expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).some((entry) =>
    entry.kind === 'event' && entry.data.type === 'gate-check-error' && entry.data.error === 'boom'
  )).toBe(true)
})

test('continues restoring after a marker write failure', () => {
  const t = appSetup()
  gateSetup(t)
  addHandoff(t, { worktreeId: 'wt-1', sessionId: 's-1' })
  addHandoff(t, { worktreeId: 'wt-2', sessionId: 's-2' })
  const writeMarker = t.app.services.gate.writeMarker.bind(t.app.services.gate)
  t.app.services.gate.writeMarker = (sessionId, worktreeId, level) => {
    if (worktreeId === 'wt-1') throw new Error('disk')
    writeMarker(sessionId, worktreeId, level)
  }

  let result: RestoreResult | undefined
  expect(() => { result = restoreHandoffs(t.app) }).not.toThrow()

  expect(result).toEqual({ markersWritten: ['s-2'], markersRemoved: [], checksResumed: [] })
  expect(readMarkerFile(t.context.home, 's-2')).toEqual({ worktreeId: 'wt-2', level: 'own-branch' })
  expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).some((entry) =>
    entry.kind === 'event' && entry.data.type === 'restore-failed' && entry.data.error === 'disk'
  )).toBe(true)
})

test('returns empty results without journaling when there is nothing to restore', () => {
  const t = appSetup()
  gateSetup(t)

  expect(existsSync(markerDir(t.context.home))).toBe(false)
  expect(restoreHandoffs(t.app)).toEqual({ markersWritten: [], markersRemoved: [], checksResumed: [] })
  expect(t.app.store.journalPage()).toEqual([])
})

test('lists marker file names in sorted order and returns empty for a missing directory', () => {
  const home = scratch('avatar-marker-list-')

  expect(listMarkerFiles(home)).toEqual([])
  mkdirSync(markerDir(home), { recursive: true })
  writeFileSync(join(markerDir(home), 'b'), '{}')
  writeFileSync(join(markerDir(home), 'a'), '{}')

  expect(listMarkerFiles(home)).toEqual(['a', 'b'])
})


test('decides again after a same-process restart and keeps fixed denials held', async () => {
  const t = appSetup()
  const { worktreePath } = addRuntimeWorktree(t)
  addHandoff(t)
  const first = runtimeSetup(t)
  t.app.services.gate.writeMarker('s-1', 'wt-1', 'own-branch')
  const request = gateRequest('s-1', worktreePath, 'Read', { file_path: join(worktreePath, 'src/a.ts') })
  const firstDecision = await first.provider(request, new AbortController().signal)
  expect(firstDecision.decision).toBe('allow')

  stopRuntime(first)
  const second = runtimeSetup(t)
  restoreHandoffs(t.app)
  const before = t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'gate').length
  const decision = await second.provider(request, new AbortController().signal)
  const sshWrite = await second.provider(
    gateRequest('s-1', worktreePath, 'Write', { file_path: join(second.agentEnv.home, '.ssh', 'config'), content: 'x' }),
    new AbortController().signal
  )

  expect(decision.decision).toBe('allow')
  expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'gate')).toHaveLength(before + 2)
  expect(sshWrite.decision).toBe('deny')
  expect(sshWrite.reason).toContain('Held for the user')
})

test('restores a lost marker before the restarted provider answers', async () => {
  const t = appSetup()
  const { worktreePath } = addRuntimeWorktree(t)
  addHandoff(t)
  const first = runtimeSetup(t)
  t.app.services.gate.writeMarker('s-1', 'wt-1', 'own-branch')
  const request = gateRequest('s-1', worktreePath, 'Read', { file_path: join(worktreePath, 'src/a.ts') })
  expect((await first.provider(request, new AbortController().signal)).decision).toBe('allow')

  stopRuntime(first)
  rmSync(join(markerDir(t.context.home), 's-1'), { force: true })
  const second = runtimeSetup(t)
  const result = restoreHandoffs(t.app)
  const before = t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'gate').length
  const decision = await second.provider(request, new AbortController().signal)

  expect(result.markersWritten).toEqual(['s-1'])
  expect(readMarkerFile(t.context.home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
  expect(decision.decision).toBe('allow')
  expect(decision.reason).not.toBe('not supervised')
  expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'gate')).toHaveLength(before + 1)
})

test('runs all disposers in reverse order and logs each failure', () => {
  const calls: string[] = []
  const lines: string[] = []
  const dispose = (name: string, failure = false) => () => {
    calls.push(name)
    if (failure) throw new Error(`${name} broke`)
  }

  expect(() => runDisposers([dispose('a'), dispose('b', true), dispose('c')], (line) => { lines.push(line) })).not.toThrow()

  expect(calls).toEqual(['c', 'b', 'a'])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('b broke')
})
