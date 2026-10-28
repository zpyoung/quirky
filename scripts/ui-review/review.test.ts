import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CAPTURE_SCHEMA_VERSION, type CaptureManifest, type ReviewOptions } from './contracts'
import { reviewManifest } from './review'

const goldenPaths = {
  dark: fileURLToPath(new URL('../../docs/quirk/specs/2026-10-28-ui-redesign/img/golden-dark.png', import.meta.url)),
  light: fileURLToPath(new URL('../../docs/quirk/specs/2026-10-28-ui-redesign/img/golden-light.png', import.meta.url))
}
let scratch = ''
let outputDir = ''
let reviewerExecutable = ''
let childPidFile = ''
let reviewStartedFile = ''
let previousEnv = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined): void {
  if (!previousEnv.has(name)) previousEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ui-review-review-test-'))
  outputDir = join(scratch, 'output')
  mkdirSync(outputDir)
  const testHome = join(scratch, 'home')
  mkdirSync(testHome)
  const quirkyHome = join(scratch, 'quirky-home')
  mkdirSync(quirkyHome)
  childPidFile = join(scratch, 'review-child.pid')
  reviewStartedFile = join(scratch, 'review-started')
  setEnv('HOME', testHome)
  setEnv('QUIRKY_HOME', quirkyHome)
  setEnv('XDG_CONFIG_HOME', join(testHome, '.config'))
  setEnv('UI_REVIEW_FAKE_MODE', 'pass')
  setEnv('UI_REVIEW_FAKE_CHILD_PID', childPidFile)
  setEnv('UI_REVIEW_FAKE_REVIEW_STARTED', reviewStartedFile)
  reviewerExecutable = join(scratch, 'fake-pi-watch.cjs')
  writeFileSync(reviewerExecutable, fakeReviewerSource(), { mode: 0o700 })
  chmodSync(reviewerExecutable, 0o700)
})

afterEach(() => {
  const oldPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) : undefined
  if (oldPid && Number.isSafeInteger(oldPid)) {
    try { process.kill(oldPid, 'SIGKILL') } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  previousEnv = new Map()
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

function capturePng(theme: 'dark' | 'light'): Buffer {
  const source = readFileSync(goldenPaths[theme])
  const ihdrEnd = 8 + 12 + source.readUInt32BE(8)
  const type = Buffer.from('tEXt')
  const data = Buffer.from(['fixture', String.fromCharCode(0), `capture-${theme}`].join(''))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([source.subarray(0, ihdrEnd), length, type, data, checksum, source.subarray(ihdrEnd)])
}

function manifest(): CaptureManifest {
  const targetsDir = mkdtempSync(join(scratch, 'captures-'))
  const captures = (['dark', 'light'] as const).map((theme) => {
    const path = join(targetsDir, `${theme}.png`)
    writeFileSync(path, capturePng(theme))
    return { targetId: 'sample.panel', theme, image: { path, sha256: sha256(path) }, status: 'captured' as const }
  })
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    createdAt: '2026-10-28T12:00:00.000Z',
    commit: 'a'.repeat(40),
    surface: 'desktop-renderer',
    viewport: { width: 1280, height: 800 },
    scope: 'full',
    selectors: [],
    targets: [{ id: 'sample.panel', plugin: 'sample', title: 'Sample panel', kind: 'panel' }],
    references: {
      dark: { path: goldenPaths.dark, sha256: sha256(goldenPaths.dark) },
      light: { path: goldenPaths.light, sha256: sha256(goldenPaths.light) }
    },
    captures,
    failures: []
  }
}

function options(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    outputDir,
    reviewerAlias: 'gemini',
    authorFamily: 'openai',
    threshold: 85,
    timeoutMs: 1_000,
    reviewerExecutable,
    ...overrides
  }
}

function fakeReviewerSource(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const mode = process.env.UI_REVIEW_FAKE_MODE || 'pass';
if (args[0] === '--check') {
  if (mode === 'check-fail') { process.stderr.write('reviewer unavailable' + String.fromCharCode(10)); process.exit(7); }
  process.stderr.write('  ✓ gemini       google/gemini-3.1-pro-preview:high' + String.fromCharCode(10));
  process.exit(0);
}
fs.appendFileSync(process.env.UI_REVIEW_FAKE_REVIEW_STARTED, 'started');
const provider = mode === 'unknown-family' ? 'mystery' : mode === 'github-copilot' ? 'github-copilot' : mode === 'reviewer-same-family' ? 'openai' : 'google';
const model = mode === 'github-copilot' ? 'claude-3.7-sonnet' : mode === 'reviewer-same-family' ? 'gpt-4.1' : 'gemini-3.1-pro-preview';
if (mode === 'timeout') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.UI_REVIEW_FAKE_CHILD_PID, String(child.pid));
  setInterval(() => {}, 60000);
}
if (mode === 'process-fail') { process.stderr.write('dispatch failed' + String.fromCharCode(10)); process.exit(9); }
if (mode === 'env-leak') process.stderr.write('OPENAI_API_KEY=sk-secret-value-123456789012345 HOME=/tmp/private-runtime-home' + String.fromCharCode(10));
const prompt = args[args.length - 1] || '';
if (mode === 'tamper-image') {
  const marker = 'Capture metadata (JSON): ';
  const metadata = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
  fs.appendFileSync(metadata.imagePath, 'tampered');
}
let score = mode === 'bad-score' ? 101 : mode === 'boundary' ? 85 : mode === 'low-dark' && prompt.includes('\"theme\":\"dark\"') ? 84 : 100;
const assessment = {
  targetVisible: mode !== 'target-hidden',
  imagesRead: mode !== 'images-not-read',
  scores: { palette: score, typography: score, spacing: score, components: score, hierarchy: score },
  reasons: ['The target surface and both images were inspected.', 'Spacing and component styling are compared against the approved theme.']
};
process.stderr.write('  ▶ resolved ' + provider + '/' + model + ':high (alias gemini)' + String.fromCharCode(10));
process.stdout.write(mode === 'invalid-json' ? '{"targetVisible": true,' + String.fromCharCode(10) : JSON.stringify(assessment) + String.fromCharCode(10));
`
}

test('an image score exactly at threshold 85 passes', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'boundary')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('passed')
  expect(report.captures).toHaveLength(2)
  expect(report.captures.every((capture) => capture.score === 85 && capture.passed)).toBe(true)
  expect(report.captures.every((capture) => capture.reviewer.provider === 'google' && capture.reviewer.model === 'gemini-3.1-pro-preview')).toBe(true)
  const artifacts = readdirSync(join(outputDir, 'reviewer'))
  expect(artifacts.some((name) => name.endsWith('.response.txt'))).toBe(true)
  expect(artifacts.some((name) => name.endsWith('.log.txt'))).toBe(true)
  expect(artifacts.every((name) => !name.includes('sample.panel'))).toBe(true)
  expect(readFileSync(join(outputDir, 'reviewer', artifacts.find((name) => name.endsWith('.log.txt'))!), 'utf8'))
    .toContain('google/gemini-3.1-pro-preview')
})

test('returned report and saved reviewer logs redact runtime secrets and env values', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'env-leak')
  const report = await reviewManifest(manifest(), options())
  const artifacts = readdirSync(join(outputDir, 'reviewer'))
    .map((name) => readFileSync(join(outputDir, 'reviewer', name), 'utf8'))
  const persisted = [JSON.stringify(report), ...artifacts].join(String.fromCharCode(10))

  expect(report.status).toBe('passed')
  expect(persisted).not.toContain('sk-secret-value-123456789012345')
  expect(persisted).not.toContain('/tmp/private-runtime-home')
  expect(persisted).toContain('[REDACTED')
})

test('one 84 image fails even when its sibling scores 100', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'low-dark')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('failed')
  expect(report.captures.map(({ score }) => score)).toEqual([84, 100])
  expect(report.captures.map(({ passed }) => passed)).toEqual([false, true])
})

test('missing coverage cells are reviewer errors', async () => {
  const input = manifest()
  input.captures.pop()
  const report = await reviewManifest(input, options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/coverage|theme|capture/i)
})

test('duplicate target and theme cells are reviewer errors', async () => {
  const input = manifest()
  input.captures[1] = { ...input.captures[0]! }
  const report = await reviewManifest(input, options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
})

test('unknown target references and empty target inventories are reviewer errors', async () => {
  const empty = manifest()
  empty.targets = []
  const emptyReport = await reviewManifest(empty, options())
  expect(emptyReport.status).toBe('error')
  expect(emptyReport.captures).toHaveLength(0)

  const unknown = manifest()
  unknown.captures[0]!.targetId = 'not-in-target-inventory'
  const unknownReport = await reviewManifest(unknown, options())
  expect(unknownReport.status).toBe('error')
  expect(unknownReport.captures).toHaveLength(0)
  expect(unknownReport.failures.join(' ')).toMatch(/unknown target/i)
})

test('duplicate target IDs are reviewer errors', async () => {
  const input = manifest()
  input.targets.push({ ...input.targets[0]! })
  const report = await reviewManifest(input, options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/duplicate target ID/i)
})

test('a substituted non-approved golden image is rejected', async () => {
  const input = manifest()
  input.references.dark = { path: goldenPaths.light, sha256: sha256(goldenPaths.light) }
  const report = await reviewManifest(input, options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/approved golden/i)
})

test('bad capture and golden digests cannot reach the reviewer', async () => {
  for (const mutate of [
    (input: CaptureManifest) => { input.captures[0]!.image!.sha256 = '0'.repeat(64) },
    (input: CaptureManifest) => { input.references.dark.sha256 = '0'.repeat(64) }
  ]) {
    const input = manifest()
    mutate(input)
    const report = await reviewManifest(input, options())
    expect(report.status).toBe('error')
    expect(report.captures).toHaveLength(0)
  }
})

test('invalid JSON and out-of-range scores are reviewer errors', async () => {
  for (const mode of ['invalid-json', 'bad-score']) {
    setEnv('UI_REVIEW_FAKE_MODE', mode)
    const report = await reviewManifest(manifest(), options())
    expect(report.status).toBe('error')
    expect(report.captures).toHaveLength(0)
  }
})

test('same-family resolved reviewer is rejected', async () => {
  const input = manifest()
  const report = await reviewManifest(input, options({ authorFamily: 'google' }))

  expect(existsSync(reviewStartedFile)).toBe(false)
  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/family|same/i)
})

test('actual model family mismatch is rejected even when preflight passed', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'reviewer-same-family')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/family|author/i)
  expect(existsSync(reviewStartedFile)).toBe(true)
})

test('unknown reviewer provider families are rejected', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'unknown-family')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/unknown provider family/i)
})

test('GitHub Copilot reviewer family follows the resolved model ID', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'github-copilot')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('passed')
  expect(report.captures.every((capture) => capture.reviewer.provider === 'github-copilot')).toBe(true)
  expect(report.captures.every((capture) => capture.reviewer.family === 'anthropic')).toBe(true)
  expect(report.captures.every((capture) => capture.reviewer.model === 'claude-3.7-sonnet')).toBe(true)
})

test('an invisible target fails even when every rubric score is 100', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'target-hidden')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('failed')
  expect(report.captures.map(({ score }) => score)).toEqual([100, 100])
  expect(report.captures.every(({ passed }) => !passed)).toBe(true)
})

test('review without explicit confirmation that both images were read is an error', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'images-not-read')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
})

test('reviewer image changes invalidate the affected review evidence', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'tamper-image')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('error')
  expect(report.captures.some((capture) => capture.theme === 'dark')).toBe(false)
  expect(report.failures.join(' ')).toMatch(/changed during review/i)
})

test('failed captures cannot be upgraded into passing visual evidence', async () => {
  const input = manifest()
  input.captures[0]!.status = 'failed'
  input.captures[0]!.error = 'renderer did not mount'
  const report = await reviewManifest(input, options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
})

test('reviewer process failures are reported without passing captures', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'process-fail')
  const report = await reviewManifest(manifest(), options())

  expect(report.status).toBe('error')
  expect(report.captures).toHaveLength(0)
  expect(report.failures.join(' ')).toMatch(/reviewer|process|dispatch/i)
})

test('timed-out reviewer and its owned child are terminated', async () => {
  setEnv('UI_REVIEW_FAKE_MODE', 'timeout')
  const report = await reviewManifest(manifest(), options({ timeoutMs: 2_000 }))

  expect(report.status).toBe('error')
  expect(report.failures.join(' ')).toMatch(/timed out|timeout/i)
  const childPid = Number(readFileSync(childPidFile, 'utf8'))
  const processState = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(childPid)])
  expect(processState.exitCode === 1 || processState.stdout.toString().trim().startsWith('Z')).toBe(true)
  rmSync(childPidFile)
})
