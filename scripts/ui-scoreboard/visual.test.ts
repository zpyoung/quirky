import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Inventory, VisualOptions, VisualResult } from './contracts'
import type { CaptureManifest, CaptureTarget, ImageEvidence, ReviewReport, ReviewedCapture, VisualAssessment } from '../ui-review/contracts'
import { scopeCaptureInventory } from '../ui-review/contribution-inventory'
import { collectInventory } from './inventory'
import { measureVisuals, notRunVisuals } from './visual'
import { CAPTURE_TIMEOUT_MS, DEFAULT_REVIEWER_ALIAS, REVIEW_TIMEOUT_MS } from '../ui-review/arguments'
import { SCORE_DIMENSIONS, THEMES, type CaptureOptions, type ReviewOptions } from '../ui-review/contracts'
import type { VisualDependencies } from './contracts'
import type { ReviewerPreflightResult } from '../ui-review/review'

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function outputDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ui-scoreboard-visual-'))
  tempDirs.push(directory)
  return directory
}

function fixtureFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      QUIRKY_HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Visual fixture',
      GIT_AUTHOR_EMAIL: 'visual@example.invalid',
      GIT_COMMITTER_NAME: 'Visual fixture',
      GIT_COMMITTER_EMAIL: 'visual@example.invalid'
    }
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function inventory(): Inventory {
  const root = mkdtempSync(join(tmpdir(), 'ui-scoreboard-visual-source-'))
  tempDirs.push(root)
  fixtureFile(root, 'plugins/acme.ui/quirky-plugin.json', JSON.stringify({
    id: 'acme.ui',
    name: 'Acme UI',
    ui: 'src/ui.tsx',
    contributes: { view: [{ id: 'view', title: 'View' }] }
  }))
  fixtureFile(root, 'plugins/acme.ui/src/ui.tsx', 'export const View = () => null\\n')
  fixtureFile(root, 'packages/ui/src/styles.css', ':root { color: var(--ui-text-primary); }\\n')
  fixtureFile(root, 'packages/ui/src/design-system/compatibility-tokens.css', ':root { --compat-px-40: 40px; }\\n')
  fixtureFile(root, 'packages/daemon/src/runtime.ts', 'export const runtime = true\\n')
  fixtureFile(root, 'apps/desktop/src/main.ts', 'export const desktop = true\\n')
  git(root, 'init', '--quiet')
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '-m', 'visual fixture')
  return collectInventory(root)
}

function image(path: string, byte: string): ImageEvidence {
  return { path, sha256: byte.repeat(64) }
}

function captureManifest(source: Inventory, overrides: Partial<CaptureManifest> = {}): CaptureManifest {
  const targets = (overrides.targets ?? source.targets).map((target) => ({ ...target }))
  const captures = targets.flatMap((target) => THEMES.map((theme) => ({
    targetId: target.id,
    theme,
    image: image(`/fixture/${encodeURIComponent(target.id)}/${theme}.png`, theme === 'dark' ? 'a' : 'b'),
    reference: image(`/goldens/${theme}.png`, theme === 'dark' ? 'c' : 'd'),
    status: 'captured' as const
  })))
  const contributionInventory = overrides.contributionInventory ?? (source.contributionInventory === undefined
    ? undefined
    : scopeCaptureInventory(source.contributionInventory, targets))
  return {
    schemaVersion: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    commit: source.commit,
    surface: 'desktop-renderer',
    viewport: { width: 1280, height: 800 },
    scope: 'full',
    selectors: [],
    ...overrides,
    ...(contributionInventory === undefined ? {} : { contributionInventory }),
    targets,
    captures: overrides.captures ?? captures,
    failures: overrides.failures ?? []
  }
}

function assessment(scores: Partial<VisualAssessment['scores']> = {}, overrides: Partial<VisualAssessment> = {}): VisualAssessment {
  return {
    targetVisible: true,
    imagesRead: true,
    scores: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, scores[dimension] ?? 85])) as VisualAssessment['scores'],
    reasons: ['Clear hierarchy and consistent spacing.'],
    ...overrides
  }
}

function reviewedCapture(targetId: string, theme: typeof THEMES[number], score = 85, overrides: Partial<ReviewedCapture> = {}): ReviewedCapture {
  const capture = {
    targetId,
    theme,
    image: image(`/fixture/${encodeURIComponent(targetId)}/${theme}.png`, theme === 'dark' ? 'a' : 'b'),
    reference: image(`/goldens/${theme}.png`, theme === 'dark' ? 'c' : 'd')
  }
  return {
    ...capture,
    reviewer: { alias: DEFAULT_REVIEWER_ALIAS, provider: 'google', model: 'fixture-vision', family: 'google' },
    assessment: assessment(),
    score,
    passed: true,
    ...overrides
  }
}

function reviewReport(manifest: CaptureManifest, overrides: Partial<ReviewReport> = {}): ReviewReport {
  const captures = manifest.captures.flatMap((capture) => capture.image && capture.status === 'captured'
    ? [reviewedCapture(capture.targetId, capture.theme)]
    : [])
  return {
    schemaVersion: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    status: 'passed',
    scope: manifest.scope,
    threshold: 85,
    authorFamily: 'openai',
    reviewerAlias: DEFAULT_REVIEWER_ALIAS,
    captures,
    failures: [],
    ...overrides
  }
}

const preflightProcess = {
  exitCode: 0,
  stdout: { text: '', bytes: 0, truncated: false },
  stderr: { text: '', bytes: 0, truncated: false },
  timedOut: false,
  aborted: false
}
const successfulPreflightResult: ReviewerPreflightResult = {
  ok: true,
  resolved: { provider: 'google', model: 'fixture-vision', family: 'google' },
  process: preflightProcess
}
const successfulPreflight: VisualDependencies['preflight'] = async () => successfulPreflightResult
type PreflightFailureCode = Extract<ReviewerPreflightResult, { ok: false }>['issue']['code']
function failedPreflight(
  message: string,
  code: PreflightFailureCode = 'operational',
  resolved?: Extract<ReviewerPreflightResult, { ok: false }>['resolved']
): ReviewerPreflightResult {
  return { ok: false, ...(resolved === undefined ? {} : { resolved }), process: preflightProcess, issue: { code, message } }
}

function options(): VisualOptions {
  return { outputDir: outputDir(), authorFamily: 'openai', reviewerAlias: DEFAULT_REVIEWER_ALIAS }
}

function dependencies(manifest: CaptureManifest, review?: VisualDependencies['review']): VisualDependencies {
  return {
    preflight: successfulPreflight,
    capture: async () => manifest,
    review: review ?? (async (filtered) => reviewReport(filtered))
  }
}

function cell(result: VisualResult, targetId: string, theme: typeof THEMES[number]) {
  const found = result.cells.find((candidate) => candidate.targetId === targetId && candidate.theme === theme)
  if (!found) throw new Error(`missing visual result cell ${targetId} (${theme})`)
  return found
}

function completeAssessmentCapture(
  manifest: CaptureManifest,
  targetId: string,
  theme: typeof THEMES[number],
  overrides: Partial<ReviewedCapture> = {},
  reportOverrides: Partial<ReviewReport> = {}
): ReviewReport {
  return reviewReport(manifest, {
    captures: [reviewedCapture(targetId, theme, 85, overrides)],
    ...reportOverrides
  })
}

type TestToolAlias = {
  declaration: CaptureTarget
  toolId: string
  renderedTarget: CaptureTarget
  reason: 'tool-navigation-alias'
}

type TestContributionInventory = { declaredTargets: CaptureTarget[]; toolAliases: TestToolAlias[] }

function projectedInventory(includeDashboard = false): { source: Inventory; body: CaptureTarget; declaration: CaptureTarget } {
  const source = inventory()
  const plugin = source.plugins.find((candidate) => candidate.id === 'acme.ui')!
  const bodies = [source.targets.find((target) => target.plugin === 'acme.ui')!]
  for (let index = 2; index <= 5; index++) {
    const kind = index % 2 === 0 ? 'panel' : 'view'
    const target: CaptureTarget = {
      id: `${kind}:acme.ui/body-${index}`,
      plugin: 'acme.ui',
      title: `Body ${index}`,
      kind
    }
    bodies.push(target)
    plugin.targets.push(target.id)
    source.targets.push(target)
  }
  const aliases = bodies.map((renderedTarget, index) => {
    const declaration: CaptureTarget = {
      id: `sidebar-section:acme.ui/navigation${index === 0 ? '' : `-${index + 1}`}`,
      plugin: 'acme.ui',
      title: `Navigation ${index + 1}`,
      kind: 'sidebar-section'
    }
    plugin.targets.push(declaration.id)
    return { declaration, toolId: declaration.id, renderedTarget, reason: 'tool-navigation-alias' as const }
  })
  if (includeDashboard) {
    const dashboard: CaptureTarget = {
      id: 'sidebar-section:quirky.agent-status/dashboard',
      plugin: 'quirky.agent-status',
      title: 'Dashboard',
      kind: 'sidebar-section'
    }
    source.plugins.push({
      id: 'quirky.agent-status',
      directory: 'plugins/quirky.agent-status',
      hasUi: true,
      targets: [dashboard.id],
      sources: []
    })
    source.targets.push(dashboard)
  }
  const contributionInventory: TestContributionInventory = {
    declaredTargets: [...source.targets.map((target) => ({ ...target })), ...aliases.map((alias) => alias.declaration)]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    toolAliases: aliases.sort((left, right) => left.declaration.id < right.declaration.id ? -1 : left.declaration.id > right.declaration.id ? 1 : 0)
  }
  Object.assign(source, { contributionInventory })
  return { source, body: bodies[0]!, declaration: aliases[0]!.declaration }
}

function projectedManifest(source: Inventory): CaptureManifest {
  const manifest = captureManifest(source)
  Object.assign(manifest, { contributionInventory: structuredClone((source as Inventory & { contributionInventory: TestContributionInventory }).contributionInventory) })
  return manifest
}

describe('visual scoreboard measurement', () => {
  test('captures the full two-theme inventory and reviews each complete target with a filtered manifest', async () => {
    const source = inventory()
    const signal = new AbortController().signal
    const visualOptions = { ...options(), signal }
    const events: string[] = []
    let preflightCalls = 0
    const fullManifest = captureManifest(source, { failures: ['one optional surface failed to mount'] })
    const original = structuredClone(fullManifest)
    const captureOptions: CaptureOptions[] = []
    const reviewCalls: Array<{ manifest: CaptureManifest; options: ReviewOptions }> = []
    const result = await measureVisuals(source, visualOptions, {
      preflight: async (received) => {
        preflightCalls++
        events.push('preflight')
        expect(received).toMatchObject({ reviewerAlias: DEFAULT_REVIEWER_ALIAS, authorFamily: 'openai', timeoutMs: REVIEW_TIMEOUT_MS })
        expect(received.signal).toBe(signal)
        return successfulPreflightResult
      },
      capture: async (received) => {
        events.push('capture')
        captureOptions.push(received)
        return fullManifest
      },
      review: async (manifest, received) => {
        events.push('review')
        reviewCalls.push({ manifest: structuredClone(manifest), options: received })
        return reviewReport(manifest, {
          captures: manifest.captures.map((capture) => reviewedCapture(capture.targetId, capture.theme, 85, { passed: false }))
        })
      }
    })

    expect(preflightCalls).toBe(1)
    expect(events.slice(0, 2)).toEqual(['preflight', 'capture'])
    expect(captureOptions).toHaveLength(1)
    expect(captureOptions[0]).toMatchObject({
      repoRoot: source.repoRoot,
      only: [],
      skipBuild: false,
      themes: THEMES,
      timeoutMs: CAPTURE_TIMEOUT_MS
    })
    expect(captureOptions[0]?.outputDir).toBe(visualOptions.outputDir)
    expect(existsSync(join(visualOptions.outputDir, 'capture-manifest.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(visualOptions.outputDir, 'capture-manifest.json'), 'utf8'))).toEqual(original)
    expect(reviewCalls).toHaveLength(source.targets.length)
    expect(new Set(reviewCalls.map(({ options: reviewOptions }) => reviewOptions.outputDir)).size).toBe(source.targets.length)
    for (const { manifest, options: reviewOptions } of reviewCalls) {
      expect(manifest.scope).toBe('filtered')
      expect(manifest.selectors).toEqual([manifest.targets[0]?.id])
      expect(manifest.targets).toHaveLength(1)
      expect(manifest.captures).toHaveLength(THEMES.length)
      expect(manifest.failures).toEqual([])
      expect(reviewOptions.outputDir.startsWith(visualOptions.outputDir)).toBe(true)
      expect(reviewOptions).toMatchObject({
        authorFamily: 'openai',
        reviewerAlias: DEFAULT_REVIEWER_ALIAS,
        threshold: 85,
        timeoutMs: REVIEW_TIMEOUT_MS
      })
    }
    expect(fullManifest).toEqual(original)
    expect(result.failures.some((failure) => failure.message.includes('one optional surface failed to mount'))).toBe(true)
    expect(result.cells).toHaveLength(source.targets.length * THEMES.length)
    expect(result.cells.every((visual) => visual.status === 'pass' && visual.score === 85)).toBe(true)
  })
  test('plugin measurement captures and reviews only that plugin in both themes', async () => {
    const source = inventory()
    const pluginId = source.plugins[0]!.id
    const targets = source.targets.filter((target) => target.plugin === pluginId)
    const manifest = captureManifest(source, { scope: 'filtered', selectors: [pluginId], targets })
    let receivedOptions: CaptureOptions | undefined
    const result = await measureVisuals(source, { ...options(), plugin: pluginId }, {
      preflight: successfulPreflight,
      capture: async (received) => {
        receivedOptions = received
        return manifest
      },
      review: async (filtered) => reviewReport(filtered),
    })

    expect(receivedOptions?.only).toEqual([pluginId])
    expect(receivedOptions?.themes).toEqual(THEMES)
    expect(result.targets.map((target) => target.id)).toEqual(targets.map((target) => target.id).sort())
    expect(result.cells).toHaveLength(targets.length * THEMES.length)
    expect(result.cells.every((visual) => visual.plugin === pluginId && visual.status === 'pass')).toBe(true)
    expect(result.failures).toEqual([])
  })

  test('preflight failures stop capture and review for full and selected-plugin targets', async () => {
    const failures: Array<{ name: string; diagnostic: string; result?: ReviewerPreflightResult; rejection?: Error }> = [
      { name: 'operational', diagnostic: 'Reviewer unavailable', result: failedPreflight('Reviewer unavailable') },
      { name: 'timeout', diagnostic: 'Reviewer preflight timed out.', result: failedPreflight('Reviewer preflight timed out.') },
      { name: 'missing executable', diagnostic: 'Could not start pi-watch:', result: failedPreflight('Could not start pi-watch: missing') },
      {
        name: 'unknown provider',
        diagnostic: 'unknown provider family mystery',
        result: failedPreflight('Reviewer preflight resolved unknown provider family mystery.', 'identity-mismatch', { provider: 'mystery', model: 'fixture-vision' })
      },
      {
        name: 'same family',
        diagnostic: 'matches author family google',
        result: failedPreflight('Resolved reviewer family google matches author family google.', 'identity-mismatch', { provider: 'google', model: 'fixture-vision', family: 'google' })
      },
      { name: 'abort', diagnostic: 'was aborted', result: failedPreflight('Reviewer preflight was aborted.', 'aborted') },
      { name: 'usage limit', diagnostic: 'usage limit reached', result: failedPreflight('Reviewer usage limit reached.', 'usage-limit') },
      { name: 'output limit', diagnostic: 'output exceeded', result: failedPreflight('Reviewer preflight output exceeded the bounded output limit.') },
      { name: 'identity', diagnostic: 'did not report a resolved', result: failedPreflight('Reviewer preflight did not report a resolved provider/model identity.', 'identity-mismatch') },
      { name: 'thrown rejection', diagnostic: 'preflight rejected unexpectedly', rejection: new Error('preflight rejected unexpectedly') }
    ]

    for (const mode of ['full', 'plugin'] as const) {
      const source = inventory()
      const pluginId = source.plugins[0]!.id
      const scopedTargets = mode === 'plugin'
        ? source.targets.filter((target) => target.plugin === pluginId)
        : source.targets
      for (const failure of failures) {
        const visualOptions = { ...options(), ...(mode === 'plugin' ? { plugin: pluginId } : {}) }
        let preflightCalls = 0
        let captureCalls = 0
        let reviewCalls = 0
        const result = await measureVisuals(source, visualOptions, {
          preflight: async () => {
            preflightCalls++
            if (failure.rejection) throw failure.rejection
            return failure.result!
          },
          capture: async () => {
            captureCalls++
            return captureManifest(source)
          },
          review: async (manifest) => {
            reviewCalls++
            return reviewReport(manifest)
          }
        })

        expect(preflightCalls).toBe(1)
        expect(captureCalls).toBe(0)
        expect(reviewCalls).toBe(0)
        expect(result.operationalError).toBe(true)
        expect(result.cells).toHaveLength(scopedTargets.length * THEMES.length)
        expect(result.cells.every((visual) => visual.status === 'fail' && visual.code === 'reviewer-preflight' &&
          visual.score === null && visual.assessment === null && visual.image === null && visual.reference === null && visual.reviewer === null)).toBe(true)
        expect(result.failures.some((entry) => entry.code === 'reviewer-preflight' && entry.message.includes(failure.diagnostic))).toBe(true)
        expect(existsSync(join(visualOptions.outputDir, 'capture-manifest.json'))).toBe(false)
        expect(existsSync(join(visualOptions.outputDir, 'reviews'))).toBe(false)
      }
    }
  })

  test('plugin measurement requires a filtered manifest with exactly its selector', async () => {
    const source = inventory()
    const pluginId = source.plugins[0]!.id
    const targets = source.targets.filter((target) => target.plugin === pluginId)
    const malformed = [
      captureManifest(source, { scope: 'full', selectors: [], targets }),
      captureManifest(source, { scope: 'filtered', selectors: ['another-plugin'], targets }),
      captureManifest(source, { scope: 'filtered', selectors: [pluginId, 'another-plugin'], targets }),
    ]

    for (const manifest of malformed) {
      const result = await measureVisuals(source, { ...options(), plugin: pluginId }, dependencies(manifest))
      expect(result.operationalError).toBe(true)
      expect(result.failures.some((failure) => failure.code === 'filtered-capture')).toBe(true)
      expect(result.targets.every((target) => target.plugin === pluginId)).toBe(true)
      expect(result.cells.every((visual) => visual.plugin === pluginId && visual.status === 'fail')).toBe(true)
    }
  })

  test('plugin measurement rejects and does not leak another plugin from a filtered manifest', async () => {
    const source = inventory()
    const pluginId = source.plugins[0]!.id
    const foreign: CaptureTarget = { id: 'view:other.plugin/private', plugin: 'other.plugin', title: 'Private', kind: 'view' }
    source.plugins.push({ id: 'other.plugin', directory: 'plugins/other.plugin', hasUi: true, targets: [foreign.id], sources: [] })
    source.targets.push(foreign)
    source.contributionInventory = {
      declaredTargets: [...source.contributionInventory!.declaredTargets, foreign]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      toolAliases: source.contributionInventory!.toolAliases
    }
    const targets = source.targets.filter((target) => target.plugin === pluginId)
    const manifest = captureManifest(source, { scope: 'filtered', selectors: [pluginId], targets })
    manifest.targets.push(foreign)
    manifest.captures.push(...THEMES.map((theme) => ({
      targetId: foreign.id,
      theme,
      image: image(`/fixture/${foreign.id}/${theme}.png`, 'e'),
      reference: image(`/goldens/${theme}.png`, 'f'),
      status: 'captured' as const
    })))
    const result = await measureVisuals(source, { ...options(), plugin: pluginId }, dependencies(manifest))

    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.code === 'target-ownership')).toBe(true)
    expect(result.targets.every((target) => target.plugin === pluginId)).toBe(true)
    expect(result.cells.every((visual) => visual.plugin === pluginId)).toBe(true)
    expect(result.targets.some((target) => target.id === foreign.id)).toBe(false)
    expect(result.cells.some((visual) => visual.targetId === foreign.id)).toBe(false)
  })


  test('uses each image score independently and ignores the review passed flag', async () => {
    const source = inventory()
    const firstTarget = source.targets[0]!
    const scores = new Map<string, number>([[`${firstTarget.id}\0dark`, 99], [`${firstTarget.id}\0light`, 84]])
    const result = await measureVisuals(source, options(), dependencies(captureManifest(source), async (manifest) => {
      const report = reviewReport(manifest, {
        captures: manifest.captures.map((capture) => {
          const score = scores.get(`${capture.targetId}\0${capture.theme}`) ?? 85
          const perDimension = Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, score])) as VisualAssessment['scores']
          return reviewedCapture(capture.targetId, capture.theme, score, {
            passed: true,
            score,
            assessment: assessment(perDimension)
          })
        })
      })
      return report
    }))

    expect(cell(result, firstTarget.id, 'dark')).toMatchObject({ status: 'pass', score: 99 })
    expect(cell(result, firstTarget.id, 'light')).toMatchObject({ status: 'fail', score: 84 })
  })

  const reviewerIdentityDrifts: Array<[string, keyof ReviewedCapture['reviewer'], string]> = [
    ['provider', 'provider', 'alternate-provider'],
    ['model', 'model', 'later-model'],
    ['family', 'family', 'anthropic'],
    ['sample alias', 'alias', 'other-alias']
  ]
  test.each(reviewerIdentityDrifts)('rejects a whole target when its later sample %s drifts from preflight', async (_name, field, value) => {
    const source = inventory()
    const firstTarget = [...source.targets].sort((left, right) => left.id.localeCompare(right.id))[0]!
    const reviewedTargets: string[] = []
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => captureManifest(source),
      review: async (manifest) => {
        reviewedTargets.push(manifest.targets[0]!.id)
        const report = reviewReport(manifest)
        Object.assign(report.captures.find((capture) => capture.theme === 'light')!.reviewer, { [field]: value })
        return report
      }
    })

    expect(reviewedTargets).toEqual([firstTarget.id])
    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.code === 'review-error' && failure.targetId === firstTarget.id)).toBe(true)
    for (const theme of THEMES) {
      expect(cell(result, firstTarget.id, theme)).toMatchObject({
        score: null,
        assessment: null,
        reviewer: null
      })
    }
  })

  test('rejects a consistent later model identity for the whole target before mapping evidence', async () => {
    const source = inventory()
    const firstTarget = [...source.targets].sort((left, right) => left.id.localeCompare(right.id))[0]!
    const reviewedTargets: string[] = []
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => captureManifest(source),
      review: async (manifest) => {
        reviewedTargets.push(manifest.targets[0]!.id)
        const report = reviewReport(manifest)
        for (const sample of report.captures) sample.reviewer.model = 'later-model'
        return report
      }
    })

    expect(reviewedTargets).toEqual([firstTarget.id])
    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.code === 'review-error' && failure.targetId === firstTarget.id)).toBe(true)
    expect(THEMES.every((theme) => cell(result, firstTarget.id, theme).score === null)).toBe(true)
  })

  test('retains the source inventory, missing surfaces, duplicate cells, and missing images as failed rows', async () => {
    const source = inventory()
    delete source.contributionInventory
    const [missingTarget, duplicateTarget, imageTarget] = source.targets
    if (!missingTarget || !duplicateTarget || !imageTarget) throw new Error('fixture inventory needs host targets')
    const runtimeTargets = source.targets.filter((target) => target.id !== missingTarget.id)
    const manifest = captureManifest(source, { targets: runtimeTargets })
    const duplicated = manifest.captures.find((capture) => capture.targetId === duplicateTarget.id && capture.theme === 'light')!
    manifest.captures.push({ ...duplicated })
    const missingImage = manifest.captures.find((capture) => capture.targetId === imageTarget.id && capture.theme === 'dark')!
    Object.assign(missingImage, { image: null, status: 'failed', error: 'screenshot unavailable' })
    const result = await measureVisuals(source, options(), dependencies(manifest))

    expect(result.targets.map((target) => target.id)).toContain(missingTarget.id)
    expect(cell(result, missingTarget.id, 'dark')).toMatchObject({ status: 'fail', code: 'surface-not-captured' })
    expect(cell(result, duplicateTarget.id, 'light')).toMatchObject({ status: 'fail', code: 'duplicate-cell' })
    expect(cell(result, imageTarget.id, 'dark')).toMatchObject({ status: 'fail', code: 'missing-image' })
  })
  test('keeps a failed mount non-operational while reviewing other complete targets', async () => {
    const source = inventory()
    const failedTarget = source.targets.find((target) => target.plugin !== null)!
    const failure = `${failedTarget.id} failed to mount in dark theme`
    const manifest = captureManifest(source, { failures: [failure] })
    const missingImage = manifest.captures.find((capture) => capture.targetId === failedTarget.id && capture.theme === 'dark')!
    Object.assign(missingImage, { image: null, status: 'failed', error: failure })
    const reviewedTargets = new Set<string>()
    const result = await measureVisuals(source, options(), dependencies(manifest, async (filtered) => {
      reviewedTargets.add(filtered.targets[0]!.id)
      return reviewReport(filtered)
    }))

    expect(result.failures.some((entry) => entry.message === failure)).toBe(true)
    expect(result.operationalError).toBe(false)
    expect(cell(result, failedTarget.id, 'dark')).toMatchObject({ status: 'fail', code: 'missing-image' })
    expect(reviewedTargets.has(failedTarget.id)).toBe(false)
    expect(reviewedTargets.size).toBe(source.targets.length - 1)
    expect(result.cells.filter((visual) => visual.targetId !== failedTarget.id).every((visual) => visual.status === 'pass')).toBe(true)
  })

  test('reports runtime extras and invalid ownership without discarding targets', async () => {
    const source = inventory()
    const extra: CaptureTarget = { id: 'runtime:extra', plugin: 'acme.unknown', title: 'Extra', kind: 'panel' }
    const manifest = captureManifest(source)
    manifest.targets.push(extra)
    manifest.captures.push(...THEMES.map((theme) => ({
      targetId: extra.id,
      theme,
      image: image(`/fixture/${extra.id}/${theme}.png`, 'e'),
      reference: image(`/goldens/${theme}.png`, 'f'),
      status: 'captured' as const
    })))
    const result = await measureVisuals(source, options(), dependencies(manifest))

    expect(result.targets).toContainEqual(extra)
    expect(result.failures.some((failure) => failure.message.includes(extra.id))).toBe(true)
    expect(result.operationalError).toBe(true)
  })

  test('rejects filtered, stale-commit, and target-mismatched capture manifests', async () => {
    const source = inventory()
    const malformed = [
      captureManifest(source, { scope: 'filtered', selectors: ['plugin'] }),
      captureManifest(source, { selectors: ['plugin'] }),
      captureManifest(source, { commit: 'stale-commit' })
    ]

    for (const manifest of malformed) {
      const result = await measureVisuals(source, options(), dependencies(manifest))
      expect(result.operationalError).toBe(true)
      expect(result.cells.some((visual) => visual.status === 'pass')).toBe(false)
    }

    const target = source.targets.find((candidate) => candidate.plugin !== null)!
    const wrongKind = captureManifest(source)
    const row = wrongKind.targets.find((candidate) => candidate.id === target.id)!
    Object.assign(row, { kind: row.kind === 'view' ? 'panel' : 'view' })
    const result = await measureVisuals(source, options(), dependencies(wrongKind))
    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.message.includes(target.id))).toBe(true)
  })

  test('preserves partial reviewer evidence and stops after an operational reviewer error', async () => {
    const source = inventory()
    const calls: string[] = []
    const result = await measureVisuals(source, options(), dependencies(captureManifest(source), async (manifest) => {
      calls.push(manifest.targets[0]!.id)
      return completeAssessmentCapture(manifest, manifest.targets[0]!.id, 'dark', {
        score: 95,
        assessment: assessment({ palette: 95, typography: 95, spacing: 95, components: 95, hierarchy: 95 })
      }, { status: 'error', failures: ['reviewer quota exceeded'] })
    }))
    const firstTarget = [...source.targets].sort((left, right) => left.id.localeCompare(right.id))[0]!

    expect(calls).toEqual([firstTarget.id])
    expect(result.operationalError).toBe(true)
    expect(cell(result, firstTarget.id, 'dark')).toMatchObject({ status: 'pass', score: 95 })
    expect(result.failures.some((failure) => failure.message.includes('reviewer quota exceeded'))).toBe(true)
    expect(result.cells.filter((visual) => visual.targetId !== firstTarget.id || visual.theme !== 'dark')
      .every((visual) => visual.status === 'fail' && visual.reasons.length > 0)).toBe(true)
  })

  test('a passed review that omits a cell stops all later target reviews', async () => {
    const source = inventory()
    const calls: string[] = []
    const firstTarget = [...source.targets].sort((left, right) => left.id.localeCompare(right.id))[0]!
    const result = await measureVisuals(source, options(), dependencies(captureManifest(source), async (manifest) => {
      calls.push(manifest.targets[0]!.id)
      return completeAssessmentCapture(manifest, manifest.targets[0]!.id, 'dark', {
        score: 95,
        assessment: assessment({ palette: 95, typography: 95, spacing: 95, components: 95, hierarchy: 95 })
      })
    }))

    expect(calls).toEqual([firstTarget.id])
    expect(result.operationalError).toBe(true)
    expect(cell(result, firstTarget.id, 'dark')).toMatchObject({ status: 'pass', score: 95 })
    expect(cell(result, firstTarget.id, 'light')).toMatchObject({ status: 'fail', code: 'review-not-completed', score: null })
    expect(result.cells.filter((visual) => visual.targetId !== firstTarget.id)
      .every((visual) => visual.code === 'review-not-completed' && visual.score === null)).toBe(true)
  })

  test('rejects invisible, unread, malformed, unknown-dimension, and inconsistent assessments', async () => {
    const source = inventory()
    const target = source.targets[0]!
    const invalid: Array<Partial<ReviewedCapture>> = [
      { assessment: assessment({}, { targetVisible: false }) },
      { assessment: assessment({}, { imagesRead: false }) },
      { assessment: assessment({ palette: Number.NaN }) },
      { assessment: assessment({ palette: Number.POSITIVE_INFINITY }) },
      { assessment: assessment({ palette: -1 }) },
      { assessment: assessment({ palette: 101 }) },
      { assessment: { ...assessment(), scores: { ...assessment().scores, surprise: 85 } as VisualAssessment['scores'] } },
      { score: 84 }
    ]

    for (const override of invalid) {
      const result = await measureVisuals(source, options(), dependencies(captureManifest(source), async (manifest) =>
        completeAssessmentCapture(manifest, target.id, 'dark', override)))
      expect(cell(result, target.id, 'dark').status).toBe('fail')
    }
  })
  test('blocks dirty source and flags source changes during capture without discarding measured cells', async () => {
    const dirtySnapshot = inventory()
    const sourceFile = join(dirtySnapshot.repoRoot, dirtySnapshot.plugins[0]!.directory, 'src/ui.tsx')
    writeFileSync(sourceFile, 'export const View = () => <div>dirty</div>\n')
    const dirty = collectInventory(dirtySnapshot.repoRoot)
    let captureStarted = false
    let preflightStarted = false
    const dirtyResult = await measureVisuals(dirty, options(), {
      preflight: async () => {
        preflightStarted = true
        return successfulPreflightResult
      },
      capture: async () => {
        captureStarted = true
        return captureManifest(dirty)
      },
      review: async (manifest) => reviewReport(manifest)
    })
    expect(preflightStarted).toBe(false)
    expect(captureStarted).toBe(false)
    expect(dirtyResult.failures.some((failure) => failure.code === 'dirty-source')).toBe(true)

    const snapshot = inventory()
    const manifest = captureManifest(snapshot)
    const staleResult = await measureVisuals(snapshot, options(), {
      preflight: successfulPreflight,
      capture: async () => {
        writeFileSync(join(snapshot.repoRoot, snapshot.plugins[0]!.directory, 'src/ui.tsx'), 'export const View = () => <div>changed</div>\n')
        return manifest
      },
      review: async (filtered) => reviewReport(filtered)
    })
    expect(staleResult.failures.some((failure) => failure.code === 'source-changed')).toBe(true)
    expect(staleResult.cells.every((visual) => visual.status === 'pass')).toBe(true)
  })

  test('capture exceptions preserve the complete matrix as operational failures', async () => {
    const source = inventory()
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => { throw new Error('Chromium unavailable') },
      review: async (manifest) => reviewReport(manifest)
    })

    expect(result.operationalError).toBe(true)
    expect(result.cells).toHaveLength(source.targets.length * THEMES.length)
    expect(result.cells.every((visual) => visual.status === 'fail' && visual.score === null && visual.reasons.length > 0)).toBe(true)
    expect(result.failures.some((failure) => failure.message.includes('Chromium unavailable'))).toBe(true)
  })

  test('notRunVisuals marks every target and theme as unmeasured', () => {
    const source = inventory()
    const result = notRunVisuals(source)

    expect(result.cells).toHaveLength(source.targets.length * THEMES.length)
    expect(result.cells.every((visual) => visual.status === 'fail' && visual.code === 'not-run' && visual.score === null)).toBe(true)
    expect(result.targets.map((target) => target.id)).toEqual(source.targets.map((target) => target.id).sort((left, right) => left.localeCompare(right)))
  })
  test('reconciles source and runtime contribution metadata before reviewing projected targets', async () => {
    const { source, body, declaration } = projectedInventory()
    const manifest = projectedManifest(source)
    const runtimeInventory = (manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory
    const runtimeBody = manifest.targets.find((target) => target.id === body.id)!
    runtimeBody.title = 'Runtime body title'
    for (const target of runtimeInventory.declaredTargets) {
      if (target.id === body.id) target.title = runtimeBody.title
      if (target.id === declaration.id) target.title = 'Runtime navigation title'
    }
    for (const alias of runtimeInventory.toolAliases) {
      if (alias.declaration.id === declaration.id) alias.declaration.title = 'Runtime navigation title'
      if (alias.renderedTarget.id === body.id) alias.renderedTarget.title = runtimeBody.title
    }
    const reviewCalls: CaptureManifest[] = []
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => manifest,
      review: async (filtered) => {
        reviewCalls.push(structuredClone(filtered))
        return reviewReport(filtered)
      }
    })
    expect(result.failures).toEqual([])
    const reviewedBody = reviewCalls.find((filtered) => filtered.targets[0]?.id === body.id)!
    const scopedMetadata = (reviewedBody as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory

    expect(result.operationalError).toBe(false)
    expect(result.cells).toHaveLength(20)
    expect(result.cells.filter((visual) => visual.plugin === 'acme.ui')).toHaveLength(10)
    expect(result.cells.filter((visual) => visual.plugin === null)).toHaveLength(10)
    expect(result.cells.every((visual) => visual.status === 'pass')).toBe(true)
    expect(reviewCalls).toHaveLength(10)
    const aliasIds = source.contributionInventory!.toolAliases.map((alias) => alias.declaration.id)
    expect(source.contributionInventory!.declaredTargets.filter((target) => target.plugin === 'acme.ui')).toHaveLength(10)
    expect(manifest.contributionInventory!.toolAliases).toHaveLength(5)
    expect(aliasIds.every((id) => !result.cells.some((visual) => visual.targetId === id))).toBe(true)
    expect(aliasIds.every((id) => !manifest.captures.some((capture) => capture.targetId === id))).toBe(true)
    expect(scopedMetadata.toolAliases).toHaveLength(1)
    expect(scopedMetadata.toolAliases[0]).toMatchObject({
      declaration: { id: declaration.id, plugin: declaration.plugin, kind: declaration.kind },
      toolId: declaration.id,
      renderedTarget: { id: body.id, plugin: body.plugin, kind: body.kind },
      reason: 'tool-navigation-alias'
    })
  })

  type ContributionMutation = (source: Inventory, manifest: CaptureManifest, body: CaptureTarget, declaration: CaptureTarget) => void
  const contributionMutations: Array<[string, string, ContributionMutation]> = [
    ['missing a declared target', 'contribution-inventory', (source: Inventory, manifest: CaptureManifest) => {
      const omitted = source.targets.find((target) => target.id === 'sidebar-section:quirky.agent-status/dashboard')!
      manifest.targets = manifest.targets.filter((target) => target.id !== omitted.id)
      manifest.captures = manifest.captures.filter((capture) => capture.targetId !== omitted.id)
    }],
    ['deleting the runtime alias record', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases = []
    }],
    ['deleting the source alias record', 'contribution-inventory', (source: Inventory) => {
      ;(source as Inventory & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases = []
    }],
    ['omitting runtime metadata from a legacy capture when source aliases exist', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      delete (manifest as CaptureManifest & { contributionInventory?: TestContributionInventory }).contributionInventory
    }],
    ['forging an alias for an ordinary target', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest, body: CaptureTarget) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases.push({
        declaration: body, toolId: body.id, renderedTarget: body, reason: 'tool-navigation-alias'
      })
    }],
    ['changing the alias body', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases[0]!.renderedTarget.id = 'view:acme.ui/unknown'
    }],
    ['changing the tool ID', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases[0]!.toolId = 'panel:acme.ui/forged'
    }],
    ['changing the alias owner', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases[0]!.renderedTarget.plugin = 'acme.other'
    }],
    ['changing the declaration kind', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases[0]!.declaration.kind = 'activity-item'
    }],
    ['duplicating an alias record', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      const aliases = (manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases
      aliases.push(structuredClone(aliases[0]!))
    }],
    ['creating a self-alias', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest) => {
      const alias = (manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.toolAliases[0]!
      alias.renderedTarget = structuredClone(alias.declaration)
    }],
    ['adding a capture row for an alias declaration', 'contribution-inventory', (_source: Inventory, manifest: CaptureManifest, _body: CaptureTarget, declaration: CaptureTarget) => {
      const capture = manifest.captures[0]!
      manifest.captures.push({ ...capture, targetId: declaration.id, theme: 'dark' })
    }]
  ]
  test.each(contributionMutations)('rejects contribution mutation: %s', async (_description, expectedCode, mutate) => {
    const { source, body, declaration } = projectedInventory(true)
    const manifest = projectedManifest(source)
    mutate(source, manifest, body, declaration)
    let reviewCalls = 0
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => manifest,
      review: async (filtered) => {
        reviewCalls++
        return reviewReport(filtered)
      }
    })

    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.code === expectedCode)).toBe(true)
    expect(reviewCalls).toBe(0)
  })

  test('duplicate cells fail with contribution metadata while other projected targets remain reviewable', async () => {
    const { source, body } = projectedInventory()
    const manifest = projectedManifest(source)
    const duplicate = manifest.captures.find((capture) => capture.targetId === body.id && capture.theme === 'dark')!
    manifest.captures.push({ ...duplicate })
    const reviewedTargets: string[] = []

    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => manifest,
      review: async (filtered) => {
        reviewedTargets.push(filtered.targets[0]!.id)
        return reviewReport(filtered)
      }
    })

    expect(manifest.contributionInventory!.toolAliases).toHaveLength(5)
    expect(result.failures).toEqual([])
    expect(result.operationalError).toBe(false)
    expect(cell(result, body.id, 'dark')).toMatchObject({ status: 'fail', code: 'duplicate-cell', score: null })
    expect(cell(result, body.id, 'light')).toMatchObject({ status: 'fail', code: 'review-not-completed', score: null })
    expect(reviewedTargets.sort()).toEqual(source.targets.filter((target) => target.id !== body.id).map((target) => target.id).sort())
    expect(result.cells.filter((visual) => visual.targetId !== body.id).every((visual) => visual.status === 'pass')).toBe(true)
  })

  test('runtime-only contributions remain ownership failures and are never reviewed', async () => {
    const { source } = projectedInventory()
    const manifest = projectedManifest(source)
    const extra: CaptureTarget = { id: 'view:acme.ui/runtime-only', plugin: 'acme.ui', title: 'Runtime only', kind: 'view' }
    manifest.targets.push(extra)
    manifest.captures.push(...THEMES.map((theme) => ({
      targetId: extra.id,
      theme,
      image: image(`/fixture/${extra.id}/${theme}.png`, 'e'),
      reference: image(`/goldens/${theme}.png`, 'f'),
      status: 'captured' as const
    })))
    ;(manifest as CaptureManifest & { contributionInventory: TestContributionInventory }).contributionInventory.declaredTargets.push(extra)
    let reviewCalls = 0
    const result = await measureVisuals(source, options(), {
      preflight: successfulPreflight,
      capture: async () => manifest,
      review: async (filtered) => {
        reviewCalls++
        return reviewReport(filtered)
      }
    })

    expect(result.operationalError).toBe(true)
    expect(result.failures.some((failure) => failure.code === 'target-ownership' && failure.targetId === extra.id)).toBe(true)
    expect(reviewCalls).toBe(0)
  })

})
