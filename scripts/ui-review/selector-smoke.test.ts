import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { captureApplication } from './capture'
import { SCREENSHOT_SIZE, goldenFor, pngDimensions } from './goldens'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const BUILD_AND_CAPTURE_TIMEOUT_MS = 360_000

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
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

// Fails loudly when a shell DOM change breaks the selectors capture.ts waits on.
test.skipIf(!executable)('the real host:shell capture still matches the shell DOM', async () => {
  const outputDir = join(scratch, 'output')
  mkdirSync(outputDir)

  const manifest = await captureApplication({
    repoRoot,
    outputDir,
    only: ['host:shell'],
    skipBuild: false,
    browserExecutable: executable!,
    themes: ['dark'],
    timeoutMs: 180_000
  })

  expect(manifest.failures).toEqual([])
  expect(manifest.captures).toHaveLength(1)
  const [capture] = manifest.captures
  expect(capture!.targetId).toBe('host:shell')
  expect(capture!.status).toBe('captured')
  expect(capture!.reference.path).toBe(goldenFor('host:shell', 'dark', repoRoot))
  expect(pngDimensions(readFileSync(capture!.image!.path))).toEqual(SCREENSHOT_SIZE)
}, BUILD_AND_CAPTURE_TIMEOUT_MS)
