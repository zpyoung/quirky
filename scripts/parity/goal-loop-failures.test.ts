import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope } from '../test-support/process-scope'
import { STEP_IDS, parseGoalLoopArgs, parseGoalLoopOutput, runGoalLoop } from './goal-loop-run'
import { createGoalLoopWorld, type GoalLoopWorld } from './goal-loop-world'

const faults = ['missing-agent', 'malformed-cli-json', 'cli-nonzero', 'missing-terminal-ack', 'provider-malformed', 'daemon-exited', 'deadline'] as const

for (const fault of ['inspection', 'tracking'] as const) {
  test(`teardown still reaps the real daemon and PTY after initial ${fault} fails`, async () => {
    const originalSpawn = Bun.spawnSync
    let world: GoalLoopWorld | undefined
    let daemonPid = 0
    let ptyPid = 0
    let injected = false
    try {
      const report = await runGoalLoop({
        createWorld: async (options) => {
          const created = await createGoalLoopWorld(options)
          world = created
          const cleanup = created.cleanup.bind(created)
          created.cleanup = async (cleanupOptions) => {
            daemonPid = created.daemonPid
            ptyPid = created.ptyPid ?? 0
            const track = created.scope.track.bind(created.scope)
            try {
              if (fault === 'inspection') {
                Bun.spawnSync = new Proxy(originalSpawn, {
                  apply(target, receiver, args: unknown[]) {
                    const command = args[0]
                    if (!injected && Array.isArray(command) && command[0] === 'ps' &&
                        command[1] === '-p' && command[2] === String(ptyPid)) {
                      injected = true
                      return { exitCode: 143, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signalCode: 'SIGTERM', success: false }
                    }
                    return Reflect.apply(target, receiver, args)
                  }
                })
              } else {
                created.scope.track = (pid) => {
                  if (!injected && pid === ptyPid) {
                    injected = true
                    throw new Error('controlled PTY tracking failure')
                  }
                  track(pid)
                }
              }
              await cleanup(cleanupOptions)
            } finally {
              Bun.spawnSync = originalSpawn
              created.scope.track = track
            }
          }
          return created
        }
      })
      expect(injected, JSON.stringify(report)).toBe(true)
      expect(report.steps.every((step) => step.status === 'passed'), JSON.stringify(report)).toBe(true)
      expect(report.ok).toBe(false)
      expect(report.cleanup.ok).toBe(false)
      expect(report.cleanup.error).toContain(fault === 'inspection' ? 'PTY inspection' : 'controlled PTY tracking failure')
      expect(daemonPid).toBeGreaterThan(0)
      expect(ptyPid).toBeGreaterThan(0)
      expect(() => process.kill(daemonPid, 0), 'owned daemon must exit before the report returns').toThrow()
      expect(() => process.kill(ptyPid, 0), 'owned PTY must exit before the report returns').toThrow()
    } finally {
      Bun.spawnSync = originalSpawn
      if (world) {
        await world.scope.cleanup()
        if (daemonPid) expect(() => process.kill(daemonPid, 0)).toThrow()
        if (ptyPid) expect(() => process.kill(ptyPid, 0)).toThrow()
        rmSync(world.root, { recursive: true, force: true })
      }
    }
  }, 150_000)
}

test('agent launch waits for delayed OMP argv and terminal observations exactly once', async () => {
  let ownedRoot = ''
  let argvReleaseSent = false
  let terminalReleaseSent = false
  const report = await runGoalLoop({
    createWorld: async (options) => {
      const world = await createGoalLoopWorld({ ...options, faults: { delayedPrompt: true } })
      ownedRoot = world.root
      const readLog = world.readLog.bind(world)
      world.readLog = async (name) => {
        const text = await readLog(name)
        if (name === 'omp' && !argvReleaseSent) {
          argvReleaseSent = true
          writeFileSync(world.paths.ompPromptArgvRelease, 'release\\n', { mode: 0o600 })
        }
        return text
      }
      const cli = world.cli.bind(world)
      world.cli = async (args, cliOptions) => {
        const result = await cli(args, cliOptions)
        if (args[0] === 'terminal' && args[1] === 'read' && !terminalReleaseSent) {
          terminalReleaseSent = true
          writeFileSync(world.paths.ompPromptTerminalRelease, 'release\\n', { mode: 0o600 })
        }
        return result
      }
      return world
    }
  })
  expect(report.ok).toBe(true)
  const launch = report.steps.find((step) => step.id === 'agents-launch')!
  expect(launch.status).toBe('passed')
  expect(argvReleaseSent).toBe(true)
  expect(terminalReleaseSent).toBe(true)
  const sessions = launch.evidence.sessions
  expect(Array.isArray(sessions)).toBe(true)
  expect(sessions).toHaveLength(2)
  for (const session of sessions as Record<string, unknown>[]) {
    expect(session.argvPromptCount).toBe(1)
    expect(session.terminalPromptCount).toBe(1)
  }
  expect(ownedRoot).not.toBe('')
  expect(existsSync(ownedRoot)).toBe(false)
}, 150_000)

test('product cleanup stall leaves the reserved hard-deadline window for real teardown', async () => {
  type CleanupOptions = { signal?: AbortSignal; deadline?: number }
  const world = await createGoalLoopWorld()
  await world.start()
  const daemonPid = world.daemonPid
  const originalCli = world.cli.bind(world)
  let productCleanupStarted = false
  let productDeadlineExpired = false
  world.cli = async (args, options) => {
    if (!productCleanupStarted && args[0] === 'worktree' && args[1] === 'list') {
      productCleanupStarted = true
      const signal = options?.signal
      if (!signal) throw new Error('product cleanup did not receive its bounded signal')
      const { promise, resolve } = Promise.withResolvers<void>()
      if (signal.aborted) {
        productDeadlineExpired = true
        resolve()
      } else {
        signal.addEventListener('abort', () => {
          productDeadlineExpired = true
          resolve()
        }, { once: true })
      }
      await promise
      throw new Error('controlled product cleanup stall ended at its phase deadline')
    }
    return originalCli(args, options)
  }
  let teardownRemainingMs = -1
  let teardownSignalAborted = true
  const originalCleanup = world.cleanup.bind(world) as (options?: CleanupOptions) => Promise<void>
  world.cleanup = async (options?: CleanupOptions) => {
    teardownRemainingMs = (options?.deadline ?? Date.now()) - Date.now()
    teardownSignalAborted = options?.signal?.aborted ?? true
    await originalCleanup(options)
  }
  try {
    const report = await runGoalLoop({
      deadlineMs: 20_000,
      createWorld: async () => world,
      beforeStep: async (id) => {
        if (id === 'agents-launch') throw new Error('controlled operation failure')
      }
    })
    expect(report.ok).toBe(false)
    expect(report.steps[0]!.status).toBe('passed')
    expect(report.steps[1]!.error?.message).toBe('controlled operation failure')
    expect(productCleanupStarted).toBe(true)
    expect(productDeadlineExpired).toBe(true)
    expect(teardownRemainingMs).toBeGreaterThan(6_000)
    expect(teardownSignalAborted).toBe(false)
    expect(report.elapsedMs).toBeLessThan(20_000)
    expect(report.cleanup.ok).toBe(false)
    expect(report.cleanup.error).toContain('product cleanup deadline exceeded')
    expect(existsSync(world.root)).toBe(false)
    expect(() => process.kill(daemonPid, 0)).toThrow()
  } finally {
    if (existsSync(world.root)) await world.cleanup()
  }
}, 30_000)

test('a timed-out process scope cannot keep world cleanup waiting or claim confirmed reaping', async () => {
  const world = await createGoalLoopWorld()
  await world.start()
  const daemonPid = world.daemonPid
  const originalCleanup = world.scope.cleanup.bind(world.scope)
  const stalled = Promise.withResolvers<void>()
  const timeout = Promise.withResolvers<'timeout'>()
  const controller = new AbortController()
  let cleanup: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    world.scope.cleanup = () => {
      controller.abort(new Error('controlled process-scope deadline'))
      return stalled.promise
    }
    cleanup = world.cleanup({ deadline: Date.now() + 1_000, signal: controller.signal })
    // real process exit and pipe cancellation cannot be driven by fake timers
    timer = setTimeout(() => timeout.resolve('timeout'), 1_000)
    const outcome = await Promise.race([cleanup.then(() => null, error => error), timeout.promise])
    expect(outcome).toMatchObject({ kind: 'cleanup-failed' })
    expect(existsSync(world.root)).toBe(true)
  } finally {
    clearTimeout(timer)
    world.scope.cleanup = originalCleanup
    await originalCleanup()
    stalled.resolve()
    await cleanup?.catch(() => undefined)
    expect(() => process.kill(daemonPid, 0)).toThrow()
    rmSync(world.root, { recursive: true, force: true })
  }
}, 30_000)

test('CLI output must be one valid JSON document and a successful exit', () => {
  expect(parseGoalLoopOutput('{"id":"actual-receipt"}\n', 0)).toEqual({ id: 'actual-receipt' })
  for (const stdout of ['', '{"truncated":', '{}\n{}', 'progress\n{}']) {
    try {
      parseGoalLoopOutput(stdout, 0)
      throw new Error('accepted malformed output')
    } catch (error) {
      expect(error).toMatchObject({ kind: 'malformed-cli-json' })
    }
  }
  try {
    parseGoalLoopOutput('{"id":"not-success"}', 1, 'operation refused')
    throw new Error('accepted nonzero exit')
  } catch (error) {
    expect(error).toMatchObject({ kind: 'cli-nonzero' })
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain('1')
  }
  expect(() => parseGoalLoopOutput('{"error":{"message":"exact owned failure"}}', 2)).toThrow('exact owned failure')
})

test('UTF-8 failure diagnostics retain complete characters within the byte budget', async () => {
  const world = {
    root: '/owned/fixture', env: {}, start: async () => {}, cleanup: async () => {}
  } as unknown as GoalLoopWorld
  const text = '\u754c'.repeat(5000)
  const report = await runGoalLoop({
    createWorld: async () => world,
    executeStep: async () => { throw Object.assign(new Error(text), { stderrTail: text }) }
  })
  const error = report.steps[0]!.error!
  expect(report.ok).toBe(false)
  for (const value of [error.message, error.stderrTail!]) {
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(8192)
    expect(value).not.toContain('\ufffd')
    expect(value.endsWith('\u754c')).toBe(true)
  }
})

for (const fault of faults) {
  test(`${fault} preserves failure, dependent not-run steps and cleanup`, async () => {
    let cleaned = false
    const world = {
      root: '/owned/fixture', env: { QUIRKY_SESSION_TOKEN: 'private-fixture-session-token' },
      start: async () => {}, cleanup: async () => { cleaned = true }
    } as unknown as GoalLoopWorld
    const report = await runGoalLoop({
      createWorld: async () => world,
      executeStep: async (id) => {
        if (id === 'terminals-roundtrip') throw Object.assign(new Error(`${'x'.repeat(10_000)} /owned/fixture private-fixture-session-token ${fault}`), {
          kind: fault, stderrTail: 'y'.repeat(10_000), evidence: { sendReceiptReceived: fault === 'missing-terminal-ack' }
        })
        return { observed: id }
      }
    })
    expect(report.ok).toBe(false)
    expect(cleaned).toBe(true)
    expect(report.cleanup.ok).toBe(true)
    expect(report.steps.map((step) => step.id)).toEqual([...STEP_IDS])
    expect(report.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'failed', 'not-run', 'not-run', 'not-run', 'not-run'])
    const failed = report.steps[2]!
    expect(failed.error?.kind).toBe(fault)
    expect(Buffer.byteLength(failed.error?.message ?? '')).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(failed.error?.stderrTail ?? '')).toBeLessThanOrEqual(8192)
    expect(JSON.stringify(report)).not.toContain('/owned/fixture')
    expect(JSON.stringify(report)).not.toContain('private-fixture-session-token')
    if (fault === 'missing-terminal-ack') expect(failed.evidence.sendReceiptReceived).toBe(true)
  })
}

test('cleanup failure prevents a green report and preserves an earlier operation error', async () => {
  for (const operationFails of [false, true]) {
    const world = {
      root: '/owned/fixture', env: {}, start: async () => {},
      cleanup: async () => { throw new Error('owned process did not exit') }
    } as unknown as GoalLoopWorld
    const report = await runGoalLoop({
      createWorld: async () => world,
      executeStep: async () => {
        if (operationFails) throw Object.assign(new Error('original operation failure'), { kind: 'cli-nonzero' })
        return { observed: true }
      }
    })
    expect(report.ok).toBe(false)
    expect(report.cleanup).toEqual({ ok: false, error: 'owned process did not exit' })
    if (operationFails) expect(report.steps[0]!.error?.message).toBe('original operation failure')
    else expect(report.steps.every((step) => step.status === 'passed')).toBe(true)
  }
})

test('the owned deadline aborts a blocked operation and still awaits cleanup', async () => {
  let signal: AbortSignal
  let cleaned = false
  const world = {
    root: '/owned/fixture', env: {}, start: async () => {},
    cleanup: async () => { cleaned = true }
  } as unknown as GoalLoopWorld
  const report = await runGoalLoop({
    deadlineMs: 20,
    createWorld: async (options) => { signal = options!.signal!; return world },
    executeStep: async () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      if (!signal.aborted) {
        signal.addEventListener('abort', () => resolve(), { once: true })
        await promise
      }
      throw Object.assign(new Error('deadline expired during operation'), { kind: 'deadline' })
    }
  })
  expect(cleaned).toBe(true)
  expect(report.ok).toBe(false)
  expect(report.cleanup.ok).toBe(true)
  expect(report.steps[0]!.status).toBe('failed')
  expect(report.steps[0]!.error?.kind).toBe('deadline')
  expect(report.steps.slice(1).every((step) => step.status === 'not-run')).toBe(true)
})

test('public arguments cannot select a home, runtime, repository, command or executable', () => {
  for (const args of [['--home', '/tmp/unsafe'], ['--runtime', 'owner'], ['--repo', '/tmp/unsafe'], ['--command', 'true'], ['--agent-bin', '/usr/bin/true'], ['--unknown'], ['--json', '--help'], ['--json', '--json']]) {
    expect(() => parseGoalLoopArgs(args)).toThrow()
  }
  expect(parseGoalLoopArgs([])).toEqual({ json: false, help: false })
  expect(parseGoalLoopArgs(['--json'])).toEqual({ json: true, help: false })
  expect(parseGoalLoopArgs(['--help'])).toEqual({ json: false, help: true })
})

test('invalid public CLI arguments exit 2 without allocating runtime state', async () => {
  const home = mkdtempSync('/tmp/quirky-goal-invalid-')
  try {
    for (const flag of ['--home', '--runtime', '--repo', '--command', '--agent-bin', '--unknown']) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goal-loop.ts'), flag], {
        env: { PATH: '/usr/bin:/bin', HOME: home, QUIRKY_HOME: home, TMPDIR: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdout: 'pipe', stderr: 'pipe'
      })
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exit, stderr).toBe(2)
      expect(stdout).toBe('')
      expect(stderr.length).toBeGreaterThan(0)
      expect(readdirSync(home)).toEqual([])
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

for (const fault of ['missing-agent', 'provider-malformed', 'daemon-exited', 'startup'] as const) {
  test(`real isolated ${fault} cannot become passing evidence`, async () => {
    let ownedRoot = ''
    let daemonPid = 0
    const report = await runGoalLoop({
      createWorld: async (options) => {
        const world = await createGoalLoopWorld({ ...options, faults: {
          missingAgent: fault === 'missing-agent', malformedProvider: fault === 'provider-malformed', failedStartup: fault === 'startup'
        } })
        ownedRoot = world.root
        return world
      },
      beforeStep: async (id, world) => {
        daemonPid = world.daemonPid
        if (fault === 'daemon-exited' && id === 'agents-launch') {
          process.kill(daemonPid, 'SIGTERM')
          const until = Date.now() + 5000
          // process exit is an OS event; fake timers cannot drive the real daemon
          while (Date.now() < until) {
            try { process.kill(daemonPid, 0) } catch { break }
            await Bun.sleep(20)
          }
        }
      }
    })
    expect(report.ok).toBe(false)
    expect(report.steps.some((step) => step.status === 'failed')).toBe(true)
    expect(report.steps.some((step) => step.status === 'not-run')).toBe(true)
    expect(report.cleanup.ok).toBe(true)
    expect(ownedRoot).not.toBe('')
    expect(existsSync(ownedRoot)).toBe(false)
    if (daemonPid) expect(() => process.kill(daemonPid, 0)).toThrow()
    if (fault === 'provider-malformed') expect(report.steps.find((step) => step.id === 'accounts-usage')?.status, JSON.stringify(report)).toBe('failed')
  }, 150_000)
}

test('SIGTERM during a real active turn reaps the owned tree without killing an unrelated process', async () => {
  const temporary = mkdtempSync('/tmp/quirky-goal-signal-')
  const home = join(temporary, 'controller-home')
  const scope = createProcessScope(home)
  const code = `import {runGoalLoop} from ${JSON.stringify(join(import.meta.dir, 'goal-loop-run.ts'))};
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort(new Error('SIGTERM')));
const report = await runGoalLoop({signal:controller.signal, onActiveTurn:async () => {const {promise,resolve}=Promise.withResolvers<void>();controller.signal.addEventListener('abort',()=>resolve(),{once:true});process.kill(process.pid,'SIGTERM');await promise}});
console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;`
  const entry = join(temporary, 'signal-fixture.ts')
  writeFileSync(entry, code)
  const environment = { PATH: '/usr/bin:/bin', HOME: home, QUIRKY_HOME: home, TMPDIR: temporary, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }
  const sentinel = Bun.spawn(['/bin/sleep', '180'], { env: environment, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn([process.execPath, entry], { env: environment, stdout: 'pipe', stderr: 'pipe' })
  // a real subprocess deadline must keep running if the fixture's event loop stalls
  const timeout = setTimeout(() => scope.killNow(), 140_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exit, stderr).toBe(1)
    const report = JSON.parse(stdout)
    expect(report.ok).toBe(false)
    expect(report.cleanup.ok).toBe(true)
    expect(report.steps.find((step: { id: string }) => step.id === 'loop-run-stop').status).toBe('failed')
    expect(sentinel.exitCode).toBeNull()
    process.kill(sentinel.pid, 0)
  } finally {
    clearTimeout(timeout)
    await scope.cleanup()
    await child.exited
    sentinel.kill('SIGTERM')
    await sentinel.exited
    rmSync(temporary, { recursive: true, force: true })
  }
}, 150_000)
