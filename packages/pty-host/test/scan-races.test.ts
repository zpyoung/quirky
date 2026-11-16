import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProcessRunnerDisposedError, liveProcesses } from '@quirky/process'
import type { ProcessRunner, PtyEvent, RunResult } from '@quirky/protocol'
import { readMeta } from '../src/history/meta'
import { SessionManager, type CreateParams, type SessionManagerOptions } from '../src/session'
import {
  heldRunner,
  onCleanup,
  recordProcessKillTargets,
  runCleanups,
  scopeForHome,
  startHost,
  tempHome,
  trackSessionProcesses,
  waitFor
} from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
const DIR = (home: string, sessionId: string) => join(home, 'sessions', sessionId)
const params = (sessionId: string, script: string): CreateParams => ({
  sessionId,
  cwd: '/tmp',
  argv: ['/bin/sh', '-c', script],
  env: ENV,
  cols: 80,
  rows: 24
})
const processResult = (stdoutText = '', extra: Partial<RunResult> = {}): RunResult => ({
  stdout: new TextEncoder().encode(stdoutText),
  stdoutText,
  stderr: '',
  exitCode: 0,
  signal: null,
  durationMs: 0,
  ...extra
})

function managerFor(
  processRunner: Pick<ProcessRunner, 'run'>,
  options: Omit<Partial<SessionManagerOptions>, 'home' | 'processRunner'> = {},
  home = tempHome()
): { manager: SessionManager; home: string } {
  const manager = new SessionManager({ home, processRunner, ...options })
  trackSessionProcesses(manager, scopeForHome(home))
  onCleanup(() => manager.shutdown())
  return { manager, home }
}

function jobScript(pidFile: string): string {
  return `set -m; sleep 7777 & echo bg=$!; echo $! > '${pidFile}'; wait`
}

async function createJob(manager: SessionManager, home: string, sessionId: string) {
  const pidFile = join(home, `${sessionId}.pid`)
  const root = await manager.create(params(sessionId, jobScript(pidFile)))
  const childPid = await waitFor(
    () => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null,
    5000,
    'background job pid'
  )
  return { rootPid: root.pid, childPid }
}

function expectAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow()
}

async function expectGone(pid: number, what: string): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return null
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM' ? null : true
    }
  }, 2500, `${what} to exit`)
}

/** Measures real socket/request delay while a deliberately held process scan remains unresolved. */
async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const { promise: result, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => resolve(false), timeoutMs)
  void promise.then(
    () => { clearTimeout(timer); resolve(true) },
    () => { clearTimeout(timer); resolve(true) }
  )
  return result
}

async function exitEvent(events: PtyEvent[], sessionId: string): Promise<PtyEvent> {
  return waitFor(
    () => events.find((event) => event.type === 'exit' && event.sessionId === sessionId) ?? null,
    5000,
    `${sessionId} exit event`
  )
}

function exitEvents(manager: SessionManager): PtyEvent[] {
  const events: PtyEvent[] = []
  manager.onExit((event) => events.push(event))
  return events
}

describe('awaited process tree operations', () => {
  test('S1: reasoned kill awaits a held runner without blocking the event loop', async () => {
    const scans = heldRunner({ hold: true })
    const { manager } = managerFor(scans.runner)
    const { pid } = await manager.create(params('k', 'sleep 7777'))
    // A real platform timer must fire while the runner is held, proving the host loop can run.
    const timerFired = Promise.withResolvers<void>()
    setTimeout(() => timerFired.resolve(), 10)

    let settled = false
    const pending = manager.kill('k', undefined, 'killed')
    void pending.then(() => { settled = true }, () => { settled = true })
    expect(pending).toBeInstanceOf(Promise)
    await timerFired.promise
    expect(settled).toBe(false)
    expect(scans.calls).toHaveLength(1)
    expect(scans.calls[0]!.argv).toEqual(['ps', '-A', '-o', 'pid=,ppid='])
    expect(scans.calls[0]!.options).toMatchObject({ timeoutMs: 1000, killGraceMs: 0 })
    expect(scans.calls[0]!.options?.signal).toBeInstanceOf(AbortSignal)
    expectAlive(pid)

    scans.release()
    await pending
  })

  test('S2: a job is captured before a reasoned kill signals its parent', async () => {
    const scans = heldRunner({ hold: true })
    const { manager, home } = managerFor(scans.runner)
    const events = exitEvents(manager)
    const { rootPid, childPid } = await createJob(manager, home, 'bg')

    const killing = manager.kill('bg', undefined, 'killed')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held process scan')
    expectAlive(rootPid)
    expectAlive(childPid)

    scans.release()
    await killing
    await exitEvent(events, 'bg')
    await expectGone(rootPid, 'session root')
    await expectGone(childPid, 'job process')
  })

  test('S3: socket kill waits for signalling while another client remains responsive; plain kill does not scan', async () => {
    const scans = heldRunner({ hold: true })
    const kills = recordProcessKillTargets()
    const host = startHost({ processRunner: scans.runner })
    const first = await host.connect()
    const second = await host.connect()
    const events = exitEvents(host.server.manager)
    const { pid } = await first.request('create', params('k', 'sleep 7777'))
    const killing = first.request('kill', { sessionId: 'k', reason: 'killed' })

    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held socket kill scan')
    expect(await settlesWithin(killing, 150)).toBe(false)
    expect((await second.request('list', {})).some((session) => session.sessionId === 'k')).toBe(true)

    scans.release()
    expect(await killing).toEqual({})
    await exitEvent(events, 'k')

    const plain = await first.request('create', params('plain', 'sleep 7777'))
    const callsBeforePlainKill = scans.calls.length
    expect(await first.request('kill', { sessionId: 'plain' })).toEqual({})
    expect(scans.calls).toHaveLength(callsBeforePlainKill)
    expect(kills.targets.some((target) => target.pid === -plain.pid && target.signal === 'SIGTERM')).toBe(true)
    expect(pid).toBeGreaterThan(0)
  })

  test('S4: pending forget hides the session, joins repeats, and removes the folder after signalling', async () => {
    const scans = heldRunner({ hold: true })
    const { manager, home } = managerFor(scans.runner)
    const { rootPid, childPid } = await createJob(manager, home, 'f')
    const folder = DIR(home, 'f')

    const forgetting = manager.forget('f')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held forget scan')
    const repeated = manager.forget('f')
    expect(await settlesWithin(forgetting, 150)).toBe(false)
    expect(existsSync(folder)).toBe(true)
    expectAlive(rootPid)
    expectAlive(childPid)
    expect((await manager.list()).some((session) => session.sessionId === 'f')).toBe(false)
    await expect(manager.read('f', 1)).rejects.toThrow('unknown session: f')

    scans.release()
    await Promise.all([forgetting, repeated])
    expect(existsSync(folder)).toBe(false)
    await expectGone(rootPid, 'forgotten session root')
    await expectGone(childPid, 'forgotten job process')
    // Keep the requested 100 ms persistence check tied to the real filesystem state.
    await Bun.sleep(100)
    expect(existsSync(folder)).toBe(false)
  })

  test('S5: socket forget replies only after its folder is removed', async () => {
    const scans = heldRunner({ hold: true })
    const host = startHost({ processRunner: scans.runner })
    const client = await host.connect()
    await client.request('create', params('f', 'sleep 7777'))
    const folder = DIR(host.home, 'f')

    const forgetting = client.request('forget', { sessionId: 'f' })
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held socket forget scan')
    expect(await settlesWithin(forgetting, 150)).toBe(false)
    expect(existsSync(folder)).toBe(true)

    scans.release()
    expect(await forgetting).toEqual({})
    expect(existsSync(folder)).toBe(false)
  })

  test('S6: create of an id waits for that id’s pending forget before spawning', async () => {
    const scans = heldRunner({ hold: true })
    const { manager, home } = managerFor(scans.runner)
    const previous = await manager.create(params('f', 'sleep 7777'))
    const forgetting = manager.forget('f')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held create/forget scan')

    const creating = manager.create(params('f', 'sleep 7777'))
    expect(await settlesWithin(creating, 50)).toBe(false)
    scans.release()
    const created = await creating
    await forgetting
    expect(created.restored).toBe(false)
    expect(created.pid).not.toBe(previous.pid)
    expect(existsSync(DIR(home, 'f'))).toBe(true)
  })

  test('S6: create rechecks shutdown after its forget wait and spawns nothing', async () => {
    const scans = heldRunner({ hold: true })
    const { manager, home } = managerFor(scans.runner)
    await manager.create(params('f', 'sleep 7777'))
    const forgetting = manager.forget('f')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held create/shutdown scan')
    const creating = manager.create(params('f', 'sleep 7777'))
    const shuttingDown = manager.shutdown()

    scans.release()
    await expect(creating).rejects.toThrow('Terminal host is shutting down')
    await Promise.all([forgetting, shuttingDown])
    expect((await manager.list()).some((session) => session.sessionId === 'f')).toBe(false)
    expect(existsSync(DIR(home, 'f'))).toBe(false)
  })

  test('S6: only the first create waiting for a forget of the same id can spawn', async () => {
    const scans = heldRunner({ hold: true })
    const { manager } = managerFor(scans.runner)
    await manager.create(params('f', 'sleep 7777'))
    const forgetting = manager.forget('f')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held duplicate create scan')

    const first = manager.create(params('f', 'sleep 7777'))
    const second = manager.create(params('f', 'sleep 7777'))
    scans.release()
    const created = await first
    await expect(second).rejects.toThrow('session already exists: f')
    await forgetting
    expect(created.restored).toBe(false)
    expect((await manager.list()).filter((session) => session.sessionId === 'f')).toHaveLength(1)
  })

  test('S7: unknown ids and invalid signals use the same rejected errors over the socket', async () => {
    const scans = heldRunner()
    const host = startHost({ processRunner: scans.runner })
    const client = await host.connect()
    await client.request('create', params('k', 'sleep 7777'))

    await expect(client.request('kill', { sessionId: 'ghost' })).rejects.toThrow('unknown session: ghost')
    await expect(client.request('forget', { sessionId: 'ghost' })).rejects.toThrow('unknown session: ghost')
    await expect(client.request('kill', { sessionId: 'k', signal: 'SIGNOPE' })).rejects.toThrow(/signal/i)
    expect(scans.calls).toHaveLength(0)
  })

  test('S8: a root that exits during the scan is not signalled afterward', async () => {
    const scans = heldRunner({ hold: true })
    const { manager } = managerFor(scans.runner)
    const events = exitEvents(manager)
    const { pid } = await manager.create(params('k', 'sleep 7777'))
    const kills = recordProcessKillTargets()
    const killing = manager.kill('k', undefined, 'killed')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'held exiting-session scan')

    process.kill(pid, 'SIGTERM')
    await exitEvent(events, 'k')
    kills.clear()
    scans.release()
    await killing

    expect(kills.targets.some((target) => target.pid === pid || target.pid === -pid)).toBe(false)
    expect(events.find((event) => event.type === 'exit' && event.sessionId === 'k')).toMatchObject({ exitCause: 'killed' })
  })

  const failedScans: Array<{ name: string; outcome: Parameters<typeof heldRunner>[0] }> = [
    { name: 'exit-nonzero', outcome: { result: processResult('', { exitCode: 1 }) } },
    { name: 'spawn-error', outcome: { result: processResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing' } }) } },
    { name: 'timeout', outcome: { result: processResult('', { exitCode: null, stopped: 'timeout' }) } },
    { name: 'signal', outcome: { result: processResult('', { exitCode: null, signal: 'SIGKILL' }) } },
    { name: 'throws', outcome: { error: new ProcessRunnerDisposedError('test') } },
    { name: 'never-settles', outcome: { never: true } }
  ]

  for (const failure of failedScans) {
    test(`S9: ${failure.name} scan failure still kills, forgets, and stops with history`, async () => {
      const scans = heldRunner(failure.outcome)
      const { manager, home } = managerFor(scans.runner)
      const events = exitEvents(manager)

      const killed = await manager.create(params('k', 'sleep 7777'))
      await manager.kill('k', undefined, 'killed')
      expect(await exitEvent(events, 'k')).toMatchObject({ exitCause: 'killed' })
      await expectGone(killed.pid, `${failure.name} killed root`)

      const forgotten = await manager.create(params('f', 'sleep 7777'))
      await manager.forget('f')
      await expectGone(forgotten.pid, `${failure.name} forgotten root`)
      expect(existsSync(DIR(home, 'f'))).toBe(false)

      await manager.create(params('s', 'sleep 7777 & wait'))
      await manager.stopWithHistory('s')
      expect((await manager.list()).find((session) => session.sessionId === 's')).toMatchObject({
        state: 'restorable',
        exitCause: 'stopped'
      })
      if (failure.name === 'never-settles') expect(scans.calls).toHaveLength(1)
    })
  }

  for (const operation of ['kill', 'forget', 'stop'] as const) {
    test(`S10: shutdown waits for a pending ${operation} tree operation before signalling`, async () => {
      const scans = heldRunner({ hold: true })
      const { manager, home } = managerFor(scans.runner)
      const kills = recordProcessKillTargets()
      const { rootPid, childPid } = await createJob(manager, home, operation)
      const events = exitEvents(manager)
      const treeOperation = operation === 'kill'
        ? manager.kill(operation, undefined, 'killed')
        : operation === 'forget'
          ? manager.forget(operation)
          : manager.stopWithHistory(operation)
      await waitFor(() => scans.calls.length === 1 || null, 5000, 'held shutdown tree scan')

      let shutdownSettled = false
      const shutdown = manager.shutdown().then(() => { shutdownSettled = true })
      await Bun.sleep(150)
      expect(shutdownSettled).toBe(false)
      expectAlive(rootPid)
      expectAlive(childPid)
      expect(kills.targets.filter((target) => target.signal !== 0 && (target.pid === rootPid || target.pid === -rootPid))).toEqual([])

      scans.release()
      await Promise.all([treeOperation, shutdown])
      await expectGone(rootPid, `${operation} root`)
      await expectGone(childPid, `${operation} job`)
      if (operation === 'kill') {
        expect(readMeta(DIR(home, operation))).toMatchObject({ exitCause: 'killed', restorable: false })
      } else if (operation === 'forget') {
        expect(existsSync(DIR(home, operation))).toBe(false)
        const next = managerFor(scans.runner, {}, home).manager
        expect((await next.list()).some((session) => session.sessionId === operation)).toBe(false)
      } else {
        const next = managerFor(scans.runner, {}, home).manager
        expect((await next.list()).find((session) => session.sessionId === operation)).toMatchObject({
          state: 'restorable',
          exitCause: 'stopped'
        })
      }
      if (operation === 'kill') expect(await exitEvent(events, operation)).toMatchObject({ exitCause: 'killed' })
    })
  }

  test('S11: shutdown closes an unresponsive scan after its bounded drain and completes forget', async () => {
    const scans = heldRunner({ never: true })
    const { manager, home } = managerFor(scans.runner, { shutdownDrainMs: 200 })
    const { pid } = await manager.create(params('f', 'sleep 7777'))
    const forgetting = manager.forget('f')
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'never-settling forget scan')
    const shutdown = manager.shutdown()

    // Bound the real shutdown race without leaving a timer behind when it finishes promptly.
    expect(await settlesWithin(Promise.all([forgetting, shutdown]), 2000)).toBe(true)
    expect(existsSync(DIR(home, 'f'))).toBe(false)
    await expectGone(pid, 'shutdown-forgotten root')
    expect(scans.calls).toHaveLength(1)
  })

  test('S12: the manager disposes its owned runner last and permits forget afterward', async () => {
    const home = tempHome()
    const manager = new SessionManager({ home })
    trackSessionProcesses(manager, scopeForHome(home))
    onCleanup(() => manager.shutdown())
    await manager.create(params('f', 'sleep 7777'))

    await manager.shutdown()
    expect(liveProcesses().filter((process) => process.owner === 'pty-host')).toEqual([])
    await manager.forget('f')
    expect(existsSync(DIR(home, 'f'))).toBe(false)
  })

  test('S12: shutdown leaves an injected runner undisposed', async () => {
    const dispose = mock(() => Promise.resolve())
    const processRunner = { run: async () => processResult(), dispose }
    const { manager } = managerFor(processRunner)

    await manager.shutdown()
    expect(dispose).not.toHaveBeenCalled()
  })

  test('S13: stopWithHistory called after shutdown starts rejects', async () => {
    const scans = heldRunner()
    const { manager } = managerFor(scans.runner)
    const shutdown = manager.shutdown()

    await expect(manager.stopWithHistory('missing')).rejects.toThrow('Terminal host is shutting down')
    await shutdown
  })
})
