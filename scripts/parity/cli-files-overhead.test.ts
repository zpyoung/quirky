import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCliFilesWorld, type CliFilesWorld } from './cli-world'

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
