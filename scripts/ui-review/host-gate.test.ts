import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPTURE_TIMEOUT_MS, REVIEW_TIMEOUT_MS } from './arguments'
import { hostContractContext, serializeContractContext } from './host-contracts'
import { runHostGate, type HostGateDependencies } from './host-gate'
import { goldenFor } from './goldens'
import { collectInventory } from '../ui-scoreboard/inventory'
import { reviewManifest } from './review'
import { SCORE_DIMENSIONS, THEMES, type CaptureManifest, type CaptureOptions, type CaptureTarget, type CaptureTheme, type ReviewCellKey, type ReviewReport, type ReviewerIdentity, type ReviewedCapture, type VisualAssessment } from './contracts'
const HOST_TARGET_IDS = ['host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'] as const
const tempRoots: string[] = []
const dimensions = { width: 2800, height: 1760 }

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-gate-'))
  tempRoots.push(path)
  return path
}

function pngBytes(width = dimensions.width, height = dimensions.height, marker = 0): Buffer {
  const bytes = Buffer.alloc(33 + marker)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  bytes[29] = 0
  return bytes
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function artifactPrefix(targetId: string, theme: CaptureTheme, runId: string): string {
  const targetKey = createHash('sha256').update(targetId).digest('hex').slice(0, 20)
  return `capture-${targetKey}-${theme}-${runId}`
}

function putFile(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}
function putPrivateFile(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
}
function fakeHostGateReviewerSource(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
const identity = '▶ resolved google/fixture-vision (alias gemini)'
if (args[0] === '--check') {
  process.stderr.write(identity + '\\n')
  process.exit(0)
}
const prompt = args[args.length - 1] || ''
const contextMatch = /Trusted host contract context \\(canonical JSON; sha256=([a-f0-9]{64})\\):\\n([^\\n]+)/.exec(prompt)
if (!contextMatch) {
  process.stderr.write('trusted contract context missing\\n')
  process.exit(4)
}
const context = JSON.parse(contextMatch[2])
const assessment = {
  targetVisible: true,
  imagesRead: true,
  scores: { palette: 90, typography: 90, spacing: 90, components: 90, hierarchy: 90 },
  reasons: ['The target surface and both images were inspected.', 'Spacing and component styling are clearly compared.']
}
const contractAudit = {
  contextSha256: contextMatch[1],
  acknowledgedRuleIds: context.rules.map((rule) => rule.id).sort(),
  reasonChecks: assessment.reasons.map((_, reasonIndex) => ({
    reasonIndex,
    contractIds: [],
    conflictsWithContract: false,
    affectsScore: false
  })),
  conflicts: []
}
process.stderr.write(identity + '\\n')
process.stdout.write(JSON.stringify({ assessment, contractAudit }) + '\\n')
`
}

type Fixture = {
  root: string
  output: string
  manifest: CaptureManifest
  source: { repoRoot: string; commit: string; sourceDigest: string; dirty: boolean; failures: never[] }
}
function fixture(): Fixture {
  const repoRoot = join(root(), 'repo')
  mkdirSync(repoRoot, { recursive: true })
  const output = join(repoRoot, 'fresh-output')
  const source = { repoRoot, commit: 'fixture-head', sourceDigest: 'a'.repeat(64), dirty: false, failures: [] as never[] }
  const targets: CaptureTarget[] = HOST_TARGET_IDS.map((id) => ({ id, plugin: null, title: id, kind: 'host' }))
  const captures = targets.flatMap((target, targetIndex) => THEMES.map((theme, themeIndex) => {
    const imageBytes = pngBytes(dimensions.width, dimensions.height, targetIndex * 2 + themeIndex + 1)
    const imagePath = join(repoRoot, 'fixture-images', `${targetIndex}-${theme}.png`)
    putFile(imagePath, imageBytes)
    const referencePath = goldenFor(target.id, theme, repoRoot)
    if (!existsSync(referencePath)) putFile(referencePath, pngBytes())
    const referenceBytes = readFileSync(referencePath)
    return {
      targetId: target.id,
      theme,
      image: { path: imagePath, sha256: digest(imageBytes) },
      reference: { path: referencePath, sha256: digest(referenceBytes) },
      status: 'captured' as const
    }
  }))
  return {
    root: repoRoot,
    output,
    source,
    manifest: {
      schemaVersion: 1,
      createdAt: '2026-11-16T00:00:00.000Z',
      commit: source.commit,
      surface: 'desktop-renderer',
      viewport: { width: 1400, height: 880 },
      scope: 'filtered',
      selectors: [...HOST_TARGET_IDS],
      targets,
      captures,
      failures: []
    }
  }
}

type ReviewMutation = (report: ReviewReport, context: { call: number; manifest: CaptureManifest; options: Record<string, unknown> }) => ReviewReport

type Scenario = {
  scores?: number[] | ((targetId: string, theme: CaptureTheme, slot: number) => number)
  issue?: (cell: { targetId: string; theme: CaptureTheme }, slot: number) => ReviewReport['issues']
  mutate?: ReviewMutation
  identity?: (slot: number, cellIndex: number) => ReviewedCapture['reviewer']
  preflightIdentity?: { provider: string; model: string; family: 'openai' | 'anthropic' | 'google' | 'xai' } | null
  reviewThrows?: (call: number) => boolean
  onReview?: (context: { call: number; manifest: CaptureManifest; options: Record<string, unknown>; output: string }) => void | Promise<void>
  sourceSnapshot?: () => Fixture['source']
  io?: Partial<HostGateDependencies>
  signals?: HostGateDependencies['signals']
  browser?: string
}

function scoreFor(scenario: Scenario, targetId: string, theme: CaptureTheme, slot: number): number {
  const scores = scenario.scores
  if (typeof scores === 'function') return scores(targetId, theme, slot)
  return scores?.[slot - 1] ?? 90
}

function assessment(score: number, overrides: Partial<VisualAssessment> = {}): VisualAssessment {
  return {
    targetVisible: true,
    imagesRead: true,
    scores: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, score])) as VisualAssessment['scores'],
    reasons: ['The host contribution is visibly present.', 'Spacing and hierarchy are clear.'],
    ...overrides
  }
}

function issueCell(issue: NonNullable<ReviewReport['issues']>[number]): string {
  return `${issue.targetId ?? ''}\0${issue.theme ?? ''}`
}

function responseReport(
  manifest: CaptureManifest,
  options: Record<string, unknown>,
  slot: number,
  scenario: Scenario,
  call: number,
  runId: string
): ReviewReport {
  const requested = (options.onlyCells as ReviewCellKey[] | undefined) ??
    manifest.captures.map(({ targetId, theme }) => ({ targetId, theme }))
  const captures: ReviewedCapture[] = []
  const issues: NonNullable<ReviewReport['issues']> = []
  for (const [cellIndex, key] of requested.entries()) {
    const capture = manifest.captures.find((item) => item.targetId === key.targetId && item.theme === key.theme)!
    const target = manifest.targets.find((item) => item.id === key.targetId)!
    const rawScore = scoreFor(scenario, key.targetId, key.theme, slot)
    const score = Number.isFinite(rawScore) ? rawScore : 90
    const context = hostContractContext(target, key.theme)
    const contextText = serializeContractContext(context)
    const reviewer = scenario.identity?.(slot, cellIndex) ?? {
      alias: 'gemini', provider: 'google', model: 'fixture-vision', family: 'google' as const
    }
    const captureReview: ReviewedCapture = {
      targetId: key.targetId,
      theme: key.theme,
      image: structuredClone(capture.image!),
      reference: structuredClone(capture.reference),
      reviewer,
      assessment: assessment(score),
      score: SCORE_DIMENSIONS.reduce((total, dimension) => total + score, 0) / SCORE_DIMENSIONS.length,
      passed: score >= 85,
      contractReview: {
        contextPath: join(String(options.outputDir), 'reviewer', `${artifactPrefix(key.targetId, key.theme, runId)}.context.json`),
        contextSha256: digest(Buffer.from(contextText, 'utf8')),
        audit: {
          contextSha256: digest(Buffer.from(contextText, 'utf8')),
          acknowledgedRuleIds: context.rules.map((rule) => rule.id).sort(),
          reasonChecks: assessment(score).reasons.map((_, reasonIndex) => ({
            reasonIndex,
            contractIds: [],
            conflictsWithContract: false,
            affectsScore: false
          })),
          conflicts: []
        }
      }
    }
    const injectedIssues = scenario.issue?.(key, slot) ?? []
    const cellIssues = injectedIssues.filter((issue) => issueCell(issue) === `${key.targetId}\0${key.theme}`)
    if (cellIssues.length > 0) issues.push(...cellIssues)
    else captures.push(captureReview)
  }
  const hasError = issues.length > 0
  const status: ReviewReport['status'] = hasError ? 'error' : captures.some((capture) => !capture.passed) ? 'failed' : 'passed'
  const report: ReviewReport = {
    schemaVersion: 1,
    createdAt: '2026-11-16T00:00:00.000Z',
    status,
    scope: manifest.scope,
    threshold: 85,
    authorFamily: 'openai',
    reviewerAlias: 'gemini',
    captures,
    failures: issues.map((issue) => issue.message),
    issues,
    selectedCells: requested
  }
  return scenario.mutate?.(report, { call, manifest, options }) ?? report
}

function dependencies(value: Fixture, scenario: Scenario = {}) {
  let reviewCall = 0
  let captureCall = 0
  const observed: Array<{ manifest: CaptureManifest; options: Record<string, unknown>; report: ReviewReport }> = []
  const captureOptions: CaptureOptions[] = []
  const base: HostGateDependencies = {
    repoRoot: value.root,
    sourceSnapshot: scenario.sourceSnapshot ?? (() => value.source),
    captureApplication: async (options) => {
      captureCall += 1
      captureOptions.push(options)
      expect(options.only).toEqual([...HOST_TARGET_IDS])
      expect(options.themes).toEqual(['dark', 'light'])
      expect(options.skipBuild).toBe(false)
      expect(options.repoRoot).toBe(value.root)
      return value.manifest
    },
    reviewManifest: async (manifest, options) => {
      reviewCall += 1
      if (scenario.reviewThrows?.(reviewCall)) throw new Error('Could not start pi-watch reviewer.')
      const record = { manifest, options: options as unknown as Record<string, unknown> }
      const slot = Number(String(options.outputDir).match(/slot-(\d+)/)?.[1] ?? 1)
      const runId = randomUUID()
      const requested = options.onlyCells ?? manifest.captures.map(({ targetId, theme }) => ({ targetId, theme }))
      const report = responseReport(manifest, record.options, slot, scenario, reviewCall, runId)
      await persistFakeReviewArtifacts(value, options.outputDir, report, runId, requested, scenario.preflightIdentity)
      await scenario.onReview?.({ ...record, call: reviewCall, output: options.outputDir })
      observed.push({ ...record, report })
      return report
    },
    ...scenario.io,
    ...(scenario.signals ? { signals: scenario.signals } : {})
  }
  return {
    deps: base,
    observed,
    captureCalls: () => captureCall,
    captureOptions,
    reviewCalls: () => reviewCall
  }
}

async function persistFakeReviewArtifacts(
  value: Fixture,
  output: string,
  report: ReviewReport,
  runId: string,
  requested: readonly ReviewCellKey[],
  preflightIdentity: Scenario['preflightIdentity']
): Promise<void> {
  const reviewerDir = join(output, 'reviewer')
  mkdirSync(reviewerDir, { recursive: true, mode: 0o700 })
  const preflight = preflightIdentity === undefined
    ? { provider: 'google', model: 'fixture-vision', family: 'google' }
    : preflightIdentity
  for (const cell of requested) {
    const target = value.manifest.targets.find((item) => item.id === cell.targetId)!
    const context = hostContractContext(target, cell.theme)
    const contextBytes = Buffer.from(serializeContractContext(context), 'utf8')
    const prefix = artifactPrefix(cell.targetId, cell.theme, runId)
    const contextPath = join(reviewerDir, `${prefix}.context.json`)
    const responsePath = join(reviewerDir, `${prefix}.response.txt`)
    const capture = report.captures.find((entry) => entry.targetId === cell.targetId && entry.theme === cell.theme)
    const issue = report.issues?.find((entry) => entry.targetId === cell.targetId && entry.theme === cell.theme)
    const logPath = join(reviewerDir, `${prefix}.log.txt`)
    putPrivateFile(contextPath, contextBytes)
    putPrivateFile(responsePath, capture ? JSON.stringify({ assessment: capture.assessment, contractAudit: capture.contractReview?.audit }) : issue?.message ?? '')
    putPrivateFile(logPath, JSON.stringify({
      targetId: cell.targetId,
      theme: cell.theme,
      identity: capture ? { provider: capture.reviewer.provider, model: capture.reviewer.model, family: capture.reviewer.family } : null,
      preflight,
      contextPath,
      contextSha256: digest(contextBytes),
      audit: capture?.contractReview?.audit ?? null
    }))
  }
  putPrivateFile(join(reviewerDir, `review-report-${runId}.json`), `${JSON.stringify(report, null, 2)}\n`)
}

function args(output: string, extra: string[] = []): string[] {
  return ['--author-family', 'openai', '--reviewer', 'gemini', '--output', output, ...extra]
}

async function run(value: Fixture, scenario: Scenario = {}) {
  const harness = dependencies(value, scenario)
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await runHostGate(args(value.output, scenario.browser ? ['--browser', scenario.browser] : []), {
    ...harness.deps,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line)
  } as HostGateDependencies)
  return { ...harness, exitCode, stdout, stderr }
}

type GateOutput = {
  status: string
  threshold: number
  sampleCount: number
  capture: { commit: string | null; sourceDigest: string | null }
  reviewerIdentity: ReviewerIdentity | null
  attempts: Array<{
    id: string
    slot: number
    requestedCells: ReviewCellKey[]
    retryOf: string | null
    reportPath: string | null
    artifactPaths: string[]
    issues: Array<{ code: string; message: string }>
    preflightIdentities: Array<{ targetId: string; theme: CaptureTheme; identity: { provider: string; model: string; family: string } | 'unknown' }>
  }>
  cells: Array<{
    targetId: string
    theme: CaptureTheme
    slots: Array<{ score: number | null; status: string; issues: Array<{ code: string }> }>
    median: number | null
    status: string
  }>
  failures: string[]
}
function reportAt(value: Fixture): GateOutput {
  return JSON.parse(readFileSync(join(value.output, 'host-gate.json'), 'utf8')) as GateOutput
}
function assertGateExit(value: Fixture, actual: number, expected: number): void {
  if (actual === expected) return
  const report = reportAt(value)
  const diagnostic = {
    status: report.status,
    failures: report.failures,
    attempts: report.attempts.map(({ slot, requestedCells, retryOf, issues }) => ({ slot, requestedCells, retryOf, issues })),
    cells: report.cells.map(({ targetId, theme, median, slots }) => ({
      targetId,
      theme,
      median,
      slots: slots.map(({ score, status, issues }) => ({ score, status, issues }))
    }))
  }
  throw new Error(`Expected host-gate exit ${expected}, got ${actual}.\n${JSON.stringify(diagnostic, null, 2)}`)
}

describe('host gate', () => {
  test('help is standalone and does not touch capture, source, or output', async () => {
    let touched = false
    const lines: string[] = []
    const exitCode = await runHostGate(['--help'], {
      captureApplication: async () => { touched = true; throw new Error('capture should not run') },
      sourceSnapshot: () => { touched = true; throw new Error('source should not run') },
      stdout: (line: string) => lines.push(line),
      stderr: () => { touched = true }
    } as HostGateDependencies)
    expect(exitCode).toBe(0)
    expect(touched).toBe(false)
    expect(lines.join('\n')).toContain('--author-family')
    expect(lines.join('\n')).toContain('--output')
    expect(lines.join('\n')).toContain('three independent')
  })

  test('captures the five targets in both themes once, then records three independent complete slots', async () => {
    const value = fixture()
    const result = await run(value, {
      onReview: ({ call }) => {
        if (call === 1) value.manifest.createdAt = 'mutated after capture'
      }
    })
    const record = reportAt(value)

    expect(result.exitCode).toBe(0)
    expect(result.captureCalls()).toBe(1)
    expect(result.captureOptions[0]).toMatchObject({ skipBuild: false, timeoutMs: CAPTURE_TIMEOUT_MS, themes: ['dark', 'light'] })
    expect(result.reviewCalls()).toBe(3)
    expect(result.observed.map(({ options }) => options.onlyCells)).toEqual([undefined, undefined, undefined])
    expect(result.observed.every(({ options }) => options.timeoutMs === REVIEW_TIMEOUT_MS)).toBe(true)
    expect(result.observed.every(({ manifest }) => manifest.createdAt === '2026-11-16T00:00:00.000Z')).toBe(true)
    const expectedCells = HOST_TARGET_IDS.flatMap((targetId) => THEMES.map((theme) => `${targetId}\0${theme}`))
    expect(result.observed.every(({ manifest }) =>
      manifest.captures.map(({ targetId, theme }) => `${targetId}\0${theme}`).sort().join('\n') === expectedCells.slice().sort().join('\n')
    )).toBe(true)
    expect(record).toMatchObject({ schemaVersion: 1, status: 'passed', threshold: 85, sampleCount: 3 })
    expect(record.cells).toHaveLength(10)
    expect(record.cells.every((cell) => cell.slots.length === 3 && cell.median === 90)).toBe(true)
    expect(record.capture.commit).toBe(value.manifest.commit)
    expect(record.capture.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(value.output, 'capture-manifest.json'))).toBe(true)
    expect(existsSync(join(value.output, 'host-gate.md'))).toBe(true)
    expect(lstatSync(value.output).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(value.output, 'host-gate.json')).mode & 0o777).toBe(0o600)
    expect(record.attempts).toHaveLength(3)
    expect(record.attempts.every((attempt) => attempt.reportPath !== null &&
      attempt.artifactPaths.includes(attempt.reportPath) &&
      attempt.artifactPaths.filter((path) => path.endsWith('.context.json')).length === 10 &&
      attempt.artifactPaths.filter((path) => path.endsWith('.response.txt')).length === 10 &&
      attempt.artifactPaths.filter((path) => path.endsWith('.log.txt')).length === 10 &&
      attempt.artifactPaths.every((path) => existsSync(join(value.output, path))
    ))).toBe(true)
    const rawReport = record.attempts[0]!.artifactPaths.find((path) => /review-report-[0-9a-f-]{36}\.json$/i.test(path))!
    expect(JSON.parse(readFileSync(join(value.output, rawReport), 'utf8'))).toHaveProperty('captures')
    const contextArtifact = record.attempts[0]!.artifactPaths.find((path) => path.endsWith('.context.json'))!
    const firstTarget = value.manifest.targets.find((target) => target.id === HOST_TARGET_IDS[0])!
    expect(readFileSync(join(value.output, contextArtifact), 'utf8'))
      .toBe(serializeContractContext(hostContractContext(firstTarget, 'dark')))
  })

  test('uses exact medians without rounding and never samples a fourth valid response', async () => {
    for (const [scores, expectedStatus, expectedMedian] of [
      [[84, 85, 86], 'passed', 85],
      [[84, 84, 100], 'failed', 84],
      [[84.999, 84.999, 100], 'failed', 84.999]
    ] as const) {
      const value = fixture()
      const result = await run(value, { scores: [...scores] })
      const record = reportAt(value)
      expect(result.exitCode).toBe(expectedStatus === 'passed' ? 0 : 1)
      expect(record.status).toBe(expectedStatus)
      expect(record.cells.every((cell) => cell.median === expectedMedian)).toBe(true)
      expect(result.reviewCalls()).toBe(3)
    }
  })

  test('rejects incomplete, duplicate, foreign and padded report cells before a score can enter the median', async () => {
    for (const mutate of [
      (report: ReviewReport) => { report.captures.pop() },
      (report: ReviewReport) => { report.captures.push(structuredClone(report.captures[0]!)) },
      (report: ReviewReport) => { report.captures[0]!.targetId = 'host:foreign' },
      (report: ReviewReport) => { report.captures.push({ ...report.captures[0]!, targetId: 'host:foreign' }) }
    ]) {
      const value = fixture()
      const result = await run(value, { mutate: (report) => { mutate(report); return report } })
      const record = reportAt(value)
      expect(result.exitCode).toBe(2)
      expect(record.status).toBe('error')
      expect(record.cells.some((cell) => cell.median !== null)).toBe(false)
    }
  })

  test('rejects malformed numeric evidence, inconsistent dimension means and status claims', async () => {
    const corruptions: Array<(capture: ReviewedCapture) => void> = [
      (capture) => { capture.assessment.scores.palette = Number.NaN },
      (capture) => { capture.assessment.scores.palette = Number.POSITIVE_INFINITY },
      (capture) => { capture.assessment.scores.palette = -0.01 },
      (capture) => { capture.assessment.scores.palette = 100.01 },
      (capture) => { capture.assessment.scores.palette = 75 },
      (capture) => { capture.score = capture.score - 1 },
      (capture) => { capture.passed = !capture.passed }
    ]
    for (const corrupt of corruptions) {
      const value = fixture()
      const result = await run(value, { mutate: (report) => { corrupt(report.captures[0]!); return report } })
      expect(result.exitCode).toBe(2)
      expect(reportAt(value).cells.some((cell) => cell.median !== null)).toBe(false)
    }
  })

  test('requires exact capture geometry and approved evidence identity before dispatch', async () => {
    const mutations: Array<(value: Fixture) => void> = [
      (value) => { value.manifest.viewport.width = 1399 },
      (value) => { value.manifest.commit = 'different-capture-head' },
      (value) => { value.manifest.captures[0]!.image!.sha256 = '0'.repeat(64) },
      (value) => { value.manifest.captures[0]!.reference.path = join(value.root, 'foreign-golden.png') },
      (value) => { value.manifest.captures[0]!.status = 'failed'; value.manifest.failures.push('capture failed') },
      (value) => { value.manifest.targets.push({ id: 'host:extra', plugin: null, title: 'Foreign', kind: 'host' }) },
      (value) => { value.manifest.captures.pop() },
      (value) => { value.manifest.captures.push(structuredClone(value.manifest.captures[0]!)) }
    ]
    for (const mutate of mutations) {
      const value = fixture()
      mutate(value)
      let calls = 0
      const harness = dependencies(value)
      harness.deps.reviewManifest = async () => { calls += 1; throw new Error('review must not dispatch') }
      const exitCode = await runHostGate(args(value.output), { ...harness.deps } as HostGateDependencies)
      expect(exitCode).toBe(2)
      expect(calls).toBe(0)
    }
  })

  test('detects changed image, golden, context, manifest and source before acceptance', async () => {
    const changes: Array<(value: Fixture, context: { call: number; options: Record<string, unknown> }) => void> = [
      (value) => putFile(value.manifest.captures[0]!.image!.path, pngBytes(dimensions.width, dimensions.height, 9)),
      (value) => putFile(value.manifest.captures[0]!.reference.path, pngBytes(dimensions.width, dimensions.height, 9)),
      (_value, context) => {
        const reviewerDir = join(String(context.options.outputDir), 'reviewer')
        const contextName = readdirSync(reviewerDir).find((name) => name.endsWith('.context.json'))!
        putFile(join(reviewerDir, contextName), '{}')
      },
      (value) => putFile(join(value.output, 'capture-manifest.json'), '{}')
    ]
    for (const change of changes) {
      const value = fixture()
      const result = await run(value, { onReview: (context) => change(value, context) })
      expect(result.exitCode).toBe(2)
      expect(reportAt(value).status).toBe('error')
      expect(reportAt(value).cells.every((cell) => cell.median === null)).toBe(true)
    }

    const sourceFixture = fixture()
    let sourceReads = 0
    const sourceResult = await run(sourceFixture, {
      sourceSnapshot: () => {
        sourceReads += 1
        return sourceReads > 1 ? { ...sourceFixture.source, sourceDigest: 'b'.repeat(64) } : sourceFixture.source
      }
    })
    expect(sourceResult.exitCode).toBe(2)
    expect(sourceReads).toBeGreaterThan(1)

    const manifestFixture = fixture()
    const manifestResult = await run(manifestFixture, {
      mutate: (report, { call }) => {
        if (call === 3) report.scope = 'full'
        return report
      }
    })
    expect(manifestResult.exitCode).toBe(2)
  })
  test('rechecks the checked-in contract implementation during the campaign', async () => {
    const value = fixture()
    const contractPath = fileURLToPath(new URL('./host-contracts.ts', import.meta.url))
    let contractReads = 0
    const result = await run(value, {
      io: {
        readFile: async (path) => {
          if (path === contractPath && ++contractReads > 1) return Buffer.from('changed trusted contract implementation')
          return readFileSync(path)
        }
      }
    })
    expect(result.exitCode).toBe(2)
    expect(contractReads).toBeGreaterThan(1)
    expect(result.reviewCalls()).toBe(0)
    expect(reportAt(value).status).toBe('error')
  })

  test('invalidates stored medians when the source snapshot changes after the final slot', async () => {
    const value = fixture()
    let sourceReads = 0
    const result = await run(value, {
      sourceSnapshot: () => {
        sourceReads += 1
        return sourceReads < 6 ? value.source : { ...value.source, sourceDigest: 'c'.repeat(64) }
      }
    })
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(sourceReads).toBe(6)
    expect(report.status).toBe('error')
    expect(report.cells.every((cell) => cell.median === null && cell.status === 'invalid')).toBe(true)
  })

  test('detects prior reviewer artifact mutation before campaign acceptance', async () => {
    const value = fixture()
    const result = await run(value, {
      onReview: ({ call }) => {
        if (call !== 2) return
        const reviewerDir = join(value.output, 'attempts', 'slot-1', 'attempt-1', 'reviewer')
        const reportName = readdirSync(reviewerDir).find((name) => name.startsWith('review-report-'))!
        putFile(join(reviewerDir, reportName), '{}')
      }
    })
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(result.reviewCalls()).toBe(2)
    expect(report.status).toBe('error')
    expect(report.cells.every((cell) => cell.median === null)).toBe(true)
  })

  test('a detected context artifact association mismatch blocks samples without retrying', async () => {
    const value = fixture()
    const missingContext = join(value.root, 'missing-context.json')
    const result = await run(value, {
      mutate: (report) => {
        report.captures[0]!.contractReview!.contextPath = missingContext
        return report
      }
    })
    assertGateExit(value, result.exitCode, 2)
    const report = reportAt(value)
    const affected = report.cells.find((cell) => cell.targetId === 'host:shell' && cell.theme === 'dark')!
    expect(result.reviewCalls()).toBe(1)
    expect(report.status).toBe('error')
    expect(affected.status).toBe('invalid')
    expect(affected.median).toBeNull()
    expect(affected.slots[0]).toMatchObject({ status: 'invalid', score: null })
    expect(affected.slots[0]!.issues).toContainEqual(expect.objectContaining({ code: 'persistence' }))
    const attempt = report.attempts[0]!
    expect(attempt.issues).toContainEqual(expect.objectContaining({
      code: 'persistence',
      message: expect.stringContaining('context path does not match its run-ID artifact')
    }))
    expect(attempt.artifactPaths.every((path) => existsSync(join(value.output, path)))).toBe(true)
    expect(attempt.artifactPaths.filter((path) => path.endsWith('.context.json'))).toHaveLength(10)
    const raw = JSON.parse(readFileSync(join(value.output, attempt.reportPath!), 'utf8')) as ReviewReport
    expect(raw.captures[0]!.contractReview!.contextPath).toBe(missingContext)
    expect(raw.status).toBe('passed')
    expect(raw.issues).toEqual([])
    expect(existsSync(missingContext)).toBe(false)
  })

  test('uses canonical artifact paths with a real reviewer behind a symlinked output parent', async () => {
    const value = fixture()
    const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
    const initialInventory = collectInventory(repoRoot)
    value.root = repoRoot
    value.manifest.commit = initialInventory.commit
    for (const capture of value.manifest.captures) {
      const path = goldenFor(capture.targetId, capture.theme, repoRoot)
      capture.reference = { path, sha256: digest(readFileSync(path)) }
    }

    const scratch = root()
    const realParent = join(scratch, 'real-output-parent')
    const aliasParent = join(scratch, 'aliased-output-parent')
    mkdirSync(realParent)
    symlinkSync(realParent, aliasParent)
    value.output = join(aliasParent, 'fresh-output')
    const reviewerExecutable = join(scratch, 'fake-pi-watch.cjs')
    writeFileSync(reviewerExecutable, fakeHostGateReviewerSource(), { mode: 0o700 })
    chmodSync(reviewerExecutable, 0o700)

    const harness = dependencies(value)
    harness.deps.sourceSnapshot = () => {
      const inventory = collectInventory(repoRoot)
      return {
        repoRoot: inventory.repoRoot,
        commit: inventory.commit,
        sourceDigest: inventory.sourceDigest,
        dirty: inventory.dirty,
        failures: inventory.failures
      }
    }
    harness.deps.reviewManifest = (manifest, options) =>
      reviewManifest(manifest, { ...options, reviewerExecutable, timeoutMs: 2_000 })

    const exitCode = await runHostGate(args(value.output), harness.deps)
    assertGateExit(value, exitCode, 0)
    const report = reportAt(value)
    expect(report.status).toBe('passed')
    expect(report.cells).toHaveLength(10)
    expect(report.cells.every((cell) => cell.median === 90)).toBe(true)
    expect(report.attempts).toHaveLength(3)
  }, 30_000)

  test('validates visibility, imagesRead, contract acknowledgment, per-reason audits and nonretryable conflicts', async () => {
    const invalid: Array<(report: ReviewReport) => void> = [
      (report) => { report.captures[0]!.assessment.targetVisible = false },
      (report) => { report.captures[0]!.assessment.imagesRead = false },
      (report) => { report.captures[0]!.contractReview!.contextSha256 = '0'.repeat(64) },
      (report) => { report.captures[0]!.contractReview!.audit.acknowledgedRuleIds.pop() },
      (report) => { report.captures[0]!.contractReview!.audit.reasonChecks.pop() },
      (report) => { report.captures[0]!.contractReview!.audit.reasonChecks[0]!.reasonIndex = 99 },
      (report) => {
        report.captures[0]!.contractReview!.audit.conflicts.push({
          contractId: 'palette-selected-colors', reason: 'The selected description should be a different color.', affectsScore: true
        })
      }
    ]
    for (const corrupt of invalid) {
      const value = fixture()
      const result = await run(value, { mutate: (report) => { corrupt(report); return report } })
      expect(result.exitCode).toBe(2)
      expect(reportAt(value).cells.some((cell) => cell.median !== null)).toBe(false)
    }
  })

  test('preserves complete preflight identity and rejects author-family or switched reviewer identities', async () => {
    const sameFamily = fixture()
    const familyResult = await run(sameFamily, {
      identity: () => ({ alias: 'gemini', provider: 'openai', model: 'fixture', family: 'openai' })
    })
    expect(familyResult.exitCode).toBe(2)

    const switched = fixture()
    const identityResult = await run(switched, {
      identity: (_slot, cellIndex) => cellIndex === 0
        ? { alias: 'gemini', provider: 'google', model: 'fixture-a', family: 'google' }
        : { alias: 'gemini', provider: 'google', model: 'fixture-b', family: 'google' }
    })
    expect(identityResult.exitCode).toBe(2)

    const normal = fixture()
    const normalResult = await run(normal)
    expect(normalResult.exitCode).toBe(0)
    expect(reportAt(normal).reviewerIdentity).toMatchObject({ alias: 'gemini', provider: 'google', model: 'fixture-vision', family: 'google' })
    const logPath = reportAt(normal).attempts[0]!.artifactPaths.find((path) => path.endsWith('.log.txt'))
    expect(logPath).toBeDefined()
    expect(JSON.parse(readFileSync(join(normal.output, logPath!), 'utf8')).preflight)
      .toEqual({ provider: 'google', model: 'fixture-vision', family: 'google' })
  })

  test('records unavailable reviewer preflight identity as unknown without fabricating it', async () => {
    const value = fixture()
    const result = await run(value, { preflightIdentity: null })
    expect(result.exitCode).toBe(0)
    expect(reportAt(value).attempts[0]!.preflightIdentities.every((entry) => entry.identity === 'unknown')).toBe(true)
  })

  test('retries each response-shape category once in a fresh linked attempt using the full manifest', async () => {
    const categories = [
      'unparseable JSON', 'unknown or missing keys', 'wrong types', 'wrong or missing context digest',
      'omitted, duplicate or unknown acknowledgments', 'missing, duplicate or out-of-range reason audits'
    ]
    for (const _category of categories) {
      const value = fixture()
      const retryKey = { targetId: 'host:shell', theme: 'dark' as const }
      const calls: Array<{ output: string; onlyCells: unknown; manifest: CaptureManifest }> = []
      let injectShapeFailure = true
      const harness = dependencies(value, {
        issue: (cell, slot) => {
          if (cell.targetId !== retryKey.targetId || cell.theme !== retryKey.theme || slot !== 1 || !injectShapeFailure) return undefined
          injectShapeFailure = false
          return [{ ...retryKey, code: 'response-shape', message: `invalid response: ${_category}` }]
        },
        onReview: ({ output, options, manifest }) => { calls.push({ output, onlyCells: options.onlyCells, manifest }) }
      })
      const exitCode = await runHostGate(args(value.output), harness.deps)
      assertGateExit(value, exitCode, 0)
      expect(calls).toHaveLength(4)
      const retryCalls = calls.filter((call) => Array.isArray(call.onlyCells) && call.onlyCells.length === 1)
      expect(retryCalls).toHaveLength(1)
      expect(retryCalls[0]!.onlyCells).toEqual([retryKey])
      expect(calls.every(({ manifest }) =>
        manifest.captures.length === 10 && manifest.scope === value.manifest.scope
      )).toBe(true)
      expect(retryCalls[0]!.output).not.toEqual(calls[0]!.output)
    }
  })
  test('retries a process-start failure once for each unattempted cell', async () => {
    const value = fixture()
    const result = await run(value, { reviewThrows: (call) => call === 1 })
    const report = reportAt(value)
    const slotOne = report.attempts.filter((attempt) => attempt.slot === 1)
    assertGateExit(value, result.exitCode, 0)
    expect(result.reviewCalls()).toBe(13)
    expect(slotOne).toHaveLength(11)
    expect(slotOne[0]!.requestedCells).toHaveLength(10)
    expect(slotOne[0]!.issues[0]?.code).toBe('operational')
    expect(slotOne.slice(1).every((attempt) => attempt.requestedCells.length === 1 && attempt.retryOf === slotOne[0]!.id)).toBe(true)
  })

  test('shares one replacement across operational and response-shape failures in either order', async () => {
    for (const codes of [
      ['operational', 'response-shape'], ['response-shape', 'operational'], ['operational', 'operational'], ['response-shape', 'response-shape']
    ] as const) {
      const value = fixture()
      const target = 'host:shell'
      let retryCount = 0
      const issue = (cell: { targetId: string; theme: CaptureTheme }, slot: number) => {
        if (cell.targetId !== target || cell.theme !== 'dark' || slot !== 1) return undefined
        retryCount += 1
        const code = codes[retryCount - 1]
        return code ? [{ ...cell, code, message: `attempt ${retryCount}` }] : undefined
      }
      const result = await run(value, { issue })
      assertGateExit(value, result.exitCode, codes[1] ? 2 : 0)
      const attempts = reportAt(value).attempts.filter((attempt) => attempt.slot === 1 &&
        attempt.requestedCells.some((cell) => cell.targetId === target && cell.theme === 'dark'))
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.retryOf).toBe(attempts[0]!.id)
      expect(result.reviewCalls()).toBe(codes[1] ? 2 : 4)
      if (codes[1]) expect(reportAt(value).cells.find((cell) => cell.targetId === target && cell.theme === 'dark')!.median).toBeNull()
    }
  })

  test('allows one replacement for the same cell independently in each slot', async () => {
    const value = fixture()
    const retryKey = { targetId: 'host:shell', theme: 'dark' as const }
    const failedSlots = new Set<number>()
    const result = await run(value, {
      issue: (cell, slot) => {
        if (cell.targetId !== retryKey.targetId || cell.theme !== retryKey.theme ||
            (slot !== 1 && slot !== 2) || failedSlots.has(slot)) return undefined
        failedSlots.add(slot)
        return [{ ...retryKey, code: 'response-shape', message: `invalid response in slot ${slot}` }]
      }
    })
    const report = reportAt(value)
    assertGateExit(value, result.exitCode, 0)
    expect(result.reviewCalls()).toBe(5)
    expect(report.attempts).toHaveLength(5)
    for (const slot of [1, 2]) {
      const attempts = report.attempts.filter((attempt) => attempt.slot === slot)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.requestedCells).toEqual([retryKey])
      expect(attempts[1]!.retryOf).toBe(attempts[0]!.id)
    }
    expect(report.attempts.filter((attempt) => attempt.slot === 3)).toHaveLength(1)
    expect(report.cells.find((cell) => cell.targetId === retryKey.targetId && cell.theme === retryKey.theme)!.slots
      .map((slot) => slot.status)).toEqual(['valid', 'valid', 'valid'])
  })

  test('keeps low-score siblings final while retrying only the eligible failed cell', async () => {
    const value = fixture()
    const low = { targetId: 'host:scoped', theme: 'light' as const }
    const retry = { targetId: 'host:palette', theme: 'dark' as const }
    let retryCount = 0
    const result = await run(value, {
      scores: (target, theme) => target === low.targetId && theme === low.theme ? 84 : 90,
      issue: (cell, slot) => {
        if (slot === 1 && cell.targetId === retry.targetId && cell.theme === retry.theme && retryCount++ === 0) {
          return [{ ...cell, code: 'response-shape', message: 'bad envelope' }]
        }
        return undefined
      }
    })
    assertGateExit(value, result.exitCode, 1)
    expect(result.reviewCalls()).toBe(4)
    const record = reportAt(value)
    expect(record.cells.find((cell) => cell.targetId === low.targetId && cell.theme === low.theme)!.slots).toHaveLength(3)
    expect(record.cells.find((cell) => cell.targetId === low.targetId && cell.theme === low.theme)!.median).toBe(84)
    expect(record.attempts.filter((attempt) => attempt.requestedCells.some((cell) => cell.targetId === low.targetId && cell.theme === low.theme))).toHaveLength(3)
    expect(record.attempts.filter((attempt) => attempt.requestedCells.some((cell) => cell.targetId === retry.targetId && cell.theme === retry.theme))).toHaveLength(4)
  })

  test('nonretryable evidence, conflict, identity, persistence, usage and cancellation issues beat shape failures', async () => {
    const hardFailures = ['invalid-sample', 'contract-conflict', 'evidence-changed', 'identity-mismatch', 'persistence', 'aborted', 'usage-limit'] as const
    for (const code of hardFailures) {
      const value = fixture()
      const target = { targetId: 'host:shell', theme: 'dark' as const }
      const result = await run(value, {
        issue: (cell, slot) => cell.targetId === target.targetId && cell.theme === target.theme && slot === 1
          ? [
              { ...target, code: 'response-shape', message: 'shape also failed' },
              { ...target, code, message: `${code} is terminal` }
            ]
          : undefined
      })
      expect(result.exitCode).toBe(2)
      expect(result.reviewCalls()).toBe(1)
      expect(reportAt(value).attempts.filter((attempt) => attempt.requestedCells.some((entry) => entry.targetId === target.targetId && entry.theme === target.theme))).toHaveLength(1)
    }
  })

  test('refuses existing output paths and symlinks without overwriting them', async () => {
    const existing = fixture()
    mkdirSync(existing.output)
    putFile(join(existing.output, 'keep.txt'), 'keep')
    const existingCalls = dependencies(existing)
    expect(await runHostGate(args(existing.output), existingCalls.deps)).toBe(2)
    expect(readFileSync(join(existing.output, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existingCalls.reviewCalls()).toBe(0)

    const linked = fixture()
    const real = join(linked.root, 'real-output')
    mkdirSync(real)
    symlinkSync(real, linked.output)
    expect(await runHostGate(args(linked.output), dependencies(linked).deps)).toBe(2)
    expect(existsSync(join(real, 'host-gate.json'))).toBe(false)
  })

  test('cancellation stops scheduling, persists partial records and returns conventional signal status', async () => {
    for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const value = fixture()
      const listeners = new Map<string, () => void>()
      const signals = {
        on: (name: string, listener: () => void) => { listeners.set(name, listener) },
        off: (name: string) => { listeners.delete(name) }
      }
      const harness = dependencies(value, {
        signals,
        onReview: ({ call }) => { if (call === 2) listeners.get(signal)?.() }
      })
      const exitCode = await runHostGate(args(value.output), harness.deps)
      const report = reportAt(value)
      expect(exitCode).toBe(expected)
      expect(harness.reviewCalls()).toBe(2)
      expect(report.status).toBe('error')
      expect(report.cells).toHaveLength(10)
      expect(report.cells.every((cell) => cell.median === null &&
        cell.slots[0]!.status === 'valid' && cell.slots[1]!.status === 'valid' && cell.slots[2]!.status === 'missing'
      )).toBe(true)
      expect(listeners.size).toBe(0)
    }
  })

  test('records Markdown persistence failure in the authoritative JSON verdict', async () => {
    const value = fixture()
    const result = await run(value, {
      io: {
        writeFile: async (path, contents, options) => {
          if (path.endsWith('host-gate.md')) throw new Error('Injected Markdown persistence failure.')
          writeFileSync(path, contents, options)
        }
      }
    })
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(report.status).toBe('error')
    expect(report.failures.some((failure) => failure.includes('Could not persist host-gate.md'))).toBe(true)
    expect(existsSync(join(value.output, 'host-gate.md'))).toBe(false)
  })

  test('only accepts the documented CLI options and forwards an explicit browser executable', async () => {
    const value = fixture()
    const result = await run(value, { browser: '/browser/chromium' })
    expect(result.exitCode).toBe(0)
    expect(result.observed).toHaveLength(3)

    const invalid = fixture()
    expect(await runHostGate(args(invalid.output, ['--threshold', '84']), dependencies(invalid).deps)).toBe(2)
    const invalidSampleCount = fixture()
    expect(await runHostGate(args(invalidSampleCount.output, ['--samples', '4']), dependencies(invalidSampleCount).deps)).toBe(2)
    expect(existsSync(invalidSampleCount.output)).toBe(false)
    expect(existsSync(invalid.output)).toBe(false)
  })
})
