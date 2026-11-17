import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserExecutable } from '../test-support/browser'
import { captureApplication } from './capture'
import { SCREENSHOT_SIZE, goldenFor, pngDimensions } from './goldens'
import { reviewManifest } from './review'
import type { ReviewReport } from './contracts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const BUILD_AND_CAPTURE_TIMEOUT_MS = 600_000
const TARGET_IDS = ['host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'] as const
const THEMES = ['dark', 'light'] as const
const executable = browserExecutable()

type OutputFingerprint = {
  path: string
  kind: 'missing' | 'directory' | 'file' | 'symlink' | 'other'
  mode?: number
  dev?: number
  ino?: number
  size?: number
  mtimeMs?: number
  ctimeMs?: number
  sha256?: string
  linkTarget?: string
}

function recordOutputPath(path: string, entries: OutputFingerprint[], recurse = true) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    entries.push({ path, kind: 'missing' })
    return undefined
  }

  const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  const entry: OutputFingerprint = {
    path,
    kind,
    mode: info.mode,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs
  }
  if (info.isSymbolicLink()) {
    entry.linkTarget = readlinkSync(path)
  } else if (info.isFile()) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error(`checkout output changed while fingerprinting ${path}`)
      }
      entry.sha256 = createHash('sha256').update(readFileSync(descriptor)).digest('hex')
    } finally {
      closeSync(descriptor)
    }
  }
  entries.push(entry)

  if (recurse && info.isDirectory()) {
    for (const name of readdirSync(path).sort()) recordOutputPath(join(path, name), entries)
  }
  return info
}

function checkoutOutputFingerprint(checkout: string): OutputFingerprint[] {
  const entries: OutputFingerprint[] = []
  recordOutputPath(join(checkout, 'packages/ui/dist'), entries)

  const pluginsRoot = join(checkout, 'plugins')
  const pluginsInfo = recordOutputPath(pluginsRoot, entries, false)
  if (pluginsInfo?.isDirectory()) {
    for (const name of readdirSync(pluginsRoot).sort()) {
      const pluginRoot = join(pluginsRoot, name)
      const pluginInfo = recordOutputPath(pluginRoot, entries, false)
      if (pluginInfo?.isDirectory()) recordOutputPath(join(pluginRoot, 'dist'), entries)
    }
  }

  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function createLocalReviewer(callsPath: string): { executable: string; isolatedPath: string } {
  const executable = join(scratch, 'fake-pi-watch.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + String.fromCharCode(10))
if (args[0] === '--check') {
  if (args[1] !== 'gemini') process.exit(2)
  process.stderr.write('  ✓ gemini       google/gemini-3.1-pro-preview:high' + String.fromCharCode(10))
  process.exit(0)
}
const prompt = args[args.length - 1] || ''
const marker = 'Capture metadata (JSON): '
const markerIndex = prompt.lastIndexOf(marker)
if (markerIndex < 0) process.exit(2)
const metadata = JSON.parse(prompt.slice(markerIndex + marker.length).split(/\\r?\\n/, 1)[0])
const image = fs.readFileSync(metadata.imagePath)
const reference = fs.readFileSync(metadata.goldenPath)
if (image.length === 0 || reference.length === 0) process.exit(3)
const contextMatch = /Trusted host contract context \\(canonical JSON; sha256=([a-f0-9]{64})\\):\\n([^\\n]+)/.exec(prompt)
if (!contextMatch) process.exit(4)
const context = JSON.parse(contextMatch[2])
const contextSha256 = createHash('sha256').update(contextMatch[2], 'utf8').digest('hex')
if (contextSha256 !== contextMatch[1]) process.exit(4)
const reasons = ['The selected host surface is visible in the captured image.', 'The layout and palette are compared with the approved theme reference.']
process.stderr.write('  ▶ resolved google/gemini-3.1-pro-preview:high (alias gemini)' + String.fromCharCode(10))
process.stdout.write(JSON.stringify({
  assessment: {
    targetVisible: true,
    imagesRead: true,
    scores: { palette: 85, typography: 85, spacing: 85, components: 85, hierarchy: 85 },
    reasons
  },
  contractAudit: {
    contextSha256,
    acknowledgedRuleIds: context.rules.map((rule) => rule.id).sort(),
    reasonChecks: reasons.map((_, reasonIndex) => ({
      reasonIndex,
      contractIds: [],
      conflictsWithContract: false,
      affectsScore: false
    })),
    conflicts: []
  }
}) + String.fromCharCode(10))
`, { mode: 0o700 })
  chmodSync(executable, 0o700)

  const isolatedPath = join(scratch, 'reviewer-path')
  mkdirSync(isolatedPath)
  const nodeLauncher = join(isolatedPath, 'node')
  writeFileSync(nodeLauncher, `#!/bin/sh
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o700 })
  chmodSync(nodeLauncher, 0o700)
  return { executable, isolatedPath }
}


let scratch = ''
let previousHome: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'quirky-ui-review-smoke-'))
  previousHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = join(scratch, 'quirky-home')
  mkdirSync(process.env.QUIRKY_HOME)
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

test('all five host targets capture and review ten dark and light cells', async () => {
  const outputDir = join(scratch, 'output')
  mkdirSync(outputDir)
  const checkoutHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const checkoutBefore = checkoutOutputFingerprint(repoRoot)

  try {
    const manifest = await captureApplication({
      repoRoot,
      outputDir,
      only: [...TARGET_IDS],
      skipBuild: false,
      browserExecutable: executable,
      themes: THEMES,
      timeoutMs: 180_000
    })

    expect(manifest.failures).toEqual([])
    expect(manifest.commit).toBe(checkoutHead)
    expect(manifest.scope).toBe('filtered')
    expect(manifest.selectors).toEqual([...TARGET_IDS])
    expect(manifest.targets.map((target) => target.id)).toEqual([...TARGET_IDS])
    expect(manifest.captures).toHaveLength(10)
    const expectedCells = TARGET_IDS.flatMap((targetId) => THEMES.map((theme) => `${targetId}\0${theme}`)).sort()
    expect(manifest.captures.map((capture) => `${capture.targetId}\0${capture.theme}`).sort()).toEqual(expectedCells)
    expect(manifest.captures.every((capture) => capture.status === 'captured' && capture.image !== null)).toBe(true)
    for (const capture of manifest.captures) {
      expect(capture.reference.path).toBe(goldenFor(capture.targetId, capture.theme, repoRoot))
      expect(pngDimensions(readFileSync(capture.image!.path))).toEqual({ width: 2800, height: 1760 })
      expect(pngDimensions(readFileSync(capture.image!.path))).toEqual(SCREENSHOT_SIZE)
    }

    const callsPath = join(scratch, 'reviewer-calls.jsonl')
    const reviewer = createLocalReviewer(callsPath)
    const previousPath = process.env.PATH
    let report: ReviewReport
    try {
      process.env.PATH = reviewer.isolatedPath
      report = await reviewManifest(manifest, {
        outputDir,
        reviewerAlias: 'gemini',
        authorFamily: 'openai',
        threshold: 85,
        timeoutMs: 30_000,
        reviewerExecutable: reviewer.executable
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }

    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
    expect(report.threshold).toBe(85)
    expect(report.captures).toHaveLength(10)
    expect(report.captures.map((capture) => `${capture.targetId}\0${capture.theme}`).sort()).toEqual(expectedCells)
    expect(report.selectedCells?.map((cell) => `${cell.targetId}\0${cell.theme}`).sort()).toEqual(expectedCells)
    expect(report.issues).toEqual([])
    expect(report.captures.every((capture) =>
      capture.passed &&
      capture.score === 85 &&
      capture.assessment.targetVisible &&
      capture.assessment.imagesRead &&
      Object.values(capture.assessment.scores).every((score) => score === 85)
    )).toBe(true)

    const reviewerDir = join(outputDir, 'reviewer')
    const contextFiles = readdirSync(reviewerDir).filter((name) => name.endsWith('.context.json'))
    expect(contextFiles).toHaveLength(10)
    for (const capture of report.captures) {
      const evidence = capture.contractReview!
      const contextBytes = readFileSync(evidence.contextPath, 'utf8')
      const context = JSON.parse(contextBytes) as {
        targetId: string
        theme: string
        rules: Array<{ id: string }>
      }
      const contextDigest = createHash('sha256').update(contextBytes, 'utf8').digest('hex')
      expect(contextDigest).toBe(evidence.contextSha256)
      expect(context.targetId).toBe(capture.targetId)
      expect(context.theme).toBe(capture.theme)
      expect(evidence.audit.contextSha256).toBe(contextDigest)
      expect(evidence.audit.acknowledgedRuleIds).toEqual(context.rules.map(({ id }) => id))
    }
    const reportArtifacts = readdirSync(reviewerDir).filter((name) => /^review-report-[0-9a-f-]{36}\.json$/.test(name))
    expect(reportArtifacts).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(reviewerDir, reportArtifacts[0]!), 'utf8'))).toEqual(report)

    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(11)
    expect(calls[0]).toEqual(['--check', 'gemini'])
    const reviewedCells = calls.slice(1).map((args) => {
      expect(args.slice(0, 4)).toEqual(['--alias', 'gemini', '--tools', 'read'])
      const prompt = args[args.length - 1]!
      const marker = 'Capture metadata (JSON): '
      const index = prompt.lastIndexOf(marker)
      expect(index).toBeGreaterThanOrEqual(0)
      const metadata = JSON.parse(prompt.slice(index + marker.length).split(/\r?\n/, 1)[0]!) as { targetId: string; theme: string }
      return `${metadata.targetId}\0${metadata.theme}`
    }).sort()
    expect(reviewedCells).toEqual(expectedCells)
  } finally {
    expect(checkoutOutputFingerprint(repoRoot)).toEqual(checkoutBefore)
  }
}, BUILD_AND_CAPTURE_TIMEOUT_MS)
