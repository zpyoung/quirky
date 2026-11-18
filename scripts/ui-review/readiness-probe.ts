import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bounded, captureTargetCell, readinessTimingFromError, withCaptureRuntime, type CaptureRuntime } from './capture'
import type { CaptureEvidence, CaptureOptions, CaptureTarget, CaptureTheme } from './contracts'
import type { ReadinessTiming } from './capture'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_TARGET = 'view:quirky.git/diff'
const DEFAULT_RUNS = 2
const DEFAULT_DEADLINE_MS = 1_200_000
const RUNTIME_TIMEOUT_MS = 60_000
const THEME_TIMEOUT_MS = 20_000
const MAX_TIMER_MS = 2_147_483_647
const REPORT_FILE = 'readiness-probe.json'
const USAGE = `Usage: bun scripts/ui-review/readiness-probe.ts --output <new-or-empty-dir> [--only <id>]... [--runs <1-5>] [--deadline-ms <60000-${MAX_TIMER_MS}>] [--skip-build] [--browser <path>]`

export type ProbeOptions = {
  output: string
  only: string[]
  runs: number
  deadlineMs: number
  skipBuild: boolean
  browser?: string
}

export type ProbeSample = {
  run: number
  targetId: string
  theme: 'dark' | 'light'
  status: 'captured' | 'failed'
  error?: string
  imagePath: string | null
  imageSha256: string | null
  isolationReady: boolean
  cellMs: number
  timing: ReadinessTiming | null
  timingSource: 'error' | 'lastReadiness' | null
}

export type ProbeReport = {
  commit: string | null
  startedAt: string
  runs: { run: number; outputDir: string; loadBefore: number[]; loadAfter: number[]; stopped?: string }[]
  samples: ProbeSample[]
  failure?: string
}

export type ProbeDeps = {
  withRuntime: typeof withCaptureRuntime
  captureCell: typeof captureTargetCell
}

class ProbeArgumentError extends Error {}

class ProbeUsageError extends Error {}

type PendingSample = {
  run: number
  target: CaptureTarget
  theme: CaptureTheme
  startedAt: number
  error?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputProblem(output: string): string | null {
  try {
    const info = lstatSync(output)
    if (info.isSymbolicLink() || !info.isDirectory()) return '--output must be a directory, not a file or symbolic link'
    if (readdirSync(output).length > 0) return '--output must be new or an empty directory'
    return null
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    return `cannot inspect --output: ${errorMessage(error)}`
  }
}

function parseFiniteInteger(value: string, flag: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new ProbeArgumentError(`${flag} must be a finite integer`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ProbeArgumentError(`${flag} must be a finite integer`)
  }
  return parsed
}

function invalidArguments(message: string): { ok: false; usage: string } {
  return { ok: false, usage: `${USAGE}\nError: ${message}` }
}

export function parseProbeArgs(argv: string[]): { ok: true; options: ProbeOptions } | { ok: false; usage: string } {
  const args = [...argv]
  if (args[0] === '--') args.shift()

  let output: string | undefined
  let runs = DEFAULT_RUNS
  let deadlineMs = DEFAULT_DEADLINE_MS
  let skipBuild = false
  let browser: string | undefined
  let only: string[] = []
  let onlySpecified = false
  const seen = new Set<string>()

  try {
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]
      const equalsIndex = token.indexOf('=')
      const flag = equalsIndex < 0 ? token : token.slice(0, equalsIndex)
      const inlineValue = equalsIndex < 0 ? undefined : token.slice(equalsIndex + 1)

      if (flag === '--skip-build') {
        if (inlineValue !== undefined) throw new ProbeArgumentError('--skip-build does not take a value')
        if (seen.has(flag)) throw new ProbeArgumentError(`${flag} may be specified only once`)
        seen.add(flag)
        skipBuild = true
        continue
      }

      if (!['--output', '--only', '--runs', '--deadline-ms', '--browser'].includes(flag)) {
        throw new ProbeArgumentError(`unknown argument: ${token}`)
      }
      if (flag !== '--only' && seen.has(flag)) throw new ProbeArgumentError(`${flag} may be specified only once`)
      seen.add(flag)

      let value = inlineValue
      if (value === undefined) {
        const next = args[index + 1]
        if (next === undefined || next.startsWith('--')) throw new ProbeArgumentError(`missing value for ${flag}`)
        value = next
        index += 1
      }
      if (value.length === 0 || value.trim().length === 0) throw new ProbeArgumentError(`missing value for ${flag}`)

      switch (flag) {
        case '--output':
          output = resolve(value)
          break
        case '--only':
          onlySpecified = true
          if (!only.includes(value)) only.push(value)
          break
        case '--runs':
          runs = parseFiniteInteger(value, flag)
          if (runs < 1 || runs > 5) throw new ProbeArgumentError('--runs must be an integer from 1 to 5')
          break
        case '--deadline-ms':
          deadlineMs = parseFiniteInteger(value, flag)
          if (deadlineMs < 60_000 || deadlineMs > MAX_TIMER_MS) {
            throw new ProbeArgumentError(`--deadline-ms must be an integer from 60000 to ${MAX_TIMER_MS}`)
          }
          break
        case '--browser':
          browser = value
          break
      }
    }

    if (!output) throw new ProbeArgumentError('--output is required')
    if (!onlySpecified) only = [DEFAULT_TARGET]
    const problem = outputProblem(output)
    if (problem) throw new ProbeArgumentError(problem)

    return {
      ok: true,
      options: {
        output,
        only,
        runs,
        deadlineMs,
        skipBuild,
        ...(browser === undefined ? {} : { browser })
      }
    }
  } catch (error) {
    return invalidArguments(errorMessage(error))
  }
}

function validateProbeOptions(options: ProbeOptions): void {
  if (typeof options.output !== 'string' || options.output.trim().length === 0) {
    throw new ProbeUsageError('--output is required')
  }
  if (!Number.isFinite(options.runs) || !Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) {
    throw new ProbeUsageError('--runs must be a finite integer from 1 to 5')
  }
  if (!Number.isFinite(options.deadlineMs) || !Number.isInteger(options.deadlineMs) ||
    options.deadlineMs < 60_000 || options.deadlineMs > MAX_TIMER_MS) {
    throw new ProbeUsageError(`--deadline-ms must be a finite integer from 60000 to ${MAX_TIMER_MS}`)
  }
  if (!Array.isArray(options.only) || options.only.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new ProbeUsageError('--only values must be non-empty strings')
  }
  const problem = outputProblem(resolve(options.output))
  if (problem) throw new ProbeUsageError(problem)
}

function gitCommit(): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 1_000 })
    if (result.status !== 0) return null
    const commit = result.stdout.trim()
    return commit.length > 0 ? commit : null
  } catch {
    return null
  }
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  if (typeof signal.reason === 'string') return new Error(signal.reason)
  return new Error('probe was aborted')
}

function abortFailure(signal: AbortSignal): string {
  return `aborted: ${errorMessage(signalError(signal))}`
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signalError(signal)
}

function sampleForFailure(pending: PendingSample, error: unknown): ProbeSample {
  const message = errorMessage(error)
  const timing = readinessTimingFromError(message)
  return {
    run: pending.run,
    targetId: pending.target.id,
    theme: pending.theme,
    status: 'failed',
    error: message,
    imagePath: null,
    imageSha256: null,
    isolationReady: false,
    cellMs: Math.max(0, Date.now() - pending.startedAt),
    timing,
    timingSource: timing ? 'error' : null
  }
}

function sampleForCapture(
  run: number,
  target: CaptureTarget,
  theme: CaptureTheme,
  capture: CaptureEvidence,
  isolationReady: boolean,
  cellMs: number,
  runtime: CaptureRuntime,
  sequenceBeforeCell: number,
  outputDir: string
): ProbeSample {
  let imagePath: string | null = null
  let imageSha256: string | null = null
  if (capture.image) {
    imagePath = isAbsolute(capture.image.path) ? capture.image.path : resolve(outputDir, capture.image.path)
    imageSha256 = createHash('sha256').update(readFileSync(imagePath)).digest('hex')
  }

  let timing: ReadinessTiming | null = null
  let timingSource: ProbeSample['timingSource'] = null
  if (capture.status === 'failed') {
    timing = readinessTimingFromError(capture.error ?? '')
    if (timing) timingSource = 'error'
  } else {
    const lastReadiness = runtime.lastReadiness
    if (lastReadiness?.targetId === target.id && lastReadiness.sequence > sequenceBeforeCell) {
      timing = lastReadiness.timing
      timingSource = 'lastReadiness'
    }
  }

  return {
    run,
    targetId: target.id,
    theme,
    status: capture.status,
    ...(capture.error === undefined ? {} : { error: capture.error }),
    imagePath,
    imageSha256,
    isolationReady,
    cellMs,
    timing,
    timingSource
  }
}

export async function runReadinessProbe(
  options: ProbeOptions,
  deps: ProbeDeps,
  callerSignal?: AbortSignal
): Promise<0 | 1> {
  validateProbeOptions(options)
  const output = resolve(options.output)
  const reportPath = join(output, REPORT_FILE)
  const report: ProbeReport = {
    commit: null,
    startedAt: new Date().toISOString(),
    runs: [],
    samples: []
  }
  let failed = false
  let reportWriteFailed = false
  const setFailure = (message: string) => {
    failed = true
    report.failure ??= message
  }
  const persistReport = (): boolean => {
    try {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      reportWriteFailed = true
      setFailure(`report write failed: ${errorMessage(error)}`)
      return false
    }
  }

  const deadlineController = new AbortController()
  const sigintController = new AbortController()
  const signalInputs = [deadlineController.signal, sigintController.signal]
  if (callerSignal) signalInputs.push(callerSignal)
  const signal = AbortSignal.any(signalInputs)
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new Error(`deadline exceeded after ${options.deadlineMs}ms`))
  }, options.deadlineMs)
  const handleSigint = () => sigintController.abort(new Error('SIGINT'))
  process.on('SIGINT', handleSigint)

  try {
    report.commit = gitCommit()
    mkdirSync(output, { recursive: true })
    if (signal.aborted) setFailure(abortFailure(signal))

    for (let run = 1; run <= options.runs; run += 1) {
      if (signal.aborted) {
        setFailure(abortFailure(signal))
        break
      }

      const outputDir = join(output, `run-${run}`)
      try {
        mkdirSync(outputDir)
      } catch (error) {
        const runRecord = { run, outputDir, loadBefore: loadavg(), loadAfter: loadavg(), stopped: errorMessage(error) }
        report.runs.push(runRecord)
        setFailure(`run ${run} output directory: ${errorMessage(error)}`)
        persistReport()
        break
      }

      const runRecord: ProbeReport['runs'][number] = {
        run,
        outputDir,
        loadBefore: loadavg(),
        loadAfter: []
      }
      report.runs.push(runRecord)
      if (!persistReport()) break

      let pending: PendingSample | undefined
      let runtimeFailure: unknown
      let isolationBlocker: string | undefined
      try {
        const runtimeOptions: CaptureOptions = {
          repoRoot: REPO_ROOT,
          only: options.only,
          themes: ['dark', 'light'],
          outputDir,
          timeoutMs: RUNTIME_TIMEOUT_MS,
          signal,
          skipBuild: options.skipBuild,
          ...(options.browser === undefined ? {} : { browserExecutable: options.browser })
        }

        await deps.withRuntime(runtimeOptions, async (runtime) => {
          captureLoop: for (const theme of ['dark', 'light'] as const) {
            for (const target of runtime.manifest.targets) {
              throwIfAborted(signal)
              const cellStartedAt = Date.now()
              pending = { run, target, theme, startedAt: cellStartedAt }
              try {
                await bounded(
                  runtime.client.callAny('theme.set', { id: theme }, { timeoutMs: THEME_TIMEOUT_MS }),
                  THEME_TIMEOUT_MS,
                  signal,
                  'theme.set'
                )
                throwIfAborted(signal)
                const sequenceBeforeCell = runtime.lastReadiness?.sequence ?? 0
                const result = await deps.captureCell(runtime, target, theme)
                const cellMs = Math.max(0, Date.now() - cellStartedAt)
                const sample = sampleForCapture(
                  run,
                  target,
                  theme,
                  result.capture,
                  result.isolation.ready,
                  cellMs,
                  runtime,
                  sequenceBeforeCell,
                  outputDir
                )
                report.samples.push(sample)
                pending = undefined
                if (!persistReport()) throw new Error(report.failure ?? 'failed to write readiness probe report')

                if (!result.isolation.ready) {
                  isolationBlocker = result.isolation.blocker
                  runRecord.stopped = result.isolation.blocker
                  setFailure(`run ${run} stopped: ${result.isolation.blocker}`)
                  break captureLoop
                }
              } catch (error) {
                if (pending) pending.error = error
                throw error
              }
            }
          }
        })
      } catch (error) {
        runtimeFailure = error
      } finally {
        runRecord.loadAfter = loadavg()
      }

      if (pending && (runtimeFailure !== undefined || signal.aborted)) {
        report.samples.push(sampleForFailure(
          pending,
          signal.aborted ? signalError(signal) : (pending.error ?? runtimeFailure)
        ))
        pending = undefined
        persistReport()
      }

      if (signal.aborted) {
        runRecord.stopped ??= abortFailure(signal)
        setFailure(abortFailure(signal))
        persistReport()
        break
      }

      if (runtimeFailure !== undefined) {
        const message = errorMessage(runtimeFailure)
        runRecord.stopped ??= message
        setFailure(message)
        persistReport()
        break
      }

      if (pending) {
        const message = errorMessage(pending.error ?? new Error('runtime ended before the cell completed'))
        report.samples.push(sampleForFailure(pending, message))
        pending = undefined
        runRecord.stopped = message
        setFailure(message)
        persistReport()
        break
      }

      if (isolationBlocker) {
        if (!persistReport()) break
        continue
      }

      if (!persistReport()) break
    }
  } catch (error) {
    if (signal.aborted) setFailure(abortFailure(signal))
    else if (error instanceof ProbeUsageError) throw error
    else setFailure(errorMessage(error))
  } finally {
    clearTimeout(deadlineTimer)
    process.removeListener('SIGINT', handleSigint)
    if (signal.aborted) report.failure = abortFailure(signal)
    if (!persistReport()) reportWriteFailed = true
  }

  return failed || reportWriteFailed ? 1 : 0
}

async function runCli(argv: string[]): Promise<0 | 1 | 2> {
  const parsed = parseProbeArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.usage)
    return 2
  }

  try {
    return await runReadinessProbe(parsed.options, { withRuntime: withCaptureRuntime, captureCell: captureTargetCell })
  } catch (error) {
    if (error instanceof ProbeUsageError) console.error(`${USAGE}\nError: ${error.message}`)
    else console.error(`Readiness probe failed: ${errorMessage(error)}`)
    return error instanceof ProbeUsageError ? 2 : 1
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))
