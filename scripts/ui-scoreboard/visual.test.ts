import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CaptureManifest, CaptureTarget, ImageEvidence, Inventory, ReviewReport, ReviewedCapture, VisualAssessment, VisualOptions, VisualResult } from './contracts'
import { collectInventory } from './inventory'
import { measureVisuals, notRunVisuals } from './visual'
import { CAPTURE_TIMEOUT_MS, DEFAULT_REVIEWER_ALIAS, REVIEW_TIMEOUT_MS } from '../ui-review/arguments'
import { SCORE_DIMENSIONS, THEMES, type CaptureOptions, type ReviewOptions } from '../ui-review/contracts'
import type { VisualDependencies } from './contracts'

const tempDirs: string[] = []

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
  return {
    schemaVersion: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    commit: source.commit,
    surface: 'desktop-renderer',
    viewport: { width: 1280, height: 800 },
    scope: 'full',
    selectors: [],
    ...overrides,
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

function options(): VisualOptions {
  return { outputDir: outputDir(), authorFamily: 'openai', reviewerAlias: DEFAULT_REVIEWER_ALIAS }
}

function dependencies(manifest: CaptureManifest, review?: VisualDependencies['review']): VisualDependencies {
  return {
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

describe('visual scoreboard measurement', () => {
  test('captures the full two-theme inventory and reviews each complete target with a filtered manifest', async () => {
    const source = inventory()
    const visualOptions = options()
    const fullManifest = captureManifest(source, { failures: ['one optional surface failed to mount'] })
    const original = structuredClone(fullManifest)
    const captureOptions: CaptureOptions[] = []
    const reviewCalls: Array<{ manifest: CaptureManifest; options: ReviewOptions }> = []
    const result = await measureVisuals(source, visualOptions, {
      capture: async (received) => {
        captureOptions.push(received)
        return fullManifest
      },
      review: async (manifest, received) => {
        reviewCalls.push({ manifest: structuredClone(manifest), options: received })
        return reviewReport(manifest, {
          captures: manifest.captures.map((capture) => reviewedCapture(capture.targetId, capture.theme, 85, { passed: false }))
        })
      }
    })

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

  test('retains the source inventory, missing surfaces, duplicate cells, and missing images as failed rows', async () => {
    const source = inventory()
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
    const dirtyResult = await measureVisuals(dirty, options(), {
      capture: async () => {
        captureStarted = true
        return captureManifest(dirty)
      },
      review: async (manifest) => reviewReport(manifest)
    })
    expect(captureStarted).toBe(false)
    expect(dirtyResult.failures.some((failure) => failure.code === 'dirty-source')).toBe(true)

    const snapshot = inventory()
    const manifest = captureManifest(snapshot)
    const staleResult = await measureVisuals(snapshot, options(), {
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
})
