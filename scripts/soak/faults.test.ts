import { expect, test, vi } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient, PluginContext } from '@quirky/protocol'
import { validateValue } from '@quirky/protocol'
import { startChild, type StartedChild } from '../../packages/process/src/child.ts'
import { parseManifest } from '../../packages/daemon/src/plugins/manifest.ts'
import { buildFaultUi, faultPlan, installFaultPlugin, installSlowGit, setGitDelay, startFault } from './faults.ts'
import { FAULT_CHECK } from './contracts.ts'
import { activate } from './faults/main.ts'
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
