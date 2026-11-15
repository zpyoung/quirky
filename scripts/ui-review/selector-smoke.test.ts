import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
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
import { chromium } from 'playwright'
import { captureApplication } from './capture'
import { SCREENSHOT_SIZE, goldenFor, pngDimensions } from './goldens'
import { reviewManifest } from './review'
import type { ReviewReport } from './contracts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const BUILD_AND_CAPTURE_TIMEOUT_MS = 600_000
const TARGET_IDS = ['host:shell', 'host:scoped', 'host:popups'] as const
const THEMES = ['dark', 'light'] as const

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

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
const metadata = JSON.parse(prompt.slice(markerIndex + marker.length))
const image = fs.readFileSync(metadata.imagePath)
const reference = fs.readFileSync(metadata.goldenPath)
if (image.length === 0 || reference.length === 0) process.exit(3)
process.stderr.write('  ▶ resolved google/gemini-3.1-pro-preview:high (alias gemini)' + String.fromCharCode(10))
process.stdout.write(JSON.stringify({
  targetVisible: true,
  imagesRead: true,
  scores: { palette: 85, typography: 85, spacing: 85, components: 85, hierarchy: 85 },
  reasons: ['The selected host surface is visible in the captured image.', 'The layout and palette are compared with the approved theme reference.']
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

const executable = chromiumExecutable()
if (!executable) {
  console.warn('selector smoke test skipped: no Chromium is installed; run `bunx playwright install chromium` to enable it')
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

test.skipIf(!executable)('the real shell, scoped and popups captures review six filtered dark and light cells', async () => {
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
      browserExecutable: executable!,
      themes: THEMES,
      timeoutMs: 180_000
    })

    expect(manifest.failures).toEqual([])
    expect(manifest.commit).toBe(checkoutHead)
    expect(manifest.scope).toBe('filtered')
    expect(manifest.selectors).toEqual([...TARGET_IDS])
    expect(manifest.targets.map((target) => target.id)).toEqual([...TARGET_IDS])
    expect(manifest.captures).toHaveLength(6)
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
    expect(report.captures).toHaveLength(6)
    expect(report.captures.map((capture) => `${capture.targetId}\0${capture.theme}`).sort()).toEqual(expectedCells)
    expect(report.captures.every((capture) =>
      capture.passed &&
      capture.score === 85 &&
      capture.assessment.targetVisible &&
      capture.assessment.imagesRead &&
      Object.values(capture.assessment.scores).every((score) => score === 85)
    )).toBe(true)

    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(7)
    expect(calls[0]).toEqual(['--check', 'gemini'])
    const reviewedCells = calls.slice(1).map((args) => {
      expect(args.slice(0, 4)).toEqual(['--alias', 'gemini', '--tools', 'read'])
      const prompt = args[args.length - 1]!
      const marker = 'Capture metadata (JSON): '
      const index = prompt.lastIndexOf(marker)
      expect(index).toBeGreaterThanOrEqual(0)
      const metadata = JSON.parse(prompt.slice(index + marker.length)) as { targetId: string; theme: string }
      return `${metadata.targetId}\0${metadata.theme}`
    }).sort()
    expect(reviewedCells).toEqual(expectedCells)
  } finally {
    expect(checkoutOutputFingerprint(repoRoot)).toEqual(checkoutBefore)
  }
}, BUILD_AND_CAPTURE_TIMEOUT_MS)
