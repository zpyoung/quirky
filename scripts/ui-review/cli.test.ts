import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CaptureManifest, ReviewReport } from './contracts'
import { runUiReview, type SignalSource } from '../ui-review'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ui-review-cli-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifest(overrides: Partial<CaptureManifest> = {}): CaptureManifest {
  return {
    schemaVersion: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    commit: 'fixture-commit',
    surface: 'desktop-renderer',
    viewport: { width: 1280, height: 800 },
    scope: 'full',
    selectors: [],
    targets: [{ id: 'host:shell', plugin: null, title: 'Shell', kind: 'host' }],
    captures: [
      { targetId: 'host:shell', theme: 'dark', image: { path: '/captures/dark.png', sha256: 'c'.repeat(64) }, reference: { path: '/goldens/dark.png', sha256: 'a'.repeat(64) }, status: 'captured' },
      { targetId: 'host:shell', theme: 'light', image: { path: '/captures/light.png', sha256: 'd'.repeat(64) }, reference: { path: '/goldens/light.png', sha256: 'b'.repeat(64) }, status: 'captured' }
    ],
    failures: [],
    ...overrides
  }
}

function report(source: CaptureManifest = manifest(), overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    status: 'passed',
    scope: source.scope,
    threshold: 85,
    authorFamily: 'openai',
    reviewerAlias: 'gemini',
    captures: source.captures.flatMap((capture) => {
      if (capture.image === null || capture.status !== 'captured') return []
      return [{
        targetId: capture.targetId,
        theme: capture.theme,
        image: capture.image,
        reference: capture.reference,
        reviewer: { alias: 'gemini', provider: 'google', model: 'test-vision', family: 'google' },
        assessment: {
          targetVisible: true,
          imagesRead: true,
          scores: { palette: 90, typography: 90, spacing: 90, components: 90, hierarchy: 90 },
          reasons: ['Consistent visual hierarchy.']
        },
        score: 90,
        passed: true
      }]
    }),
    failures: [],
    ...overrides
  }
}

function args(outputDir: string): string[] {
  return ['--author-family', 'openai', '--output', outputDir]
}

function fakeSignals(): SignalSource & { emit(signal: 'SIGINT' | 'SIGTERM'): void } {
  const handlers = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>()
  return {
    on(signal, listener) {
      const listeners = handlers.get(signal) ?? new Set()
      listeners.add(listener)
      handlers.set(signal, listeners)
    },
    off(signal, listener) {
      handlers.get(signal)?.delete(listener)
    },
    emit(signal) {
      for (const listener of handlers.get(signal) ?? []) listener()
    }
  }
}

describe('ui review CLI boundary', () => {
  test('help returns before creating output or invoking the application', async () => {
    let mkdirCalled = false
    let captureCalled = false
    let reviewCalled = false
    const exitCode = await runUiReview(['--help'], {
      mkdir: async () => {
        mkdirCalled = true
      },
      captureApplication: async () => {
        captureCalled = true
        return manifest()
      },
      reviewManifest: async () => {
        reviewCalled = true
        return report()
      },
      stdout: () => undefined,
      stderr: () => undefined
    })

    expect(exitCode).toBe(0)
    expect(mkdirCalled).toBe(false)
    expect(captureCalled).toBe(false)
    expect(reviewCalled).toBe(false)
  })
  test('does not overwrite an existing output directory', async () => {
    const parent = makeTempDir()
    const outputDir = join(parent, 'existing')
    mkdirSync(outputDir)
    writeFileSync(join(outputDir, 'keep.txt'), 'preserve me')

    const exitCode = await runUiReview(args(outputDir))

    expect(exitCode).toBe(2)
    expect(readFileSync(join(outputDir, 'keep.txt'), 'utf8')).toBe('preserve me')
    expect(existsSync(join(outputDir, 'capture-manifest.json'))).toBe(false)
  })

  test('persists failed capture evidence and maps coverage failures to exit 1', async () => {
    const outputDir = join(makeTempDir(), 'capture-failure')
    let reviewCalled = false
    const failedManifest = manifest({
      captures: [
        { targetId: 'host:shell', theme: 'dark', image: { path: '/captures/dark.png', sha256: 'c'.repeat(64) }, reference: { path: '/goldens/dark.png', sha256: 'a'.repeat(64) }, status: 'captured' },
        { targetId: 'host:shell', theme: 'light', image: null, reference: { path: '/goldens/light.png', sha256: 'b'.repeat(64) }, status: 'failed', error: 'mount failed' }
      ],
      failures: ['host:shell failed to mount in light theme']
    })

    const exitCode = await runUiReview(args(outputDir), {
      captureApplication: async () => failedManifest,
      reviewManifest: async () => {
        reviewCalled = true
        return report()
      }
    })

    expect(exitCode).toBe(1)
    expect(reviewCalled).toBe(false)
    expect(JSON.parse(readFileSync(join(outputDir, 'capture-manifest.json'), 'utf8'))).toMatchObject({ failures: failedManifest.failures })
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({ status: 'failed', exitCode: 1 })
  })
  test('capture-only reports the selected filtered inventory without claiming a review', async () => {
    const outputDir = join(makeTempDir(), 'filtered-capture')
    let reviewCalled = false
    const filteredManifest = manifest({
      scope: 'filtered',
      selectors: ['quirky.tasks'],
      targets: [{ id: 'quirky.tasks/panel', plugin: 'quirky.tasks', title: 'Tasks', kind: 'panel' }],
      captures: [
        { targetId: 'quirky.tasks/panel', theme: 'dark', image: { path: '/captures/tasks-dark.png', sha256: 'e'.repeat(64) }, reference: { path: '/goldens/dark.png', sha256: 'a'.repeat(64) }, status: 'captured' },
        { targetId: 'quirky.tasks/panel', theme: 'light', image: { path: '/captures/tasks-light.png', sha256: 'f'.repeat(64) }, reference: { path: '/goldens/light.png', sha256: 'b'.repeat(64) }, status: 'captured' }
      ]
    })

    const exitCode = await runUiReview([...args(outputDir), '--capture-only', '--only', 'quirky.tasks'], {
      captureApplication: async () => filteredManifest,
      reviewManifest: async () => {
        reviewCalled = true
        return report(filteredManifest)
      }
    })

    expect(exitCode).toBe(0)
    expect(reviewCalled).toBe(false)
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({
      status: 'not-reviewed',
      scope: 'filtered',
      targetIds: ['quirky.tasks/panel'],
      outputPaths: { reviewReport: null }
    })
  })


  test('persists reviewer runtime errors and maps them to exit 2', async () => {
    const outputDir = join(makeTempDir(), 'review-failure')
    const exitCode = await runUiReview(args(outputDir), {
      captureApplication: async () => manifest(),
      reviewManifest: async () => { throw new Error('reviewer unavailable at https://pi.example/review?access_token=secret-token-value Bearer bearer-secret-value OPENAI_API_KEY=env-secret token=field-secret') }
    })

    expect(exitCode).toBe(2)
    const persistedError = JSON.parse(readFileSync(join(outputDir, 'ui-review-error.json'), 'utf8')) as { status: string; operation: string; diagnostic: string }
    expect(persistedError).toMatchObject({ status: 'error', operation: 'review' })
    expect(persistedError.diagnostic).toContain('reviewer unavailable')
    expect(persistedError.diagnostic).not.toContain('secret-token-value')
    expect(persistedError.diagnostic).not.toContain('bearer-secret-value')
    expect(persistedError.diagnostic).not.toContain('env-secret')
    expect(persistedError.diagnostic).not.toContain('field-secret')
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({ status: 'error', exitCode: 2 })
  })
  test('persists malformed evidence as an error report without starting capture or reviewer', async () => {
    const parent = makeTempDir()
    const manifestPath = join(parent, 'malformed.json')
    const outputDir = join(parent, 'malformed-review')
    const homeDir = join(parent, 'home')
    const configDir = join(parent, 'config')
    const reviewerBinDir = join(parent, 'reviewer-bin')
    const reviewerStartedPath = join(parent, 'reviewer-started')
    const fakeReviewerPath = join(reviewerBinDir, 'pi-watch')
    mkdirSync(reviewerBinDir)
    mkdirSync(homeDir)
    mkdirSync(configDir)
    mkdirSync(join(parent, 'quirky-home'))
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 99 }))
    writeFileSync(fakeReviewerPath, `#!/bin/sh\n: > "${reviewerStartedPath}"\n`)
    chmodSync(fakeReviewerPath, 0o700)

    const originalEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      QUIRKY_HOME: process.env.QUIRKY_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
    }
    process.env.PATH = [reviewerBinDir, originalEnv.PATH].filter((value): value is string => Boolean(value)).join(delimiter)
    process.env.HOME = homeDir
    process.env.QUIRKY_HOME = join(parent, 'quirky-home')
    process.env.XDG_CONFIG_HOME = configDir

    let captureStarted = false
    let exitCode: number
    try {
      exitCode = await runUiReview([
        '--author-family', 'openai', '--output', outputDir, '--manifest', manifestPath
      ], {
        captureApplication: async () => {
          captureStarted = true
          throw new Error('capture should not start in manifest mode')
        },
        stdout: () => undefined,
        stderr: () => undefined
      })
    } finally {
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(exitCode).toBe(2)
    expect(captureStarted).toBe(false)
    expect(existsSync(reviewerStartedPath)).toBe(false)
    expect(JSON.parse(readFileSync(join(outputDir, 'review-report.json'), 'utf8'))).toMatchObject({
      status: 'error',
      captures: []
    })
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({
      status: 'error',
      exitCode: 2
    })
  })
  test('maps a below-threshold image to exit 1 and persists the failed review', async () => {
    const outputDir = join(makeTempDir(), 'low-score')
    const source = manifest()
    const lowScoreReport = report(source, {
      status: 'failed',
      captures: report(source).captures.map((capture) => ({
        ...capture,
        assessment: { ...capture.assessment, scores: { palette: 84, typography: 84, spacing: 84, components: 84, hierarchy: 84 } },
        score: 84,
        passed: false
      })),
      failures: ['host:shell (dark) scored 84 below threshold 85']
    })

    const exitCode = await runUiReview(args(outputDir), {
      captureApplication: async () => source,
      reviewManifest: async () => lowScoreReport
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(readFileSync(join(outputDir, 'review-report.json'), 'utf8'))).toMatchObject({
      status: 'failed',
      failures: lowScoreReport.failures
    })
  })

  test('does not treat an unknown selection as a successful empty capture', async () => {
    const outputDir = join(makeTempDir(), 'unknown-selection')
    const exitCode = await runUiReview([...args(outputDir), '--capture-only', '--only', 'missing.plugin'], {
      captureApplication: async () => { throw new Error('Unknown selector: missing.plugin') }
    })

    expect(exitCode).toBe(2)
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({
      status: 'error',
      exitCode: 2,
      outputPaths: { captureProgress: join(outputDir, 'capture-progress.json') }
    })
  })


  test('review-only mode never invokes capture', async () => {
    const parent = makeTempDir()
    const manifestPath = join(parent, 'capture.json')
    const outputDir = join(parent, 'review-only')
    writeFileSync(manifestPath, JSON.stringify(manifest()))
    let captureCalled = false

    const exitCode = await runUiReview([
      '--author-family', 'openai', '--output', outputDir, '--manifest', manifestPath
    ], {
      captureApplication: async () => {
        captureCalled = true
        throw new Error('capture must not run')
      },
      reviewManifest: async (input) => report(input)
    })

    expect(exitCode).toBe(0)
    expect(captureCalled).toBe(false)
    expect(existsSync(join(outputDir, 'review-report.json'))).toBe(true)
  })


  test('signal exit waits for capture cleanup and uses conventional nonzero status', async () => {
    const outputDir = join(makeTempDir(), 'signal-run')
    const signals = fakeSignals()
    let cleanupFinished = false
    let signalObserved = false
    const signalFailure = manifest({ failures: ['interrupted'] })
    const run = runUiReview([...args(outputDir), '--capture-only'], {
      signals,
      captureApplication: async ({ signal }) => {
        signals.emit('SIGINT')
        await Promise.resolve()
        signalObserved = signal?.aborted === true
        cleanupFinished = true
        return signalFailure
      }
    })

    const exitCode = await run
    expect(signalObserved).toBe(true)

    expect(exitCode).toBe(130)
    expect(cleanupFinished).toBe(true)
    expect(existsSync(join(outputDir, 'capture-manifest.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(outputDir, 'ui-review-result.json'), 'utf8'))).toMatchObject({ exitCode: 130 })
  })
})
