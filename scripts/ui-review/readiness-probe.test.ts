import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProbeArgs, runReadinessProbe, type ProbeDeps, type ProbeOptions, type ProbeReport } from './readiness-probe'
import type { ReadinessTiming } from './capture'
import type { CaptureEvidence } from './contracts'

const TARGET = 'view:quirky.git/diff'
const OTHER_TARGET = 'view:acme.fixture/page'
const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_TIMER_MS = 2_147_483_647
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type RuntimeOptions = Parameters<ProbeDeps['withRuntime']>[0]
type RuntimeScenario = Parameters<ProbeDeps['withRuntime']>[1]
type ProbeRuntime = Parameters<RuntimeScenario>[0]
type ProbeCapture = CaptureEvidence

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'readiness-probe-test-'))
  tempRoots.push(path)
  return path
}

function options(output: string, overrides: Partial<ProbeOptions> = {}): ProbeOptions {
  return {
    output,
    only: [TARGET],
    runs: 1,
    deadlineMs: 60_000,
    skipBuild: false,
    ...overrides
  }
}

function readinessTiming(sequence: number): ReadinessTiming {
  return {
    sequence,
    deadlineMs: 3_000,
    budgetMs: 2_500,
    phaseOffsetMs: 500,
    readyMs: 800,
    hostRejectedMs: null,
    diagnosticLatencyMs: null,
    hostMaxLagMs: 1,
    polls: 4,
    firstPollMs: 10,
    lastPollMs: 750,
    maxGapMs: 300,
    maxPollMs: 8,
    totalPollMs: 18,
    longTaskObserver: true,
    longTaskCoverageFromMs: 10,
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    lastFailed: null,
    lateReady: null,
    cleanup: 'proved'
  }
}

function setLastReadiness(runtime: ProbeRuntime, targetId: string, sequence: number): void {
  const writable = runtime as ProbeRuntime & {
    lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTiming }
  }
  writable.lastReadiness = { targetId, sequence, timing: readinessTiming(sequence) }
}

function lastReadiness(runtime: ProbeRuntime): { targetId: string; sequence: number; timing: ReadinessTiming } | undefined {
  return (runtime as ProbeRuntime & {
    lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTiming }
  }).lastReadiness
}

function makeRuntime(outputDir: string, onCall: (method: string, params: Record<string, unknown>, rpcOptions?: { timeoutMs?: number }) => void = () => {}): ProbeRuntime {
  return {
    outputDir,
    manifest: { targets: [{ id: TARGET, plugin: 'quirky.git', title: 'Diff', kind: 'view' }] },
    client: {
      async callAny(method: string, params: Record<string, unknown> = {}, rpcOptions?: { timeoutMs?: number }) {
        onCall(method, params, rpcOptions)
        return {}
      }
    }
  } as unknown as ProbeRuntime
}

function capture(
  targetId: string,
  theme: 'dark' | 'light',
  status: 'captured' | 'failed',
  imagePath: string | null = null,
  error?: string
): ProbeCapture {
  return {
    targetId,
    theme,
    image: imagePath ? { path: imagePath, sha256: 'capture-side-digest-is-not-authoritative' } : null,
    reference: { path: 'reference.png', sha256: 'reference-digest' },
    status,
    ...(error === undefined ? {} : { error })
  }
}

function readReport(output: string): ProbeReport {
  return JSON.parse(readFileSync(join(output, 'readiness-probe.json'), 'utf8')) as ProbeReport
}

test('defaults the Git probe and rejects invalid, non-finite, and out-of-range numeric arguments', () => {
  const root = tempRoot()
  const output = join(root, 'new-output')
  const parsed = parseProbeArgs(['--output', output])
  expect(parsed).toEqual({
    ok: true,
    options: {
      output,
      only: [TARGET],
      runs: 2,
      deadlineMs: 1_200_000,
      skipBuild: false
    }
  })
  expect(existsSync(output)).toBe(false)

  for (const runs of ['0', '6', '1.5', 'NaN', 'Infinity', '1e999']) {
    expect(parseProbeArgs(['--output', output, '--runs', runs]).ok).toBe(false)
  }
  for (const deadline of ['59999', 'NaN', 'Infinity', '1e999', String(MAX_TIMER_MS + 1)]) {
    expect(parseProbeArgs(['--output', output, '--deadline-ms', deadline]).ok).toBe(false)
  }
  expect(parseProbeArgs(['--output', output, '--runs', '1']).ok).toBe(true)
  expect(parseProbeArgs(['--output', output, '--runs', '5']).ok).toBe(true)
  expect(parseProbeArgs(['--output', output, '--deadline-ms', '60000']).ok).toBe(true)
  expect(parseProbeArgs(['--output', output, '--deadline-ms', String(MAX_TIMER_MS)]).ok).toBe(true)
  expect(parseProbeArgs(['--output', output, '--only', TARGET, '--only', OTHER_TARGET, '--skip-build', '--browser', '/custom/chrome'])).toMatchObject({
    ok: true,
    options: { only: [TARGET, OTHER_TARGET], skipBuild: true, browser: '/custom/chrome' }
  })
})

test('runs each repeat in a fresh runtime, writes reports incrementally, hashes image files, and preserves capture progress', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const events: string[] = []
  const reportCountsSeenByNextCell: number[] = []
  const progressBytes = Buffer.from('{"runtime":"owned progress"}\n')
  const imageBytes = Buffer.from('actual image bytes')
  const runtimeOptionsSeen: RuntimeOptions[] = []
  let activeRun = 0

  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      runtimeOptionsSeen.push(runtimeOptions)
      activeRun += 1
      const run = activeRun
      const runDir = join(output, `run-${run}`)
      expect(runtimeOptions.repoRoot).toBe(MODULE_REPO_ROOT)
      expect(runtimeOptions.outputDir).toBe(runDir)
      expect(existsSync(runDir)).toBe(true)
      expect(readdirSync(runDir)).toEqual([])
      expect(runtimeOptions.only).toEqual([TARGET])
      expect(runtimeOptions.themes).toEqual(['dark', 'light'])
      expect(runtimeOptions.timeoutMs).toBe(60_000)
      expect(runtimeOptions.skipBuild).toBe(true)
      expect(runtimeOptions.browserExecutable).toBe('/custom/chrome')
      expect(runtimeOptions.signal).toBeInstanceOf(AbortSignal)

      const progressPath = join(runDir, 'capture-progress.json')
      writeFileSync(progressPath, progressBytes)
      const runtime = makeRuntime(runDir, (method, params, rpcOptions) => {
        events.push(`rpc:${run}:${method}:${String(params.id)}`)
        if (method === 'theme.set') expect(rpcOptions?.timeoutMs).toBe(20_000)
      })
      setLastReadiness(runtime, TARGET, run * 100)
      try {
        await scenario(runtime)
      } finally {
        expect(readFileSync(progressPath)).toEqual(progressBytes)
        events.push(`settled:${run}`)
      }
    },
    captureCell: async (runtime, target, theme) => {
      const runDir = runtime.outputDir
      const currentReport = join(output, 'readiness-probe.json')
      reportCountsSeenByNextCell.push(existsSync(currentReport) ? readReport(output).samples.length : 0)
      events.push(`cell:${activeRun}:${theme}`)
      expect(events.at(-2)).toBe(`rpc:${activeRun}:theme.set:${theme}`)
      const imagePath = join(runDir, `image-${theme}.png`)
      writeFileSync(imagePath, imageBytes)
      const sequence = (lastReadiness(runtime)?.sequence ?? 0) + 1
      setLastReadiness(runtime, target.id, sequence)
      return { capture: capture(target.id, theme, 'captured', imagePath), isolation: { ready: true } }
    }
  }

  const result = await runReadinessProbe(options(output, {
    runs: 2,
    deadlineMs: 120_000,
    skipBuild: true,
    browser: '/custom/chrome'
  }), deps)

  expect(result).toBe(0)
  expect(runtimeOptionsSeen).toHaveLength(2)
  expect(runtimeOptionsSeen[0].outputDir).not.toBe(runtimeOptionsSeen[1].outputDir)
  expect(events).toEqual([
    'rpc:1:theme.set:dark', 'cell:1:dark',
    'rpc:1:theme.set:light', 'cell:1:light', 'settled:1',
    'rpc:2:theme.set:dark', 'cell:2:dark',
    'rpc:2:theme.set:light', 'cell:2:light', 'settled:2'
  ])
  expect(reportCountsSeenByNextCell).toEqual([0, 1, 2, 3])
  expect(readdirSync(output).sort()).toEqual(['readiness-probe.json', 'run-1', 'run-2'])

  const report = readReport(output)
  expect(report.runs.map(({ run, outputDir }) => ({ run, outputDir }))).toEqual([
    { run: 1, outputDir: join(output, 'run-1') },
    { run: 2, outputDir: join(output, 'run-2') }
  ])
  expect(report.runs.every((run) => run.loadBefore.length === 3 && run.loadAfter.length === 3)).toBe(true)
  expect(report.samples).toHaveLength(4)
  expect(report.samples.map((sample) => [sample.run, sample.theme])).toEqual([
    [1, 'dark'], [1, 'light'], [2, 'dark'], [2, 'light']
  ])
  for (const sample of report.samples) {
    const actualBytes = readFileSync(sample.imagePath!)
    expect(sample.imageSha256).toBe(createHash('sha256').update(actualBytes).digest('hex'))
    expect(sample.status).toBe('captured')
    expect(sample.timingSource).toBe('lastReadiness')
  }
})

test('uses a fresh matching sequence only after theme setup and before capture', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  let sequence = 40
  let themeCalls = 0
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      const runtime = makeRuntime(runtimeOptions.outputDir, (method) => {
        if (method !== 'theme.set') return
        themeCalls += 1
        sequence += 1
        setLastReadiness(runtime, TARGET, sequence)
      })
      await scenario(runtime)
    },
    captureCell: async (runtime, target, theme) => {
      if (theme === 'dark') {
        sequence += 1
        setLastReadiness(runtime, target.id, sequence)
      }
      return { capture: capture(target.id, theme, 'captured'), isolation: { ready: true } }
    }
  }

  expect(await runReadinessProbe(options(output), deps)).toBe(0)
  const report = readReport(output)
  expect(themeCalls).toBe(2)
  expect(report.samples.map((sample) => sample.timingSource)).toEqual(['lastReadiness', null])
  expect(report.samples[0].timing?.sequence).toBe(42)
  expect(report.samples[1].timing).toBeNull()
})

test('prefers failed-sample timing parsed from the error over runtime lastReadiness', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const errorTiming = readinessTiming(9)
  const error = `slot ${TARGET} content exceeded 3000ms (busy: false, text: "waiting"); timing=${JSON.stringify(errorTiming)}`
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      const runtime = makeRuntime(runtimeOptions.outputDir, (method) => {
        if (method === 'theme.set') setLastReadiness(runtime, TARGET, 20)
      })
      await scenario(runtime)
    },
    captureCell: async (_runtime, target, theme) => ({
      capture: capture(target.id, theme, 'failed', null, error),
      isolation: { ready: true }
    })
  }

  expect(await runReadinessProbe(options(output), deps)).toBe(0)
  const [sample] = readReport(output).samples
  expect(sample.status).toBe('failed')
  expect(sample.error).toBe(error)
  expect(sample.timing).toEqual(errorTiming)
  expect(sample.timingSource).toBe('error')
})

test('does not attribute captured timing to a different target', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      const runtime = makeRuntime(runtimeOptions.outputDir, (method) => {
        if (method === 'theme.set') setLastReadiness(runtime, OTHER_TARGET, 50)
      })
      await scenario(runtime)
    },
    captureCell: async (_runtime, target, theme) => ({
      capture: capture(target.id, theme, 'captured'),
      isolation: { ready: true }
    })
  }

  expect(await runReadinessProbe(options(output), deps)).toBe(0)
  expect(readReport(output).samples[0]).toMatchObject({ timing: null, timingSource: null })
})

test('stops an unisolated run and starts the next repeat with a fresh runtime', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const events: string[] = []
  let run = 0
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      run += 1
      events.push(`start:${run}`)
      const runtime = makeRuntime(runtimeOptions.outputDir)
      try {
        await scenario(runtime)
      } finally {
        events.push(`settled:${run}`)
      }
    },
    captureCell: async (runtime, target, theme) => {
      events.push(`cell:${run}:${theme}`)
      return {
        capture: capture(target.id, theme, 'captured'),
        isolation: run === 1 ? { ready: false, blocker: 'dialog survived reload' } : { ready: true }
      }
    }
  }

  expect(await runReadinessProbe(options(output, { runs: 2 }), deps)).toBe(1)
  expect(events).toEqual([
    'start:1', 'cell:1:dark', 'settled:1',
    'start:2', 'cell:2:dark', 'cell:2:light', 'settled:2'
  ])
  const report = readReport(output)
  expect(report.runs).toMatchObject([
    { run: 1, stopped: 'dialog survived reload' },
    { run: 2 }
  ])
  expect(report.samples.map((sample) => [sample.run, sample.theme, sample.isolationReady])).toEqual([
    [1, 'dark', false], [2, 'dark', true], [2, 'light', true]
  ])
})
test('a later abort overrides an earlier run failure without erasing its stopped reason', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const events: string[] = []
  let activeSignal: AbortSignal | undefined
  let run = 0
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      run += 1
      const thisRun = run
      activeSignal = runtimeOptions.signal
      events.push(`start:${thisRun}`)
      try {
        await scenario(makeRuntime(runtimeOptions.outputDir))
      } finally {
        events.push(`settled:${thisRun}`)
      }
    },
    captureCell: async (runtime, target, theme) => {
      events.push(`cell:${run}:${theme}`)
      if (run === 1) {
        return {
          capture: capture(target.id, theme, 'captured'),
          isolation: { ready: false, blocker: 'dialog survived reload' }
        }
      }

      started.resolve()
      const { promise, reject } = Promise.withResolvers<never>()
      const signal = activeSignal!
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      return await promise
    }
  }

  const probe = runReadinessProbe(options(output, { runs: 3 }), deps, controller.signal)
  await started.promise
  controller.abort(new Error('caller stopped during run 2'))
  const result = await probe
  events.push('probe-returned')

  expect(result).toBe(1)
  expect(events).toEqual([
    'start:1', 'cell:1:dark', 'settled:1',
    'start:2', 'cell:2:dark', 'settled:2', 'probe-returned'
  ])
  const report = readReport(output)
  expect(report.failure).toBe('aborted: caller stopped during run 2')
  expect(report.runs).toMatchObject([
    { run: 1, stopped: 'dialog survived reload' },
    { run: 2, stopped: 'aborted: caller stopped during run 2' }
  ])
  expect(report.runs).toHaveLength(2)
})


test('records a throwing capture only after its runtime settles', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const events: string[] = []
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      try {
        await scenario(makeRuntime(runtimeOptions.outputDir))
      } finally {
        events.push('runtime-settled')
      }
    },
    captureCell: async () => {
      events.push('capture-threw')
      throw new Error('capture transport failed')
    }
  }

  const result = await runReadinessProbe(options(output, { runs: 2 }), deps)
  events.push('probe-returned')
  expect(result).toBe(1)
  expect(events).toEqual(['capture-threw', 'runtime-settled', 'probe-returned'])
  const report = readReport(output)
  expect(report.failure).toContain('capture transport failed')
  expect(report.samples).toHaveLength(1)
  expect(report.samples[0]).toMatchObject({ status: 'failed', imagePath: null, imageSha256: null })
  expect(report.samples[0].error).toContain('capture transport failed')
})

test('caller abort is recorded after runtime settlement and prevents another run', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const events: string[] = []
  let activeSignal: AbortSignal | undefined
  let runtimeCalls = 0
  const listenersBefore = process.listenerCount('SIGINT')
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      runtimeCalls += 1
      activeSignal = runtimeOptions.signal
      try {
        await scenario(makeRuntime(runtimeOptions.outputDir))
      } finally {
        events.push('runtime-settled')
      }
    },
    captureCell: async () => {
      started.resolve()
      const { promise, reject } = Promise.withResolvers<never>()
      const signal = activeSignal!
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      return await promise
    }
  }

  const probe = runReadinessProbe(options(output, { runs: 2 }), deps, controller.signal)
  await started.promise
  expect(activeSignal).toBeInstanceOf(AbortSignal)
  expect(activeSignal).not.toBe(controller.signal)
  controller.abort(new Error('caller stopped'))
  const result = await probe
  events.push('probe-returned')

  expect(result).toBe(1)
  expect(runtimeCalls).toBe(1)
  expect(events).toEqual(['runtime-settled', 'probe-returned'])
  expect(process.listenerCount('SIGINT')).toBe(listenersBefore)
  expect(readReport(output).failure).toContain('aborted: caller stopped')
})

test('SIGINT abort is recorded after runtime settlement, removes its handler, and starts no later run', async () => {
  const root = tempRoot()
  const output = join(root, 'probe')
  const started = Promise.withResolvers<void>()
  const events: string[] = []
  const listenersBefore = process.listenerCount('SIGINT')
  let activeSignal: AbortSignal | undefined
  let runtimeCalls = 0
  const deps: ProbeDeps = {
    withRuntime: async (runtimeOptions, scenario) => {
      runtimeCalls += 1
      activeSignal = runtimeOptions.signal
      try {
        await scenario(makeRuntime(runtimeOptions.outputDir))
      } finally {
        events.push('runtime-settled')
      }
    },
    captureCell: async () => {
      started.resolve()
      const { promise, reject } = Promise.withResolvers<never>()
      const signal = activeSignal!
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      return await promise
    }
  }

  const probe = runReadinessProbe(options(output, { runs: 2 }), deps)
  await started.promise
  expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1)
  expect(activeSignal).toBeInstanceOf(AbortSignal)
  expect(process.emit('SIGINT')).toBe(true)
  const result = await probe
  events.push('probe-returned')

  expect(result).toBe(1)
  expect(runtimeCalls).toBe(1)
  expect(events).toEqual(['runtime-settled', 'probe-returned'])
  expect(process.listenerCount('SIGINT')).toBe(listenersBefore)
  expect(readReport(output).failure).toMatch(/^aborted: .*SIGINT/i)
})

test('CLI usage errors exit 2 without creating output or entering a runtime', () => {
  const root = tempRoot()
  const script = fileURLToPath(new URL('./readiness-probe.ts', import.meta.url))
  const nonEmptyOutput = join(root, 'non-empty')
  mkdirSync(nonEmptyOutput)
  const marker = join(nonEmptyOutput, 'keep.txt')
  writeFileSync(marker, 'untouched')
  const cases = [
    { args: [], output: undefined },
    { args: ['--output', nonEmptyOutput], output: nonEmptyOutput },
    ...['0', '6', '1.5', 'NaN', 'Infinity'].map((runs, index) => ({
      args: ['--output', join(root, `invalid-runs-${index}`), '--runs', runs],
      output: join(root, `invalid-runs-${index}`)
    })),
    {
      args: ['--output', join(root, 'invalid-deadline'), '--deadline-ms', '59999'],
      output: join(root, 'invalid-deadline')
    }
  ]

  for (const { args, output } of cases) {
    const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: MODULE_REPO_ROOT })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(2)
    if (output && output !== nonEmptyOutput) expect(existsSync(output)).toBe(false)
  }
  expect(readFileSync(marker, 'utf8')).toBe('untouched')
  expect(existsSync(join(nonEmptyOutput, 'run-1'))).toBe(false)
})
