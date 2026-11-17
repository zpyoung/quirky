import { afterEach, beforeEach, expect, test, vi } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient, PluginContext } from '@quirky/protocol'
import { validateValue } from '@quirky/protocol'
import { startChild, type StartedChild } from '../../packages/process/src/child.ts'
import { parseManifest } from '../../packages/daemon/src/plugins/manifest.ts'
import { buildFaultUi, faultPlan, inspectPtyHost, installFaultPlugin, installSlowGit, ownsPtyHost, ptyHostEntry, sameHost, setGitDelay, startFault } from './faults.ts'
import { FAULT_CHECK } from './contracts.ts'
import { activate } from './faults/main.ts'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope.ts'
import type { PtyHostInspection } from './faults.ts'
import type { PtyPauseDependencies, RunningFault } from './faults.ts'

const timerControls = vi as typeof vi & { advanceTimersByTime(milliseconds: number): void }

test('spreads eighty leaks over the first sixty percent of a short or long run', () => {
  expect(faultPlan('leak', 24)).toEqual({ kind: 'leak', count: 80, everyMs: 180, lifetimeSeconds: 54 })
  expect(faultPlan('leak', 1800)).toEqual({ kind: 'leak', count: 80, everyMs: 13500, lifetimeSeconds: 1830 })
})

test('bounds the leak interval and lifetime on extreme run lengths', () => {
  expect(faultPlan('leak', 200_000)).toEqual({ kind: 'leak', count: 80, everyMs: 60_000, lifetimeSeconds: 86_400 })
  expect(faultPlan('leak', 0.01)).toEqual({ kind: 'leak', count: 80, everyMs: 10, lifetimeSeconds: 31 })
})

test('plans zombie holders, bounded storms, a synchronous stall, slow git, and fixed feedback and flood', () => {
  expect(faultPlan('zombies', 24)).toEqual({ kind: 'zombies', holders: 2, each: 5, lifetimeSeconds: 54 })
  expect(faultPlan('storm', 24)).toEqual({ kind: 'storm', seconds: 10 })
  expect(faultPlan('block', 24)).toEqual({ kind: 'block', ms: 3000 })
  expect(faultPlan('slow-git', 24)).toEqual({ kind: 'slow-git', ms: 35_000 })
  expect(faultPlan('feedback', 24)).toEqual({ kind: 'feedback', refreshes: 17 })
  expect(faultPlan('flood', 24)).toEqual({ kind: 'flood', requests: 3000 })
  expect(FAULT_CHECK.flood).toBe('requests')
})

test('feedback injection requires two distinct ready-window worktrees', () => {
  const control = { callAny: async () => { throw new Error('unexpected plugin call') } } as unknown as QuirkyClient
  expect(() => startFault({
    kind: 'feedback',
    home: '/unused',
    control,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now(),
    signal: new AbortController().signal
  })).toThrow('feedback fault requires two distinct nonempty worktrees')
})

test('flood injection requires a valid copied window target', async () => {
  const control = { callAny: async () => ({ started: true }) } as unknown as QuirkyClient
  const base = {
    kind: 'flood' as const,
    home: '/unused',
    control,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now() - 2100,
    signal: new AbortController().signal
  }
  for (const floodWindow of [undefined, { index: -1, worktree: 'a' }, { index: 0.5, worktree: 'a' }, { index: 0, worktree: '' }, { index: 0, worktree: '  ' }]) {
    expect(() => startFault({ ...base, floodWindow })).toThrow('flood fault requires a nonnegative window index and nonempty worktree')
  }
})

type FixtureHandler = (params?: unknown) => unknown

function activateFixture() {
  const handlers = new Map<string, FixtureHandler>()
  const events: { type: string; data: unknown }[] = []
  const context = {
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation as FixtureHandler),
    emit: (type: string, data: unknown) => { events.push({ type, data }); return true }
  } as unknown as PluginContext
  const previous = process.env.QUIRKY_SOAK_FAULTS
  process.env.QUIRKY_SOAK_FAULTS = '1'
  let dispose: void | (() => void)
  try {
    dispose = activate(context)
  } finally {
    if (previous === undefined) delete process.env.QUIRKY_SOAK_FAULTS
    else process.env.QUIRKY_SOAK_FAULTS = previous
  }
  return { handlers, events, dispose }
}

test('declares feedback and flood schemas accepted by the daemon manifest validator', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, 'faults', 'quirky-plugin.json'), 'utf8'))
  const methods = Object.fromEntries(manifest.contributes.method.map((entry: { id: string }) => [entry.id, entry]))
  const events = Object.fromEntries(manifest.contributes.event.map((entry: { id: string }) => [entry.id, entry]))

  expect(validateValue(methods.feedbackStart.params, { worktrees: ['a', 'b'] })).toBeNull()
  expect(validateValue(methods.feedbackStart.params, { worktrees: 'a' })).not.toBeNull()
  expect(validateValue(methods.feedbackStart.result, { started: true })).toBeNull()
  expect(validateValue(methods.feedbackRefresh.params, { owner: 'a' })).toBeNull()
  expect(validateValue(methods.feedbackRefresh.params, { owner: 1 })).not.toBeNull()
  expect(validateValue(methods.feedbackRefresh.result, { owner: 'a', sequence: 17 })).toBeNull()
  expect(validateValue(methods.feedbackRefresh.result, { owner: 'a', sequence: 18 })).not.toBeNull()
  expect(validateValue(methods.feedbackReport.result, { worktrees: null, refreshes: 0, active: false })).toBeNull()
  expect(validateValue(methods.feedbackReport.result, { worktrees: ['a', 'b'], refreshes: 17, active: false })).toBeNull()
  expect(validateValue(methods.feedbackReport.result, { worktrees: ['a', 1], refreshes: 17, active: false })).not.toBeNull()
  expect(validateValue(events.feedbackStarted.data, { worktrees: ['a', 'b'], first: 'a' })).toBeNull()
  expect(validateValue(events.feedbackChanged.data, { worktrees: ['a', 'b'], owner: 'a', sequence: 17 })).toBeNull()
  expect(validateValue(events.feedbackChanged.data, { worktrees: ['a', 'b'], owner: 'a', sequence: 18 })).not.toBeNull()
  const parsed = parseManifest(JSON.stringify(manifest), {
    dirName: 'soak.faults',
    dir: resolve(import.meta.dir, 'faults'),
    source: 'installed'
  })
  expect(parsed.ok).toBe(true)
})

test('validates bounded strict flood method and event schemas', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, 'faults', 'quirky-plugin.json'), 'utf8'))
  const methods = Object.fromEntries(manifest.contributes.method.map((entry: { id: string }) => [entry.id, entry]))
  const events = Object.fromEntries(manifest.contributes.event.map((entry: { id: string }) => [entry.id, entry]))
  const start = methods.floodStart.params
  const tick = methods.floodTick.params
  const report = methods.floodReport.result

  for (const method of [methods.floodStart, methods.floodTick, methods.floodReport]) {
    expect(method.params.type).toBe('object')
    expect(method.params.additionalProperties).toBe(false)
    expect(method.result.type).toBe('object')
    expect(method.result.additionalProperties).toBe(false)
  }
  for (const value of [1, 10_000]) {
    expect(validateValue(start, { worktree: 'a', requests: value })).toBeNull()
  }
  expect(validateValue(start, { worktree: 'a' })).not.toBeNull()
  for (const value of [0, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 10_001]) {
    expect(validateValue(start, { worktree: 'a', requests: value })).not.toBeNull()
  }
  expect(validateValue(start, { worktree: 'a', requests: 1, extra: true })).not.toBeNull()
  expect(validateValue(methods.floodStart.result, { started: true })).toBeNull()
  expect(validateValue(methods.floodStart.result, { started: true, extra: true })).not.toBeNull()
  expect(validateValue(tick, { owner: 'a', sequence: 1 })).toBeNull()
  expect(validateValue(tick, { owner: 'a', sequence: 0 })).not.toBeNull()
  expect(validateValue(tick, { owner: 'a', sequence: 10_001 })).not.toBeNull()
  expect(validateValue(methods.floodTick.result, { owner: 'a', sequence: 1 })).toBeNull()
  expect(validateValue(methods.floodTick.result, { owner: 'a', sequence: 1, extra: true })).not.toBeNull()
  expect(validateValue(methods.floodReport.params, {})).toBeNull()
  expect(validateValue(methods.floodReport.params, { extra: true })).not.toBeNull()
  expect(methods.floodReport.readOnly).toBe(true)
  expect(validateValue(report, { worktree: null, expected: 0, requests: 0, active: false })).toBeNull()
  expect(validateValue(report, { worktree: 'a', expected: 10_000, requests: 10_000, active: false })).toBeNull()
  expect(validateValue(report, { worktree: 'a', expected: 10_001, requests: 0, active: true })).not.toBeNull()
  expect(validateValue(events.floodStarted.data, { worktree: 'a', requests: 3000 })).toBeNull()
  expect(validateValue(events.floodStarted.data, { worktree: 'a', requests: 3000, extra: true })).not.toBeNull()
  expect(events.floodStarted.worktree).toBe('worktree')
  expect(events.floodStarted.data.additionalProperties).toBe(false)
})

test('feedback fixture alternates exactly seventeen owners and rejects invalid or late requests', () => {
  vi.useFakeTimers()
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/feedbackStart')!
  const refresh = fixture.handlers.get('method:soak.faults/feedbackRefresh')!
  const report = fixture.handlers.get('method:soak.faults/feedbackReport')!
  try {
    expect(report()).toEqual({ worktrees: null, refreshes: 0, active: false })
    expect(fixture.handlers.get('method:soak.faults/report')!())
      .toEqual({ leaked: [], holders: [], refreshes: 0, blockedMs: null })
    expect(() => start({ worktrees: ['a', 'a'] })).toThrow()
    expect(() => start({ worktrees: [' ', 'b'] })).toThrow()
    expect(() => start({ worktrees: [] })).toThrow()
    expect(() => start({ worktrees: ['a'] })).toThrow()
    expect(() => start({ worktrees: ['a', 'b', 'c'] })).toThrow()
    expect(start({ worktrees: ['a', 'b'] })).toEqual({ started: true })
    expect(() => start({ worktrees: ['a', 'b'] })).toThrow()
    expect(fixture.events).toEqual([{
      type: 'feedbackStarted', data: { worktrees: ['a', 'b'], first: 'a' }
    }])
    expect(() => refresh({ owner: 'unarmed' })).toThrow()
    expect(report()).toEqual({ worktrees: ['a', 'b'], refreshes: 0, active: true })

    for (let sequence = 1; sequence <= 17; sequence += 1) {
      const owner = sequence % 2 === 1 ? 'a' : 'b'
      expect(refresh({ owner })).toEqual({ owner, sequence })
      expect(report()).toMatchObject({
        worktrees: ['a', 'b'], refreshes: sequence, active: sequence < 17
      })
    }
    expect(() => refresh({ owner: 'a' })).toThrow()
    expect(report()).toEqual({ worktrees: ['a', 'b'], refreshes: 17, active: false })
    timerControls.advanceTimersByTime(49)
    expect(fixture.events.filter((event) => event.type === 'feedbackChanged')).toEqual([])
    timerControls.advanceTimersByTime(1)
    const changed = fixture.events.filter((event) => event.type === 'feedbackChanged')
    expect(changed).toHaveLength(17)
    expect(changed.map((event) => event.data)).toEqual(Array.from({ length: 17 }, (_, index) => ({
      worktrees: ['a', 'b'],
      owner: index % 2 === 0 ? 'a' : 'b',
      sequence: index + 1
    })))
  } finally {
    fixture.dispose?.()
    vi.useRealTimers()
  }
})

test('feedback fixture deactivation cancels its pending changed event', () => {
  vi.useFakeTimers()
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/feedbackStart')!
  const refresh = fixture.handlers.get('method:soak.faults/feedbackRefresh')!
  try {
    start({ worktrees: ['a', 'b'] })
    refresh({ owner: 'a' })
    fixture.dispose?.()
    timerControls.advanceTimersByTime(60)
    expect(fixture.events.filter((event) => event.type === 'feedbackChanged')).toEqual([])
  } finally {
    fixture.dispose?.()
    vi.useRealTimers()
  }
})

test('flood fixture starts once and accepts each requested sequence in arbitrary order', () => {
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/floodStart')!
  const tick = fixture.handlers.get('method:soak.faults/floodTick')!
  const report = fixture.handlers.get('method:soak.faults/floodReport')!
  try {
    expect(report()).toEqual({ worktree: null, expected: 0, requests: 0, active: false })
    expect(start({ worktree: 'a', requests: 3000 })).toEqual({ started: true })
    expect(fixture.events).toEqual([{
      type: 'floodStarted',
      data: { worktree: 'a', requests: 3000 }
    }])
    for (let sequence = 3000; sequence >= 1; sequence -= 1) {
      expect(tick({ owner: 'a', sequence })).toEqual({ owner: 'a', sequence })
    }
    expect(report()).toEqual({ worktree: 'a', expected: 3000, requests: 3000, active: false })
    expect(fixture.events).toEqual([{
      type: 'floodStarted',
      data: { worktree: 'a', requests: 3000 }
    }])
    expect(fixture.handlers.get('method:soak.faults/report')!())
      .toEqual({ leaked: [], holders: [], refreshes: 0, blockedMs: null })
  } finally {
    fixture.dispose?.()
  }
})

test('flood fixture rejects empty or whitespace worktree IDs', () => {
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/floodStart')!
  try {
    expect(() => start({ worktree: '', requests: 1 })).toThrow()
    expect(() => start({ worktree: '  ', requests: 1 })).toThrow()
    expect(fixture.handlers.get('method:soak.faults/floodReport')!())
      .toEqual({ worktree: null, expected: 0, requests: 0, active: false })
    expect(fixture.events).toEqual([])
  } finally {
    fixture.dispose?.()
  }
})

test('flood fixture rejects every invalid request count without arming', () => {
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/floodStart')!
  const report = fixture.handlers.get('method:soak.faults/floodReport')!
  try {
    for (const requests of [0, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 10_001]) {
      expect(() => start({ worktree: 'a', requests })).toThrow()
      expect(report()).toEqual({ worktree: null, expected: 0, requests: 0, active: false })
      expect(fixture.events).toEqual([])
    }
    expect(start({ worktree: 'a', requests: 10_000 })).toEqual({ started: true })
    expect(report()).toEqual({ worktree: 'a', expected: 10_000, requests: 0, active: true })
  } finally {
    fixture.dispose?.()
  }
})

test('flood fixture rejects unarmed, foreign, duplicate, and out-of-range ticks without counting them', () => {
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/floodStart')!
  const tick = fixture.handlers.get('method:soak.faults/floodTick')!
  const report = fixture.handlers.get('method:soak.faults/floodReport')!
  try {
    expect(() => tick({ owner: 'a', sequence: 1 })).toThrow()
    expect(start({ worktree: 'a', requests: 2 })).toEqual({ started: true })
    expect(() => tick({ owner: 'b', sequence: 1 })).toThrow()
    expect(() => tick({ owner: 'a', sequence: 0 })).toThrow()
    expect(() => tick({ owner: 'a', sequence: 3 })).toThrow()
    expect(report()).toEqual({ worktree: 'a', expected: 2, requests: 0, active: true })
    expect(tick({ owner: 'a', sequence: 2 })).toEqual({ owner: 'a', sequence: 2 })
    expect(() => tick({ owner: 'a', sequence: 2 })).toThrow()
    expect(report()).toEqual({ worktree: 'a', expected: 2, requests: 1, active: true })
    expect(fixture.events).toHaveLength(1)
  } finally {
    fixture.dispose?.()
  }
})

test('flood fixture rejects repeated starts and mutations after completion or deactivation', () => {
  const fixture = activateFixture()
  const start = fixture.handlers.get('method:soak.faults/floodStart')!
  const tick = fixture.handlers.get('method:soak.faults/floodTick')!
  const report = fixture.handlers.get('method:soak.faults/floodReport')!
  try {
    expect(start({ worktree: 'a', requests: 1 })).toEqual({ started: true })
    expect(() => start({ worktree: 'a', requests: 1 })).toThrow()
    expect(tick({ owner: 'a', sequence: 1 })).toEqual({ owner: 'a', sequence: 1 })
    expect(() => tick({ owner: 'a', sequence: 1 })).toThrow()
    expect(report()).toEqual({ worktree: 'a', expected: 1, requests: 1, active: false })
    expect(() => start({ worktree: 'b', requests: 1 })).toThrow()
    fixture.dispose?.()
    expect(() => tick({ owner: 'a', sequence: 1 })).toThrow()
    expect(() => start({ worktree: 'b', requests: 1 })).toThrow()
    expect(report()).toEqual({ worktree: 'a', expected: 1, requests: 1, active: false })
    expect(fixture.events).toHaveLength(1)
  } finally {
    fixture.dispose?.()
  }
})

test('builds feedback UI into the disposable plugin output', async () => {
  const home = mkdtempSync(join(tmpdir(), 'quirky-soak-feedback-ui-'))
  const repoRoot = resolve(import.meta.dir, '../..')
  try {
    installFaultPlugin(home, repoRoot)
    await buildFaultUi(home, repoRoot)
    expect(existsSync(join(home, 'plugins', 'soak.faults', 'src', 'ui.tsx'))).toBe(true)
    expect(existsSync(join(home, 'plugins', 'soak.faults', 'dist', 'ui.js'))).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

async function runWrappedGit(wrapper: string, args: string[], cwd: string, detached = false): Promise<{ pid: number; exitCode: number }> {
  const child = Bun.spawn([wrapper, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(detached ? { detached: true } : {}),
  })
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { pid: child.pid, exitCode: await child.exited }
}

function makeGitRepository(root: string): string {
  const git = Bun.which('git')
  if (!git) throw new Error('the test Git executable is unavailable')
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const result = Bun.spawnSync([git, 'init', repo], { stdout: 'ignore', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error('could not initialize the wrapper test repository')
  return repo
}
/** Waits for OS process-group transitions in the wrapper integration test. */
function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}


test('slow-git wrapper delays only worktree list and records its own pid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-slow-git-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const repo = makeGitRepository(root)
  const pidFile = join(root, 'slow-git.pids')
  const wrapper = join(home, 'fakebin', 'git')
  try {
    installSlowGit(home, process.env.PATH ?? '', pidFile)
    setGitDelay(home, 400)

    const started = performance.now()
    const delayed = await runWrappedGit(wrapper, ['worktree', 'list'], repo)
    expect(delayed.exitCode).toBe(0)
    expect(performance.now() - started).toBeGreaterThanOrEqual(400)
    expect(readFileSync(pidFile, 'utf8')).toBe(`${delayed.pid}\n`)

    const versionStarted = performance.now()
    const version = await runWrappedGit(wrapper, ['--version'], repo)
    expect(version.exitCode).toBe(0)
    expect(performance.now() - versionStarted).toBeLessThan(400)
    expect(readFileSync(pidFile, 'utf8')).toBe(`${delayed.pid}\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('slow-git wrapper runs worktree list and git version without a delay file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-slow-git-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const repo = makeGitRepository(root)
  const pidFile = join(root, 'slow-git.pids')
  const wrapper = join(home, 'fakebin', 'git')
  try {
    installSlowGit(home, process.env.PATH ?? '', pidFile)

    for (const args of [['worktree', 'list'], ['--version']]) {
      const started = performance.now()
      expect((await runWrappedGit(wrapper, args, repo)).exitCode).toBe(0)
      expect(performance.now() - started).toBeLessThan(400)
    }
    expect(existsSync(pidFile)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('killing the slow-git process group also kills its sleep child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-slow-git-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const repo = makeGitRepository(root)
  const pidFile = join(root, 'slow-git.pids')
  const wrapper = join(home, 'fakebin', 'git')
  let pid: number | undefined
  let child: StartedChild | undefined
  try {
    installSlowGit(home, process.env.PATH ?? '', pidFile)
    setGitDelay(home, 30_000)
    const spawned = startChild([wrapper, 'worktree', 'list'], {
      cwd: repo,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child = spawned
    pid = spawned.pid
    // A real delay lets the wrapper fork `sleep` before the test kills its process group.
    await wait(200)
    process.kill(-spawned.pid, 'SIGKILL')
    await spawned.exited

    const deadline = Date.now() + 1000
    let error: unknown
    do {
      try {
        process.kill(-spawned.pid, 0)
      } catch (caught) {
        error = caught
        break
      }
      await wait(20)
    } while (Date.now() < deadline)
    expect((error as NodeJS.ErrnoException | undefined)?.code).toBe('ESRCH')
  } finally {
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
    if (child) await child.exited
    rmSync(root, { recursive: true, force: true })
  }
})

test('installs a discoverable plugin entry point only in the supplied home', () => {
  const home = mkdtempSync(join(tmpdir(), 'quirky-soak-fault-install-'))
  try {
    installFaultPlugin(home, resolve(import.meta.dir, '../..'))
    const plugin = join(home, 'plugins', 'soak.faults')
    const manifest = JSON.parse(readFileSync(join(plugin, 'quirky-plugin.json'), 'utf8'))
    expect(manifest.id).toBe('soak.faults')
    expect(existsSync(join(plugin, manifest.main))).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('refuses activation outside the soak before registering handlers', () => {
  const original = process.env.QUIRKY_SOAK_FAULTS
  delete process.env.QUIRKY_SOAK_FAULTS
  try {
    expect(() => activate({} as PluginContext)).toThrow('soak.faults runs only inside a soak')
  } finally {
    if (original === undefined) delete process.env.QUIRKY_SOAK_FAULTS
    else process.env.QUIRKY_SOAK_FAULTS = original
  }
})

test('an aborted fault makes no plugin calls and cannot produce evidence', async () => {
  const abort = new AbortController()
  abort.abort()
  let calls = 0
  const control = { callAny: async () => { calls++; throw new Error('unexpected call') } } as unknown as QuirkyClient
  const fault = startFault({ kind: 'block', home: '/unused', control, projects: [], out: '/unused', runSeconds: 24, startedAt: performance.now(), signal: abort.signal })
  try {
    let failure: unknown
    try { await fault.finish() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(calls).toBe(0)
  } finally {
    fault.stop()
    fault.stop()
  }
})

test('a rejected injection cannot be replaced with a successful closing report', async () => {
  const injected = Promise.withResolvers<void>()
  let calls = 0
  const control = { callAny: async () => {
    calls++
    injected.resolve()
    throw new Error('fault handler failed')
  } } as unknown as QuirkyClient
  const fault = startFault({ kind: 'block', home: '/unused', control, projects: [], out: '/unused', runSeconds: 24, startedAt: performance.now() - 2100, signal: new AbortController().signal })
  try {
    await injected.promise
    let failure: unknown
    try { await fault.finish() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('fault handler failed')
    expect(calls).toBe(1)
  } finally {
    fault.stop()
  }
})

for (const phase of ['injection', 'report'] as const) {
  test(`abort releases finalization while the ${phase} RPC is still pending`, async () => {
    const abort = new AbortController()
    const pending = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<void>()
    const control = { callAny: async (method: string) => {
      if (method === (phase === 'injection' ? 'soak.faults/block' : 'soak.faults/report')) {
        entered.resolve()
        return pending.promise
      }
      return { blockedMs: 3000 }
    } } as unknown as QuirkyClient
    const fault = startFault({ kind: 'block', home: '/unused', control, projects: [], out: '/unused', runSeconds: 24, startedAt: performance.now() - 2100, signal: abort.signal })
    const finished = fault.finish().catch((error: unknown) => error)
    const timeout = Promise.withResolvers<string>()
    let timer: Timer | undefined
    try {
      await entered.promise
      abort.abort()
      timer = setTimeout(() => timeout.resolve('still waiting for RPC'), 500)
      const result = await Promise.race([finished, timeout.promise])
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('soak fault was stopped before completion')
    } finally {
      clearTimeout(timer)
      fault.stop()
      pending.resolve({ leaked: [], holders: [], refreshes: 0, blockedMs: 3000 })
      await finished
    }
  })
}

test('a failed final report is not retried on subsequent finalization', async () => {
  let reportCalls = 0
  const control = { callAny: async (method: string) => {
    if (method === 'soak.faults/block') return { blockedMs: 3000 }
    if (method === 'soak.faults/report') {
      reportCalls += 1
      throw new Error('final report failed')
    }
    throw new Error(`unexpected call: ${method}`)
  } } as unknown as QuirkyClient
  const fault = startFault({
    kind: 'block',
    home: '/unused',
    control,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now() - 2100,
    signal: new AbortController().signal
  })
  try {
    const first = fault.finish()
    await expect(first).rejects.toThrow('final report failed')
    const second = fault.finish()
    expect(second).toBe(first)
    await expect(second).rejects.toThrow('final report failed')
    expect(reportCalls).toBe(1)
  } finally {
    fault.stop()
  }
})

test('flood controller polls until the copied target reports exact completion', async () => {
  const selectedWindow = { index: 0, worktree: 'window-a' }
  let reportCalls = 0
  const methods: string[] = []
  const control = { callAny: async (method: string, params: unknown) => {
    methods.push(method)
    if (method === 'soak.faults/floodStart') {
      expect(params).toEqual({ worktree: 'window-a', requests: 3000 })
      selectedWindow.worktree = 'changed-after-start'
      return { started: true }
    }
    if (method === 'soak.faults/floodReport') {
      reportCalls += 1
      return reportCalls === 1
        ? { worktree: 'window-a', expected: 3000, requests: 2999, active: true }
        : { worktree: 'window-a', expected: 3000, requests: 3000, active: false }
    }
    throw new Error(`unexpected call: ${method}`)
  } } as unknown as QuirkyClient
  const fault = startFault({
    kind: 'flood',
    home: '/unused',
    control,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now() - 2100,
    signal: new AbortController().signal,
    floodWindow: selectedWindow
  })
  try {
    const record = await fault.finish()
    expect(record).toEqual({
      kind: 'flood',
      check: 'requests',
      at: expect.any(Number),
      detail: {
        pids: [],
        refreshes: 0,
        blockedMs: null,
        flood: { index: 0, worktree: 'window-a', requests: 3000 }
      }
    })
    expect(reportCalls).toBe(2)
    expect(methods).toEqual([
      'soak.faults/floodStart',
      'soak.faults/floodReport',
      'soak.faults/floodReport'
    ])
  } finally {
    fault.stop()
  }
})

for (const phase of ['start', 'report'] as const) {
  test(`flood controller rejects malformed ${phase} acknowledgements`, async () => {
    const control = { callAny: async (method: string) => {
      if (method === 'soak.faults/floodStart') return phase === 'start' ? { started: false } : { started: true }
      if (method === 'soak.faults/floodReport') {
        return phase === 'report'
          ? { worktree: 'foreign', expected: 3000, requests: 3000, active: false }
          : { worktree: 'window-a', expected: 3000, requests: 3000, active: false }
      }
      throw new Error(`unexpected call: ${method}`)
    } } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    try {
      await expect(fault.finish()).rejects.toThrow(
        phase === 'start' ? 'floodStart RPC did not confirm' : 'floodReport did not match the armed target'
      )
    } finally {
      fault.stop()
    }
  })
}

for (const [label, response] of [
  ['null result', null],
  ['missing started field', {}],
  ['extra property', { started: true, extra: true }]
] as const) {
  test(`flood controller rejects floodStart ${label}`, async () => {
    const control = { callAny: async () => response } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    try {
      await expect(fault.finish()).rejects.toThrow('floodStart RPC did not confirm')
    } finally {
      fault.stop()
    }
  })
}

for (const [label, report] of [
  ['null report', null],
  ['unarmed worktree', { worktree: null, expected: 0, requests: 0, active: false }],
  ['foreign worktree', { worktree: 'other', expected: 3000, requests: 3000, active: false }],
  ['wrong expected count', { worktree: 'window-a', expected: 2999, requests: 3000, active: false }],
  ['negative request count', { worktree: 'window-a', expected: 3000, requests: -1, active: true }],
  ['excess request count', { worktree: 'window-a', expected: 3000, requests: 3001, active: false }],
  ['nonboolean active flag', { worktree: 'window-a', expected: 3000, requests: 0, active: 'yes' }],
  ['complete but still active', { worktree: 'window-a', expected: 3000, requests: 3000, active: true }],
  ['incomplete but inactive', { worktree: 'window-a', expected: 3000, requests: 2999, active: false }],
  ['extra property', { worktree: 'window-a', expected: 3000, requests: 3000, active: false, extra: true }]
] as const) {
  test(`flood controller rejects a malformed floodReport with ${label}`, async () => {
    const control = { callAny: async (method: string) => {
      if (method === 'soak.faults/floodStart') return { started: true }
      if (method === 'soak.faults/floodReport') return report
      throw new Error(`unexpected call: ${method}`)
    } } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    try {
      await expect(fault.finish()).rejects.toThrow('floodReport did not match the armed target')
    } finally {
      fault.stop()
    }
  })
}

for (const phase of ['start', 'report'] as const) {
  test(`flood controller preserves a rejected ${phase} RPC`, async () => {
    const control = { callAny: async (method: string) => {
      if (method === 'soak.faults/floodStart') {
        if (phase === 'start') throw new Error('start transport failed')
        return { started: true }
      }
      if (method === 'soak.faults/floodReport') throw new Error('report transport failed')
      throw new Error(`unexpected call: ${method}`)
    } } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    try {
      await expect(fault.finish()).rejects.toThrow(
        phase === 'start' ? 'floodStart RPC failed: start transport failed' : 'floodReport RPC failed: report transport failed'
      )
    } finally {
      fault.stop()
    }
  })
}

for (const phase of ['start', 'report'] as const) {
  test(`flood controller bounds a pending ${phase} RPC by the ten-second deadline`, async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    let timeoutMs = 0
    const control = { callAny: async (method: string, _params: unknown, options: { timeoutMs?: number }) => {
      calls += 1
      timeoutMs = options.timeoutMs ?? 0
      if (method === 'soak.faults/floodStart') {
        if (phase === 'start') {
          entered.resolve()
          return pending.promise
        }
        return { started: true }
      }
      if (method === 'soak.faults/floodReport' && phase === 'report') {
        entered.resolve()
        return pending.promise
      }
      throw new Error(`unexpected call: ${method}`)
    } } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    const finished = fault.finish().then(() => null, (error: unknown) => error)
    try {
      await entered.promise
      expect(timeoutMs).toBeGreaterThan(0)
      expect(timeoutMs).toBeLessThanOrEqual(10_000)
      timerControls.advanceTimersByTime(10_000)
      const result = await finished
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('10 seconds')
      expect(calls).toBe(phase === 'start' ? 1 : 2)
    } finally {
      fault.stop()
      pending.resolve({ started: true })
      vi.useRealTimers()
    }
  })
}

test('flood controller rejects an incomplete fixture at the deadline and caches finalization', async () => {
  vi.useFakeTimers()
  const entered = Promise.withResolvers<void>()
  let reportCalls = 0
  const control = { callAny: async (method: string) => {
    if (method === 'soak.faults/floodStart') return { started: true }
    if (method === 'soak.faults/floodReport') {
      reportCalls += 1
      entered.resolve()
      return { worktree: 'window-a', expected: 3000, requests: 0, active: true }
    }
    throw new Error(`unexpected call: ${method}`)
  } } as unknown as QuirkyClient
  const fault = startFault({
    kind: 'flood',
    home: '/unused',
    control,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now() - 2100,
    signal: new AbortController().signal,
    floodWindow: { index: 0, worktree: 'window-a' }
  })
  try {
    const first = fault.finish()
    expect(fault.finish()).toBe(first)
    await entered.promise
    timerControls.advanceTimersByTime(10_000)
    await expect(first).rejects.toThrow('10 seconds')
    expect(reportCalls).toBeGreaterThan(0)
    expect(reportCalls).toBeLessThanOrEqual(101)
  } finally {
    fault.stop()
    vi.useRealTimers()
  }
})

for (const phase of ['start', 'report'] as const) {
  test(`stopping during a pending flood ${phase} RPC releases finalization without another call`, async () => {
    const pending = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    const control = { callAny: async (method: string) => {
      calls += 1
      if (method === 'soak.faults/floodStart') {
        if (phase === 'start') {
          entered.resolve()
          return pending.promise
        }
        return { started: true }
      }
      if (method === 'soak.faults/floodReport' && phase === 'report') {
        entered.resolve()
        return pending.promise
      }
      throw new Error(`unexpected call: ${method}`)
    } } as unknown as QuirkyClient
    const fault = startFault({
      kind: 'flood',
      home: '/unused',
      control,
      projects: [],
      out: '/unused',
      runSeconds: 24,
      startedAt: performance.now() - 2100,
      signal: new AbortController().signal,
      floodWindow: { index: 0, worktree: 'window-a' }
    })
    const finished = fault.finish().then(() => null, (error: unknown) => error)
    try {
      await entered.promise
      fault.stop()
      const result = await finished
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('soak fault was stopped before completion')
      expect(calls).toBe(phase === 'start' ? 1 : 2)
    } finally {
      fault.stop()
      pending.resolve({ started: true })
    }
  })
}
type TestChild = Bun.Subprocess<'ignore', 'ignore', 'ignore'>
type FakeHost = { root: string; home: string; entry: string; child: TestChild }
type PauseOverrides = PtyPauseDependencies
type StartedFault = RunningFault

const ptyChildren: TestChild[] = []
const ptyScopes: ProcessScope[] = []
const ptyFaults: StartedFault[] = []
const ptyScratch: string[] = []

function makePtyScratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  ptyScratch.push(path)
  return path
}

function createFakePtyHost(options: {
  scope?: ProcessScope
  home?: string
  cwd?: string
  envHome?: string
  extraEnv?: Record<string, string>
} = {}): FakeHost {
  const root = makePtyScratch('quirky-soak-pty-root-')
  const home = options.home ?? options.scope?.home ?? makePtyScratch('quirky-soak-pty-home-')
  const entry = join(root, 'packages', 'pty-host', 'src', 'main.ts')
  mkdirSync(join(root, 'packages', 'pty-host', 'src'), { recursive: true })
  writeFileSync(entry, 'await Bun.sleep(60_000)\n')
  const childOptions = {
    cwd: options.cwd ?? home,
    env: { ...process.env, ...(options.scope?.env ?? {}), ...options.extraEnv, QUIRKY_HOME: options.envHome ?? home },
    stdin: 'ignore' as const,
    stdout: 'ignore' as const,
    stderr: 'ignore' as const
  }
  const child = options.scope
    ? options.scope.spawn([process.execPath, entry], childOptions)
    : Bun.spawn([process.execPath, entry], childOptions)
  ptyChildren.push(child)
  return { root, home, entry, child }
}

function startPtyFault(host: FakeHost, dependencies: PauseOverrides = {}, options: {
  home?: string
  repoRoot?: string
  reportedPid?: number
  trackedPid?: number
} = {}): StartedFault {
  const control = {
    callAny: async (method: string) => {
      if (method !== 'status.get') throw new Error(`unexpected pty-pause control call: ${method}`)
      return { ptyHost: { pid: options.reportedPid ?? host.child.pid } }
    }
  } as unknown as QuirkyClient
  const fault = startFault({
    kind: 'pty-pause',
    repoRoot: options.repoRoot ?? host.root,
    home: options.home ?? host.home,
    ptyHostPid: () => options.trackedPid ?? host.child.pid,
    control,
    projects: [],
    out: host.home,
    runSeconds: 24,
    startedAt: performance.now() - 2100,
    signal: new AbortController().signal,
    ptyPause: { holdMs: 300, ...dependencies }
  })
  ptyFaults.push(fault)
  return fault
}

function processState(pid: number, home: string): string | null {
  try {
    const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], {
      timeout: 2000,
      env: { ...process.env, QUIRKY_HOME: home }
    })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  } catch {
    return null
  }
}

// Process state changes asynchronously, so these checks poll the OS instead of faking timers.
async function waitForState(pid: number, home: string, stopped: boolean, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = processState(pid, home)
    if (stopped ? state?.startsWith('T') : state !== null && !state.startsWith('T')) return state
    await Bun.sleep(20)
  }
  throw new Error(`process ${pid} did not become ${stopped ? 'stopped' : 'running'}`)
}

async function waitForHostIdentity(host: FakeHost): Promise<Extract<PtyHostInspection, { kind: 'present' }>['identity']> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = inspectPtyHost(host.child.pid)
    if (result.kind === 'present') return result.identity
    await Bun.sleep(20)
  }
  throw new Error(`could not inspect fake PTY host ${host.child.pid}`)
}

async function expectNotApplied(fault: StartedFault): Promise<void> {
  const error = await fault.finish().then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/^pty-pause fault not applied:/)
  expect(await fault.settled()).toBe('not-applied')
}

async function expectChildGoneOrRunning(host: FakeHost): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    try {
      process.kill(host.child.pid, 0)
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
      return
    }
    const state = processState(host.child.pid, host.home)
    if (state !== null) {
      expect(state.startsWith('T')).toBe(false)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error(`could not verify whether process ${host.child.pid} is gone or running`)
}

function stoppedProcessesWithHome(home: string): string[] {
  const command = process.platform === 'darwin'
    ? ['ps', 'eww', '-A', '-o', 'pid=,stat=,command=']
    : ['ps', 'e', '-A', '-o', 'pid=,stat=,command=']
  const result = Bun.spawnSync(command, { timeout: 2000, env: { ...process.env, QUIRKY_HOME: home } })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().split(/\r?\n/).filter((line) => {
    const columns = line.trim().split(/\s+/, 3)
    return line.includes(`QUIRKY_HOME=${home}`) && columns[1]?.startsWith('T')
  })
}

let previousQuirkyHome: string | undefined

beforeEach(() => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = makePtyScratch('quirky-soak-pty-test-home-')
})
afterEach(async () => {
  const faults = ptyFaults.splice(0)
  for (const fault of faults) fault.stop()
  await Promise.all(faults.map((fault) => fault.settled().catch(() => null)))
  for (const child of ptyChildren.splice(0)) {
    try { child.kill('SIGCONT') } catch {}
    try { child.kill('SIGKILL') } catch {}
    await child.exited
  }
  for (const scope of ptyScopes.splice(0)) await scope.cleanup()
  for (const path of ptyScratch.splice(0)) rmSync(path, { recursive: true, force: true })
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  previousQuirkyHome = undefined
})

test('plans the PTY pause fault as a 3-second stalls injection', () => {
  expect(faultPlan('pty-pause', 24)).toEqual({ kind: 'pty-pause', ms: 3000 })
  expect(FAULT_CHECK['pty-pause']).toBe('stalls')
})

test('settled resolves immediately with null for non-PTY faults', async () => {
  const fault = startFault({
    kind: 'block',
    home: makePtyScratch('quirky-soak-pty-settled-'),
    control: {} as QuirkyClient,
    projects: [],
    out: '/unused',
    runSeconds: 24,
    startedAt: performance.now() + 60_000,
    signal: new AbortController().signal
  })
  ptyFaults.push(fault)
  try {
    expect(await fault.settled()).toBeNull()
  } finally {
    fault.stop()
  }
})

test('inspects an owned fake-checkout host synchronously and reports it absent after reaping', async () => {
  const host = createFakePtyHost()
  try {
    const identity = await waitForHostIdentity(host)
    expect(identity).toMatchObject({
      pid: host.child.pid,
      cwd: host.home,
      home: host.home
    })
    expect(identity.started.length).toBeGreaterThan(0)
    expect(identity.command.endsWith(` ${host.entry}`)).toBe(true)
    expect(ptyHostEntry(host.root)).toBe(realpathSync(host.entry))
    const current = inspectPtyHost(host.child.pid)
    expect(current.kind).toBe('present')
    if (current.kind === 'present') expect(sameHost(identity, current.identity)).toBe(true)

    process.kill(host.child.pid, 'SIGKILL')
    await host.child.exited
    expect(inspectPtyHost(host.child.pid)).toEqual({ kind: 'absent' })
  } finally {
    try { host.child.kill('SIGCONT') } catch {}
    try { host.child.kill('SIGKILL') } catch {}
    await host.child.exited
  }
})

test('owns only the exact live PTY host identity and compares host identity without state', async () => {
  const host = createFakePtyHost()
  try {
    const identity = await waitForHostIdentity(host)
    const owner = { home: host.home, entry: ptyHostEntry(host.root) }
    expect(ownsPtyHost(identity, owner)).toBeNull()
    expect(sameHost(identity, { ...identity, state: 'T' })).toBe(true)
    expect(sameHost(identity, { ...identity, pid: identity.pid + 1 })).toBe(false)
    expect(sameHost(identity, { ...identity, started: `${identity.started} changed` })).toBe(false)
    expect(sameHost(identity, { ...identity, command: `${identity.command} changed` })).toBe(false)
    expect(sameHost(identity, { ...identity, cwd: `${identity.cwd}/other` })).toBe(false)
    expect(sameHost(identity, { ...identity, home: `${identity.home}/other` })).toBe(false)

    expect(ownsPtyHost({ ...identity, pid: process.pid }, owner)).toMatch(/pid/i)
    expect(ownsPtyHost({ ...identity, pid: 0 }, owner)).toMatch(/pid/i)
    expect(ownsPtyHost({ ...identity, state: 'T' }, owner)).toMatch(/state|stopped/i)
    expect(ownsPtyHost({ ...identity, command: `${identity.command} extra` }, owner)).toMatch(/command/i)
    expect(ownsPtyHost({ ...identity, cwd: `${identity.cwd}/other` }, owner)).toMatch(/cwd/i)
    expect(ownsPtyHost({ ...identity, home: `${identity.home}2` }, owner)).toMatch(/home/i)
  } finally {
    try { host.child.kill('SIGCONT') } catch {}
    try { host.child.kill('SIGKILL') } catch {}
    await host.child.exited
  }
})
type RefusalSetup = {
  host: FakeHost
  options?: { home?: string; repoRoot?: string; reportedPid?: number }
}

const refusalCases: [string, () => Promise<RefusalSetup>][] = [
  ['wrong home', async () => {
    const host = createFakePtyHost()
    return { host, options: { home: makePtyScratch('quirky-soak-pty-other-home-') } }
  }],
  ['home prefix', async () => {
    const home = makePtyScratch('quirky-soak-pty-home-prefix-')
    return { host: createFakePtyHost({ home, envHome: `${home}2` }) }
  }],
  ['wrong cwd', async () => {
    const home = makePtyScratch('quirky-soak-pty-cwd-home-')
    return { host: createFakePtyHost({ home, cwd: makePtyScratch('quirky-soak-pty-cwd-') }) }
  }],
  ['wrong entry', async () => {
    const host = createFakePtyHost()
    const repoRoot = makePtyScratch('quirky-soak-pty-wrong-entry-')
    mkdirSync(join(repoRoot, 'packages', 'pty-host', 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'pty-host', 'src', 'main.ts'), 'await Bun.sleep(60_000)\n')
    return { host, options: { repoRoot } }
  }],
  ['already stopped child', async () => {
    const host = createFakePtyHost()
    process.kill(host.child.pid, 'SIGSTOP')
    await waitForState(host.child.pid, host.home, true)
    return { host }
  }],
  ['status pid mismatch', async () => {
    const host = createFakePtyHost()
    return { host, options: { reportedPid: host.child.pid + 1 } }
  }]
]

for (const [label, prepare] of refusalCases) {
  test(`refuses the PTY pause without signalling an unowned host: ${label}`, async () => {
    const { host, options } = await prepare()
    const signals: string[] = []
    const fault = startPtyFault(host, {
      kill: (_pid, signal) => { signals.push(signal) }
    }, options)
    await expectNotApplied(fault)
    expect(signals).toEqual([])
  })
}

for (const resultKind of ['absent', 'unreadable', 'replaced', 'stopped'] as const) {
  test(`refuses to stop a host whose second inspection is ${resultKind}`, async () => {
    const host = createFakePtyHost()
    const real = await waitForHostIdentity(host)
    let inspections = 0
    let firstInspection: PtyHostInspection | undefined
    let secondInspection: PtyHostInspection | undefined
    const signals: string[] = []
    const injected: PtyHostInspection = resultKind === 'absent'
      ? { kind: 'absent' }
      : resultKind === 'unreadable'
        ? { kind: 'unreadable', reason: 'injected inspection failure' }
        : { kind: 'present', identity: { ...real, started: `${real.started} replaced` } }
    const fault = startPtyFault(host, {
      inspect: (pid) => {
        inspections += 1
        if (inspections === 1) {
          const current = inspectPtyHost(pid)
          firstInspection = current
          return current
        }
        if (inspections === 2) {
          const current = resultKind === 'stopped' && firstInspection?.kind === 'present'
            ? { kind: 'present', identity: { ...firstInspection.identity, state: 'T' } } as const
            : injected
          secondInspection = current
          return current
        }
        return inspectPtyHost(pid)
      },
      kill: (_pid, signal) => { signals.push(signal) }
    })
    await expectNotApplied(fault)
    expect(inspections).toBe(2)
    expect(signals).toEqual([])
    if (resultKind === 'stopped') {
      expect(firstInspection?.kind).toBe('present')
      if (firstInspection?.kind === 'present') {
        expect(firstInspection.identity.state.startsWith('T')).toBe(false)
        expect(secondInspection).toEqual({
          kind: 'present',
          identity: { ...firstInspection.identity, state: 'T' }
        })
      }
    }
  })
}

test('does not resume a pause when SIGSTOP itself fails', async () => {
  const host = createFakePtyHost()
  const signals: string[] = []
  const fault = startPtyFault(host, {
    kill: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGSTOP') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    }
  })
  const error = await fault.finish().then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('SIGSTOP failed: EPERM')
  expect(await fault.settled()).toBe('not-applied')
  expect(signals).toEqual(['SIGSTOP'])
  expect(processState(host.child.pid, host.home)?.startsWith('T')).not.toBe(true)
})

test('shares one two-second budget among synchronous process inspections', async () => {
  const host = createFakePtyHost()
  await waitForHostIdentity(host)
  const originalSpawnSync = Bun.spawnSync
  const calls: { command: string[]; timeout: number | undefined }[] = []
  Bun.spawnSync = new Proxy(originalSpawnSync, {
    apply(target, receiver, args: unknown[]) {
      const command = args[0] as string[]
      const options = args[1] as { timeout?: number } | undefined
      calls.push({ command: [...command], timeout: options?.timeout })
      if (calls.length === 1) {
        // Consume real synchronous time so later reads must receive only the remaining budget.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
      }
      return Reflect.apply(target, receiver, args)
    }
  })
  try {
    expect(inspectPtyHost(host.child.pid).kind).toBe('present')
    expect(calls[0]?.timeout).toBe(2000)
    if (process.platform === 'darwin') {
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.slice(1).every(({ timeout }) => timeout !== undefined && timeout < 1000)).toBe(true)
    } else {
      expect(calls).toHaveLength(1)
    }
  } finally {
    Bun.spawnSync = originalSpawnSync
  }
})
test('holds, resumes, records the pause and re-inspects the same host immediately before every signal', async () => {
  const host = createFakePtyHost()
  const operations: string[] = []
  const fault = startPtyFault(host, {
    inspect: (pid) => {
      operations.push('inspect')
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => {
      operations.push(`signal:${signal}`)
      process.kill(pid, signal)
    }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('resumed')
  await waitForState(host.child.pid, host.home, false)

  const record = await fault.finish()
  expect(record).toMatchObject({
    kind: 'pty-pause',
    check: 'stalls',
    detail: { pids: [host.child.pid], refreshes: 0 }
  })
  expect(record.detail.blockedMs).toBeGreaterThanOrEqual(290)
  const signals = operations.flatMap((operation, index) =>
    operation.startsWith('signal:') ? [{ operation, before: operations[index - 1] }] : [])
  expect(signals.map(({ operation }) => operation)).toEqual(['signal:SIGSTOP', 'signal:SIGCONT'])
  expect(signals.every(({ before }) => before === 'inspect')).toBe(true)
})

test('stop begins async resume and settled waits for the final outcome', async () => {
  const host = createFakePtyHost()
  const signals: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 3000,
    kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal) }
  })
  await waitForState(host.child.pid, host.home, true)
  fault.stop()
  expect(await fault.settled()).toBe('resumed')
  await waitForState(host.child.pid, host.home, false)
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT'])
})

test('finish during the hold waits for cleanup and returns the applied pause record', async () => {
  const host = createFakePtyHost()
  const fault = startPtyFault(host, { holdMs: 3000 })
  await waitForState(host.child.pid, host.home, true)
  const record = await fault.finish()
  expect(await fault.settled()).toBe('resumed')
  expect(record.kind).toBe('pty-pause')
  await waitForState(host.child.pid, host.home, false)
})

test('retries unreadable resume inspections without signalling until identity is readable', async () => {
  const host = createFakePtyHost()
  let inspections = 0
  const signals: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 100,
    inspect: (pid) => {
      inspections += 1
      if (inspections >= 3 && inspections <= 5) return { kind: 'unreadable', reason: 'injected failure' }
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal) }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('resumed')
  expect(inspections).toBeGreaterThanOrEqual(6)
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT'])
  await waitForState(host.child.pid, host.home, false)
})

test('continues polling a delivered CONT through scheduler delay without retrying or killing', async () => {
  const host = createFakePtyHost()
  let continueSignals = 0
  let delayedPolls = 0
  const signals: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 100,
    inspect: (pid) => {
      const result = inspectPtyHost(pid)
      if (continueSignals > 0 && delayedPolls < 4 && result.kind === 'present') {
        delayedPolls += 1
        return { kind: 'present', identity: { ...result.identity, state: 'T' } }
      }
      return result
    },
    kill: (pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGCONT') continueSignals += 1
      process.kill(pid, signal)
    }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('resumed')
  expect(delayedPolls).toBe(4)
  expect(signals.filter((signal) => signal === 'SIGCONT')).toHaveLength(1)
  expect(signals).not.toContain('SIGKILL')
  await waitForState(host.child.pid, host.home, false)
})

test('retries a CONT that fails with EPERM once', async () => {
  const host = createFakePtyHost()
  let failed = false
  const signals: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 100,
    kill: (pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGCONT' && !failed) {
        failed = true
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      }
      process.kill(pid, signal)
    }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('resumed')
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT'])
  await waitForState(host.child.pid, host.home, false)
})

test('kills a verified host after three failed CONT attempts and rejects finish', async () => {
  const host = createFakePtyHost()
  const signals: string[] = []
  const operations: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 100,
    inspect: (pid) => {
      operations.push('inspect')
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => {
      signals.push(signal)
      operations.push(`signal:${signal}`)
      if (signal === 'SIGCONT') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      process.kill(pid, signal)
    }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('killed')
  await expect(fault.finish()).rejects.toThrow('pty-pause resume failed; host killed')
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT', 'SIGCONT', 'SIGKILL'])
  const signalReads = operations.flatMap((operation, index) =>
    operation.startsWith('signal:') ? [{ operation, before: operations[index - 1] }] : [])
  expect(signalReads.every(({ before }) => before === 'inspect')).toBe(true)
  await host.child.exited
})

test('keeps confirming KILL while the same host is a zombie until it is absent', async () => {
  const host = createFakePtyHost()
  const identity = await waitForHostIdentity(host)
  const signals: string[] = []
  let killSent = false
  let zombieInspections = 0
  const fault = startPtyFault(host, {
    holdMs: 100,
    inspect: (pid) => {
      if (killSent && zombieInspections < 3) {
        zombieInspections += 1
        return { kind: 'present', identity: { ...identity, state: 'Z' } }
      }
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGCONT') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      if (signal === 'SIGKILL') killSent = true
      process.kill(pid, signal)
    }
  })
  try {
    await waitForState(host.child.pid, host.home, true)
    expect(await fault.settled()).toBe('killed')
    await expect(fault.finish()).rejects.toThrow('pty-pause resume failed; host killed')
    expect(zombieInspections).toBe(3)
    expect(signals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT', 'SIGCONT', 'SIGKILL'])
  } finally {
    fault.stop()
    await fault.settled()
    try { host.child.kill('SIGCONT') } catch {}
    try { host.child.kill('SIGKILL') } catch {}
    await host.child.exited
  }
}, 15_000)
test('does not SIGKILL a pid replaced before the escalation identity check', async () => {
  const host = createFakePtyHost()
  const identity = await waitForHostIdentity(host)
  let continueAttempts = 0
  const signals: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 100,
    inspect: (pid) => {
      if (continueAttempts === 3) {
        return { kind: 'present', identity: { ...identity, state: 'T', started: `${identity.started} replacement` } }
      }
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGCONT') {
        continueAttempts += 1
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      }
      process.kill(pid, signal)
    }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('lost')
  await expect(fault.finish()).rejects.toThrow('pty-pause host changed or exited during the pause')
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT', 'SIGCONT'])
})
async function waitForChildGone(host: FakeHost, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(host.child.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await Bun.sleep(20)
  }
  throw new Error(`process ${host.child.pid} did not exit`)
}

function createDecoyProcess(): FakeHost {
  const root = makePtyScratch('quirky-soak-pty-decoy-')
  const home = makePtyScratch('quirky-soak-pty-decoy-home-')
  const entry = join(root, 'sleeper.ts')
  writeFileSync(entry, 'await Bun.sleep(60_000)\n')
  const child = Bun.spawn([process.execPath, entry], {
    cwd: home,
    env: { ...process.env, QUIRKY_HOME: home },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore'
  })
  ptyChildren.push(child)
  return { root, home, entry, child }
}

test('reports lost without CONT when the host exits during the hold', async () => {
  const host = createFakePtyHost()
  const signals: string[] = []
  const fault = startPtyFault(host, {
    kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal) }
  })
  await waitForState(host.child.pid, host.home, true)
  process.kill(host.child.pid, 'SIGKILL')
  await host.child.exited
  expect(await fault.settled()).toBe('lost')
  await expect(fault.finish()).rejects.toThrow('pty-pause host changed or exited during the pause')
  expect(signals).toEqual(['SIGSTOP'])
})

test('reports lost without CONT when the host identity changes during the hold', async () => {
  const host = createFakePtyHost()
  const identity = await waitForHostIdentity(host)
  let inspections = 0
  const signals: string[] = []
  const fault = startPtyFault(host, {
    inspect: (pid) => {
      inspections += 1
      if (inspections >= 3) {
        return { kind: 'present', identity: { ...identity, started: `${identity.started} replaced` } }
      }
      return inspectPtyHost(pid)
    },
    kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal) }
  })
  await waitForState(host.child.pid, host.home, true)
  expect(await fault.settled()).toBe('lost')
  await expect(fault.finish()).rejects.toThrow('pty-pause host changed or exited during the pause')
  expect(signals).toEqual(['SIGSTOP'])
})

test('bounds unreadable resume retries and reports pid and start time to stderr', async () => {
  const host = createFakePtyHost()
  const identity = await waitForHostIdentity(host)
  let inspections = 0
  let stderr = ''
  const originalWrite = process.stderr.write
  const resumeInspections: number[] = []
  const signals: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stderr.write
  try {
    const fault = startPtyFault(host, {
      resumeDeadlineMs: 500,
      inspect: (pid) => {
        inspections += 1
        if (inspections >= 3) {
          resumeInspections.push(Date.now())
          return { kind: 'unreadable', reason: 'injected inspection failure' }
        }
        return inspectPtyHost(pid)
      },
      kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal) }
    })
    await waitForState(host.child.pid, host.home, true)
    expect(await fault.settled()).toBe('unverified')
    await expect(fault.finish()).rejects.toThrow('pty-pause resume could not be verified')
    expect(resumeInspections.length).toBeGreaterThan(0)
    expect(resumeInspections.at(-1)! - resumeInspections[0]!).toBeLessThanOrEqual(500)
    expect(stderr).toContain(String(host.child.pid))
    expect(stderr).toContain(identity.started)
    expect(signals).toEqual(['SIGSTOP'])
  } finally {
    process.stderr.write = originalWrite
  }
})

const exitRunnerModes = ['success', 'replaced', 'absent', 'unreadable'] as const
const exitRunnerNames = {
  success: 'synchronously resumes the same stopped host from the process exit handler',
  replaced: 'does not signal a replaced PTY host from the process exit handler',
  absent: 'does not signal an absent PTY host from the process exit handler',
  unreadable: 'does not signal an unreadable PTY host from the process exit handler'
} as const

for (const mode of exitRunnerModes) {
  test(exitRunnerNames[mode], async () => {
    const host = createFakePtyHost()
    let runner: TestChild | undefined
    try {
      const runnerHome = makePtyScratch('quirky-soak-pty-exit-runner-home-')
      const runnerRoot = makePtyScratch('quirky-soak-pty-exit-runner-')
      const runnerPath = join(runnerRoot, 'exit-runner.ts')
      const signalPath = join(runnerHome, 'signals.log')
      const inspectionPath = join(runnerHome, 'inspections.log')
      writeFileSync(runnerPath, `
import { appendFileSync } from 'node:fs'
import { inspectPtyHost, startFault } from ${JSON.stringify(new URL('./faults.ts', import.meta.url).href)}
const repoRoot = process.argv[2]!
const home = process.argv[3]!
const pid = Number(process.argv[4])
const mode = process.argv[5]!
const signalPath = process.argv[6]!
const inspectionPath = process.argv[7]!
const control = { callAny: async (method: string) => {
  if (method !== 'status.get') throw new Error('unexpected control call: ' + method)
  return { ptyHost: { pid } }
} }
let inspections = 0
startFault({
  kind: 'pty-pause',
  repoRoot,
  home,
  ptyHostPid: () => pid,
  control: control as never,
  projects: [],
  out: home,
  runSeconds: 24,
  startedAt: performance.now() - 2100,
  signal: new AbortController().signal,
  ptyPause: {
    holdMs: 3000,
    inspect: (targetPid) => {
      inspections += 1
      if (inspections <= 2 || mode === 'success') return inspectPtyHost(targetPid)
      if (mode === 'absent') {
        appendFileSync(inspectionPath, inspections + ':absent\\n')
        return { kind: 'absent' }
      }
      if (mode === 'unreadable') {
        appendFileSync(inspectionPath, inspections + ':unreadable\\n')
        return { kind: 'unreadable', reason: 'injected exit inspection failure' }
      }
      const current = inspectPtyHost(targetPid)
      if (current.kind !== 'present') return current
      appendFileSync(inspectionPath, inspections + ':replaced\\n')
      return { kind: 'present', identity: { ...current.identity, started: current.identity.started + ' replaced', state: 'T' } }
    },
    kill: (targetPid, signal) => {
      appendFileSync(signalPath, targetPid + ':' + signal + '\\n')
      if (targetPid === pid) process.kill(targetPid, signal)
    }
  }
})
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
  const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], {
    timeout: 2000,
    env: { ...process.env, QUIRKY_HOME: home }
  })
  if (result.exitCode === 0 && result.stdout.toString().trim().startsWith('T')) {
    // Exit synchronously while the real hold is active; do not wait for async resume.
    await Bun.sleep(100)
    process.exit(1)
  }
  await Bun.sleep(10)
}
process.exit(2)
`)
      runner = Bun.spawn([process.execPath, runnerPath, host.root, host.home, String(host.child.pid), mode, signalPath, inspectionPath], {
        cwd: runnerHome,
        env: { ...process.env, QUIRKY_HOME: runnerHome },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      ptyChildren.push(runner)
      expect(await runner.exited).toBe(1)
      const signals = readFileSync(signalPath, 'utf8').trim().split(/\r?\n/)
      if (mode === 'success') {
        expect(signals).toEqual([`${host.child.pid}:SIGSTOP`, `${host.child.pid}:SIGCONT`])
        await waitForState(host.child.pid, host.home, false, 1000)
      } else {
        expect(signals).toEqual([`${host.child.pid}:SIGSTOP`])
        await waitForState(host.child.pid, host.home, true, 1000)
      }
      if (mode === 'replaced') {
        expect(readFileSync(inspectionPath, 'utf8').trim().split(/\r?\n/)).toEqual(['3:replaced'])
      }
      if (mode === 'absent') {
        expect(readFileSync(inspectionPath, 'utf8').trim().split(/\r?\n/)).toEqual(['3:absent'])
      }
      if (mode === 'unreadable') {
        expect(readFileSync(inspectionPath, 'utf8').trim().split(/\r?\n/))
          .toEqual(['3:unreadable', '4:unreadable', '5:unreadable'])
      }
    } finally {
      const children = runner ? [runner, host.child] : [host.child]
      for (const child of children) {
        try { child.kill('SIGCONT') } catch {}
        try { child.kill('SIGKILL') } catch {}
      }
      await Promise.all(children.map((child) => child.exited))
    }
  }, 15_000)
}
const scopeCleanupVariants = [
  { name: 'plain', outcome: 'resumed', mustExit: false },
  { name: 'unreadable first three rounds', outcome: 'resumed', mustExit: false },
  { name: 'unreadable through the deadline', outcome: 'unverified', mustExit: true },
  { name: 'CONT always fails', outcome: 'killed', mustExit: false },
  { name: 'CONT and KILL fail', outcome: 'unverified', mustExit: true },
  { name: 'measurement clock throws after STOP', outcome: 'resumed', mustExit: false }
] as const

// These cases exercise real OS stop/continue delivery and process-scope cleanup.
for (const variant of scopeCleanupVariants) {
  test(`scope finally cleanup owns a stopped host with an unrelated decoy: ${variant.name}`, async () => {
    const scope = createProcessScope()
    ptyScopes.push(scope)
    const host = createFakePtyHost({ scope })
    const decoy = createDecoyProcess()
    const signalTargets: { pid: number; signal: string }[] = []
    let inspections = 0
    const stopSent = Promise.withResolvers<void>()
    let throwClockOnNextNow = false
    const dependencies: PauseOverrides = {
      holdMs: 3000,
      kill: (pid, signal) => {
        signalTargets.push({ pid, signal })
        if (pid === decoy.child.pid) return
        if (variant.name === 'CONT always fails' && signal === 'SIGCONT') {
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        }
        if (variant.name === 'CONT and KILL fail' && (signal === 'SIGCONT' || signal === 'SIGKILL')) {
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        }
        process.kill(pid, signal)
        if (signal === 'SIGSTOP') {
          throwClockOnNextNow = variant.name === 'measurement clock throws after STOP'
          stopSent.resolve()
        }
      }
    }
    if (variant.name === 'unreadable first three rounds') {
      dependencies.inspect = (pid) => {
        inspections += 1
        if (inspections >= 3 && inspections <= 5) return { kind: 'unreadable', reason: 'injected failure' }
        return inspectPtyHost(pid)
      }
    }
    if (variant.name === 'unreadable through the deadline') {
      dependencies.resumeDeadlineMs = 500
      dependencies.inspect = (pid) => {
        inspections += 1
        return inspections >= 3
          ? { kind: 'unreadable', reason: 'injected failure' }
          : inspectPtyHost(pid)
      }
    }
    if (variant.name === 'measurement clock throws after STOP') {
      dependencies.now = () => {
        if (throwClockOnNextNow) {
          throwClockOnNextNow = false
          throw new Error('measurement clock failed')
        }
        return performance.now()
      }
    }
    const fault = startPtyFault(host, dependencies)
    let caught: unknown
    let outcome: string | null = null
    let cleanupMs = 0
    try {
      try {
        if (variant.name === 'measurement clock throws after STOP') await stopSent.promise
        else await waitForState(host.child.pid, scope.home, true)
        throw new Error('ps failed for 9 of 10 samples')
      } finally {
        const cleanupStarted = performance.now()
        fault.stop()
        outcome = await fault.settled()
        await scope.cleanup()
        cleanupMs = performance.now() - cleanupStarted
      }
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('ps failed for 9 of 10 samples')
    expect(outcome).toBe(variant.outcome)
    expect(signalTargets).toContainEqual({ pid: host.child.pid, signal: 'SIGSTOP' })
    expect(signalTargets.some(({ pid }) => pid === decoy.child.pid)).toBe(false)
    if (variant.name === 'unreadable through the deadline') {
      expect(signalTargets.some(({ signal }) => signal === 'SIGCONT')).toBe(false)
    }
    if (variant.name === 'CONT and KILL fail') {
      expect(signalTargets.some(({ signal }) => signal === 'SIGKILL')).toBe(true)
    }
    expect(signalTargets.every(({ pid }) => pid === host.child.pid)).toBe(true)
    expect(stoppedProcessesWithHome(scope.home)).toEqual([])
    expect(processState(decoy.child.pid, decoy.home)?.startsWith('T')).toBe(false)
    expect(() => process.kill(decoy.child.pid, 0)).not.toThrow()
    if (variant.mustExit) await waitForChildGone(host)
    else await expectChildGoneOrRunning(host)
    if (variant.name === 'unreadable through the deadline' || variant.name === 'CONT and KILL fail') {
      expect(cleanupMs).toBeLessThan(7000)
    }
    if (variant.name === 'measurement clock throws after STOP') {
      const error = await fault.finish().then(() => undefined, (caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('measurement clock failed')
    }
  }, 15_000)
}
test('returns unreadable rather than absent when synchronous inspection fails for a live pid', async () => {
  const host = createFakePtyHost()
  await waitForHostIdentity(host)
  const originalSpawnSync = Bun.spawnSync
  Bun.spawnSync = new Proxy(originalSpawnSync, {
    apply() {
      throw new Error('injected process inspection failure')
    }
  })
  try {
    const result = inspectPtyHost(host.child.pid)
    expect(result.kind).toBe('unreadable')
    if (result.kind === 'unreadable') expect(result.reason.length).toBeGreaterThan(0)
    expect(() => process.kill(host.child.pid, 0)).not.toThrow()
  } finally {
    Bun.spawnSync = originalSpawnSync
  }
})
test('resumes in the hold finally when the measurement clock throws just after SIGSTOP', async () => {
  const host = createFakePtyHost()
  let throwOnNextNow = false
  const operations: string[] = []
  const fault = startPtyFault(host, {
    holdMs: 3000,
    now: () => {
      operations.push(throwOnNextNow ? 'now-after-stop' : 'now')
      if (throwOnNextNow) {
        throwOnNextNow = false
        throw new Error('measurement clock failed')
      }
      return performance.now()
    },
    kill: (pid, signal) => {
      operations.push(`signal:${signal}`)
      process.kill(pid, signal)
      if (signal === 'SIGSTOP') throwOnNextNow = true
    }
  })
  expect(await fault.settled()).toBe('resumed')
  expect(operations.indexOf('signal:SIGSTOP')).toBeLessThan(operations.indexOf('now-after-stop'))
  await waitForState(host.child.pid, host.home, false)
  await expect(fault.finish()).rejects.toThrow('measurement clock failed')
})
for (const output of ['', 'malformed command output']) {
  test(`treats ${output || 'empty'} Darwin environment output as unreadable for a live host`, async () => {
    if (process.platform !== 'darwin') return
    const host = createFakePtyHost()
    await waitForHostIdentity(host)
    const originalSpawnSync = Bun.spawnSync
    Bun.spawnSync = new Proxy(originalSpawnSync, {
      apply(target, receiver, args: unknown[]) {
        const command = args[0] as string[]
        if (command[0] === 'ps' && command[1] === 'eww') {
          return {
            exitCode: 0,
            stdout: Buffer.from(output),
            stderr: Buffer.alloc(0),
            success: true,
            signalCode: null,
            pid: process.pid
          }
        }
        return Reflect.apply(target, receiver, args)
      }
    })
    try {
      expect(inspectPtyHost(host.child.pid).kind).toBe('unreadable')
      expect(() => process.kill(host.child.pid, 0)).not.toThrow()
    } finally {
      Bun.spawnSync = originalSpawnSync
    }
  })
}
test('reads QUIRKY_HOME when another inherited environment value contains spaces', async () => {
  const host = createFakePtyHost({ extraEnv: { SOAK_LABEL: 'two words' } })
  try {
    const identity = await waitForHostIdentity(host)
    expect(identity.home).toBe(host.home)
  } finally {
    try { host.child.kill('SIGCONT') } catch {}
    try { host.child.kill('SIGKILL') } catch {}
    await host.child.exited
  }
})
test('returns a null home for valid Darwin command output without QUIRKY_HOME', async () => {
  if (process.platform !== 'darwin') return
  const host = createFakePtyHost()
  const identity = await waitForHostIdentity(host)
  const originalSpawnSync = Bun.spawnSync
  Bun.spawnSync = new Proxy(originalSpawnSync, {
    apply(target, receiver, args: unknown[]) {
      const command = args[0] as string[]
      if (command[0] === 'ps' && command[1] === 'eww') {
        return {
          exitCode: 0,
          stdout: Buffer.from(`${identity.command} SOAK_LABEL=two words`),
          stderr: Buffer.alloc(0),
          success: true,
          signalCode: null,
          pid: process.pid
        }
      }
      return Reflect.apply(target, receiver, args)
    }
  })
  try {
    const inspection = inspectPtyHost(host.child.pid)
    expect(inspection.kind).toBe('present')
    if (inspection.kind === 'present') expect(inspection.identity.home).toBeNull()
  } finally {
    Bun.spawnSync = originalSpawnSync
  }
})
