import { expect, test } from 'bun:test'
import type { RuntimeInfo } from '@quirky/protocol/node'
import { daemonStatus } from './daemon-status'

const runtime: RuntimeInfo = { pid: 37, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }

function ownedDaemon() {
  return { pid: runtime.pid, exited: new Promise<number>(() => {}) }
}

test('daemon status defaults each health probe to 300 ms', async () => {
  let probeTimeout: number | undefined
  const alive = await daemonStatus('/owned/home', ownedDaemon(), 5_000, {
    now: () => 0,
    readRuntime: () => runtime,
    isDaemonAlive: async (_runtime, timeout) => { probeTimeout = timeout; return true }
  })

  expect(alive).toBe(true)
  expect(probeTimeout).toBe(300)
})

test('daemon status uses the configured per-probe timeout', async () => {
  let probeTimeout: number | undefined
  const alive = await daemonStatus('/owned/home', ownedDaemon(), 5_000, {
    probeTimeoutMs: 250,
    now: () => 0,
    readRuntime: () => runtime,
    isDaemonAlive: async (_runtime, timeout) => { probeTimeout = timeout; return true }
  })

  expect(alive).toBe(true)
  expect(probeTimeout).toBe(250)
})

test('daemon status bounds a probe by the remaining retry deadline', async () => {
  let probeTimeout: number | undefined
  const alive = await daemonStatus('/owned/home', ownedDaemon(), 120, {
    probeTimeoutMs: 250,
    now: () => 0,
    readRuntime: () => runtime,
    isDaemonAlive: async (_runtime, timeout) => { probeTimeout = timeout; return true }
  })

  expect(alive).toBe(true)
  expect(probeTimeout).toBe(120)
})

test('daemon status rejects invalid per-probe timeouts before probing', async () => {
  const expectedError = { name: 'Error', message: 'probeTimeoutMs must be an integer from 1 to 5000' }
  for (const probeTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5001, 1.5]) {
    let probes = 0
    await expect(daemonStatus('/owned/home', ownedDaemon(), 5_000, {
      probeTimeoutMs,
      now: () => 0,
      readRuntime: () => runtime,
      isDaemonAlive: async () => { probes++; return true }
    })).rejects.toMatchObject(expectedError)
    expect(probes).toBe(0)
  }
})
