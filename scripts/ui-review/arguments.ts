import { isAbsolute, resolve } from 'node:path'
import type { ModelFamily } from './contracts'

export const DEFAULT_REVIEWER_ALIAS = 'gemini'
export const DEFAULT_THRESHOLD = 85
export const CAPTURE_TIMEOUT_MS = 180_000
export const REVIEW_TIMEOUT_MS = 120_000

export type UiReviewArguments =
  | { mode: 'help' }
  | {
      mode: 'capture' | 'capture-only'
      outputDir: string
      authorFamily: ModelFamily
      reviewerAlias: string
      threshold: number
      only: string[]
      skipBuild: boolean
      browserExecutable?: string
    }
  | {
      mode: 'manifest'
      outputDir: string
      authorFamily: ModelFamily
      reviewerAlias: string
      threshold: number
      manifestPath: string
    }

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

export const HELP_TEXT = `Usage:
  bun run ui:review -- --author-family <openai|anthropic|google|xai> --output /absolute/new/report-directory [options]
  bun run ui:review -- --author-family <family> --output /absolute/new/report-directory --manifest <capture-manifest.json> [options]

Capture and review the real desktop renderer against the approved dark/light screenshots.
The first form captures every discovered surface; --only may be repeated to select exact
contribution IDs or plugin IDs. --capture-only stores evidence and reports not-reviewed.
The --manifest form reviews an existing manifest only; it never launches the application.

Options:
  --author-family <family>  Required author model family; reviewer must resolve to another family.
  --output <absolute-dir>   Required fresh output directory; an existing path is never overwritten.
  --only <id-or-plugin>     Repeatable exact target/plugin selector (capture mode only).
  --reviewer <alias>        pi-watch reviewer alias (default: ${DEFAULT_REVIEWER_ALIAS}).
  --threshold <0..100>      Minimum score for every image (default: ${DEFAULT_THRESHOLD}).
  --skip-build              Use existing UI build assets instead of building them.
  --browser <executable>    Use this installed Chromium-family browser executable.
  --capture-only            Capture evidence without asking a vision reviewer.
  --manifest <path>         Review existing capture evidence without starting the app.
  --help                    Show this help without starting any runtime.

Prerequisites:
  Install browser assets explicitly with: bunx playwright install chromium
  Authenticate pi with: pi /login
  Check the default reviewer alias with: pi-watch --check gemini
  Supply --browser when Chromium is installed outside Playwright's browser location.
  Default operation bounds: capture ${CAPTURE_TIMEOUT_MS} ms; review ${REVIEW_TIMEOUT_MS} ms.
  This command does not install dependencies or browser assets automatically.

Exit codes:
  0  Capture-only completed (not reviewed), or every reviewed image passed.
  1  Capture/coverage/mount failure or at least one image below threshold.
  2  Invalid arguments, missing prerequisites, malformed evidence, reviewer, or runtime error.
  SIGINT/SIGTERM use conventional nonzero statuses (130/143) after owned cleanup.`

const modelFamilies: Record<ModelFamily, true> = { openai: true, anthropic: true, google: true, xai: true }
const valueOptions: Record<string, true> = {
  '--author-family': true,
  '--output': true,
  '--only': true,
  '--reviewer': true,
  '--threshold': true,
  '--browser': true,
  '--manifest': true
}
const booleanOptions: Record<string, true> = { '--help': true, '--skip-build': true, '--capture-only': true }

function parseThreshold(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new ArgumentError(`Invalid --threshold value: ${JSON.stringify(value)}`)
  }
  const threshold = Number(value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new ArgumentError('--threshold must be a finite number from 0 to 100')
  }
  return threshold
}

/** Parse only; this function performs no filesystem or application work. */
export function parseArguments(argv: readonly string[]): UiReviewArguments {
  const args = [...argv]
  if (args[0] === '--') args.shift()
  if (args.includes('--help')) return { mode: 'help' }

  const seen = new Set<string>()
  const only: string[] = []
  let authorFamily: ModelFamily | undefined
  let outputDir: string | undefined
  let reviewerAlias = DEFAULT_REVIEWER_ALIAS
  let threshold = DEFAULT_THRESHOLD
  let skipBuild = false
  let captureOnly = false
  let browserExecutable: string | undefined
  let manifestPath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    const equalsIndex = token.indexOf('=')
    const flag = equalsIndex < 0 ? token : token.slice(0, equalsIndex)
    const inlineValue = equalsIndex < 0 ? undefined : token.slice(equalsIndex + 1)

    if (Object.hasOwn(booleanOptions, flag)) {
      if (inlineValue !== undefined) throw new ArgumentError(`${flag} does not take a value`)
      if (flag !== '--help' && seen.has(flag)) throw new ArgumentError(`${flag} may be specified only once`)
      seen.add(flag)
      if (flag === '--skip-build') skipBuild = true
      else if (flag === '--capture-only') captureOnly = true
      continue
    }

    if (!Object.hasOwn(valueOptions, flag)) throw new ArgumentError(`Unknown argument: ${token}`)
    if (flag !== '--only' && seen.has(flag)) throw new ArgumentError(`${flag} may be specified only once`)
    seen.add(flag)

    let value = inlineValue
    if (value === undefined) {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) throw new ArgumentError(`Missing value for ${flag}`)
      value = next
      index += 1
    }
    if (value.length === 0 || value.trim().length === 0) throw new ArgumentError(`Missing value for ${flag}`)

    switch (flag) {
      case '--author-family':
        if (!Object.hasOwn(modelFamilies, value)) {
          throw new ArgumentError('--author-family must be openai, anthropic, google, or xai')
        }
        authorFamily = value as ModelFamily
        break
      case '--output':
        if (!isAbsolute(value)) throw new ArgumentError('--output must be an absolute directory path')
        outputDir = resolve(value)
        break
      case '--only':
        if (/\s/.test(value)) throw new ArgumentError('--only requires an exact ID/plugin selector without whitespace')
        if (!only.includes(value)) only.push(value)
        break
      case '--reviewer':
        if (/\s/.test(value)) throw new ArgumentError('--reviewer must be a single pi-watch alias')
        reviewerAlias = value
        break
      case '--threshold':
        threshold = parseThreshold(value)
        break
      case '--browser':
        browserExecutable = value
        break
      case '--manifest':
        manifestPath = resolve(value)
        break
    }
  }

  if (!authorFamily) throw new ArgumentError('--author-family is required')
  if (!outputDir) throw new ArgumentError('--output is required')
  if (manifestPath) {
    if (captureOnly) throw new ArgumentError('--manifest cannot be combined with --capture-only')
    if (skipBuild) throw new ArgumentError('--manifest cannot be combined with --skip-build')
    if (browserExecutable) throw new ArgumentError('--manifest cannot be combined with --browser')
    if (only.length > 0) throw new ArgumentError('--only is available only while capturing')
    return { mode: 'manifest', outputDir, authorFamily, reviewerAlias, threshold, manifestPath }
  }

  return {
    mode: captureOnly ? 'capture-only' : 'capture',
    outputDir,
    authorFamily,
    reviewerAlias,
    threshold,
    only,
    skipBuild,
    ...(browserExecutable ? { browserExecutable } : {})
  }
}
