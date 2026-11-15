import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as cliWorldModule from './cli-world'

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
type StartupDiagnostics = {
  phase: string
  elapsedMs: number
  buildElapsedMs: number
  rendererElapsedMs: number
  assets?: { uiDir: string; pluginsDir: string }
  renderer: StartupObservation[]
  logs: { buildTail?: string; daemonTail?: string; rendererTail?: string }
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
      homeRemoved: boolean
      started: { daemon: boolean; browser: boolean }
      unresolvedAcquisition: boolean
      scopeCleanupComplete: boolean
      acquisitionSettled: boolean
    }
  }
}
type CliFilesStartupError = Error & { kind: string; cleanupError?: string; startupEvidence: StartupEvidence }
type StartupErrorConstructor = new (kind: string, message: string, evidence: StartupEvidence, stderrTail?: string) => CliFilesStartupError
type FakeChild = { pid: number; exited: Promise<number> }
type FakeScope = {
  home: string
  env: Record<string, string>
  spawn(command: string[], options?: { env?: Record<string, string> }): FakeChild
  cleanup(): Promise<void>
  killNow(): void
  track(pid: number): void
}
type Factory = (options?: { signal?: AbortSignal; deadline?: number }, dependencies?: Record<string, unknown>) => Promise<{
  home: string
  env: Record<string, string>
  buildElapsedMs: number
  startupDiagnostics?: StartupDiagnostics
  cleanup(): Promise<void>
  cleanupEvidence: StartupEvidence['cleanup']['evidence']
}>

const cliWorldNamespace = cliWorldModule as unknown as {
  createCliFilesWorld?: Factory
  CliFilesStartupError?: StartupErrorConstructor
}

function requireFactory(): Factory {
  if (!cliWorldNamespace.createCliFilesWorld) throw new Error('createCliFilesWorld is not exported')
  return cliWorldNamespace.createCliFilesWorld
}


function captureFailure<T>(promise: Promise<T>): Promise<Error & { kind?: string; startupEvidence?: StartupEvidence }> {
  return promise.then(
    () => { throw new Error('expected startup construction to reject') },
    (error: unknown) => error instanceof Error ? error as Error & { kind?: string; startupEvidence?: StartupEvidence } : new Error(String(error))
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
  guardFailure?: boolean
  fixtureFailure?: boolean
  buildFailure?: boolean
  chromeMissing?: boolean
  rendererFailure?: boolean
  processTableFailure?: boolean
  survivor?: boolean
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
    helperEnv: undefined as Record<string, string> | undefined,
    preparedEnv: undefined as Record<string, string> | undefined,
    buildEnv: undefined as Record<string, string> | undefined,
    daemonEnv: undefined as Record<string, string> | undefined,
    lastObservation: undefined as StartupObservation | undefined
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
    finish: async () => ({ records: records.map(record => ({ ...record })), requests: [] }),
    stop: async () => {
      events.push('browser.stop')
      state.livePids.delete(801)
    }
  }
  const currentIdentity = (pid: number): ProcessIdentity => {
    if (pid === 701 && state.reusedDaemonPid) {
      return { pid, ppid: 1, pgid: 1, started: 'unrelated-reused-pid', state: 'S', command: '/usr/bin/unrelated-sentinel' }
    }
    return {
      pid,
      ppid: process.pid,
      pgid: process.pid,
      started: `owned-start-${pid}`,
      state: 'S',
      command: pid === 701 ? `${process.execPath} packages/daemon/src/main.ts` : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    }
  }
  const processSnapshot = (_ownedHome: string): Map<number, ProcessIdentity> => {
    if (state.failProcessTable) throw new Error('recording process table unavailable')
    const pids = new Set(state.livePids)
    if (state.reusedDaemonPid) pids.add(701)
    return new Map([...pids].map(pid => [pid, currentIdentity(pid)]))
  }
  const scope: FakeScope = {
    home,
    env: { QUIRKY_HOME: home, QUIRKY_TEST_SCOPE: 'runtime-token' },
    spawn(command, spawnOptions) {
      const env = spawnOptions?.env
      if (command[1] === 'packages/ui/build.ts') {
        events.push('build.spawn')
        state.buildEnv = env
        const exited = Promise.resolve(0).then(exitCode => {
          events.push('build.exit')
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
      if (!options.survivor) state.livePids.clear()
    },
    killNow() {
      events.push('scope.killNow')
      if (!options.survivor) state.livePids.clear()
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
    const longLog = `${home} runtime-token hook-token https://u:p@127.0.0.1/path?token=runtime-token&extra=value#fragment-secret ${'λ'.repeat(7_000)}\n`
    writeFileSync(join(outDir, 'ui-build.log'), longLog)
    writeFileSync(join(outDir, 'daemon.log'), longLog)
  }
  const dependencies: Record<string, unknown> = {
    createScope: () => {
      events.push('scope.create')
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
      expect(world.env).toBe(actual.state.helperEnv)
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
      expect(evidence?.cleanup.evidence.trackedIdentities).toEqual([])
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
      expect(world.env).toBe(fixture.state.helperEnv)
    } finally {
      await world.cleanup()
    }
  } finally {
    fixture.dispose()
  }
})
