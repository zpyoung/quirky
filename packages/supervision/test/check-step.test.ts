import { afterEach, expect, test } from 'bun:test'
import { createSupervision } from '../src/index'
import type { CheckInput, SupervisionContext, SupervisionEngine } from '../src/index'

const engines: SupervisionEngine[] = []
type HostCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function engineFor(call: HostCall): SupervisionEngine {
  const engine = createSupervision({ call } as unknown as SupervisionContext)
  engines.push(engine)
  return engine
}

async function rejectWith(promise: Promise<unknown>, expected: Record<string, unknown>) {
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (error) {
    expect(error).toMatchObject(expected)
    return error
  }
}

const input: CheckInput = {
  checkId: 'loop-1:2:1', command: 'pnpm test --filter unit', cwd: '/worktrees/w1', timeoutSeconds: 90
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

test('runCheck forwards the operation identity and returns raw check evidence', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const evidence = { checkId: input.checkId, ran: true, exitCode: 0, pass: false, output: 'raw provider evidence' }
  const engine = engineFor(async (method, params) => { calls.push({ method, params }); return evidence })

  expect(await engine.runCheck(input)).toEqual(evidence)
  expect(calls).toEqual([{
    method: 'quirky.checks/run',
    params: { checkId: 'loop-1:2:1', command: 'pnpm test --filter unit', cwd: '/worktrees/w1', timeoutSeconds: 90 }
  }])
})

test('abort, explicit cancellation, and repeated disposal coalesce for one active operation', async () => {
  const runReply = deferred<unknown>()
  const cancelReply = deferred<unknown>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const controller = new AbortController()
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.checks/run') return runReply.promise
    if (method === 'quirky.checks/cancel') return cancelReply.promise
    throw new Error(`unexpected RPC ${method}`)
  })

  const running = engine.runCheck(input, { signal: controller.signal })
  void running.catch(() => undefined)
  await flush()
  expect(calls).toEqual([{ method: 'quirky.checks/run', params: {
    checkId: 'loop-1:2:1', command: input.command, cwd: input.cwd, timeoutSeconds: input.timeoutSeconds
  } }])

  controller.abort()
  await flush()
  expect(calls.filter((call) => call.method === 'quirky.checks/cancel')).toEqual([
    { method: 'quirky.checks/cancel', params: { checkId: 'loop-1:2:1' } }
  ])
  engine.dispose()
  engine.dispose()
  const explicitCancellation = engine.cancelCheck('loop-1:2:1')
  await flush()
  expect(calls.filter((call) => call.method === 'quirky.checks/cancel')).toHaveLength(1)

  cancelReply.resolve({ cancelled: true })
  await explicitCancellation
  runReply.resolve({ checkId: input.checkId, ran: true, aborted: true })
  await flush()
})

test('abort before runCheck starts issues neither a run nor a cancellation request', async () => {
  const calls: string[] = []
  const engine = engineFor(async (method) => { calls.push(method); return {} })
  const controller = new AbortController()
  controller.abort()

  await rejectWith(engine.runCheck(input, { signal: controller.signal }), { name: 'AbortError' })
  expect(calls).toEqual([])
})

test('settled check IDs can be reused and disposal does not cancel settled operations', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const evidence = { pass: true, exitCode: 0 }
  const engine = engineFor(async (method, params) => { calls.push({ method, params }); return evidence })
  const reusable = { ...input, checkId: 'run-1' }

  expect(await engine.runCheck(reusable)).toEqual(evidence)
  expect(await engine.runCheck(reusable)).toEqual(evidence)
  engine.dispose()
  await flush()
  expect(calls.filter((call) => call.method === 'quirky.checks/run')).toHaveLength(2)
  expect(calls.filter((call) => call.method === 'quirky.checks/cancel')).toEqual([])
  expect(calls.map((call) => call.params?.checkId)).toEqual(['run-1', 'run-1'])
})

test('concurrent duplicate check IDs reject before a second run RPC', async () => {
  const held = deferred<unknown>()
  const calls: string[] = []
  const engine = engineFor(async (method) => {
    calls.push(method)
    return held.promise
  })
  const first = engine.runCheck(input)
  await flush()
  await rejectWith(engine.runCheck(input), { code: 'duplicate-check' })
  expect(calls).toEqual(['quirky.checks/run'])
  held.resolve({ checkId: input.checkId, ran: false })
  await first
})

test('runCheck preserves transport failures for supervisor-specific normalization', async () => {
  const failure = Object.assign(new Error('check launch failed'), { code: 'conflict', data: { reason: 'shutting-down' } })
  const calls: string[] = []
  const engine = engineFor(async (method) => { calls.push(method); throw failure })

  await expect(engine.runCheck(input)).rejects.toBe(failure)
  expect(calls).toEqual(['quirky.checks/run'])
})
