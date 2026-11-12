import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionLost, RpcError, RpcErrorCode, type CallOptions } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, runtimeFilePath } from '@quirky/protocol/node'
import { ConnectionLostError, createDaemonLink, DaemonUnavailableError, type RpcLinkClient } from '../src/link'
import { createDaemonRestart } from '../src/commands/daemon'
import { parseArgs } from '../src/args'
import type { Context } from '../src/commands/types'
import { Printer } from '../src/output'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { runCli } from './fixtures/fake-daemon'

const STAND_IN = join(import.meta.dir, 'fixtures', 'stand-in-daemon.ts')
const NEW_DAEMON_ENTRY = join(import.meta.dir, 'fixtures', 'fake-daemon-entry.ts')
const REQUEST_MS = 200
const STOP_MS = 300
const KILL_MS = 2_000

const never = () => Promise.withResolvers<unknown>().promise

let scope: ProcessScope

beforeEach(() => {
  scope = createProcessScope()
})

afterEach(async () => {
  const startedPath = join(scope.home, 'started.json')
  if (existsSync(startedPath)) {
    const started = JSON.parse(readFileSync(startedPath, 'utf8')) as { pid: number }
    scope.track(started.pid)
  }
  await scope.cleanup()
})

async function startStandIn(mode: string) {
  // The stand-in is a real process, so startup must be observed through runtime health.
  const child = scope.spawn([process.execPath, STAND_IN, mode], { stdout: 'ignore', stderr: 'ignore' })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const runtime = readRuntime(scope.home)
    if (runtime && (await isDaemonAlive(runtime, 100))) return { pid: runtime.pid, child }
    await Bun.sleep(20)
  }
  throw new Error(`stand-in daemon did not become healthy in ${scope.home}`)
}

function calls(): string[] {
  const path = join(scope.home, 'calls.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : []
}

function signals(): string[] {
  const path = join(scope.home, 'signals.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : []
}

function startedDaemon(): { pid: number; args: string[] } {
  return JSON.parse(readFileSync(join(scope.home, 'started.json'), 'utf8')) as { pid: number; args: string[] }
}

async function waitForExit(standIn: { pid: number; child: { exited: Promise<number> } }): Promise<void> {
  await standIn.child.exited
  if (processIsAlive(standIn.pid)) throw new Error(`process ${standIn.pid} is still alive`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}


async function runCliRestart(argv: string[] = []) {
  return runCli(['daemon', 'restart', ...argv], {
    home: scope.home,
    env: { QUIRKY_DAEMON_ENTRY: NEW_DAEMON_ENTRY }
  })
}

type RpcCall = (method: string, params: Record<string, unknown>, options?: CallOptions) => Promise<unknown>

function makeContext(
  call: RpcCall,
  options: { json?: boolean; events?: string[]; onClose?: () => void } = {}
): { ctx: Context; stdout(): string; events: string[] } {
  let output = ''
  const events = options.events ?? []
  const rpc = {
    requestBase: 'restart-test',
    call,
    callAny: call,
    reconnect: async () => {},
    close() {
      events.push('close')
      options.onClose?.()
    }
  }
  const writer = { stdout: (text: string) => { output += text }, stderr: () => {} }
  const ctx: Context = {
    rpc: rpc as unknown as Context['rpc'],
    requestBase: 'restart-test',
    out: new Printer(writer, options.json ?? false),
    env: { QUIRKY_HOME: scope.home },
    cwd: scope.home,
    readFile: () => '',
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    openDesktopApp: async () => ({ ok: false, reason: 'not available in this test' })
  }
  return { ctx, stdout: () => output, events }
}

async function invokeRestart(
  ctx: Context,
  argv: string[] = [],
  timings?: { requestMs?: number; stopMs?: number; killMs?: number }
): Promise<void> {
  const command = createDaemonRestart(timings)
  const args = parseArgs(argv, command.flags, command.name)
  const previousEntry = process.env.QUIRKY_DAEMON_ENTRY
  process.env.QUIRKY_DAEMON_ENTRY = NEW_DAEMON_ENTRY
  try {
    await command.run(args, ctx)
  } finally {
    if (previousEntry === undefined) delete process.env.QUIRKY_DAEMON_ENTRY
    else process.env.QUIRKY_DAEMON_ENTRY = previousEntry
  }
}

function observeSignals(pid: number, events: string[], denyKill = false): () => void {
  const original = process.kill
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
      events.push(`signal:${signal}`)
      if (denyKill && signal === 'SIGKILL') {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
    }
    return original.call(process, target, signal)
  }) as typeof process.kill
  return () => { process.kill = original }
}

function writeRuntimePid(pid: unknown): void {
  writeFileSync(runtimeFilePath(scope.home), JSON.stringify({ pid, port: 1, token: 'test-token' }))
}

describe('daemon restart process boundaries', () => {
  test('K6: stops cleanly, reports JSON status, and starts the configured daemon', async () => {
    const old = await startStandIn('exit-on-stop')
    const result = await runCliRestart(['--json'])
    const started = startedDaemon()

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ pid: started.pid, stopped: 'clean' })
    expect(calls()).toEqual(['client.hello', 'daemon.stop'])
    await waitForExit(old)
  }, 30_000)

  test('K6: keeps the human result ending at the new pid', async () => {
    const old = await startStandIn('exit-on-stop')
    const result = await runCliRestart()
    const started = startedDaemon()

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`restarted quirkyd (pid ${started.pid})\n`)
    expect(calls()).toEqual(['client.hello', 'daemon.stop'])
    await waitForExit(old)
  }, 30_000)

  test('K6: starts the replacement in safe mode when requested', async () => {
    const old = await startStandIn('exit-on-stop')
    const result = await runCliRestart(['--disable-plugins'])
    const started = startedDaemon()

    expect(result.code).toBe(0)
    expect(started.args).toEqual(['--disable-plugins'])
    expect(calls()).toEqual(['client.hello', 'daemon.stop'])
    await waitForExit(old)
  }, 30_000)

  test('K7: a silent handshake is bounded, then the old process is terminated', async () => {
    const old = await startStandIn('silent-hello')
    const result = await runCliRestart()
    const started = startedDaemon()

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      `restarted quirkyd (pid ${started.pid}); the old daemon (pid ${old.pid}) did not answer daemon.stop within 5s and was sent SIGTERM\n`
    )
    expect(calls()).toEqual(['client.hello'])
    await waitForExit(old)
  }, 30_000)

  test('K8: an unanswered stop request is bounded, then the old process is terminated', async () => {
    const old = await startStandIn('silent-stop')
    const result = await runCliRestart()
    const started = startedDaemon()

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      `restarted quirkyd (pid ${started.pid}); the old daemon (pid ${old.pid}) did not answer daemon.stop within 5s and was sent SIGTERM\n`
    )
    expect(calls()).toEqual(['client.hello', 'daemon.stop'])
    await waitForExit(old)
  }, 30_000)

  test('K9: one request deadline covers a never-settling connect and closes before signalling', async () => {
    const old = await startStandIn('exit-on-term')
    const events: string[] = []
    const callsMade: { method: string; params: Record<string, unknown>; options?: CallOptions }[] = []
    const context = makeContext((method, params, options) => {
      callsMade.push({ method, params, options })
      return never()
    }, { events })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(callsMade).toEqual([{ method: 'daemon.stop', params: {}, options: { timeoutMs: REQUEST_MS } }])
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGTERM'))
    expect(context.stdout()).toContain(`did not answer daemon.stop within 0.2s and was sent SIGTERM`)
    await waitForExit(old)
    expect(startedDaemon().pid).not.toBe(old.pid)
  }, 10_000)

  test('K10: kills an unanswered daemon that ignores SIGTERM', async () => {
    const old = await startStandIn('ignore-term')
    const events: string[] = []
    const context = makeContext(() => never(), { events })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(context.stdout()).toContain(
      `the old daemon (pid ${old.pid}) did not stop within 0.3s and was killed`
    )
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGTERM'))
    expect(events).toContain('signal:SIGKILL')
    await waitForExit(old)
    expect(startedDaemon().pid).not.toBe(old.pid)
  }, 10_000)

  test('K11: a dropped connection waits for the process without sending a signal', async () => {
    const old = await startStandIn('exit-on-control')
    const events: string[] = []
    const context = makeContext(async () => {
      writeFileSync(join(scope.home, 'exit-now'), 'exit')
      throw new ConnectionLostError('restart-test')
    }, { events, json: true })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(JSON.parse(context.stdout()).stopped).toBe('clean')
    expect(events).not.toContain('signal:SIGTERM')
    expect(events).not.toContain('signal:SIGKILL')
    await waitForExit(old)
    expect(startedDaemon().pid).not.toBe(old.pid)
  }, 10_000)

  test('K12: a daemon unavailable error is treated as unanswered while health is live', async () => {
    const old = await startStandIn('exit-on-term')
    const events: string[] = []
    const context = makeContext(async () => { throw new DaemonUnavailableError('socket unavailable') }, { events })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(context.stdout()).toContain(`did not answer daemon.stop within 0.2s and was sent SIGTERM`)
    expect(signals()).toEqual(['SIGTERM'])
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGTERM'))
    await waitForExit(old)
  }, 10_000)

  test('K13: kills a daemon that answered stop but kept running', async () => {
    const old = await startStandIn('ignore-term')
    const events: string[] = []
    const context = makeContext(async () => ({ ok: true }), { events })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(context.stdout()).toContain(
      `the old daemon (pid ${old.pid}) did not stop within 0.3s and was killed`
    )
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGKILL'))
    await waitForExit(old)
  }, 10_000)

  test('K14: reports an unkillable daemon and does not start a replacement', async () => {
    const old = await startStandIn('ignore-term')
    const events: string[] = []
    const context = makeContext(() => never(), { events })
    const restoreSignals = observeSignals(old.pid, events, true)
    try {
      await expect(
        invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
      ).rejects.toThrow(`quirkyd (pid ${old.pid}) did not stop within 0.3s and could not be killed`)
    } finally {
      restoreSignals()
    }

    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGTERM'))
    expect(existsSync(join(scope.home, 'started.json'))).toBe(false)
    expect(processIsAlive(old.pid)).toBe(true)
  }, 10_000)

  test('K15: fails on an unrelated RPC error without signalling or starting a daemon', async () => {
    const old = await startStandIn('exit-on-term')
    const events: string[] = []
    const context = makeContext(async () => {
      throw new RpcError(RpcErrorCode.Unauthorized, 'not authorized')
    }, { events })

    await expect(invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS }))
      .rejects.toThrow('not authorized')
    expect(events).toEqual(['close'])
    expect(signals()).toEqual([])
    expect(existsSync(join(scope.home, 'started.json'))).toBe(false)
    expect(processIsAlive(old.pid)).toBe(true)
  }, 10_000)

  test('K16: reports not-running without calling daemon.stop', async () => {
    const context = makeContext(async (method) => { throw new Error(`unexpected RPC ${method}`) })
    await invokeRestart(context.ctx, [])

    expect(context.stdout()).toContain('the old daemon was not running')
    expect(startedDaemon().pid).toBeGreaterThan(0)
  })

  test('K17: closes the link before signalling and before starting a replacement', async () => {
    const old = await startStandIn('exit-on-term')
    const events: string[] = []
    const context = makeContext(() => never(), {
      events,
      onClose: () => writeFileSync(join(scope.home, 'link-closed'), String(Date.now()))
    })
    const restoreSignals = observeSignals(old.pid, events)
    try {
      await invokeRestart(context.ctx, [], { requestMs: REQUEST_MS, stopMs: STOP_MS, killMs: KILL_MS })
    } finally {
      restoreSignals()
    }

    expect(events.indexOf('close')).toBeLessThan(events.indexOf('signal:SIGTERM'))
    expect(existsSync(join(scope.home, 'link-closed'))).toBe(true)
    expect(startedDaemon().pid).not.toBe(old.pid)
  }, 10_000)

  test('refuses the caller pid before sending daemon.stop or starting a replacement', async () => {
    writeRuntimePid(process.pid)
    let callsMade = 0
    const context = makeContext(async () => { callsMade++; return { ok: true } })

    await expect(invokeRestart(context.ctx)).rejects.toThrow(`refusing to signal this process (pid ${process.pid})`)
    expect(callsMade).toBe(0)
    expect(existsSync(join(scope.home, 'started.json'))).toBe(false)
  })

  test('refuses an invalid runtime pid before sending daemon.stop or starting a replacement', async () => {
    writeRuntimePid('123')
    let callsMade = 0
    const context = makeContext(async () => { callsMade++; return { ok: true } })

    await expect(invokeRestart(context.ctx)).rejects.toThrow('invalid daemon pid')
    expect(callsMade).toBe(0)
    expect(existsSync(join(scope.home, 'started.json'))).toBe(false)
  })
})

describe('K18: closing a daemon link prevents late sends', () => {
  test('rejects a call after its initial connection arrives late and closes that client', async () => {
    let callCount = 0
    let closeCount = 0
    const client: RpcLinkClient = {
      callAny: async () => { callCount++; return { ok: true } },
      close: () => { closeCount++ }
    }
    // This exercises the real race between link.close() and a delayed transport connection.
    const pendingClient = Promise.withResolvers<RpcLinkClient>()
    const link = createDaemonLink(() => {
      setTimeout(() => pendingClient.resolve(client), 100)
      return pendingClient.promise
    })
    const call = link.callAny('daemon.stop', {})
    await Bun.sleep(10)
    link.close()

    await expect(call).rejects.toThrow('daemon link is closed')
    expect(callCount).toBe(0)
    expect(closeCount).toBeGreaterThan(0)
  })

  test('rejects a call whose reconnect arrives after close without using the late client', async () => {
    const reconnectStarted = Promise.withResolvers<void>()
    const lateConnection = Promise.withResolvers<RpcLinkClient>()
    let connections = 0
    let initialCalls = 0
    let reconnectCalls = 0
    let lateCloseCount = 0
    const initial: RpcLinkClient = {
      callAny: async () => { initialCalls++; throw new ConnectionLost('dropped') },
      close: () => {}
    }
    const late: RpcLinkClient = {
      callAny: async () => { reconnectCalls++; return { ok: true } },
      close: () => { lateCloseCount++ }
    }
    const link = createDaemonLink(() => {
      connections++
      if (connections === 1) return Promise.resolve(initial)
      reconnectStarted.resolve()
      return lateConnection.promise
    }, { requestBase: 'restart-test' })
    const call = link.callAny('status.get', {})
    await reconnectStarted.promise
    link.close()
    lateConnection.resolve(late)

    await expect(call).rejects.toThrow('daemon link is closed')
    expect(initialCalls).toBe(1)
    expect(reconnectCalls).toBe(0)
    expect(lateCloseCount).toBeGreaterThan(0)
  })

  test('does not send an answer after the confirmation wait reconnects late', async () => {
    const initialRequest = Promise.withResolvers<unknown>()
    const lateConnection = Promise.withResolvers<RpcLinkClient>()
    const reconnectStarted = Promise.withResolvers<void>()
    let lateCalls = 0
    let lateCloseCount = 0
    const initial: RpcLinkClient = {
      callAny: () => initialRequest.promise,
      close: () => {}
    }
    const late: RpcLinkClient = {
      callAny: async () => { lateCalls++; return { status: 'answered', askId: 'ask-1', answers: {}, skipped: [] } },
      close: () => { lateCloseCount++ }
    }
    let connections = 0
    const link = createDaemonLink(() => {
      connections++
      if (connections === 1) return Promise.resolve(initial)
      reconnectStarted.resolve()
      return lateConnection.promise
    }, { requestBase: 'restart-test' })
    const call = link.callAny('acme.dangerous', {})
    const reconnect = link.reconnect().catch(() => {})
    await reconnectStarted.promise
    initialRequest.reject(
      new RpcError(RpcErrorCode.ConfirmationRequired, 'confirmation required', { askId: 'ask-1', action: 'run' })
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    link.close()
    lateConnection.resolve(late)

    await expect(call).rejects.toThrow('daemon link is closed')
    await reconnect
    expect(lateCalls).toBe(0)
    expect(lateCloseCount).toBeGreaterThan(0)
  })
})
