#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Inventory } from '../ui-scoreboard/contracts'
import { collectInventory } from '../ui-scoreboard/inventory'
import { CAPTURE_TIMEOUT_MS, DEFAULT_REVIEWER_ALIAS, DEFAULT_THRESHOLD, REVIEW_TIMEOUT_MS } from './arguments'
import { captureApplication } from './capture'
import { scopeCaptureInventory } from './contribution-inventory'
import {
  THEMES, type CaptureOptions, type CaptureManifest, type CaptureTarget, type CaptureEvidence,
  type ModelFamily, type ReviewCellKey, type ReviewIssue, type ReviewOptions,
  type ReviewReport, type ReviewerIdentity
} from './contracts'
import { goldenFor, pngDimensions, SCREENSHOT_SIZE } from './goldens'
import { hostContractContext, serializeContractContext } from './host-contracts'
import {
  assertPluginInventory, renderPluginCampaign, summarizePluginCampaign, validatePluginCapture,
  validatePluginSample, type PluginArtifact, type PluginAttempt, type PluginCampaignInput,
  type PluginCampaignReport, type PluginCampaignTiming, type PluginSampleSlot
} from './plugin-campaign'
import { reviewManifest } from './review'

type SignalName = 'SIGINT' | 'SIGTERM'
type SignalListener = () => void

export type PluginGateIO = {
  mkdir(path: string, options: { mode: number; recursive?: boolean }): Promise<unknown>
  lstat(path: string): Promise<Stats>
  readFile(path: string): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, contents: string | Uint8Array, options: { encoding?: 'utf8'; flag: 'wx'; mode: number }): Promise<unknown>
  realpath(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export type PluginGateDependencies = {
  inventory?: (repoRoot: string) => Inventory | Promise<Inventory>
  capture?: (options: CaptureOptions) => Promise<CaptureManifest>
  review?: (manifest: CaptureManifest, options: ReviewOptions) => Promise<ReviewReport>
  repoRoot?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  signals?: {
    on(signal: SignalName, listener: SignalListener): void
    off(signal: SignalName, listener: SignalListener): void
  }
  io?: Partial<PluginGateIO>
  now?: () => number
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONTEXT_IMPLEMENTATION = fileURLToPath(new URL('./host-contracts.ts', import.meta.url))
const MAX_FILE_BYTES = 64 * 1024 * 1024
const FAMILIES = ['openai', 'anthropic', 'google', 'xai'] as const
const ISSUE_CODES: readonly ReviewIssue['code'][] = [
  'operational', 'response-shape', 'invalid-sample', 'contract-conflict', 'evidence-changed',
  'identity-mismatch', 'persistence', 'aborted', 'usage-limit'
]
const GLOBAL_CODES: Record<string, true> = {
  'evidence-changed': true, 'identity-mismatch': true, persistence: true, aborted: true, 'usage-limit': true
}
const FAMILY_BY_PROVIDER: Record<string, ModelFamily | undefined> = {
  google: 'google', 'google-gemini-cli': 'google', 'google-antigravity': 'google',
  openai: 'openai', 'openai-codex': 'openai', anthropic: 'anthropic', xai: 'xai'
}
const HELP = `Usage:
  bun scripts/ui-review/plugin-gate.ts --author-family <openai|anthropic|google|xai> --output <absolute-fresh-directory> [--reviewer <alias>] [--browser <executable>]
  bun scripts/ui-review/plugin-gate.ts --help

Captures every projected plugin surface once in both themes. Reviews each immutable image
in three independent slots, with four concurrent calls and one operational/response-shape
replacement per missing slot. Every exact median must reach 85. No selector or score overrides.
The reviewer must resolve to a family different from the implementation author.

Exit: 0 plugin gate passed (not goal completion); 1 complete below-85 evidence;
2 incomplete/invalid evidence; 130/143 interrupted after owned cleanup.
`

type Arguments = { output: string; authorFamily: ModelFamily; reviewer: string; browser?: string }
type FrozenContext = { bytes: string; sha256: string; path: string }
type AttemptOutcome = { attempt: PluginAttempt; retryable: boolean; valid: boolean }

class GateFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redact(text: string): string {
  return text
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\/(?:Users|home)\/[^\s"'<>]+/g, '[REDACTED_HOME_PATH]')
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function key(cell: ReviewCellKey): string { return `${cell.targetId}\0${cell.theme}` }

function sameIdentity(left: ReviewerIdentity, right: ReviewerIdentity): boolean {
  return left.alias === right.alias && left.provider === right.provider && left.model === right.model && left.family === right.family
}

function identity(value: unknown, alias: string): ReviewerIdentity | null {
  if (!record(value) || typeof value.provider !== 'string' || typeof value.model !== 'string' ||
      value.provider.length === 0 || value.model.length === 0 || value.model.length > 256 ||
      !FAMILIES.includes(value.family as ModelFamily)) return null
  let family = FAMILY_BY_PROVIDER[value.provider.toLowerCase()]
  if (!family && value.provider.toLowerCase() === 'github-copilot') {
    const model = value.model.slice(value.model.lastIndexOf('/') + 1).toLowerCase()
    family = /^(?:gpt-|o[1-9](?:-|$)|codex(?:-|$))/.test(model) ? 'openai'
      : model.startsWith('claude-') ? 'anthropic' : model.startsWith('gemini-') ? 'google'
        : model.startsWith('grok-') ? 'xai' : undefined
  }
  if (family !== value.family) return null
  return { alias, provider: value.provider, model: value.model, family: value.family as ModelFamily }
}

function parse(argv: readonly string[]): Arguments | null {
  if (argv.length === 1 && argv[0] === '--help') return null
  const allowed: Record<string, true> = { '--output': true, '--author-family': true, '--reviewer': true, '--browser': true }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!
    const value = argv[index + 1]
    if (!Object.hasOwn(allowed, flag) || values.has(flag) || value === undefined || value.startsWith('--') ||
        value.trim() !== value || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid, duplicate, or missing option: ${flag}`)
    }
    values.set(flag, value)
  }
  const output = values.get('--output')
  const authorFamily = values.get('--author-family') as ModelFamily
  const reviewer = values.get('--reviewer') ?? DEFAULT_REVIEWER_ALIAS
  if (!output || !isAbsolute(output) || !FAMILIES.includes(authorFamily) || !/^[a-zA-Z0-9_-]{1,128}$/.test(reviewer)) {
    throw new Error('A fresh absolute --output and valid --author-family are required; reviewer must be a bounded alias.')
  }
  return { output: resolve(output), authorFamily, reviewer, ...(values.has('--browser') ? { browser: values.get('--browser')! } : {}) }
}

async function freshOutput(path: string, io: PluginGateIO): Promise<string> {
  try {
    await io.lstat(path)
    throw new Error('Output already exists; refusing to overwrite it.')
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT') throw error
  }
  const parent = dirname(path)
  let component: string = sep
  for (const part of parent.split(sep).filter(Boolean)) {
    component = join(component, part)
    try {
      const stat = await io.lstat(component)
      if (stat.isSymbolicLink()) {
        const systemTmp = process.platform === 'darwin' && component === '/tmp' && await io.realpath(component) === '/private/tmp'
        const systemVar = process.platform === 'darwin' && component === '/var' && await io.realpath(component) === '/private/var'
        if (!systemTmp && !systemVar) throw new Error('Output parent contains a user-created symlink.')
      } else if (!stat.isDirectory()) throw new Error('Output parent is not a directory.')
    } catch (error) {
      if (!record(error) || error.code !== 'ENOENT') throw error
      await io.mkdir(component, { mode: 0o700 })
    }
  }
  const canonicalParent = await io.realpath(parent)
  const canonical = join(canonicalParent, path.slice(parent.length + (parent === sep ? 0 : 1)))
  await io.mkdir(canonical, { mode: 0o700 })
  const stat = await io.lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('Output must be a private directory.')
  return await io.realpath(canonical)
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** Measures all source-projected plugin images without recapture, score replacement, or omitted error rows. */
export async function runPluginGate(argv: readonly string[], dependencies: PluginGateDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(`${text}\n`))
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(`${text}\n`))
  let args: Arguments | null
  try { args = parse(argv) } catch (error) { stderr(`${redact(message(error))}\n${HELP}`); return 2 }
  if (args === null) { stdout(HELP); return 0 }
  const io: PluginGateIO = { ...fs, ...dependencies.io }
  let output: string
  try { output = await freshOutput(args.output, io) } catch (error) { stderr(redact(message(error))); return 2 }
  const repoRoot = resolve(dependencies.repoRoot ?? REPO_ROOT)
  const inventoryReader = dependencies.inventory ?? collectInventory
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const timing: PluginCampaignTiming = {
    concurrency: 4, captureMs: 0, reviewMs: 0, totalMs: 0,
    initialReviewCalls: 0, replacementReviewCalls: 0, maxConcurrency: 0
  }
  const controller = new AbortController()
  const signals = dependencies.signals ?? process
  let signalName: SignalName | null = null
  let fatal = false
  let active = 0
  let launchQueue = Promise.resolve()
  let inventory: Inventory | null = null
  let manifest: CaptureManifest | null = null
  let captureValidated = false
  let parentArtifact: PluginArtifact | null = null
  let reviewer: ReviewerIdentity | null = null
  const attempts: PluginCampaignInput['attempts'] = []
  const failures: PluginCampaignInput['failures'] = []
  const targetManifests: NonNullable<PluginCampaignInput['targetManifests']> = []
  const expectedContexts: NonNullable<PluginCampaignInput['expectedContexts']> = []
  const frozenFiles = new Map<string, string>()
  const contexts = new Map<string, FrozenContext>()
  const targets = new Map<string, CaptureManifest>()
  const excludedTargets = new Set<string>()
  const invalidCells = new Set<string>()
  const stop = (code: string, detail: string, cell?: ReviewCellKey) => {
    fatal = true
    failures.push({ code, message: redact(detail), ...cell })
    if (!controller.signal.aborted) controller.abort(new Error(code))
  }
  const interrupt = (name: SignalName) => () => {
    if (signalName) return
    signalName = name
    stop('aborted', `Interrupted by ${name}.`)
  }
  const onSigint = interrupt('SIGINT')
  const onSigterm = interrupt('SIGTERM')
  signals.on('SIGINT', onSigint)
  signals.on('SIGTERM', onSigterm)

  const readRegular = async (path: string): Promise<Buffer> => {
    const stat = await io.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Evidence must be a bounded regular file.')
    const bytes = await io.readFile(path)
    if (bytes.length > MAX_FILE_BYTES || bytes.length !== stat.size) throw new Error('Evidence size changed while reading.')
    return bytes
  }
  const save = async (path: string, bytes: string | Uint8Array): Promise<PluginArtifact> => {
    try { await io.writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) } catch (error) {
      throw new GateFailure('persistence', `Cannot exclusively persist artifact: ${redact(message(error))}`)
    }
    const artifact = { path, sha256: sha256(bytes) }
    if (sha256(await readRegular(path)) !== artifact.sha256) throw new GateFailure('persistence', 'Saved artifact does not match its original bytes.')
    frozenFiles.set(path, artifact.sha256)
    return artifact
  }
  const verify = async () => {
    if (!inventory) return
    const current = await inventoryReader(repoRoot)
    if (current.dirty || current.failures.length || current.commit !== inventory.commit || current.sourceDigest !== inventory.sourceDigest) {
      throw new GateFailure('evidence-changed', 'Source commit, digest, or clean inventory changed during the campaign.')
    }
    for (const [path, hash] of frozenFiles) {
      try {
        if (sha256(await readRegular(path)) !== hash) throw new Error('hash mismatch')
      } catch { throw new GateFailure('evidence-changed', `Frozen evidence changed or disappeared: ${redact(path)}`) }
    }
    for (const [cellKey, expected] of contexts) {
      const [targetId, theme] = cellKey.split('\0')
      const target = manifest!.targets.find(({ id }) => id === targetId)!
      const bytes = serializeContractContext(hostContractContext(target, theme as ReviewCellKey['theme']))
      if (bytes !== expected.bytes) throw new GateFailure('evidence-changed', 'Trusted contract context changed during the campaign.')
    }
  }
  const bindIdentity = (value: unknown, required: boolean) => {
    const resolved = identity(value, args.reviewer)
    if (!resolved) {
      if (required || value !== null && value !== undefined) throw new GateFailure('identity-mismatch', 'Reviewer identity is missing, malformed, or has an unknown provider family.')
      return null
    }
    if (resolved.family === args.authorFamily || reviewer && !sameIdentity(reviewer, resolved)) {
      throw new GateFailure('identity-mismatch', 'Reviewer identity changed or matches the author family.')
    }
    reviewer ??= resolved
    return resolved
  }

  const readAttemptArtifacts = async (directory: string, report: unknown, cell: ReviewCellKey, attempt: PluginAttempt) => {
    const reviewerDir = join(directory, 'reviewer')
    const stat = await io.lstat(reviewerDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Missing private reviewer artifact directory.')
    const names = await io.readdir(reviewerDir)
    const reports = names.filter((name) => /^review-report-[0-9a-f-]{36}\.json$/i.test(name))
    if (reports.length !== 1) throw new Error('Exactly one run-ID ReviewReport artifact is required.')
    attempt.artifacts = []
    const retain = async (path: string) => {
      const bytes = await readRegular(path)
      const hash = sha256(bytes)
      frozenFiles.set(path, hash)
      attempt.artifacts!.push({ path, sha256: hash })
      return bytes
    }
    const reportPath = join(reviewerDir, reports[0]!)
    const reportBytes = await retain(reportPath)
    attempt.reportPath = reportPath
    attempt.reportSha256 = sha256(reportBytes)
    if (stable(JSON.parse(reportBytes.toString('utf8'))) !== stable(report)) throw new Error('Saved and returned reviewer reports differ.')
    const runId = reports[0]!.slice('review-report-'.length, -'.json'.length)
    const prefix = `capture-${sha256(cell.targetId).slice(0, 20)}-${cell.theme}-${runId}`
    const contextPath = join(reviewerDir, `${prefix}.context.json`)
    const contextBytes = await retain(contextPath)
    await retain(join(reviewerDir, `${prefix}.response.txt`))
    const logBytes = await retain(join(reviewerDir, `${prefix}.log.txt`))
    const context = contexts.get(key(cell))!
    if (contextBytes.toString('utf8') !== context.bytes) throw new GateFailure('evidence-changed', 'Reviewer trusted-context bytes differ from frozen source context.')
    const log: unknown = JSON.parse(logBytes.toString('utf8'))
    const configPath = /(?:[A-Za-z]:\\[^\s]+|\/[^\s"']*(?:\.config|\.claude|\.pi|\.env(?:\.[^/\\]+)?|credentials|secrets?)[^\s"']*)/gi
    const loggedPath = contextPath.split(homedir()).join('<home>').replace(configPath, '[REDACTED_CONFIG_PATH]')
    if (!record(log) || log.targetId !== cell.targetId || log.theme !== cell.theme ||
        log.contextSha256 !== context.sha256 || log.contextPath !== loggedPath) {
      throw new Error('Reviewer log/context does not identify the requested cell and run.')
    }
    const captures = record(report) && Array.isArray(report.captures) ? report.captures : []
    const sample = captures[0]
    if (record(sample) && record(sample.contractReview)) {
      const evidencePath = contextPath.replace(configPath, '[REDACTED_CONFIG_PATH]')
      if (sample.contractReview.contextPath !== evidencePath) throw new Error('Reviewed sample points to a different trusted-context artifact.')
      if (stable(log.audit) !== stable(sample.contractReview.audit)) throw new Error('Reviewer log and report contract audits differ.')
    }
    attempt.preflightIdentity = bindIdentity(log.preflight, captures.length > 0)
    bindIdentity(log.identity, captures.length > 0)
  }

  const runAttempt = async (cell: ReviewCellKey, slot: PluginSampleSlot, retryOf: string | null): Promise<AttemptOutcome> => {
    const id = `${sha256(cell.targetId).slice(0, 20)}-${cell.theme}-slot-${slot}-${retryOf ? 'replacement' : 'initial'}`
    const attempt: PluginAttempt = { id, retryOf, reportPath: null, reportSha256: null, issues: [], sample: null, startedAt: now() }
    const directory = join(output, 'attempts', id)
    const predecessor = launchQueue
    const { promise: launch, resolve: releaseLaunch } = Promise.withResolvers<void>()
    launchQueue = launch
    let called = false
    try {
      await verify()
      if (controller.signal.aborted) throw new GateFailure('aborted', 'Campaign stopped before review dispatch.')
      try { await io.mkdir(directory, { mode: 0o700 }) } catch (error) { throw new GateFailure('persistence', message(error)) }
      await predecessor
      if (controller.signal.aborted) throw new GateFailure('aborted', 'Campaign stopped before review dispatch.')
      active += 1
      timing.maxConcurrency = Math.max(timing.maxConcurrency, active)
      if (retryOf) timing.replacementReviewCalls += 1
      else timing.initialReviewCalls += 1
      called = true
      attempts.push({ ...cell, slot, attempt })
      releaseLaunch()
      let report: ReviewReport
      try {
        report = await (dependencies.review ?? reviewManifest)(targets.get(cell.targetId)!, {
          outputDir: directory, reviewerAlias: args.reviewer, authorFamily: args.authorFamily,
          threshold: DEFAULT_THRESHOLD, timeoutMs: REVIEW_TIMEOUT_MS, onlyCells: [{ ...cell }], signal: controller.signal
        })
      } finally { active -= 1 }
      let admissionFailure: GateFailure | null = null
      try {
        if (!record(report) || report.schemaVersion !== 1 || !Array.isArray(report.captures) ||
            !Array.isArray(report.failures) || !report.failures.every((item) => typeof item === 'string') ||
            !Array.isArray(report.issues) || !Array.isArray(report.selectedCells) ||
            !['passed', 'failed', 'error'].includes(report.status)) {
          throw new GateFailure('unclassified', 'Reviewer returned a malformed report envelope.')
        }
        if (report.authorFamily !== args.authorFamily || report.reviewerAlias !== args.reviewer ||
            report.threshold !== DEFAULT_THRESHOLD || report.scope !== 'filtered') {
          throw new GateFailure('identity-mismatch', 'Reviewer report identity, scope, or threshold does not match the request.')
        }
        if (report.selectedCells.length !== 1 || !record(report.selectedCells[0]) || key(report.selectedCells[0]) !== key(cell)) {
          throw new GateFailure('identity-mismatch', 'Reviewer report selection differs from the requested cell.')
        }
        for (const issue of report.issues) {
          if (!record(issue) || !ISSUE_CODES.includes(issue.code) || typeof issue.message !== 'string' ||
              issue.targetId !== undefined && issue.targetId !== cell.targetId ||
              issue.theme !== undefined && issue.theme !== cell.theme) {
            throw new GateFailure('unclassified', 'Reviewer returned an unknown or foreign issue.')
          }
          if (Object.hasOwn(GLOBAL_CODES, issue.code)) stop(issue.code, issue.message, cell)
        }
        attempt.issues = report.issues.map((issue) => ({ ...issue, message: redact(issue.message) }))
        attempt.sample = report.captures.length === 1 ? structuredClone(report.captures[0]!) : null
      } catch (error) {
        admissionFailure = error instanceof GateFailure ? error : new GateFailure('unclassified', message(error))
        stop(admissionFailure.code, admissionFailure.message, cell)
      }
      try { await readAttemptArtifacts(directory, report, cell, attempt) } catch (error) {
        if (error instanceof GateFailure) throw error
        throw new GateFailure('persistence', `Reviewer artifact validation failed: ${redact(message(error))}`)
      }
      if (admissionFailure) throw admissionFailure
      await verify()
      if (report.captures.length > 1) attempt.issues.push({ ...cell, code: 'invalid-sample', message: 'Reviewer returned duplicate or foreign sample cells.' })
      if (attempt.sample) {
        const capture = manifest!.captures.find((item) => key(item) === key(cell))!
        const target = manifest!.targets.find(({ id: targetId }) => targetId === cell.targetId)!
        const issue = validatePluginSample(attempt.sample, capture, target, args.authorFamily, reviewer)
        if (issue) attempt.issues.push({ ...issue, message: redact(issue.message) })
        else if (attempt.issues.length > 0 && attempt.issues.every(({ code }) => code === 'operational' || code === 'response-shape')) {
          attempt.issues.push({ ...cell, code: 'invalid-sample', message: 'A completed sample cannot be replaced by an operational or shape issue.' })
        }
      }
      const global = attempt.issues.find(({ code }) => Object.hasOwn(GLOBAL_CODES, code))
      if (global) stop(global.code, global.message, cell)
      const valid = attempt.sample !== null && attempt.issues.length === 0
      const retryable = !fatal && !attempt.sample && attempt.issues.length > 0 &&
        attempt.issues.every(({ code }) => code === 'operational' || code === 'response-shape')
      if (!valid && !retryable && attempt.issues.length === 0) {
        stop('unclassified', 'Reviewer returned no requested sample and no typed failure.', cell)
      }
      return { attempt, valid, retryable }
    } catch (error) {
      const code = error instanceof GateFailure ? error.code : controller.signal.aborted ? 'aborted' : 'unclassified'
      const issueCode: ReviewIssue['code'] = ISSUE_CODES.includes(code as ReviewIssue['code']) ? code as ReviewIssue['code'] : 'invalid-sample'
      attempt.issues.push({ ...cell, code: issueCode, message: redact(message(error)) })
      if (!called && code === 'persistence') attempts.push({ ...cell, slot, attempt })
      stop(code, message(error), cell)
      if (called && attempt.reportPath === null) {
        try {
          const reviewerDir = join(directory, 'reviewer')
          const names = (await io.readdir(reviewerDir)).filter((name) => /^review-report-[0-9a-f-]{36}\.json$/i.test(name))
          if (names.length !== 1) throw new Error('No unique persisted report after the reviewer exception.')
          const saved: unknown = JSON.parse((await readRegular(join(reviewerDir, names[0]!))).toString('utf8'))
          await readAttemptArtifacts(directory, saved, cell, attempt)
        } catch (artifactError) {
          attempt.issues.push({ ...cell, code: 'persistence', message: redact(message(artifactError)) })
        }
      }
      return { attempt, valid: false, retryable: false }
    } finally {
      releaseLaunch()
      attempt.endedAt = now()
      if (!called && attempt.issues.length === 0) attempt.issues.push({ ...cell, code: 'aborted', message: 'Review was not dispatched.' })
    }
  }

  let reviewStartedAt: number | null = null
  let report: PluginCampaignReport | null = null
  const summarize = (): PluginCampaignReport => {
    if (!inventory) {
      return {
        schemaVersion: 1, status: 'error', goalPassed: false, threshold: 85, sampleCount: 3,
        source: { commit: '', sourceDigest: '' }, manifest: parentArtifact, authorFamily: args.authorFamily,
        reviewer, plugins: [], cells: [], failures, extraAttempts: [],
        counts: { requiredCells: 0, completeValidCells: 0, passing: 0, belowThreshold: 0, invalid: 0 }, timing
      }
    }
    const value = summarizePluginCampaign({
      inventory, manifest: captureValidated ? manifest : null, manifestEvidence: parentArtifact ?? undefined,
      captureEvidence: manifest && Array.isArray(manifest.captures) ? manifest.captures : [],
      activatedVisibilitySettings: manifest?.activatedVisibilitySettings,
      authorFamily: args.authorFamily, reviewer, attempts, failures, targetManifests, expectedContexts, timing
    })
    value.manifest = parentArtifact
    if (fatal) {
      value.status = 'error'
      if (failures.some(({ code }) => code === 'evidence-changed' || code === 'identity-mismatch')) {
        for (const cell of value.cells) { cell.status = 'invalid'; cell.median = null; cell.range = null }
        for (const plugin of value.plugins) if (plugin.targetIds.length) plugin.status = 'invalid'
        value.counts = { requiredCells: value.cells.length, completeValidCells: 0, passing: 0, belowThreshold: 0, invalid: value.cells.length }
      }
    }
    return value
  }
  try {
    const source = await inventoryReader(repoRoot)
    inventory = freeze(structuredClone(source))
    assertPluginInventory(inventory)
    if (inventory.dirty || inventory.failures.length) throw new GateFailure('evidence-changed', 'Source inventory is dirty or contains discovery failures.')
    const implementationBytes = await readRegular(CONTEXT_IMPLEMENTATION)
    frozenFiles.set(CONTEXT_IMPLEMENTATION, sha256(implementationBytes))
    if (controller.signal.aborted) throw new GateFailure('aborted', 'Campaign interrupted before capture.')
    const captureDir = join(output, 'capture')
    await io.mkdir(captureDir, { mode: 0o700 })
    const selectors = [...new Set(inventory.targets.filter(({ plugin }) => plugin !== null).map(({ plugin }) => plugin!))].sort()
    const captureStartedAt = now()
    try {
      const captured = await (dependencies.capture ?? captureApplication)({
        repoRoot, outputDir: captureDir, only: selectors, themes: THEMES, skipBuild: false,
        timeoutMs: CAPTURE_TIMEOUT_MS, signal: controller.signal, ...(args.browser ? { browserExecutable: args.browser } : {})
      })
      manifest = freeze(structuredClone(captured))
      parentArtifact = await save(join(output, 'capture-manifest.json'), json(captured))
      const progressPath = join(captureDir, 'capture-progress.json')
      try {
        const bytes = await readRegular(progressPath)
        frozenFiles.set(progressPath, sha256(bytes))
      } catch (error) {
        if (!record(error) || error.code !== 'ENOENT') throw error
      }
    } catch (error) {
      const progressPath = join(captureDir, 'capture-progress.json')
      try {
        const bytes = await readRegular(progressPath)
        parentArtifact = { path: progressPath, sha256: sha256(bytes) }
        frozenFiles.set(progressPath, parentArtifact.sha256)
        const progress: unknown = JSON.parse(bytes.toString('utf8'))
        if (record(progress)) manifest = freeze(progress as CaptureManifest)
      } catch (progressError) {
        failures.push({ code: 'capture-progress-unavailable', message: redact(message(progressError)) })
      }
      throw error
    } finally { timing.captureMs = now() - captureStartedAt }
    const validation = validatePluginCapture(inventory, manifest)
    captureValidated = true
    for (const target of validation.invalidTargets) excludedTargets.add(target.targetId)
    for (const target of manifest.targets) {
      if (excludedTargets.has(target.id)) continue
      for (const capture of manifest.captures.filter(({ targetId }) => targetId === target.id)) {
        const approved = await io.realpath(goldenFor(target.id, capture.theme, repoRoot))
        if (await io.realpath(capture.reference.path) !== approved) throw new GateFailure('evidence-changed', 'Reference is not the approved same-theme PNG.')
        const referenceBytes = await readRegular(approved)
        if (sha256(referenceBytes) !== capture.reference.sha256) throw new GateFailure('evidence-changed', 'Approved reference hash differs from capture evidence.')
        const referenceDimensions = pngDimensions(referenceBytes)
        if (!referenceDimensions || referenceDimensions.width !== SCREENSHOT_SIZE.width || referenceDimensions.height !== SCREENSHOT_SIZE.height) {
          throw new GateFailure('evidence-changed', `Approved reference PNG dimensions must be ${SCREENSHOT_SIZE.width}×${SCREENSHOT_SIZE.height}.`)
        }
        frozenFiles.set(approved, capture.reference.sha256)
        try {
          if (!capture.image) throw new Error('Capture image is missing.')
          const bytes = await readRegular(capture.image.path)
          const dimensions = pngDimensions(bytes)
          if (!dimensions || dimensions.width !== SCREENSHOT_SIZE.width || dimensions.height !== SCREENSHOT_SIZE.height) throw new Error('Capture PNG dimensions are not 2800×1760.')
          if (sha256(bytes) !== capture.image.sha256) throw new GateFailure('evidence-changed', 'Capture PNG hash differs from its manifest.')
          frozenFiles.set(capture.image.path, capture.image.sha256)
        } catch (error) {
          if (error instanceof GateFailure) throw error
          excludedTargets.add(target.id)
          failures.push({ code: 'target-capture-incomplete', targetId: target.id, theme: capture.theme, message: redact(message(error)) })
        }
      }
    }
    await io.mkdir(join(output, 'targets'), { mode: 0o700 })
    await io.mkdir(join(output, 'contexts'), { mode: 0o700 })
    await io.mkdir(join(output, 'attempts'), { mode: 0o700 })
    for (const targetId of validation.eligibleTargetIds) {
      if (excludedTargets.has(targetId)) continue
      const target = manifest.targets.find(({ id }) => id === targetId)!
      const derived: CaptureManifest = freeze({
        ...structuredClone(manifest), scope: 'filtered', selectors: [targetId], targets: [target],
        captures: THEMES.map((theme) => manifest!.captures.find((cell) => cell.targetId === targetId && cell.theme === theme)!),
        contributionInventory: scopeCaptureInventory(manifest.contributionInventory!, [target]), failures: []
      })
      const artifact = await save(join(output, 'targets', `${sha256(targetId)}.json`), json(derived))
      targetManifests.push({ targetId, ...artifact })
      targets.set(targetId, derived)
      for (const theme of THEMES) {
        const bytes = serializeContractContext(hostContractContext(target, theme))
        const contextArtifact = await save(join(output, 'contexts', `${sha256(targetId)}-${theme}.json`), bytes)
        contexts.set(key({ targetId, theme }), { bytes, ...contextArtifact })
        expectedContexts.push({ targetId, theme, sha256: contextArtifact.sha256 })
      }
    }
    await verify()
    const cells = [...targets.keys()].sort().flatMap((targetId) => THEMES.map((theme) => ({ targetId, theme })))
    reviewStartedAt = now()
    for (const slot of [1, 2, 3] as const) {
      if (fatal) break
      let next = 0
      const queue = cells.filter((cell) => !invalidCells.has(key(cell)))
      const lane = async () => {
        while (!fatal && next < queue.length) {
          const cell = queue[next++]!
          const initial = await runAttempt(cell, slot, null)
          if (fatal) return
          let outcome = initial
          if (initial.retryable) outcome = await runAttempt(cell, slot, initial.attempt.id)
          if (fatal) return
          if (!outcome.valid) {
            invalidCells.add(key(cell))
            const issue = outcome.attempt.issues.find(({ code }) => code !== 'operational' && code !== 'response-shape') ?? outcome.attempt.issues[0]
            failures.push({ ...cell, code: issue?.code ?? 'invalid-sample', message: issue?.message ?? 'Sample slot did not produce a valid score.' })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, lane))
    }
    await verify()
  } catch (error) {
    stop(error instanceof GateFailure ? error.code : 'campaign-error', message(error))
  } finally {
    try {
      try { await verify() } catch (error) {
        stop(error instanceof GateFailure ? error.code : 'evidence-changed', message(error))
      }
      if (reviewStartedAt !== null) timing.reviewMs = now() - reviewStartedAt
      timing.totalMs = now() - startedAt
      try {
        report = summarize()
      } catch (error) {
        failures.push({ code: 'inventory-mismatch', message: redact(message(error)) })
        const source = inventory
        if (source && captureValidated) {
          captureValidated = false
          report = summarize()
        } else {
          inventory = null
          report = summarize()
          if (source) report.source = { commit: source.commit, sourceDigest: source.sourceDigest }
        }
      }
      try { await io.writeFile(join(output, 'plugin-gate.md'), renderPluginCampaign(report), { flag: 'wx', mode: 0o600 }) } catch (error) {
        stop('persistence', `Could not persist plugin-gate.md: ${message(error)}`)
        report.status = 'error'
        report.failures.push(failures[failures.length - 1]!)
      }
      try { await io.writeFile(join(output, 'plugin-gate.json'), json(report), { flag: 'wx', mode: 0o600 }) } catch (error) {
        stop('persistence', `Could not persist plugin-gate.json: ${message(error)}`)
        report.status = 'error'
        report.failures.push(failures[failures.length - 1]!)
        const amendment = join(output, 'plugin-gate-error.md')
        try {
          await io.writeFile(amendment, renderPluginCampaign(report), { flag: 'wx', mode: 0o600 })
          await io.rename(amendment, join(output, 'plugin-gate.md'))
        } catch (amendError) {
          stderr(`Could not preserve an accurate Markdown summary: ${redact(message(amendError))}`)
          await io.unlink(join(output, 'plugin-gate.md')).catch(() => undefined)
        }
        stderr(redact(message(error)))
      }
    } finally {
      signals.off('SIGINT', onSigint)
      signals.off('SIGTERM', onSigterm)
    }
  }
  if (signalName) return signalName === 'SIGINT' ? 130 : 143
  const exitCode = report!.status === 'passed' && !fatal ? 0 : report!.status === 'failed' && !fatal ? 1 : 2
  stdout(`Plugin campaign ${report!.status}; see ${join(output, 'plugin-gate.json')}`)
  return exitCode
}

if (import.meta.main) {
  process.exitCode = await runPluginGate(process.argv.slice(2))
}
