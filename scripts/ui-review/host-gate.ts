#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureApplication as defaultCaptureApplication } from './capture'
import { hostContractContext, serializeContractContext } from './host-contracts'
import {
  CAPTURE_TIMEOUT_MS,
  DEFAULT_REVIEWER_ALIAS,
  REVIEW_TIMEOUT_MS
} from './arguments'
import {
  SCORE_DIMENSIONS,
  THEMES,
  type CaptureManifest,
  type CaptureOptions,
  type CaptureTarget,
  type CaptureTheme,
  type ContractAudit,
  type HostContractContext,
  type ImageEvidence,
  type ModelFamily,
  type ReviewCellKey,
  type ReviewIssue,
  type ReviewOptions,
  type ReviewReport,
  type ReviewerIdentity,
  type ReviewedCapture,
  type VisualAssessment
} from './contracts'
import { reviewManifest as defaultReviewManifest } from './review'
import { SCREENSHOT_SIZE, VIEWPORT, goldenFor, pngDimensions } from './goldens'
import { collectInventory } from '../ui-scoreboard/inventory'

export const HOST_GATE_THRESHOLD = 85 as const
export const HOST_GATE_SAMPLE_COUNT = 3 as const
export const HOST_GATE_TARGET_IDS = ['host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'] as const

const OUTPUT_REPORT_NAME = 'host-gate.json'
const OUTPUT_MARKDOWN_NAME = 'host-gate.md'
const MANIFEST_NAME = 'capture-manifest.json'
const FAMILIES: readonly ModelFamily[] = ['openai', 'anthropic', 'google', 'xai']
const HOST_CONTRACTS_PATH = fileURLToPath(new URL('./host-contracts.ts', import.meta.url))
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

type SignalName = 'SIGINT' | 'SIGTERM'
type SignalListener = () => void
export interface HostGateSignalSource {
  on(signal: SignalName, listener: SignalListener): void
  off(signal: SignalName, listener: SignalListener): void
}

type SourceSnapshot = {
  repoRoot: string
  commit: string
  sourceDigest: string
  dirty: boolean
  failures: unknown[]
}
type FileWriteOptions = { encoding?: 'utf8'; flag: 'wx'; mode: number }
type HostGateIO = {
  mkdir(path: string, options: { mode: number; recursive?: boolean }): Promise<unknown>
  lstat(path: string): Promise<Stats>
  readFile(path: string): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, contents: string | Uint8Array, options: FileWriteOptions): Promise<unknown>
  realpath(path: string): Promise<string>
}
type CaptureRunner = (options: CaptureOptions) => Promise<CaptureManifest>
type ReviewRunner = (manifest: CaptureManifest, options: ReviewOptions) => Promise<ReviewReport>

export interface HostGateDependencies {
  captureApplication?: CaptureRunner
  reviewManifest?: ReviewRunner
  sourceSnapshot?: (repoRoot: string) => SourceSnapshot | Promise<SourceSnapshot>
  mkdir?: HostGateIO['mkdir']
  realpath?: HostGateIO['realpath']
  lstat?: HostGateIO['lstat']
  readFile?: HostGateIO['readFile']
  readdir?: HostGateIO['readdir']
  writeFile?: HostGateIO['writeFile']
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  repoRoot?: string
  signals?: HostGateSignalSource
}

type GateArguments = {
  mode: 'run'
  authorFamily: ModelFamily
  reviewerAlias: string
  outputDir: string
  browserExecutable?: string
} | { mode: 'help' }
type GateStatus = 'passed' | 'failed' | 'error'
type CellStatus = 'passed' | 'failed' | 'invalid'
type SlotStatus = 'valid' | 'invalid' | 'missing'
type StoredConflict = {
  slot: number
  attemptId: string
  contractId: string
  reason: string
  affectsScore: boolean
}
type StoredPreflight = { targetId: string; theme: CaptureTheme; identity: { provider: string; model: string; family: ModelFamily } | 'unknown' }
type GateSlot = {
  slot: number
  status: SlotStatus
  score: number | null
  scores: Record<string, number> | null
  attemptId: string | null
  reportPath: string | null
  issues: ReviewIssue[]
  conflicts: StoredConflict[]
}
type GateCell = {
  targetId: string
  theme: CaptureTheme
  image: ImageEvidence | null
  reference: ImageEvidence | null
  contextPath: string | null
  contextSha256: string | null
  slots: GateSlot[]
  median: number | null
  conflicts: StoredConflict[]
  status: CellStatus
}
type GateAttempt = {
  id: string
  slot: number
  requestedCells: ReviewCellKey[]
  reportPath: string | null
  reviewerReportPath: string | null
  artifactPaths: string[]
  issues: ReviewIssue[]
  retryOf: string | null
  preflightIdentities: StoredPreflight[]
}
type GateReport = {
  schemaVersion: 1
  status: GateStatus
  threshold: typeof HOST_GATE_THRESHOLD
  sampleCount: typeof HOST_GATE_SAMPLE_COUNT
  authorFamily: ModelFamily
  reviewerAlias: string
  reviewerIdentity: ReviewerIdentity | null
  capture: {
    commit: string | null
    sourceDigest: string | null
    manifestPath: string | null
    manifestSha256: string | null
  }
  contextImplementationSha256: string | null
  attempts: GateAttempt[]
  cells: GateCell[]
  failures: string[]
}
type ExpectedContext = {
  target: CaptureTarget
  theme: CaptureTheme
  key: string
  text: string
  bytes: Buffer
  sha256: string
  path: string
  context: HostContractContext
}
type FrozenEvidence = { path: string; sha256: string; kind: 'image' | 'reference' }
type ArtifactBundle = {
  reviewerDir: string
  runId: string
  reportPath: string
  artifactPaths: string[]
  artifactDigests: Map<string, string>
  preflightIdentities: StoredPreflight[]
  identityByCell: Map<string, { provider: string; model: string; family: ModelFamily } | 'unknown'>
}
type AttemptResult = {
  attempt: GateAttempt
  report: ReviewReport | null
  issues: ReviewIssue[]
  outcomes: Map<string, CellOutcome>
  fatal: string | null
}
type CellOutcome = {
  status: 'valid' | 'retryable' | 'terminal'
  capture?: ReviewedCapture
  score?: number
  issues: ReviewIssue[]
}

type IO = HostGateIO & {
  stdout(line: string): void
  stderr(line: string): void
  repoRoot: string
  sourceSnapshot(repoRoot: string): SourceSnapshot | Promise<SourceSnapshot>
  signals: HostGateSignalSource
}

const processSignals: HostGateSignalSource = {
  on(signal, listener) { process.on(signal, listener) },
  off(signal, listener) { process.off(signal, listener) }
}
const defaultIO: Omit<IO, 'repoRoot' | 'sourceSnapshot'> = {
  mkdir: async (path, options) => await mkdir(path, options),
  realpath: async (path) => await realpath(path),
  lstat: async (path) => await lstat(path),
  readFile: async (path) => await readFile(path),
  readdir: async (path) => await readdir(path),
  writeFile: async (path, contents, options) => await writeFile(path, contents, options),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  signals: processSignals
}

const HELP_TEXT = `Usage:
  bun scripts/ui-review/host-gate.ts --author-family <openai|anthropic|google|xai> --reviewer <alias> --output <fresh-absolute-dir> [--browser <executable>]

Capture exactly host:shell, host:scoped, host:popups, host:settings, and host:palette in dark and light themes. Review the same frozen evidence in three independent slots; every unrounded cell median must be at least 85. Only one replacement per cell and slot is allowed for an operational or response-shape failure.

Options:
  --author-family <family>  Required implementation author model family.
  --reviewer <alias>        Reviewer alias (default: ${DEFAULT_REVIEWER_ALIAS}).
  --output <absolute-dir>   Required fresh private output directory; existing paths and symlinks are refused.
  --browser <executable>    Use this installed Chromium-family browser executable.
  --help                    Show this help without capture, model, or filesystem work.

Exit codes:
  0  All ten cell medians are at least 85.
  1  All ten cells have three valid samples, but at least one median is below 85.
  2  Invalid or incomplete evidence, non-retryable failure, or exhausted replacement attempt.
  130/143  SIGINT/SIGTERM after owned capture/reviewer cleanup and partial artifact preservation.`

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function cellKey(cell: ReviewCellKey): string {
  return `${cell.targetId}\0${cell.theme}`
}

function sortedCells(): ReviewCellKey[] {
  return HOST_GATE_TARGET_IDS.flatMap((targetId) => THEMES.map((theme) => ({ targetId, theme })))
}

function family(value: string): value is ModelFamily {
  return FAMILIES.includes(value as ModelFamily)
}

function parseArguments(argv: readonly string[]): GateArguments {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  if (args.includes('--help')) throw new Error('--help must be used by itself')

  let authorFamily: ModelFamily | undefined
  let reviewerAlias = DEFAULT_REVIEWER_ALIAS
  let outputDir: string | undefined
  let browserExecutable: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    const equalsAt = token.indexOf('=')
    const flag = equalsAt < 0 ? token : token.slice(0, equalsAt)
    if (!['--author-family', '--reviewer', '--output', '--browser'].includes(flag)) throw new Error(`Unknown argument: ${token}`)
    if (seen.has(flag)) throw new Error(`${flag} may be specified only once`)
    seen.add(flag)
    let value = equalsAt < 0 ? undefined : token.slice(equalsAt + 1)
    if (value === undefined) {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      value = next
      index += 1
    }
    if (value.length === 0 || value.trim().length === 0) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--author-family':
        if (!family(value)) throw new Error('--author-family must be openai, anthropic, google, or xai')
        authorFamily = value
        break
      case '--reviewer':
        if (/\s/.test(value)) throw new Error('--reviewer must be a single reviewer alias')
        reviewerAlias = value
        break
      case '--output':
        if (!isAbsolute(value)) throw new Error('--output must be an absolute directory path')
        outputDir = resolve(value)
        break
      case '--browser':
        browserExecutable = value
        break
    }
  }
  if (!authorFamily) throw new Error('--author-family is required')
  if (!outputDir) throw new Error('--output is required')
  return { mode: 'run', authorFamily, reviewerAlias, outputDir, ...(browserExecutable ? { browserExecutable } : {}) }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!record(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function isFamilyValue(value: unknown): value is ModelFamily {
  return typeof value === 'string' && family(value)
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
}

function makeIssue(code: ReviewIssue['code'], message: string, cell?: ReviewCellKey): ReviewIssue {
  return { ...(cell ? { targetId: cell.targetId, theme: cell.theme } : {}), code, message: message.slice(0, 2_000) }
}

function initialReport(args: Extract<GateArguments, { mode: 'run' }>): GateReport {
  return {
    schemaVersion: 1,
    status: 'error',
    threshold: HOST_GATE_THRESHOLD,
    sampleCount: HOST_GATE_SAMPLE_COUNT,
    authorFamily: args.authorFamily,
    reviewerAlias: args.reviewerAlias,
    reviewerIdentity: null,
    capture: { commit: null, sourceDigest: null, manifestPath: null, manifestSha256: null },
    contextImplementationSha256: null,
    attempts: [],
    cells: sortedCells().map(({ targetId, theme }) => ({
      targetId,
      theme,
      image: null,
      reference: null,
      contextPath: null,
      contextSha256: null,
      slots: Array.from({ length: HOST_GATE_SAMPLE_COUNT }, (_, index) => ({
        slot: index + 1,
        status: 'missing' as const,
        score: null,
        scores: null,
        attemptId: null,
        reportPath: null,
        issues: [],
        conflicts: []
      })),
      median: null,
      conflicts: [],
      status: 'invalid'
    })),
    failures: []
  }
}

function cellRecord(report: GateReport, cell: ReviewCellKey): GateCell {
  const found = report.cells.find((entry) => entry.targetId === cell.targetId && entry.theme === cell.theme)
  if (!found) throw new Error(`Host gate internal cell missing: ${cell.targetId} (${cell.theme})`)
  return found
}

function assertCleanSource(snapshot: SourceSnapshot, repoRoot: string): void {
  if (!record(snapshot) || snapshot.repoRoot !== repoRoot || !validText(snapshot.commit, 256) ||
      !/^[0-9a-f]{64}$/i.test(snapshot.sourceDigest) || snapshot.dirty !== false ||
      !Array.isArray(snapshot.failures) || snapshot.failures.length > 0) {
    throw new Error('Production source inventory is dirty, incomplete, or unavailable; host capture was not accepted.')
  }
}

function sameSource(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return left.repoRoot === right.repoRoot && left.commit === right.commit && left.sourceDigest === right.sourceDigest &&
    left.dirty === right.dirty && left.failures.length === right.failures.length
}

async function inspect(path: string, io: IO): Promise<Stats> {
  const info = await io.lstat(path)
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink evidence path: ${path}`)
  return info
}

async function assertPrivateDirectory(path: string, io: IO): Promise<void> {
  const info = await inspect(path, io)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error(`Expected a private, non-symlink directory: ${path}`)
}

async function createPrivateDirectory(path: string, io: IO, recursive = false): Promise<void> {
  await io.mkdir(path, { mode: 0o700, ...(recursive ? { recursive: true } : {}) })
  await assertPrivateDirectory(path, io)
}

async function requireRegularFile(path: string, io: IO): Promise<void> {
  const info = await inspect(path, io)
  if (!info.isFile()) throw new Error(`Expected a regular evidence file: ${path}`)
}

async function writePrivate(path: string, data: string | Uint8Array, io: IO): Promise<void> {
  await io.writeFile(path, data, { ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}), flag: 'wx', mode: 0o600 })
  await requireRegularFile(path, io)
  const info = await io.lstat(path)
  if ((info.mode & 0o077) !== 0) throw new Error(`Evidence file is not private: ${path}`)
}

function checkSourceShape(value: unknown): asserts value is SourceSnapshot {
  if (!record(value) || typeof value.repoRoot !== 'string' || typeof value.commit !== 'string' ||
      typeof value.sourceDigest !== 'string' || typeof value.dirty !== 'boolean' || !Array.isArray(value.failures)) {
    throw new Error('Source inventory snapshot has an invalid shape.')
  }
}

function validateManifestShape(value: unknown, repoRoot: string, source: SourceSnapshot): asserts value is CaptureManifest {
  if (!record(value) || value.schemaVersion !== 1 || value.surface !== 'desktop-renderer' || value.scope !== 'filtered' ||
      value.commit !== source.commit || !record(value.viewport) || value.viewport.width !== VIEWPORT.width ||
      value.viewport.height !== VIEWPORT.height || !Array.isArray(value.selectors) || !Array.isArray(value.targets) ||
      !Array.isArray(value.captures) || !Array.isArray(value.failures) || value.failures.length !== 0) {
    throw new Error('Capture manifest is not a clean, full two-theme host capture at the approved viewport and source commit.')
  }
  const selectors = value.selectors
  if (selectors.length !== HOST_GATE_TARGET_IDS.length || new Set(selectors).size !== selectors.length ||
      HOST_GATE_TARGET_IDS.some((id) => !selectors.includes(id))) {
    throw new Error('Capture manifest selectors do not name exactly the five approved host targets.')
  }
  const targets = value.targets
  if (targets.length !== HOST_GATE_TARGET_IDS.length) throw new Error('Capture manifest must contain exactly the five approved host targets.')
  const targetsById = new Map<string, CaptureTarget>()
  for (const candidate of targets) {
    if (!record(candidate) || !validText(candidate.id, 256) || candidate.plugin !== null || candidate.kind !== 'host' || targetsById.has(candidate.id)) {
      throw new Error('Capture manifest contains a malformed, duplicate, or non-host target.')
    }
    targetsById.set(candidate.id, candidate as unknown as CaptureTarget)
  }
  if (HOST_GATE_TARGET_IDS.some((id) => !targetsById.has(id)) || targetsById.size !== HOST_GATE_TARGET_IDS.length) {
    throw new Error('Capture manifest is missing an approved host target or includes a foreign target.')
  }
  if (value.captures.length !== HOST_GATE_TARGET_IDS.length * THEMES.length) {
    throw new Error('Capture manifest must contain exactly ten host/theme cells.')
  }
  const found = new Set<string>()
  for (const candidate of value.captures) {
    if (!record(candidate) || !validText(candidate.targetId, 256) || !THEMES.includes(candidate.theme as CaptureTheme) ||
        candidate.status !== 'captured' || candidate.image === null || !record(candidate.image) || !record(candidate.reference)) {
      throw new Error('Capture manifest contains missing or failed host evidence.')
    }
    const key = cellKey({ targetId: candidate.targetId, theme: candidate.theme as CaptureTheme })
    if (!targetsById.has(candidate.targetId) || found.has(key)) throw new Error('Capture manifest contains a duplicate or foreign host/theme cell.')
    found.add(key)
    const image = candidate.image
    const reference = candidate.reference
    if (!validText(image.path, 4096) || !/^[0-9a-f]{64}$/i.test(String(image.sha256)) ||
        !validText(reference.path, 4096) || !/^[0-9a-f]{64}$/i.test(String(reference.sha256))) {
      throw new Error(`Capture manifest evidence is malformed for ${candidate.targetId} (${candidate.theme}).`)
    }
    const approved = resolve(goldenFor(candidate.targetId, candidate.theme as CaptureTheme, repoRoot))
    if (resolve(reference.path) !== approved) throw new Error(`Capture uses a non-approved reference for ${candidate.targetId} (${candidate.theme}).`)
  }
  if (found.size !== HOST_GATE_TARGET_IDS.length * THEMES.length) throw new Error('Capture manifest is missing a host/theme cell.')
}

async function readFrozenEvidence(manifest: CaptureManifest, repoRoot: string, io: IO): Promise<FrozenEvidence[]> {
  const evidence: FrozenEvidence[] = []
  for (const cell of sortedCells()) {
    const capture = manifest.captures.find((candidate) => candidate.targetId === cell.targetId && candidate.theme === cell.theme)!
    for (const [kind, candidate] of [['image', capture.image], ['reference', capture.reference]] as const) {
      if (!candidate) throw new Error(`Missing ${kind} evidence for ${cell.targetId} (${cell.theme}).`)
      const path = resolve(candidate.path)
      await requireRegularFile(path, io)
      const bytes = await io.readFile(path)
      const dimensions = pngDimensions(bytes)
      if (!dimensions || dimensions.width !== SCREENSHOT_SIZE.width || dimensions.height !== SCREENSHOT_SIZE.height) {
        throw new Error(`${cell.targetId} (${cell.theme}) ${kind} is not a ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height} PNG.`)
      }
      const actual = hash(bytes)
      if (actual !== candidate.sha256.toLowerCase()) throw new Error(`${cell.targetId} (${cell.theme}) ${kind} digest does not match its file.`)
      if (kind === 'reference' && path !== resolve(goldenFor(cell.targetId, cell.theme, repoRoot))) {
        throw new Error(`The ${cell.targetId} (${cell.theme}) reference is not the approved repository golden.`)
      }
      evidence.push({ path, sha256: actual, kind })
    }
  }
  return evidence
}

function validateContext(context: HostContractContext, targetId: string, theme: CaptureTheme): void {
  if (!record(context) || context.schemaVersion !== 1 || context.targetId !== targetId || context.theme !== theme || !Array.isArray(context.rules)) {
    throw new Error(`Trusted host contract context is malformed for ${targetId} (${theme}).`)
  }
  let previous = ''
  const ids = new Set<string>()
  for (const rule of context.rules) {
    if (!record(rule) || !validText(rule.id, 128) || !validText(rule.source, 1024) || !validText(rule.text, 4_000) || ids.has(rule.id) || rule.id <= previous) {
      throw new Error(`Trusted host contract rules are malformed or unsorted for ${targetId} (${theme}).`)
    }
    ids.add(rule.id)
    previous = rule.id
  }
}

async function buildContexts(manifest: CaptureManifest, outputDir: string, io: IO): Promise<Map<string, ExpectedContext>> {
  const contextDir = join(outputDir, 'contexts')
  await createPrivateDirectory(contextDir, io)
  const contexts = new Map<string, ExpectedContext>()
  for (const cell of sortedCells()) {
    const target = manifest.targets.find((candidate) => candidate.id === cell.targetId)!
    const context = hostContractContext(target, cell.theme)
    validateContext(context, cell.targetId, cell.theme)
    const text = serializeContractContext(context)
    const bytes = Buffer.from(text, 'utf8')
    const key = cellKey(cell)
    const path = join(contextDir, `${hash(Buffer.from(cell.targetId)).slice(0, 20)}-${cell.theme}.json`)
    await writePrivate(path, bytes, io)
    contexts.set(key, { target, theme: cell.theme, key, text, bytes, sha256: hash(bytes), path, context })
  }
  return contexts
}

function expectedIssueCells(issues: readonly ReviewIssue[], requested: readonly ReviewCellKey[]): Map<string, ReviewIssue[]> {
  const wanted = new Set(requested.map(cellKey))
  const result = new Map<string, ReviewIssue[]>()
  for (const issue of issues) {
    if (!record(issue) || !validText(issue.code, 64) || !validText(issue.message, 2_000)) {
      throw new Error('Reviewer report contains a malformed structured issue.')
    }
    if ((issue.targetId === undefined) !== (issue.theme === undefined)) throw new Error('Reviewer issue must identify both target and theme, or neither.')
    if (issue.targetId === undefined) {
      for (const key of wanted) result.set(key, [...(result.get(key) ?? []), issue])
      continue
    }
    if (!validText(issue.targetId, 256) || !THEMES.includes(issue.theme as CaptureTheme)) throw new Error('Reviewer issue has an invalid target/theme identity.')
    const key = cellKey({ targetId: issue.targetId, theme: issue.theme as CaptureTheme })
    if (!wanted.has(key)) throw new Error(`Reviewer issue references an unrequested cell ${issue.targetId} (${issue.theme}).`)
    result.set(key, [...(result.get(key) ?? []), issue])
  }
  return result
}

function toPreflight(value: unknown, cell: ReviewCellKey): StoredPreflight['identity'] {
  if (value === null) return 'unknown'
  if (!record(value) || !validText(value.provider, 256) || !validText(value.model, 512) || !isFamilyValue(value.family)) {
    throw new Error(`Malformed reviewer preflight identity for ${cell.targetId} (${cell.theme}).`)
  }
  return { provider: value.provider, model: value.model, family: value.family }
}

function sameIdentity(left: ReviewerIdentity, right: ReviewerIdentity): boolean {
  return left.alias === right.alias && left.provider === right.provider && left.model === right.model && left.family === right.family
}

function sameResolvedIdentity(left: ReviewerIdentity, right: { provider: string; model: string; family: ModelFamily }): boolean {
  return left.provider === right.provider && left.model === right.model && left.family === right.family
}

function reportArtifactNames(names: string[]): string[] {
  return names.filter((name) => /^review-report-[0-9a-f-]{36}\.json$/i.test(name))
}

function cellArtifactPrefix(cell: ReviewCellKey, runId: string): string {
  return `capture-${hash(Buffer.from(cell.targetId)).slice(0, 20)}-${cell.theme}-${runId}`
}

async function readReviewArtifacts(
  outputDir: string,
  report: ReviewReport,
  requested: readonly ReviewCellKey[],
  contexts: Map<string, ExpectedContext>,
  io: IO
): Promise<ArtifactBundle> {
  const reviewerDir = join(outputDir, 'reviewer')
  await assertPrivateDirectory(reviewerDir, io)
  const names = await io.readdir(reviewerDir)
  const reportNames = reportArtifactNames(names)
  if (reportNames.length !== 1) throw new Error('Review attempt must persist exactly one run-ID-named ReviewReport artifact.')
  const runId = reportNames[0]!.slice('review-report-'.length, -'.json'.length)
  const reportPath = join(reviewerDir, reportNames[0]!)
  await requireRegularFile(reportPath, io)
  const saved = await io.readFile(reportPath)
  let parsed: unknown
  try { parsed = JSON.parse(saved.toString('utf8')) as unknown } catch { throw new Error('Persisted ReviewReport artifact is not valid JSON.') }
  if (stableJson(parsed) !== stableJson(report)) throw new Error('Persisted ReviewReport artifact differs from the returned report.')

  const artifactPaths = [reportPath]
  const artifactDigests = new Map([[reportPath, hash(saved)]])
  const preflightIdentities: StoredPreflight[] = []
  const identityByCell = new Map<string, StoredPreflight['identity']>()
  for (const cell of requested) {
    const key = cellKey(cell)
    const context = contexts.get(key)
    if (!context) throw new Error(`Missing frozen context for ${cell.targetId} (${cell.theme}).`)
    const prefix = cellArtifactPrefix(cell, runId)
    const contextPath = join(reviewerDir, `${prefix}.context.json`)
    const responsePath = join(reviewerDir, `${prefix}.response.txt`)
    const logPath = join(reviewerDir, `${prefix}.log.txt`)
    const artifactBytes = new Map<string, Buffer>()
    for (const artifact of [contextPath, responsePath, logPath]) {
      await requireRegularFile(artifact, io)
      const bytes = await io.readFile(artifact)
      artifactPaths.push(artifact)
      artifactDigests.set(artifact, hash(bytes))
      artifactBytes.set(artifact, bytes)
    }
    const logBytes = artifactBytes.get(logPath)!
    let log: unknown
    try { log = JSON.parse(logBytes.toString('utf8')) as unknown } catch { throw new Error(`Reviewer log is not valid JSON for ${cell.targetId} (${cell.theme}).`) }
    if (!record(log) || log.targetId !== cell.targetId || log.theme !== cell.theme ||
        log.contextPath !== contextPath || log.contextSha256 !== context.sha256) {
      throw new Error(`Reviewer log does not preserve the requested evidence/context for ${cell.targetId} (${cell.theme}).`)
    }
    const contextBytes = artifactBytes.get(contextPath)!
    if (!contextBytes.equals(context.bytes) || hash(contextBytes) !== context.sha256) {
      throw new Error(`Persisted trusted context changed for ${cell.targetId} (${cell.theme}).`)
    }
    const preflight = toPreflight(log.preflight, cell)
    preflightIdentities.push({ ...cell, identity: preflight })
    identityByCell.set(key, preflight)
    if (log.identity !== null && log.identity !== undefined && !record(log.identity)) {
      throw new Error(`Reviewer log identity is malformed for ${cell.targetId} (${cell.theme}).`)
    }
  }
  return { reviewerDir, runId, reportPath, artifactPaths, artifactDigests, preflightIdentities, identityByCell }
}

function exactCellList(value: unknown, expected: readonly ReviewCellKey[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  const found = new Set<string>()
  for (const cell of value) {
    if (!record(cell) || !exactKeys(cell, ['targetId', 'theme']) || !validText(cell.targetId, 256) ||
        !THEMES.includes(cell.theme as CaptureTheme)) return false
    const key = cellKey({ targetId: cell.targetId, theme: cell.theme as CaptureTheme })
    if (found.has(key)) return false
    found.add(key)
  }
  return expected.every((cell) => found.has(cellKey(cell)))
}

function auditConflicts(
  audit: ContractAudit,
  assessment: VisualAssessment,
  context: ExpectedContext
): { conflicts: StoredConflict[]; penalized: boolean; failure?: string } {
  if (!record(audit) || !exactKeys(audit as unknown as Record<string, unknown>, ['contextSha256', 'acknowledgedRuleIds', 'reasonChecks', 'conflicts']) ||
      audit.contextSha256 !== context.sha256 || !Array.isArray(audit.acknowledgedRuleIds) ||
      !Array.isArray(audit.reasonChecks) || !Array.isArray(audit.conflicts)) {
    return { conflicts: [], penalized: false, failure: 'Contract audit is malformed or has a mismatched context digest.' }
  }
  const ids = context.context.rules.map((rule) => rule.id)
  const known = new Set(ids)
  if (audit.acknowledgedRuleIds.length !== ids.length || audit.acknowledgedRuleIds.some((id, index) => id !== ids[index])) {
    return { conflicts: [], penalized: false, failure: 'Contract acknowledgments are missing, duplicated, unknown, or unsorted.' }
  }
  if (audit.reasonChecks.length !== assessment.reasons.length) return { conflicts: [], penalized: false, failure: 'Contract reason audit does not cover every scored reason exactly once.' }
  const checks = new Set<number>()
  let penalized = false
  for (const check of audit.reasonChecks) {
    if (!record(check) || !exactKeys(check as unknown as Record<string, unknown>, ['reasonIndex', 'contractIds', 'conflictsWithContract', 'affectsScore']) ||
        !Number.isInteger(check.reasonIndex) || check.reasonIndex < 0 || check.reasonIndex >= assessment.reasons.length || checks.has(check.reasonIndex) ||
        !Array.isArray(check.contractIds) || check.contractIds.some((id) => !known.has(id)) ||
        new Set(check.contractIds).size !== check.contractIds.length || typeof check.conflictsWithContract !== 'boolean' || typeof check.affectsScore !== 'boolean') {
      return { conflicts: [], penalized: false, failure: 'Contract reason audit contains a duplicate, missing, out-of-range, or unknown entry.' }
    }
    checks.add(check.reasonIndex)
    if (check.conflictsWithContract && check.affectsScore) penalized = true
  }
  if (audit.conflicts.length > 20) return { conflicts: [], penalized: false, failure: 'Contract conflict annotations exceed the allowed limit.' }
  const conflicts: StoredConflict[] = []
  for (const conflict of audit.conflicts) {
    if (!record(conflict) || !exactKeys(conflict as unknown as Record<string, unknown>, ['contractId', 'reason', 'affectsScore']) ||
        !known.has(conflict.contractId) || !validText(conflict.reason, 1_000) || typeof conflict.affectsScore !== 'boolean') {
      return { conflicts: [], penalized: false, failure: 'Contract conflict annotation is malformed or references an unknown rule.' }
    }
    conflicts.push({ slot: 0, attemptId: '', contractId: conflict.contractId, reason: conflict.reason, affectsScore: conflict.affectsScore })
    if (conflict.affectsScore) penalized = true
  }
  return { conflicts, penalized }
}

function assessCapture(
  candidate: unknown,
  cell: ReviewCellKey,
  manifest: CaptureManifest,
  context: ExpectedContext,
  options: Extract<GateArguments, { mode: 'run' }>,
  priorIdentity: ReviewerIdentity | null,
  preflight: StoredPreflight['identity']
): { capture?: ReviewedCapture; score?: number; conflicts: StoredConflict[]; issue?: ReviewIssue } {
  if (!record(candidate)) return { conflicts: [], issue: makeIssue('invalid-sample', 'Review output cell is malformed.', cell) }
  const capture = candidate as unknown as ReviewedCapture
  if (capture.targetId !== cell.targetId || capture.theme !== cell.theme) {
    return { conflicts: [], issue: makeIssue('invalid-sample', 'Review output cell identity does not match its requested slot.', cell) }
  }
  const source = manifest.captures.find((item) => item.targetId === cell.targetId && item.theme === cell.theme)!
  if (!record(capture.image) || !record(capture.reference) || capture.image.path !== resolve(source.image!.path) ||
      capture.image.sha256 !== source.image!.sha256 || capture.reference.path !== resolve(source.reference.path) ||
      capture.reference.sha256 !== source.reference.sha256) {
    return { conflicts: [], issue: makeIssue('evidence-changed', 'Review output image/reference identity differs from frozen capture evidence.', cell) }
  }
  if (!record(capture.reviewer) || capture.reviewer.alias !== options.reviewerAlias || !validText(capture.reviewer.provider, 256) ||
      !validText(capture.reviewer.model, 512) || !isFamilyValue(capture.reviewer.family)) {
    return { conflicts: [], issue: makeIssue('identity-mismatch', 'Review output has no complete resolved reviewer identity.', cell) }
  }
  if (capture.reviewer.family === options.authorFamily) {
    return { conflicts: [], issue: makeIssue('identity-mismatch', 'Resolved reviewer family matches the implementation author.', cell) }
  }
  if (priorIdentity && !sameIdentity(priorIdentity, capture.reviewer)) {
    return { conflicts: [], issue: makeIssue('identity-mismatch', 'Resolved reviewer identity changed during the host gate.', cell) }
  }
  if (preflight !== 'unknown' && !sameResolvedIdentity(capture.reviewer, preflight)) {
    return { conflicts: [], issue: makeIssue('identity-mismatch', 'Reviewer preflight identity differs from the resolved cell identity.', cell) }
  }
  if (!record(capture.assessment)) return { conflicts: [], issue: makeIssue('invalid-sample', 'Review assessment is malformed.', cell) }
  const assessment = capture.assessment
  if (assessment.targetVisible !== true || assessment.imagesRead !== true) {
    return { conflicts: [], issue: makeIssue('invalid-sample', 'Reviewer did not confirm target visibility and reading both images.', cell) }
  }
  if (!record(assessment.scores) || Object.keys(assessment.scores).length !== SCORE_DIMENSIONS.length ||
      SCORE_DIMENSIONS.some((dimension) => !Object.hasOwn(assessment.scores, dimension) ||
        typeof assessment.scores[dimension] !== 'number' || !Number.isFinite(assessment.scores[dimension]) ||
        assessment.scores[dimension] < 0 || assessment.scores[dimension] > 100)) {
    return { conflicts: [], issue: makeIssue('invalid-sample', 'Review output does not contain five finite scores from 0 through 100.', cell) }
  }
  if (!Array.isArray(assessment.reasons) || assessment.reasons.length < 2 || assessment.reasons.length > 20 ||
      assessment.reasons.some((reason) => !validText(reason, 1_000))) {
    return { conflicts: [], issue: makeIssue('invalid-sample', 'Review reasons are missing, oversized, or malformed.', cell) }
  }
  const score = SCORE_DIMENSIONS.reduce((total, dimension) => total + assessment.scores[dimension], 0) / SCORE_DIMENSIONS.length
  if (!Number.isFinite(capture.score) || capture.score !== score || typeof capture.passed !== 'boolean' || capture.passed !== (score >= HOST_GATE_THRESHOLD)) {
    return { conflicts: [], issue: makeIssue('invalid-sample', 'Review mean/status does not exactly match the five raw dimensions.', cell) }
  }
  if (!record(capture.contractReview) || !validText(capture.contractReview.contextPath, 4096) ||
      capture.contractReview.contextSha256 !== context.sha256) {
    return { conflicts: [], issue: makeIssue('response-shape', 'Review omitted the trusted context path or returned a mismatched context digest.', cell) }
  }
  const audit = auditConflicts(capture.contractReview.audit, assessment, context)
  if (audit.failure) return { conflicts: [], issue: makeIssue('response-shape', audit.failure, cell) }
  const conflicts = audit.conflicts.map((conflict) => ({ ...conflict, slot: 0, attemptId: '' }))
  if (audit.penalized) return { conflicts, issue: makeIssue('contract-conflict', 'A contract conflict was declared score-affecting.', cell) }
  const passed = score >= HOST_GATE_THRESHOLD
  if (capture.passed !== passed) return { conflicts, issue: makeIssue('invalid-sample', 'Review pass flag disagrees with its unrounded score.', cell) }
  return { capture, score, conflicts }
}

function reportEnvelopeFailure(report: unknown, requested: readonly ReviewCellKey[], manifest: CaptureManifest, options: Extract<GateArguments, { mode: 'run' }>): string | null {
  if (!record(report) || report.schemaVersion !== 1 || !['passed', 'failed', 'error'].includes(String(report.status)) ||
      report.scope !== manifest.scope || report.threshold !== HOST_GATE_THRESHOLD || report.authorFamily !== options.authorFamily ||
      report.reviewerAlias !== options.reviewerAlias || !Array.isArray(report.captures) || !Array.isArray(report.failures) ||
      report.failures.some((failure) => typeof failure !== 'string')) return 'Reviewer report has an invalid envelope or mismatched request identity.'
  if (!exactCellList(report.selectedCells, requested)) return 'Reviewer report selection differs from the requested host cells.'
  if (report.issues !== undefined && !Array.isArray(report.issues)) return 'Reviewer report issues are malformed.'
  return null
}

function median(scores: number[]): number {
  const sorted = scores.slice().sort((left, right) => left - right)
  return sorted[1]!
}

function markdown(report: GateReport): string {
  const lines = [
    '# Host screenshot gate',
    '',
    `Status: **${report.status}** (threshold ${HOST_GATE_THRESHOLD}; ${HOST_GATE_SAMPLE_COUNT} valid samples per cell).`,
    '',
    '| Target | Theme | Slot means | Median | Result | Raw reports |',
    '| --- | --- | --- | ---: | --- | --- |'
  ]
  for (const cell of report.cells) {
    const scores = cell.slots.map((slot) => slot.score === null ? '—' : String(slot.score)).join(', ')
    const attempts = [...new Set(cell.slots.map((slot) => slot.reportPath).filter((path): path is string => path !== null))]
      .map((path) => `[report](${path})`).join(', ')
    lines.push(`| ${cell.targetId} | ${cell.theme} | ${scores} | ${cell.median === null ? '—' : String(cell.median)} | ${cell.status} | ${attempts || '—'} |`)
  }
  if (report.failures.length > 0) lines.push('', '## Issues', '', ...report.failures.map((failure) => `- ${failure}`))
  return `${lines.join('\n')}\n`
}

async function verifyStableState(
  outputDir: string,
  manifestPath: string,
  manifestBytes: Buffer,
  manifest: CaptureManifest,
  source: SourceSnapshot,
  evidence: readonly FrozenEvidence[],
  contexts: Map<string, ExpectedContext>,
  attemptArtifactDigests: ReadonlyMap<string, string>,
  contextImplementationSha256: string,
  io: IO
): Promise<void> {
  if (stableJson(manifest) !== stableJson(JSON.parse(manifestBytes.toString('utf8')) as unknown)) {
    throw new Error('Frozen capture manifest changed during the host campaign.')
  }
  const persistedManifest = await io.readFile(manifestPath)
  if (!persistedManifest.equals(manifestBytes)) throw new Error('Persisted capture manifest changed during the host campaign.')
  const currentSource = await collectSource(io.repoRoot, io)
  assertCleanSource(currentSource, io.repoRoot)
  if (!sameSource(source, currentSource)) throw new Error('Production source commit or source digest changed during the host campaign.')
  const implementationBytes = await io.readFile(HOST_CONTRACTS_PATH)
  if (hash(implementationBytes) !== contextImplementationSha256) throw new Error('Trusted host-contract implementation changed during the host campaign.')
  for (const item of evidence) {
    await requireRegularFile(item.path, io)
    const bytes = await io.readFile(item.path)
    if (hash(bytes) !== item.sha256) throw new Error(`Frozen ${item.kind} changed during review: ${item.path}`)
  }
  for (const context of contexts.values()) {
    await requireRegularFile(context.path, io)
    const bytes = await io.readFile(context.path)
    if (!bytes.equals(context.bytes) || hash(bytes) !== context.sha256) throw new Error(`Frozen trusted context changed: ${context.path}`)
  }
  for (const [path, expectedSha256] of attemptArtifactDigests) {
    await requireRegularFile(path, io)
    const bytes = await io.readFile(path)
    if (hash(bytes) !== expectedSha256) throw new Error(`Persisted reviewer artifact changed during the host campaign: ${path}`)
  }
  const outputInfo = await io.lstat(outputDir)
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('Host gate output directory changed during the campaign.')
}

async function collectSource(repoRoot: string, io: IO): Promise<SourceSnapshot> {
  const snapshot = await io.sourceSnapshot(repoRoot)
  checkSourceShape(snapshot)
  return snapshot
}

function expectedPath(context: ExpectedContext, reviewerDir: string, cell: ReviewCellKey, runId: string): string {
  return join(reviewerDir, `${cellArtifactPrefix(cell, runId)}.context.json`)
}

function outcomeMapFor(
  report: ReviewReport,
  requested: readonly ReviewCellKey[],
  manifest: CaptureManifest,
  contexts: Map<string, ExpectedContext>,
  bundle: ArtifactBundle,
  options: Extract<GateArguments, { mode: 'run' }>,
  currentIdentity: ReviewerIdentity | null
): { outcomes: Map<string, CellOutcome>; fatal: string | null } {
  const outcomes = new Map<string, CellOutcome>()
  const envelopeError = reportEnvelopeFailure(report, requested, manifest, options)
  if (envelopeError) {
    for (const cell of requested) outcomes.set(cellKey(cell), { status: 'terminal', issues: [makeIssue('invalid-sample', envelopeError, cell)] })
    return { outcomes, fatal: envelopeError }
  }
  let fatal: string | null = null
  const issues = (report.issues ?? []) as ReviewIssue[]
  let issuesByCell: Map<string, ReviewIssue[]>
  try { issuesByCell = expectedIssueCells(issues, requested) }
  catch (error) {
    const message = errorMessage(error)
    for (const cell of requested) outcomes.set(cellKey(cell), { status: 'terminal', issues: [makeIssue('invalid-sample', message, cell)] })
    return { outcomes, fatal: message }
  }
  const capturesByCell = new Map<string, ReviewedCapture>()
  for (const capture of report.captures) {
    if (!record(capture) || typeof capture.targetId !== 'string' || !THEMES.includes(capture.theme as CaptureTheme)) {
      fatal = 'Reviewer report contains a malformed output cell.'
      break
    }
    const key = cellKey({ targetId: capture.targetId, theme: capture.theme as CaptureTheme })
    if (!requested.some((cell) => cellKey(cell) === key) || capturesByCell.has(key)) {
      fatal = 'Reviewer report contains a foreign or duplicate output cell.'
      break
    }
    capturesByCell.set(key, capture as unknown as ReviewedCapture)
  }
  if (fatal) {
    for (const cell of requested) outcomes.set(cellKey(cell), { status: 'terminal', issues: [makeIssue('invalid-sample', fatal, cell)] })
    return { outcomes, fatal }
  }

  for (const cell of requested) {
    const key = cellKey(cell)
    const context = contexts.get(key)!
    const cellIssues = issuesByCell.get(key) ?? []
    const terminalIssues = cellIssues.filter((issue) => issue.code !== 'operational' && issue.code !== 'response-shape')
    const retryableIssues = cellIssues.filter((issue) => issue.code === 'operational' || issue.code === 'response-shape')
    const candidate = capturesByCell.get(key)
    const preflight = bundle.identityByCell.get(key) ?? 'unknown'
    if (terminalIssues.length > 0) {
      outcomes.set(key, { status: 'terminal', issues: terminalIssues })
      fatal ??= terminalIssues[0]!.message
      continue
    }
    if (retryableIssues.length > 0 && candidate) {
      const mixed = makeIssue('invalid-sample', 'Reviewer returned a scored cell and a retryable failure for the same cell.', cell)
      outcomes.set(key, { status: 'terminal', issues: [...retryableIssues, mixed] })
      fatal ??= mixed.message
      continue
    }
    if (retryableIssues.length > 0) {
      outcomes.set(key, { status: 'retryable', issues: retryableIssues })
      continue
    }
    if (!candidate) {
      const missing = makeIssue('invalid-sample', 'Reviewer omitted a selected cell without a retryable issue.', cell)
      outcomes.set(key, { status: 'terminal', issues: [missing] })
      fatal ??= missing.message
      continue
    }
    const checked = assessCapture(candidate, cell, manifest, context, options, currentIdentity, preflight)
    const decoratedConflicts = checked.conflicts.map((conflict) => ({ ...conflict, slot: 0, attemptId: '' }))
    if (checked.issue) {
      const retryable = checked.issue.code === 'response-shape'
      outcomes.set(key, { status: retryable ? 'retryable' : 'terminal', issues: [checked.issue] })
      if (!retryable) fatal ??= checked.issue.message
      continue
    }
    outcomes.set(key, { status: 'valid', capture: checked.capture, score: checked.score, issues: [] })
    const logIdentity = preflight
    if (logIdentity !== 'unknown' && !sameResolvedIdentity(checked.capture!.reviewer, logIdentity)) {
      const mismatch = makeIssue('identity-mismatch', 'Reviewer artifact identity does not agree with the reported capture identity.', cell)
      outcomes.set(key, { status: 'terminal', issues: [mismatch] })
      fatal ??= mismatch.message
    }
    if (decoratedConflicts.length > 0) outcomes.get(key)!.issues.push(...decoratedConflicts.map((conflict) => makeIssue('invalid-sample', conflict.reason, cell)))
  }
  if (report.status === 'error' && issues.length === 0) {
    const error = 'Review report returned error status without a typed issue code.'
    fatal ??= error
    for (const cell of requested) {
      const existing = outcomes.get(cellKey(cell))
      if (existing?.status === 'valid') outcomes.set(cellKey(cell), { status: 'terminal', issues: [makeIssue('invalid-sample', error, cell)] })
    }
  }
  return { outcomes, fatal }
}

function buildAttemptRecord(
  id: string,
  slot: number,
  requested: readonly ReviewCellKey[],
  reportPath: string | null,
  reviewerReportPath: string | null,
  artifactPaths: string[],
  issues: ReviewIssue[],
  retryOf: string | null,
  preflightIdentities: StoredPreflight[]
): GateAttempt {
  return {
    id,
    slot,
    requestedCells: requested.map((cell) => ({ ...cell })),
    reportPath,
    reviewerReportPath,
    artifactPaths,
    issues: [...issues],
    retryOf,
    preflightIdentities
  }
}

function setSlotIssue(report: GateReport, cell: ReviewCellKey, slotNumber: number, attemptId: string, issue: ReviewIssue): void {
  const slot = cellRecord(report, cell).slots[slotNumber - 1]!
  slot.status = 'invalid'
  slot.score = null
  slot.scores = null
  slot.attemptId = attemptId
  slot.issues.push(issue)
}
function invalidateValidScores(report: GateReport, issue: ReviewIssue): void {
  for (const cell of report.cells) {
    cell.median = null
    cell.status = 'invalid'
    for (const slot of cell.slots) {
      if (slot.status !== 'valid') continue
      slot.status = 'invalid'
      slot.score = null
      slot.scores = null
      const cellIssue = makeIssue(issue.code, issue.message, { targetId: cell.targetId, theme: cell.theme })
      if (!slot.issues.some((current) => current.code === cellIssue.code && current.message === cellIssue.message)) {
        slot.issues.push(cellIssue)
      }
    }
  }
}


function addConflicts(gateReport: GateReport, slot: number, attemptId: string, report: ReviewReport | null): void {
  if (!report || !Array.isArray(report.captures)) return
  for (const candidate of report.captures) {
    if (!record(candidate) || !validText(candidate.targetId, 256) || !THEMES.includes(candidate.theme as CaptureTheme) || !record(candidate.contractReview)) continue
    const audit = candidate.contractReview.audit
    if (!record(audit) || !Array.isArray(audit.conflicts)) continue
    const cell = { targetId: candidate.targetId, theme: candidate.theme as CaptureTheme }
    const stored = cellRecord(gateReport, cell)
    for (const conflict of audit.conflicts) {
      if (!record(conflict) || !validText(conflict.contractId, 128) || !validText(conflict.reason, 1_000) || typeof conflict.affectsScore !== 'boolean') continue
      const raw: StoredConflict = { slot, attemptId, contractId: conflict.contractId, reason: conflict.reason, affectsScore: conflict.affectsScore }
      stored.conflicts.push(raw)
      stored.slots[slot - 1]!.conflicts.push(raw)
    }
  }
}

function finalizeCells(report: GateReport): boolean {
  let complete = true
  for (const cell of report.cells) {
    if (cell.slots.length !== HOST_GATE_SAMPLE_COUNT || cell.slots.some((slot) => slot.status !== 'valid' || slot.score === null)) {
      cell.median = null
      cell.status = 'invalid'
      complete = false
      continue
    }
    const scores = cell.slots.map((slot) => slot.score!)
    cell.median = median(scores)
    cell.status = cell.median >= HOST_GATE_THRESHOLD ? 'passed' : 'failed'
  }
  return complete
}

function checkStatus(report: GateReport, complete: boolean, fatal: boolean): { status: GateStatus; exitCode: number } {
  if (fatal || !complete) return { status: 'error', exitCode: 2 }
  if (report.cells.every((cell) => cell.status === 'passed')) return { status: 'passed', exitCode: 0 }
  return { status: 'failed', exitCode: 1 }
}

function relativeOutputPath(outputDir: string, path: string): string {
  const result = relative(outputDir, path)
  return result.split(sep).join('/')
}

/** Accepts only ten immutable host cells with three valid reviews each and medians of at least 85; preserves partial evidence on errors. */
export async function runHostGate(argv: readonly string[], dependencies: HostGateDependencies = {}): Promise<number> {
  let args: GateArguments
  try {
    args = parseArguments(argv)
  } catch (error) {
    ;(dependencies.stderr ?? defaultIO.stderr)(`${errorMessage(error)}\n${HELP_TEXT}`)
    return 2
  }
  if (args.mode === 'help') {
    ;(dependencies.stdout ?? defaultIO.stdout)(HELP_TEXT)
    return 0
  }

  const io: IO = {
    ...defaultIO,
    ...dependencies,
    repoRoot: resolve(dependencies.repoRoot ?? DEFAULT_REPO_ROOT),
    sourceSnapshot: dependencies.sourceSnapshot ?? ((repoRoot) => collectInventory(repoRoot))
  }
  const gateReport = initialReport(args)
  let signalName: SignalName | undefined
  let exitCode = 2
  let campaignFatal = false
  const controller = new AbortController()
  const onInterrupt = (name: SignalName): SignalListener => () => {
    if (signalName !== undefined) return
    signalName = name
    controller.abort(new Error(`Interrupted by ${name}`))
  }
  const onSigint = onInterrupt('SIGINT')
  const onSigterm = onInterrupt('SIGTERM')

  try {
    try {
      await io.lstat(args.outputDir)
      throw new Error('Output path already exists; host gate refuses to overwrite it.')
    } catch (error) {
      if (record(error) && error.code !== 'ENOENT') throw error
      if (error instanceof Error && error.message.includes('already exists')) throw error
    }
    await io.mkdir(dirname(args.outputDir), { mode: 0o700, recursive: true })
    await createPrivateDirectory(args.outputDir, io)
    args.outputDir = await io.realpath(args.outputDir)
  } catch (error) {
    io.stderr(`Cannot create fresh private host-gate output: ${errorMessage(error)}`)
    return 2
  }

  io.signals.on('SIGINT', onSigint)
  io.signals.on('SIGTERM', onSigterm)

  const appendFailure = (message: string) => {
    if (!gateReport.failures.includes(message)) gateReport.failures.push(message.slice(0, 2_000))
  }
  const inventoryReader = dependencies.sourceSnapshot ?? ((repoRoot: string) => collectInventory(repoRoot))

  try {
    const sourceSnapshotValue = await inventoryReader(io.repoRoot)
    checkSourceShape(sourceSnapshotValue)
    const source = sourceSnapshotValue
    assertCleanSource(source, io.repoRoot)
    gateReport.capture.commit = source.commit
    gateReport.capture.sourceDigest = source.sourceDigest

    const contextImplementationBytes = await io.readFile(HOST_CONTRACTS_PATH)
    const contextImplementationSha256 = hash(contextImplementationBytes)
    gateReport.contextImplementationSha256 = contextImplementationSha256

    const captureDir = join(args.outputDir, 'capture')
    await createPrivateDirectory(captureDir, io)
    const captureOptions: CaptureOptions = {
      repoRoot: io.repoRoot,
      outputDir: captureDir,
      only: [...HOST_GATE_TARGET_IDS],
      themes: [...THEMES],
      skipBuild: false,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      signal: controller.signal,
      ...(args.browserExecutable ? { browserExecutable: args.browserExecutable } : {})
    }
    const capture = dependencies.captureApplication ?? defaultCaptureApplication
    const captured: unknown = await capture(captureOptions)
    const serializedManifest = json(captured)
    const manifestBytes = Buffer.from(serializedManifest, 'utf8')
    const manifestPath = join(args.outputDir, MANIFEST_NAME)
    await writePrivate(manifestPath, manifestBytes, io)
    gateReport.capture.manifestPath = relativeOutputPath(args.outputDir, manifestPath)
    gateReport.capture.manifestSha256 = hash(manifestBytes)
    validateManifestShape(captured, io.repoRoot, source)
    const manifest = deepFreeze(structuredClone(captured))
    const evidence = await readFrozenEvidence(manifest, io.repoRoot, io)
    const contexts = await buildContexts(manifest, args.outputDir, io)
    for (const cell of sortedCells()) {
      const entry = cellRecord(gateReport, cell)
      const captureEvidence = manifest.captures.find((candidate) => candidate.targetId === cell.targetId && candidate.theme === cell.theme)!
      entry.image = structuredClone(captureEvidence.image)
      entry.reference = structuredClone(captureEvidence.reference)
      const context = contexts.get(cellKey(cell))!
      entry.contextPath = relativeOutputPath(args.outputDir, context.path)
      entry.contextSha256 = context.sha256
    }
    await verifyStableState(args.outputDir, manifestPath, manifestBytes, manifest, source, evidence, contexts, new Map(), contextImplementationSha256, io)

    const reviewer = dependencies.reviewManifest ?? defaultReviewManifest
    const attemptArtifactDigests = new Map<string, string>()
    let slotAttemptIndex = 0

    const runAttempt = async (slot: number, requested: ReviewCellKey[], retryOf: string | null): Promise<AttemptResult> => {
      slotAttemptIndex += 1
      const attemptNumber = slotAttemptIndex
      const attemptId = `slot-${slot}-attempt-${attemptNumber}-${randomUUID()}`
      const attemptDir = join(args.outputDir, 'attempts', `slot-${slot}`)
      if (!await existsDirectory(attemptDir, io)) await createPrivateDirectory(attemptDir, io, true)
      const outputDir = join(attemptDir, `attempt-${attemptNumber}`)
      try {
        await createPrivateDirectory(outputDir, io)
      } catch (error) {
        const issue = makeIssue('persistence', `Cannot create a fresh reviewer attempt directory: ${errorMessage(error)}`)
        const attempt = buildAttemptRecord(attemptId, slot, requested, null, null, [], [issue], retryOf, [])
        gateReport.attempts.push(attempt)
        return { attempt, report: null, issues: [issue], outcomes: new Map(requested.map((cell) => [cellKey(cell), { status: 'terminal' as const, issues: [makeIssue('persistence', issue.message, cell)] }])), fatal: issue.message }
      }
      const reviewOptions: ReviewOptions = {
        outputDir,
        reviewerAlias: args.reviewerAlias,
        authorFamily: args.authorFamily,
        threshold: HOST_GATE_THRESHOLD,
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal: controller.signal,
        ...(requested.length === sortedCells().length ? {} : { onlyCells: requested.map((cell) => ({ ...cell })) })
      }
      let report: ReviewReport
      try {
        report = await reviewer(manifest, reviewOptions)
      } catch (error) {
        const issue = makeIssue(signalName ? 'aborted' : 'operational', errorMessage(error))
        const attempt = buildAttemptRecord(attemptId, slot, requested, null, null, [], [issue], retryOf, [])
        gateReport.attempts.push(attempt)
        const outcomes = new Map<string, { status: 'valid' | 'retryable' | 'terminal'; issues: ReviewIssue[] }>()
        for (const cell of requested) outcomes.set(cellKey(cell), {
          status: signalName ? 'terminal' : 'retryable',
          issues: [makeIssue(signalName ? 'aborted' : 'operational', issue.message, cell)]
        })
        return { attempt, report: null, issues: [issue], outcomes, fatal: signalName ? issue.message : null }
      }

      let bundle: ArtifactBundle
      try {
        bundle = await readReviewArtifacts(outputDir, report, requested, contexts, io)
        for (const [path, sha256] of bundle.artifactDigests) attemptArtifactDigests.set(path, sha256)
      } catch (error) {
        const issue = makeIssue('persistence', errorMessage(error))
        const reviewerDir = join(outputDir, 'reviewer')
        const names = await io.readdir(reviewerDir).catch(() => [])
        const artifactPaths = names.map((name) => join(reviewerDir, name))
        const attempt = buildAttemptRecord(attemptId, slot, requested, null, null, artifactPaths.map((path) => relativeOutputPath(args.outputDir, path)), [issue], retryOf, [])
        gateReport.attempts.push(attempt)
        const outcomes = new Map<string, { status: 'valid' | 'retryable' | 'terminal'; issues: ReviewIssue[] }>()
        for (const cell of requested) outcomes.set(cellKey(cell), { status: 'terminal', issues: [makeIssue('persistence', issue.message, cell)] })
        return { attempt, report, issues: [issue], outcomes, fatal: issue.message }
      }

      const artifactFailure: ReviewIssue[] = []
      for (const cell of requested) {
        const key = cellKey(cell)
        const capture = report.captures.find((candidate) => candidate.targetId === cell.targetId && candidate.theme === cell.theme)
        const context = contexts.get(key)!
        const pathFromLog = expectedPath(context, bundle.reviewerDir, cell, bundle.runId)
        if (capture && capture.contractReview?.contextPath !== pathFromLog) {
          artifactFailure.push(makeIssue('persistence', `ReviewReport context path does not match its run-ID artifact for ${cell.targetId} (${cell.theme}).`, cell))
        }
      }
      const envelope = reportEnvelopeFailure(report, requested, manifest, args)
      const baseIssues = [...(report.issues ?? []), ...artifactFailure]
      const preliminary = outcomeMapFor(report, requested, manifest, contexts, bundle, args, gateReport.reviewerIdentity)
      if (envelope && preliminary.fatal === null) preliminary.fatal = envelope
      const attemptIssues = [...baseIssues]
      if (preliminary.fatal) attemptIssues.push(makeIssue('invalid-sample', preliminary.fatal))
      const reportPath = relativeOutputPath(args.outputDir, bundle.reportPath)
      const attempt = buildAttemptRecord(
        attemptId,
        slot,
        requested,
        reportPath,
        reportPath,
        bundle.artifactPaths.map((path) => relativeOutputPath(args.outputDir, path)),
        attemptIssues,
        retryOf,
        bundle.preflightIdentities
      )
      gateReport.attempts.push(attempt)
      addConflicts(gateReport, slot, attemptId, report)
      for (const [key, outcome] of preliminary.outcomes) {
        const cell = sortedCells().find((candidate) => cellKey(candidate) === key)!
        const slotRecord = cellRecord(gateReport, cell).slots[slot - 1]!
        for (const issue of outcome.issues) if (!slotRecord.issues.some((current) => current.code === issue.code && current.message === issue.message)) slotRecord.issues.push(issue)
        if (outcome.status === 'valid') {
          slotRecord.status = 'valid'
          slotRecord.score = outcome.score ?? null
          slotRecord.scores = outcome.capture ? { ...outcome.capture.assessment.scores } : null
          slotRecord.attemptId = attemptId
          slotRecord.reportPath = reportPath
          const cellRecordValue = cellRecord(gateReport, cell)
          cellRecordValue.image = structuredClone(outcome.capture!.image)
          cellRecordValue.reference = structuredClone(outcome.capture!.reference)
          cellRecordValue.contextPath = relativeOutputPath(args.outputDir, contexts.get(key)!.path)
          cellRecordValue.contextSha256 = contexts.get(key)!.sha256
          if (gateReport.reviewerIdentity === null) gateReport.reviewerIdentity = structuredClone(outcome.capture!.reviewer)
          else if (!sameIdentity(gateReport.reviewerIdentity, outcome.capture!.reviewer)) {
            const mismatch = makeIssue('identity-mismatch', 'Resolved reviewer identity changed across host-gate samples.', cell)
            slotRecord.status = 'invalid'
            slotRecord.score = null
            slotRecord.scores = null
            slotRecord.issues.push(mismatch)
            preliminary.outcomes.set(key, { status: 'terminal', issues: [mismatch] })
            preliminary.fatal ??= mismatch.message
          }
        } else if (outcome.status === 'terminal') {
          slotRecord.status = 'invalid'
          slotRecord.score = null
          slotRecord.scores = null
          slotRecord.attemptId = attemptId
          slotRecord.reportPath = reportPath
        }
      }
      if (preliminary.fatal) {
        gateReport.failures.push(preliminary.fatal)
      }

      try {
        await verifyStableState(args.outputDir, manifestPath, manifestBytes, manifest, source, evidence, contexts, attemptArtifactDigests, contextImplementationSha256, io)
      } catch (error) {
        const issue = makeIssue('evidence-changed', errorMessage(error))
        attempt.issues.push(issue)
        gateReport.failures.push(issue.message)
        invalidateValidScores(gateReport, issue)
        return { attempt, report, issues: [...baseIssues, issue], outcomes: new Map(requested.map((cell) => [cellKey(cell), { status: 'terminal' as const, issues: [makeIssue('evidence-changed', issue.message, cell)] }])), fatal: issue.message }
      }
      return { attempt, report, issues: attemptIssues, outcomes: preliminary.outcomes, fatal: preliminary.fatal }
    }

    for (let slotNumber = 1; slotNumber <= HOST_GATE_SAMPLE_COUNT && !campaignFatal; slotNumber += 1) {
      const retryCounts = new Map<string, number>()
      slotAttemptIndex = 0
      const initialCells = sortedCells()
      const initial = await runAttempt(slotNumber, initialCells, null)
      if (signalName) {
        campaignFatal = true
        break
      }
      if (initial.fatal) {
        campaignFatal = true
        break
      }
      const retryCells: ReviewCellKey[] = []
      for (const cell of initialCells) {
        const outcome = initial.outcomes.get(cellKey(cell))
        if (outcome?.status !== 'retryable') continue
        retryCounts.set(cellKey(cell), 1)
        retryCells.push(cell)
      }
      for (const cell of retryCells) {
        if (signalName) { campaignFatal = true; break }
        if ((retryCounts.get(cellKey(cell)) ?? 0) !== 1) {
          const issue = makeIssue('invalid-sample', 'The one shared replacement attempt was already used for this cell/slot.', cell)
          setSlotIssue(gateReport, cell, slotNumber, initial.attempt.id, issue)
          campaignFatal = true
          break
        }
        const retry = await runAttempt(slotNumber, [cell], initial.attempt.id)
        if (signalName) { campaignFatal = true; break }
        const outcome = retry.outcomes.get(cellKey(cell))
        if (retry.fatal || !outcome || outcome.status !== 'valid') {
          if (outcome?.status === 'retryable') {
            const issue = makeIssue('invalid-sample', 'The shared operational/response-shape replacement attempt did not produce a valid sample.', cell)
            setSlotIssue(gateReport, cell, slotNumber, retry.attempt.id, issue)
            gateReport.failures.push(issue.message)
          }
          campaignFatal = true
          break
        }
      }
    }
    try {
      await verifyStableState(args.outputDir, manifestPath, manifestBytes, manifest, source, evidence, contexts, attemptArtifactDigests, contextImplementationSha256, io)
    } catch (error) {
      const issue = makeIssue('evidence-changed', errorMessage(error))
      appendFailure(issue.message)
      const lastAttempt = gateReport.attempts[gateReport.attempts.length - 1]
      if (lastAttempt && !lastAttempt.issues.some((current) => current.code === issue.code && current.message === issue.message)) {
        lastAttempt.issues.push(issue)
      }
      invalidateValidScores(gateReport, issue)
      campaignFatal = true
    }
    const complete = finalizeCells(gateReport)
    const status = checkStatus(gateReport, complete, campaignFatal)
    gateReport.status = status.status
    exitCode = status.exitCode
  } catch (error) {
    campaignFatal = true
    gateReport.status = 'error'
    appendFailure(errorMessage(error))
    exitCode = 2
  } finally {
    if (signalName) {
      campaignFatal = true
      gateReport.status = 'error'
      appendFailure(`Interrupted by ${signalName}.`)
      exitCode = signalName === 'SIGINT' ? 130 : 143
    }
    finalizeCells(gateReport)
    try {
      await writePrivate(join(args.outputDir, OUTPUT_MARKDOWN_NAME), markdown(gateReport), io)
    } catch (error) {
      gateReport.status = 'error'
      appendFailure(`Could not persist host-gate.md: ${errorMessage(error)}`)
      campaignFatal = true
      exitCode = signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : 2
    }
    try {
      await writePrivate(join(args.outputDir, OUTPUT_REPORT_NAME), json(gateReport), io)
    } catch (error) {
      gateReport.status = 'error'
      appendFailure(`Could not persist host-gate.json: ${errorMessage(error)}`)
      campaignFatal = true
      exitCode = signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : 2
    }
    io.signals.off('SIGINT', onSigint)
    io.signals.off('SIGTERM', onSigterm)
  }

  if (exitCode === 0) io.stdout(`Host gate passed: all 10 cell medians are at least ${HOST_GATE_THRESHOLD}.`)
  else if (exitCode === 1) io.stdout('Host gate completed: at least one valid cell median is below 85.')
  else io.stderr(`Host gate ${signalName ? 'interrupted' : 'blocked'}; see ${join(args.outputDir, OUTPUT_REPORT_NAME)}.`)
  return exitCode
}

async function existsDirectory(path: string, io: IO): Promise<boolean> {
  try {
    const info = await io.lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return false
    throw error
  }
}

if (import.meta.main) {
  const exitCode = await runHostGate(Bun.argv.slice(2))
  process.exitCode = exitCode
}
