import { expect, test, vi } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient, PluginContext } from '@quirky/protocol'
import { validateValue } from '@quirky/protocol'
import { startChild, type StartedChild } from '../../packages/process/src/child.ts'
import { parseManifest } from '../../packages/daemon/src/plugins/manifest.ts'
import { buildFaultUi, faultPlan, installFaultPlugin, installSlowGit, setGitDelay, startFault } from './faults.ts'
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

test('plans zombie holders, bounded storms, a synchronous stall, slow git, and fixed feedback', () => {
  expect(faultPlan('zombies', 24)).toEqual({ kind: 'zombies', holders: 2, each: 5, lifetimeSeconds: 54 })
  expect(faultPlan('storm', 24)).toEqual({ kind: 'storm', seconds: 10 })
  expect(faultPlan('block', 24)).toEqual({ kind: 'block', ms: 3000 })
  expect(faultPlan('slow-git', 24)).toEqual({ kind: 'slow-git', ms: 35_000 })
  expect(faultPlan('feedback', 24)).toEqual({ kind: 'feedback', refreshes: 17 })
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

test('declares feedback schemas accepted by the daemon manifest validator', () => {
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
