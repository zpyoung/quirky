import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { PluginContext, ProcessRunner, RunOptions, RunResult, Session } from '@quirky/protocol'
import { AgentStatusService, type HookInput } from '../src/service'
import { decideIdentity, processAlive, type IdentityEvent, type IsAlive } from '../src/identity'
import type { ActivityFeed } from '../src/activity'
import type { RowStore } from '../src/store'
import type { AgentRow, NormalizerCache } from '../src/types'

const PID = 24801
const NOW = Date.parse('2026-11-12T12:00:00Z')
const START = 'Thu Nov 12 12:00:00 2026'
const OTHER_START = 'Wed Nov 11 11:00:00 2026'
const PS_ARGV = ['ps', '-o', 'lstart=', '-p', String(PID)]
const restores: (() => void)[] = []
let killMode: 'alive' | 'dead' | 'eperm' = 'alive'
let killCalls = 0

beforeEach(() => {
  killMode = 'alive'
  killCalls = 0
  const kill = spyOn(process, 'kill').mockImplementation(() => {
    killCalls++
    if (killMode === 'dead') throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    if (killMode === 'eperm') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    return true
  })
  const spawnSync = spyOn(Bun, 'spawnSync').mockImplementation(() => {
    throw new Error('synchronous process entrypoint forbidden')
  })
  restores.push(() => kill.mockRestore(), () => spawnSync.mockRestore())
})

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const service of services.splice(0)) {
    if (!(service as unknown as { stopped: boolean }).stopped) service.shutdown()
  }
})

type RunnerCall = { argv: readonly string[]; options?: RunOptions }
type RunnerStep = RunResult | Error | (() => Promise<RunResult>)

function runResult(stdoutText: string, changes: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...changes
  }
}

function fakeRunner(...steps: RunnerStep[]): { runner: ProcessRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: ProcessRunner = {
    async run(argv, options) {
      calls.push({ argv: [...argv], options })
      const step = steps.shift()
      if (!step) throw new Error('unexpected process runner call')
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step() : step
    }
  }
  return { runner, calls }
}

function assertPsCall(call: RunnerCall | undefined): void {
  expect(call?.argv).toEqual(PS_ARGV)
  expect(call?.options?.rerunnable).toBe(true)
  expect(call?.options?.env?.TZ).toBe('UTC0')
  expect(call?.options?.env?.LC_ALL).toBe('C')
}

const PARTIAL_MISMATCH = runResult(OTHER_START)
const incompleteReads: readonly [string, RunnerStep][] = [
  ['spawn error', runResult(OTHER_START, { spawnError: { code: 'ENOENT', message: 'ps unavailable' } })],
  ['timeout', runResult(OTHER_START, { stopped: 'timeout' })],
  ['abort', runResult(OTHER_START, { stopped: 'aborted' })],
  ['overflow', runResult(OTHER_START, { stopped: 'overflow' })],
  ['null exit code', runResult(OTHER_START, { exitCode: null })],
  ['null exit code with signal', runResult(OTHER_START, { exitCode: null, signal: 'SIGTERM' })],
  ['signal termination', runResult(OTHER_START, { signal: 'SIGTERM' })],
  ['runner rejection', new Error('runner disposed or pipe stalled')]
]

for (const [name, step] of incompleteReads) {
  test(`an incomplete identity read retains the lead after ${name}`, async () => {
    const { runner, calls } = fakeRunner(step)
    expect(await processAlive(PID, START, runner)).toBe(true)
    expect(calls).toHaveLength(1)
    assertPsCall(calls[0])
  })
}

describe('processAlive', () => {
  const completedReads: readonly [string, RunResult, boolean][] = [
    ['matching start', runResult('  Thu   Nov 12 12:00:00 2026  \n'), true],
    ['different start', runResult(OTHER_START), false],
    ['empty start', runResult(''), false],
    ['nonzero exit', runResult(START, { exitCode: 1 }), false]
  ]

  for (const [name, result, expected] of completedReads) {
    test(`uses the runner and interprets a completed ${name}`, async () => {
      const { runner, calls } = fakeRunner(result)
      expect(await processAlive(PID, START, runner)).toBe(expected)
      expect(calls).toHaveLength(1)
      assertPsCall(calls[0])
    })
  }

  test('passes the call-time parent environment with stable locale overrides', async () => {
    const key = 'QUIRKY_G2_10_PROCESS_ENV'
    const previous = process.env[key]
    process.env[key] = 'inherited-at-call-time'
    const expectedEnv = { ...process.env, TZ: 'UTC0', LC_ALL: 'C' }
    try {
      const { runner, calls } = fakeRunner(runResult(START))
      expect(await processAlive(PID, START, runner)).toBe(true)
      expect(calls[0]?.options?.env).toEqual(expectedEnv)
      expect(calls[0]?.options?.rerunnable).toBe(true)
      expect(calls[0]?.argv).toEqual(PS_ARGV)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  test('keeps signal-0 fast paths for dead, EPERM and unknown-start processes', async () => {
    killMode = 'dead'
    const dead = fakeRunner()
    expect(await processAlive(PID, START, dead.runner)).toBe(false)
    expect(dead.calls).toHaveLength(0)

    killMode = 'eperm'
    const permitted = fakeRunner(runResult(START))
    expect(await processAlive(PID, START, permitted.runner)).toBe(true)
    expect(permitted.calls).toHaveLength(1)
    assertPsCall(permitted.calls[0])

    killMode = 'alive'
    const unknownStart = fakeRunner()
    expect(await processAlive(PID, null, unknownStart.runner)).toBe(true)
    expect(unknownStart.calls).toHaveLength(0)
    expect(killCalls).toBe(3)
  })
})

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function nextTurn() {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}


function agentRow(sessionId = 's1', prompt = 'old prompt'): AgentRow {
  return {
    sessionId,
    agent: 'claude',
    state: 'working',
    prompt,
    detail: prompt,
    lead: {
      providerSession: 'abc',
      agentPid: PID,
      agentStart: START,
      ended: false,
      state: 'working',
      stateStartedAt: NOW
    },
    children: [],
    stateStartedAt: NOW,
    evidenceAt: NOW,
    turnStartedAt: NOW,
    lastHookAt: NOW,
    source: 'hook'
  }
}

function promptEvent(sessionId = 's1'): HookInput {
  return {
    source: 'claude',
    sessionId,
    payload: { session_id: 'xyz', prompt: 'new prompt' },
    event: 'UserPromptSubmit'
  }
}

function unknownEvent(sessionId: string): HookInput {
  return { source: 'unknown-agent', sessionId, payload: {} }
}

function terminalSession(id: string): Session {
  return {
    id,
    kind: 'terminal',
    agent: 'claude',
    worktreeId: 'wt1',
    cwd: '/fixture/workspace',
    title: 'Claude',
    status: 'running',
    createdAt: NOW,
    lastActivityAt: NOW,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    providerSession: { id: 'xyz', transcriptPath: null }
  }
}

function normalizerCache(): NormalizerCache {
  return new Map([
    [
      'claude',
      {
        prompt: 'old prompt',
        children: new Set<string>(),
        question: null,
        childWait: null,
        childApproval: null
      }
    ]
  ])
}

const services: AgentStatusService[] = []

function serviceFixture(options: {
  runner: ProcessRunner
  rows?: AgentRow[]
  sessions?: Session[]
  isAlive?: IsAlive
}) {
  const stored = new Map((options.rows ?? []).map((row) => [row.sessionId, row]))
  const sessionById = new Map((options.sessions ?? []).map((session) => [session.id, session]))
  const deleted: string[] = []
  const imported: AgentRow[] = []
  const retired: string[] = []
  const commits: { session: Session; row: AgentRow | null }[] = []
  const rpcCalls: { method: string; params?: Record<string, unknown> }[] = []
  const caches = new Map((options.rows ?? []).map((row) => [row.sessionId, normalizerCache()]))
  const rowStore = {
    get: (sessionId: string) => stored.get(sessionId) ?? null,
    all: () => [...stored.values()].map((row) => ({ row, updatedAt: NOW })),
    transaction<T>(work: () => T): T {
      return work()
    },
    put: (row: AgentRow) => stored.set(row.sessionId, row),
    delete: (sessionId: string) => {
      deleted.push(sessionId)
      stored.delete(sessionId)
    }
  }
  const activity = {
    sync: () => undefined,
    importRow: (row: AgentRow) => imported.push(row),
    retire: (sessionId: string) => retired.push(sessionId)
  }
  const context = {
    pluginId: 'quirky.agent-status',
    dir: '/fixture/plugin',
    home: '/fixture/home',
    dataDir: '/fixture/plugin-data',
    pty: {},
    process: options.runner,
    call: async (method: string, params: Record<string, unknown> = {}) => {
      rpcCalls.push({ method, params })
      if (method === 'quirky.session/list') return [...sessionById.values()]
      if (method === 'quirky.session/get') return sessionById.get(String(params.session)) ?? null
      return null
    },
    log: () => undefined,
    emit: () => true
  } as unknown as PluginContext
  const service = new AgentStatusService(
    context,
    rowStore as unknown as RowStore,
    activity as unknown as ActivityFeed,
    options.isAlive,
    () => NOW,
    { settleMs: 1, hookSilenceMs: 1, scale: 1 }
  )
  Object.assign(service, {
    caches,
    commit: async (session: Session, row: AgentRow | null) => {
      commits.push({ session, row })
      if (row) stored.set(session.id, row)
      else stored.delete(session.id)
    },
    capture: async () => undefined,
    attachFacet: () => undefined,
    watchProgram: () => undefined,
    watchTranscript: () => undefined,
    emitSettled: () => undefined
  })
  services.push(service)
  return {
    service,
    stored,
    deleted,
    imported,
    retired,
    commits,
    rpcCalls,
    caches
  }
}

describe('identity decisions and service liveness', () => {
  const foreignEvent: IdentityEvent = { source: 'claude', providerSession: 'xyz', movesLead: false }

  test('decideIdentity stays pending until asynchronous liveness resolves', async () => {
    const alive = deferred<boolean>()
    let settled = false
    const decision = decideIdentity(agentRow(), foreignEvent, NOW, () => alive.promise).then((verdict) => {
      settled = true
      return verdict
    })
    await nextTurn()
    expect(settled).toBe(false)
    alive.resolve(true)
    expect(await decision).toBe('ignore')

    const dead = deferred<boolean>()
    const replacing = decideIdentity(agentRow(), foreignEvent, NOW, () => dead.promise)
    dead.resolve(false)
    expect(await replacing).toBe('replace')
  })

  test('a held liveness read blocks same-session work but not another session', async () => {
    const held = deferred<RunResult>()
    const { runner, calls } = fakeRunner(() => held.promise)
    const oldRow = agentRow()
    const fixture = serviceFixture({
      runner,
      rows: [oldRow],
      sessions: [terminalSession('s1'), terminalSession('s2')]
    })
    let sameSessionDone = false
    let firstDone = false
    const first = fixture.service.ingest(promptEvent('s1')).then(() => {
      firstDone = true
    })
    const queued = fixture.service.ingest(unknownEvent('s1')).then(() => {
      sameSessionDone = true
    })
    const otherSession = fixture.service.ingest(promptEvent('s2'))

    await nextTurn()
    await otherSession
    expect(firstDone).toBe(false)
    expect(sameSessionDone).toBe(false)
    expect(calls).toHaveLength(1)
    assertPsCall(calls[0])
    expect(fixture.rpcCalls.filter((call) => call.method === 'quirky.session/get' && call.params?.session === 's1')).toHaveLength(1)
    expect(fixture.commits.map(({ session }) => session.id)).toEqual(['s2'])
    expect(fixture.stored.get('s1')).toEqual(oldRow)
    expect(fixture.stored.get('s2')?.prompt).toBe('new prompt')

    held.resolve(runResult(START))
    await Promise.all([first, queued])
    expect(firstDone).toBe(true)
    expect(sameSessionDone).toBe(true)
    expect(fixture.rpcCalls.filter((call) => call.method === 'quirky.session/get' && call.params?.session === 's1')).toHaveLength(2)
    expect(fixture.commits.map(({ session }) => session.id)).toEqual(['s2'])
  })

  test('get waits for queued Stop processing before reading its row', async () => {
    const pendingLiveness = deferred<boolean>()
    let livenessStarted = false
    const oldRow = { ...agentRow(), sessionBoundary: true }
    const fixture = serviceFixture({
      runner: fakeRunner().runner,
      rows: [oldRow, agentRow('s2')],
      sessions: [terminalSession('s1'), terminalSession('s2')],
      isAlive: () => {
        livenessStarted = true
        return pendingLiveness.promise
      }
    })
    const ingestion = fixture.service.ingest({
      source: 'claude',
      sessionId: 's1',
      event: 'Stop',
      payload: { session_id: 'abc', last_assistant_message: 'finished' }
    })
    await nextTurn()
    expect(livenessStarted).toBe(true)
    expect(fixture.stored.get('s1')?.sessionBoundary).toBe(true)

    let readSettled = false
    const read = fixture.service.get('s1').then((row) => {
      readSettled = true
      return row
    })
    await nextTurn()
    expect(readSettled).toBe(false)

    let otherReadSettled = false
    const otherRead = fixture.service.get('s2').then((row) => {
      otherReadSettled = true
      return row
    })
    await nextTurn()
    expect(otherReadSettled).toBe(true)
    expect((await otherRead)?.sessionId).toBe('s2')

    pendingLiveness.resolve(true)
    await ingestion
    const postStopRow = await read
    expect(postStopRow?.state).toBe('done')
    expect(postStopRow?.sessionBoundary).toBeUndefined()
  })

  for (const answer of [true, false]) {
    test(`presence sweep awaits liveness=${answer} before changing rows`, async () => {
      const pending = deferred<boolean>()
      const fixture = serviceFixture({
        runner: fakeRunner().runner,
        rows: [agentRow()],
        isAlive: () => pending.promise
      })
      let settled = false
      const sweep = fixture.service.sweepPresence().then(() => {
        settled = true
      })
      await nextTurn()
      expect(settled).toBe(false)
      expect(fixture.stored.has('s1')).toBe(true)
      expect(fixture.deleted).toEqual([])
      pending.resolve(answer)
      await sweep
      if (answer) {
        expect(fixture.stored.has('s1')).toBe(true)
        expect(fixture.deleted).toEqual([])
        expect(fixture.imported).toEqual([])
        expect(fixture.retired).toEqual([])
      } else {
        expect(fixture.stored.has('s1')).toBe(false)
        expect(fixture.deleted).toEqual(['s1'])
        expect(fixture.imported).toHaveLength(1)
        expect(fixture.retired).toEqual(['s1'])
      }
    })
  }

  test('shutdown while ingestion awaits liveness prevents replacement', async () => {
    const held = deferred<RunResult>()
    const { runner, calls } = fakeRunner(() => held.promise)
    const oldRow = agentRow()
    const fixture = serviceFixture({ runner, rows: [oldRow], sessions: [terminalSession('s1')] })
    const cache = fixture.caches.get('s1')!
    const priorCache = structuredClone(cache)
    const ingestion = fixture.service.ingest(promptEvent())
    await nextTurn()
    expect(calls).toHaveLength(1)
    fixture.service.shutdown()
    held.resolve(runResult(OTHER_START))
    await ingestion
    expect(fixture.stored.get('s1')).toEqual(oldRow)
    expect(fixture.commits).toEqual([])
    expect(cache).toEqual(priorCache)
  })

  test('shutdown while a presence sweep awaits liveness prevents retirement', async () => {
    const held = deferred<RunResult>()
    const { runner, calls } = fakeRunner(() => held.promise)
    const oldRow = agentRow()
    const fixture = serviceFixture({ runner, rows: [oldRow] })
    const sweeping = fixture.service.sweepPresence()
    await nextTurn()
    expect(calls).toHaveLength(1)
    fixture.service.shutdown()
    held.resolve(runResult(OTHER_START))
    await sweeping
    expect(fixture.stored.get('s1')).toEqual(oldRow)
    expect(fixture.caches.has('s1')).toBe(true)
    expect(fixture.commits).toEqual([])
    expect(fixture.deleted).toEqual([])
    expect(fixture.imported).toEqual([])
    expect(fixture.retired).toEqual([])
  })
})

for (const [name, incomplete] of incompleteReads) {
  test(`presence retains row and cache after incomplete ${name}, then reprobes a completed mismatch`, async () => {
    const { runner, calls } = fakeRunner(incomplete, PARTIAL_MISMATCH)
    const row = agentRow()
    const fixture = serviceFixture({ runner, rows: [row] })
    const cache = fixture.caches.get('s1')!
    const priorCache = structuredClone(cache)

    await fixture.service.sweepPresence()
    expect(calls).toHaveLength(1)
    assertPsCall(calls[0])
    expect(fixture.stored.get('s1')).toEqual(row)
    expect(cache).toEqual(priorCache)
    expect(fixture.commits).toEqual([])
    expect(fixture.imported).toEqual([])
    expect(fixture.retired).toEqual([])
    expect(fixture.deleted).toEqual([])

    await fixture.service.sweepPresence()
    expect(calls).toHaveLength(2)
    assertPsCall(calls[1])
    expect(fixture.stored.has('s1')).toBe(false)
    expect(fixture.deleted).toEqual(['s1'])
    expect(fixture.imported).toHaveLength(1)
    expect(fixture.retired).toEqual(['s1'])
  })

  test(`foreign ingestion retains old row and cache after incomplete ${name}, then replaces on a completed mismatch`, async () => {
    const { runner, calls } = fakeRunner(incomplete, PARTIAL_MISMATCH)
    const row = agentRow()
    const fixture = serviceFixture({ runner, rows: [row], sessions: [terminalSession('s1')] })
    const cache = fixture.caches.get('s1')!
    const priorCache = structuredClone(cache)

    await fixture.service.ingest(promptEvent())
    expect(calls).toHaveLength(1)
    assertPsCall(calls[0])
    expect(fixture.stored.get('s1')).toEqual(row)
    expect(fixture.commits).toEqual([])
    expect(cache).toEqual(priorCache)

    await fixture.service.ingest(promptEvent())
    expect(calls).toHaveLength(2)
    assertPsCall(calls[1])
    expect(fixture.commits).toHaveLength(1)
    expect(fixture.commits[0]?.row?.prompt).toBe('new prompt')
    expect(fixture.stored.get('s1')?.prompt).toBe('new prompt')
    expect(fixture.stored.get('s1')?.lead.providerSession).toBe('xyz')
  })
}
