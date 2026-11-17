import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPTURE_TIMEOUT_MS, REVIEW_TIMEOUT_MS } from './arguments'
import { hostContractContext, serializeContractContext } from './host-contracts'
import { runPluginGate, type PluginGateDependencies } from './plugin-gate'
import { goldenFor, SCREENSHOT_SIZE, VIEWPORT } from './goldens'
import { SCORE_DIMENSIONS, THEMES, type CaptureManifest, type CaptureOptions, type CaptureTarget, type CaptureTheme, type ContributionInventory, type ReviewCellKey, type ReviewIssue, type ReviewOptions, type ReviewReport, type ReviewedCapture, type ReviewerIdentity, type VisualAssessment } from './contracts'
import { reviewManifest } from './review'
import type { Inventory, PluginInventory } from '../ui-scoreboard/contracts'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const HOST_TARGETS: CaptureTarget[] = [
  { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' },
  { id: 'host:scoped', plugin: null, title: 'Scoped', kind: 'host' },
  { id: 'host:popups', plugin: null, title: 'Popups', kind: 'host' },
  { id: 'host:settings', plugin: null, title: 'Settings', kind: 'host' },
  { id: 'host:palette', plugin: null, title: 'Palette', kind: 'host' }
]
const REVIEWER: ReviewerIdentity = { alias: 'gemini', provider: 'google', model: 'fixture-vision', family: 'google' }
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-gate-'))
  tempRoots.push(root)
  return root
}

function pngBytes(width = SCREENSHOT_SIZE.width, height = SCREENSHOT_SIZE.height, marker = 0): Buffer {
  const bytes = Buffer.alloc(33 + marker)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function target(kind: CaptureTarget['kind'], plugin: string, suffix: string): CaptureTarget {
  return { id: `${kind}:${plugin}/${suffix}`, plugin, title: `${plugin} ${suffix}`, kind }
}

function inventoryFixture(targetCounts: Record<string, number>, aliasPlugins: readonly string[] = []): Inventory {
  const projectedTargets: CaptureTarget[] = []
  const pluginTargets = new Map<string, CaptureTarget[]>()
  const toolAliases: ContributionInventory['toolAliases'] = []
  for (const [plugin, count] of Object.entries(targetCounts).sort(([left], [right]) => left.localeCompare(right))) {
    const declarations: CaptureTarget[] = []
    for (let index = 0; index < count; index++) {
      const body = target('view', plugin, `target-${index + 1}`)
      projectedTargets.push(body)
      declarations.push(body)
    }
    if (aliasPlugins.includes(plugin)) {
      const body = declarations[0]
      if (!body) throw new Error(`Alias fixture ${plugin} needs a rendered target.`)
      const declaration = target('sidebar-section', plugin, 'shortcut')
      declarations.push(declaration)
      toolAliases.push({ declaration, toolId: `panel:${plugin}/navigation-tool`, renderedTarget: body, reason: 'tool-navigation-alias' })
    }
    pluginTargets.set(plugin, declarations)
  }
  const declaredTargets = [...HOST_TARGETS, ...projectedTargets, ...toolAliases.map(({ declaration }) => declaration)]
    .sort((left, right) => left.id.localeCompare(right.id))
  const contributionInventory: ContributionInventory = { declaredTargets, toolAliases }
  const plugins: PluginInventory[] = [...pluginTargets].map(([id, declarations]) => ({
    id,
    directory: `plugins/${id}`,
    hasUi: declarations.length > 0,
    targets: declarations.map(({ id: targetId }) => targetId).sort(),
    sources: []
  }))
  return {
    repoRoot: REPO_ROOT,
    commit: 'fixture-main-commit',
    sourceDigest: 'a'.repeat(64),
    dirty: false,
    plugins,
    targets: [...HOST_TARGETS, ...projectedTargets],
    contributionInventory,
    sharedSources: [],
    exclusions: [],
    failures: []
  }
}

function scopedContributions(source: ContributionInventory, targetIds: ReadonlySet<string>): ContributionInventory {
  const toolAliases = source.toolAliases.filter(({ renderedTarget }) => targetIds.has(renderedTarget.id))
  const declaredTargets = source.declaredTargets.filter(({ id }) =>
    targetIds.has(id) || toolAliases.some(({ declaration }) => declaration.id === id)
  )
  return { declaredTargets, toolAliases }
}

type Fixture = {
  root: string
  output: string
  repoRoot: string
  inventory: Inventory
  manifest: CaptureManifest
  captureBytes: string | null
  captureDirectory: string | null
}

function fixture(
  targetCounts: Record<string, number> = { alpha: 1 },
  options: { aliases?: readonly string[]; failedCells?: readonly ReviewCellKey[] } = {}
): Fixture {
  const root = tempRoot()
  const inventory = inventoryFixture(targetCounts, options.aliases)
  const targets = inventory.targets.filter(({ plugin }) => plugin !== null)
  const targetIds = new Set(targets.map(({ id }) => id))
  const captures: CaptureManifest['captures'] = targets.flatMap((entry, targetIndex) => THEMES.map((theme, themeIndex) => {
    const imagePath = join(root, 'images', `${digest(entry.id).slice(0, 12)}-${theme}.png`)
    const image = pngBytes(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height, targetIndex * 2 + themeIndex + 1)
    mkdirSync(dirname(imagePath), { recursive: true })
    writeFileSync(imagePath, image)
    const referencePath = goldenFor(entry.id, theme, REPO_ROOT)
    const reference = readFileSync(referencePath)
    return {
      targetId: entry.id,
      theme,
      image: { path: imagePath, sha256: digest(image) },
      reference: { path: referencePath, sha256: digest(reference) },
      status: 'captured' as const
    }
  }))
  for (const key of options.failedCells ?? []) {
    const capture = captures.find(({ targetId, theme }) => targetId === key.targetId && theme === key.theme)!
    capture.image = null
    capture.status = 'failed'
    capture.error = 'fixture screenshot failed'
  }
  const failures = (options.failedCells ?? []).map(({ targetId, theme }) => `${targetId} (${theme}): fixture screenshot failed`)
  const selectors = [...new Set(targets.map(({ plugin }) => plugin!))].sort()
  const manifest: CaptureManifest = {
    schemaVersion: 1,
    createdAt: '2026-11-16T00:00:00.000Z',
    commit: inventory.commit,
    surface: 'desktop-renderer',
    viewport: { ...VIEWPORT },
    scope: 'filtered',
    selectors,
    targets,
    captures,
    failures,
    contributionInventory: scopedContributions(inventory.contributionInventory!, targetIds)
  }
  return {
    root,
    output: join(root, 'fresh-output'),
    repoRoot: REPO_ROOT,
    inventory,
    manifest,
    captureBytes: null,
    captureDirectory: null
  }
}

function cellKey(targetId: string, theme: CaptureTheme): string {
  return `${targetId}\0${theme}`
}

function assessment(score: number, overrides: Partial<VisualAssessment> = {}): VisualAssessment {
  return {
    targetVisible: true,
    imagesRead: true,
    scores: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, score])) as VisualAssessment['scores'],
    reasons: ['The plugin contribution is visible.', 'Both images were read and compared.'],
    ...overrides
  }
}

function artifactPrefix(targetId: string, theme: CaptureTheme, runId: string): string {
  const targetHash = createHash('sha256').update(targetId).digest('hex').slice(0, 20)
  return `capture-${targetHash}-${theme}-${runId}`
}

function writePrivate(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
}

type Scenario = {
  scores?: number | ((targetId: string, theme: CaptureTheme, slot: number) => number)
  issue?: (key: ReviewCellKey, slot: number, attempt: number) => ReviewIssue[] | undefined
  mutate?: (report: ReviewReport, context: { key: ReviewCellKey; slot: number }) => ReviewReport
  captureError?: Error
}

type ObservedReview = { key: ReviewCellKey; slot: number; manifest: CaptureManifest; options: ReviewOptions; output: string }

function dependencies(value: Fixture, scenario: Scenario = {}) {
  let captureCalls = 0
  let reviewCalls = 0
  let clock = 0
  const captureOptions: CaptureOptions[] = []
  const observed: ObservedReview[] = []
  const nextSlot = new Map<string, number>()
  const attemptCounts = new Map<string, number>()
  const retryPending = new Set<string>()
  const stdout: string[] = []
  const stderr: string[] = []
  const signalListeners = new Map<string, () => void>()
  const deps: PluginGateDependencies = {
    repoRoot: value.repoRoot,
    inventory: () => structuredClone(value.inventory),
    capture: async (options) => {
      captureCalls += 1
      captureOptions.push(options)
      value.captureDirectory = options.outputDir
      mkdirSync(options.outputDir, { recursive: true, mode: 0o700 })
      value.captureBytes = `${JSON.stringify(value.manifest, null, 2)}\n`
      writePrivate(join(options.outputDir, 'capture-progress.json'), value.captureBytes)
      if (scenario.captureError) throw scenario.captureError
      return structuredClone(value.manifest)
    },
    review: async (manifest, options) => {
      reviewCalls += 1
      const requested = options.onlyCells ?? manifest.captures.map(({ targetId, theme }) => ({ targetId, theme }))
      const runId = randomUUID()
      const output = options.outputDir
      const reviewerDir = join(output, 'reviewer')
      mkdirSync(reviewerDir, { recursive: true, mode: 0o700 })
      const captures: ReviewedCapture[] = []
      const issues: ReviewIssue[] = []
      let primary = requested[0]!
      let primarySlot = 1
      for (const key of requested) {
        const id = cellKey(key.targetId, key.theme)
        const slot = nextSlot.get(id) ?? 1
        const attempt = (attemptCounts.get(id) ?? 0) + 1
        attemptCounts.set(id, attempt)
        primary = key
        primarySlot = slot
        const targetEntry = manifest.targets.find(({ id: targetId }) => targetId === key.targetId)!
        const capture = manifest.captures.find(({ targetId, theme }) => targetId === key.targetId && theme === key.theme)!
        const context = hostContractContext(targetEntry, key.theme)
        const contextText = serializeContractContext(context)
        const contextHash = digest(contextText)
        const prefix = artifactPrefix(key.targetId, key.theme, runId)
        const contextPath = join(reviewerDir, `${prefix}.context.json`)
        const score = typeof scenario.scores === 'function'
          ? scenario.scores(key.targetId, key.theme, slot)
          : scenario.scores ?? 90
        const visual = assessment(score)
        const audit = {
          contextSha256: contextHash,
          acknowledgedRuleIds: context.rules.map(({ id: ruleId }) => ruleId).sort(),
          reasonChecks: visual.reasons.map((_, reasonIndex) => ({
            reasonIndex, contractIds: [], conflictsWithContract: false, affectsScore: false
          })),
          conflicts: [] as Array<{ contractId: string; reason: string; affectsScore: boolean }>
        }
        const reviewer = { ...REVIEWER, alias: options.reviewerAlias }
        const reviewed: ReviewedCapture = {
          targetId: key.targetId,
          theme: key.theme,
          image: structuredClone(capture.image!),
          reference: structuredClone(capture.reference),
          reviewer,
          assessment: visual,
          score: SCORE_DIMENSIONS.reduce((sum, dimension) => sum + visual.scores[dimension], 0) / SCORE_DIMENSIONS.length,
          passed: score >= 85,
          contractReview: { contextPath, contextSha256: contextHash, audit }
        }
        const injected = scenario.issue?.(key, slot, attempt) ?? []
        const retryable = injected.length > 0 && injected.every(({ code }) => code === 'operational' || code === 'response-shape')
        if (injected.length > 0) {
          issues.push(...injected)
          if (retryable) retryPending.add(id)
        } else {
          captures.push(reviewed)
          nextSlot.set(id, slot + 1)
        }
        if (retryPending.has(id) && attempt > 1) retryPending.delete(id)
        writePrivate(contextPath, contextText)
        writePrivate(join(reviewerDir, `${prefix}.response.txt`), JSON.stringify({ assessment: visual, contractAudit: audit }))
        writePrivate(join(reviewerDir, `${prefix}.log.txt`), `${JSON.stringify({
          targetId: key.targetId,
          theme: key.theme,
          identity: reviewer,
          preflight: { provider: REVIEWER.provider, model: REVIEWER.model, family: REVIEWER.family },
          contextPath,
          contextSha256: contextHash,
          audit
        }, null, 2)}\n`)
      }
      const report: ReviewReport = {
        schemaVersion: 1,
        createdAt: '2026-11-16T00:00:00.000Z',
        status: issues.length > 0 ? 'error' : captures.some(({ passed }) => !passed) ? 'failed' : 'passed',
        scope: manifest.scope,
        threshold: 85,
        authorFamily: options.authorFamily,
        reviewerAlias: options.reviewerAlias,
        captures,
        failures: issues.map(({ message }) => message),
        issues,
        selectedCells: requested.map(({ targetId, theme }) => ({ targetId, theme }))
      }
      const result = scenario.mutate?.(report, { key: primary, slot: primarySlot }) ?? report
      for (const key of requested) {
        const targetEntry = manifest.targets.find(({ id: targetId }) => targetId === key.targetId)!
        const contextText = serializeContractContext(hostContractContext(targetEntry, key.theme))
        const sample = result.captures.find(({ targetId, theme }) => targetId === key.targetId && theme === key.theme)
        const issue = result.issues?.find(({ targetId, theme }) => targetId === key.targetId && theme === key.theme)
        const prefix = artifactPrefix(key.targetId, key.theme, runId)
        const contextPath = sample?.contractReview?.contextPath ?? join(reviewerDir, `${prefix}.context.json`)
        const contextHash = sample?.contractReview?.contextSha256 ?? digest(contextText)
        const audit = sample?.contractReview?.audit ?? null
        writeFileSync(join(reviewerDir, `${prefix}.context.json`), contextText)
        writeFileSync(join(reviewerDir, `${prefix}.response.txt`), sample
          ? JSON.stringify({ assessment: sample.assessment, contractAudit: audit })
          : issue?.message ?? '')
        writeFileSync(join(reviewerDir, `${prefix}.log.txt`), `${JSON.stringify({
          targetId: key.targetId,
          theme: key.theme,
          identity: sample?.reviewer ?? null,
          preflight: { provider: REVIEWER.provider, model: REVIEWER.model, family: REVIEWER.family },
          contextPath,
          contextSha256: contextHash,
          audit
        }, null, 2)}\n`)
      }
      writePrivate(join(reviewerDir, `review-report-${runId}.json`), `${JSON.stringify(result, null, 2)}\n`)
      observed.push({ key: primary, slot: primarySlot, manifest, options, output })
      return result
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    signals: {
      on: (signal, listener) => { signalListeners.set(signal, listener) },
      off: (signal) => { signalListeners.delete(signal) }
    },
    now: () => ++clock
  }
  return {
    deps,
    captureOptions,
    observed,
    captureCalls: () => captureCalls,
    reviewCalls: () => reviewCalls,
    stdout,
    stderr,
    signalListeners
  }
}

function args(output: string, extra: string[] = []): string[] {
  return ['--author-family', 'openai', '--output', output, ...extra]
}

async function run(value: Fixture, scenario: Scenario = {}, extra: string[] = []) {
  const harness = dependencies(value, scenario)
  const exitCode = await runPluginGate(args(value.output, extra), harness.deps)
  return { ...harness, exitCode }
}

type GateAttempt = {
  id: string
  retryOf: string | null
  reportPath?: string | null
  reportSha256?: string | null
  artifacts?: Array<{ path: string; sha256: string }>
  preflightIdentity?: { provider: string; model: string; family: string } | null
  issues: ReviewIssue[]
  sample: ReviewedCapture | null
}

type GateReport = {
  schemaVersion: 1
  status: 'passed' | 'failed' | 'error'
  goalPassed: false
  threshold: 85
  sampleCount: 3
  counts: { completeValidCells: number }
  plugins: Array<{ id: string; targetIds: string[]; status: string }>
  cells: Array<{
    targetId: string
    plugin: string
    theme: CaptureTheme
    slots: Array<{ slot: number; score: number | null; attempts: GateAttempt[]; status?: string }>
    median: number | null
    range: number | null
    status: 'pass' | 'fail' | 'invalid'
  }>
  failures: Array<{ code: string; message: string; targetId?: string; theme?: CaptureTheme }>
  manifest: { path: string; sha256: string } | null
  reviewer?: ReviewerIdentity | null
  timing?: { initialReviewCalls: number; replacementReviewCalls: number; maxConcurrency: number }
  captureEvidence?: CaptureManifest['captures']
  activatedVisibilitySettings?: string[]
  targetManifests?: Array<{ targetId: string; path: string; sha256: string }>
}

function reportAt(value: Fixture): GateReport {
  return JSON.parse(readFileSync(join(value.output, 'plugin-gate.json'), 'utf8')) as GateReport
}

function cellAt(report: GateReport, targetId: string, theme: CaptureTheme): GateReport['cells'][number] {
  const cell = report.cells.find((entry) => entry.targetId === targetId && entry.theme === theme)
  if (!cell) throw new Error(`missing ${targetId} (${theme}) in plugin-gate.json`)
  return cell
}

function eventLatch() {
  let count = 0
  const waiters = new Map<number, Array<() => void>>()
  return {
    count: () => count,
    advance: () => {
      count += 1
      for (const [target, listeners] of waiters) {
        if (count < target) continue
        waiters.delete(target)
        listeners.forEach((listener) => listener())
      }
    },
    waitFor: (target: number) => count >= target ? Promise.resolve() : new Promise<void>((resolveCount) => {
      const listeners = waiters.get(target) ?? []
      listeners.push(resolveCount)
      waiters.set(target, listeners)
    })
  }
}

function deferredVoid() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveSignal) => signal.addEventListener('abort', () => resolveSignal(), { once: true }))
}

function waitForReleaseOrAbort(release: Promise<void>, signal: AbortSignal): Promise<'release' | 'abort'> {
  if (signal.aborted) return Promise.resolve('abort')
  return new Promise((resolveChoice) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolveChoice('abort')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    release.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolveChoice('release')
    })
  })
}

function holdReviewsUntilAbort(
  value: Fixture,
  harness: { deps: PluginGateDependencies },
  afterFirst?: (options: ReviewOptions, report: ReviewReport) => void | Promise<void>
) {
  const originalReview = harness.deps.review!
  const entered = eventLatch()
  const aborted = eventLatch()
  const releaseFirst = deferredVoid()
  const releaseCleanup = deferredVoid()
  let calls = 0
  let settled = false
  harness.deps.review = async (manifest, options) => {
    const call = calls++
    entered.advance()
    if (call === 0 && await waitForReleaseOrAbort(releaseFirst.promise, options.signal!) === 'release') {
      const report = await originalReview(manifest, options)
      await afterFirst?.(options, report)
      return report
    }
    await waitForSignal(options.signal!)
    aborted.advance()
    await releaseCleanup.promise
    return originalReview(manifest, options)
  }
  const runPromise = runPluginGate(args(value.output), harness.deps).finally(() => { settled = true })
  return {
    entered,
    aborted,
    releaseFirst: releaseFirst.resolve,
    releaseCleanup: releaseCleanup.resolve,
    runPromise,
    calls: () => calls,
    settled: () => settled
  }
}


describe('plugin gate', () => {
  test('help is standalone; strict CLI rejects missing, duplicate, unknown, narrowing and executable options', async () => {
    const value = fixture()
    const helpText: string[] = []
    const help = await runPluginGate(['--help'], {
      inventory: () => { throw new Error('help collected inventory') },
      capture: async () => { throw new Error('help captured') },
      review: async () => { throw new Error('help reviewed') },
      stdout: (text) => helpText.push(text)
    })
    expect(help).toBe(0)
    expect(helpText.join('\n')).toContain('--author-family')
    expect(helpText.join('\n')).toContain('--output')
    expect(existsSync(value.output)).toBe(false)

    const invalidInputs = [
      ['--author-family', 'openai', '--author-family', 'anthropic', '--output', value.output],
      ['--author-family', 'openai', '--output', value.output, '--output', value.output],
      ['--author-family', 'openai', '--output', value.output, '--reviewer', 'gemini', '--reviewer', 'gemini'],
      ['--author-family', 'openai', '--output', value.output, '--browser', '/bin/browser', '--browser', '/bin/other'],
      ['--author-family', 'openai', '--output', value.output, '--reviewer'],
      ['--author-family', 'openai', '--output', value.output, '--browser'],
      ['--author-family', 'openai'],
      ['--output', value.output],
      ['--author-family', 'openai', '--output'],
      ['--author-family=openai', '--output', value.output],
      ['--author-family', 'openai', `--output=${value.output}`],
      ['--author-family', ' openai', '--output', join(value.root, 'padded-family')],
      ['--author-family', 'openai', '--output', `${join(value.root, 'padded-output')} `],
      [' --author-family', 'openai', '--output', join(value.root, 'padded-option')],
      ['--author-family ', 'openai', '--output', join(value.root, 'padded-option-name')],
      ['--author-family', 'openai', '--output', value.output, '--help'],
      ['--author-family', 'openai', '--output', join(value.root, 'unknown-separated'), '--unrecognized', 'value'],
      ['--author-family', 'openai', '--output', join(value.root, 'unknown-equals'), '--unrecognized=value'],
      ['--author-family', 'openai', '--output', join(value.root, 'equals-reviewer'), '--reviewer=gemini'],
      ['--author-family', 'openai', '--output', join(value.root, 'equals-browser'), '--browser=/bin/browser'],
      ...['--only', '--plugin', '--threshold', '--samples', '--manifest', '--skip-build', '--prompt', '--context', '--reviewer-executable']
        .flatMap((flag) => [
          ['--author-family', 'openai', '--output', join(value.root, `invalid-${flag.slice(2)}`), flag, 'x'],
          ['--author-family', 'openai', '--output', join(value.root, `invalid-equals-${flag.slice(2)}`), `${flag}=x`]
        ]),
      ['--author-family', 'openai', '--output', join(value.root, 'missing-equals-output'), '--output=/tmp/hidden'],
      ['--author-family', 'openai', '--output', join(value.root, 'invalid-browser'), '--browser=/bin/browser']
    ]
    for (const argv of invalidInputs) {
      expect(await runPluginGate(argv, dependencies(value).deps)).toBe(2)
      const outputFlag = argv.find((argument) => argument === '--output' || argument.startsWith('--output='))
      const outputPath = outputFlag === '--output'
        ? argv[argv.indexOf('--output') + 1]
        : outputFlag?.slice('--output='.length)
      if (outputPath) expect(existsSync(outputPath)).toBe(false)
    }
  })

  test('captures every screenshot-bearing plugin once and freezes scoped two-theme manifests', async () => {
    const value = fixture({ alpha: 2, beta: 1, dormant: 0 }, { aliases: ['alpha'] })
    const result = await run(value)
    const report = reportAt(value)
    const targets = value.inventory.targets.filter(({ plugin }) => plugin !== null)
    const expectedCells = targets.flatMap(({ id }) => THEMES.map((theme) => `${id}\0${theme}`)).sort()
    const captureProgress = join(result.captureOptions[0]!.outputDir, 'capture-progress.json')

    expect(result.exitCode).toBe(0)
    expect(result.captureCalls()).toBe(1)
    expect(result.captureOptions[0]).toMatchObject({
      only: ['alpha', 'beta'], themes: ['dark', 'light'], skipBuild: false, timeoutMs: CAPTURE_TIMEOUT_MS
    })
    expect(result.captureOptions[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(result.reviewCalls()).toBe(18)
    expect(result.observed.every(({ options, manifest }) =>
      options.timeoutMs === REVIEW_TIMEOUT_MS && options.onlyCells?.length === 1 &&
      manifest.targets.length === 1 && manifest.captures.length === 2 && manifest.failures.length === 0
    )).toBe(true)
    expect(readFileSync(captureProgress, 'utf8')).toBe(value.captureBytes!)
    expect(report.manifest).toMatchObject({ sha256: digest(readFileSync(captureProgress)) })
    expect(report.cells.map(({ targetId, theme }) => `${targetId}\0${theme}`).sort()).toEqual(expectedCells)
    expect(report.cells.every(({ slots, median, range, status }) =>
      slots.length === 3 && slots.every(({ score }) => score === 90) && median === 90 && range === 0 && status === 'pass'
    )).toBe(true)
    expect(report.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alpha', status: 'pass' }),
      expect.objectContaining({ id: 'beta', status: 'pass' }),
      expect.objectContaining({ id: 'dormant', targetIds: [], status: 'not-applicable' })
    ]))
    expect(report.goalPassed).toBe(false)
    expect(lstatSync(value.output).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(value.output, 'plugin-gate.json')).mode & 0o777).toBe(0o600)

    for (const review of result.observed) {
      expect(review.options.onlyCells).toEqual([review.key])
      expect(review.manifest.targets[0]!.id).toBe(review.key.targetId)
      expect(review.manifest.captures.map(({ theme }) => theme)).toEqual(['dark', 'light'])
      expect(review.manifest.captures.map(({ targetId, theme }) => `${targetId}\0${theme}`).sort()).toEqual([
        `${review.key.targetId}\0dark`, `${review.key.targetId}\0light`
      ])
    }
    const aliasTarget = result.observed.find(({ manifest }) => manifest.targets[0]!.id === 'view:alpha/target-1')!.manifest
    expect(aliasTarget.contributionInventory?.toolAliases).toHaveLength(1)
    expect(aliasTarget.contributionInventory?.toolAliases[0]).toMatchObject({
      declaration: { id: 'sidebar-section:alpha/shortcut' },
      renderedTarget: { id: 'view:alpha/target-1' },
      reason: 'tool-navigation-alias'
    })
    const otherTarget = result.observed.find(({ manifest }) => manifest.targets[0]!.id === 'view:alpha/target-2')!.manifest
    expect(otherTarget.contributionInventory?.toolAliases).toEqual([])
    expect(otherTarget.contributionInventory?.declaredTargets.map(({ id }) => id)).toEqual(['view:alpha/target-2'])
    expect(readdirSync(join(result.observed[0]!.output, 'reviewer')).some((name) =>
      /^capture-[a-f0-9]{20}-dark-[0-9a-f-]{36}\.context\.json$/i.test(name)
    )).toBe(true)
  })

  test.each(['forward', 'reverse', 'interleaved'])('uses four lanes and slot barriers under %s completion', async (order) => {
    const value = fixture({ alpha: 1, beta: 1, gamma: 1 })
    const sortedCells = value.manifest.targets.flatMap(({ id }) => THEMES.map((theme) => ({ targetId: id, theme })))
      .sort((left, right) => left.targetId.localeCompare(right.targetId) || THEMES.indexOf(left.theme) - THEMES.indexOf(right.theme))
    const scoreFor = (key: ReviewCellKey, slot: number) => 60 + sortedCells.findIndex((cell) =>
      cell.targetId === key.targetId && cell.theme === key.theme
    ) * 5 + slot
    const harness = dependencies(value, { scores: (targetId, theme, slot) => scoreFor({ targetId, theme }, slot) })
    const ordinaryReview = harness.deps.review!
    const calls: Array<{ key: ReviewCellKey; slot: number; release: () => void; settled: boolean }> = []
    const slotByCell = new Map<string, number>()
    const countWaiters = new Map<number, Array<() => void>>()
    const settledWaiters = new Map<number, Array<() => void>>()
    let active = 0
    let maximum = 0
    let settledCount = 0
    const waitForCount = (count: number) => calls.length >= count ? Promise.resolve() : new Promise<void>((resolveCount) => {
      const listeners = countWaiters.get(count) ?? []
      listeners.push(resolveCount)
      countWaiters.set(count, listeners)
    })
    const waitForSettled = (count: number) => settledCount >= count ? Promise.resolve() : new Promise<void>((resolveCount) => {
      const listeners = settledWaiters.get(count) ?? []
      listeners.push(resolveCount)
      settledWaiters.set(count, listeners)
    })
    const notify = (waiters: Map<number, Array<() => void>>, current: number) => {
      for (const [count, listeners] of waiters) {
        if (current < count) continue
        waiters.delete(count)
        listeners.forEach((listener) => listener())
      }
    }
    harness.deps.review = async (manifest, options) => {
      const key = options.onlyCells![0]!
      const id = cellKey(key.targetId, key.theme)
      const slot = (slotByCell.get(id) ?? 0) + 1
      slotByCell.set(id, slot)
      const { promise, resolve } = Promise.withResolvers<void>()
      const call = { key, slot, release: resolve, settled: false }
      calls.push(call)
      active += 1
      maximum = Math.max(maximum, active)
      notify(countWaiters, calls.length)
      try {
        await promise
        return await ordinaryReview(manifest, options)
      } finally {
        call.settled = true
        active -= 1
        settledCount += 1
        notify(settledWaiters, settledCount)
      }
    }
    const runPromise = runPluginGate(args(value.output), harness.deps)
    try {
      await waitForCount(4)
      expect(maximum).toBe(4)
      expect(calls.slice(0, 4).map(({ key }) => key)).toEqual(sortedCells.slice(0, 4))
      for (const slot of [1, 2, 3]) {
        const expectedStart = (slot - 1) * 6
        const needed = expectedStart + 4
        await waitForCount(needed)
        expect(calls.filter(({ slot: actual }) => actual === slot).length).toBeGreaterThanOrEqual(4)
        while (calls.filter(({ slot: actual, settled }) => actual === slot && !settled).length > 0 ||
          calls.filter(({ slot: actual }) => actual === slot).length < 6) {
          const pending = calls.filter(({ slot: actual, settled }) => actual === slot && !settled)
          const call = pending[order === 'forward' ? 0 : order === 'reverse' ? pending.length - 1 : Math.floor(pending.length / 2)]!
          const before = settledCount
          const countBefore = calls.length
          call.release()
          await waitForSettled(before + 1)
          if (calls.filter(({ slot: actual }) => actual === slot).length < 6) await waitForCount(countBefore + 1)
          expect(calls.every(({ slot: actual }) => actual <= slot)).toBe(true)
        }
        expect(calls.filter(({ slot: actual }) => actual === slot).map(({ key }) => key)).toEqual(sortedCells)
        if (slot < 3) {
          await waitForCount(slot * 6 + 4)
          expect(calls.filter(({ slot: actual }) => actual === slot + 1).length).toBe(4)
          expect(calls.filter(({ slot: actual }) => actual === slot).every(({ settled }) => settled)).toBe(true)
        }
      }
      const exitCode = await runPromise
      expect(exitCode).toBe(1)
      expect(calls).toHaveLength(18)
      expect(maximum).toBe(4)
      const report = reportAt(value)
      for (const cell of report.cells) {
        expect(cell.slots.map(({ score }) => score)).toEqual([1, 2, 3].map((slot) => scoreFor(cell, slot)))
      }
    } finally {
      calls.forEach(({ release }) => release())
      await runPromise.catch(() => undefined)
    }
  }, 60_000)

  test('shares one retry between operational and response-shape issues in either order', async () => {
    for (const codes of [
      ['operational', 'response-shape'],
      ['response-shape', 'operational'],
      ['operational', 'operational'],
      ['response-shape', 'response-shape'],
      ['response-shape']
    ] as const) {
      const value = fixture({ alpha: 1 })
      const key = { targetId: 'view:alpha/target-1', theme: 'dark' as const }
      const result = await run(value, {
        scores: (_targetId, theme) => theme === 'light' ? 84 : 90,
        issue: (requested, slot, attempt) => requested.targetId === key.targetId && requested.theme === key.theme &&
          slot === 1 && attempt <= codes.length
          ? [{ ...key, code: codes[attempt - 1]!, message: `attempt ${attempt}` }]
          : undefined
      })
      const report = reportAt(value)
      const cell = cellAt(report, key.targetId, key.theme)
      expect(result.reviewCalls()).toBe(codes.length === 1 ? 7 : 5)
      expect(cell.slots[0]!.attempts).toHaveLength(2)
      expect(cell.slots[0]!.attempts.flatMap(({ issues }) => issues.map(({ code }) => code))).toEqual([...codes])
      expect(cell.slots[0]!.attempts[0]!.issues.map(({ code }) => code)).toEqual([codes[0]])
      expect(cell.slots[0]!.attempts[0]!.retryOf).toBeNull()
      expect(cell.slots[0]!.attempts.slice(1).every(({ retryOf }) => retryOf === cell.slots[0]!.attempts[0]!.id)).toBe(true)
      expect(result.observed.filter(({ key: called }) => called.targetId === key.targetId && called.theme === key.theme)
        .every(({ manifest, options }) => manifest.targets.length === 1 && manifest.captures.length === 2 &&
          options.onlyCells?.length === 1 && options.onlyCells[0]!.targetId === key.targetId && options.onlyCells[0]!.theme === key.theme
        )).toBe(true)
      if (codes.length > 1) {
        expect(result.exitCode).toBe(2)
        expect(cell).toMatchObject({ median: null, status: 'invalid' })
        expect(cell.slots.slice(1).every(({ score, attempts }) => score === null && attempts.length === 0)).toBe(true)
      } else {
        expect(result.exitCode).toBe(1)
        expect(cell.slots.map(({ score }) => score)).toEqual([90, 90, 90])
      }
      const sibling = cellAt(report, key.targetId, 'light')
      expect(sibling.slots.map(({ score }) => score)).toEqual([84, 84, 84])
      expect(result.observed.filter(({ key: called }) => called.targetId === key.targetId && called.theme === 'light')).toHaveLength(3)
    }
  })

  test('scenario 4 preserves the six-cell denominator while continuing after a local capture failure and conflict', async () => {
    const aDark = { targetId: 'view:alpha/target-1', theme: 'dark' as const }
    const aLight = { targetId: 'view:alpha/target-1', theme: 'light' as const }
    const bDark = { targetId: 'view:beta/target-1', theme: 'dark' as const }
    const value = fixture({ alpha: 1, beta: 1, gamma: 1 }, { aliases: ['beta'], failedCells: [aLight] })
    const result = await run(value, {
      scores: (targetId, theme) => targetId === bDark.targetId && theme === 'dark'
        ? 90
        : targetId === 'view:beta/target-1' ? 85
          : targetId === 'view:gamma/target-1' && theme === 'dark' ? 84 : 86,
      mutate: (report, { key, slot }) => {
        if (key.targetId !== bDark.targetId || key.theme !== bDark.theme || slot !== 2) return report
        const sample = report.captures[0]!
        sample.assessment.scores = Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, 100])) as ReviewedCapture['assessment']['scores']
        sample.assessment.reasons[0] = 'The plugin should contradict the retained host frame contract.'
        sample.score = 100
        sample.passed = true
        sample.contractReview!.audit.reasonChecks[0] = {
          reasonIndex: 0,
          contractIds: ['host-frame-ownership'],
          conflictsWithContract: true,
          affectsScore: true
        }
        sample.contractReview!.audit.conflicts.push({
          contractId: 'host-frame-ownership',
          reason: sample.assessment.reasons[0]!,
          affectsScore: true
        })
        return report
      }
    })
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(result.captureCalls()).toBe(1)
    expect(result.reviewCalls()).toBe(11)
    expect(new Set(result.observed.map(({ manifest }) => manifest.targets[0]!.id))).toEqual(new Set([
      'view:beta/target-1', 'view:gamma/target-1'
    ]))
    expect(result.observed.every(({ manifest }) => manifest.targets.length === 1 && manifest.captures.length === 2)).toBe(true)
    expect(report.cells).toHaveLength(6)
    expect(cellAt(report, aDark.targetId, aDark.theme)).toMatchObject({ median: null, range: null, status: 'invalid' })
    expect(cellAt(report, aDark.targetId, aDark.theme).slots.map(({ score }) => score)).toEqual([null, null, null])
    expect(cellAt(report, aLight.targetId, aLight.theme)).toMatchObject({ median: null, status: 'invalid' })
    const conflict = cellAt(report, bDark.targetId, bDark.theme)
    expect(conflict.slots.map(({ score }) => score)).toEqual([90, null, null])
    expect(conflict.slots[1]!.attempts[0]).toMatchObject({
      sample: expect.objectContaining({ score: 100 }),
      issues: expect.arrayContaining([expect.objectContaining({ code: 'contract-conflict' })])
    })
    expect(conflict.median).toBeNull()
    expect(cellAt(report, 'view:beta/target-1', 'light')).toMatchObject({ median: 85, range: 0, status: 'pass' })
    expect(cellAt(report, 'view:gamma/target-1', 'dark')).toMatchObject({ median: 84, range: 0, status: 'fail' })
    expect(cellAt(report, 'view:gamma/target-1', 'light')).toMatchObject({ median: 86, range: 0, status: 'pass' })
    expect(report).toMatchObject({ status: 'error', goalPassed: false, threshold: 85, sampleCount: 3 })
    expect(report.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alpha', status: 'invalid' }),
      expect.objectContaining({ id: 'beta', status: 'invalid' }),
      expect.objectContaining({ id: 'gamma', status: 'fail' })
    ]))
    const betaManifest = result.observed.find(({ manifest }) => manifest.targets[0]!.id === 'view:beta/target-1')!.manifest
    expect(betaManifest.contributionInventory?.toolAliases).toHaveLength(1)
    expect(betaManifest.contributionInventory?.toolAliases[0]!.renderedTarget.id).toBe('view:beta/target-1')
    expect(betaManifest.failures).toEqual([])
    expect(value.manifest.failures.some((message) => message.includes(`${aLight.targetId} (light)`))).toBe(true)
  })
  test('rejects source and captured target, cell, and alias mismatches before reviewing', async () => {
    const damages: Array<(value: Fixture) => void> = [
      (value) => { value.inventory.targets.find(({ plugin }) => plugin !== null)!.plugin = 'foreign' },
      (value) => { value.manifest.targets[0]!.plugin = 'foreign' },
      (value) => { value.manifest.captures.pop() },
      (value) => {
        value.manifest.contributionInventory!.toolAliases[0]!.renderedTarget = target('view', 'foreign', 'target')
      }
    ]
    for (const damage of damages) {
      const value = fixture({ alpha: 1 }, { aliases: ['alpha'] })
      damage(value)
      const result = await run(value)
      const report = reportAt(value)

      expect(result.exitCode).toBe(2)
      expect(result.reviewCalls()).toBe(0)
      expect(report.status).toBe('error')
      expect(report.failures.length).toBeGreaterThan(0)
    }
  })

  test('makes failed, null, missing, and wrong-size captures ineligible for both themes', async () => {
    const value = fixture({ failed: 1, nullImage: 1, missing: 1, wrongSize: 1 }, {
      failedCells: [{ targetId: 'view:failed/target-1', theme: 'dark' }]
    })
    const nullImage = value.manifest.captures.find(({ targetId, theme }) =>
      targetId === 'view:nullImage/target-1' && theme === 'dark'
    )!
    nullImage.status = 'captured'
    nullImage.image = null
    delete nullImage.error
    const missing = value.manifest.captures.find(({ targetId, theme }) =>
      targetId === 'view:missing/target-1' && theme === 'dark'
    )!
    rmSync(missing.image!.path)
    const wrongSize = value.manifest.captures.find(({ targetId, theme }) =>
      targetId === 'view:wrongSize/target-1' && theme === 'dark'
    )!
    const wrongPng = pngBytes(SCREENSHOT_SIZE.width - 1, SCREENSHOT_SIZE.height, 31)
    writeFileSync(wrongSize.image!.path, wrongPng)
    wrongSize.image!.sha256 = digest(wrongPng)

    const result = await run(value)
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(result.reviewCalls()).toBe(0)
    expect(report.cells).toHaveLength(8)
    for (const plugin of ['failed', 'nullImage', 'missing', 'wrongSize']) {
      for (const theme of THEMES) {
        const cell = cellAt(report, `view:${plugin}/target-1`, theme)
        expect(cell.status).toBe('invalid')
        expect(cell.slots.every(({ score, attempts }) => score === null && attempts.length === 0)).toBe(true)
      }
    }
  })

  test('rejects malformed approved-reference dimensions before dispatch', async () => {
    const value = fixture()
    const malformed = pngBytes(SCREENSHOT_SIZE.width - 1, SCREENSHOT_SIZE.height, 41)
    const references = new Set(value.manifest.captures.map(({ reference }) => reference.path))
    for (const capture of value.manifest.captures) capture.reference.sha256 = digest(malformed)
    const harness = dependencies(value)
    harness.deps.io = {
      readFile: async (path) => references.has(path) ? malformed : readFileSync(path)
    }

    const exitCode = await runPluginGate(args(value.output), harness.deps)
    const report = reportAt(value)
    expect(exitCode).toBe(2)
    expect(harness.reviewCalls()).toBe(0)
    expect(report.status).toBe('error')
    expect(report.failures.length).toBeGreaterThan(0)
  })

  test('stops on a source change discovered before the first review dispatch', async () => {
    const value = fixture({ alpha: 1, beta: 1 })
    const harness = dependencies(value)
    let inventoryReads = 0
    harness.deps.inventory = () => {
      inventoryReads += 1
      const snapshot = structuredClone(value.inventory)
      if (inventoryReads > 1) snapshot.commit = 'changed-before-review'
      return snapshot
    }

    const exitCode = await runPluginGate(args(value.output), harness.deps)
    const report = reportAt(value)
    expect(exitCode).toBe(2)
    expect(inventoryReads).toBeGreaterThan(1)
    expect(harness.reviewCalls()).toBe(0)
    expect(report.cells).toHaveLength(4)
    expect(report.cells.every(({ slots }) => slots.every(({ attempts }) => attempts.length === 0))).toBe(true)
  })

  test('retains capture progress, manifest identity, and diagnostics when capture throws', async () => {
    const failedCell = { targetId: 'view:alpha/target-1', theme: 'dark' as const }
    const value = fixture({ alpha: 1 }, { failedCells: [failedCell] })
    value.manifest.activatedVisibilitySettings = ['setting:alpha/dashboard-enabled']
    const result = await run(value, { captureError: new Error('capture fixture failed after progress') })
    const report = reportAt(value)
    const progress = join(result.captureOptions[0]!.outputDir, 'capture-progress.json')

    expect(result.exitCode).toBe(2)
    expect(result.captureCalls()).toBe(1)
    expect(result.reviewCalls()).toBe(0)
    expect(value.captureBytes).not.toBeNull()
    expect(readFileSync(progress, 'utf8')).toBe(value.captureBytes!)
    expect(report.manifest).not.toBeNull()
    expect(existsSync(report.manifest!.path)).toBe(true)
    expect(digest(readFileSync(report.manifest!.path))).toBe(report.manifest!.sha256)
    expect(report.captureEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: failedCell.targetId, theme: failedCell.theme, status: 'failed', image: null })
    ]))
    expect(report.activatedVisibilitySettings).toEqual(value.manifest.activatedVisibilitySettings)
    expect(report.cells).toHaveLength(2)
    expect(report.status).toBe('error')
  })

  test('refuses existing files, directories, final/parent symlinks, non-directory ancestors, and normalized aliases', async () => {
    const value = fixture()
    const occupied = join(value.root, 'occupied')
    const occupiedFile = join(value.root, 'occupied-file')
    const realParent = join(value.root, 'real-parent')
    const linkedParent = join(value.root, 'linked-parent')
    const finalLink = join(value.root, 'final-link')
    const notDirectory = join(value.root, 'not-a-directory')
    mkdirSync(occupied)
    writeFileSync(occupiedFile, 'keep-me')
    mkdirSync(realParent)
    symlinkSync(realParent, linkedParent, 'dir')
    symlinkSync(occupied, finalLink, 'dir')
    writeFileSync(notDirectory, 'keep-me-too')
    const rejected = [
      occupied,
      `${value.root}//occupied/`,
      `${value.root}/not-created/../occupied/`,
      occupiedFile,
      finalLink,
      join(linkedParent, 'fresh-output'),
      join(notDirectory, 'child')
    ]
    for (const output of rejected) {
      const harness = dependencies(value)
      expect(await runPluginGate(args(output), harness.deps)).toBe(2)
      expect(harness.captureCalls()).toBe(0)
      expect(harness.reviewCalls()).toBe(0)
    }
    expect(readFileSync(occupiedFile, 'utf8')).toBe('keep-me')
    expect(lstatSync(finalLink).isSymbolicLink()).toBe(true)

    const tmpParent = mkdtempSync(join('/tmp', 'plugin-gate-tmp-alias-'))
    tempRoots.push(tmpParent)
    const accepted = join(tmpParent, 'nested//fresh-output/')
    const acceptedRun = await runPluginGate(args(accepted), dependencies(value).deps)
    expect(acceptedRun).toBe(0)
    expect(existsSync(join(tmpParent, 'nested', 'fresh-output'))).toBe(true)
  })

  test('a contract conflict is non-retryable even when the same response has a shape issue', async () => {
    const key = { targetId: 'view:alpha/target-1', theme: 'dark' as const }
    const value = fixture()
    const result = await run(value, {
      mutate: (report, context) => {
        if (context.key.targetId !== key.targetId || context.key.theme !== key.theme || context.slot !== 1) return report
        const sample = report.captures[0]!
        sample.assessment.reasons[0] = 'The requested boxed tabs contradict the retained underline rule.'
        sample.contractReview!.audit.reasonChecks[0] = {
          reasonIndex: 0, contractIds: ['host-underline-tabs'], conflictsWithContract: true, affectsScore: true
        }
        sample.contractReview!.audit.conflicts.push({
          contractId: 'host-underline-tabs',
          reason: sample.assessment.reasons[0]!,
          affectsScore: true
        })
        report.issues!.push({ ...key, code: 'response-shape', message: 'simultaneous malformed response marker' })
        report.status = 'error'
        return report
      }
    })
    const report = reportAt(value)
    const dark = cellAt(report, key.targetId, key.theme)
    expect(result.exitCode).toBe(2)
    expect(dark.slots[0]!.attempts).toHaveLength(1)
    expect(dark.slots[0]!.attempts[0]!.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['contract-conflict', 'response-shape'])
    )
    expect(dark.slots.slice(1).every(({ attempts, score }) => attempts.length === 0 && score === null)).toBe(true)
    expect(cellAt(report, key.targetId, 'light').slots.map(({ score }) => score)).toEqual([90, 90, 90])
    expect(result.observed.filter(({ key: called }) => called.targetId === key.targetId && called.theme === 'light')).toHaveLength(3)
  })

  test('local invalid samples never retry or prevent their sibling from completing', async () => {
    for (const field of ['targetVisible', 'imagesRead'] as const) {
      const value = fixture()
      const result = await run(value, { mutate: (report, { key, slot }) => {
        if (key.theme === 'dark' && slot === 1) report.captures[0]!.assessment[field] = false
        return report
      } })
      const report = reportAt(value)
      expect(result.exitCode).toBe(2)
      expect(result.reviewCalls()).toBe(4)
      expect(cellAt(report, 'view:alpha/target-1', 'dark').median).toBeNull()
      expect(cellAt(report, 'view:alpha/target-1', 'light').median).toBe(90)
    }
  })

  test('each global issue aborts owned reviews immediately and awaits their cleanup', async () => {
    for (const code of ['usage-limit', 'identity-mismatch', 'evidence-changed', 'persistence', 'aborted'] as const) {
      const value = fixture({ alpha: 1, beta: 1, gamma: 1 })
      const harness = dependencies(value, { issue: (cell) => cell.theme === 'dark' && cell.targetId === 'view:alpha/target-1'
        ? [{ ...cell, code, message: `injected ${code}` }] : undefined })
      const controlled = holdReviewsUntilAbort(value, harness)
      try {
        await controlled.entered.waitFor(4)
        controlled.releaseFirst()
        await controlled.aborted.waitFor(3)
        expect(controlled.calls()).toBe(4)
        expect(controlled.settled()).toBe(false)
        controlled.releaseCleanup()
        expect(await controlled.runPromise).toBe(2)
        expect(reportAt(value).cells).toHaveLength(6)
        expect(reportAt(value).cells.every(({ median }) => median === null)).toBe(true)
        expect(harness.signalListeners.size).toBe(0)
      } finally {
        controlled.releaseFirst()
        controlled.releaseCleanup()
        await controlled.runPromise
      }
    }
  }, 60_000)

  test('a known quota stop precedes blocked artifact IO and sibling dequeue', async () => {
    const value = fixture({ alpha: 1, beta: 1, gamma: 1 })
    const harness = dependencies(value, { issue: (cell) => cell.theme === 'dark' && cell.targetId === 'view:alpha/target-1'
      ? [{ ...cell, code: 'usage-limit', message: 'quota exhausted' }] : undefined })
    const releaseIO = deferredVoid()
    let firstDirectory = ''
    harness.deps.io = { readFile: async (path) => {
      if (firstDirectory && path.startsWith(firstDirectory)) await releaseIO.promise
      return readFileSync(path)
    } }
    const controlled = holdReviewsUntilAbort(value, harness, (options) => { firstDirectory = options.outputDir })
    try {
      await controlled.entered.waitFor(4)
      controlled.releaseFirst()
      await controlled.aborted.waitFor(3)
      expect(controlled.calls()).toBe(4)
      expect(controlled.settled()).toBe(false)
      releaseIO.resolve()
      controlled.releaseCleanup()
      expect(await controlled.runPromise).toBe(2)
    } finally {
      releaseIO.resolve()
      controlled.releaseFirst()
      controlled.releaseCleanup()
      await controlled.runPromise
    }
  }, 30_000)

  test('signals propagate to capture and reviews, preserve all rows and remove listeners', async () => {
    for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const value = fixture({ alpha: 1, beta: 1, gamma: 1 })
      const harness = dependencies(value)
      const controlled = holdReviewsUntilAbort(value, harness)
      try {
        await controlled.entered.waitFor(4)
        harness.signalListeners.get(signal)!()
        await controlled.aborted.waitFor(4)
        expect(controlled.settled()).toBe(false)
        controlled.releaseCleanup()
        expect(await controlled.runPromise).toBe(expected)
        expect(controlled.calls()).toBe(4)
        expect(harness.captureOptions[0]!.signal!.aborted).toBe(true)
        expect(reportAt(value).cells.every(({ median }) => median === null)).toBe(true)
        expect(harness.signalListeners.size).toBe(0)
      } finally {
        controlled.releaseFirst()
        controlled.releaseCleanup()
        await controlled.runPromise
      }
    }
  }, 30_000)

  test('unknown issues, malformed identities and thrown exceptions retain raw evidence without retry', async () => {
    for (const kind of ['unknown', 'identity', 'envelope', 'throw'] as const) {
      const value = fixture()
      const harness = dependencies(value, { mutate: (report) => {
        if (kind === 'unknown') report.issues!.push({ code: 'future-issue' as ReviewIssue['code'], message: 'unknown code' })
        if (kind === 'identity') report.authorFamily = 'google'
        if (kind === 'envelope') report.schemaVersion = 9 as 1
        return report
      } })
      const original = harness.deps.review!
      let calls = 0
      harness.deps.review = async (manifest, options) => {
        calls += 1
        const report = await original(manifest, options)
        if (kind === 'throw') throw new Error('unclassified exception after persistence')
        return report
      }
      expect(await runPluginGate(args(value.output), harness.deps)).toBe(2)
      const report = reportAt(value)
      expect(calls).toBeLessThanOrEqual(2)
      expect(report.timing!.replacementReviewCalls).toBe(0)
      expect(report.cells.every(({ median }) => median === null)).toBe(true)
      for (const attempt of report.cells.flatMap(({ slots }) => slots.flatMap(({ attempts }) => attempts))) {
        expect(attempt.reportPath).not.toBeNull()
        expect(digest(readFileSync(attempt.reportPath!))).toBe(attempt.reportSha256!)
      }
    }
  })

  test('source, manifest, PNG, reference and trusted-context drift invalidate every median', async () => {
    for (const kind of ['source-commit', 'source-digest', 'source-dirty', 'parent', 'progress', 'derived', 'image', 'golden', 'context', 'implementation'] as const) {
      const value = fixture()
      const harness = dependencies(value)
      const original = harness.deps.review!
      let changed = false
      harness.deps.io = { readFile: async (path) => {
        const bytes = readFileSync(path)
        if (changed && (kind === 'golden' && path === value.manifest.captures[0]!.reference.path ||
            kind === 'implementation' && path.endsWith('/host-contracts.ts'))) {
          const altered = Buffer.from(bytes)
          altered[altered.length - 1] ^= 1
          return altered
        }
        return bytes
      } }
      harness.deps.review = async (manifest, options) => {
        const report = await original(manifest, options)
        if (!changed) {
          changed = true
          if (kind === 'source-commit') value.inventory.commit = 'changed-commit'
          if (kind === 'source-digest') value.inventory.sourceDigest = 'b'.repeat(64)
          if (kind === 'source-dirty') value.inventory.dirty = true
          if (kind === 'parent') writeFileSync(join(value.output, 'capture-manifest.json'), '{}')
          if (kind === 'progress') writeFileSync(join(value.captureDirectory!, 'capture-progress.json'), '{}')
          if (kind === 'derived') writeFileSync(join(value.output, 'targets', readdirSync(join(value.output, 'targets'))[0]!), '{}')
          if (kind === 'image') writeFileSync(value.manifest.captures[0]!.image!.path, pngBytes(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height, 88))
          if (kind === 'context') writeFileSync(join(value.output, 'contexts', readdirSync(join(value.output, 'contexts'))[0]!), '{}')
        }
        return report
      }
      expect(await runPluginGate(args(value.output), harness.deps)).toBe(2)
      expect(reportAt(value).cells.every(({ median }) => median === null)).toBe(true)
      expect(reportAt(value).timing!.replacementReviewCalls).toBe(0)
    }
  })

  test('missing, malformed and misassociated artifacts cannot certify a sample', async () => {
    for (const kind of ['missing-report', 'malformed-report', 'missing-context', 'context-path', 'context-bytes', 'run-id'] as const) {
      const value = fixture()
      const harness = dependencies(value, { mutate: (report) => {
        if (kind === 'context-path') report.captures[0]!.contractReview!.contextPath = join(value.root, 'foreign-context.json')
        return report
      } })
      const original = harness.deps.review!
      harness.deps.review = async (manifest, options) => {
        const report = await original(manifest, options)
        const directory = join(options.outputDir, 'reviewer')
        const reportName = readdirSync(directory).find((name) => name.startsWith('review-report-'))!
        const contextName = readdirSync(directory).find((name) => name.endsWith('.context.json'))!
        if (kind === 'missing-report') rmSync(join(directory, reportName))
        if (kind === 'malformed-report') writeFileSync(join(directory, reportName), '{')
        if (kind === 'missing-context') rmSync(join(directory, contextName))
        if (kind === 'context-bytes') writeFileSync(join(directory, contextName), '{}')
        if (kind === 'run-id') renameSync(join(directory, reportName), join(directory, `review-report-${randomUUID()}.json`))
        return report
      }
      expect(await runPluginGate(args(value.output), harness.deps)).toBe(2)
      const report = reportAt(value)
      expect(report.cells.every(({ median }) => median === null)).toBe(true)
      expect(report.timing!.replacementReviewCalls).toBe(0)
      if (kind === 'missing-context' || kind === 'context-path') {
        expect(report.cells.flatMap(({ slots }) => slots.flatMap(({ attempts }) => attempts))
          .some(({ reportPath, reportSha256 }) => reportPath && reportSha256)).toBe(true)
      }
    }
  })

  test('duplicate or padded fourth samples invalidate only their requested cell', async () => {
    for (const count of [2, 4]) {
      const value = fixture()
      const result = await run(value, { mutate: (report, { key, slot }) => {
        if (key.theme === 'dark' && slot === 1) {
          while (report.captures.length < count) report.captures.push(structuredClone(report.captures[0]!))
        }
        return report
      } })
      expect(result.exitCode).toBe(2)
      const report = reportAt(value)
      expect(cellAt(report, 'view:alpha/target-1', 'dark').median).toBeNull()
      expect(cellAt(report, 'view:alpha/target-1', 'light').median).toBe(90)
      expect(result.reviewCalls()).toBe(4)
    }
  })

  test('summary persistence failures never leave a durable passing verdict', async () => {
    for (const filename of ['plugin-gate.json', 'plugin-gate.md']) {
      const value = fixture()
      const harness = dependencies(value)
      harness.deps.io = { writeFile: async (path, contents, options) => {
        if (path.endsWith(filename)) throw new Error('injected summary persistence failure')
        writeFileSync(path, contents, options)
      } }
      expect(await runPluginGate(args(value.output), harness.deps)).toBe(2)
      const survivor = join(value.output, filename.endsWith('.json') ? 'plugin-gate.md' : 'plugin-gate.json')
      expect(readFileSync(survivor, 'utf8')).toContain('error')
      expect(readFileSync(survivor, 'utf8')).toContain('persistence')
    }
  })

  test('exact medians, not reviewer averages or a noise allowance, determine the gate', async () => {
    for (const [scores, median, exitCode] of [
      [[84, 85, 86], 85, 0], [[84, 84, 100], 84, 1],
      [[84.999, 84.999, 100], 84.999, 1], [[62, 62, 62], 62, 1]
    ] as const) {
      const value = fixture()
      const result = await run(value, { scores: (_targetId, _theme, slot) => scores[slot - 1]! })
      expect(result.exitCode).toBe(exitCode)
      expect(reportAt(value).cells.map(({ median: actual }) => actual)).toEqual([median, median])
      expect(result.reviewCalls()).toBe(6)
    }
  })

  test('real reviewManifest reads approved PNG fixtures and returns six context-bound samples', async () => {
    const value = fixture()
    for (const capture of value.manifest.captures) {
      const bytes = readFileSync(capture.reference.path)
      writeFileSync(capture.image!.path, bytes)
      capture.image!.sha256 = digest(bytes)
    }
    const executable = join(value.root, 'local-reviewer.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const identity = '▶ resolved google/fixture-vision (alias gemini)'
process.stderr.write(identity + '\\n')
if (args[0] === '--check') process.exit(0)
const prompt = args[args.length - 1]
const match = /Trusted host contract context \\(canonical JSON; sha256=([a-f0-9]{64})\\):\\n([^\\n]+)/.exec(prompt)
const context = JSON.parse(match[2])
const metadata = JSON.parse(/Capture metadata \\(JSON\\): ([^\\n]+)/.exec(prompt)[1])
for (const path of [metadata.imagePath, metadata.goldenPath]) {
  if (fs.readFileSync(path).readUInt32BE(16) !== 2800) process.exit(4)
}
const assessment = { targetVisible: true, imagesRead: true,
  scores: { palette: 85, typography: 85, spacing: 85, components: 85, hierarchy: 85 },
  reasons: ['Both approved PNG fixtures were read.', 'This synthetic assessment verifies transport only.'] }
const contractAudit = { contextSha256: match[1], acknowledgedRuleIds: context.rules.map(rule => rule.id).sort(),
  reasonChecks: assessment.reasons.map((_, reasonIndex) => ({ reasonIndex, contractIds: [], conflictsWithContract: false, affectsScore: false })), conflicts: [] }
process.stdout.write(JSON.stringify({ assessment, contractAudit }) + '\\n')
`, { mode: 0o700 })
    const inputPath = join(value.root, 'fixture.json')
    writePrivate(inputPath, JSON.stringify({ inventory: value.inventory, manifest: value.manifest }))
    const childSource = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPluginGate } from ${JSON.stringify(fileURLToPath(new URL('./plugin-gate.ts', import.meta.url)))}
import { reviewManifest } from ${JSON.stringify(fileURLToPath(new URL('./review.ts', import.meta.url)))}
const { inventory, manifest } = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, 'utf8'))
let calls = 0
process.exitCode = await runPluginGate(${JSON.stringify(args(value.output))}, {
  repoRoot: ${JSON.stringify(value.repoRoot)}, inventory: () => structuredClone(inventory),
  capture: async (options) => {
    writeFileSync(join(options.outputDir, 'capture-progress.json'), JSON.stringify(manifest, null, 2) + '\\n', { mode: 0o600 })
    return manifest
  },
  review: (manifest, options) => {
    calls += 1
    return reviewManifest(manifest, { ...options, reviewerExecutable: ${JSON.stringify(executable)}, timeoutMs: 20000 })
  }
})
console.log('LOCAL_CALLS=' + calls)
`
    const child = Bun.spawn([process.execPath, '-e', childSource], {
      env: { ...process.env, HOME: realpathSync(value.root), QUIRKY_HOME: join(value.root, 'isolated-child-home') },
      stdout: 'pipe', stderr: 'pipe'
    })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}\n${JSON.stringify(reportAt(value))}`)
    expect(stdout).toContain('LOCAL_CALLS=6')
    const report = reportAt(value)
    expect(report.cells.map(({ slots }) => slots.map(({ score }) => score))).toEqual([[85, 85, 85], [85, 85, 85]])
    for (const attempt of report.cells.flatMap(({ slots }) => slots.flatMap(({ attempts }) => attempts))) {
      expect(attempt.artifacts!.filter(({ path }) => path.endsWith('.context.json'))).toHaveLength(1)
      const log = JSON.parse(readFileSync(attempt.artifacts!.find(({ path }) => path.endsWith('.log.txt'))!.path, 'utf8'))
      expect(log.contextPath).toContain('<home>')
      expect(log.preflight).toEqual({ provider: 'google', model: 'fixture-vision', family: 'google' })
    }
  }, 90_000)

  test('quota exhaustion retains already completed valid three-slot measurements', async () => {
    const value = fixture({ alpha: 2, beta: 1 })
    const result = await run(value, { issue: (cell, slot) => slot === 3 && cell.targetId === 'view:beta/target-1'
      ? [{ ...cell, code: 'usage-limit', message: 'quota exhausted after earlier cells completed' }] : undefined })
    const report = reportAt(value)
    expect(result.exitCode).toBe(2)
    expect(report.cells.some(({ median }) => median === 90)).toBe(true)
    expect(report.cells.some(({ median }) => median === null)).toBe(true)
    expect(report.counts.completeValidCells).toBeGreaterThan(0)
  })
})
