import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient, PluginContext } from '@quirky/protocol'
import { faultPlan, installFaultPlugin, startFault } from './faults.ts'
import { activate } from './faults/main.ts'

test('spreads eighty leaks over the first sixty percent of a short or long run', () => {
  expect(faultPlan('leak', 24)).toEqual({ kind: 'leak', count: 80, everyMs: 180, lifetimeSeconds: 54 })
  expect(faultPlan('leak', 1800)).toEqual({ kind: 'leak', count: 80, everyMs: 13500, lifetimeSeconds: 1830 })
})

test('bounds the leak interval and lifetime on extreme run lengths', () => {
  expect(faultPlan('leak', 200_000)).toEqual({ kind: 'leak', count: 80, everyMs: 60_000, lifetimeSeconds: 86_400 })
  expect(faultPlan('leak', 0.01)).toEqual({ kind: 'leak', count: 80, everyMs: 10, lifetimeSeconds: 31 })
})

test('plans zombie holders, a bounded refresh loop, and a synchronous stall', () => {
  expect(faultPlan('zombies', 24)).toEqual({ kind: 'zombies', holders: 2, each: 5, lifetimeSeconds: 54 })
  expect(faultPlan('storm', 24)).toEqual({ kind: 'storm', seconds: 10 })
  expect(faultPlan('block', 24)).toEqual({ kind: 'block', ms: 3000 })
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
  const fault = startFault({ kind: 'block', home: '/unused', control, runSeconds: 24, startedAt: performance.now(), signal: abort.signal })
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
  const fault = startFault({ kind: 'block', home: '/unused', control, runSeconds: 24, startedAt: performance.now() - 2100, signal: new AbortController().signal })
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
    const fault = startFault({ kind: 'block', home: '/unused', control, runSeconds: 24, startedAt: performance.now() - 2100, signal: abort.signal })
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
