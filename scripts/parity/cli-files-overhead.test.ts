import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCliFilesWorld, type CliFilesWorld } from './cli-world'
import { createTimingLedger, formatTimingLine, runCliFilesParity, type CliFileObservationTiming, type CliFilesTiming } from './cli-files'

type WorldFactory = (options?: { signal?: AbortSignal; deadline?: number }, dependencies?: Record<string, unknown>) => Promise<CliFilesWorld>
const createWorld = createCliFilesWorld as unknown as WorldFactory

type TestState = {
  livePids: Set<number>
  daemonState: string
  daemonStarted: string
  browserStarted: string
  runtimePid: number
  runtimePort: number
  connIds: number[]
  pageClosed: boolean[]
  includeChild: boolean
  probeHealthy: boolean
  onUiState?: () => void
}

type TestCounts = { snapshots: number; probes: number; uiState: number; finish: number; liveness: number; cli: number }

function cliFilesStandIns(options: { liveness?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-files-overhead-')))
  const repoRoot = resolve(import.meta.dir, '../..')
  const uiDir = join(home, 'ui-dist')
  const fixtureBin = join(home, 'fixture-bin')
  const fetchPreload = join(home, 'fetch-preload.cjs')
  const worktrees = [
    { id: 'wt-a', path: join(home, 'repos', 'a'), repoId: 'repo-a', name: 'a', isMain: false, status: 'idle' },
    { id: 'wt-b', path: join(home, 'repos', 'b'), repoId: 'repo-b', name: 'b', isMain: false, status: 'idle' }
  ]
  for (const worktree of worktrees) mkdirSync(worktree.path, { recursive: true })

  const events: string[] = []
  const counts: TestCounts = { snapshots: 0, probes: 0, uiState: 0, finish: 0, liveness: 0, cli: 0 }
  const state: TestState = {
    livePids: new Set(),
    daemonState: 'S',
    daemonStarted: 'daemon-701',
    browserStarted: 'browser-801',
    runtimePid: 701,
    runtimePort: 43123,
    connIds: [41, 42],
    pageClosed: [false, false],
    includeChild: false,
    probeHealthy: true
  }
  const records = [
    { index: 0, connId: 41, worktree: 'wt-a', open: true },
    { index: 1, connId: 42, worktree: 'wt-b', open: true }
  ]
  const pages = [
    { isClosed: () => state.pageClosed[0]! },
    { isClosed: () => state.pageClosed[1]! }
  ]
  const windows: Record<string, unknown> = {
    pages,
    browserPid: 801,
    finish: async () => {
      counts.finish++
      events.push('finish')
      return { records: records.map((record) => ({ ...record })), requests: [] }
    },
    stop: async () => { state.livePids.delete(801) }
  }
  if (options.liveness !== false) {
    windows.liveness = () => {
      counts.liveness++
      events.push('liveness')
      return records.map(({ index, connId, worktree, open }) => ({ index, connId, worktree, open }))
    }
  }

  const soakEnv: Record<string, string> = {}
  const soakWorld = {
    home,
    runtime: { pid: 701, port: 43123, token: 'fixture-token', hookToken: 'fixture-hook-token', entryHash: 'fixture-entry' },
    get daemonPid() { return state.runtimePid },
    env: soakEnv,
    workers: [],
    ptyHostPid: () => null,
    updatePtyHostPid: () => {},
    fixtures: { worktrees },
    control: {
      callAny: async (method: string) => {
        if (method !== 'ui.state') throw new Error(`unexpected soak RPC ${method}`)
        counts.uiState++
        events.push('ui.state')
        state.onUiState?.()
        return { windows: state.connIds.map((connId) => ({ connId })) }
      },
      close: () => {}
    },
    track: () => {},
    stop: async () => { state.livePids.delete(701) }
  }

  const processSnapshot = () => {
    counts.snapshots++
    events.push('snapshot')
    const snapshot = new Map<number, { pid: number; ppid: number; pgid: number; started: string; state: string; command: string }>()
    if (state.livePids.has(701)) snapshot.set(701, {
      pid: 701, ppid: process.pid, pgid: process.pid, started: state.daemonStarted,
      state: state.daemonState, command: 'quirky-daemon'
    })
    if (state.livePids.has(801)) snapshot.set(801, {
      pid: 801, ppid: process.pid, pgid: process.pid, started: state.browserStarted,
      state: 'S', command: 'chromium'
    })
    if (state.includeChild && state.livePids.has(701)) snapshot.set(905, {
      pid: 905, ppid: 701, pgid: 701, started: 'child-905', state: 'S', command: 'git status'
    })
    return snapshot
  }
  const cliCalls: string[][] = []
  const dependencies: Record<string, unknown> = {
    repoRoot,
    createScope: () => ({
      home,
      env: { QUIRKY_HOME: home, QUIRKY_TEST_SCOPE: 'overhead-test-scope' },
      spawn: () => { throw new Error('stand-in must not spawn an arbitrary process') },
      track: () => {},
      cleanup: async () => {},
      killNow: () => {}
    }),
    installCliFixtureTools: () => ({ fixtureBin, fetchPreload }),
    createCliEnvironment: () => ({
      HOME: home, QUIRKY_HOME: home, QUIRKY_PORT: '0', QUIRKY_AGENT_SEARCH_DIRS: '',
      PATH: `${fixtureBin}:/usr/bin:/bin`, BUN_OPTIONS: `--preload=${fetchPreload}`,
      QUIRKY_CLI_ENTRY: join(repoRoot, 'packages/cli/src/main.ts')
    }),
    verifyEgressGuard: async () => {},
    prepareCaptureFixtureHome: async () => ({ ready: true }),
    registerCaptureFixtures: async () => ({ worktrees }),
    startWorld: async (_start: Record<string, unknown>, startDependencies: Record<string, unknown>) => {
      const prepare = startDependencies.prepareCaptureFixtureHome as ((ownedHome: string, options: { env: Record<string, string> }) => Promise<unknown>)
      const helperEnv = {
        HOME: '/poison/home', QUIRKY_HOME: home, QUIRKY_UI_DIR: uiDir,
        QUIRKY_PORT: '1234', QUIRKY_AGENT_SEARCH_DIRS: '/poison/agents', PATH: '/poison/bin'
      }
      await prepare(home, { env: helperEnv })
      mkdirSync(uiDir, { recursive: true })
      Object.assign(soakEnv, helperEnv)
      state.livePids.add(701)
      return soakWorld
    },
    openWindows: async () => {
      state.livePids.add(801)
      return windows
    },
    findChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    readRuntime: () => ({
      pid: state.runtimePid, home, port: state.runtimePort,
      token: 'fixture-token', hookToken: 'fixture-hook-token', entryHash: 'fixture-entry'
    }),
    isDaemonAlive: async () => {
      counts.probes++
      events.push('probe')
      return state.probeHealthy && state.livePids.has(701)
    },
    processSnapshot,
    runCli: async (argv: string[]) => {
      counts.cli++
      events.push('cli')
      cliCalls.push([...argv])
      return { stdout: '{"ok":true}', stderr: '', exitCode: 0, stdoutBytes: 11, elapsedMs: 1 }
    },
    runPreparation: async () => ({ stdout: '', stderr: '', exitCode: 0, stdoutBytes: 0, elapsedMs: 1 })
  }
  let clock = 0
  const installFakeClock = () => {
    dependencies.now = () => clock
    dependencies.sleep = async (milliseconds: number) => { clock += milliseconds }
    return { now: () => clock }
  }
  const resetPerCallEvidence = () => {
    events.length = 0
    for (const key of Object.keys(counts) as (keyof TestCounts)[]) counts[key] = 0
    state.onUiState = undefined
  }
  return { home, events, counts, state, dependencies, cliCalls, installFakeClock, resetPerCallEvidence }
}

function cliArgv(world: CliFilesWorld): string[] {
  return [process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']
}

async function failureOf(promise: Promise<unknown>): Promise<Error & { kind?: string; stderrTail?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { kind?: string; stderrTail?: string }
  }
  throw new Error('expected operation to reject')
}

test('one CLI call probes, checks UI state and renderer liveness, snapshots, then starts the child', async () => {
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  try {
    fixture.resetPerCallEvidence()
    await world.execute(cliArgv(world))
    expect(fixture.events).toEqual(['probe', 'ui.state', 'liveness', 'snapshot', 'cli'])
    expect(fixture.counts).toEqual({ snapshots: 1, probes: 1, uiState: 1, finish: 0, liveness: 1, cli: 1 })
    expect(fixture.cliCalls).toHaveLength(1)
  } finally {
    await world.cleanup()
  }
})

type MutationCase = {
  name: string
  kind: string
  message: string
  mutate(state: TestState): () => void
}

const rendererAwaitMutations: MutationCase[] = [
  {
    name: 'daemon disappearance', kind: 'daemon-identity', message: 'owned daemon process is not present in the process table',
    mutate: (state) => { state.livePids.delete(701); return () => { state.livePids.add(701) } }
  },
  {
    name: 'daemon PID reuse', kind: 'daemon-identity', message: 'owned daemon process identity changed',
    mutate: (state) => { state.daemonStarted = 'reused-daemon-701'; return () => { state.daemonStarted = 'daemon-701' } }
  },
  {
    name: 'browser disappearance', kind: 'renderer-disconnected', message: 'owned browser process is not present in the process table',
    mutate: (state) => { state.livePids.delete(801); return () => { state.livePids.add(801) } }
  },
  {
    name: 'browser PID reuse', kind: 'renderer-disconnected', message: 'owned browser process identity changed',
    mutate: (state) => { state.browserStarted = 'reused-browser-801'; return () => { state.browserStarted = 'browser-801' } }
  },
  {
    name: 'daemon becomes a zombie', kind: 'daemon-exited', message: 'owned daemon is not healthy; refusing CLI auto-start',
    mutate: (state) => { state.daemonState = 'Z'; return () => { state.daemonState = 'S' } }
  },
  {
    name: 'runtime port changes', kind: 'daemon-exited', message: 'owned daemon is not healthy; refusing CLI auto-start',
    mutate: (state) => { state.runtimePort = 43124; return () => { state.runtimePort = 43123 } }
  }
]

for (const mutation of rendererAwaitMutations) {
  test(`CLI call refuses ${mutation.name} while ui.state is pending`, async () => {
    const fixture = cliFilesStandIns()
    const world = await createWorld({}, fixture.dependencies)
    let restore = () => {}
    try {
      fixture.resetPerCallEvidence()
      fixture.state.onUiState = () => {
        fixture.state.onUiState = undefined
        restore = mutation.mutate(fixture.state)
      }
      await expect(world.execute(cliArgv(world))).rejects.toMatchObject({ kind: mutation.kind, message: mutation.message })
      expect(fixture.cliCalls).toEqual([])
    } finally {
      restore()
      await world.cleanup()
    }
  })
}

test('a missing daemon fails health checking after at most one probe and one snapshot', async () => {
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  try {
    fixture.resetPerCallEvidence()
    fixture.state.livePids.delete(701)
    const error = await failureOf(world.execute(cliArgv(world)))
    expect(error).toMatchObject({ kind: 'daemon-exited', message: 'owned daemon is not healthy; refusing CLI auto-start' })
    expect(fixture.counts.probes).toBeLessThanOrEqual(1)
    expect(fixture.counts.snapshots).toBeLessThanOrEqual(1)
    expect(fixture.cliCalls).toEqual([])
  } finally {
    fixture.state.livePids.add(701)
    await world.cleanup()
  }
})

test('a five-second health refusal includes bounded probe diagnostics', async () => {
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  try {
    fixture.resetPerCallEvidence()
    const clock = fixture.installFakeClock()
    fixture.state.probeHealthy = false
    const error = await failureOf(world.execute(cliArgv(world)))
    expect(error).toMatchObject({ kind: 'daemon-exited', message: 'owned daemon is not healthy; refusing CLI auto-start' })
    const diagnostic = JSON.parse(error.stderrTail ?? 'null')
    expect(diagnostic).toMatchObject({ probes: 100, windowMs: 5_000, daemonState: 'S', runtimeMatches: true })
    expect(Number.isInteger(diagnostic.lastProbeMs)).toBe(true)
    expect(diagnostic.lastProbeMs).toBeGreaterThanOrEqual(0)
    expect(Buffer.byteLength(error.stderrTail ?? '')).toBeLessThanOrEqual(1_024)
    expect(clock.now()).toBe(5_000)
    expect(fixture.counts.probes).toBe(100)
    expect(fixture.counts.snapshots).toBe(100)
    expect(fixture.cliCalls).toEqual([])
  } finally {
    fixture.state.probeHealthy = true
    await world.cleanup()
  }
})

test('startup health refusal keeps the same bounded probe diagnostics', async () => {
  const fixture = cliFilesStandIns()
  const clock = fixture.installFakeClock()
  fixture.state.probeHealthy = false
  const error = await failureOf(createWorld({}, fixture.dependencies))
  expect(error).toMatchObject({ kind: 'daemon-exited', message: 'owned daemon did not remain healthy after startup' })
  const diagnostic = JSON.parse((error as Error & { stderrTail?: string }).stderrTail ?? 'null')
  expect(diagnostic).toMatchObject({ probes: 100, windowMs: 5_000, daemonState: 'S', runtimeMatches: true })
  expect(Number.isInteger(diagnostic.lastProbeMs)).toBe(true)
  expect(Buffer.byteLength((error as Error & { stderrTail?: string }).stderrTail ?? '')).toBeLessThanOrEqual(1_024)
  expect(clock.now()).toBe(5_000)
})

test('the final ownership snapshot tracks a daemon child', async () => {
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  try {
    fixture.resetPerCallEvidence()
    fixture.state.onUiState = () => { fixture.state.includeChild = true }
    await world.execute(cliArgv(world))
    fixture.state.includeChild = false
    await world.cleanup()
    expect(world.cleanupEvidence.trackedIdentities).toContainEqual(expect.objectContaining({ kind: 'daemon-child', pid: 905 }))
  } finally {
    fixture.state.includeChild = false
    await world.cleanup()
  }
})

test('an injected window handle without liveness falls back to finish', async () => {
  const fixture = cliFilesStandIns({ liveness: false })
  const world = await createWorld({}, fixture.dependencies)
  try {
    fixture.resetPerCallEvidence()
    await world.execute(cliArgv(world))
    expect(fixture.counts).toEqual({ snapshots: 1, probes: 1, uiState: 1, finish: 1, liveness: 0, cli: 1 })
  } finally {
    await world.cleanup()
  }
})

type TimedPhase = CliFileObservationTiming & { elapsedMs: number }

test('timing ledger accounts for child, harness, and DOM-wait time', () => {
  let now = 0
  const ledger = createTimingLedger(() => now)
  ledger.begin('files-review-source')
  ledger.recordCli(1_000, 700)
  ledger.recordCli(2_000, 1_500)
  ledger.recordCli(500, 400)
  ledger.recordDomWait(250)
  ledger.recordDomWait(750)
  now = 4_600

  const timing: TimedPhase = ledger.end()
  expect(timing).toEqual({ cliCalls: 3, cliChildMs: 2_600, harnessMs: 900, domWaitMs: 1_000, elapsedMs: 4_600 })
  expect(formatTimingLine('files-review-source', 'observed', timing))
    .toBe('files-review-source observed in 4.6 s: 3 CLI calls, 2.6 s in CLI children, 0.9 s in harness checks, 1.0 s waiting for renderers')
  expect(formatTimingLine('files-review-source', 'failed', timing))
    .toBe('files-review-source failed after 4.6 s: 3 CLI calls, 2.6 s in CLI children, 0.9 s in harness checks, 1.0 s waiting for renderers')
  expect(formatTimingLine('setup', 'finished', timing))
    .toBe('setup finished in 4.6 s: 3 CLI calls, 2.6 s in CLI children, 0.9 s in harness checks, 1.0 s waiting for renderers')
})

test('timing ledger summarizes setup, all observations, teardown, and their work', () => {
  let now = 0
  const ledger = createTimingLedger(() => now)
  ledger.begin('setup')
  now = 100
  ledger.end()
  ledger.begin('files-first')
  ledger.recordCli(20, 8)
  ledger.recordDomWait(4)
  now = 130
  ledger.end()
  ledger.begin('files-second')
  now = 150
  ledger.end()
  ledger.begin('teardown')
  now = 175
  ledger.end()

  const summary: CliFilesTiming = ledger.summary()
  expect(summary).toEqual({
    setupMs: 100, observationsMs: 50, teardownMs: 25,
    cliCalls: 1, cliChildMs: 8, harnessMs: 12, domWaitMs: 4
  })
})

test('setup health failures retain bounded detail in the report and progress', async () => {
  const detail = JSON.stringify({ probes: 100, windowMs: 5_000, lastProbeMs: 1, daemonState: 'S', runtimeMatches: true })
  const message = 'owned daemon is not healthy; refusing CLI auto-start'
  const failure = Object.assign(new Error(message), { kind: 'daemon-exited', stderrTail: detail })
  const progress: string[] = []
  const report = await runCliFilesParity({
    createWorld: async () => { throw failure },
    onProgress: (line) => { progress.push(line) }
  })
  expect(report.error).toEqual({ stage: 'setup', kind: 'daemon-exited', message, detail })
  expect(progress).toContain(`setup failed: ${message} (${detail})`)
  expect(progress.some((line) => line.startsWith('setup failed after '))).toBe(true)
})

test('setup report detail is bounded to the diagnostic limit', async () => {
  const failure = Object.assign(new Error('injected startup failure'), {
    kind: 'startup-failed',
    stderrTail: 'd'.repeat(9_000)
  })
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  expect(Buffer.byteLength(report.error?.detail ?? '')).toBeLessThanOrEqual(8 * 1_024)
})

test('a run failing after two CLI calls counts exactly its registered receipts', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-files-timing-')))
  try {
    mkdirSync(join(home, 'ui-dist'), { recursive: true })
    writeFileSync(join(home, 'ui-dist', 'index.html'), '<!doctype html>')
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({
      pid: process.pid, port: 43_123, token: 'timing-token', hookToken: 'timing-hook-token',
      daemonVersion: 'test', protocolVersion: 1, startedAt: Date.now()
    }))
    const worktrees = [
      { id: 'wt-a', path: join(home, 'repos', 'a'), repoId: 'repo-a', name: 'a', isMain: false, status: 'idle' },
      { id: 'wt-b', path: join(home, 'repos', 'b'), repoId: 'repo-b', name: 'b', isMain: false, status: 'idle' }
    ]
    for (const worktree of worktrees) mkdirSync(worktree.path, { recursive: true })
    const securityLog = join(home, 'security.log')
    const orcaLog = join(home, 'orca.log')
    const egressLog = join(home, 'egress.log')
    writeFileSync(securityLog, '')
    writeFileSync(orcaLog, '')
    writeFileSync(egressLog, 'https://cli-parity-guard.invalid/self-test\n')
    const trackedIdentities = [
      { kind: 'daemon', pid: process.pid, ppid: process.pid, pgid: process.pid, started: 'daemon', command: 'packages/daemon/src/main.ts', gone: true },
      { kind: 'browser', pid: process.pid + 1, ppid: process.pid, pgid: process.pid, started: 'browser', command: 'Chromium', gone: true }
    ]
    let calls = 0
    const world = {
      home,
      env: { QUIRKY_HOME: home },
      daemonPid: process.pid,
      cliEntry: process.execPath,
      pages: [{ isClosed: () => false }, { isClosed: () => false }],
      records: [
        { index: 0, connId: 41, worktree: 'wt-a', open: true, shown: true },
        { index: 1, connId: 42, worktree: 'wt-b', open: true, shown: true }
      ],
      worktrees,
      tools: { fixtureBin: join(home, 'bin'), fetchPreload: join(home, 'preload.cjs'), securityLog, orcaLog, egressLog },
      buildElapsedMs: 0,
      cleanupEvidence: {
        trackedIdentities,
        identities: trackedIdentities.map(({ kind, pid, gone }) => ({ kind, pid, gone })),
        processIdentitiesGone: true,
        homeRemoved: true
      },
      execute: async () => {
        calls++
        if (calls === 1) {
          const stdout = JSON.stringify({ windows: [{ connId: 41 }, { connId: 42 }] })
          return { stdout, stderr: '', exitCode: 0, stdoutBytes: Buffer.byteLength(stdout), elapsedMs: 10 }
        }
        throw Object.assign(new Error('injected failure after two CLI calls'), {
          kind: 'injected-cli-failure', exitCode: 1, stdoutBytes: 0, elapsedMs: 25, stderrTail: 'injected failure'
        })
      },
      assertLive: async () => { throw new Error('stop cleanup after setup failure') },
      cleanup: async () => { rmSync(home, { recursive: true, force: true }) }
    } as unknown as CliFilesWorld
    const report = await runCliFilesParity({ createWorld: async () => world })
    expect(calls).toBe(2)
    const timing: CliFilesTiming | undefined = report.timing
    expect(timing?.cliCalls).toBe(report.receipts.length)
    expect(timing?.cliCalls).toBe(2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
