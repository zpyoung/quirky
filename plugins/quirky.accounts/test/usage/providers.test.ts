import { describe, expect, jest, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess } from '@quirky/protocol'
import { ProviderProcessOwner, createProviderRuntime, type ProviderRuntime } from '../../src/usage/process'
import { fetchCodexUsage } from '../../src/usage/codex-adapter'
import type { UsageTarget } from '../../src/usage/types'
import {
  mapAntigravityUsage,
  mapClaudeUsage,
  mapCodexUsage,
  mapCursorUsage,
  mapGeminiUsage,
  mapGrokUsage,
  mapKimiUsage,
  mapMiniMaxUsage,
  mapOpenCodeGoUsage,
  mapZcodeUsage
} from '../../src/usage/mappers'

const now = Date.parse('2026-10-27T12:00:00.000Z')
const resetSeconds = Math.floor((now + 3_600_000) / 1000)
const resetIso = new Date(now + 3_600_000).toISOString()

const timerControls = jest as unknown as {
  useFakeTimers(): void
  advanceTimersByTime(milliseconds: number): void
  useRealTimers(): void
}

function percent(window: { usedPercent: number } | null | undefined): number | null {
  return window?.usedPercent ?? null
}

describe('provider usage mapping', () => {
  test('maps all ten providers to bounded windows and provider-specific metadata', () => {
    const claude = mapClaudeUsage({
      five_hour: { utilization: 104, resets_at: resetIso },
      seven_day: { used_percentage: 25, resets_at: resetSeconds },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 17,
          resets_at: resetIso,
          scope: { model: { display_name: 'Fable' } }
        }
      ]
    }, now)
    expect(percent(claude.session)).toBe(100)
    expect(claude.session?.windowMinutes).toBe(300)
    expect(claude.weekly?.resetsAt).toBe(now + 3_600_000)
    expect(percent(claude.fableWeekly)).toBe(17)

    const codex = mapCodexUsage({
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: resetSeconds },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: resetSeconds },
      planType: 'plus',
      rateLimitResetCredits: {
        availableCount: 1,
        totalEarnedCount: 3,
        credits: [{ status: 'available', expiresAt: resetSeconds, grantedAt: resetSeconds - 100 }]
      }
    }, now)
    expect(percent(codex.session)).toBe(31)
    expect(percent(codex.weekly)).toBe(12)
    expect(codex.planType).toBe('plus')
    expect(codex.rateLimitResetCredits?.availableCount).toBe(1)
    expect(codex.rateLimitResetCredits?.credits?.[0]?.expiresAt).toBe(now + 3_600_000)

    const gemini = mapGeminiUsage(
      [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.35, resetTime: resetIso }],
      now
    )
    expect(percent(gemini.session)).toBe(65)
    expect(gemini.buckets?.[0]).toMatchObject({ name: 'Pro', windowMinutes: 60 })
    expect(gemini.buckets?.[0]?.resetsAt).toBe(now + 3_600_000)

    const antigravity = mapAntigravityUsage(
      {
        status: 'SUCCESS',
        command: {
          name: 'usage',
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.4, reset_time: resetIso },
                  { id: 'gemini-5h', name: '5 Hour Limit', window: '5h', remaining_fraction: 0.75, reset_time: resetIso }
                ]
              }
            ]
          }
        }
      },
      now
    )
    expect(percent(antigravity.weekly)).toBe(60)
    expect(percent(antigravity.session)).toBe(25)
    expect(antigravity.buckets?.[0]?.group).toBe('Gemini Models')

    const opencode = mapOpenCodeGoUsage({
      usage: {
        rolling: { percent: 24, resetsAt: resetIso },
        weekly: { percent: 45, resetsAt: resetIso },
        monthly: { percent: 11, resetsAt: resetIso }
      }
    }, now)
    expect(percent(opencode.session)).toBe(24)
    expect(percent(opencode.weekly)).toBe(45)
    expect(percent(opencode.monthly)).toBe(11)

    const kimi = mapKimiUsage({
      usage: { limit: '100', used: '35', resetTime: resetIso },
      limits: [{ window: { duration: 5, timeUnit: 'HOUR' }, detail: { limit: 20, used: 5, resetAt: resetIso } }]
    }, now)
    expect(percent(kimi.weekly)).toBe(35)
    expect(percent(kimi.session)).toBe(25)
    expect(kimi.session?.windowMinutes).toBe(300)

    const minimax = mapMiniMaxUsage({
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 72,
          start_time: now,
          end_time: now + 3_600_000,
          current_weekly_remaining_percent: 80,
          weekly_remains_time: 604_800_000
        }
      ]
    }, ['general'], now)
    expect(percent(minimax.session)).toBe(28)
    expect(percent(minimax.weekly)).toBe(20)

    const grok = mapGrokUsage({
      creditUsagePercent: 34,
      currentPeriod: { end: resetIso },
      monthlyLimit: { val: 100 },
      used: { val: 40 },
      subscriptionTier: 'super'
    }, now)
    expect(percent(grok.weekly)).toBe(34)
    expect(percent(grok.monthly)).toBe(40)
    expect(grok.planType).toBe('super')

    const cursor = mapCursorUsage({
      billingCycleStart: new Date(now).toISOString(),
      billingCycleEnd: resetIso,
      membershipType: 'pro',
      individualUsage: {
        plan: { enabled: true, autoPercentUsed: 42, apiPercentUsed: 18, totalPercentUsed: 44 },
        onDemand: { enabled: true, used: 2, limit: 10 }
      }
    }, now)
    expect(percent(cursor.monthly)).toBe(44)
    expect(cursor.monthly?.windowMinutes).toBe(60)
    expect(cursor.buckets?.map((bucket) => bucket.name)).toEqual(['Cursor Models', 'Other Models', 'On-demand'])
    expect(cursor.planType).toBe('pro')

    const zcode = mapZcodeUsage({
      success: true,
      code: 200,
      data: {
        level: 'GLM Coding Plan',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 100, currentValue: 27, nextResetTime: now + 3_600_000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 50, nextResetTime: now + 30 * 86_400_000 }
        ]
      }
    }, now)
    expect(percent(zcode.weekly)).toBe(27)
    expect(percent(zcode.monthly)).toBe(50)
    expect(zcode.planType).toBe('GLM Coding Plan')
  })

  test('rejects malformed provider payloads instead of inventing zero usage', () => {
    expect(mapClaudeUsage({ five_hour: { utilization: Number.NaN } }, now).session).toBeNull()
    expect(mapGeminiUsage({ buckets: [{ modelId: 'pro', remainingFraction: Number.NaN, resetTime: 'bad' }] }, now).buckets).toEqual([])
    expect(mapAntigravityUsage({ status: 'SUCCESS' }, now).status).not.toBe('ok')
    expect(mapMiniMaxUsage({ model_remains: [] }, ['general'], now).status).not.toBe('ok')
  })
})
type CodexTestProcess = {
  handle: SpawnedProcess
  writes: string[]
  stopCalls: Array<{ graceMs?: number }>
  closeInputCalls: number
  enqueue(bytes: Uint8Array): void
  error(error: Error): void
  complete(exit?: Partial<SpawnExit>): SpawnExit
}

function codexTestProcess(options: {
  onWrite?: (line: string) => void
  writeResult?: Promise<boolean>
  closeInputResult?: Promise<void>
} = {}): CodexTestProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stdoutEnded = false
  let exit: SpawnExit | undefined
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<SpawnExit>()
  const writes: string[] = []
  const stopCalls: Array<{ graceMs?: number }> = []
  let closeInputCalls = 0
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller }
  })
  const complete = (result: Partial<SpawnExit> = {}): SpawnExit => {
    if (!exit) {
      exit = { exitCode: 0, signal: null, durationMs: 0, ...result }
      resolveExited(exit)
    }
    if (!stdoutEnded) {
      stdoutEnded = true
      stdoutController.close()
    }
    return exit
  }
  const handle: SpawnedProcess = {
    pid: 17,
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderrTail: () => '',
    write: (data) => {
      const line = typeof data === 'string' ? data : new TextDecoder().decode(data)
      writes.push(line)
      options.onWrite?.(line)
      return options.writeResult ?? Promise.resolve(true)
    },
    closeInput: () => {
      closeInputCalls += 1
      return options.closeInputResult ?? Promise.resolve()
    },
    exited,
    stop: (stopOptions) => {
      stopCalls.push({ graceMs: stopOptions?.graceMs })
      complete({ exitCode: null, signal: 'SIGTERM', stopped: 'stop' })
      return exited
    }
  }
  return {
    handle,
    writes,
    stopCalls,
    get closeInputCalls() { return closeInputCalls },
    enqueue: (bytes) => stdoutController.enqueue(bytes),
    error: (error) => {
      stdoutEnded = true
      stdoutController.error(error)
    },
    complete
  }
}

function codexFixture(): { root: string; target: UsageTarget & { home: string } } {
  const root = mkdtempSync(join(tmpdir(), 'quirky-codex-provider-test-'))
  const home = join(root, 'codex')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token' } }), { mode: 0o600 })
  return {
    root,
    target: { provider: 'codex', accountId: 'codex-a', home, active: true, label: 'Codex', revision: 1 }
  }
}

function codexRuntime(process: CodexTestProcess, signal = new AbortController().signal): {
  runtime: ProviderRuntime
  calls: Array<{ argv: readonly string[]; options: SpawnOptions }>
} {
  const calls: Array<{ argv: readonly string[]; options: SpawnOptions }> = []
  const spawner: ProcessSpawner = {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return process.handle
    }
  }
  const runtime = createProviderRuntime(new ProviderProcessOwner(spawner), signal)
  runtime.fetch = async () => { throw new Error('network access disabled in this fixture') }
  return { runtime, calls }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await yieldToEventLoop()
  if (!predicate()) throw new Error('The Codex fixture did not reach the expected state')
}

function jsonLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

function rateLimitsResponse(): Uint8Array {
  return jsonLine({
    jsonrpc: '2.0',
    id: 2,
    result: {
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: resetSeconds },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: resetSeconds },
      planType: 'plus',
      rateLimitResetCredits: {
        availableCount: 1,
        totalEarnedCount: 1,
        credits: [{ status: 'available', expiresAt: resetSeconds, grantedAt: resetSeconds - 60 }]
      }
    }
  })
}

describe('Codex App Server usage', () => {
  test('performs the JSON-RPC handshake with chunked frames and unawaited input writes', async () => {
    const fixture = codexFixture()
    const neverWrite = Promise.withResolvers<boolean>().promise
    const neverClose = Promise.withResolvers<void>().promise
    let process!: CodexTestProcess
    process = codexTestProcess({
      writeResult: neverWrite,
      closeInputResult: neverClose,
      onWrite: (line) => {
        const request = JSON.parse(line) as { id?: number }
        if (request.id === 1) {
          const frame = jsonLine({ jsonrpc: '2.0', id: 1, result: {} })
          process.enqueue(frame.subarray(0, 9))
          process.enqueue(frame.subarray(9))
        } else if (request.id === 2) {
          const frame = rateLimitsResponse()
          process.enqueue(frame.subarray(0, 17))
          process.enqueue(frame.subarray(17))
        }
      }
    })
    const { runtime, calls } = codexRuntime(process)

    const sentinelName = 'QUIRKY_CODEX_USAGE_TEST_SENTINEL'
    const sentinelValue = 'safe-environment-sentinel'
    const previousSentinel = globalThis.process.env[sentinelName]
    globalThis.process.env[sentinelName] = sentinelValue
    const expectedEnvironment = { ...globalThis.process.env, CODEX_HOME: fixture.target.home }
    try {
      const snapshot = await fetchCodexUsage(runtime, fixture.target)
      expect(snapshot.status).toBe('ok')
      expect(process.writes.map((line) => JSON.parse(line))).toEqual([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'orca', version: '1.0.0' } } },
        { jsonrpc: '2.0', method: 'initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }
      ])
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      const { env: forwardedEnvironment, ...optionsWithoutEnvironment } = call.options
      expect({ argv: call.argv, options: optionsWithoutEnvironment }).toEqual({
        argv: ['codex', '-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'],
        options: {
          cwd: fixture.target.home,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
          timeoutMs: null,
          killGraceMs: 1_000,
          signal: runtime.signal
        }
      })
      expect(forwardedEnvironment !== globalThis.process.env).toBe(true)
      expect(forwardedEnvironment?.CODEX_HOME).toBe(fixture.target.home)
      expect(forwardedEnvironment?.[sentinelName]).toBe(sentinelValue)
      expect(
        forwardedEnvironment !== undefined &&
          Object.keys(forwardedEnvironment).length === Object.keys(expectedEnvironment).length &&
          Object.entries(expectedEnvironment).every(([key, value]) => forwardedEnvironment[key] === value)
      ).toBe(true)
      expect(process.closeInputCalls).toBe(1)
      expect(process.stopCalls).toEqual([{ graceMs: 1_000 }])
    } finally {
      if (previousSentinel === undefined) delete globalThis.process.env[sentinelName]
      else globalThis.process.env[sentinelName] = previousSentinel
      await runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test('times out initialization after thirty seconds even when stdin writes never settle', async () => {
    const fixture = codexFixture()
    const process = codexTestProcess({ writeResult: Promise.withResolvers<boolean>().promise })
    const { runtime, calls } = codexRuntime(process)
    timerControls.useFakeTimers()
    try {
      const resultPromise = fetchCodexUsage(runtime, fixture.target)
      await waitUntil(() => calls.length === 1)
      timerControls.advanceTimersByTime(29_999)
      await Promise.resolve()
      timerControls.advanceTimersByTime(1)
      const snapshot = await resultPromise
      expect(snapshot.error).toBe('Codex App Server initialization timed out')
      expect(process.stopCalls).toEqual([{ graceMs: 1_000 }])
    } finally {
      timerControls.useRealTimers()
      await runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test('starts the ten-second read timeout after initialization', async () => {
    const fixture = codexFixture()
    let process!: CodexTestProcess
    process = codexTestProcess({
      writeResult: Promise.withResolvers<boolean>().promise,
      onWrite: (line) => {
        const request = JSON.parse(line) as { id?: number }
        if (request.id === 1) process.enqueue(jsonLine({ jsonrpc: '2.0', id: 1, result: {} }))
      }
    })
    const { runtime, calls } = codexRuntime(process)
    timerControls.useFakeTimers()
    try {
      const resultPromise = fetchCodexUsage(runtime, fixture.target)
      await waitUntil(() => calls.length === 1 && process.writes.some((line) => JSON.parse(line).id === 2))
      timerControls.advanceTimersByTime(9_999)
      await Promise.resolve()
      timerControls.advanceTimersByTime(1)
      const snapshot = await resultPromise
      expect(snapshot.error).toBe('Codex rate limit request timed out')
      expect(process.stopCalls).toEqual([{ graceMs: 1_000 }])
    } finally {
      timerControls.useRealTimers()
      await runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test('fails closed when stdout exceeds the raw-byte cap', async () => {
    const fixture = codexFixture()
    const process = codexTestProcess()
    const { runtime, calls } = codexRuntime(process)
    try {
      const resultPromise = fetchCodexUsage(runtime, fixture.target)
      await waitUntil(() => calls.length === 1)
      process.enqueue(new Uint8Array(524_289).fill(0x20))
      const snapshot = await resultPromise
      expect(snapshot.error).toBe('Codex App Server response was too large')
      expect(process.stopCalls).toEqual([{ graceMs: 1_000 }])
    } finally {
      await runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test('fails closed on stdout errors and spawn errors', async () => {
    const fixture = codexFixture()
    const failedStream = codexTestProcess()
    const streamRuntime = codexRuntime(failedStream)
    try {
      const resultPromise = fetchCodexUsage(streamRuntime.runtime, fixture.target)
      await waitUntil(() => streamRuntime.calls.length === 1)
      failedStream.error(new Error('fixture stream error'))
      const snapshot = await resultPromise
      expect(snapshot.error).toBe('Codex App Server exited unexpectedly')
      expect(snapshot.status).not.toBe('ok')
    } finally {
      await streamRuntime.runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }

    const spawnFixture = codexFixture()
    const failedSpawn = codexTestProcess()
    failedSpawn.complete({ exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'codex missing' } })
    const spawnRuntime = codexRuntime(failedSpawn)
    try {
      const snapshot = await fetchCodexUsage(spawnRuntime.runtime, spawnFixture.target)
      expect(snapshot.error).toBe('Codex CLI could not be started')
      expect(snapshot.status).toBe('unavailable')
    } finally {
      await spawnRuntime.runtime.processes.shutdown()
      rmSync(spawnFixture.root, { recursive: true, force: true })
    }
  })

  test('maps cancellation and stops the child with the caller signal', async () => {
    const fixture = codexFixture()
    const process = codexTestProcess()
    const controller = new AbortController()
    const { runtime, calls } = codexRuntime(process, controller.signal)
    try {
      const resultPromise = fetchCodexUsage(runtime, fixture.target)
      await waitUntil(() => calls.length === 1)
      controller.abort()
      const snapshot = await resultPromise
      expect(snapshot.error).toBe('Codex usage refresh was cancelled')
      expect(calls[0]?.options.signal).toBe(controller.signal)
      expect(process.stopCalls).toEqual([{ graceMs: 1_000 }])
    } finally {
      await runtime.processes.shutdown()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
