import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerRequestError, VaultWorkerClient } from '../src/worker-client'

const IDLE_WORKER_MS = 5 * 60_000
const FAILURE_TIMEOUT_MS = 5000
const RETIREMENT_GATE_ENV = 'QUIRKY_VAULT_RETIREMENT_GATE'
const workerEntrypoint = new URL('./fixtures/worker-retirement.ts', import.meta.url).href

function captureIdleTimer() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let callback: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const scheduled = originalSetTimeout(...args)
    if (args[1] === IDLE_WORKER_MS) {
      callback = args[0] as () => void
      timer = scheduled
    }
    return scheduled
  }) as typeof setTimeout

  return {
    fire() {
      if (!callback) throw new Error('idle timer was not scheduled')
      callback()
      if (timer !== undefined) originalClearTimeout(timer)
      timer = undefined
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      if (timer !== undefined) originalClearTimeout(timer)
      timer = undefined
    }
  }
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(message)), FAILURE_TIMEOUT_MS)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}


describe('vault worker idle retirement', () => {
  test('waits for idle close before issuing a queued request to one fresh worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qv-retirement-'))
    const gate = join(directory, 'release-close')
    const previousGate = process.env[RETIREMENT_GATE_ENV]
    process.env[RETIREMENT_GATE_ENV] = gate
    const closeStarted = Promise.withResolvers<void>()
    const timer = captureIdleTimer()
    const client = new VaultWorkerClient(workerEntrypoint, (event) => {
      if (event.event === 'scanProgress' && event.data.current === 'close-started') closeStarted.resolve()
    })

    try {
      const first = await within(client.request<{ workerId: string; calls: number; value: string }>('record', { value: 'first' }), 'initial worker request timed out')
      expect(first).toMatchObject({ calls: 1, value: 'first' })

      timer.fire()
      await within(closeStarted.promise, 'idle close did not start')
      const lateRequest = client.request<{ workerId: string; calls: number; value: string }>('record', { value: 'late' })
      writeFileSync(gate, 'release')

      const late = await within(lateRequest, 'request arriving during idle close was stranded')
      expect(late).toMatchObject({ calls: 1, value: 'late' })
      expect(late.workerId).not.toBe(first.workerId)
    } finally {
      writeFileSync(gate, 'release')
      try {
        await within(client.close(), 'worker cleanup timed out')
      } finally {
        timer.restore()
        if (previousGate === undefined) delete process.env[RETIREMENT_GATE_ENV]
        else process.env[RETIREMENT_GATE_ENV] = previousGate
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 15_000)

  test('shutdown rejects queued work promptly and waits for the retiring worker cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qv-retirement-shutdown-'))
    const gate = join(directory, 'release-close')
    const previousGate = process.env[RETIREMENT_GATE_ENV]
    process.env[RETIREMENT_GATE_ENV] = gate
    const closeStarted = Promise.withResolvers<void>()
    const timer = captureIdleTimer()
    const client = new VaultWorkerClient(workerEntrypoint, (event) => {
      if (event.event === 'scanProgress' && event.data.current === 'close-started') closeStarted.resolve()
    })

    try {
      await within(client.request('record', { value: 'before-shutdown' }), 'initial worker request timed out')
      timer.fire()
      await within(closeStarted.promise, 'idle close did not start')

      const queued = client.request('record', { value: 'during-shutdown' }).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      )
      let shutdownSettled = false
      const shutdown = client.close().then(() => { shutdownSettled = true })

      const outcome = await within(queued, 'shutdown did not reject queued work promptly')
      expect(outcome.status).toBe('rejected')
      const error = outcome.status === 'rejected' ? outcome.error : undefined
      expect(error).toBeInstanceOf(WorkerRequestError)
      expect(error instanceof WorkerRequestError && error.kind).toBe('worker-closed')
      expect(shutdownSettled).toBe(false)

      writeFileSync(gate, 'release')
      await within(shutdown, 'shutdown did not wait for retiring worker cleanup')
      expect(shutdownSettled).toBe(true)
    } finally {
      writeFileSync(gate, 'release')
      try {
        await within(client.close(), 'worker cleanup timed out')
      } finally {
        timer.restore()
        if (previousGate === undefined) delete process.env[RETIREMENT_GATE_ENV]
        else process.env[RETIREMENT_GATE_ENV] = previousGate
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 15_000)
})
