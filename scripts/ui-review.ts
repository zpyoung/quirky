#!/usr/bin/env bun
import { captureApplication as defaultCaptureApplication } from './ui-review/capture'
import { reviewManifest as defaultReviewManifest } from './ui-review/review'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CaptureManifest, CaptureOptions, ModelFamily, ReviewOptions, ReviewReport } from './ui-review/contracts'
import { ArgumentError, CAPTURE_TIMEOUT_MS, HELP_TEXT, REVIEW_TIMEOUT_MS, parseArguments, type UiReviewArguments } from './ui-review/arguments'

const CAPTURE_MANIFEST_NAME = 'capture-manifest.json'
const REVIEW_REPORT_NAME = 'review-report.json'
const RESULT_NAME = 'ui-review-result.json'
const ERROR_NAME = 'ui-review-error.json'
type ExitStatus = 'passed' | 'failed' | 'error' | 'not-reviewed'
type CaptureRunner = (options: CaptureOptions) => Promise<CaptureManifest>
type ReviewRunner = (manifest: CaptureManifest, options: ReviewOptions) => Promise<ReviewReport>
type SignalName = 'SIGINT' | 'SIGTERM'
type SignalListener = () => void
type CaptureSettings = { threshold: number; authorFamily: ModelFamily; reviewerAlias: string }

type OutputPaths = {
  captureManifest: string | null
  captureProgress: string | null
  reviewReport: string | null
  errorReport: string | null
}

type UiReviewResult = {
  schemaVersion: 1
  status: ExitStatus
  exitCode: number
  scope: 'full' | 'filtered' | 'unknown'
  targetIds: string[]
  threshold: number
  authorFamily: ModelFamily
  reviewerAlias: string
  failures: string[]
  outputPaths: OutputPaths
}

export interface SignalSource {
  on(signal: SignalName, listener: SignalListener): void
  off(signal: SignalName, listener: SignalListener): void
}

export interface UiReviewDependencies {
  captureApplication?: CaptureRunner
  reviewManifest?: ReviewRunner
  readFile?: (path: string) => Promise<string>
  mkdir?: (path: string, options: { mode: number; recursive?: boolean }) => Promise<unknown>
  writeFile?: (path: string, contents: string, options: { encoding: 'utf8'; flag: 'wx'; mode: number }) => Promise<unknown>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  repoRoot?: string
  signals?: SignalSource
}

const processSignals: SignalSource = {
  on(signal, listener) {
    process.on(signal, listener)
  },
  off(signal, listener) {
    process.off(signal, listener)
  }
}

const defaultDependencies = {
  readFile: async (path: string) => await readFile(path, 'utf8'),
  mkdir: async (path: string, options: { mode: number; recursive?: boolean }) => await mkdir(path, options),
  writeFile: async (path: string, contents: string, options: { encoding: 'utf8'; flag: 'wx'; mode: number }) => await writeFile(path, contents, options),
  stdout: (line: string) => console.log(line),
  stderr: (line: string) => console.error(line),
  repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  signals: processSignals
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function diagnosticText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|xai|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|PRIVATE_KEY))\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|token|secret|password)["']?)\s*[:=]\s*["']?[^,\s"'&}]+/gi, '$1=[REDACTED]')
    .trim()
}

function outputPath(outputDir: string, name: string): string {
  return resolve(outputDir, name)
}

function inventoryFrom(value: CaptureManifest): { scope: UiReviewResult['scope']; targetIds: string[] } {
  const candidate: unknown = value
  if (typeof candidate !== 'object' || candidate === null) return { scope: 'unknown', targetIds: [] }
  const candidateScope = 'scope' in candidate ? candidate.scope : undefined
  const targets = 'targets' in candidate ? candidate.targets : undefined
  const scope = candidateScope === 'full' || candidateScope === 'filtered' ? candidateScope : 'unknown'
  const targetIds = Array.isArray(targets)
    ? targets.flatMap((target) => {
      if (typeof target !== 'object' || target === null || !('id' in target)) return []
      return typeof target.id === 'string' ? [target.id] : []
    })
    : []
  return { scope, targetIds }
}

/** Validate capture completeness only; detailed manifest/evidence validation belongs to reviewManifest. */
function captureProblems(manifest: CaptureManifest, only: string[]): string[] {
  const problems = [...manifest.failures]
  const targetIds = manifest.targets.map((target) => target.id)
  const uniqueTargetIds = new Set(targetIds)
  if (targetIds.length === 0) problems.push('Capture inventory is empty')
  if (uniqueTargetIds.size !== targetIds.length) problems.push('Capture inventory contains duplicate target IDs')

  if (only.length === 0) {
    if (manifest.scope !== 'full') problems.push('Unfiltered capture did not report a full inventory')
    if (manifest.selectors.length !== 0) problems.push('Unfiltered capture reported unexpected selectors')
  } else {
    if (manifest.scope !== 'filtered') problems.push('Selected capture did not report a filtered inventory')
    if (manifest.selectors.length !== only.length || only.some((selector) => !manifest.selectors.includes(selector))) {
      problems.push('Capture manifest selectors do not match the requested selection')
    }
    for (const selector of only) {
      if (!manifest.targets.some((target) => target.id === selector || target.plugin === selector)) {
        problems.push(`No captured target matches selector ${selector}`)
      }
    }
  }

  const seen = new Set<string>()
  for (const capture of manifest.captures) {
    const key = `${capture.targetId}\0${capture.theme}`
    if (!uniqueTargetIds.has(capture.targetId)) problems.push(`Capture references unknown target ${capture.targetId}`)
    if (seen.has(key)) problems.push(`Duplicate ${capture.theme} capture for ${capture.targetId}`)
    seen.add(key)
    if (capture.status !== 'captured' || capture.image === null) {
      problems.push(capture.error || `Capture failed for ${capture.targetId} (${capture.theme})`)
    }
  }
  for (const targetId of targetIds) {
    for (const theme of ['dark', 'light'] as const) {
      if (!seen.has(`${targetId}\0${theme}`)) problems.push(`Missing ${theme} capture for ${targetId}`)
    }
  }
  return [...new Set(problems)]
}

function captureFailureReport(manifest: CaptureManifest, args: CaptureSettings, failures: string[]): ReviewReport {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: 'failed',
    scope: manifest.scope,
    threshold: args.threshold,
    authorFamily: args.authorFamily,
    reviewerAlias: args.reviewerAlias,
    captures: [],
    failures: ['Review skipped because capture coverage failed.', ...failures]
  }
}

function statusSummary(result: UiReviewResult): string {
  if (result.status === 'not-reviewed') {
    return `UI capture complete (not reviewed): ${result.targetIds.length} target(s), ${result.scope} inventory.`
  }
  if (result.status === 'passed') {
    return `UI review passed: ${result.targetIds.length} target(s), ${result.targetIds.length * 2} image(s), threshold ${result.threshold}.`
  }
  return `UI review ${result.status}: ${result.failures.length} failure(s), exit ${result.exitCode}.`
}

/** Run the command with injectable boundaries; importing this module has no side effects. */
export async function runUiReview(argv: readonly string[], dependencies: UiReviewDependencies = {}): Promise<number> {
  const io = {
    readFile: dependencies.readFile ?? defaultDependencies.readFile,
    mkdir: dependencies.mkdir ?? defaultDependencies.mkdir,
    writeFile: dependencies.writeFile ?? defaultDependencies.writeFile,
    stdout: dependencies.stdout ?? defaultDependencies.stdout,
    stderr: dependencies.stderr ?? defaultDependencies.stderr,
    repoRoot: dependencies.repoRoot ?? defaultDependencies.repoRoot,
    signals: dependencies.signals ?? defaultDependencies.signals
  }

  let args: UiReviewArguments
  try {
    args = parseArguments(argv)
  } catch (error) {
    io.stderr(`${error instanceof ArgumentError ? error.message : diagnosticText(error)}\n${HELP_TEXT}`)
    return 2
  }
  if (args.mode === 'help') {
    io.stdout(HELP_TEXT)
    return 0
  }

  const paths: OutputPaths = {
    captureManifest: null,
    captureProgress: null,
    reviewReport: null,
    errorReport: null,
    result: outputPath(args.outputDir, RESULT_NAME)
  }
  const controller = new AbortController()
  let signalName: SignalName | undefined
  let status: ExitStatus = 'error'
  let exitCode = 2
  let scope: UiReviewResult['scope'] = 'unknown'
  let targetIds: string[] = []
  let failures: string[] = []
  let directoryCreated = false
  let operation = args.mode === 'manifest' ? 'manifest-read' : 'capture'

  const onInterrupt = (signal: SignalName): SignalListener => () => {
    if (signalName === undefined) {
      signalName = signal
      controller.abort(new Error(`Interrupted by ${signal}`))
    }
  }
  const onSigint = onInterrupt('SIGINT')
  const onSigterm = onInterrupt('SIGTERM')
  io.signals.on('SIGINT', onSigint)
  io.signals.on('SIGTERM', onSigterm)

  try {
    try {
      await io.mkdir(dirname(args.outputDir), { mode: 0o700, recursive: true })
      await io.mkdir(args.outputDir, { mode: 0o700 })
      directoryCreated = true
    } catch (error) {
      io.stderr(`Cannot create fresh output directory: ${diagnosticText(error)}`)
    }

    if (!directoryCreated) return signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : 2

    try {
      if (signalName) throw new Error(`Interrupted by ${signalName}`)
      let manifest: CaptureManifest

      if (args.mode === 'manifest') {
        const parsedManifest: unknown = JSON.parse(await io.readFile(args.manifestPath))
        // reviewManifest is the strict validation boundary for persisted evidence.
        manifest = parsedManifest as CaptureManifest
      } else {
        // captureApplication owns this progress file; the CLI retains and reports it on failures.
        paths.captureProgress = outputPath(args.outputDir, 'capture-progress.json')
        operation = 'capture'
        const capture = dependencies.captureApplication ?? defaultCaptureApplication
        const captureOptions: CaptureOptions = {
          repoRoot: io.repoRoot,
          outputDir: args.outputDir,
          only: args.only,
          skipBuild: args.skipBuild,
          ...(args.browserExecutable ? { browserExecutable: args.browserExecutable } : {}),
          timeoutMs: CAPTURE_TIMEOUT_MS,
          signal: controller.signal
        }
        manifest = await capture(captureOptions)
        paths.captureManifest = outputPath(args.outputDir, CAPTURE_MANIFEST_NAME)
        await io.writeFile(paths.captureManifest, json(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      }

      const inventory = inventoryFrom(manifest)
      scope = inventory.scope
      targetIds = inventory.targetIds
      if (signalName) throw new Error(`Interrupted by ${signalName}`)

      let coverageProblems: string[] = []
      if (args.mode === 'capture' || args.mode === 'capture-only') {
        coverageProblems = captureProblems(manifest, args.only)
      }

      if (args.mode === 'capture-only') {
        failures = coverageProblems
        if (coverageProblems.length > 0) {
          status = 'failed'
          exitCode = 1
        } else {
          status = 'not-reviewed'
          exitCode = 0
        }
      } else if (args.mode === 'capture' && coverageProblems.length > 0) {
        failures = coverageProblems
        status = 'failed'
        exitCode = 1
        const report = captureFailureReport(manifest, args, failures)
        paths.reviewReport = outputPath(args.outputDir, REVIEW_REPORT_NAME)
        await io.writeFile(paths.reviewReport, json(report), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } else {
        operation = 'review'
        const review = dependencies.reviewManifest ?? defaultReviewManifest
        const reviewOptions: ReviewOptions = {
          outputDir: args.outputDir,
          reviewerAlias: args.reviewerAlias,
          authorFamily: args.authorFamily,
          threshold: args.threshold,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal: controller.signal
        }
        const report = await review(manifest, reviewOptions)
        paths.reviewReport = outputPath(args.outputDir, REVIEW_REPORT_NAME)
        await io.writeFile(paths.reviewReport, json(report), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        failures = [...report.failures]
        if (report.status === 'passed') {
          status = 'passed'
          exitCode = 0
        } else if (report.status === 'failed') {
          status = 'failed'
          exitCode = 1
        } else {
          status = 'error'
          exitCode = 2
        }
      }
    } catch (error) {
      if (signalName) {
        status = 'error'
        exitCode = signalName === 'SIGINT' ? 130 : 143
        failures = [`Interrupted by ${signalName}.`, ...failures]
        if (paths.errorReport === null) {
          paths.errorReport = outputPath(args.outputDir, ERROR_NAME)
          try {
            await io.writeFile(paths.errorReport, json({
              schemaVersion: 1,
              status: 'error',
              createdAt: new Date().toISOString(),
              operation,
              outputPaths: paths,
              diagnostic: `Interrupted by ${signalName}.`
            }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          } catch (persistError) {
            io.stderr(`Cannot persist interruption evidence: ${diagnosticText(persistError)}`)
            paths.errorReport = null
          }
        }
      } else {
        const diagnostic = diagnosticText(error)
        status = 'error'
        exitCode = 2
        failures = [diagnostic]
        paths.errorReport = outputPath(args.outputDir, ERROR_NAME)
        try {
          await io.writeFile(paths.errorReport, json({
            schemaVersion: 1,
            status: 'error',
            createdAt: new Date().toISOString(),
            operation,
            outputPaths: paths,
            diagnostic
          }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (persistError) {
          io.stderr(`Cannot persist error evidence: ${diagnosticText(persistError)}`)
          paths.errorReport = null
        }
        io.stderr(`UI review ${operation} failed: ${diagnostic}`)
      }
    }

    if (signalName) {
      status = 'error'
      exitCode = signalName === 'SIGINT' ? 130 : 143
      if (!failures.some((failure) => failure.includes('Interrupted'))) failures.unshift(`Interrupted by ${signalName}.`)
      if (paths.errorReport === null) {
        paths.errorReport = outputPath(args.outputDir, ERROR_NAME)
        try {
          await io.writeFile(paths.errorReport, json({
            schemaVersion: 1,
            status: 'error',
            createdAt: new Date().toISOString(),
            operation,
            outputPaths: paths,
            diagnostic: `Interrupted by ${signalName}.`
          }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (persistError) {
          io.stderr(`Cannot persist interruption evidence: ${diagnosticText(persistError)}`)
          paths.errorReport = null
        }
      }
    }

    const result: UiReviewResult = {
      schemaVersion: 1,
      status,
      exitCode,
      scope,
      targetIds,
      threshold: args.threshold,
      authorFamily: args.authorFamily,
      reviewerAlias: args.reviewerAlias,
      failures,
      outputPaths: paths
    }
    try {
      await io.writeFile(paths.result, json(result), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      io.stderr(`Cannot persist UI review result: ${diagnosticText(error)}`)
      if (!signalName) {
        status = 'error'
        exitCode = 2
      }
    }
    io.stdout(statusSummary({ ...result, status, exitCode }))
    io.stdout(JSON.stringify(paths))
  } finally {
    io.signals.off('SIGINT', onSigint)
    io.signals.off('SIGTERM', onSigterm)
  }

  return signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : exitCode
}

if (import.meta.main) process.exitCode = await runUiReview(Bun.argv.slice(2))
