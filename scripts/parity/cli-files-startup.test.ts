import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import * as cliWorldModule from './cli-world'
import { getProcessInspectionMetadata, type CliFilesWorld } from './cli-world'
import { CliFilesRunner, runCliFilesParity } from './cli-files'
import { CLI_FILES_LIMITS } from './cli-files-limits'

type ProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  started: string
  state: string
  command: string
}
type StartupObservation = {
  stage: string
  elapsedMs: number
  index?: number
  worktree?: string
  connId?: number
  browserPid?: number
  message?: string
  pageErrors?: string[]
  failedRequests?: Array<{ path: string; message: string }>
}
type ProcessInspectionMetadata = {
  spawnErrorCode: string | null
  spawnErrorName: string | null
  exitStatus: number | null
  signal: string | null
  stdoutWasString: boolean
  stdoutBytes: number | null
  timeoutHit: boolean
  maxBufferHit: boolean
  timeoutMs: number
  maxBufferBytes: number
}
type StartupDiagnostics = {
  phase: string
  elapsedMs: number
  buildElapsedMs: number
  rendererElapsedMs: number
  assets?: { uiDir: string; pluginsDir: string }
  renderer: StartupObservation[]
  logs: { buildTail?: string; daemonTail?: string; rendererTail?: string }
  processInspection?: ProcessInspectionMetadata
}
type StartupEvidence = {
  diagnostics: StartupDiagnostics
  cleanup: {
    ok: boolean
    error?: string
    evidence: {
      trackedIdentities: Array<{
        kind: string
        pid: number
        ppid: number
        pgid: number
        started: string
        command: string
        gone: boolean
      }>
      identities: Array<{ kind: string; pid: number; gone: boolean }>
      processIdentitiesGone: boolean
      processInspection?: ProcessInspectionMetadata
      homeRemoved: boolean
      started: { daemon: boolean; browser: boolean }
      unresolvedAcquisition: boolean
      scopeCleanupComplete: boolean
      acquisitionSettled: boolean
    }
  }
}
type CliFilesStartupError = Error & {
  kind: string
  cleanupError?: string
  startupEvidence: StartupEvidence
  processInspection?: ProcessInspectionMetadata
}
type StartupErrorConstructor = new (kind: string, message: string, evidence: StartupEvidence, stderrTail?: string) => CliFilesStartupError
type FakeChild = { pid: number; exited: Promise<number> }
type FakeScope = {
  home: string
  env: Record<string, string>
  spawn(command: string[], options?: { env?: Record<string, string> }): FakeChild
  cleanup(env?: Record<string, string>): Promise<void>
  killNow(): void
  track(pid: number): void
}
type Factory = (options?: { signal?: AbortSignal; deadline?: number }, dependencies?: Record<string, unknown>) => Promise<CliFilesWorld>
const cliWorldNamespace = cliWorldModule as unknown as {
  createCliFilesWorld?: Factory
  CliFilesStartupError?: StartupErrorConstructor
}

function requireFactory(): Factory {
  if (!cliWorldNamespace.createCliFilesWorld) throw new Error('createCliFilesWorld is not exported')
  return cliWorldNamespace.createCliFilesWorld
}


function captureFailure<T>(promise: Promise<T>): Promise<Error & {
  kind?: string
  startupEvidence?: StartupEvidence
  processInspection?: ProcessInspectionMetadata
}> {
  return promise.then(
    () => { throw new Error('expected startup construction to reject') },
    (error: unknown) => error instanceof Error
      ? error as Error & { kind?: string; startupEvidence?: StartupEvidence; processInspection?: ProcessInspectionMetadata }
      : new Error(String(error))
  )
}
function daemonIdentity() {
  return {
    kind: 'daemon', pid: 701, ppid: 1, pgid: 701, started: 'owned-start-701',
    command: '<cli-home>/packages/daemon/src/main.ts', gone: true
  }
}

function browserIdentity() {
  return {
    kind: 'browser', pid: 801, ppid: 1, pgid: 801, started: 'owned-start-801',
    command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', gone: true
  }
}

function validStartupEvidence(options: { daemon?: boolean; browser?: boolean } = {}): StartupEvidence {
  const started = { daemon: options.daemon ?? true, browser: options.browser ?? false }
  const trackedIdentities = [
    ...(started.daemon ? [daemonIdentity()] : []),
    ...(started.browser ? [browserIdentity()] : [])
  ]
  return {
    diagnostics: {
      phase: 'renderer',
      elapsedMs: 59,
      buildElapsedMs: 37,
      rendererElapsedMs: 19,
      assets: { uiDir: '<cli-home>/ui-dist', pluginsDir: '<cli-home>/builtin-plugins' },
      renderer: [{ stage: 'navigation', elapsedMs: 8, index: 0, ...(started.browser ? { browserPid: 801 } : {}), message: 'local renderer navigation failed' }],
      logs: { buildTail: 'λ build tail', daemonTail: 'daemon tail' }
    },
    cleanup: {
      ok: true,
      evidence: {
        trackedIdentities,
        identities: trackedIdentities.map(({ kind, pid, gone }) => ({ kind, pid, gone })),
        processIdentitiesGone: true,
        homeRemoved: true,
        started,
        unresolvedAcquisition: false,
        scopeCleanupComplete: true,
        acquisitionSettled: true
      }
    }
  }
}

function typedStartupError(evidence: StartupEvidence, kind = 'renderer-disconnected', message = 'startup renderer failed'): CliFilesStartupError {
  expect(cliWorldNamespace.CliFilesStartupError).toBeDefined()
  if (!cliWorldNamespace.CliFilesStartupError) throw new Error('CliFilesStartupError is not exported')
  return new cliWorldNamespace.CliFilesStartupError(kind, message, evidence)
}

function privatePluginAlias(home: string): string {
  const aliasHome = home.replace(/^\/private(?=\/)/, '')
  return `${aliasHome}/../home/builtin-plugins/`
}

function makeFactoryFixture(options: {
  pluginAlias?: string | ((home: string) => string)
  homeAlias?: (home: string) => string
  symlinkEscape?: boolean
  danglingPluginSymlink?: boolean
  scopeCreationFailure?: boolean
  guardFailure?: boolean
  fixtureFailure?: boolean
  buildFailure?: boolean
  chromeMissing?: boolean
  rendererFailure?: boolean
  processTableFailure?: boolean
  survivor?: boolean
  buildSurvivor?: boolean
  missingBuildRoot?: boolean
  longAuthenticatedLog?: boolean
  reuseBuildPid?: boolean
  reuseDaemonPid?: boolean
  worldStopFailure?: boolean
  uiStateFailure?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cli-files-startup-'))
  const homePath = join(root, 'home')
  mkdirSync(homePath)
  const home = realpathSync(homePath)
  const uiDir = join(home, 'ui-dist')
  const pluginsDir = join(home, 'builtin-plugins')
  const outDir = join(home, 'out')
  const fixtureBin = join(home, 'fixture-bin')
  const fetchPreload = join(home, 'fetch-preload.cjs')
  const repoRoot = realpathSync(join(import.meta.dir, '../..'))
  const events: string[] = []
  const state = {
    livePids: new Set<number>(),
    runtimeWritten: false,
    failProcessTable: false,
    reusedDaemonPid: false,
    reusedBuildPid: false,
    helperEnv: undefined as Record<string, string> | undefined,
    preparedEnv: undefined as Record<string, string> | undefined,
    buildEnv: undefined as Record<string, string> | undefined,
    daemonEnv: undefined as Record<string, string> | undefined,
    lastObservation: undefined as StartupObservation | undefined,
    processSnapshotCalls: 0,
    shownRecordChecks: 0,
    shownConnectionChecks: 0
  }
  const worktrees = [
    { id: 'wt-a', path: join(home, 'repos', 'a'), repoId: 'repo-a', name: 'a', isMain: false, status: 'idle' },
    { id: 'wt-b', path: join(home, 'repos', 'b'), repoId: 'repo-b', name: 'b', isMain: false, status: 'idle' }
  ]
  for (const worktree of worktrees) mkdirSync(worktree.path, { recursive: true })
  const pages = [{ isClosed: () => false }, { isClosed: () => false }]
  const records = [
    { index: 0, connId: 41, worktree: 'wt-a', open: true, shown: true, lastRequestAgeSeconds: 0, requests: 1, sockets: 1, pageErrors: 0, pageErrorExamples: [] },
    { index: 1, connId: 42, worktree: 'wt-b', open: true, shown: true, lastRequestAgeSeconds: 0, requests: 1, sockets: 1, pageErrors: 0, pageErrorExamples: [] }
  ]
  const windows = {
    pages,
    browserPid: 801,
    finish: async () => {
      state.shownRecordChecks += 1
      return { records: records.map(record => ({ ...record })), requests: [] }
    },
    stop: async () => {
      events.push('browser.stop')
      state.livePids.delete(801)
    }
  }
  const currentIdentity = (pid: number): ProcessIdentity => {
    if (pid === 701 && state.reusedDaemonPid) {
      return { pid, ppid: 1, pgid: 1, started: 'unrelated-reused-pid', state: 'S', command: '/usr/bin/unrelated-sentinel' }
    }
    if (pid === 702 && state.reusedBuildPid) {
      return { pid, ppid: 1, pgid: 702, started: 'unrelated-reused-build-pid', state: 'S', command: '/usr/bin/unrelated-build-sentinel' }
    }
    return {
      pid,
      ppid: pid === 703 ? (state.livePids.has(702) ? 702 : 1) : process.pid,
      pgid: pid === 702 || pid === 703 ? 702 : process.pid,
      started: `owned-start-${pid}`,
      state: 'S',
      command: pid === 701 ? `${process.execPath} packages/daemon/src/main.ts`
        : pid === 702 ? `${process.execPath} packages/ui/build.ts`
          : pid === 703 ? `${process.execPath} packages/ui/build-worker.ts`
            : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    }
  }
  const processSnapshot = (_ownedHome: string): Map<number, ProcessIdentity> => {
    state.processSnapshotCalls += 1
    if (state.failProcessTable) throw new Error('recording process table unavailable')
    const pids = new Set(state.livePids)
    if (state.reusedDaemonPid) pids.add(701)
    if (state.reusedBuildPid) pids.add(702)
    return new Map([...pids]
      .filter(pid => !(options.missingBuildRoot && pid === 702))
      .map(pid => [pid, currentIdentity(pid)]))
  }
  const clearScopeProcesses = () => {
    for (const pid of [...state.livePids]) {
      if ((options.survivor && pid === 701) || (options.buildSurvivor && pid === 703)) continue
      state.livePids.delete(pid)
    }
  }
  const scope: FakeScope = {
    home,
    env: { QUIRKY_HOME: home, QUIRKY_TEST_SCOPE: 'runtime-token' },
    spawn(command, spawnOptions) {
      const env = spawnOptions?.env
      if (command[1] === 'packages/ui/build.ts') {
        events.push('build.spawn')
        state.buildEnv = env
        state.livePids.add(702)
        const exited = Promise.resolve(0).then(exitCode => {
          events.push('build.exit')
          state.livePids.delete(702)
          if (options.buildSurvivor) state.livePids.add(703)
          if (options.reuseBuildPid) state.reusedBuildPid = true
          return exitCode
        })
        return { pid: 702, exited }
      }
      if (command[1] === 'packages/daemon/src/main.ts') {
        events.push('daemon.spawn')
        state.daemonEnv = env
        state.livePids.add(701)
        state.runtimeWritten = true
        return { pid: 701, exited: Promise.resolve(0) }
      }
      throw new Error(`unexpected recording child: ${command.join(' ')}`)
    },
    async cleanup() {
      events.push('scope.cleanup')
      clearScopeProcesses()
    },
    killNow() {
      events.push('scope.killNow')
      clearScopeProcesses()
    },
    track() {}
  }
  const soakWorld = {
    home,
    runtime: { pid: 701, port: 43123, token: 'runtime-token', hookToken: 'hook-token', entryHash: 'fixture-entry' },
    daemonPid: 701,
    env: {} as Record<string, string>,
    workers: [] as unknown[],
    ptyHostPid: () => null,
    updatePtyHostPid() {},
    fixtures: { worktrees },
    control: {
      callAny: async (method: string) => {
        if (method === 'ui.state') {
          state.shownConnectionChecks += 1
          if (options.uiStateFailure) throw new Error('recording UI state failed')
          return { windows: [41, 42].map(connId => ({ connId })) }
        }
        throw new Error(`unexpected recording RPC ${method}`)
      },
      close() {}
    },
    async stop() {
      events.push('world.stop')
      if (options.worldStopFailure) throw new Error('recording world stop failed')
      state.livePids.delete(701)
      if (options.reuseDaemonPid) state.reusedDaemonPid = true
      if (options.survivor) state.livePids.add(701)
    }
  }
  const tools = { fixtureBin, fetchPreload, egressLog: join(home, 'out', 'egress.log') }
  const writeOwnedLogs = () => {
    mkdirSync(outDir, { recursive: true })
    const longUrl = `wss://user:password@127.0.0.1/${'a'.repeat(9_000)}?auth=unknown-secret#fragment-secret`
    const socketUrl = 'ws://socket-user:socket-password@127.0.0.1/rpc?auth=unknown-socket-secret#socket-fragment-secret'
    const longLog = options.longAuthenticatedLog
      ? `${home} ${longUrl}${'λ'.repeat(3_000)}\nuseful λ tail ${socketUrl}\n`
      : `${home} runtime-token hook-token https://u:p@127.0.0.1/path?token=runtime-token&extra=value#fragment-secret ${'λ'.repeat(7_000)}\nuseful λ tail\n`
    writeFileSync(join(outDir, 'ui-build.log'), longLog)
    writeFileSync(join(outDir, 'daemon.log'), longLog)
  }
  const dependencies: Record<string, unknown> = {
    createScope: () => {
      events.push('scope.create')
      if (options.scopeCreationFailure) throw new Error('recording scope creation failed')
      return scope
    },
    installCliFixtureTools: (ownedHome: string) => {
      if (ownedHome !== home) throw new Error('fixture tools escaped the owned home')
      events.push('tools.install')
      return tools
    },
    createCliEnvironment: (ownedHome: string, checkout: string, installedBin: string, installedPreload: string) => {
      if (ownedHome !== home || checkout !== repoRoot || installedBin !== fixtureBin || installedPreload !== fetchPreload) {
        throw new Error('recording environment received incorrect ownership roots')
      }
      events.push('environment.create')
      return {
        HOME: home,
        QUIRKY_HOME: home,
        QUIRKY_PORT: '0',
        QUIRKY_AGENT_SEARCH_DIRS: '',
        PATH: `${fixtureBin}:/usr/bin:/bin`,
        BUN_OPTIONS: `--preload=${fetchPreload}`,
        QUIRKY_CLI_ENTRY: join(repoRoot, 'packages/cli/src/main.ts')
      }
    },
    verifyEgressGuard: async () => {
      events.push('egress.verify')
      if (options.guardFailure) throw new Error('recording egress guard refused startup')
    },
    prepareCaptureFixtureHome: async (_ownedHome: string, preparation: { env: Record<string, string> }) => {
      events.push('fixtures.prepare')
      if (options.fixtureFailure) throw new Error('recording fixture preparation failed')
      state.preparedEnv = preparation.env
      return { ready: true }
    },
    registerCaptureFixtures: async () => ({ worktrees }),
    startWorld: async (_worldOptions: Record<string, unknown>, startDependencies: Record<string, unknown>) => {
      events.push('world.start')
      const prepare = startDependencies.prepareCaptureFixtureHome as ((ownedHome: string, preparation: { env: Record<string, string> }) => Promise<unknown>)
      const createOwnedScope = startDependencies.createScope as () => FakeScope
      const stagedPlugins = typeof options.pluginAlias === 'function'
        ? options.pluginAlias(home)
        : options.pluginAlias ?? join(home, 'builtin-plugins')
      if (options.symlinkEscape) {
        mkdirSync(join(home, 'other-owned-directory'), { recursive: true })
        symlinkSync(join(home, 'other-owned-directory'), pluginsDir, 'dir')
      } else if (options.danglingPluginSymlink) {
        symlinkSync(join(home, 'missing-plugin-target'), pluginsDir, 'dir')
      } else {
        mkdirSync(pluginsDir, { recursive: true })
      }
      const helperEnv: Record<string, string> = {
        HOME: '/poison/home',
        QUIRKY_HOME: home,
        QUIRKY_UI_DIR: uiDir,
        QUIRKY_PLUGINS_DIR: stagedPlugins,
        QUIRKY_BUILTIN_PLUGINS_DIR: stagedPlugins,
        QUIRKY_PORT: '1234',
        QUIRKY_AGENT_SEARCH_DIRS: '/poison/agents',
        PATH: '/poison/bin',
        HTTP_PROXY: 'http://proxy.invalid',
        OPENAI_API_KEY: 'poison-credential',
        QUIRKY_SESSION_TOKEN: 'poison-session',
        GIT_CONFIG_GLOBAL: '/poison/gitconfig',
        NODE_OPTIONS: '--require=poison'
      }
      state.helperEnv = helperEnv
      await prepare(options.homeAlias?.(home) ?? home, { env: helperEnv })
      if (options.buildFailure) {
        const buildScope = createOwnedScope()
        await buildScope.spawn([process.execPath, 'packages/ui/build.ts'], { env: { ...helperEnv, QUIRKY_UI_OUT: uiDir } }).exited
        writeOwnedLogs()
        throw new Error('recording UI build failed')
      }
      if (options.symlinkEscape) return Promise.reject(new Error('builder was reached through an escaping plugin symlink'))
      const buildScope = createOwnedScope()
      await buildScope.spawn([process.execPath, 'packages/ui/build.ts'], { env: { ...helperEnv, QUIRKY_UI_OUT: uiDir } }).exited
      mkdirSync(uiDir, { recursive: true })
      writeOwnedLogs()
      const daemonScope = createOwnedScope()
      daemonScope.spawn([process.execPath, 'packages/daemon/src/main.ts'], { env: helperEnv })
      soakWorld.env = helperEnv
      return soakWorld
    },
    findChrome: () => options.chromeMissing ? undefined : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    readRuntime: () => state.runtimeWritten ? {
      pid: 701, home, port: 43123, token: 'runtime-token', hookToken: 'hook-token', entryHash: 'fixture-entry'
    } : undefined,
    isDaemonAlive: async () => state.livePids.has(701),
    processSnapshot,
    openWindows: async (openOptions: Record<string, unknown>) => {
      events.push('windows.open')
      const onStartup = openOptions.onStartup as ((observation: StartupObservation) => void) | undefined
      const report = (observation: StartupObservation) => {
        state.lastObservation = observation
        onStartup?.(observation)
      }
      state.livePids.add(801)
      report({ stage: 'launch', elapsedMs: 1, browserPid: 801 })
      if (options.rendererFailure) {
        const sensitive = `local renderer navigation failed at ${home} https://u:p@127.0.0.1/path?token=runtime-token&extra=value#fragment-secret`
        for (let index = 0; index < 70; index += 1) {
          report({
            stage: 'page', elapsedMs: index + 2, index: 0, browserPid: 801,
            pageErrors: Array.from({ length: 7 }, (_, errorIndex) => `${home} runtime-token page ${errorIndex}`),
            failedRequests: Array.from({ length: 7 }, () => ({
              path: 'https://u:p@127.0.0.1/assets.js?token=runtime-token&extra=value#fragment-secret',
              message: sensitive
            }))
          })
        }
        report({
          stage: 'navigation', elapsedMs: 90, index: 0, browserPid: 801, message: sensitive,
          pageErrors: Array.from({ length: 7 }, (_, errorIndex) => `${home} runtime-token navigation ${errorIndex}`),
          failedRequests: Array.from({ length: 7 }, () => ({
            path: 'https://127.0.0.1/assets.js?arbitrary=value#fragment-secret', message: sensitive
          }))
        })
        if (options.processTableFailure) state.failProcessTable = true
        state.livePids.delete(801)
        throw new Error(sensitive)
      }
      if (options.processTableFailure) state.failProcessTable = true
      if (options.uiStateFailure) return windows
      report({ stage: 'ready', elapsedMs: 4, browserPid: 801 })
      return windows
    }
  }
  return {
    root,
    home,
    uiDir,
    pluginsDir,
    events,
    state,
    scope,
    windows,
    dependencies,
    dispose() { rmSync(root, { recursive: true, force: true }) }
  }
}



test('CLI-files overlays generated private roots through preparation, build, daemon and world handoff', async () => {
  const createWorld = requireFactory()
  const actual = makeFactoryFixture({
    pluginAlias: privatePluginAlias,
    homeAlias: home => `${home.replace(/^\/private(?=\/)/, '')}/../home/`
  })
  try {
    const world = await createWorld({}, actual.dependencies)
    try {
      const expectedPlugins = join(actual.home, 'builtin-plugins')
      expect(actual.state.preparedEnv).toBe(actual.state.helperEnv)
      expect(actual.state.buildEnv).toEqual({ ...actual.state.helperEnv, QUIRKY_UI_OUT: actual.uiDir })
      expect(actual.state.buildEnv?.QUIRKY_PLUGINS_DIR).toBe(expectedPlugins)
      expect(actual.state.buildEnv?.QUIRKY_BUILTIN_PLUGINS_DIR).toBe(expectedPlugins)
      expect(actual.state.daemonEnv).toBe(actual.state.helperEnv)
      expect(actual.state.helperEnv).toBe(world.env)
      expect(actual.state.preparedEnv?.QUIRKY_PLUGINS_DIR).toBe(expectedPlugins)
      expect(actual.state.preparedEnv?.QUIRKY_BUILTIN_PLUGINS_DIR).toBe(expectedPlugins)
      expect(actual.state.preparedEnv?.QUIRKY_UI_DIR).toBe(actual.uiDir)
      expect(actual.state.preparedEnv?.HTTP_PROXY).toBeUndefined()
      expect(actual.state.preparedEnv?.OPENAI_API_KEY).toBeUndefined()
      expect(actual.state.preparedEnv?.QUIRKY_SESSION_TOKEN).toBeUndefined()
      expect(actual.events.indexOf('fixtures.prepare')).toBeLessThan(actual.events.indexOf('build.spawn'))
      expect(actual.events.indexOf('build.exit')).toBeLessThan(actual.events.indexOf('daemon.spawn'))
      expect(world.startupDiagnostics).toMatchObject({
        phase: 'ready',
        assets: { uiDir: '<cli-home>/ui-dist', pluginsDir: '<cli-home>/builtin-plugins' }
      })
      expect(world.startupDiagnostics?.buildElapsedMs).toBeGreaterThanOrEqual(0)
      expect(world.startupDiagnostics?.elapsedMs).toBeGreaterThanOrEqual(world.startupDiagnostics?.buildElapsedMs ?? 0)
    } finally {
      await world.cleanup()
      await world.cleanup()
    }
    expect(actual.events.filter(event => event === 'world.stop')).toHaveLength(1)
    expect(actual.events.filter(event => event === 'browser.stop')).toHaveLength(1)
  } finally {
    actual.dispose()
  }
})

test('CLI-files refuses a plugin-root symlink escape before the builder can run', async () => {
  const fixture = makeFactoryFixture({ symlinkEscape: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure).toMatchObject({ kind: 'fixture-home' })
    expect(fixture.events).not.toContain('build.spawn')
    expect(fixture.events).not.toContain('daemon.spawn')
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: true,
      evidence: { started: { daemon: false, browser: false }, scopeCleanupComplete: true, acquisitionSettled: true, homeRemoved: true }
    })
  } finally {
    fixture.dispose()
  }
})
test('CLI-files refuses a dangling generated plugin-root symlink inside its home', async () => {
  const fixture = makeFactoryFixture({ danglingPluginSymlink: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure).toMatchObject({ kind: 'fixture-home' })
    expect(fixture.events).not.toContain('build.spawn')
    expect(fixture.events).not.toContain('daemon.spawn')
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: true,
      evidence: { started: { daemon: false, browser: false }, scopeCleanupComplete: true, acquisitionSettled: true, homeRemoved: true }
    })
    expect(fixture.pluginsDir).toBe(join(fixture.home, 'builtin-plugins'))
  } finally {
    fixture.dispose()
  }
})


test('CLI-files preserves pre-return browser identity and bounded sanitized renderer evidence after navigation failure', async () => {
  const fixture = makeFactoryFixture({ rendererFailure: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    const evidence = failure.startupEvidence
    expect(typeof cliWorldNamespace.CliFilesStartupError).toBe('function')
    if (cliWorldNamespace.CliFilesStartupError) expect(failure).toBeInstanceOf(cliWorldNamespace.CliFilesStartupError)
    expect(failure.message).toContain('local renderer navigation failed')
    expect(evidence?.diagnostics.phase).toBe('renderer')
    expect(evidence?.diagnostics.renderer.length).toBeLessThanOrEqual(64)
    expect(evidence?.diagnostics.renderer.some(observation => observation.stage === 'navigation' && observation.message?.includes('local renderer navigation failed'))).toBe(true)
    const navigation = evidence?.diagnostics.renderer.find(observation => observation.stage === 'navigation')
    expect(navigation?.pageErrors).toHaveLength(5)
    expect(navigation?.failedRequests).toHaveLength(5)
    expect(evidence?.cleanup).toMatchObject({
      ok: true,
      evidence: {
        started: { daemon: true, browser: true },
        processIdentitiesGone: true,
        homeRemoved: true,
        unresolvedAcquisition: false,
        scopeCleanupComplete: true,
        acquisitionSettled: true
      }
    })
    expect(evidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({ kind: 'browser', pid: 801, gone: true }))
    expect(evidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({ kind: 'daemon', pid: 701, gone: true }))
    expect(Buffer.byteLength(evidence?.diagnostics.logs.buildTail ?? '')).toBeLessThanOrEqual(8_192)
    expect(Buffer.byteLength(evidence?.diagnostics.logs.daemonTail ?? '')).toBeLessThanOrEqual(8_192)
    expect(evidence?.diagnostics.logs.buildTail).toContain('λ')
    expect(evidence?.diagnostics.logs.daemonTail).toContain('λ')
    const serialized = JSON.stringify(evidence)
    for (const secret of [fixture.home, 'runtime-token', 'hook-token', 'poison-credential', 'fragment-secret', '?token=', '?extra=', '?arbitrary=']) {
      expect(serialized).not.toContain(secret)
    }
    expect(evidence && Object.isFrozen(evidence)).toBe(true)
    expect(evidence && Object.isFrozen(evidence.diagnostics)).toBe(true)
    expect(evidence && Object.isFrozen(evidence.diagnostics.renderer)).toBe(true)
    expect(evidence && Object.isFrozen(evidence.cleanup.evidence.trackedIdentities)).toBe(true)
    fixture.state.lastObservation?.pageErrors?.push('mutated after failure')
    expect(JSON.stringify(evidence)).not.toContain('mutated after failure')
  } finally {
    fixture.dispose()
  }
})

test('CLI-files missing Chrome records only the captured daemon root and removes its home', async () => {
  const fixture = makeFactoryFixture({ chromeMissing: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure).toMatchObject({ kind: 'missing-chrome' })
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: true,
      evidence: {
        started: { daemon: true, browser: false },
        processIdentitiesGone: true,
        homeRemoved: true,
        scopeCleanupComplete: true,
        acquisitionSettled: true
      }
    })
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities.map(identity => identity.kind)).toContain('daemon')
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities.map(identity => identity.kind)).not.toContain('browser')
  } finally {
    fixture.dispose()
  }
})

test('CLI-files guard, fixture and failed build retain pre-daemon accounting and owned build logs', async () => {
  for (const fault of ['guard', 'fixtures', 'build'] as const) {
    const fixture = makeFactoryFixture(fault === 'guard' ? { guardFailure: true } :
      fault === 'fixtures' ? { fixtureFailure: true } : { buildFailure: true })
    try {
      const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
      const evidence = failure.startupEvidence
      expect(evidence?.cleanup.evidence.started).toEqual({ daemon: false, browser: false })
      if (fault === 'build') {
        expect(evidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({
          kind: 'build', pid: 702, pgid: 702, started: 'owned-start-702',
          command: `${process.execPath} packages/ui/build.ts`, gone: true
        }))
      } else {
        expect(evidence?.cleanup.evidence.trackedIdentities).toEqual([])
      }
      expect(evidence?.cleanup).toMatchObject({
        ok: true,
        evidence: { homeRemoved: true, processIdentitiesGone: true, scopeCleanupComplete: true, acquisitionSettled: true, unresolvedAcquisition: false }
      })
      if (fault === 'guard') {
        expect(evidence?.diagnostics.phase).toBe('environment')
        expect(fixture.events).not.toContain('world.start')
      } else if (fault === 'fixtures') {
        expect(failure.message).toContain('recording fixture preparation failed')
        expect(evidence?.diagnostics.phase).toBe('fixtures')
        expect(fixture.events).not.toContain('build.spawn')
        expect(fixture.events).not.toContain('daemon.spawn')
      } else {
        expect(evidence?.diagnostics.phase).toBe('build')
        expect(evidence?.diagnostics.buildElapsedMs).toBeGreaterThanOrEqual(0)
        expect(evidence?.diagnostics.logs.buildTail).toContain('λ')
        expect(fixture.events.indexOf('build.exit')).toBeLessThan(fixture.events.indexOf('scope.cleanup'))
      }
    } finally {
      fixture.dispose()
    }
  }
})
test('CLI-files fails closed when the spawned build root identity is missing', async () => {
  const fixture = makeFactoryFixture({ buildFailure: true, missingBuildRoot: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: false,
      evidence: { trackedIdentities: [], processIdentitiesGone: false, homeRemoved: false, scopeCleanupComplete: true }
    })
    expect(failure.startupEvidence?.cleanup.error?.toLowerCase()).toContain('build')
  } finally {
    fixture.dispose()
  }
})

test('CLI-files does not certify a surviving build-group child when scope cleanup resolves', async () => {
  const fixture = makeFactoryFixture({ buildFailure: true, buildSurvivor: true })
  const originalNow = Date.now
  let acceleratedNow = originalNow()
  Date.now = () => fixture.events.includes('scope.cleanup') ? (acceleratedNow += 2_500) : originalNow()
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.evidence).toMatchObject({
      processIdentitiesGone: false,
      homeRemoved: false,
      scopeCleanupComplete: true
    })
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({
      kind: 'build-child', pid: 703, pgid: 702, command: `${process.execPath} packages/ui/build-worker.ts`, gone: false
    }))
  } finally {
    Date.now = originalNow
    fixture.dispose()
  }
})

test('CLI-files never adopts a reused build-root PID as a private-group identity', async () => {
  const fixture = makeFactoryFixture({ buildFailure: true, reuseBuildPid: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure.startupEvidence?.cleanup.ok).toBe(true)
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({
      kind: 'build', pid: 702, pgid: 702, started: 'owned-start-702', gone: true
    }))
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).not.toContainEqual(expect.objectContaining({
      command: '/usr/bin/unrelated-build-sentinel'
    }))
  } finally {
    fixture.dispose()
  }
})

test('CLI-files removes credentials from a log tail whose boundary splits a long authenticated URL', async () => {
  const fixture = makeFactoryFixture({ buildFailure: true, longAuthenticatedLog: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    const snapshot = JSON.stringify(failure.startupEvidence)
    expect(snapshot).not.toContain('user:password')
    expect(snapshot).not.toContain('auth=unknown-secret')
    expect(snapshot).not.toContain('fragment-secret')
    expect(snapshot).toContain('useful λ tail')
  } finally {
    fixture.dispose()
  }
})
test('CLI-files leaves scope-creation failure unresolved instead of certifying empty cleanup', async () => {
  const fixture = makeFactoryFixture({ scopeCreationFailure: true })
  try {
    const failure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(failure.message).toContain('recording scope creation failed')
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.evidence).toMatchObject({
      trackedIdentities: [],
      processIdentitiesGone: false,
      acquisitionSettled: false
    })
    expect(fixture.events).toEqual(['scope.create'])
  } finally {
    fixture.dispose()
  }
})



test('CLI-files keeps process-table uncertainty and a surviving root failed without calling either a measured leak', async () => {
  const failedTable = makeFactoryFixture({ rendererFailure: true, processTableFailure: true })
  try {
    const failure = await captureFailure(requireFactory()({}, failedTable.dependencies))
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.error).toContain('recording process table unavailable')
    expect(failure.startupEvidence?.cleanup.evidence.processIdentitiesGone).toBe(false)
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities.some(identity => identity.gone)).toBe(false)
    expect(failure.message).toContain('local renderer navigation failed')
    expect(failure.message).not.toContain('recording process table unavailable')
  } finally {
    failedTable.dispose()
  }

  const survivor = makeFactoryFixture({ chromeMissing: true, survivor: true })
  const originalNow = Date.now
  let acceleratedNow = originalNow()
  Date.now = () => survivor.events.includes('world.stop') ? (acceleratedNow += 2_500) : originalNow()
  try {
    const failure = await captureFailure(requireFactory()({}, survivor.dependencies))
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.error).toContain('could not be verified')
    expect(failure.startupEvidence?.cleanup.evidence.started).toEqual({ daemon: true, browser: false })
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({ kind: 'daemon', gone: false }))
    expect(failure.startupEvidence?.cleanup.error).not.toMatch(/processes remain: .*measured leak/i)
  } finally {
    Date.now = originalNow
    survivor.dispose()
  }
})
test('CLI-files process snapshots expose bounded spawn metadata without leaking process-table output', async () => {
  const getMetadata = getProcessInspectionMetadata
  const limit = 16 * 1024 * 1024
  const secretStdout = 'private-process-table-stdout-Ω'
  const overLimitStdout = 'x'.repeat(limit + 1)
  const longCode = 'PROCESS-CODE-'.repeat(20)
  const longName = `SpawnFailure${'λ'.repeat(100)}`
  const longSignal = `SIGTERM${'λ'.repeat(100)}`
  const scenarios: Array<{
    label: string
    code?: string
    name?: string
    status: number | null | undefined
    signal: string | null | undefined
    stdout: string | null
    timeoutHit: boolean
    maxBufferHit: boolean
  }> = [
    {
      label: 'ETIMEDOUT',
      code: 'ETIMEDOUT',
      name: longName,
      status: null,
      signal: longSignal,
      stdout: secretStdout,
      timeoutHit: true,
      maxBufferHit: false
    },
    {
      label: 'TimeoutError',
      code: longCode,
      name: 'TimeoutError',
      status: null,
      signal: null,
      stdout: secretStdout,
      timeoutHit: true,
      maxBufferHit: false
    },
    {
      label: 'ENOBUFS',
      code: 'ENOBUFS',
      name: longName,
      status: null,
      signal: null,
      stdout: secretStdout,
      timeoutHit: false,
      maxBufferHit: true
    },
    {
      label: 'captured stdout over the process-table cap',
      status: 23,
      signal: longSignal,
      stdout: overLimitStdout,
      timeoutHit: false,
      maxBufferHit: true
    },
    {
      label: 'non-string stdout',
      status: 0,
      signal: null,
      stdout: null,
      timeoutHit: false,
      maxBufferHit: false
    },
    {
      label: 'nonzero exit status',
      status: 23,
      signal: null,
      stdout: secretStdout,
      timeoutHit: false,
      maxBufferHit: false
    },
    {
      label: 'backend omits exit status',
      code: 'ETIMEDOUT',
      name: 'Error',
      status: undefined,
      signal: null,
      stdout: secretStdout,
      timeoutHit: true,
      maxBufferHit: false
    },
    {
      label: 'backend omits signal',
      status: 23,
      signal: undefined,
      stdout: secretStdout,
      timeoutHit: false,
      maxBufferHit: false
    }
  ]

  for (const scenario of scenarios) {
    const fixture = makeFactoryFixture()
    let spawnCalls = 0
    const spawnError = scenario.code === undefined
      ? undefined
      : Object.assign(new Error(`secret spawn message ${secretStdout}`), { code: scenario.code, name: scenario.name })
    const spawnProcessSnapshot = (command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnCalls += 1
      expect(command).toBe('/bin/ps')
      expect(args).toEqual(['-A', '-o', 'pid=,ppid=,pgid=,lstart=,stat=,command='])
      expect(options).toEqual({
        cwd: fixture.home,
        env: {
          HOME: fixture.home,
          QUIRKY_HOME: fixture.home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: join(fixture.home, 'tmp'),
          LANG: 'C',
          TZ: 'UTC'
        },
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: limit,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return { error: spawnError, status: scenario.status, signal: scenario.signal, stdout: scenario.stdout }
    }

    try {
      const outcome = await requireFactory()({}, {
        ...fixture.dependencies,
        spawnProcessSnapshot
      }).then(
        world => ({ world }),
        error => ({ error })
      )
      if ('world' in outcome) {
        await outcome.world.cleanup()
        throw new Error('expected injected process snapshot failure')
      }
      const failure = outcome.error as Error & {
        kind?: string
        processInspection?: ProcessInspectionMetadata
        startupEvidence?: StartupEvidence
      }
      expect(spawnCalls, scenario.label).toBeGreaterThan(0)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.name).toBe('CliFilesStartupError')
      expect(failure.kind).toBe('startup-failed')
      expect(failure.message).toBe('could not inspect owned process identities')
      const metadata = getMetadata(failure)
      const expected = {
        spawnErrorCode: scenario.code === undefined ? null : scenario.code.slice(0, 128),
        spawnErrorName: scenario.name === longName ? `SpawnFailure${'λ'.repeat(58)}` : scenario.name ?? null,
        exitStatus: scenario.status ?? null,
        signal: scenario.signal === longSignal ? `SIGTERM${'λ'.repeat(60)}` : scenario.signal ?? null,
        stdoutWasString: scenario.stdout !== null,
        stdoutBytes: scenario.stdout === null ? null : Buffer.byteLength(scenario.stdout, 'utf8'),
        timeoutHit: scenario.timeoutHit,
        maxBufferHit: scenario.maxBufferHit,
        timeoutMs: 2_000,
        maxBufferBytes: limit
      }
      for (const value of [metadata?.spawnErrorCode, metadata?.spawnErrorName, metadata?.signal]) {
        if (typeof value !== 'string') continue
        expect(Buffer.byteLength(value, 'utf8'), scenario.label).toBeLessThanOrEqual(128)
        expect(value, scenario.label).not.toContain('\uFFFD')
      }
      expect(metadata, scenario.label).toEqual(expected)
      expect(failure.processInspection, scenario.label).toEqual(expected)
      expect(failure.startupEvidence?.diagnostics.processInspection, scenario.label).toEqual(expected)
      expect(Object.isFrozen(metadata)).toBe(true)
      expect(Object.isFrozen(failure.startupEvidence?.diagnostics)).toBe(true)
      expect(Object.keys(metadata!).sort()).toEqual([
        'exitStatus', 'maxBufferBytes', 'maxBufferHit', 'signal', 'spawnErrorCode',
        'spawnErrorName', 'stdoutBytes', 'stdoutWasString', 'timeoutHit', 'timeoutMs'
      ])
      expect(metadata).not.toHaveProperty('stdout')
      expect(metadata).not.toHaveProperty('message')
      const untrustedCopy = getMetadata(Object.assign(new Error('wrapper'), {
        processInspection: { ...metadata, stdout: secretStdout, extra: 'must-not-survive' }
      }))
      expect(untrustedCopy).toEqual(expected)
      const serialized = JSON.stringify({ failure: failure.processInspection, diagnostics: failure.startupEvidence?.diagnostics })
      expect(serialized).not.toContain(secretStdout)
      expect(serialized).not.toContain('secret spawn message')
      expect(serialized).not.toContain('must-not-survive')
    } finally {
      fixture.dispose()
    }
  }
})

test('CLI-files retains process inspection metadata from a cleanup process-table failure', async () => {
  const getMetadata = getProcessInspectionMetadata
  const fixture = makeFactoryFixture({ chromeMissing: true })
  const secretStdout = 'cleanup-process-table-private-output'
  let cleanupInspectionStarted = false
  const spawnProcessSnapshot = (_command: string, _args: readonly string[], _options: Record<string, unknown>) => {
    if (fixture.events.includes('world.stop')) {
      cleanupInspectionStarted = true
      const error = Object.assign(new Error(`cleanup spawn details ${secretStdout}`), { code: 'ENOBUFS' })
      return { error, status: null, signal: null, stdout: secretStdout }
    }
    const rows = [...fixture.state.livePids].map(pid => {
      const pgid = pid === 702 ? 702 : process.pid
      const command = pid === 701 ? `${process.execPath} packages/daemon/src/main.ts`
        : pid === 702 ? `${process.execPath} packages/ui/build.ts`
          : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      return `${pid} ${process.pid} ${pgid} owned-start-${pid} fixture date process time S ${command}`
    }).join('\n')
    return { error: undefined, status: 0, signal: null, stdout: rows }
  }
  try {
    const failure = await captureFailure(requireFactory()({}, {
      ...fixture.dependencies,
      spawnProcessSnapshot
    }))
    expect(cleanupInspectionStarted).toBe(true)
    expect(failure.message).toBe('an installed macOS Chrome or Chromium executable was not found')
    expect(failure.startupEvidence?.diagnostics.processInspection).toMatchObject({
      spawnErrorCode: 'ENOBUFS',
      spawnErrorName: 'Error',
      timeoutHit: false,
      maxBufferHit: true,
      timeoutMs: 2_000,
      maxBufferBytes: 16 * 1024 * 1024
    })
    expect(getMetadata(failure)).toEqual(failure.startupEvidence?.diagnostics.processInspection)
    expect(failure.startupEvidence?.cleanup.evidence.processInspection).toEqual(failure.startupEvidence?.diagnostics.processInspection)
    expect(JSON.stringify(failure.startupEvidence)).not.toContain(secretStdout)
    expect(JSON.stringify(failure.startupEvidence)).not.toContain('cleanup spawn details')
  } finally {
    fixture.dispose()
  }
})


test('CLI-files compares full captured identities across PID reuse and preserves stop fallback order', async () => {
  const reused = makeFactoryFixture({ chromeMissing: true, reuseDaemonPid: true })
  try {
    const failure = await captureFailure(requireFactory()({}, reused.dependencies))
    expect(failure.startupEvidence?.cleanup).toMatchObject({ ok: true, evidence: { processIdentitiesGone: true, homeRemoved: true } })
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({
      kind: 'daemon', pid: 701, started: 'owned-start-701', gone: true
    }))
  } finally {
    reused.dispose()
  }

  const stopFailure = makeFactoryFixture({ uiStateFailure: true, worldStopFailure: true })
  try {
    const failure = await captureFailure(requireFactory()({}, stopFailure.dependencies))
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.error).toContain('recording world stop failed')
    expect(stopFailure.events.indexOf('browser.stop')).toBeLessThan(stopFailure.events.indexOf('world.stop'))
    expect(stopFailure.events.indexOf('world.stop')).toBeLessThan(stopFailure.events.indexOf('scope.killNow'))
    expect(stopFailure.events.indexOf('scope.killNow')).toBeLessThan(stopFailure.events.indexOf('scope.cleanup'))
  } finally {
    stopFailure.dispose()
  }
})

test('CLI-files accounts for a late renderer that resolves and is stopped before the world', async () => {
  const fixture = makeFactoryFixture()
  const createWorld = requireFactory()
  const deferred = Promise.withResolvers<typeof fixture.windows>()
  const opened = Promise.withResolvers<void>()
  const setTimer = globalThis.setTimeout
  fixture.dependencies.openWindows = (options: Record<string, unknown>) => {
    const signal = options.signal as AbortSignal
    const observer = options.onStartup as ((observation: StartupObservation) => void) | undefined
    fixture.events.push('windows.open')
    fixture.state.livePids.add(801)
    observer?.({ stage: 'launch', elapsedMs: 1, browserPid: 801 })
    signal.addEventListener('abort', () => queueMicrotask(() => deferred.resolve(fixture.windows)), { once: true })
    opened.resolve()
    return deferred.promise
  }
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      setTimer(callback, ms === 30_000 ? 0 : ms, ...args)) as typeof setTimeout
    const failurePromise = captureFailure(createWorld({}, fixture.dependencies))
    await opened.promise
    const failure = await failurePromise
    expect(failure.kind).toBe('deadline')
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: true,
      evidence: { started: { daemon: true, browser: true }, unresolvedAcquisition: false, scopeCleanupComplete: true, acquisitionSettled: true }
    })
    expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
    expect(failure.startupEvidence?.cleanup.evidence.trackedIdentities).toContainEqual(expect.objectContaining({ kind: 'browser', pid: 801, gone: true }))
  } finally {
    globalThis.setTimeout = setTimer
    fixture.dispose()
  }
})

test('CLI-files refuses clean evidence while a late renderer acquisition stays unresolved', async () => {
  const fixture = makeFactoryFixture()
  const createWorld = requireFactory()
  const opened = Promise.withResolvers<void>()
  const setTimer = globalThis.setTimeout
  fixture.dependencies.openWindows = (options: Record<string, unknown>) => {
    const observer = options.onStartup as ((observation: StartupObservation) => void) | undefined
    fixture.events.push('windows.open')
    fixture.state.livePids.add(801)
    observer?.({ stage: 'launch', elapsedMs: 1, browserPid: 801 })
    const unresolved = Promise.withResolvers<typeof fixture.windows>()
    opened.resolve()
    return unresolved.promise
  }
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      setTimer(callback, ms === 30_000 || ms === 25_000 ? 0 : ms, ...args)) as typeof setTimeout
    const failurePromise = captureFailure(createWorld({}, fixture.dependencies))
    await opened.promise
    const failure = await failurePromise
    expect(failure.kind).toBe('deadline')
    expect(failure.startupEvidence?.cleanup.ok).toBe(false)
    expect(failure.startupEvidence?.cleanup.evidence.started).toEqual({ daemon: true, browser: true })
    expect(failure.startupEvidence?.cleanup.evidence.unresolvedAcquisition).toBe(true)
    expect(failure.startupEvidence?.cleanup.evidence.acquisitionSettled).toBe(false)
  } finally {
    globalThis.setTimeout = setTimer
    fixture.dispose()
  }
})

test('CLI-files ignores poisoned inherited plugin roots and builds only under its canonical home', async () => {
  const fixture = makeFactoryFixture({ pluginAlias: '/poison/inherited-plugins' })
  try {
    const world = await requireFactory()({}, fixture.dependencies)
    try {
      expect(fixture.state.buildEnv).toMatchObject({
        QUIRKY_PLUGINS_DIR: fixture.pluginsDir,
        QUIRKY_BUILTIN_PLUGINS_DIR: fixture.pluginsDir,
        QUIRKY_UI_OUT: fixture.uiDir
      })
      expect(fixture.state.helperEnv).toBe(world.env)
    } finally {
      await world.cleanup()
    }
  } finally {
    fixture.dispose()
  }
})
test('CLI-files report transfers validated failed-startup evidence without fabricating CLI observations', async () => {
  const evidence = validStartupEvidence({ daemon: true, browser: false })
  const failure = typedStartupError(evidence, 'missing-chrome', 'an installed macOS Chrome or Chromium executable was not found')
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  const serialized = JSON.stringify(report)
  expect(report).toMatchObject({
    ok: false,
    parityComplete: false,
    error: { stage: 'setup', kind: 'missing-chrome', message: 'an installed macOS Chrome or Chromium executable was not found' },
    cleanup: { ok: true }
  })
  expect(report.buildElapsedMs).toBe(37)
  expect((report as unknown as { startup?: StartupDiagnostics }).startup).toEqual(evidence.diagnostics)
  expect(report.receipts).toEqual([])
  expect(report.observations).toHaveLength(13)
  expect(report.observations.every(observation => observation.status === 'not-run' && observation.receiptIds.length === 0)).toBe(true)
  expect(report.rows).toHaveLength(4)
  expect(report.rows.every(row => row.status === 'not-run' && row.executed === false)).toBe(true)
  expect(report.cleanup.evidence).toMatchObject({
    processIdentitiesGone: true,
    homeRemoved: true,
    daemonIdentityFound: true,
    browserIdentityFound: false,
    trackedIdentities: [expect.objectContaining({ kind: 'daemon', pid: 701, gone: true })]
  })
  expect(serialized).not.toContain('owned world cleanup identity could not be verified')
})
test('CLI-files report transfers shell-ready diagnostics while retaining cleanup proof', async () => {
  const evidence = validStartupEvidence({ browser: true })
  const shellReady = { stage: 'shell-ready', elapsedMs: 7, index: 0, worktree: 'ready', connId: 41, browserPid: 801 }
  evidence.diagnostics.renderer.push(shellReady)
  const failure = typedStartupError(evidence, 'renderer-disconnected', 'shell readiness failed')
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })

  const startup: StartupDiagnostics | undefined = report.startup
  expect(startup).toEqual(evidence.diagnostics)
  expect(report.ok).toBe(false)
  expect(report.cleanup.ok).toBe(true)
  expect(report.cleanup.evidence).toMatchObject({
    processIdentitiesGone: true,
    homeRemoved: true,
    daemonIdentityFound: true,
    browserIdentityFound: true,
    trackedIdentities: [
      expect.objectContaining({ kind: 'daemon', pid: 701, gone: true }),
      expect.objectContaining({ kind: 'browser', pid: 801, gone: true })
    ],
    unresolvedAcquisition: false,
    scopeCleanupComplete: true,
    acquisitionSettled: true
  })
  expect(report.observations).toHaveLength(13)
  expect(report.observations.every(observation => observation.status === 'not-run' && observation.receiptIds.length === 0)).toBe(true)
  expect(report.receipts).toEqual([])
  expect(report.parityComplete).toBe(false)
})

test('CLI-files runner removes unknown WebSocket URL secrets while preserving the path', async () => {
  const evidence = validStartupEvidence({ daemon: true, browser: false })
  evidence.diagnostics.logs.daemonTail =
    'wss://user:pass@127.0.0.1/rpc?auth=unknown-socket-secret#socket-fragment-secret'
  const failure = typedStartupError(evidence, 'missing-chrome', 'browser missing')
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  const serialized = JSON.stringify(report)
  expect(serialized).not.toContain('user:pass')
  expect(serialized).not.toContain('auth=unknown-socket-secret')
  expect(serialized).not.toContain('socket-fragment-secret')
  expect(serialized).toContain('wss://127.0.0.1/rpc')
})


test('CLI-files report accepts explicit clean pre-daemon accounting without inventing roots', async () => {
  const evidence = validStartupEvidence({ daemon: false, browser: false })
  const failure = typedStartupError(evidence, 'egress-guard-inactive', 'recording guard refused startup')
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  expect(report.cleanup.ok).toBe(true)
  expect(report.cleanup.evidence).toMatchObject({
    processIdentitiesGone: true,
    homeRemoved: true,
    daemonIdentityFound: false,
    browserIdentityFound: false,
    trackedIdentities: []
  })
  expect(report.error).toMatchObject({ kind: 'egress-guard-inactive', message: 'recording guard refused startup' })
})

test('CLI-files runner rejects ordinary errors, malformed roots, uncertain teardown and incomplete acquisition accounting', async () => {
  const ordinary = await runCliFilesParity({ createWorld: async () => { throw new Error('ordinary injected startup failed') } })
  expect(ordinary.cleanup.ok).toBe(false)
  expect(ordinary.error).toMatchObject({ kind: 'observation-failed', message: 'ordinary injected startup failed' })

  const mutations: Array<[string, (evidence: StartupEvidence) => void]> = [
    ['missing started daemon root', evidence => {
      evidence.cleanup.evidence.trackedIdentities = []
      evidence.cleanup.evidence.identities = []
    }],
    ['root present when daemon never started', evidence => {
      evidence.cleanup.evidence.started = { daemon: false, browser: false }
      evidence.cleanup.evidence.trackedIdentities = [daemonIdentity()]
      evidence.cleanup.evidence.identities = [{ kind: 'daemon', pid: 701, gone: true }]
    }],
    ['browser PID reported without a started browser root', evidence => {
      evidence.diagnostics.renderer[0]!.browserPid = 801
    }],
    ['malformed phase array', evidence => { Object.assign(evidence.diagnostics, { phase: ['renderer'] }) }],
    ['unknown renderer stage', evidence => { evidence.diagnostics.renderer[0]!.stage = 'unknown-stage' }],
    ['malformed renderer stage array', evidence => { Object.assign(evidence.diagnostics.renderer[0]!, { stage: ['failed'] }) }],
    ['unknown process table', evidence => { evidence.cleanup.evidence.processIdentitiesGone = false }],
    ['home removal not verified', evidence => { evidence.cleanup.evidence.homeRemoved = false }],
    ['scope cleanup incomplete', evidence => { evidence.cleanup.evidence.scopeCleanupComplete = false }],
    ['startup acquisition unresolved', evidence => {
      evidence.cleanup.evidence.acquisitionSettled = false
      evidence.cleanup.evidence.unresolvedAcquisition = true
    }],
    ['identity survived', evidence => {
      evidence.cleanup.evidence.trackedIdentities[0]!.gone = false
      evidence.cleanup.evidence.identities[0]!.gone = false
    }]

  ]
  for (const [label, mutate] of mutations) {
    const evidence = validStartupEvidence({ daemon: true, browser: false })
    mutate(evidence)
    const report = await runCliFilesParity({ createWorld: async () => { throw typedStartupError(evidence, 'renderer-disconnected', label) } })
    if (label === 'unknown renderer stage') {
      expect(report.startup, label).toBeUndefined()
    }
    expect(report.cleanup.ok, label).toBe(false)
    expect(report.ok, label).toBe(false)
    expect(report.parityComplete, label).toBe(false)
    expect(report.error?.message, label).toBe(label)
  }
})
test('CLI-files runner preserves process proof separately when startup-home removal fails', async () => {
  const evidence = validStartupEvidence({ daemon: true, browser: false })
  evidence.cleanup.ok = false
  evidence.cleanup.error = 'owned home removal could not be verified'
  evidence.cleanup.evidence.homeRemoved = false
  const failure = typedStartupError(evidence, 'missing-chrome', 'browser missing')
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  expect(report.ok).toBe(false)
  expect(report.cleanup.ok).toBe(false)
  expect(report.cleanup.error).toContain('owned home removal could not be verified')
  expect(report.cleanup.evidence).toMatchObject({ processIdentitiesGone: true, homeRemoved: false })
  expect(report.error).toMatchObject({ kind: 'missing-chrome', message: 'browser missing' })
})
test('CLI-files observation retains bounded process inspection metadata from its thrown error', async () => {
  const runner = new CliFilesRunner({})
  const metadata: ProcessInspectionMetadata = {
    spawnErrorCode: 'ENOBUFS',
    spawnErrorName: 'Error',
    exitStatus: null,
    signal: null,
    stdoutWasString: true,
    stdoutBytes: 32,
    timeoutHit: false,
    maxBufferHit: true,
    timeoutMs: 2_000,
    maxBufferBytes: 16 * 1024 * 1024
  }
  const failure = Object.assign(new Error('process table could not be inspected'), { processInspection: metadata })
  try {
    await runner.observation('process-inspection', async () => { throw failure })
    const observation = runner.observations.get('process-inspection') as unknown as {
      error?: { kind: string; message: string; processInspection?: ProcessInspectionMetadata }
    }
    expect(observation.error).toMatchObject({
      kind: 'observation-failed',
      message: 'process table could not be inspected',
      processInspection: metadata
    })
    expect((runner.primaryFailure as unknown as { processInspection?: ProcessInspectionMetadata }).processInspection).toEqual(metadata)
  } finally {
    clearTimeout(runner.workTimer)
    clearTimeout(runner.cleanupTimer)
    runner.workController.abort()
    runner.cleanupController.abort()
  }
})

test('CLI-files final report carries process inspection metadata from a rejected startup', async () => {
  const metadata: ProcessInspectionMetadata = {
    spawnErrorCode: 'ENOBUFS',
    spawnErrorName: 'Error',
    exitStatus: null,
    signal: null,
    stdoutWasString: true,
    stdoutBytes: 32,
    timeoutHit: false,
    maxBufferHit: true,
    timeoutMs: 2_000,
    maxBufferBytes: 16 * 1024 * 1024
  }
  const evidence = validStartupEvidence({ daemon: false, browser: false })
  evidence.diagnostics.processInspection = metadata
  evidence.cleanup.evidence.processInspection = metadata
  const failure = Object.assign(
    typedStartupError(evidence, 'startup-failed', 'could not inspect owned process identities'),
    { processInspection: metadata }
  )
  const report = await runCliFilesParity({ createWorld: async () => { throw failure } })
  const propagated = report as unknown as {
    startup?: StartupDiagnostics
    error?: { kind: string; message: string; processInspection?: ProcessInspectionMetadata }
    cleanup?: { evidence?: { processInspection?: ProcessInspectionMetadata } }
  }
  expect(propagated.startup?.processInspection).toEqual(metadata)
  expect(propagated.cleanup?.evidence?.processInspection).toEqual(metadata)
  expect(propagated.error).toMatchObject({
    kind: 'startup-failed',
    message: 'could not inspect owned process identities',
    processInspection: metadata
  })
  expect(JSON.stringify(report)).toContain('"processInspection"')
})


test('CLI-files runner retains and re-sanitizes actual factory startup evidence in JSON', async () => {
  const fixture = makeFactoryFixture({ rendererFailure: true })
  try {
    const factoryFailure = await captureFailure(requireFactory()({}, fixture.dependencies))
    expect(factoryFailure.startupEvidence).toBeDefined()
    const report = await runCliFilesParity({ createWorld: async () => { throw factoryFailure } })
    const json = JSON.stringify(report)
    expect(report.startup?.buildElapsedMs).toBe(report.buildElapsedMs)
    expect(report.startup?.phase).toBe('renderer')
    expect(report.error?.message).toContain('local renderer navigation failed')
    for (const secret of [fixture.home, 'runtime-token', 'hook-token', 'u:p@127.0.0.1', 'fragment-secret', '?token=', '?extra=', '?arbitrary=', 'extra=value', 'arbitrary=value']) {
      expect(json).not.toContain(secret)
    }
    expect(report.cleanup.evidence).toMatchObject({
      processIdentitiesGone: true,
      homeRemoved: true,
      daemonIdentityFound: true,
      browserIdentityFound: true,
      trackedIdentities: expect.arrayContaining([
        expect.objectContaining({ kind: 'build', pid: 702, gone: true }),
        expect.objectContaining({ kind: 'daemon', pid: 701, gone: true }),
        expect.objectContaining({ kind: 'browser', pid: 801, gone: true })
      ])
    })
  } finally {
    fixture.dispose()
  }
})

test('CLI-files never certifies a late returned browser PID whose start identity was not captured', async () => {
  const fixture = makeFactoryFixture()
  const opening = Promise.withResolvers<void>()
  const late = Promise.withResolvers<typeof fixture.windows>()
  const controller = new AbortController()
  fixture.dependencies.openWindows = async () => {
    opening.resolve()
    return late.promise
  }
  try {
    const failed = captureFailure(requireFactory()({ signal: controller.signal }, fixture.dependencies))
    await opening.promise
    controller.abort(new Error('renderer startup interrupted'))
    late.resolve(fixture.windows)
    const failure = await failed
    expect(failure.message).toContain('renderer startup interrupted')
    expect(failure.startupEvidence?.cleanup).toMatchObject({
      ok: false,
      evidence: { started: { daemon: true, browser: true }, homeRemoved: true, processIdentitiesGone: false }
    })
    expect(failure.startupEvidence?.cleanup.error).toContain('identity could not be verified')
    expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
  } finally {
    late.resolve(fixture.windows)
    fixture.dispose()
  }
})
test('CLI-files work and cleanup deadlines follow the shared timer policy', async () => {
  const realDateNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let controlledNow = realDateNow()
  Date.now = () => controlledNow
  type ControlledTimer = { delay: number; handle: ReturnType<typeof setTimeout>; fire(): void }
  const timers: ControlledTimer[] = []
  const fakeTimerHandles = new Set<ReturnType<typeof setTimeout>>()
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [handler, delay, ...callbackArgs] = args
    if (Number(delay) === CLI_FILES_LIMITS.workMs || Number(delay) === 5_000) {
      const handle = {} as ReturnType<typeof setTimeout>
      fakeTimerHandles.add(handle)
      timers.push({
        delay: Number(delay),
        handle,
        fire: () => {
          if (typeof handler === 'function') Reflect.apply(handler, undefined, callbackArgs)
        }
      })
      return handle
    }
    return realSetTimeout(...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (!fakeTimerHandles.has(handle)) realClearTimeout(handle)
  }) as typeof clearTimeout
  const runners: CliFilesRunner[] = []
  const createRunner = () => {
    const runner = new CliFilesRunner({})
    runners.push(runner)
    return runner
  }
  const workDeadlineMessage = `CLI file rehearsal exceeded its ${CLI_FILES_LIMITS.workMs / 1_000}-second work deadline`

  try {
    expect(CLI_FILES_LIMITS.workMs + CLI_FILES_LIMITS.cleanupMs).toBeLessThan(CLI_FILES_LIMITS.watchdogMs)
    expect(CLI_FILES_LIMITS.watchdogMs).toBeLessThan(CLI_FILES_LIMITS.testMs)
    expect(CLI_FILES_LIMITS.testMs).toBeLessThan(CLI_FILES_LIMITS.fileMs)

    for (const elapsedMs of [330_001, CLI_FILES_LIMITS.workMs - 1]) {
      const runner = createRunner()
      controlledNow = runner.startedAt + elapsedMs
      expect(() => runner.failIfStopped()).not.toThrow()
    }

    const expiredRunner = createRunner()
    controlledNow = expiredRunner.startedAt + CLI_FILES_LIMITS.workMs
    let synchronousFailure: unknown
    try {
      expiredRunner.failIfStopped()
    } catch (error) {
      synchronousFailure = error
    }
    expect(synchronousFailure).toMatchObject({ kind: 'deadline', message: workDeadlineMessage })

    const timerRunner = createRunner()
    const workTimer = timers.find(timer => timer.handle === timerRunner.workTimer)
    expect(workTimer?.delay).toBe(CLI_FILES_LIMITS.workMs)
    controlledNow = timerRunner.startedAt + CLI_FILES_LIMITS.workMs
    workTimer?.fire()
    expect(timerRunner.workController.signal.aborted).toBe(true)
    expect(() => timerRunner.failIfStopped()).toThrow(workDeadlineMessage)

    const cleanupRunner = createRunner()
    const cleanupTimeouts: number[] = []
    cleanupRunner.world = {
      cliEntry: '/repo/packages/cli/src/main.ts',
      execute: async (_argv: string[], options?: { timeoutMs?: number }) => {
        cleanupTimeouts.push(options?.timeoutMs ?? -1)
        return { stdout: '{}', stderr: '', exitCode: 0, stdoutBytes: 2, elapsedMs: 0 }
      }
    } as unknown as CliFilesWorld
    controlledNow = cleanupRunner.startedAt + CLI_FILES_LIMITS.workMs + CLI_FILES_LIMITS.cleanupMs - 5_000
    const cleanupDeadline = cleanupRunner.beginCleanup()
    expect(cleanupDeadline).toBe(cleanupRunner.startedAt + CLI_FILES_LIMITS.workMs + CLI_FILES_LIMITS.cleanupMs)
    const cleanupTimer = timers.find(timer => timer.handle === cleanupRunner.cleanupTimer)
    expect(cleanupTimer?.delay).toBe(5_000)
    await cleanupRunner.execute(['status'], { id: 'cleanup-reserve', cleanup: true })
    expect(cleanupTimeouts).toEqual([5_000])

    controlledNow = cleanupRunner.startedAt + CLI_FILES_LIMITS.workMs + CLI_FILES_LIMITS.cleanupMs
    await expect(cleanupRunner.execute(['status'], { id: 'cleanup-expired', cleanup: true }))
      .rejects.toMatchObject({ kind: 'cleanup-deadline', message: 'no teardown time remains' })
    expect(cleanupTimeouts).toEqual([5_000])
  } finally {
    for (const runner of runners) {
      if (runner.workTimer !== undefined) globalThis.clearTimeout(runner.workTimer)
      if (runner.cleanupTimer !== undefined) globalThis.clearTimeout(runner.cleanupTimer)
      runner.workController.abort()
      runner.cleanupController.abort()
    }
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    Date.now = realDateNow
  }
})

test('CLI-files world caps factory work at the policy limit and preserves shorter deadlines', async () => {
  const realDateNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let controlledNow = realDateNow()
  const scheduledDelays: number[] = []
  const fakeTimerHandles = new Set<ReturnType<typeof setTimeout>>()
  Date.now = () => controlledNow
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const delay = Number(args[1] ?? 0)
    if (delay === CLI_FILES_LIMITS.workMs || delay === 5_000) {
      scheduledDelays.push(delay)
      const handle = {} as ReturnType<typeof setTimeout>
      fakeTimerHandles.add(handle)
      return handle
    }
    return realSetTimeout(...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (!fakeTimerHandles.has(handle)) realClearTimeout(handle)
  }) as typeof clearTimeout
  const worlds: CliFilesWorld[] = []
  const fixtures: Array<{ dispose(): void }> = []

  try {
    const factory = requireFactory()
    for (const requestedMs of [CLI_FILES_LIMITS.workMs + 10_000, 5_000]) {
      const scheduledDelayCount = scheduledDelays.length
      const fixture = makeFactoryFixture()
      fixtures.push(fixture)
      const startedAt = controlledNow
      const effectiveMs = Math.min(requestedMs, CLI_FILES_LIMITS.workMs)
      const world = await factory({ deadline: startedAt + requestedMs }, fixture.dependencies)
      worlds.push(world)
      expect(scheduledDelays.slice(scheduledDelayCount)).toContain(effectiveMs)

      controlledNow = startedAt + effectiveMs
      await expect(world.execute([process.execPath, world.cliEntry]))
        .rejects.toMatchObject({ kind: 'deadline', message: 'CLI files work deadline reached' })
      await world.cleanup()
      worlds.pop()
      fixture.dispose()
      fixtures.pop()
      controlledNow += 1
    }
  } finally {
    try {
      for (const world of worlds) await world.cleanup()
    } finally {
      for (const fixture of fixtures) fixture.dispose()
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      Date.now = realDateNow
    }
  }
})

test('CLI-files captures coherent window evidence within the remaining-work deadline', async () => {
  const realDateNow = Date.now
  let controlledNow = realDateNow()
  Date.now = () => controlledNow
  const home = '/owned-cli-files'
  const cliEntry = `${home}/packages/cli/src/main.ts`
  const assignedWorktrees = new Map([[41, 'assigned-a'], [42, 'assigned-b']])
  const shownWorktrees = new Map([[41, 'shown-a'], [42, 'shown-b']])
  type ReadMarker = {
    phase: string
    kind: 'cli' | 'dom'
    operation: string
    connId?: number
    worktree?: string
    startedOrder?: number
    completedOrder?: number
    done: boolean
  }
  const markers: ReadMarker[] = []
  const barriers: Array<{ name: string; order: number }> = []
  let ioOrder = 0
  let phase = 'sample'
  let flushQueued = false
  let pending: Array<{ marker: ReadMarker; resolve(): void }> = []
  const boundedRead = (marker: ReadMarker): Promise<void> => {
    markers.push(marker)
    marker.startedOrder = ioOrder++
    const { promise, resolve } = Promise.withResolvers<void>()
    pending.push({ marker, resolve })
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(() => {
        flushQueued = false
        controlledNow += 3_000
        const batch = pending
        pending = []
        for (const entry of batch) {
          entry.marker.done = true
          entry.marker.completedOrder = ioOrder++
          entry.resolve()
        }
      })
    }
    return promise
  }
  const domFor = (connId: number) => ({
    connId: 0,
    workspaceId: shownWorktrees.get(connId)!,
    groupId: `group-${connId}`,
    selectedTabId: null,
    renderedTabId: null,
    path: null,
    documentHasFocus: true,
    activeElement: { tag: 'BODY', role: null, inDocument: true },
    activeElementHostedTabId: null,
    activeElementIsSource: false,
    reviewTabMounted: false,
    reviewScopeChip: null,
    reviewWidth: 0,
    reviewScrollTop: 0,
    caret: null,
    lines: [],
    reviewCards: []
  })
  const argument = (argv: string[], flag: string) => {
    const index = argv.indexOf(flag)
    return index < 0 ? undefined : argv[index + 1]
  }
  const workspaceFor = (worktree: string) => {
    const groupId = worktree === 'shown-a' ? 'group-41' : 'group-42'
    return { id: worktree, activeGroup: groupId, root: { kind: 'group', id: groupId, tabs: [], activeTab: null } }
  }
  const windows = ([41, 42] as const).map(connId => ({
    connId,
    worktree: { id: assignedWorktrees.get(connId)! },
    record: { index: connId === 41 ? 0 : 1, connId, worktree: assignedWorktrees.get(connId)!, open: true, shown: true },
    page: {
      isClosed: () => false,
      evaluate: async () => {
        await boundedRead({ phase, kind: 'dom', operation: `dom-${connId}`, connId, done: false })
        return domFor(connId)
      }
    }
  }))
  const recordingWorld = {
    home,
    cliEntry,
    execute: async (argv: string[], options?: { timeoutMs?: number }) => {
      const startedAt = controlledNow
      let result: Record<string, unknown>
      let operation: string
      let connId: number | undefined
      let worktree: string | undefined
      if (argv[2] === 'api' && argv[3] === 'call') {
        operation = argv[4]!
        if (operation === 'ui.window.state') {
          connId = Number(argument(argv, '--conn-id'))
          worktree = shownWorktrees.get(connId)
          result = { connId, layout: { worktree, view: null } }
        } else if (operation === 'quirky.terminal/workspace') {
          worktree = argument(argv, '--workspace')
          result = workspaceFor(worktree!)
        } else if (operation === 'quirky.worktree/navigationState') {
          connId = Number(argument(argv, '--window'))
          worktree = shownWorktrees.get(connId)
          result = { worktrees: [worktree], index: 0 }
        } else {
          throw new Error(`unexpected recording API call: ${operation}`)
        }
      } else if (argv[2] === 'editor' && argv[3] === 'state') {
        operation = 'editor.state'
        worktree = argument(argv, '--worktree')
        result = { buffers: [] }
      } else {
        throw new Error(`unexpected recording CLI command: ${argv[2]}`)
      }
      const marker: ReadMarker = { phase, kind: 'cli', operation, ...(connId ? { connId } : {}), ...(worktree ? { worktree } : {}), done: false }
      await boundedRead(marker)
      if (options?.timeoutMs !== undefined && controlledNow - startedAt > options.timeoutMs) {
        throw new Error(`recorded child exceeded its supplied ${options.timeoutMs}ms timeout`)
      }
      const stdout = JSON.stringify(result)
      return { stdout, stderr: '', exitCode: 0, stdoutBytes: Buffer.byteLength(stdout), elapsedMs: 0 }
    }
  } as unknown as NonNullable<CliFilesRunner['world']>
  const runners: CliFilesRunner[] = []
  const createRunner = () => {
    const runner = new CliFilesRunner({})
    runners.push(runner)
    runner.home = home
    runner.windows = windows as unknown as typeof runner.windows
    runner.world = recordingWorld
    return runner
  }

  try {
    const sampleRunner = createRunner()
    controlledNow = sampleRunner.workDeadline - 10_000
    const sample = await sampleRunner.captureSample('deadline-sample')
    expect(controlledNow).toBeLessThan(sampleRunner.workDeadline)
    expect(sample.public.map(window => window.connId)).toEqual([41, 42])
    expect(sample.public.map(window => window.windowState)).toMatchObject([
      { layout: { worktree: 'shown-a' } },
      { layout: { worktree: 'shown-b' } }
    ])
    expect(sample.snapshots.map(snapshot => snapshot.windowWorktree)).toEqual(['shown-a', 'shown-b'])
    expect(sample.dom.map(window => window.workspaceId)).toEqual(['shown-a', 'shown-b'])
    expect(sample.snapshots.map(snapshot => snapshot.windowWorktree === assignedWorktrees.get(snapshot.connId))).toEqual([false, false])
    const sampleReads = markers.filter(marker => marker.phase === 'sample')
    for (const [connId, worktree] of [[41, 'shown-a'], [42, 'shown-b']] as const) {
      const state = sampleReads.find(marker => marker.operation === 'ui.window.state' && marker.connId === connId)
      const workspace = sampleReads.find(marker => marker.operation === 'quirky.terminal/workspace' && marker.worktree === worktree)
      const editor = sampleReads.find(marker => marker.operation === 'editor.state' && marker.worktree === worktree)
      const dom = sampleReads.find(marker => marker.kind === 'dom' && marker.connId === connId)
      expect(state?.done).toBe(true)
      expect(workspace?.worktree).toBe(worktree)
      expect(editor?.worktree).toBe(worktree)
      expect(state?.completedOrder).toBeLessThan(workspace?.startedOrder ?? Number.POSITIVE_INFINITY)
      expect(state?.completedOrder).toBeLessThan(editor?.startedOrder ?? Number.POSITIVE_INFINITY)
      expect(dom?.startedOrder).toBeGreaterThan(Math.max(
        workspace?.completedOrder ?? Number.POSITIVE_INFINITY,
        editor?.completedOrder ?? Number.POSITIVE_INFINITY
      ))
    }

    const transitionRunner = createRunner()
    controlledNow = transitionRunner.workDeadline - 27_000
    phase = 'transition-before'
    const transition = await transitionRunner.transition('deadline-transition', async () => {
      const beforeReads = markers.filter(marker => marker.phase === 'transition-before')
      expect(beforeReads.every(marker => marker.done)).toBe(true)
      expect(beforeReads.some(marker => marker.operation === 'quirky.worktree/navigationState')).toBe(true)
      barriers.push({ name: 'mutate', order: ioOrder++ })
      phase = 'transition-after'
      return { changed: true }
    }, async () => {
      barriers.push({ name: 'waitForRender', order: ioOrder++ })
      const afterReads = markers.filter(marker => marker.phase === 'transition-after')
      const histories = afterReads.filter(marker => marker.operation === 'quirky.worktree/navigationState')
      const publicReads = afterReads.filter(marker =>
        marker.operation === 'quirky.terminal/workspace' || marker.operation === 'editor.state')
      expect(histories.every(marker => marker.done)).toBe(true)
      expect(publicReads.every(marker => marker.done)).toBe(true)
      expect(Math.max(...histories.map(marker => marker.completedOrder ?? Number.NEGATIVE_INFINITY)))
        .toBeLessThan(Math.min(...publicReads.map(marker => marker.startedOrder ?? Number.POSITIVE_INFINITY)))
      for (const [connId, worktree] of [[41, 'shown-a'], [42, 'shown-b']] as const) {
        const layout = afterReads.find(marker => marker.operation === 'ui.window.state' && marker.connId === connId)
        const history = histories.find(marker => marker.connId === connId)
        const workspace = publicReads.find(marker => marker.operation === 'quirky.terminal/workspace' && marker.worktree === worktree)
        const editor = publicReads.find(marker => marker.operation === 'editor.state' && marker.worktree === worktree)
        expect(layout?.done).toBe(true)
        expect(history?.done).toBe(true)
        expect(layout?.completedOrder).toBeLessThan(history?.startedOrder ?? Number.POSITIVE_INFINITY)
        expect(workspace?.done).toBe(true)
        expect(editor?.done).toBe(true)
      }
      expect(afterReads.some(marker => marker.kind === 'dom')).toBe(false)
    })
    expect(controlledNow).toBeLessThan(transitionRunner.workDeadline)
    expect(barriers.map(barrier => barrier.name)).toEqual(['mutate', 'waitForRender'])
    expect(transition.before.snapshots.map(snapshot => snapshot.windowWorktree)).toEqual(['shown-a', 'shown-b'])
    expect(transition.after.snapshots.map(snapshot => snapshot.windowWorktree)).toEqual(['shown-a', 'shown-b'])
    expect([transition.historyBefore.target.connId, transition.historyBefore.other.connId]).toEqual([41, 42])
    expect([transition.historyBefore.target.shownWorktree, transition.historyBefore.other.shownWorktree]).toEqual(['shown-a', 'shown-b'])
    expect([transition.historyAfter.target.connId, transition.historyAfter.other.connId]).toEqual([41, 42])
    expect([transition.historyAfter.target.shownWorktree, transition.historyAfter.other.shownWorktree]).toEqual(['shown-a', 'shown-b'])
    const renderBarrier = barriers.find(barrier => barrier.name === 'waitForRender')
    const firstAfterDom = markers.find(marker => marker.phase === 'transition-after' && marker.kind === 'dom')
    expect(firstAfterDom?.startedOrder).toBeGreaterThan(renderBarrier?.order ?? Number.POSITIVE_INFINITY)

    const otherRunner = createRunner()
    controlledNow = otherRunner.workDeadline - 8_000
    phase = 'other-window'
    const other = await otherRunner.captureOtherWindow('deadline-other-window')
    expect(controlledNow).toBeLessThan(otherRunner.workDeadline)
    expect(other.connId).toBe(42)
    expect(other.windowState).toMatchObject({ layout: { worktree: 'shown-b' } })
    expect(other.history.shownWorktree).toBe('shown-b')
    const otherReads = markers.filter(marker => marker.phase === 'other-window')
    const otherState = otherReads.find(marker => marker.operation === 'ui.window.state')
    const otherHistory = otherReads.find(marker => marker.operation === 'quirky.worktree/navigationState')
    const otherDom = otherReads.find(marker => marker.kind === 'dom')
    expect(otherState?.done).toBe(true)
    expect(otherHistory?.worktree).toBe('shown-b')
    expect(other.dom.workspaceId).toBe('shown-b')
    expect(otherState?.completedOrder).toBeLessThan(otherHistory?.startedOrder ?? Number.POSITIVE_INFINITY)
    expect(otherState?.completedOrder).toBeLessThan(otherDom?.startedOrder ?? Number.POSITIVE_INFINITY)
  } finally {
    for (const runner of runners) {
      clearTimeout(runner.workTimer)
      clearTimeout(runner.cleanupTimer)
      runner.workController.abort()
    }
    Date.now = realDateNow
  }
})

test('CLI-files drains started snapshot reads before preserving the primary failure', async () => {
  const runner = new CliFilesRunner({})
  const home = '/owned-cli-files-drain'
  const cliEntry = `${home}/packages/cli/src/main.ts`
  const primaryError = new Error('primary public read failed')
  const heldRead = Promise.withResolvers<void>()
  const failedRead = Promise.withResolvers<void>()
  const shownWorktrees = new Map([[41, 'shown-a'], [42, 'shown-b']])
  let siblingStarted = false
  let pendingReads = 0
  let mutationCount = 0
  let renderWaitCount = 0
  const domFor = (connId: number) => ({
    connId: 0,
    workspaceId: shownWorktrees.get(connId)!,
    groupId: `group-${connId}`,
    selectedTabId: null,
    renderedTabId: null,
    path: null,
    documentHasFocus: true,
    activeElement: { tag: 'BODY', role: null, inDocument: true },
    activeElementHostedTabId: null,
    activeElementIsSource: false,
    reviewTabMounted: false,
    reviewScopeChip: null,
    reviewWidth: 0,
    reviewScrollTop: 0,
    caret: null,
    lines: [],
    reviewCards: []
  })
  const argument = (argv: string[], flag: string) => {
    const index = argv.indexOf(flag)
    return index < 0 ? undefined : argv[index + 1]
  }
  const windows = ([41, 42] as const).map(connId => ({
    connId,
    worktree: { id: `assigned-${connId}` },
    record: { index: connId === 41 ? 0 : 1, connId, worktree: `assigned-${connId}`, open: true, shown: true },
    page: { isClosed: () => false, evaluate: async () => domFor(connId) }
  }))
  runner.home = home
  runner.windows = windows as unknown as typeof runner.windows
  runner.world = {
    home,
    cliEntry,
    execute: async (argv: string[]) => {
      pendingReads += 1
      try {
        let result: Record<string, unknown>
        if (argv[2] === 'api' && argv[3] === 'call' && argv[4] === 'ui.window.state') {
          const connId = Number(argument(argv, '--conn-id'))
          if (connId === 41) {
            failedRead.resolve()
            throw primaryError
          }
          if (connId === 42) {
            siblingStarted = true
            await heldRead.promise
          }
          result = { connId, layout: { worktree: shownWorktrees.get(connId), view: null } }
        } else if (argv[2] === 'api' && argv[3] === 'call' && argv[4] === 'quirky.terminal/workspace') {
          const worktree = argument(argv, '--workspace')!
          const connId = worktree === 'shown-a' ? 41 : 42
          const groupId = `group-${connId}`
          result = { id: worktree, activeGroup: groupId, root: { kind: 'group', id: groupId, tabs: [], activeTab: null } }
        } else if (argv[2] === 'editor' && argv[3] === 'state') {
          result = { buffers: [] }
        } else {
          throw new Error(`unexpected recording CLI command: ${argv[2]}`)
        }
        const stdout = JSON.stringify(result)
        return { stdout, stderr: '', exitCode: 0, stdoutBytes: Buffer.byteLength(stdout), elapsedMs: 0 }
      } finally {
        pendingReads -= 1
      }
    }
  } as unknown as NonNullable<typeof runner.world>

  let settledBeforeRelease = false
  let completion: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
  try {
    completion = runner.transition('drain-transition', async () => {
      mutationCount += 1
      return { changed: true }
    }, async () => {
      renderWaitCount += 1
    }).then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error })
    )
    void completion.then(() => { settledBeforeRelease = true })
    await failedRead.promise
    const eventLoopTurn = Promise.withResolvers<void>()
    setImmediate(eventLoopTurn.resolve)
    await eventLoopTurn.promise
    if (siblingStarted) {
      expect(settledBeforeRelease).toBe(false)
      expect(pendingReads).toBe(1)
    }
    heldRead.resolve()
    const result = await completion
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(primaryError)
    expect(pendingReads).toBe(0)
    expect(mutationCount).toBe(0)
    expect(renderWaitCount).toBe(0)
  } finally {
    heldRead.resolve()
    if (completion) await completion
    clearTimeout(runner.workTimer)
    clearTimeout(runner.cleanupTimer)
    runner.workController.abort()
  }
})
test('CLI-files concurrent live health probes restore the caller environment and spawn function', async () => {
  const fixture = makeFactoryFixture()
  const originalEnvironment = { ...process.env }
  const originalSpawnSync = Bun.spawnSync
  const healthResponses: Array<PromiseWithResolvers<boolean>> = []
  const firstHealthStarted = Promise.withResolvers<void>()
  const secondHealthStarted = Promise.withResolvers<void>()
  let holdHealthResponses = false
  let world: CliFilesWorld | undefined
  const liveChecks: Promise<unknown>[] = []
  try {
    process.env.QUIRKY_HEALTH_ENV_LIFETIME = 'caller'
    fixture.dependencies.isDaemonAlive = async () => {
      if (!holdHealthResponses) return true
      const response = Promise.withResolvers<boolean>()
      healthResponses.push(response)
      if (healthResponses.length === 1) firstHealthStarted.resolve()
      if (healthResponses.length === 2) secondHealthStarted.resolve()
      return response.promise
    }
    world = await requireFactory()({}, fixture.dependencies)
    const callerEnvironment = { ...process.env }
    const identityReadsBefore = fixture.state.processSnapshotCalls
    const shownRecordChecksBefore = fixture.state.shownRecordChecks
    const shownConnectionChecksBefore = fixture.state.shownConnectionChecks
    holdHealthResponses = true
    const first = world.assertLive().then(() => undefined, error => error)
    const second = world.assertLive().then(() => undefined, error => error)
    liveChecks.push(first, second)

    await firstHealthStarted.promise
    const eventLoopTurn = Promise.withResolvers<void>()
    setImmediate(eventLoopTurn.resolve)
    await eventLoopTurn.promise
    const overlappedBeforeFirstRelease = healthResponses.length === 2

    healthResponses[0]!.resolve(true)
    const firstFailure = await first
    await secondHealthStarted.promise
    healthResponses[1]!.resolve(true)
    const secondFailure = await second

    expect(firstFailure).toBeUndefined()
    expect(secondFailure).toBeUndefined()
    expect(overlappedBeforeFirstRelease).toBe(true)
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(originalSpawnSync)
    expect(fixture.state.processSnapshotCalls).toBeGreaterThan(identityReadsBefore)
    expect(fixture.state.shownRecordChecks).toBeGreaterThan(shownRecordChecksBefore)
    expect(fixture.state.shownConnectionChecks).toBeGreaterThan(shownConnectionChecksBefore)
  } finally {
    holdHealthResponses = false
    for (const response of healthResponses) response.resolve(true)
    await Promise.allSettled(liveChecks)
    try {
      await world?.cleanup()
    } finally {
      Bun.spawnSync = originalSpawnSync
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnvironment)
      fixture.dispose()
    }
  }
})

test('CLI-files aborts a pending live health probe without holding caller globals through cleanup', async () => {
  const fixture = makeFactoryFixture()
  const originalEnvironment = { ...process.env }
  const originalSpawnSync = Bun.spawnSync
  const pendingHealth = Promise.withResolvers<boolean>()
  const healthStarted = Promise.withResolvers<void>()
  const cleanupTimedOut = Promise.withResolvers<boolean>()
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let holdHealthResponse = false
  let world: CliFilesWorld | undefined
  let liveCheck: Promise<unknown> | undefined
  let cleanup: Promise<void> | undefined
  try {
    process.env.QUIRKY_HEALTH_ENV_LIFETIME = 'caller'
    fixture.dependencies.isDaemonAlive = async () => {
      if (!holdHealthResponse) return true
      healthStarted.resolve()
      return pendingHealth.promise
    }
    world = await requireFactory()({}, fixture.dependencies)
    const callerEnvironment = { ...process.env }
    holdHealthResponse = true
    const controller = new AbortController()
    liveCheck = world.assertLive({ signal: controller.signal }).then(
      () => undefined,
      error => error
    )
    await healthStarted.promise
    controller.abort(new Error('recorded health cancellation'))
    const cancellation = await liveCheck
    expect(cancellation).toMatchObject({ message: 'recorded health cancellation' })

    cleanup = world.cleanup()
    // A real-time bound detects a cleanup deadlock, for which no event can be awaited.
    cleanupTimer = setTimeout(() => cleanupTimedOut.resolve(false), 1_000)
    const cleanedUp = await Promise.race([
      cleanup.then(() => true, () => false),
      cleanupTimedOut.promise
    ])
    expect(cleanedUp).toBe(true)
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(originalSpawnSync)
  } finally {
    holdHealthResponse = false
    pendingHealth.resolve(true)
    const releasedProbeTurn = Promise.withResolvers<void>()
    setImmediate(releasedProbeTurn.resolve)
    await releasedProbeTurn.promise
    clearTimeout(cleanupTimer)
    await Promise.allSettled([...(liveCheck ? [liveCheck] : []), ...(cleanup ? [cleanup] : [])])
    try {
      await world?.cleanup()
    } finally {
      Bun.spawnSync = originalSpawnSync
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnvironment)
      fixture.dispose()
    }
  }
})
test('CLI-files synchronous scope calls forward both supported Bun spawn forms with the owned environment', async () => {
  const fixture = makeFactoryFixture({ worldStopFailure: true })
  const originalEnvironment = { ...process.env }
  const originalSpawnSync = Bun.spawnSync
  const spawnCalls: unknown[][] = []
  const argvEnvironment = { PATH: '/explicit/argv' }
  const objectEnvironment = { PATH: '/explicit/object' }
  const explicitOwnedSpawnSync = ((...args: unknown[]) => {
    spawnCalls.push(args)
    return { exitCode: 0, stdout: '', stderr: '' }
  }) as unknown as typeof Bun.spawnSync
  const originalScopeSpawn = fixture.scope.spawn.bind(fixture.scope)
  let spawnHome: string | undefined
  let unsupportedRejected = false
  let world: CliFilesWorld | undefined
  fixture.scope.spawn = (command, options) => {
    if (spawnCalls.length === 0) {
      spawnHome = process.env.QUIRKY_HOME
      const spawnSync = Bun.spawnSync as unknown as (...args: unknown[]) => unknown
      spawnSync(['/recorded/argv-explicit'], { env: argvEnvironment })
      spawnSync(['/recorded/argv-owned'])
      spawnSync({ cmd: ['/recorded/object-explicit'], env: objectEnvironment })
      spawnSync({ cmd: ['/recorded/object-undefined'], env: undefined })
      spawnSync({ cmd: ['/recorded/object-owned'] })
      try {
        spawnSync({ cmd: 'unsupported-command' })
      } catch {
        unsupportedRejected = true
      }
    }
    return originalScopeSpawn(command, options)
  }
  try {
    Bun.spawnSync = explicitOwnedSpawnSync
    world = await requireFactory()({}, fixture.dependencies)
    const cleanupFailure = await world.cleanup().then(
      () => undefined,
      error => error
    )
    const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
    expect(cleanupMessage.includes('scope process calls must use executable argv')).toBe(false)
    expect(cleanupMessage).toContain('recording world stop failed')
    expect(spawnCalls).toHaveLength(5)
    const explicitArgvOptions = spawnCalls[0]![1] as { env?: Record<string, string> }
    const ownedEnvironment = spawnCalls[1]![1] as { env?: Record<string, string> }
    const explicitObjectCall = spawnCalls[2]![0] as { cmd: string[]; env?: Record<string, string> }
    const objectWithoutEnv = spawnCalls[3]![0] as { cmd: string[]; env?: Record<string, string> }
    const objectWithOmittedEnv = spawnCalls[4]![0] as { cmd: string[]; env?: Record<string, string> }

    expect(spawnHome).toBe(fixture.home)
    expect(spawnCalls.map(([first]) => Array.isArray(first) ? 'argv' : 'object'))
      .toEqual(['argv', 'argv', 'object', 'object', 'object'])
    expect(explicitArgvOptions.env).toBe(argvEnvironment)
    expect(ownedEnvironment.env?.QUIRKY_HOME).toBe(fixture.home)
    expect(explicitObjectCall.env).toBe(objectEnvironment)
    expect(objectWithoutEnv.env?.QUIRKY_HOME).toBe(fixture.home)
    expect(objectWithOmittedEnv.env?.QUIRKY_HOME).toBe(fixture.home)
    expect(unsupportedRejected).toBe(true)
    expect(Bun.spawnSync).toBe(explicitOwnedSpawnSync)
    expect(isDeepStrictEqual({ ...process.env }, originalEnvironment)).toBe(true)
  } finally {
    try {
      if (world) await Promise.allSettled([world.cleanup()])
    } finally {
      Bun.spawnSync = originalSpawnSync
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnvironment)
      fixture.dispose()
    }
  }
})
test('CLI-files default health fetch uses its owned loopback environment and releases caller globals while pending', async () => {
  const fixture = makeFactoryFixture()
  const originalEnvironment = { ...process.env }
  const originalSpawnSync = Bun.spawnSync
  const healthResponse = Promise.withResolvers<Response>()
  const proxyResponse = Promise.withResolvers<Response>()
  const arrival = Promise.withResolvers<'health' | 'proxy' | 'settled' | 'timeout'>()
  const proxyKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
  let healthRequests = 0
  let proxyRequests = 0
  let holdResponses = false
  let healthServer: Bun.Server<undefined> | undefined
  let proxyServer: Bun.Server<undefined> | undefined
  let arrivalTimer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let world: CliFilesWorld | undefined
  let liveCheck: Promise<unknown> | undefined
  try {
    healthServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        healthRequests += 1
        if (!holdResponses) return Response.json({ pid: 701 })
        arrival.resolve('health')
        return healthResponse.promise
      }
    })
    proxyServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        proxyRequests += 1
        if (!holdResponses) return Response.json({ pid: 701 })
        arrival.resolve('proxy')
        return proxyResponse.promise
      }
    })
    const healthPort = healthServer.port
    const proxyPort = proxyServer.port
    if (healthPort === undefined || proxyPort === undefined) throw new Error('health fixture requires TCP listener ports')
    for (const key of proxyKeys) delete process.env[key]
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`

    const startWorld = fixture.dependencies.startWorld as (
      worldOptions: Record<string, unknown>,
      startDependencies: Record<string, unknown>
    ) => Promise<{ runtime: { port: number } }>
    fixture.dependencies.startWorld = async (
      worldOptions: Record<string, unknown>,
      startDependencies: Record<string, unknown>
    ) => {
      const started = await startWorld(worldOptions, startDependencies)
      started.runtime.port = healthPort
      return started
    }
    const readRuntime = fixture.dependencies.readRuntime as () => {
      pid: number; home: string; port: number; token: string; hookToken: string; entryHash: string
    } | undefined
    fixture.dependencies.readRuntime = () => {
      const runtime = readRuntime()
      return runtime ? { ...runtime, port: healthPort } : undefined
    }
    delete fixture.dependencies.isDaemonAlive

    world = await requireFactory()({}, fixture.dependencies)
    const callerEnvironment = { ...process.env }
    const healthRequestsBefore = healthRequests
    const proxyRequestsBefore = proxyRequests
    holdResponses = true
    controller = new AbortController()
    liveCheck = world.assertLive({ signal: controller.signal }).then(
      () => undefined,
      error => error
    )
    // Bound the local-server wait so a broken fetch setup cannot strand this regression.
    arrivalTimer = setTimeout(() => {
      arrival.resolve('timeout')
      controller?.abort(new Error('loopback health request did not arrive'))
    }, 1_000)
    const observedRoute = await Promise.race([
      arrival.promise,
      liveCheck.then(() => 'settled' as const)
    ])

    expect(observedRoute).toBe('health')
    expect(healthRequests).toBeGreaterThan(healthRequestsBefore)
    expect(proxyRequests).toBe(proxyRequestsBefore)
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(originalSpawnSync)

    healthResponse.resolve(Response.json({ pid: 701 }))
    expect(await liveCheck).toBeUndefined()
    expect(proxyRequests).toBe(proxyRequestsBefore)
  } finally {
    holdResponses = false
    controller?.abort(new Error('health probe test cleanup'))
    healthResponse.resolve(Response.json({ pid: 701 }))
    proxyResponse.resolve(Response.json({ pid: 701 }))
    clearTimeout(arrivalTimer)
    const releasedResponseTurn = Promise.withResolvers<void>()
    setImmediate(releasedResponseTurn.resolve)
    await releasedResponseTurn.promise
    await Promise.allSettled([...(liveCheck ? [liveCheck] : []), ...(world ? [world.cleanup()] : [])])
    try {
      await Promise.allSettled([healthServer?.stop(true), proxyServer?.stop(true)])
    } finally {
      Bun.spawnSync = originalSpawnSync
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnvironment)
      fixture.dispose()
    }
  }
})
test('CLI-files overlapping failed-stop cleanups keep explicit environments across awaits without changing globals', async () => {
  const fixtureA = makeFactoryFixture({ worldStopFailure: true })
  const fixtureB = makeFactoryFixture({ worldStopFailure: true })
  const callerEnvironment = { ...process.env }
  const callerSpawnSync = Bun.spawnSync
  const enteredA = Promise.withResolvers<void>()
  const enteredB = Promise.withResolvers<void>()
  const releaseA = Promise.withResolvers<void>()
  const releaseB = Promise.withResolvers<void>()
  const cleanupFailure = new Error('recorded scope cleanup failure')
  const originalCleanupA = fixtureA.scope.cleanup.bind(fixtureA.scope)
  const originalCleanupB = fixtureB.scope.cleanup.bind(fixtureB.scope)
  const environments: Array<Record<string, string> | undefined> = []
  let worldA: CliFilesWorld | undefined
  let worldB: CliFilesWorld | undefined
  let resultA: Promise<unknown> | undefined
  let resultB: Promise<unknown> | undefined
  fixtureA.scope.cleanup = async env => {
    environments[0] = env
    enteredA.resolve()
    await releaseA.promise
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(callerSpawnSync)
    await originalCleanupA()
    throw cleanupFailure
  }
  fixtureB.scope.cleanup = async env => {
    environments[1] = env
    enteredB.resolve()
    await releaseB.promise
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(callerSpawnSync)
    await originalCleanupB()
  }
  try {
    worldA = await requireFactory()({}, fixtureA.dependencies)
    worldB = await requireFactory()({}, fixtureB.dependencies)
    resultA = worldA.cleanup().then(() => undefined, error => error)
    await enteredA.promise
    expect(environments[0]?.QUIRKY_HOME).toBe(fixtureA.home)
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(callerSpawnSync)
    resultB = worldB.cleanup().then(() => undefined, error => error)
    await enteredB.promise
    expect(environments[1]?.QUIRKY_HOME).toBe(fixtureB.home)
    expect(environments[0]).not.toBe(environments[1])
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    releaseA.resolve()
    releaseB.resolve()
    const [failureA, failureB] = await Promise.all([resultA, resultB])
    expect((failureA as Error).message).toContain('recorded scope cleanup failure')
    expect((failureA as Error).message).toContain('recording world stop failed')
    expect((failureB as Error).message).toContain('recording world stop failed')
    expect(fixtureA.events.filter(event => event === 'scope.cleanup')).toHaveLength(1)
    expect(fixtureB.events.filter(event => event === 'scope.cleanup')).toHaveLength(1)
    expect(isDeepStrictEqual({ ...process.env }, callerEnvironment)).toBe(true)
    expect(Bun.spawnSync).toBe(callerSpawnSync)
  } finally {
    releaseA.resolve()
    releaseB.resolve()
    await Promise.allSettled([
      ...(resultA ? [resultA] : worldA ? [worldA.cleanup()] : []),
      ...(resultB ? [resultB] : worldB ? [worldB.cleanup()] : [])
    ])
    Bun.spawnSync = callerSpawnSync
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, callerEnvironment)
    fixtureA.dispose()
    fixtureB.dispose()
  }
})
