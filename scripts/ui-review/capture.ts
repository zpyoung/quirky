import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromium, type Browser, type BrowserServer, type Locator, type Page } from 'playwright'
import { type UiModel, type UiToolEntry, type ThemeInfo } from '@quirky/protocol'
import { connectDaemon, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope'
import {
  closeAskCardFixture,
  createAskCardFixture,
  closeCaptureTerminalFixture,
  createCaptureTerminalFixture,
  createLoopFixture,
  createIsolatedRuntimeEnvironment,
  createTranscriptFixture,
  createViewFixture,
  openFixtureEditorBuffer,
  prepareCaptureFixtureHome,
  prepareCaptureTerminalFixture,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type AskCardFixture,
  type CaptureTerminalFixture,
  type EditorFixtureBuffer,
  type FixtureRpcClient,
  type LoopFixture,
  type PreparedCaptureFixtureHome,
  type RegisteredCaptureFixtures,
  type TranscriptFixture,
  type ViewFixture
} from './fixtures'
import { CHECKS_FIXTURE_BRANCH } from './tasks-fixture'
import { createRemoteFixtures, type RemoteFixtures } from './remote-fixtures'
import { captureBrowserExecutable } from './browser'
import { PALETTE_SEARCH_LABEL } from '../../packages/ui/src/plugins/palette'
import { enableCaptureVisibilitySettings, projectCaptureInventory, scopeCaptureInventory } from './contribution-inventory'
export { discoverCaptureTargets } from './contribution-inventory'
import {
  CAPTURE_SCHEMA_VERSION,
  THEMES,
  type CaptureEvidence,
  type CaptureManifest,
  type CaptureOptions,
  type CaptureTarget,
  type CaptureTheme,
  type ContributionInventory,
  type ImageEvidence
} from './contracts'
import { clearScene, newSceneState, populateShell, raiseNeedsYouToast, scopeToProject, showPopupsTogether, type SceneState } from './shell-scenes'
import {
  DEVICE_SCALE_FACTOR,
  SCREENSHOT_SIZE,
  VIEWPORT,
  loadGoldenReferences,
  pngDimensions,
  referenceFor,
  type GoldenReferences
} from './goldens'
import {
  prepareRuntimeAssets,
  runtimeAssetEnvironment,
  snapshotRuntimeAssets,
  verifyRuntimeAssets,
  type AssetSnapshot,
  type RuntimeAssets
} from './runtime-assets'

const UI_DIST_RELATIVE = 'packages/ui/dist'
const DAEMON_ENTRY = 'packages/daemon/src/main.ts'
const BUILD_ENTRY = 'packages/ui/build.ts'
const CAPTURE_ROOT = 'captures'
const CAPTURE_PROGRESS_FILE = 'capture-progress.json'
const SHELL_TARGETS: ReadonlySet<string> = new Set(['host:shell', 'host:scoped', 'host:popups'])
export type CaptureCell = { targetId: string; theme: CaptureTheme }
export const OVERLAY_OPEN_MS = 15_000
const OVERLAY_TRIGGER_NAMES = new WeakMap<Promise<unknown>, string>()
let readinessSequence = 0

function namedOverlayTrigger(command: string, trigger: Promise<unknown>): Promise<unknown> {
  OVERLAY_TRIGGER_NAMES.set(trigger, command)
  return trigger
}

const CELL_TERMINAL_TARGETS: ReadonlySet<string> = new Set([
  'view:quirky.session/worktree',
  'status-bar:quirky.git/ahead-behind',
  'status-bar:quirky.reviews/checks',
  'view:quirky.accounts/session-accessory',
  'overlay:quirky.accounts/switch-dialog',
  'overlay:quirky.handoff/dialog'
])
const REMOTE_TARGETS: ReadonlySet<string> = new Set([
  'view:quirky.orchestration/remote-worker-output',
  'view:quirky.worktree/remote'
])
const VIEW_TARGETS: Readonly<Record<string, true>> = { 'view:quirky.view/render': true, 'view:quirky.view/pane': true }
const TERMINAL_SURFACE_PLUGINS: ReadonlySet<string> = new Set([
  'quirky.terminal',
  'quirky.session',
  'quirky.session-info',
  'quirky.agent-status',
  'quirky.terminal-dock'
])

type RuntimeClient = FixtureRpcClient & { close(): void }

type RendererTheme = ThemeInfo & { plugin: string | null }
export type ReadinessClause =
  | 'unmounted' | 'hidden' | 'busy' | 'loading-leaf' | 'loading-text'
  | 'ask-card' | 'chat-agents' | 'quick-open' | 'terminal-pane' | 'empty'
  | 'git-reviewed-header' | 'git-reviewed-collapsed' | 'git-expanded-count'
  | 'git-code' | 'git-local-fixture' | 'git-since-notice'

export type ReadinessPhase = { token: string; sequence: number; startedAt: number }
export type ReadinessArg = {
  slotSelector: string
  targetId: string
  ask: AskCardFixture | null
  terminal: CaptureTerminalFixture | null
  phase: ReadinessPhase | null
}

export type ReadinessTrace = {
  token: string
  sequence: number
  targetId: string
  startedAt: number
  polls: number
  firstPollAt: number | null
  lastPollAt: number | null
  maxGapMs: number | null
  maxPollMs: number
  totalPollMs: number
  readyAt: number | null
  lastFailed: ReadinessClause | null
  longTaskObserver: boolean
  longTasks: { count: number; totalMs: number; maxMs: number } | null
}

export type ReadinessTiming = {
  sequence: number
  deadlineMs: number
  budgetMs: number
  phaseOffsetMs: number
  readyMs: number | null
  hostRejectedMs: number | null
  diagnosticLatencyMs: number | null
  hostMaxLagMs: number
  polls: number | null
  firstPollMs: number | null
  lastPollMs: number | null
  maxGapMs: number | null
  maxPollMs: number | null
  totalPollMs: number | null
  longTaskObserver: boolean | null
  longTaskCoverageFromMs: number | null
  longTasks: { count: number; totalMs: number; maxMs: number } | null
  lastFailed: ReadinessClause | null
  lateReady: boolean | null
  cleanup: 'proved' | `unproved: ${string}`
}

type ReadinessPhaseEntry = {
  state: 'open' | 'closed'
  sequence: number
  closedBy: 'host' | 'successor' | 'superseded' | null
  trace: ReadinessTrace
  observer: PerformanceObserver | null
}

type ReadinessPageStore = { phases: Record<string, ReadinessPhaseEntry> }
type ReadinessPageGlobal = typeof globalThis & { __quirkyCaptureReadiness?: ReadinessPageStore }

export type CaptureRuntime = {
  options: CaptureOptions
  outputDir: string
  client: RuntimeClient
  page: Page
  model: UiModel
  themes: Record<CaptureTheme, RendererTheme>
  references: GoldenReferences
  fixtures: RegisteredCaptureFixtures
  editorBuffer: EditorFixtureBuffer | null
  terminalFixture: CaptureTerminalFixture | null
  cellTerminalFixture: CaptureTerminalFixture | null
  cellTerminalWorktreeId: string | null
  ownedTerminalFixtures: Map<string, CaptureTerminalFixture>
  terminalAcquisitionUncertain: boolean
  cellAskFixture: AskCardFixture | null
  ownedAskFixtures: Map<string, AskCardFixture>
  askAcquisitionUncertain: boolean
  transcriptFixture: TranscriptFixture | null
  loopFixture: LoopFixture | null
  remoteFixtures: RemoteFixtures | null
  viewFixture?: ViewFixture | null
  structuredSessionId: string | null
  dirtyCloseFixture: { bufferId: string; tabId: string; originalContents: string } | null
  scene: SceneState
  manifest: CaptureManifest
  secrets: string[]
  pageErrors: string[]
  fixtureInputErrors: ReadonlyMap<string, string>
  lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTiming }
}
class CaptureRuntimeError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sanitizedError(error: unknown, secrets: string[]): string {
  let message = errorMessage(error)
  for (const secret of secrets) {
    if (secret.length === 0) continue
    message = message.replaceAll(secret, '<redacted>').replaceAll(encodeURIComponent(secret), '<redacted>')
  }
  message = message
    .replace(/\S*quirky-test-process-scope-[^\s]*/g, '<process-scope>')
    .replace(/([?#&]token=)[^\s&#]*/gi, '$1<redacted>')
    .replace(/\b((?:rpc|hook)?token)\s*[:=]\s*([^\s,;}\]]+)/gi, '$1=<redacted>')
  return message.slice(0, 2_000)
}
export function registerPathSecret(path: string, secrets: string[]): void {
  const aliases = [path]
  try { aliases.push(realpathSync(path)) } catch {}
  for (const alias of aliases) {
    if (!secrets.includes(alias)) secrets.push(alias)
    const alternate = /^\/private\/(?:var|tmp)\//.test(alias)
      ? alias.slice('/private'.length)
      : /^\/(?:var|tmp)\//.test(alias) ? `/private${alias}` : null
    if (alternate && !secrets.includes(alternate)) secrets.push(alternate)
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'capture was aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

export function bounded<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  throwIfAborted(signal)
  const { promise: boundedPromise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (error: unknown, value?: T) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (error !== undefined) reject(error)
    else resolve(value as T)
  }
  const onAbort = () => finish(abortError(signal!))
  timer = setTimeout(() => finish(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  promise.then((value) => finish(undefined, value), (error) => finish(error))
  return boundedPromise
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function evidence(path: string, bytes: Uint8Array): ImageEvidence {
  return { path: resolve(path), sha256: sha256(bytes) }
}


export function selectCaptureTargets(targets: CaptureTarget[], selectors: string[], inventory?: ContributionInventory): CaptureTarget[] {
  if (selectors.length === 0) return targets
  const selected = new Set<string>()
  for (const selector of selectors) {
    const alias = inventory?.toolAliases.find((entry) => entry.declaration.id === selector)
    if (alias) throw new Error(`${alias.declaration.id} is not mounted; tool ${alias.toolId} renders ${alias.renderedTarget.id}`)
    if (selector.trim().length === 0) throw new Error('empty capture selector is not allowed')
    const matches = targets.filter((target) => target.id === selector || target.plugin === selector)
    if (matches.length === 0) throw new Error(`unknown capture selector ${JSON.stringify(selector)}`)
    for (const target of matches) selected.add(target.id)
  }
  return targets.filter((target) => selected.has(target.id))
}

export function captureCells(targets: CaptureTarget[], themes: readonly CaptureTheme[] = THEMES): CaptureCell[] {
  return themes.flatMap((theme) => targets.map((target) => ({ targetId: target.id, theme })))
}

function validateOptions(options: CaptureOptions): { repoRoot: string; outputDir: string } {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('capture timeout must be a positive finite number')
  if (!Array.isArray(options.only)) throw new Error('--only selectors must be an array')
  if (options.themes && (options.themes.length === 0 || options.themes.some((theme) => !THEMES.includes(theme)))) {
    throw new Error('capture themes must be a non-empty subset of dark and light')
  }
  const repoRoot = resolve(options.repoRoot)
  const outputDir = resolve(options.outputDir)
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) throw new Error(`repository root is not a directory: ${repoRoot}`)
  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) throw new Error(`capture output directory must already exist: ${outputDir}`)
  const progressPath = join(outputDir, CAPTURE_PROGRESS_FILE)
  if (existsSync(progressPath)) throw new Error(`refusing to overwrite existing capture progress: ${progressPath}`)
  return { repoRoot, outputDir }
}


async function readStreamTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length > 8_000) text = text.slice(-8_000)
  }
  text += decoder.decode()
  return text
}

async function runOwnedCommand(
  scope: ProcessScope,
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal)
  const child = scope.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stdoutPromise = readStreamTail(child.stdout)
  const stderrPromise = readStreamTail(child.stderr)
  try {
    const status = await bounded(child.exited, timeoutMs, signal, command.join(' '))
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (status !== 0) throw new Error(`${command.join(' ')} failed (${status}): ${stderr.trim() || stdout.trim() || 'no details'}`)
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(250)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.allSettled([stdoutPromise, stderrPromise])
    throw error
  }
}

function outputTail(stream: ReadableStream<Uint8Array>): () => string {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
        if (text.length > 8_000) text = text.slice(-8_000)
      }
    } catch {
      // Process shutdown closes the pipe; the bounded tail is diagnostic-only.
    }
  })()
  return () => text
}

export async function waitForRuntime(home: string, child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if (child.exitCode !== null) throw new Error(`daemon exited before startup (exit ${child.exitCode})`)
    const runtime = readRuntime(home)
    if (runtime && await bounded(isDaemonAlive(runtime, Math.min(500, timeoutMs)), timeoutMs, signal, 'daemon health check')) return runtime
    await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`)
}

const SHOWCASE_TRANSCRIPT = 'packages/ui/test/fixtures/markdown-showcase.md'
const SHOWCASE_PROMPT = 'Why do partial replies disappear after a reload?'
const SHOWCASE_AT = Date.UTC(2026, 10, 17, 9, 30)

/**
 * Gives a structured session a finished turn whose agent reply is the markdown showcase, so its
 * capture shows every rendered block. The journal belongs to quirky.structured and has no method
 * that takes a ready-made reply, so the rows are written into its store directly. The store
 * exists only once the plugin has run, which `ensureStore` makes sure of.
 */
export async function seedStructuredTranscript(
  home: string,
  sessionId: string,
  repoRoot: string,
  ensureStore: () => Promise<unknown>
): Promise<void> {
  const showcase = readFileSync(join(repoRoot, SHOWCASE_TRANSCRIPT), 'utf8')
  await ensureStore()
  const store = join(home, 'plugin-data', 'quirky.structured', 'store.db')
  if (!existsSync(store)) throw new Error('quirky.structured has no journal to seed')
  const db = new Database(store)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const insert = db.query('INSERT INTO structured_messages (session_id, seq, role, text, data, item, at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    const rows: [string, string, object][] = [
      ['user', SHOWCASE_PROMPT, { kind: 'user', text: SHOWCASE_PROMPT }],
      ['assistant', showcase, { kind: 'prose', text: showcase }],
      ['result', '', { kind: 'turn-end', state: 'done', durationMs: 42_000 }]
    ]
    db.transaction(() => {
      const next = (db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM structured_messages WHERE session_id = ?').get(sessionId) as { next: number }).next
      rows.forEach(([role, text, item], index) => insert.run(sessionId, next + index, role, text, JSON.stringify(item), SHOWCASE_AT + index * 1000))
    })()
  } finally {
    db.close()
  }
}

export async function rpc(
  client: FixtureRpcClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  throwIfAborted(signal)
  return await bounded(client.callAny(method, params, { timeoutMs }), timeoutMs, signal, method)
}

function chooseTheme(themes: RendererTheme[], appearance: CaptureTheme): RendererTheme {
  const candidates = themes.filter((theme) => theme.appearance === appearance)
  const selected = candidates.find((theme) => theme.id === appearance) ??
    candidates.find((theme) => theme.id !== 'default') ?? candidates[0]
  if (!selected) throw new Error(`no ${appearance} appearance theme is available`)
  return selected
}

function writeThemeSelection(outputDir: string, themes: Record<CaptureTheme, RendererTheme>, references: GoldenReferences): void {
  const path = join(outputDir, 'theme-selection.json')
  if (existsSync(path)) throw new Error(`refusing to overwrite existing evidence: ${path}`)
  writeFileSync(path, JSON.stringify({
    themes: Object.fromEntries(THEMES.map((appearance) => [appearance, {
      id: themes[appearance].id,
      title: themes[appearance].title,
      plugin: themes[appearance].plugin,
      appearance: themes[appearance].appearance
    }])),
    references
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
function writeCaptureProgress(outputDir: string, manifest: CaptureManifest, initialized: boolean): void {
  const path = join(outputDir, CAPTURE_PROGRESS_FILE)
  const contents = JSON.stringify(manifest, null, 2) + '\n'
  if (!initialized) {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function selectedThemeList(value: unknown): RendererTheme[] {
  const themes = record(value).themes
  if (!Array.isArray(themes)) throw new Error('theme.list did not return a theme inventory')
  return themes.filter((item): item is RendererTheme => {
    const theme = record(item)
    return typeof theme.id === 'string' && typeof theme.title === 'string' &&
      (theme.appearance === 'dark' || theme.appearance === 'light') &&
      (theme.plugin === null || typeof theme.plugin === 'string') &&
      typeof theme.colors === 'object' && theme.colors !== null
  })
}

function themeBackground(theme: RendererTheme): string {
  const value = record(theme.colors).bg
  if (typeof value !== 'string') throw new Error(`theme ${theme.id} does not declare the bg color token`)
  return value
}

async function applyTheme(runtime: CaptureRuntime, theme: RendererTheme): Promise<void> {
  const result = record(await rpc(runtime.client, 'theme.set', { id: theme.id }, runtime.options.timeoutMs, runtime.options.signal))
  if (result.active !== theme.id || result.chosen !== theme.id) throw new Error(`theme API did not activate ${theme.id}`)
  await bounded(runtime.page.waitForFunction((expected) => {
    const actual = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    return actual.toLowerCase() === expected.toLowerCase()
  }, themeBackground(theme), { timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, `renderer theme ${theme.id}`)
}
async function verifyThemeBeforeCapture(runtime: CaptureRuntime, expected: RendererTheme): Promise<boolean> {
  try {
    const list = record(await rpc(runtime.client, 'theme.list', {}, runtime.options.timeoutMs, runtime.options.signal))
    const activeId = list.active
    const selected = selectedThemeList(list).find((theme) => theme.id === activeId)
    const background = await bounded(runtime.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    ), runtime.options.timeoutMs, runtime.options.signal, 'read renderer theme')
    if (list.chosen === expected.id && activeId === expected.id && selected?.appearance === expected.appearance &&
      background.toLowerCase() === themeBackground(expected).toLowerCase()) {
      return false
    }
    await applyTheme(runtime, expected)
    return true
  } catch (error) {
    if (runtime.options.signal?.aborted) throw error
    throw new CaptureRuntimeError(`theme verification failed: ${errorMessage(error)}`)
  }
}

async function waitForUiWindow(runtime: CaptureRuntime): Promise<void> {
  const deadline = Date.now() + runtime.options.timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(runtime.options.signal)
    const state = record(await rpc(runtime.client, 'ui.state', {}, runtime.options.timeoutMs, runtime.options.signal))
    if (Array.isArray(state.windows) && state.windows.length > 0) {
      await runtime.page.locator('.shell-workspace').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      return
    }
    await Bun.sleep(100)
  }
  throw new Error('renderer did not connect to the isolated daemon')
}

async function waitForRendererModel(runtime: CaptureRuntime): Promise<void> {
  await runtime.page.locator('.tool-shell__stripe').first().waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
}

async function openLocalWorktreeContext(
  runtime: CaptureRuntime,
  worktree = runtime.fixtures.primaryWorktree
): Promise<void> {
  const view = runtime.model.views.find((candidate) => candidate.id === 'view:quirky.session/worktree')
  if (!view) throw new Error('the local session worktree view is unavailable for fixture preparation')
  const usePrimarySession = worktree.id === runtime.fixtures.primaryWorktree.id
  const target: CaptureTarget = { id: view.id, plugin: view.plugin, title: view.title, kind: 'view' }
  const input = fixtureViewInput(
    { ...runtime.fixtures, primaryWorktree: worktree },
    target,
    runtime.editorBuffer,
    usePrimarySession ? runtime.terminalFixture : null,
    runtime.structuredSessionId,
    {
      transcript: runtime.transcriptFixture,
      loop: runtime.loopFixture,
      remote: runtime.remoteFixtures,
      cellTerminal: runtime.cellTerminalFixture,
      view: runtime.viewFixture
    }
  )
  await rpc(runtime.client, 'ui.view.open', { id: view.id, input }, runtime.options.timeoutMs, runtime.options.signal)
  await inspectSurface(runtime, target)
}

async function prepareAccountsStaleSession(runtime: CaptureRuntime, provider: 'claude' | 'codex'): Promise<void> {
  const terminal = runtime.cellTerminalFixture ?? runtime.terminalFixture
  if (!terminal) throw new Error(`a terminal fixture is required to prepare the ${provider} account session`)
  const { primaryWorktree } = runtime.fixtures
  const { timeoutMs, signal } = runtime.options
  const homeOverrides = {
    claude: { value: null, source: 'absent' },
    codex: { value: null, source: 'absent' }
  }

  await rpc(runtime.client, 'quirky.accounts/select', { provider, accountId: null }, timeoutMs, signal)
  await rpc(runtime.client, 'quirky.accounts/prepare', {
    agent: provider,
    sessionId: terminal.sessionId,
    worktreeId: primaryWorktree.id,
    cwd: primaryWorktree.path,
    homeOverrides
  }, timeoutMs, signal)

  const listed = record(await rpc(runtime.client, 'quirky.accounts/list', { provider }, timeoutMs, signal))
  const findAccountId = (state: Record<string, unknown>): string | undefined => {
    if (!Array.isArray(state.accounts)) return undefined
    const account = state.accounts.map(record).find((entry) =>
      entry.provider === provider && typeof entry.id === 'string' && entry.id.length > 0
    )
    return typeof account?.id === 'string' ? account.id : undefined
  }
  let accountId = findAccountId(listed)

  if (!accountId) {
    const pending = record(await rpc(runtime.client, 'quirky.accounts/beginLogin', {
      provider,
      label: provider === 'claude' ? 'Review Claude' : 'Review Codex'
    }, timeoutMs, signal))
    if (typeof pending.id !== 'string' || pending.id.length === 0) {
      throw new Error(`${provider} account sign-in did not return a request ID`)
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for ${provider} account sign-in`)
      const status = record(await rpc(
        runtime.client,
        'quirky.accounts/loginStatus',
        { id: pending.id },
        Math.min(timeoutMs, remaining),
        signal
      ))
      if (status.status === 'complete') {
        const result = record(status.result)
        const completedId = typeof status.accountId === 'string' ? status.accountId : result.id
        if (typeof completedId === 'string' && completedId.length > 0) accountId = completedId
        break
      }
      if (status.status === 'error' || status.status === 'cancelled') {
        throw new Error(`${provider} account sign-in ${status.status}: ${String(status.error ?? '')}`)
      }
      const waitMs = Math.min(100, Math.max(1, deadline - Date.now()))
      await bounded(Bun.sleep(waitMs), waitMs, signal, `wait for ${provider} account sign-in`)
    }
    if (!accountId) {
      accountId = findAccountId(record(await rpc(runtime.client, 'quirky.accounts/list', { provider }, timeoutMs, signal)))
    }
  }
  if (!accountId) throw new Error(`completed ${provider} sign-in did not create a managed account`)
  await rpc(runtime.client, 'quirky.accounts/select', { provider, accountId }, timeoutMs, signal)
}

export function targetSlotSelector(target: CaptureTarget): string {
  if (target.kind === 'overlay' && target.id === 'overlay:quirky.feedback/mode') return '[data-quirky-feedback]'
  if (target.kind === 'overlay' && target.id === 'overlay:quirky.terminal/floating') return '[data-floating-panel]'
  const attr = JSON.stringify(target.id)
  return target.kind === 'overlay' ? `[data-plugin-overlay=${attr}]` : `[data-plugin-slot=${attr}]`
}

async function closeNewChatDialog(runtime: CaptureRuntime): Promise<void> {
  const selector = '[data-plugin-overlay="overlay:quirky.session/chat-dialogs"] [role="dialog"]'
  await runtime.page.evaluate((dialogSelector) => {
    document.querySelector(dialogSelector)?.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click()
  }, selector)
  await bounded(runtime.page.locator(selector).waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }),
    runtime.options.timeoutMs, undefined, 'close New chat dialog')
}

async function closeCurrentSurface(runtime: CaptureRuntime): Promise<void> {
  await clearScene(runtime)
  await closeNewChatDialog(runtime)
  const settings = runtime.page.getByRole('dialog', { name: 'Settings', exact: true })
  if (await settings.count() > 0 && await settings.isVisible()) {
    const cancel = settings.getByRole('button', { name: 'Cancel', exact: true })
    if (await cancel.count() > 0) await cancel.click({ timeout: runtime.options.timeoutMs })
  }

  const accountSwitchDialog = runtime.page.locator('[data-plugin-overlay="overlay:quirky.accounts/switch-dialog"] [role="dialog"]')
  const hadAccountSwitchDialog = await accountSwitchDialog.count() > 0
  const accountAccessory = runtime.page.locator('.accounts-ui.session-accessory')
  const hadAccountAccessory = await accountAccessory.count() > 0
  const feedbackSurface = runtime.page.locator('[data-quirky-feedback]:not([data-feedback-banner])')
  const hadFeedback = await feedbackSurface.count() > 0
  const floatingPanel = runtime.page.locator('[data-floating-panel]')
  const orchestrationSetupSurface = runtime.page.locator('aside[aria-label="Enable orchestration"]')
  const hadFloating = await floatingPanel.count() > 0 || await orchestrationSetupSurface.count() > 0
  const composer = runtime.page.locator('.tasks-composer')
  const composerDialog = '[data-plugin-overlay="overlay:quirky.tasks/workspace-composer"] .ui-dialog-backdrop'
  const quickOpen = runtime.page.locator('.qe-quick-open')
  const quickOpenDialog = runtime.page.locator('[data-plugin-overlay="overlay:quirky.editor/quick-open"] .ui-dialog-backdrop')
  const hadQuickOpen = await quickOpen.count() > 0
  const hadComposer = await composer.count() > 0
  const handoffDialog = runtime.page.locator('[data-plugin-overlay="overlay:quirky.handoff/dialog"] [role="dialog"]')
  const loopsDialog = runtime.page.locator('[data-plugin-overlay="overlay:quirky.loops/dialogs"] [role="dialog"]')

  if (hadQuickOpen) {
    if (await quickOpen.isVisible()) {
      const cancel = quickOpenDialog.getByRole('button', { name: 'Cancel', exact: true })
      const close = quickOpenDialog.getByRole('button', { name: 'Close dialog', exact: true })
      const dismiss = await cancel.count() > 0 ? cancel : close
      if (await dismiss.count() > 0) await dismiss.click({ timeout: runtime.options.timeoutMs })
    }
    await bounded(quickOpen.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }),
      runtime.options.timeoutMs, runtime.options.signal, 'close Editor quick-open')
  }
  await bounded(runtime.page.keyboard.press('Escape'), runtime.options.timeoutMs, runtime.options.signal, 'close renderer overlay')
  if (hadFeedback) {
    await rpc(runtime.client, 'setting.set', { id: 'setting:quirky.feedback/active', value: false }, runtime.options.timeoutMs, runtime.options.signal)
    await bounded(feedbackSurface.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close Feedback mode')
  }
  if (await handoffDialog.count() > 0) {
    await rpc(runtime.client, 'ui.command.run', { id: 'command:quirky.handoff/cancel' }, runtime.options.timeoutMs, runtime.options.signal)
    await bounded(handoffDialog.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close Handoff dialog')
  }
  if (await loopsDialog.count() > 0) {
    await rpc(runtime.client, 'ui.command.run', {
      id: 'command:quirky.loops/setup-action',
      args: { action: 'cancel' }
    }, runtime.options.timeoutMs, runtime.options.signal)
    await bounded(loopsDialog.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close Loops dialog')
  }
  if (hadAccountSwitchDialog) {
    await rpc(runtime.client, 'quirky.accounts/select', { provider: 'claude', accountId: null }, runtime.options.timeoutMs, runtime.options.signal)
    await bounded(accountSwitchDialog.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close Accounts switch dialog')
  }
  if (hadComposer) {
    // escape may already be unmounting the dialog; inspect and dismiss in one renderer turn.
    await runtime.page.evaluate((selector) => {
      const dialog = document.querySelector(selector)
      const cancel = dialog?.querySelector<HTMLButtonElement>('.tasks-composer__actions button')
      if (cancel && !cancel.disabled) cancel.click()
    }, composerDialog)
    await bounded(runtime.page.locator(composerDialog).waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }),
      runtime.options.timeoutMs, runtime.options.signal, 'close Tasks workspace composer')
  }
  if (hadFloating) {
    await rpc(runtime.client, 'quirky.terminal/setFloating', { open: false }, runtime.options.timeoutMs, runtime.options.signal)
    await Promise.all([
      bounded(floatingPanel.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close floating panel'),
      bounded(orchestrationSetupSurface.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close orchestration setup')
    ])
  }

  await rpc(runtime.client, 'ui.palette.set', { open: false }, runtime.options.timeoutMs, runtime.options.signal)
  await rpc(runtime.client, 'ui.view.close', {}, runtime.options.timeoutMs, runtime.options.signal)
  if (hadAccountAccessory) {
    await rpc(runtime.client, 'quirky.accounts/select', { provider: 'codex', accountId: null }, runtime.options.timeoutMs, runtime.options.signal)
    await bounded(accountAccessory.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'close Accounts session accessory')
  }
  await rpc(runtime.client, 'ui.panel.close', {}, runtime.options.timeoutMs, runtime.options.signal)
  await rpc(runtime.client, 'ui.sidebar.set', { visible: true }, runtime.options.timeoutMs, runtime.options.signal)
}

/** The one place that knows how the shell exposes Settings; update it when the control moves. */
export async function openSettings(runtime: Pick<CaptureRuntime, 'page' | 'options'>): Promise<void> {
  const more = runtime.page.locator('.window-bar').getByRole('button', { name: 'More', exact: true })
  if (await more.count() !== 1) throw new Error('host Overflow control is unavailable')
  await more.click({ timeout: runtime.options.timeoutMs })
  const settings = runtime.page.getByRole('menuitem', { name: 'Settings', exact: true })
  if (await settings.count() !== 1) throw new Error('host Settings control is unavailable')
  await settings.click({ timeout: runtime.options.timeoutMs })
  await runtime.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
}

export function fixtureViewInput(
  fixtures: RegisteredCaptureFixtures,
  target: CaptureTarget,
  editorBuffer: EditorFixtureBuffer | null,
  terminalFixture: CaptureTerminalFixture | null,
  structuredSessionId: string | null = null,
  extra?: {
    transcript?: TranscriptFixture | null
    loop?: LoopFixture | null
    remote?: RemoteFixtures | null
    cellTerminal?: CaptureTerminalFixture | null
    view?: ViewFixture | null
    ask?: AskCardFixture | null
  }
): Record<string, unknown> {
  if (target.id === 'view:quirky.ask/card') {
    if (!extra?.ask) throw new Error('an ask fixture is required for the Ask card view')
    return { askId: extra.ask.askId }
  }
  const worktree = fixtures.primaryWorktree
  const input: Record<string, unknown> = {
    worktree: worktree.id,
    worktreeId: worktree.id,
    workspace: worktree.id,
    repo: fixtures.repo.id,
    repoId: fixtures.repo.id
  }
  if (target.id === 'view:quirky.view/render') {
    if (!extra?.view) throw new Error('a view fixture is required for the render view')
    input.viewId = extra.view.inlineViewId
  }
  if (target.id === 'view:quirky.view/pane') {
    if (!extra?.view) throw new Error('a view fixture is required for the pane view')
    input.session = extra.view.sessionId
  }
  if (target.id === 'view:quirky.orchestration/remote-worker-output') {
    if (!extra?.remote) throw new Error('remote fixtures are required for the remote worker output view')
    return { dispatchId: extra.remote.dispatchId }
  }
  if (target.id === 'view:quirky.reviews/create') {
    const readyWorktree = fixtures.worktrees.find((candidate) => candidate.name === 'ui-review-ready')
    if (!readyWorktree) throw new Error('the Reviews create fixture worktree ui-review-ready is unavailable')
    input.worktree = readyWorktree.id
    input.worktreeId = readyWorktree.id
    input.workspace = readyWorktree.id
  }
  if (target.plugin === 'quirky.git' && target.id.endsWith('/diff')) {
    input.mode = 'review'
  }
  if (target.plugin === 'quirky.editor' && target.id === 'view:quirky.editor/document' && editorBuffer) {
    input.bufferId = editorBuffer.id
    input.tabId = editorBuffer.tabId
    input.mode = editorBuffer.mode
  }
  const activeTerminal = extra?.cellTerminal ?? terminalFixture
  if (activeTerminal && (
    ['quirky.terminal', 'quirky.session-info', 'quirky.terminal-dock', 'quirky.accounts'].includes(target.plugin ?? '') ||
    target.id === 'view:quirky.session/worktree'
  )) {
    input.session = activeTerminal.sessionId
    input.sessionId = activeTerminal.sessionId
    input.tabId = activeTerminal.tabId
    input.pane = activeTerminal.paneId
    input.paneId = activeTerminal.paneId
  }
  if (target.id === 'view:quirky.session/structured') {
    if (!structuredSessionId) throw new Error('a structured session fixture is required for the structured view')
    input.session = structuredSessionId
  }
  if (target.id === 'view:quirky.session-info/transcript') {
    if (!extra?.transcript) throw new Error('a transcript fixture is required for the transcript view')
    input.session = extra.transcript.sessionId
  }
  if (target.id === 'view:quirky.loops/loop') {
    if (!extra?.loop) throw new Error('a loop fixture is required for the Loops view')
    input.loopId = extra.loop.loopId
  }
  if (target.id === 'view:quirky.worktree/remote') {
    if (!extra?.remote) throw new Error('remote fixtures are required for the remote workspace view')
    input.workspace = extra.remote.mirrorId
  }
  return input
}

async function openWorktreeContext(runtime: CaptureRuntime): Promise<void> {
  const editorView = runtime.model.views.find((view) => view.plugin === 'quirky.editor' && view.id.endsWith('/document'))
  if (!editorView || !runtime.editorBuffer) throw new Error('fixture editor buffer is unavailable for worktree-scoped surface')
  const worktree = runtime.fixtures.primaryWorktree
  await rpc(runtime.client, 'ui.view.open', {
    id: editorView.id,
    input: {
      worktree: worktree.id,
      worktreeId: worktree.id,
      workspace: worktree.id,
      bufferId: runtime.editorBuffer.id,
      tabId: runtime.editorBuffer.tabId,
      mode: runtime.editorBuffer.mode
    }
  }, runtime.options.timeoutMs, runtime.options.signal)
  await inspectSurface(runtime, { id: editorView.id, plugin: editorView.plugin, title: editorView.title, kind: 'view' })
}
async function visibleDialogNames(page: Page): Promise<string[]> {
  const backdrops = page.locator('.overlay-layer .ui-dialog-backdrop:visible')
  if (await backdrops.count() === 0) return []
  const names = (await backdrops.locator('.ui-dialog__title').allTextContents())
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : ['dialog']
}

export async function waitForOverlay(
  runtime: Pick<CaptureRuntime, 'page' | 'options'>,
  locator: Locator,
  label: string,
  trigger?: Promise<unknown>
): Promise<void> {
  const timeoutMs = runtime.options.overlayOpenMs ?? OVERLAY_OPEN_MS
  const timeoutError = Symbol('overlay timeout')
  const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>()
  const timer = setTimeout(() => rejectTimeout(timeoutError), timeoutMs)
  const visible = locator.waitFor({ state: 'visible', timeout: timeoutMs + 5 })
  const pending = [visible, timeout]
  if (trigger) {
    const { promise: refused, reject } = Promise.withResolvers<never>()
    void trigger.catch((error) => reject(new Error(
      `trigger ${OVERLAY_TRIGGER_NAMES.get(trigger) ?? label} was refused: ${errorMessage(error)}`
    )))
    pending.push(refused)
  }
  try {
    await bounded(Promise.race(pending), timeoutMs + 10, runtime.options.signal, label)
  } catch (error) {
    if (error === timeoutError) {
      const names = await visibleDialogNames(runtime.page)
      throw new Error(`${label} did not draw within ${timeoutMs}ms; visible dialogs: ${names.join(', ') || 'none'}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}


async function openUnsavedCloseOverlay(runtime: CaptureRuntime): Promise<void> {
  const buffer = runtime.editorBuffer
  if (!buffer?.tabId) throw new Error('the fixture editor tab is unavailable for unsaved-close capture')
  await openWorktreeContext(runtime)
  const state = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: buffer.id }, runtime.options.timeoutMs, runtime.options.signal))
  const current = Array.isArray(state.buffers) ? state.buffers.map(record).find((entry) => entry.id === buffer.id) : undefined
  const tab = Array.isArray(state.tabs) ? state.tabs.map(record).find((entry) => entry.tabId === buffer.tabId && entry.bufferId === buffer.id) : undefined
  const sameSource = current?.path === buffer.path || (typeof current?.path === 'string' &&
    realpathSync(current.path) === realpathSync(buffer.path))
  if (!current || !tab || !sameSource || current.dirty !== false || typeof current.contentRevision !== 'number') {
    throw new Error(`the mounted fixture editor document did not identify the expected clean app.ts buffer and tab; ${JSON.stringify({
      requested: { bufferId: buffer.id, tabId: buffer.tabId, path: buffer.path },
      actual: { bufferId: current?.id, path: current?.path, dirty: current?.dirty, revision: current?.contentRevision, tab }
    })}`)
  }
  const originalContents = readFileSync(buffer.path, 'utf8')
  runtime.dirtyCloseFixture = { bufferId: buffer.id, tabId: buffer.tabId, originalContents }
  const draft = record(await rpc(runtime.client, 'quirky.editor/draft', {
    bufferId: buffer.id,
    content: `${originalContents}\n// Unsaved review draft\n`,
    expectedRevision: current.contentRevision
  }, runtime.options.timeoutMs, runtime.options.signal))
  if (draft.dirty !== true || typeof draft.contentRevision !== 'number') throw new Error('the editor fixture draft did not become dirty')
  buffer.contentRevision = draft.contentRevision
  const documentContent = runtime.page.locator('[data-plugin-slot="view:quirky.editor/document"] .qe-document-content .cm-content')
  await documentContent.filter({ hasText: '// Unsaved review draft' }).waitFor({
    state: 'visible', timeout: Math.min(10_000, runtime.options.timeoutMs)
  })
  await documentContent.click({ timeout: runtime.options.timeoutMs })
  await rpc(runtime.client, 'ui.palette.set', { open: true }, runtime.options.timeoutMs, runtime.options.signal)
  const palette = runtime.page.getByRole('dialog', { name: 'Command palette', exact: true })
  await palette.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  await palette.getByRole('tab', { name: 'Commands', exact: true }).click({ timeout: runtime.options.timeoutMs })
  await palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL, exact: true }).fill('Close Editor Tab', { timeout: runtime.options.timeoutMs })
  const command = palette.getByRole('option').filter({
    has: runtime.page.locator('.shell-palette__entry-name').filter({ hasText: /^Close Editor Tab$/ })
  })
  await command.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  if (await command.count() !== 1) throw new Error('the exact Close Editor Tab command is unavailable')
  await command.click({ timeout: runtime.options.timeoutMs })
  await palette.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs })
  const dialog = runtime.page.getByRole('dialog', { name: 'Unsaved Changes', exact: true })
  await waitForOverlay(runtime, dialog, 'Unsaved Changes')
  if (await dialog.count() !== 1 || !/(?:^|[“"'\s])app\.ts(?:[”"'\s]|$)/.test(await dialog.innerText())) {
    throw new Error('Unsaved Changes did not identify exactly the fixture app.ts document')
  }
  for (const name of ['Cancel', "Don't Save", 'Save']) {
    const button = dialog.getByRole('button', { name, exact: true })
    if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) {
      throw new Error(`Unsaved Changes ${name} control is unavailable or disabled`)
    }
  }
  const openedState = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: buffer.id }, runtime.options.timeoutMs, runtime.options.signal))
  const requests = Array.isArray(openedState.closeRequests) ? openedState.closeRequests.map(record) : []
  if (requests.some((request) => request.bufferId !== buffer.id || request.tabId !== buffer.tabId)) {
    throw new Error('the editor close request did not identify the owned fixture buffer and tab')
  }
}

async function resolveUnsavedCloseOverlay(runtime: CaptureRuntime): Promise<void> {
  const owned = runtime.dirtyCloseFixture
  if (!owned) return
  const { timeoutMs } = runtime.options
  const dialog = runtime.page.getByRole('dialog', { name: 'Unsaved Changes', exact: true })
  let failure: unknown
  try {
    if (await dialog.count() === 1 && await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: timeoutMs })
    }
  } catch (error) { failure = error }
  try {
    const state = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: owned.bufferId }, timeoutMs))
    const current = Array.isArray(state.buffers) ? state.buffers.map(record).find((entry) => entry.id === owned.bufferId) : undefined
    const requests = Array.isArray(state.closeRequests) ? state.closeRequests.map(record) : []
    if (requests.some((request) => request.bufferId === owned.bufferId && request.tabId === owned.tabId)) {
      if (current?.dirty !== true) throw new Error('owned editor close request became clean before it could be safely cancelled')
      await rpc(runtime.client, 'quirky.editor/close', { bufferId: owned.bufferId, tabId: owned.tabId, choice: 'cancel' }, timeoutMs)
    }
  } catch (error) { failure ??= error }
  try {
    const state = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: owned.bufferId }, timeoutMs))
    const current = Array.isArray(state.buffers) ? state.buffers.map(record).find((entry) => entry.id === owned.bufferId) : undefined
    if (!current || typeof current.contentRevision !== 'number') throw new Error('owned editor buffer disappeared during cleanup')
    if (current.dirty === true) {
      await rpc(runtime.client, 'quirky.editor/draft', {
        bufferId: owned.bufferId, content: owned.originalContents, expectedRevision: current.contentRevision
      }, timeoutMs)
    }
  } catch (error) { failure ??= error }
  try {
    const state = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: owned.bufferId }, timeoutMs))
    const current = Array.isArray(state.buffers) ? state.buffers.map(record).find((entry) => entry.id === owned.bufferId) : undefined
    const tab = Array.isArray(state.tabs) ? state.tabs.map(record).find((entry) => entry.tabId === owned.tabId && entry.bufferId === owned.bufferId) : undefined
    const requests = Array.isArray(state.closeRequests) ? state.closeRequests.map(record) : []
    if (!current || !tab || current.dirty !== false || requests.some((request) => request.bufferId === owned.bufferId || request.tabId === owned.tabId)) {
      throw new Error('owned editor buffer, tab, or close request did not settle after cancellation')
    }
    await dialog.waitFor({ state: 'detached', timeout: timeoutMs })
    if (runtime.editorBuffer?.id === owned.bufferId && typeof current.contentRevision === 'number') {
      runtime.editorBuffer.contentRevision = current.contentRevision
    }
    runtime.dirtyCloseFixture = null
  } catch (error) { failure ??= error }
  if (failure) throw failure
}

async function openPanel(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  if (target.plugin === 'quirky.editor' || target.plugin === 'quirky.git') await openWorktreeContext(runtime)
  await rpc(runtime.client, 'ui.panel.open', { id: target.id }, runtime.options.timeoutMs, runtime.options.signal)
}

export async function ensureHandoffTerminalContext(
  runtime: Pick<CaptureRuntime, 'terminalFixture' | 'cellTerminalFixture' | 'options' | 'client'>
): Promise<void> {
  const terminal = runtime.cellTerminalFixture ?? runtime.terminalFixture
  if (!terminal) throw new Error('a terminal fixture is required to capture the Handoff dialog')
  const { timeoutMs, signal } = runtime.options
  const deadline = Date.now() + timeoutMs
  const readHistory = async () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const history = record(await rpc(runtime.client, 'quirky.terminal/history', {
      session: terminal.sessionId,
      lines: 100,
      format: 'text'
    }, Math.min(timeoutMs, remaining), signal))
    return Array.isArray(history.lines) && history.lines.some((line) => typeof line === 'string' && line.trim().length > 0)
  }
  const readSnapshot = async () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return {}
    return record(await rpc(runtime.client, 'quirky.terminal/snapshot', {
      session: terminal.sessionId
    }, Math.min(timeoutMs, remaining), signal))
  }
  const waitForNextPoll = async () => {
    const waitMs = Math.min(100, Math.max(1, deadline - Date.now()))
    await bounded(Bun.sleep(waitMs), waitMs, signal, 'wait for Handoff terminal output')
  }

  if (await readHistory()) return
  let snapshot: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    snapshot = await readSnapshot()
    if (snapshot.shellState === 'ready' || snapshot.shellState === 'unsupported') break
    if (snapshot.shellState === 'timed_out') throw new Error('terminal fixture shell timed out before Handoff context was captured')
    await waitForNextPoll()
  }
  if (snapshot.shellState !== 'ready' && snapshot.shellState !== 'unsupported') throw new Error('terminal fixture shell did not become ready for Handoff context')
  const rows = typeof snapshot.rows === 'number' && Number.isFinite(snapshot.rows) ? Math.max(1, Math.ceil(snapshot.rows)) : 24
  const lineCount = rows + 20
  await rpc(runtime.client, 'quirky.terminal/write', {
    session: terminal.sessionId,
    data: `printf '${'UI review handoff fixture\\n'.repeat(lineCount)}'\n`
  }, timeoutMs, signal)
  while (Date.now() < deadline) {
    if (await readHistory()) return
    await waitForNextPoll()
  }
  throw new Error('terminal fixture did not produce readable Handoff context')
}

async function openTarget(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  await closeCurrentSurface(runtime)
  switch (target.kind) {
    case 'host':
      if (target.id === 'host:settings') return await openSettings(runtime)
      if (target.id === 'host:palette') {
        await rpc(runtime.client, 'ui.palette.set', { open: true }, runtime.options.timeoutMs, runtime.options.signal)
        await runtime.page.getByRole('dialog', { name: 'Command palette', exact: true }).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
        return
      }
      if (target.id === 'host:shell') return await populateShell(runtime)
      if (target.id === 'host:scoped') {
        await populateShell(runtime)
        return await scopeToProject(runtime)
      }
      if (target.id === 'host:popups') {
        await populateShell(runtime)
        return await showPopupsTogether(runtime)
      }
      throw new Error(`unsupported host target ${target.id}`)
    case 'view': {
      const toolId = hostingToolFor(runtime.model, target)
      if (toolId !== null) {
        await rpc(runtime.client, 'ui.tool.open', { id: toolId }, runtime.options.timeoutMs, runtime.options.signal)
        return
      }
      if (target.id === 'view:quirky.accounts/session-accessory') {
        await openLocalWorktreeContext(runtime)
        await prepareAccountsStaleSession(runtime, 'codex')
      }
      const input = fixtureViewInput(runtime.fixtures, target, runtime.editorBuffer, runtime.terminalFixture, runtime.structuredSessionId, {
        transcript: runtime.transcriptFixture,
        loop: runtime.loopFixture,
        remote: runtime.remoteFixtures,
        cellTerminal: runtime.cellTerminalFixture,
        view: runtime.viewFixture,
        ask: runtime.cellAskFixture
      })
      if (target.id === 'view:quirky.browser/page') {
        const pane = record(await rpc(runtime.client, 'quirky.browser/paneOpen', {
          worktree: runtime.fixtures.primaryWorktree.id,
          url: 'http://localhost:5173',
          mode: 'native'
        }, runtime.options.timeoutMs, runtime.options.signal))
        if (typeof pane.id !== 'string' || pane.id.length === 0) throw new Error('quirky.browser/paneOpen did not return a pane ID')
        await rpc(runtime.client, 'ui.view.open', { id: target.id, input: { ...input, pane: pane.id } }, runtime.options.timeoutMs, runtime.options.signal)
      } else {
        await rpc(runtime.client, 'ui.view.open', { id: target.id, input }, runtime.options.timeoutMs, runtime.options.signal)
      }
      return
    }
    case 'panel':
      await openPanel(runtime, target)
      return
    case 'settings-section': {
      await openSettings(runtime)
      const section = runtime.page.getByRole('group', { name: target.title, exact: true })
      await section.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      await section.scrollIntoViewIfNeeded({ timeout: runtime.options.timeoutMs })
      return
    }
    case 'overlay':
      if (target.id === 'overlay:quirky.accounts/switch-dialog') {
        await openLocalWorktreeContext(runtime)
        await prepareAccountsStaleSession(runtime, 'claude')
        await waitForOverlay(
          runtime,
          runtime.page.locator('[data-plugin-overlay="overlay:quirky.accounts/switch-dialog"] [role="dialog"]'),
          'Accounts switch dialog'
        )
      } else if (target.id === 'overlay:quirky.session/chat-dialogs') {
        const trigger = namedOverlayTrigger('command:quirky.session/new-chat', rpc(runtime.client, 'ui.command.run', {
          id: 'command:quirky.session/new-chat',
          args: { workspace: runtime.fixtures.primaryWorktree.id }
        }, runtime.options.timeoutMs, runtime.options.signal))
        await waitForOverlay(runtime,
          runtime.page.locator('[data-plugin-overlay="overlay:quirky.session/chat-dialogs"]').getByRole('dialog', { name: 'New chat', exact: true }),
          'New chat', trigger)
      } else if (target.id === 'overlay:quirky.editor/quick-open') {
        await openWorktreeContext(runtime)
        const trigger = namedOverlayTrigger('command:quirky.editor/quick-open', rpc(
          runtime.client,
          'ui.command.run',
          { id: 'command:quirky.editor/quick-open' },
          runtime.options.timeoutMs,
          runtime.options.signal
        ))
        await waitForOverlay(runtime, runtime.page.locator('.qe-quick-open'), 'Editor quick-open', trigger)
        await runtime.page.getByRole('textbox', { name: 'Go to file', exact: true }).fill('app.ts', { timeout: runtime.options.timeoutMs })
        await runtime.page.getByRole('option').filter({ hasText: 'src/app.ts' }).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      } else if (target.id === 'overlay:quirky.editor/close') {
        await openUnsavedCloseOverlay(runtime)
      } else if (target.id === 'overlay:quirky.feedback/mode') {
        const trigger = namedOverlayTrigger('command:quirky.feedback/toggle', rpc(
          runtime.client,
          'ui.command.run',
          { id: 'command:quirky.feedback/toggle' },
          runtime.options.timeoutMs,
          runtime.options.signal
        ))
        await waitForOverlay(
          runtime,
          runtime.page.locator('[data-quirky-feedback]:not([data-feedback-banner])'),
          'Feedback mode',
          trigger
        )
      } else if (target.id === 'overlay:quirky.handoff/dialog') {
        await ensureHandoffTerminalContext(runtime)
        const terminal = runtime.cellTerminalFixture ?? runtime.terminalFixture
        if (!terminal) throw new Error('a terminal fixture is required to capture the Handoff dialog')
        const trigger = namedOverlayTrigger('command:quirky.handoff/open', rpc(runtime.client, 'ui.command.run', {
          id: 'command:quirky.handoff/open',
          args: { session: terminal.sessionId }
        }, runtime.options.timeoutMs, runtime.options.signal))
        await waitForOverlay(
          runtime,
          runtime.page.locator('[data-plugin-overlay="overlay:quirky.handoff/dialog"] [role="dialog"]'),
          'Handoff dialog',
          trigger
        )
      } else if (target.id === 'overlay:quirky.loops/dialogs') {
        const trigger = namedOverlayTrigger('command:quirky.loops/new', rpc(runtime.client, 'ui.command.run', {
          id: 'command:quirky.loops/new',
          args: { workspace: runtime.fixtures.primaryWorktree.id }
        }, runtime.options.timeoutMs, runtime.options.signal))
        const dialog = runtime.page.locator('[data-plugin-overlay="overlay:quirky.loops/dialogs"] [role="dialog"]')
        await waitForOverlay(runtime, dialog, 'Loops dialog', trigger)
        await dialog.getByLabel('Prompt', { exact: true }).fill('Review the current workspace and summarize the next useful task.')
        await dialog.getByText('Enter a prompt to start the loop.', { exact: true })
          .waitFor({ state: 'detached', timeout: runtime.options.timeoutMs })
      } else if (target.id === 'overlay:quirky.orchestration/floating-setup') {
        const trigger = namedOverlayTrigger('quirky.terminal/setFloating', rpc(
          runtime.client,
          'quirky.terminal/setFloating',
          { open: true },
          runtime.options.timeoutMs,
          runtime.options.signal
        ))
        await waitForOverlay(
          runtime,
          runtime.page.locator('[data-plugin-overlay="overlay:quirky.orchestration/floating-setup"]')
            .locator('aside[aria-label="Enable orchestration"]'),
          'Orchestration setup',
          trigger
        )
      } else if (target.id === 'overlay:quirky.tasks/workspace-composer') {
        const trigger = namedOverlayTrigger('quirky.tasks/workspace', rpc(runtime.client, 'quirky.tasks/workspace', {
          target: {
            worktree: runtime.fixtures.primaryWorktree.id,
            kind: 'issue',
            number: runtime.fixtures.tasks.issue.number
          },
          action: 'start'
        }, runtime.options.timeoutMs, runtime.options.signal))
        await waitForOverlay(runtime, runtime.page.locator('.tasks-composer'), 'Tasks workspace composer', trigger)
      } else if (target.id === 'overlay:quirky.terminal/floating') {
        const trigger = namedOverlayTrigger('quirky.terminal/setFloating', rpc(
          runtime.client,
          'quirky.terminal/setFloating',
          { open: true },
          runtime.options.timeoutMs,
          runtime.options.signal
        ))
        await waitForOverlay(runtime, runtime.page.locator('[data-floating-panel]'), 'Terminal floating panel', trigger)
      }
      return
    case 'sidebar-section':
    case 'activity-item':
    case 'status-bar':
      if (target.id === 'status-bar:quirky.reviews/checks') {
        const worktree = runtime.fixtures.worktrees.find((entry) =>
          entry.repoId === runtime.fixtures.repo.id && entry.name === CHECKS_FIXTURE_BRANCH)
        if (!worktree) throw new Error('the Reviews checks fixture worktree is unavailable')
        await openLocalWorktreeContext(runtime, worktree)
        const refreshed = record(await rpc(runtime.client, 'quirky.reviews/checksRefresh',
          { worktree: worktree.id, force: true }, runtime.options.timeoutMs, runtime.options.signal))
        if (refreshed.ok !== true) throw new Error(`Reviews checks fixture refresh failed: ${String(refreshed.error ?? refreshed.kind ?? 'unknown')}`)
      } else if (target.id === 'status-bar:quirky.git/ahead-behind') {
        await openLocalWorktreeContext(runtime)
      } else if (target.plugin === 'quirky.editor' || target.plugin === 'quirky.git') {
        await openWorktreeContext(runtime)
      }
      await openSurfaceTool(runtime, target)
      return
  }
}

/**
 * Resolves independently mounted stripe/sidebar targets and canonical view bodies to their production tools.
 * Ordinary views and always-visible surfaces need no tool.
 */
export function hostingToolFor(model: UiModel, target: CaptureTarget): string | null {
  if (target.kind === 'view') {
    const hasSidebarAlias = model.tools?.some((tool) => tool.contributionId === target.id &&
      model.sidebarSections.some((entry) => tool.id === entry.id || tool.aliases.includes(entry.id)))
    if (!hasSidebarAlias) return null
    return projectCaptureInventory(model).contributionInventory.toolAliases
      .find((alias) => alias.renderedTarget.id === target.id)?.toolId ?? null
  }
  if (target.kind !== 'sidebar-section' && target.kind !== 'activity-item') return null
  const tool = findHostingTool(model, target)
  return tool.id
}

function findHostingTool(model: Pick<UiModel, 'tools'>, target: CaptureTarget): UiToolEntry {
  const tool = model.tools?.find((candidate) => candidate.contributionId === target.id || candidate.id === target.id || candidate.aliases.includes(target.id))
  if (!tool) throw new Error(`no tool hosts ${target.id}`)
  return tool
}

/** Opens a target's production tool without redirecting non-mounted sidebar declarations to another body. */
export async function openSurfaceTool(runtime: Pick<CaptureRuntime, 'client' | 'model' | 'options'>, target: CaptureTarget): Promise<void> {
  const id = hostingToolFor(runtime.model, target)
  if (id === null) return
  const tool = findHostingTool(runtime.model, target)
  if (target.kind === 'sidebar-section' && tool.contributionId !== target.id) {
    throw new Error(`${target.id} is not shown by its tool ${tool.id}, which shows ${tool.contributionId ?? 'the host Inbox'} instead`)
  }
  await rpc(runtime.client, 'ui.tool.open', { id }, runtime.options.timeoutMs, runtime.options.signal)
}

export async function waitForStateShown(runtime: Pick<CaptureRuntime, 'client' | 'options'>, target: CaptureTarget, toolId?: string | null): Promise<void> {
  if (target.kind === 'host' || target.kind === 'settings-section' || target.kind === 'overlay') return
  const deadline = Date.now() + runtime.options.timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(runtime.options.signal)
    const state = record(await rpc(runtime.client, 'ui.state', {}, runtime.options.timeoutMs, runtime.options.signal))
    const slots = Array.isArray(state.slots) ? state.slots : []
    const slot = slots.map(record).find((entry) => entry.id === target.id)
    const open = record(record(record(state.layout).tools).open)
    if (slot?.shown === true && (!toolId || Object.values(open).includes(toolId))) return
    await Bun.sleep(75)
  }
  throw new Error(`public UI state did not show ${target.id}${toolId ? ` in tool ${toolId}` : ''}`)
}

/** True when the open Command palette dialog contains its search field. */
export async function paletteFieldMounted(page: Page): Promise<boolean> {
  return await page.getByRole('dialog', { name: 'Command palette', exact: true })
    .getByRole('textbox', { name: PALETTE_SEARCH_LABEL, exact: true }).count() > 0
}

export function contentReadiness(arg: ReadinessArg): boolean {
  const addLongTasks = (entry: ReadinessPhaseEntry, records: PerformanceEntry[]) => {
    const stats = entry.trace.longTasks
    if (!stats) return
    for (const record of records) {
      stats.count += 1
      stats.totalMs += record.duration
      stats.maxMs = Math.max(stats.maxMs, record.duration)
    }
  }
  const flushAndDisconnect = (entry: ReadinessPhaseEntry): boolean => {
    const observer = entry.observer
    if (!observer) return true
    try { addLongTasks(entry, observer.takeRecords()) } catch {}
    try {
      observer.disconnect()
      entry.observer = null
      return true
    } catch {
      return false
    }
  }

  let phaseEntry: ReadinessPhaseEntry | null = null
  const phase = arg.phase
  if (phase) {
    const pageGlobal = globalThis as ReadinessPageGlobal
    const store = pageGlobal.__quirkyCaptureReadiness ?? {
      phases: Object.create(null) as Record<string, ReadinessPhaseEntry>
    }
    pageGlobal.__quirkyCaptureReadiness = store
    const known = store.phases[phase.token]
    if (known?.state === 'closed') return false
    if (known) {
      phaseEntry = known
    } else {
      const trace: ReadinessTrace = {
        token: phase.token,
        sequence: phase.sequence,
        targetId: arg.targetId,
        startedAt: phase.startedAt,
        polls: 0,
        firstPollAt: null,
        lastPollAt: null,
        maxGapMs: null,
        maxPollMs: 0,
        totalPollMs: 0,
        readyAt: null,
        lastFailed: null,
        longTaskObserver: false,
        longTasks: null
      }
      const superseded = Object.values(store.phases).some((entry) => entry.sequence > phase.sequence)
      phaseEntry = {
        state: superseded ? 'closed' : 'open',
        sequence: phase.sequence,
        closedBy: superseded ? 'superseded' : null,
        trace,
        observer: null
      }
      store.phases[phase.token] = phaseEntry
      if (superseded) return false

      for (const previous of Object.values(store.phases)) {
        if (previous === phaseEntry || previous.sequence >= phase.sequence || previous.state === 'closed') continue
        flushAndDisconnect(previous)
        previous.state = 'closed'
        previous.closedBy = 'successor'
      }

      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        let observer: PerformanceObserver | null = null
        try {
          observer = new PerformanceObserver((list) => {
            if (phaseEntry?.state === 'open') addLongTasks(phaseEntry, list.getEntries())
          })
          observer.observe({ entryTypes: ['longtask'] })
          phaseEntry.observer = observer
          phaseEntry.trace.longTaskObserver = true
          phaseEntry.trace.longTasks = { count: 0, totalMs: 0, maxMs: 0 }
        } catch {
          if (observer) {
            try {
              observer.disconnect()
            } catch {
              phaseEntry.observer = observer
            }
          }
          phaseEntry.trace.longTaskObserver = false
          phaseEntry.trace.longTasks = null
        }
      }
    }
    if (phaseEntry.state !== 'open') return false
  }

  const pollStarted = phaseEntry ? performance.now() : 0
  const pollAt = phaseEntry ? Date.now() - phaseEntry.trace.startedAt : 0
  if (phaseEntry) {
    const trace = phaseEntry.trace
    if (trace.firstPollAt === null) trace.firstPollAt = pollAt
    if (trace.lastPollAt !== null) trace.maxGapMs = Math.max(trace.maxGapMs ?? 0, pollAt - trace.lastPollAt)
    trace.lastPollAt = pollAt
    trace.polls += 1
  }

  let failedClause: ReadinessClause | null = null
  const fail = (clause: ReadinessClause): false => {
    failedClause = clause
    return false
  }
  const admitted = (() => {
    const node = document.querySelector(arg.slotSelector)
    if (!node) return fail('unmounted')
    const body = node.classList.contains('plugin-slot') ? node.querySelector('.plugin-slot-body') : node
    const element = body ?? node
    const visible = (child: Element | null): child is Element => {
      if (!child) return false
      const style = getComputedStyle(child)
      const rect = child.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const ownVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    const visibleChild = [...element.querySelectorAll('*')].some((child) => {
      const childStyle = getComputedStyle(child)
      const childRect = child.getBoundingClientRect()
      return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && childRect.width > 0 && childRect.height > 0
    })
    if (!ownVisible && !visibleChild) return fail('hidden')
    if (node.querySelector('[aria-busy="true"], [role="progressbar"]')) return fail('busy')
    const loadingLeaf = [...element.querySelectorAll('*')].some((child) => {
      if (child.children.length > 0 || !/^loading(?:\b|…)/i.test((child.textContent ?? '').trim())) return false
      const childStyle = getComputedStyle(child)
      const childRect = child.getBoundingClientRect()
      return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && childRect.width > 0 && childRect.height > 0
    })
    if (loadingLeaf) return fail('loading-leaf')
    if (node.querySelector('[role="alert"], .plugin-slot-error')) return true
    const text = (element.textContent ?? '').trim()
    if (/^loading\b/i.test(text)) return fail('loading-text')
    if (arg.targetId === 'view:quirky.ask/card') {
      const cards = [...element.querySelectorAll('[data-approval-card]')].filter(visible)
      const card = cards[0]
      if (!arg.ask || cards.length !== 1 || card?.getAttribute('data-approval-card') !== arg.ask.askId ||
        card.querySelector('[data-approval-command]')?.textContent?.trim() !== arg.ask.command) return fail('ask-card')
      return ['Allow once', 'Allow for this session', 'Deny'].every((label) =>
        [...card.querySelectorAll<HTMLButtonElement>('button')].some((button) =>
          button.textContent?.trim() === label && !button.disabled && visible(button)))
        || fail('ask-card')
    }
    if (arg.targetId === 'overlay:quirky.session/chat-dialogs') {
      const dialog = element.querySelector('[role="dialog"]')
      const group = dialog?.querySelector('[role="group"][aria-label="Agents"]')
      const buttons = group ? [...group.querySelectorAll<HTMLButtonElement>('button')] : []
      const ready = visible(dialog ?? null) && visible(group ?? null) && buttons.length === 4 &&
        buttons.every((button) => visible(button) && (!button.disabled ||
          Boolean(button.title.trim() && button.querySelector('span')?.textContent?.trim())))
      return ready || fail('chat-agents')
    }
    if (arg.targetId === 'overlay:quirky.editor/quick-open') {
      const input = element.querySelector<HTMLInputElement>('input[aria-label="Go to file"]')
      const ready = input?.value === 'app.ts' && !/Searching files|Opening file/.test(text) &&
        [...element.querySelectorAll<HTMLButtonElement>('[role="option"]')].some((option) =>
          !option.disabled && visible(option) && option.querySelector('small')?.textContent?.trim() === 'src/app.ts')
      return ready || fail('quick-open')
    }
    if (arg.targetId === 'view:quirky.session/worktree') {
      if (!arg.terminal) return fail('terminal-pane')
      const pane = [...element.querySelectorAll('.qt-pane')].find((candidate) =>
        candidate.getAttribute('data-session') === arg.terminal!.sessionId &&
        candidate.getAttribute('data-pane') === arg.terminal!.paneId)
      const ready = visible(pane ?? null) && visible(pane?.querySelector('.terminal-pane-screen .xterm-screen') ?? null) &&
        !pane?.querySelector('[data-terminal-connection-state], [role="alert"], [aria-busy="true"], [role="progressbar"]')
      return ready || fail('terminal-pane')
    }
    if (arg.targetId === 'view:quirky.git/diff') {
      const reviewed = element.querySelector('section[data-path="src/app.ts"]')
      const expanded = [...element.querySelectorAll<HTMLElement>('[data-review-body]')].filter((reviewBody) => !reviewBody.hidden)
      const textRange = document.createRange()
      const renderedText = (line: HTMLElement) => {
        const parts: string[] = []
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let textNode = walker.nextNode(); textNode !== null; textNode = walker.nextNode()) {
          const parent = textNode.parentElement
          if (!visible(parent) || !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
          textRange.selectNodeContents(textNode)
          const textRect = textRange.getBoundingClientRect()
          if (textRect.width > 0 && textRect.height > 0) parts.push(textNode.textContent ?? '')
        }
        return parts.join('')
      }
      const diffs = expanded.map((reviewBody) => ({
        body: reviewBody,
        path: reviewBody.closest('section[data-path]')?.getAttribute('data-path'),
        code: [...reviewBody.querySelectorAll<HTMLElement>('.cm-editor .cm-content')]
          .filter((content) => visible(content.closest('.cm-editor')) && visible(content) &&
            content.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          .flatMap((content) => [...content.querySelectorAll<HTMLElement>('.cm-line')])
          .filter((line) => visible(line) && line.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          .map(renderedText).join('\n').trim()
      }))
      const local = diffs.find((diff) => diff.path === 'src/local-review-fixture.ts')
      const since = diffs.find((diff) => diff.path === 'src/review-note.ts')?.body.querySelector<HTMLElement>('.git-review__since')
      if (!visible(reviewed?.querySelector('header') ?? null)) return fail('git-reviewed-header')
      if (reviewed?.querySelector<HTMLElement>('[data-review-body]')?.hidden !== true) return fail('git-reviewed-collapsed')
      if (expanded.length !== 2) return fail('git-expanded-count')
      if (!diffs.every((diff) => visible(diff.body) && diff.code.length > 0)) return fail('git-code')
      if (local?.code.includes('export const localReviewFixture = true') !== true) return fail('git-local-fixture')
      if (!visible(since ?? null) || since?.innerText.includes('Showing changes since you reviewed') !== true) {
        return fail('git-since-notice')
      }
      return true
    }
    return text.length > 0 || visibleChild || fail('empty')
  })()

  if (phaseEntry) {
    const trace = phaseEntry.trace
    const elapsed = performance.now() - pollStarted
    trace.maxPollMs = Math.max(trace.maxPollMs, elapsed)
    trace.totalPollMs += elapsed
    if (failedClause) trace.lastFailed = failedClause
    if (admitted) trace.readyAt = Date.now() - trace.startedAt
  }
  return admitted
}

export function closeReadinessPhase(token: string): (ReadinessTrace & { observerDisconnected: boolean }) | null {
  const pageGlobal = globalThis as ReadinessPageGlobal
  const store = pageGlobal.__quirkyCaptureReadiness ?? {
    phases: Object.create(null) as Record<string, ReadinessPhaseEntry>
  }
  pageGlobal.__quirkyCaptureReadiness = store
  let entry = store.phases[token]
  if (!entry) {
    entry = {
      state: 'closed',
      sequence: 0,
      closedBy: 'host',
      observer: null,
      trace: {
        token,
        sequence: 0,
        targetId: '',
        startedAt: Date.now(),
        polls: 0,
        firstPollAt: null,
        lastPollAt: null,
        maxGapMs: null,
        maxPollMs: 0,
        totalPollMs: 0,
        readyAt: null,
        lastFailed: null,
        longTaskObserver: false,
        longTasks: null
      }
    }
    store.phases[token] = entry
  }
  if (entry.state === 'open') {
    entry.state = 'closed'
    entry.closedBy = 'host'
  }
  let observerDisconnected = true
  const observer = entry.observer
  if (observer) {
    try {
      const stats = entry.trace.longTasks
      if (stats) {
        for (const record of observer.takeRecords()) {
          stats.count += 1
          stats.totalMs += record.duration
          stats.maxMs = Math.max(stats.maxMs, record.duration)
        }
      }
    } catch {}
    try {
      observer.disconnect()
      entry.observer = null
    } catch {
      observerDisconnected = false
    }
  }
  return { ...entry.trace, observerDisconnected }
}

export function readinessTimingFromError(message: string): ReadinessTiming | null {
  const marker = '; timing='
  const markerAt = message.indexOf(marker)
  if (markerAt < 0) return null
  const start = markerAt + marker.length
  if (message[start] !== '{') return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < message.length; index += 1) {
    const character = message[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(message.slice(start, index + 1))
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as ReadinessTiming
          }
        } catch {}
        return null
      }
    }
  }
  return null
}

/** Redacts free text without letting credential patterns consume structured timing delimiters. */
function sanitizedCaptureError(error: unknown, secrets: string[]): string {
  const message = errorMessage(error)
  const timing = readinessTimingFromError(message)
  if (!timing) return sanitizedError(error, secrets)
  const marker = '; timing='
  const timingAt = message.indexOf(marker)
  const originalTiming = JSON.stringify(timing)
  const prefix = sanitizedError(message.slice(0, timingAt), secrets)
  const suffix = sanitizedError(message.slice(timingAt + marker.length + originalTiming.length), secrets)
  const redactedTiming = JSON.stringify(timing, (key, value: unknown) => {
    if (typeof value !== 'string') return value
    const redacted = sanitizedError(value, secrets)
    return key === 'cleanup' ? redacted.slice(0, 'unproved: '.length + 160) : redacted
  })
  return `${prefix}${marker}${redactedTiming}${suffix}`.slice(0, 2_000)
}

function readinessTraceFrom(value: unknown, phase: ReadinessPhase, targetId: string): ReadinessTrace | null {
  const candidate = record(value)
  if (candidate.token !== phase.token || candidate.sequence !== phase.sequence || candidate.targetId !== targetId ||
    typeof candidate.startedAt !== 'number' || typeof candidate.polls !== 'number' ||
    typeof candidate.maxPollMs !== 'number' || typeof candidate.totalPollMs !== 'number' ||
    typeof candidate.longTaskObserver !== 'boolean') return null
  return value as ReadinessTrace
}

function timingForReadiness(
  phase: ReadinessPhase,
  deadlineMs: number,
  budgetMs: number,
  phaseOffsetMs: number,
  trace: ReadinessTrace | null,
  hostRejectedMs: number | null,
  diagnosticLatencyMs: number | null,
  hostMaxLagMs: number,
  lateReady: boolean | null,
  cleanup: ReadinessTiming['cleanup']
): ReadinessTiming {
  return {
    sequence: phase.sequence,
    deadlineMs,
    budgetMs,
    phaseOffsetMs,
    readyMs: trace?.readyAt ?? null,
    hostRejectedMs,
    diagnosticLatencyMs,
    hostMaxLagMs,
    polls: trace?.polls ?? null,
    firstPollMs: trace?.firstPollAt ?? null,
    lastPollMs: trace?.lastPollAt ?? null,
    maxGapMs: trace?.maxGapMs ?? null,
    maxPollMs: trace?.maxPollMs ?? null,
    totalPollMs: trace?.totalPollMs ?? null,
    longTaskObserver: trace?.longTaskObserver ?? null,
    longTaskCoverageFromMs: trace && trace.longTaskObserver ? trace.firstPollAt : null,
    longTasks: trace?.longTasks ?? null,
    lastFailed: trace?.lastFailed ?? null,
    lateReady,
    cleanup
  }
}

/** Admits only the live mounted content required by a production screenshot cell. */
export async function inspectSurface(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  runtime.lastReadiness = undefined
  const aliases = runtime.manifest.contributionInventory?.toolAliases.filter((alias) => alias.renderedTarget.id === target.id) ?? []
  const toolId = aliases[0]?.toolId ?? (target.kind === 'sidebar-section' ? hostingToolFor(runtime.model, target) : null)
  await waitForStateShown(runtime, target, toolId)
  if (target.id === 'view:quirky.browser/page') {
    await Promise.all([
      bounded(runtime.page.locator('.qbp-toolbar').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'browser toolbar'),
      bounded(runtime.page.locator('.qbp-page').getByText('Native browsing is unavailable here', { exact: true })
        .waitFor({ state: 'visible', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'settled browser pane')
    ])
  }
  if (target.kind === 'host') {
    const element = SHELL_TARGETS.has(target.id)
      ? runtime.page.locator('.shell-workspace')
      : runtime.page.getByRole('dialog', { name: target.title, exact: true })
    await element.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
    const details = await element.evaluate((node) => ({
      text: (node.textContent ?? '').trim(),
      rect: node.getBoundingClientRect().toJSON(),
      visible: getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none'
    }))
    if (!details.visible || details.rect.width <= 0 || details.rect.height <= 0) throw new Error(`${target.id} is hidden or has zero size`)
    if (!SHELL_TARGETS.has(target.id) && details.text.length === 0) throw new Error(`${target.id} is empty`)
    if (target.id === 'host:palette' && !await paletteFieldMounted(runtime.page)) {
      throw new Error('host palette did not mount its command filter')
    }
    return
  }
  const selector = targetSlotSelector(target)
  const mountSelector = target.id === 'overlay:quirky.feedback/mode'
    ? `${selector}:not([data-feedback-banner])`
    : selector
  const root = runtime.page.locator(mountSelector)

  await bounded(root.waitFor({ state: 'attached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, `slot ${target.id} mount`)
  if (await root.count() !== 1) throw new Error(`slot ${target.id} did not mount in the renderer DOM`)
  if (toolId !== null) {
    const actualTool = await root.evaluate((node) => node.closest('[data-tool-panel]')?.getAttribute('data-tool-panel') ?? null)
    if (actualTool !== toolId) throw new Error(`slot ${target.id} is not inside tool ${toolId}`)
    for (const alias of aliases) {
      if (await runtime.page.locator(targetSlotSelector(alias.declaration)).count() !== 0) {
        throw new Error(`non-mounted alias ${alias.declaration.id} appeared in the renderer DOM`)
      }
    }
  }
  const readinessTimeout = Math.min(target.kind === 'overlay' ? 1_500 : 10_000, runtime.options.timeoutMs)
  const contentStarted = Date.now()
  const terminal = target.id === 'view:quirky.session/worktree' ? runtime.cellTerminalFixture : null
  if (terminal) {
    let report: Record<string, unknown> = {}
    while (Date.now() - contentStarted < readinessTimeout) {
      const remaining = readinessTimeout - (Date.now() - contentStarted)
      const state = record(await rpc(runtime.client, 'ui.state', {}, Math.max(1, remaining), runtime.options.signal))
      const slots = Array.isArray(state.slots) ? state.slots.map(record) : []
      report = record(slots.find((slot) => slot.id === target.id)?.report)
      if (report.worktree === runtime.cellTerminalWorktreeId && report.active === terminal.sessionId &&
        report.focusedPane === terminal.paneId && Array.isArray(report.visibleSessions) &&
        report.visibleSessions.includes(terminal.sessionId) && Array.isArray(report.panes) &&
        report.panes.map(record).some((pane) => pane.pane === terminal.paneId && pane.session === terminal.sessionId)) break
      await bounded(Bun.sleep(Math.min(50, Math.max(1, remaining))), Math.max(1, remaining), runtime.options.signal, 'terminal slot report')
    }
    if (report.worktree !== runtime.cellTerminalWorktreeId || report.active !== terminal.sessionId ||
      report.focusedPane !== terminal.paneId || !Array.isArray(report.visibleSessions) || !report.visibleSessions.includes(terminal.sessionId) ||
      !Array.isArray(report.panes) || !report.panes.map(record).some((pane) => pane.pane === terminal.paneId && pane.session === terminal.sessionId)) {
      throw new Error(`terminal slot report did not identify requested worktree/session/pane ${JSON.stringify({
        worktree: runtime.cellTerminalWorktreeId, ...terminal, report, elapsedMs: Date.now() - contentStarted
      })}`)
    }
  }
  const remainingContentMs = Math.max(1, readinessTimeout - (Date.now() - contentStarted))
  const budgetMs = remainingContentMs
  const sequence = ++readinessSequence
  const token = randomUUID()
  let hostMaxLagMs = 0
  let nextHostLagAt = Date.now() + 100
  const hostLagInterval = setInterval(() => {
    const now = Date.now()
    hostMaxLagMs = Math.max(hostMaxLagMs, now - nextHostLagAt)
    nextHostLagAt = now + 100
  }, 100)
  const startedAt = Date.now()
  nextHostLagAt = startedAt + 100
  const phase: ReadinessPhase = { token, sequence, startedAt }
  const arg: ReadinessArg = {
    slotSelector: mountSelector,
    targetId: target.id,
    ask: runtime.cellAskFixture,
    terminal,
    phase
  }
  try {
    try {
      throwIfAborted(runtime.options.signal)
      await bounded(runtime.page.waitForFunction(contentReadiness, arg, { timeout: budgetMs }),
        budgetMs, runtime.options.signal, `slot ${target.id} content`)
    } catch (error) {
      if (runtime.options.signal?.aborted) throw abortError(runtime.options.signal)
      const message = errorMessage(error)
      const timeout = /content exceeded \d+ms/.test(message) || /Timeout.*exceeded/i.test(message)
      if (!timeout) {
        if (!runtime.options.signal?.aborted) {
          try {
            await bounded(runtime.page.evaluate(closeReadinessPhase, phase.token), 1_000,
              runtime.options.signal, `slot ${target.id} readiness close`)
          } catch {}
        }
        throw error
      }

      const timeoutMessage = `slot ${target.id} content exceeded ${readinessTimeout}ms`
      const hostRejectedMs = Date.now() - startedAt
      let diagnosticLatencyMs: number | null = null
      let diagnosticFailure: string | null = null
      let details: { text: string; busy: boolean; nodes?: unknown[] } | null = null
      let trace: ReadinessTrace | null = null
      let cleanup: ReadinessTiming['cleanup'] = 'unproved: timeout diagnostics did not answer'
      if (!runtime.options.signal?.aborted) {
        const diagnosticStartedAt = Date.now()
        try {
          const responseValue = await bounded(root.evaluate((node, args: {
            targetId: string
            phase: ReadinessPhase
            token: string
          }) => {
            let details: {
              text: string
              busy: boolean
              nodes: Array<{
                tag: string
                class: string
                text: string | undefined
                rect: unknown
                display: string
                visibility: string
                ancestors: Array<{ tag: string; hidden: boolean; display: string; rect: unknown }>
              }>
            } | null = null
            let diagnosticReason: string | null = null
            try {
              const body = node.classList.contains('plugin-slot') ? node.querySelector('.plugin-slot-body') : node
              const element = body ?? node
              details = {
                text: (element.textContent ?? '').trim(),
                busy: node.querySelector('[aria-busy="true"], [role="progressbar"]') !== null,
                nodes: [...element.querySelectorAll('*')].filter((child) =>
                  child.matches('[aria-busy="true"], [role="progressbar"], [role="alert"], [data-terminal-connection-state], [data-review-body], [data-approval-card], [role="option"], .cm-content') ||
                  (child.children.length === 0 && /^(loading|searching|connecting)\b/i.test(child.textContent?.trim() ?? ''))
                ).slice(0, 8).map((child) => ({
                  tag: child.tagName,
                  class: child.className,
                  text: child.textContent?.trim().slice(0, 120),
                  rect: child.getBoundingClientRect().toJSON(),
                  display: getComputedStyle(child).display,
                  visibility: getComputedStyle(child).visibility,
                  ancestors: [child.parentElement, child.parentElement?.parentElement]
                    .filter((parent) => parent !== null && parent !== undefined)
                    .map((parent) => ({
                      tag: parent.tagName,
                      hidden: parent.hidden,
                      display: getComputedStyle(parent).display,
                      rect: parent.getBoundingClientRect().toJSON()
                    }))
                }))
              }
            } catch (error) {
              diagnosticReason = error instanceof Error ? error.message : String(error)
            }

            const pageGlobal = globalThis as ReadinessPageGlobal
            const store = pageGlobal.__quirkyCaptureReadiness ?? {
              phases: Object.create(null) as Record<string, ReadinessPhaseEntry>
            }
            pageGlobal.__quirkyCaptureReadiness = store
            let entry = store.phases[args.token]
            if (!entry) {
              const trace: ReadinessTrace = {
                token: args.token,
                sequence: args.phase.sequence,
                targetId: args.targetId,
                startedAt: args.phase.startedAt,
                polls: 0,
                firstPollAt: null,
                lastPollAt: null,
                maxGapMs: null,
                maxPollMs: 0,
                totalPollMs: 0,
                readyAt: null,
                lastFailed: null,
                longTaskObserver: false,
                longTasks: null
              }
              entry = {
                state: 'closed',
                sequence: args.phase.sequence,
                closedBy: 'host',
                trace,
                observer: null
              }
              store.phases[args.token] = entry
            }
            if (entry.state === 'open') {
              entry.state = 'closed'
              entry.closedBy = 'host'
            }
            let observerDisconnected = true
            const observer = entry.observer
            if (observer) {
              try {
                const stats = entry.trace.longTasks
                if (stats) {
                  for (const task of observer.takeRecords()) {
                    stats.count += 1
                    stats.totalMs += task.duration
                    stats.maxMs = Math.max(stats.maxMs, task.duration)
                  }
                }
              } catch {}
              try {
                observer.disconnect()
                entry.observer = null
              } catch {
                observerDisconnected = false
              }
            }
            return { details, diagnosticReason, trace: entry.trace, observerDisconnected }
          }, { targetId: target.id, phase, token }), 5_000, runtime.options.signal, `slot ${target.id} timeout diagnostics`)
          diagnosticLatencyMs = Date.now() - diagnosticStartedAt
          const response = record(responseValue)
          const detailsValue = Object.hasOwn(response, 'details') ? response.details : responseValue
          const candidateDetails = record(detailsValue)
          if (typeof candidateDetails.text === 'string' && typeof candidateDetails.busy === 'boolean') {
            details = {
              text: candidateDetails.text,
              busy: candidateDetails.busy,
              ...(Array.isArray(candidateDetails.nodes) ? { nodes: candidateDetails.nodes } : {})
            }
          }
          if (typeof response.diagnosticReason === 'string') diagnosticFailure = response.diagnosticReason.slice(0, 160)
          else if (!details) diagnosticFailure = 'slot diagnostic details were unavailable'
          trace = readinessTraceFrom(
            Object.hasOwn(response, 'trace') ? response.trace : responseValue,
            phase,
            target.id
          )
          cleanup = response.observerDisconnected === true
            ? 'proved'
            : 'unproved: observer disconnect was not confirmed'
        } catch (diagnosticError) {
          diagnosticLatencyMs = Date.now() - diagnosticStartedAt
          diagnosticFailure = errorMessage(diagnosticError).slice(0, 160)
          cleanup = `unproved: ${diagnosticFailure}`
        }
      } else {
        diagnosticFailure = 'capture was aborted before diagnostics'
        cleanup = `unproved: ${diagnosticFailure}`
      }

      let lateReady: boolean | null = null
      if (!runtime.options.signal?.aborted) {
        try {
          const lateResult = await bounded(runtime.page.evaluate(contentReadiness, {
            ...arg,
            phase: null
          }), 2_000, runtime.options.signal, `slot ${target.id} late readiness check`)
          lateReady = lateResult === true
        } catch {
          lateReady = null
        }
      }
      const timing = timingForReadiness(
        phase,
        readinessTimeout,
        budgetMs,
        startedAt - contentStarted,
        trace,
        hostRejectedMs,
        diagnosticLatencyMs,
        hostMaxLagMs,
        lateReady,
        cleanup
      )
      const serializedTiming = JSON.stringify(timing)
      if (!details || diagnosticFailure) {
        const reason = (diagnosticFailure ?? 'slot diagnostic details were unavailable').slice(0, 160)
        throw new Error(`${timeoutMessage} (diagnostics unavailable: ${reason}); timing=${serializedTiming}`)
      }
      const requirement = target.id === 'view:quirky.ask/card' ? 'Ask card approval card (owned ID, command, enabled approval controls)' :
        target.id === 'view:quirky.session/worktree' ? 'requested attached terminal surface' :
        target.id === 'view:quirky.git/diff' ? 'reviewed header and visible code in both expanded fixture diffs' :
        target.id === 'overlay:quirky.editor/quick-open' ? 'current src/app.ts quick-open result' :
        target.id === 'overlay:quirky.session/chat-dialogs' ? 'New chat Agents group with four choices' : ''
      const nodes = Array.isArray(details.nodes) ? details.nodes : []
      throw new Error(`${timeoutMessage} (busy: ${details.busy}, text: ${JSON.stringify(details.text.slice(0, 120))}); timing=${serializedTiming}${requirement ? `; ${requirement}; phase=content; elapsed=${Date.now() - contentStarted}ms; nodes=${JSON.stringify(nodes)}` : ''}`)
    }

    let trace: ReadinessTrace | null = null
    let cleanup: ReadinessTiming['cleanup'] = 'unproved: observer disconnect was not confirmed'
    try {
      if (runtime.options.signal?.aborted) throw abortError(runtime.options.signal)
      const closeValue = await bounded(runtime.page.evaluate(closeReadinessPhase, phase.token), 1_000,
        runtime.options.signal, `slot ${target.id} readiness close`)
      if (runtime.options.signal?.aborted) throw abortError(runtime.options.signal)
      trace = readinessTraceFrom(closeValue, phase, target.id)
      if (record(closeValue).observerDisconnected === true) cleanup = 'proved'
    } catch (closeError) {
      if (runtime.options.signal?.aborted) throw abortError(runtime.options.signal)
      cleanup = `unproved: ${errorMessage(closeError).slice(0, 160)}`
    }
    if (runtime.options.signal?.aborted) throw abortError(runtime.options.signal)
    runtime.lastReadiness = {
      targetId: target.id,
      sequence,
      timing: timingForReadiness(
        phase,
        readinessTimeout,
        budgetMs,
        startedAt - contentStarted,
        trace,
        null,
        null,
        hostMaxLagMs,
        null,
        cleanup
      )
    }
  } finally {
    clearInterval(hostLagInterval)
  }
  const details = await root.evaluate((node) => {
    const body = node.classList.contains('plugin-slot') ? node.querySelector('.plugin-slot-body') : node
    const element = body ?? node
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const children = [...element.querySelectorAll('*')]
    const visibleChild = children.some((child) => {
      const childStyle = getComputedStyle(child)
      const childRect = child.getBoundingClientRect()
      return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && childRect.width > 0 && childRect.height > 0
    })
    return {
      text: (element.textContent ?? '').trim(),
      error: node.querySelector('[role=\"alert\"], .plugin-slot-error')?.textContent?.trim() ?? '',
      busy: node.querySelector('[aria-busy=\"true\"], [role=\"progressbar\"]') !== null,
      visible: (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) || visibleChild,
      content: (element.textContent ?? '').trim().length > 0 || visibleChild
    }
  })
  if (details.error) throw new Error(`${target.id === 'view:quirky.ask/card' ? 'Ask card approval card' : `slot ${target.id}`} reported an error: ${details.error}`)
  if (!details.visible) throw new Error(`slot ${target.id} is hidden or has zero size`)
  if (!details.content) throw new Error(`slot ${target.id} is empty`)
  if (details.busy || /^loading\b/i.test(details.text)) throw new Error(`slot ${target.id} is still loading`)
  if (target.id === 'view:quirky.orchestration/remote-worker-output') {
    await bounded(runtime.page.waitForFunction((readoutSelector) =>
      document.querySelector(readoutSelector)?.textContent?.includes('Ready.') === true,
    `${selector} pre.ui-readout`, { timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'remote worker output readiness')
  }
  if (target.id === 'view:quirky.worktree/remote' &&
    (!details.text.includes('Connected') || !details.text.includes('Branch') || !details.text.includes('remote-review'))) {
    throw new Error('remote workspace did not show Connected and the remote-review branch')
  }
}

function capturePath(outputDir: string, cell: CaptureCell): string {
  return join(outputDir, CAPTURE_ROOT, cell.theme, `${encodeURIComponent(cell.targetId)}.png`)
}

async function screenshot(runtime: CaptureRuntime, path: string, diagnostic = false): Promise<ImageEvidence> {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing capture evidence: ${path}`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = await bounded(runtime.page.screenshot({
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    timeout: runtime.options.timeoutMs
  }), runtime.options.timeoutMs, diagnostic ? undefined : runtime.options.signal, 'renderer screenshot')
  const dimensions = pngDimensions(bytes)
  if (!dimensions || dimensions.width !== SCREENSHOT_SIZE.width || dimensions.height !== SCREENSHOT_SIZE.height) {
    throw new Error(`renderer screenshot was not ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`)
  }
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  return evidence(path, bytes)
}

async function prepareTasksCapture(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  const sidebar = target.id === 'sidebar-section:quirky.tasks/tasks'
  const view = target.id === 'view:quirky.tasks/tasks'
  const composer = target.id === 'overlay:quirky.tasks/workspace-composer'
  if (!sidebar && !view && !composer) return
  const { primaryWorktree, repo, tasks } = runtime.fixtures
  await rpc(runtime.client, 'quirky.tasks/prepare', {
    worktree: primaryWorktree.id
  }, runtime.options.timeoutMs, runtime.options.signal)
  if (composer) return

  const pullRequest = tasks.pullRequest
  await rpc(runtime.client, 'quirky.tasks/navigate', {
    worktree: primaryWorktree.id,
    mode: 'prs',
    repoIds: [repo.id],
    query: 'is:pr is:open',
    page: 1,
    scrollTop: 0,
    detail: {
      worktree: primaryWorktree.id,
      kind: 'pullRequest',
      number: pullRequest.number,
      url: pullRequest.url
    }
  }, runtime.options.timeoutMs, runtime.options.signal)
}

async function waitForTasksCapture(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  const compact = target.id === 'sidebar-section:quirky.tasks/tasks'
  const expanded = target.id === 'view:quirky.tasks/tasks'
  if (!compact && !expanded) return
  const { pullRequest } = runtime.fixtures.tasks
  const selectors = {
    root: compact ? '.tasks-compact' : '.tasks-list',
    row: compact ? '.tasks-compact__row' : '.tasks-list__row',
    title: pullRequest.title,
    loading: compact
      ? '.tasks-compact__loading, .tasks-compact__skeleton, [aria-busy="true"], [role="progressbar"]'
      : '.tasks-list__loading, .tasks-list__skeleton-row, [aria-busy="true"], [role="progressbar"]',
    detail: expanded
      ? `.tasks-list__detail .tasks-pr[aria-label="Pull request #${pullRequest.number}"] .tasks-pr__title`
      : null,
    description: expanded ? pullRequest.body : null
  }
  const ready = runtime.page.waitForFunction(async (expected) => {
    const root = document.querySelector(expected.root)
    if (!root) return false
    const visible = (element: Element | null): boolean => {
      if (!element) return false
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
    }
    const hasLoading = () => {
      if ([...root.querySelectorAll(expected.loading)].some(visible)) return true
      return [...root.querySelectorAll('*')].some((element) =>
        element.children.length === 0 &&
        /^loading(?:\b|…)/i.test((element.textContent ?? '').trim()) &&
        visible(element)
      )
    }
    const findRow = () => [...root.querySelectorAll(expected.row)].find((element) =>
      (element.textContent ?? '').includes(expected.title) && visible(element)
    ) ?? null
    const findDetail = () => expected.detail === null
      ? null
      : [...root.querySelectorAll(expected.detail)].find((element) =>
        (element.textContent ?? '').trim() === expected.title && visible(element)
      ) ?? null
    const hasDescription = () => {
      if (expected.description === null) return true
      const description = root.querySelector('.tasks-pr__description')
      return visible(description) && (description?.textContent ?? '').includes(expected.description)
    }

    const row = findRow()
    const detail = findDetail()
    if (!row || hasLoading() || !hasDescription() || (expected.detail !== null && !detail)) return false
    const { promise: nextFrame, resolve: nextFrameReady } = Promise.withResolvers<void>()
    requestAnimationFrame(() => nextFrameReady())
    await nextFrame
    if (!root.isConnected || !row.isConnected || findRow() !== row || hasLoading()) return false
    return hasDescription() && (expected.detail === null || (detail !== null && detail.isConnected && findDetail() === detail))
  }, selectors, { timeout: runtime.options.timeoutMs })
  await bounded(ready, runtime.options.timeoutMs, runtime.options.signal, 'Tasks fixture rows and detail')
}

async function waitForViewCapture(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  if (!VIEW_TARGETS[target.id]) return
  const fixture = runtime.viewFixture
  if (!fixture) throw new Error(`a view fixture is required for the ${target.id.endsWith('/pane') ? 'pane' : 'render'} view`)
  const pane = target.id === 'view:quirky.view/pane'
  const expected = {
    selector: targetSlotSelector(target),
    viewId: pane ? fixture.paneViewIds[0] : fixture.inlineViewId,
    pane
  }
  await bounded(runtime.page.waitForFunction(({ selector, viewId, pane }) => {
    const root = document.querySelector(selector)
    const card = root?.querySelector(`[data-view-card="${viewId}"]`)
    if (!root || !card || card.getAttribute('aria-label') !== 'Bundle size by route') return false
    const rect = card.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || root.querySelector('[role="alert"]')) return false
    if (!card.querySelector('[data-view-node="bar-chart"] [role="img"] svg') ||
      card.querySelectorAll('table tbody tr').length !== 3 ||
      !card.textContent?.includes('412 KB')) return false
    const buttons = [...card.querySelectorAll('button')].map(button => button.textContent?.trim())
    if (!buttons.includes('Lazy-load zxcvbn') || !buttons.includes('Replace date-fns-tz')) return false
    if (!pane) return true
    const tabs = [...root.querySelectorAll('[role="tab"]')]
    return tabs.length === 2 && tabs[0]?.textContent?.trim() === 'Bundle size by route' &&
      tabs[1]?.textContent?.trim() === 'Module map' && tabs[0]?.getAttribute('aria-selected') === 'true'
  }, expected, { timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'stored view card, chart, table, buttons and pane tabs')
}

async function captureOne(runtime: CaptureRuntime, target: CaptureTarget, theme: CaptureTheme): Promise<CaptureEvidence> {
  const cell = { targetId: target.id, theme }
  const reference = referenceFor(runtime.references, target.id, theme)
  const path = capturePath(runtime.outputDir, cell)
  const errorStart = runtime.pageErrors.length
  let image: ImageEvidence | null = null
  try {
    throwIfAborted(runtime.options.signal)
    await prepareTasksCapture(runtime, target)
    await openTarget(runtime, target)
    await inspectSurface(runtime, target)
    await waitForTasksCapture(runtime, target)
    await waitForViewCapture(runtime, target)
    const themeChanged = await verifyThemeBeforeCapture(runtime, runtime.themes[theme])
    if (themeChanged) await inspectSurface(runtime, target)
    await waitForTasksCapture(runtime, target)
    await waitForViewCapture(runtime, target)
    if (runtime.pageErrors.length > errorStart) {
      throw new Error(`renderer raised: ${runtime.pageErrors.slice(errorStart).join('; ')}`)
    }
    if (target.id === 'host:shell') await raiseNeedsYouToast(runtime)
    image = await screenshot(runtime, path)
    if (target.id === 'overlay:quirky.editor/close') await resolveUnsavedCloseOverlay(runtime)
    return { ...cell, image, reference, status: 'captured' }
  } catch (error) {
    if (error instanceof CaptureRuntimeError) throw error
    if (!runtime.options.signal?.aborted) {
      if (runtime.page.isClosed() || !runtime.page.context().browser()?.isConnected()) throw error
      try {
        await rpc(runtime.client, 'status.get', {}, Math.min(runtime.options.timeoutMs, 1_000))
      } catch {
        throw error
      }
    }
    const message = sanitizedCaptureError(error, runtime.secrets)
    if (!image && !existsSync(path)) {
      try {
        image = await screenshot(runtime, path, true)
      } catch {
        image = null
      }
    } else if (!image && existsSync(path)) {
      try { image = evidence(path, readFileSync(path)) } catch { image = null }
    }
    runtime.manifest.failures.push(`${target.id} (${theme}): ${message}`)
    return { ...cell, image, reference, status: 'failed', error: message }
  }
}

function failedCell(cell: CaptureCell, references: GoldenReferences, error: string): CaptureEvidence {
  return { ...cell, image: null, reference: referenceFor(references, cell.targetId, cell.theme), status: 'failed', error }
}

export function fillBlockedCells(
  cells: CaptureCell[],
  blockedCell: CaptureCell,
  references: GoldenReferences,
  results: Map<string, CaptureEvidence>,
  blocker: string
): void {
  const blockedIndex = cells.findIndex((cell) => cell.targetId === blockedCell.targetId && cell.theme === blockedCell.theme)
  if (blockedIndex < 0) return
  for (let index = blockedIndex + 1; index < cells.length; index += 1) {
    const cell = cells[index]
    const key = `${cell.targetId}\0${cell.theme}`
    if (!results.has(key)) results.set(key, failedCell(cell, references, `not attempted: renderer blocked by ${blocker}`))
  }
}

async function drainAskFixture(runtime: CaptureRuntime, fixture: AskCardFixture): Promise<void> {
  const { timeoutMs } = runtime.options
  const selector = '[data-plugin-slot="panel:quirky.ask/questions"]'
  const pendingSelector = `[data-ask-card=${JSON.stringify(fixture.askId)}]`
  const resultSelector = `[data-ask-result=${JSON.stringify(fixture.askId)}]`
  const observation = await (async () => {
    await rpc(runtime.client, 'ui.view.close', {}, timeoutMs)
    await rpc(runtime.client, 'ui.panel.open', { id: 'panel:quirky.ask/questions' }, timeoutMs)
    const root = runtime.page.locator(selector)
    await root.waitFor({ state: 'attached', timeout: timeoutMs })
    return await root.evaluateHandle((node, args) => {
      const body = node.querySelector('.plugin-slot-body') ?? node
      let seen = false
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      let observer: MutationObserver
      const sameRoot = () => node.isConnected && document.querySelector(args.selector) === node &&
        (node.querySelector('.plugin-slot-body') ?? node) === body
      const { promise: done, resolve, reject } = Promise.withResolvers<void>()
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        observer?.disconnect()
        if (error) reject(error)
        else resolve()
      }
      void done.catch(() => undefined)
      const inspect = () => {
        if (!sameRoot()) return finish(new Error('owned Ask observation root was remounted'))
        if (body.querySelector(args.resultSelector)) seen = true
        if (seen && !body.querySelector(args.resultSelector) && !body.querySelector(args.pendingSelector)) finish()
      }
      observer = new MutationObserver(inspect)
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
      timer = setTimeout(() => finish(new Error('owned Ask resolution flash did not appear and detach naturally')), args.timeoutMs)
      inspect()
      return { done, sameRoot, stop: () => finish(new Error('owned Ask observation stopped')) }
    }, { selector, pendingSelector, resultSelector, timeoutMs })
  })().then((handle) => ({ handle }), (error: unknown) => ({ error }))

  let pendingFailure: unknown
  if ('handle' in observation) {
    try {
      await runtime.page.locator(`${selector} ${pendingSelector}`).waitFor({ state: 'visible', timeout: Math.min(2_000, timeoutMs) })
    } catch (error) {
      pendingFailure = error
    }
  }
  let cancelFailure: unknown
  try {
    await closeAskCardFixture(runtime.client, fixture, { timeoutMs })
  } catch (error) {
    cancelFailure = error
    runtime.manifest.failures.push(`owned Ask cancellation: ${sanitizedError(error, runtime.secrets)}`)
    try {
      await closeAskCardFixture(runtime.client, fixture, { timeoutMs })
      cancelFailure = undefined
    } catch {}
  }
  if (!('handle' in observation)) throw observation.error
  const { handle } = observation
  const verifyPendingReport = async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const state = record(await rpc(runtime.client, 'ui.state', {}, remaining))
      const slots = Array.isArray(state.slots) ? state.slots.map(record) : []
      const report = record(slots.find((slot) => slot.id === 'panel:quirky.ask/questions')?.report)
      if (Array.isArray(report.pending) && !report.pending.map(record).some((ask) => ask.askId === fixture.askId)) return
      await Bun.sleep(Math.min(25, remaining))
    }
    throw new Error('owned Ask pending report did not settle')
  }
  try {
    if (cancelFailure) throw cancelFailure
    await bounded(handle.evaluate((state) => state.done), timeoutMs, undefined, 'owned Ask renderer drain')
    if (pendingFailure) {
      runtime.manifest.failures.push(`owned Ask pending observation recovered: ${sanitizedError(pendingFailure, runtime.secrets)}`)
    }
    await verifyPendingReport()
    if (!await handle.evaluate((state) => state.sameRoot())) {
      throw new Error('owned Ask pending report or observation root did not settle')
    }
    await rpc(runtime.client, 'ui.panel.close', {}, timeoutMs)
    await rpc(runtime.client, 'ui.panel.open', { id: 'panel:quirky.ask/questions' }, timeoutMs)
    await runtime.page.locator(`${selector} .plugin-slot-body`).waitFor({ state: 'attached', timeout: timeoutMs })
    await verifyPendingReport()
    if (await runtime.page.locator(`${selector} ${pendingSelector}, ${selector} ${resultSelector}`).count() !== 0) {
      throw new Error('owned Ask effects returned after reopening Questions')
    }
    await rpc(runtime.client, 'ui.panel.close', {}, timeoutMs)
    runtime.ownedAskFixtures.delete(fixture.askId)
    if (runtime.cellAskFixture?.askId === fixture.askId) runtime.cellAskFixture = null
  } finally {
    await handle.evaluate((state) => state.stop()).catch(() => undefined)
    await handle.dispose()
  }
}

export async function isolateCell(
  runtime: CaptureRuntime,
  target: CaptureTarget,
  theme: CaptureTheme,
  failed: boolean
): Promise<{ ready: true } | { ready: false; blocker: string }> {
  const options = runtime.options
  runtime.options = { ...options, signal: undefined }
  try {
    return await isolateOwnedCell(runtime, target, theme, failed)
  } finally {
    runtime.options = options
  }
}

async function isolateOwnedCell(
  runtime: CaptureRuntime, target: CaptureTarget, theme: CaptureTheme, failed: boolean
): Promise<{ ready: true } | { ready: false; blocker: string }> {
  const cell = `${target.id} (${theme})`
  const recordCleanupFailure = (error: unknown) => {
    runtime.manifest.failures.push(`${cell} cleanup: ${sanitizedError(error, runtime.secrets)}`)
  }
  for (const cleanup of [resolveUnsavedCloseOverlay, closeNewChatDialog]) {
    try { await cleanup(runtime) } catch (error) { recordCleanupFailure(error) }
  }
  try {
    await closeCurrentSurface(runtime)
  } catch (error) {
    recordCleanupFailure(error)
  }
  if (runtime.cellTerminalFixture) runtime.ownedTerminalFixtures.set(runtime.cellTerminalFixture.tabId, runtime.cellTerminalFixture)
  for (const [tabId, terminal] of runtime.ownedTerminalFixtures) {
    try {
      await closeCaptureTerminalFixture(runtime.client, terminal, runtime.options)
      runtime.ownedTerminalFixtures.delete(tabId)
      if (runtime.cellTerminalFixture?.tabId === tabId) runtime.cellTerminalFixture = null
    } catch (error) {
      recordCleanupFailure(error)
    }
  }
  for (const ask of runtime.ownedAskFixtures.values()) {
    try { await drainAskFixture(runtime, ask) } catch (error) { recordCleanupFailure(error) }
  }
  if (runtime.ownedAskFixtures.size || runtime.askAcquisitionUncertain ||
    runtime.ownedTerminalFixtures.size || runtime.terminalAcquisitionUncertain || runtime.dirtyCloseFixture) {
    recordCleanupFailure(new Error('owned fixture acquisition or renderer cleanup remains uncertain'))
    return { ready: false, blocker: `${cell}: owned fixture cleanup is unproved` }
  }

  let dialogs: string[]
  try {
    dialogs = await visibleDialogNames(runtime.page)
  } catch (error) {
    recordCleanupFailure(error)
    return { ready: false, blocker: `${cell}: renderer state could not be inspected` }
  }
  if (!failed && dialogs.length > 0) runtime.manifest.failures.push(`${cell} left a dialog open: ${dialogs.join(', ')}`)
  if (!failed && dialogs.length === 0) return { ready: true }

  const reloadAndVerify = async (): Promise<boolean> => {
    try {
      await bounded(runtime.page.reload({ waitUntil: 'domcontentloaded', timeout: runtime.options.timeoutMs }),
        runtime.options.timeoutMs, runtime.options.signal, 'renderer reload')
      await waitForUiWindow(runtime)
      const state = record(await rpc(runtime.client, 'ui.state', {}, runtime.options.timeoutMs, runtime.options.signal))
      const windows = Array.isArray(state.windows) ? state.windows : []
      if (windows.length !== 1) throw new Error(`renderer reported ${windows.length} windows after reload`)
      await runtime.page.locator('.tool-shell__stripe').first().waitFor({
        state: 'visible',
        timeout: runtime.options.timeoutMs
      })
      await verifyThemeBeforeCapture(runtime, runtime.themes[theme])
      return true
    } catch (error) {
      recordCleanupFailure(new Error(`renderer reload was not ready: ${sanitizedError(error, runtime.secrets)}`))
      return false
    }
  }

  if (!await reloadAndVerify()) return { ready: false, blocker: `${cell}: renderer reload was not ready` }
  try {
    dialogs = await visibleDialogNames(runtime.page)
  } catch (error) {
    recordCleanupFailure(error)
    return { ready: false, blocker: `${cell}: renderer state could not be inspected after reload` }
  }
  if (dialogs.length === 0) return { ready: true }

  try {
    await closeCurrentSurface(runtime)
  } catch (error) {
    recordCleanupFailure(error)
  }
  if (!await reloadAndVerify()) return { ready: false, blocker: `${cell}: renderer reload was not ready` }
  try {
    dialogs = await visibleDialogNames(runtime.page)
  } catch (error) {
    recordCleanupFailure(error)
    return { ready: false, blocker: `${cell}: renderer state could not be inspected after reload` }
  }
  if (dialogs.length > 0) {
    runtime.manifest.failures.push(`${cell} left a dialog that survived two renderer reloads: ${dialogs.join(', ')}`)
    return { ready: false, blocker: `${cell}: ${dialogs.join(', ')}` }
  }
  return { ready: true }
}

export async function captureTargetCell(
  runtime: CaptureRuntime,
  target: CaptureTarget,
  theme: CaptureTheme
): Promise<{
  capture: CaptureEvidence
  isolation: { ready: true } | { ready: false; blocker: string }
}> {
  runtime.lastReadiness = undefined
  const cell = { targetId: target.id, theme }
  if (runtime.ownedAskFixtures.size || runtime.askAcquisitionUncertain ||
    runtime.ownedTerminalFixtures.size || runtime.terminalAcquisitionUncertain || runtime.dirtyCloseFixture) {
    const blocker = 'previous cell still owns unresolved fixture resources'
    return { capture: failedCell(cell, runtime.references, blocker), isolation: { ready: false, blocker } }
  }
  runtime.cellTerminalFixture = null
  runtime.cellTerminalWorktreeId = null
  runtime.cellAskFixture = null
  let preparationFailure: string | null = null
  try {
    throwIfAborted(runtime.options.signal)
    if (CELL_TERMINAL_TARGETS.has(target.id)) {
      const worktree = target.id === 'status-bar:quirky.reviews/checks'
        ? runtime.fixtures.worktrees.find((entry) => entry.repoId === runtime.fixtures.repo.id && entry.name === CHECKS_FIXTURE_BRANCH)
        : runtime.fixtures.primaryWorktree
      if (!worktree) throw new Error('the Reviews checks fixture worktree is unavailable')
      runtime.cellTerminalWorktreeId = worktree.id
      runtime.terminalAcquisitionUncertain = true
      const terminal = await createCaptureTerminalFixture(runtime.client, runtime.fixtures, runtime.options, target.title, {
        worktree,
        onAcquired: (owned) => {
          runtime.ownedTerminalFixtures.set(owned.tabId, owned)
          runtime.cellTerminalFixture = owned
          runtime.terminalAcquisitionUncertain = false
        }
      })
      await prepareCaptureTerminalFixture(runtime.client, terminal, runtime.options)
    }
    if (target.id === 'view:quirky.ask/card') {
      runtime.askAcquisitionUncertain = true
      runtime.cellAskFixture = await createAskCardFixture(runtime.client, runtime.options, (owned) => {
        runtime.ownedAskFixtures.set(owned.askId, owned)
        runtime.cellAskFixture = owned
        runtime.askAcquisitionUncertain = false
      })
    }
  } catch (error) {
    preparationFailure = `${target.id === 'view:quirky.ask/card' ? 'Ask' : 'terminal'} fixture input: ${sanitizedError(error, runtime.secrets)}`
    runtime.manifest.failures.push(preparationFailure)
  }

  const fixtureFailure = preparationFailure ?? runtime.fixtureInputErrors.get(target.id)
  let capture: CaptureEvidence
  if (fixtureFailure) {
    capture = failedCell(cell, runtime.references, fixtureFailure)
  } else {
    try {
      capture = await captureOne(runtime, target, theme)
    } catch (error) {
      await isolateCell(runtime, target, theme, true)
      throw error
    }
  }
  const cleanupStart = runtime.manifest.failures.length
  const isolation = await isolateCell(runtime, target, theme, capture.status === 'failed')
  if (capture.status === 'captured' && (runtime.manifest.failures.length > cleanupStart || !isolation.ready)) {
    capture = { ...capture, status: 'failed', error: runtime.manifest.failures.slice(cleanupStart).join('; ') || 'cell isolation was not ready' }
  }
  return { capture, isolation }
}

async function closeOwnedRuntime(
  scope: ProcessScope,
  client: RuntimeClient | undefined,
  browser: Browser | undefined,
  server: BrowserServer | undefined,
  remote: Pick<RemoteFixtures, 'stop'> | undefined,
  fixtures: Pick<PreparedCaptureFixtureHome, 'cleanup'> | undefined,
  signal: AbortSignal | undefined
): Promise<string[]> {
  const failures: string[] = []
  // The launchServer owns Chromium; retain the client until it closes.
  // Playwright's own graceful shutdown budget is 30 seconds.
  if (server) {
    try { await bounded(server.close(), 35_000, undefined, 'browser server close') } catch (error) { failures.push(`browser server close: ${errorMessage(error)}`) }
  }
  if (browser) {
    try { await bounded(browser.close(), 2_000, undefined, 'browser close') } catch (error) { failures.push(`browser close: ${errorMessage(error)}`) }
  }
  if (remote) {
    try { failures.push(...await remote.stop()) } catch (error) { failures.push(`remote fixture cleanup: ${errorMessage(error)}`) }
  }
  if (client) {
    if (!signal?.aborted) {
      try { await bounded(client.callAny('daemon.stop', {}, { timeoutMs: 1_000 }), 1_250, undefined, 'daemon stop') } catch { /* ProcessScope remains the authoritative owner. */ }
    }
    try { client.close() } catch (error) { failures.push(`daemon client close: ${errorMessage(error)}`) }
  }
  try { await scope.cleanup() } catch (error) { failures.push(`process cleanup: ${errorMessage(error)}`) }
  if (!existsSync(scope.home)) {
    try { fixtures?.cleanup() } catch (error) { failures.push(`fixture cleanup: ${errorMessage(error)}`) }
  } else if (fixtures) {
    failures.push('fixture cleanup deferred because the isolated home still contains owned processes')
  }
  return failures
}

function assertBrowserExecutable(executable: string): void {
  if (!existsSync(executable) || !statSync(executable).isFile()) throw new Error(`Chromium executable is unavailable: ${executable}`)
}

/** Starts the real app in a disposable home, captures every selected contribution, and cleans all owned processes. */
export async function captureApplication(options: CaptureOptions): Promise<CaptureManifest> {
  return await runCaptureApplication(options)
}

/** Exercises production capture surfaces while retaining the private runtime's resource ownership. */
export async function withCaptureRuntime(options: CaptureOptions, scenario: (runtime: CaptureRuntime) => Promise<void>): Promise<void> {
  await runCaptureApplication(options, scenario)
}

async function runCaptureApplication(options: CaptureOptions, scenario?: (runtime: CaptureRuntime) => Promise<void>): Promise<CaptureManifest> {
  const { repoRoot, outputDir } = validateOptions(options)
  const selectedThemes = options.themes ?? THEMES
  const references = loadGoldenReferences(repoRoot)
  const executable = resolve(options.browserExecutable ?? captureBrowserExecutable())
  assertBrowserExecutable(executable)

  const scope = createProcessScope()
  const secrets: string[] = []
  let env: Record<string, string> = {}
  let prepared: PreparedCaptureFixtureHome | undefined
  let fixtures: RegisteredCaptureFixtures | undefined
  let editorBuffer: EditorFixtureBuffer | null = null
  let terminalFixture: CaptureTerminalFixture | null = null
  let transcriptFixture: TranscriptFixture | null = null
  let loopFixture: LoopFixture | null = null
  let remoteFixtures: RemoteFixtures | null = null
  let structuredSessionId: string | null = null
  let viewFixture: ViewFixture | null = null
  let daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let daemonOutput = () => ''
  let daemonErrors = () => ''
  let client: RuntimeClient | undefined
  let browserServer: BrowserServer | undefined
  let browser: Browser | undefined
  let manifest: CaptureManifest | undefined
  let cells: CaptureCell[] = []
  const results = new Map<string, CaptureEvidence>()
  const fixtureInputErrors = new Map<string, string>()
  let progressInitialized = false
  let progressEnabled = true
  let thrown: unknown

  const persistProgress = () => {
    if (!manifest || !progressEnabled) return
    try {
      writeCaptureProgress(outputDir, manifest, progressInitialized)
      progressInitialized = true
    } catch (error) {
      progressEnabled = false
      manifest.failures.push(`capture progress persistence failed: ${sanitizedError(error, secrets)}`)
    }
  }

  const syncProgress = () => {
    if (!manifest) return
    manifest.captures = cells.flatMap((cell) => {
      const capture = results.get(`${cell.targetId}\0${cell.theme}`)
      return capture ? [capture] : []
    })
    persistProgress()
  }

  const fillMissingCells = (message: string) => {
    if (!manifest) return
    for (const cell of cells) {
      const key = `${cell.targetId}\0${cell.theme}`
      if (!results.has(key)) results.set(key, failedCell(cell, references, message))
    }
    manifest.captures = cells.map((cell) => results.get(`${cell.targetId}\0${cell.theme}`)!)
    for (const capture of manifest.captures) {
      if (capture.status === 'failed' && !manifest.failures.some((failure) => failure.startsWith(`${capture.targetId} (${capture.theme}):`))) {
        manifest.failures.push(`${capture.targetId} (${capture.theme}): ${capture.error ?? 'capture failed'}`)
      }
    }
  }

  const recordFixtureInputFailure = (name: string, affectedTargets: CaptureTarget[], error: unknown) => {
    if (!manifest) return
    const message = `${name} fixture input: ${sanitizedError(error, secrets)}`
    manifest.failures.push(message)
    for (const target of affectedTargets) fixtureInputErrors.set(target.id, message)
    persistProgress()
  }

  try {
    registerPathSecret(scope.home, secrets)
    const baseEnv = createIsolatedRuntimeEnvironment(scope.home, { repoRoot, uiDir: join(repoRoot, UI_DIST_RELATIVE) })
    throwIfAborted(options.signal)
    const assets: RuntimeAssets = await prepareRuntimeAssets({
      repoRoot,
      home: scope.home,
      skipBuild: options.skipBuild,
      signal: options.signal
    })
    if (assets.ownedRoot) registerPathSecret(assets.ownedRoot, secrets)
    throwIfAborted(options.signal)
    env = runtimeAssetEnvironment(baseEnv, assets)
    if (!options.skipBuild) {
      await runOwnedCommand(scope, [process.execPath, join(repoRoot, BUILD_ENTRY)], repoRoot, env, options.timeoutMs, options.signal)
    }
    const assetSnapshot: AssetSnapshot = snapshotRuntimeAssets(assets)
    throwIfAborted(options.signal)
    prepared = await prepareCaptureFixtureHome(scope.home, { timeoutMs: options.timeoutMs, signal: options.signal, env })
    daemon = scope.spawn([process.execPath, join(repoRoot, DAEMON_ENTRY)], {
      cwd: repoRoot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    daemonOutput = outputTail(daemon.stdout)
    daemonErrors = outputTail(daemon.stderr)
    const runtime = await waitForRuntime(scope.home, daemon, options.timeoutMs, options.signal)
    secrets.push(runtime.token, runtime.hookToken)

    const connecting = connectDaemon({ home: scope.home, role: 'cli', name: 'ui-screenshot-review', autostart: false })
    try {
      client = await bounded(connecting, options.timeoutMs, options.signal, 'daemon RPC connection')
    } catch (error) {
      void connecting.then((lateClient) => lateClient.close(), () => undefined)
      throw error
    }
    const activeClient = client
    const status = record(await rpc(activeClient, 'status.get', {}, options.timeoutMs, options.signal))
    if (status.home !== scope.home) throw new Error('daemon did not start with the isolated capture home')

    fixtures = await registerCaptureFixtures(activeClient, prepared, { timeoutMs: options.timeoutMs, signal: options.signal })
    const activeFixtures = fixtures
    await seedWorktreeStatuses(activeClient, activeFixtures, { port: runtime.port, hookToken: runtime.hookToken }, { timeoutMs: options.timeoutMs, signal: options.signal })
    const initialModel = record(await rpc(activeClient, 'ui.contributions', {}, options.timeoutMs, options.signal)) as unknown as UiModel
    const { model, activatedVisibilitySettings } = await enableCaptureVisibilitySettings(initialModel,
      (method, params) => rpc(activeClient, method, params, options.timeoutMs, options.signal))
    if (!Array.isArray(model.views) || !Array.isArray(model.panels) || !Array.isArray(model.sidebarSections) ||
      !Array.isArray(model.activityItems) || !Array.isArray(model.statusBars) || !Array.isArray(model.overlays) ||
      !Array.isArray(model.settingsSections) || !model.modules || typeof model.modules !== 'object') {
      throw new Error('ui.contributions returned an invalid surface inventory')
    }
    const projection = projectCaptureInventory(model)
    const targets = selectCaptureTargets(projection.targets, options.only, projection.contributionInventory)
    cells = captureCells(targets, selectedThemes)
    const commit = (await runOwnedCommand(scope, ['git', '-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot, env, options.timeoutMs, options.signal)).stdout
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('could not identify the repository commit for the capture manifest')

    const themeInventory = selectedThemeList(await rpc(activeClient, 'theme.list', {}, options.timeoutMs, options.signal))
    const themes = Object.fromEntries(THEMES.map((appearance) => [appearance, chooseTheme(themeInventory, appearance)])) as Record<CaptureTheme, RendererTheme>
    writeThemeSelection(outputDir, themes, references)
    manifest = {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      commit,
      surface: 'desktop-renderer',
      viewport: VIEWPORT,
      scope: options.only.length === 0 ? 'full' : 'filtered',
      selectors: [...options.only],
      targets,
      contributionInventory: scopeCaptureInventory(projection.contributionInventory, targets),
      activatedVisibilitySettings,
      captures: [],
      failures: []
    }
    persistProgress()

    if (targets.some((target) => target.plugin === 'quirky.editor' || target.plugin === 'quirky.git')) {
      try {
        editorBuffer = await openFixtureEditorBuffer(activeClient, activeFixtures, { timeoutMs: options.timeoutMs, signal: options.signal })
      } catch (error) {
        manifest.failures.push(`fixture editor input: ${sanitizedError(error, secrets)}`)
        persistProgress()
      }
    }
    const terminalTargets = targets.filter((target) =>
      !CELL_TERMINAL_TARGETS.has(target.id) &&
      target.id !== 'view:quirky.session-info/transcript' &&
      (target.id === 'view:quirky.session/worktree' || TERMINAL_SURFACE_PLUGINS.has(target.plugin ?? ''))
    )
    if (terminalTargets.length > 0) {
      try {
        terminalFixture = await createCaptureTerminalFixture(activeClient, activeFixtures, {
          timeoutMs: options.timeoutMs,
          signal: options.signal
        })
      } catch (error) {
        recordFixtureInputFailure('terminal', terminalTargets, error)
      }
    }

    const transcriptTargets = targets.filter((target) => target.id === 'view:quirky.session-info/transcript')
    if (transcriptTargets.length > 0) {
      try {
        transcriptFixture = await createTranscriptFixture(activeClient, activeFixtures, {
          timeoutMs: options.timeoutMs,
          signal: options.signal
        })
      } catch (error) {
        recordFixtureInputFailure('transcript', transcriptTargets, error)
      }
    }

    const loopTargets = targets.filter((target) => target.id === 'view:quirky.loops/loop')
    if (loopTargets.length > 0) {
      try {
        loopFixture = await createLoopFixture(activeClient, activeFixtures, {
          timeoutMs: options.timeoutMs,
          signal: options.signal
        })
      } catch (error) {
        recordFixtureInputFailure('loop', loopTargets, error)
      }
    }
    const viewTargets = targets.filter((target) => VIEW_TARGETS[target.id])
    if (viewTargets.length > 0) {
      try {
        viewFixture = await createViewFixture(activeClient, activeFixtures, {
          timeoutMs: options.timeoutMs, signal: options.signal
        })
      } catch (error) {
        recordFixtureInputFailure('view', viewTargets, error)
      }
    }


    const remoteTargets = targets.filter((target) => REMOTE_TARGETS.has(target.id))
    if (remoteTargets.length > 0) {
      try {
        remoteFixtures = await createRemoteFixtures(scope, scope.home, activeClient, env, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          repoRoot,
          assets,
          secrets,
          fixtures: activeFixtures
        })
      } catch (error) {
        recordFixtureInputFailure('remote', remoteTargets, error)
      }
    }

    if (targets.some((target) => target.id === 'view:quirky.session/structured')) {
      try {
        const session = record(await rpc(activeClient, 'quirky.session/register', {
          worktree: activeFixtures.primaryWorktree.id,
          agent: 'claude',
          kind: 'structured',
          title: 'UI Review Structured Session',
          cwd: activeFixtures.primaryWorktree.path,
          background: true
        }, options.timeoutMs, options.signal))
        if (typeof session.id !== 'string' || session.id.length === 0) {
          throw new Error('quirky.session/register did not return a session ID')
        }
        structuredSessionId = session.id
        await seedStructuredTranscript(scope.home, session.id, repoRoot, () =>
          rpc(activeClient, 'quirky.structured/messages', { session: session.id }, options.timeoutMs, options.signal)
        )
      } catch (error) {
        manifest.failures.push(`fixture structured session: ${sanitizedError(error, secrets)}`)
        persistProgress()
      }
    }
    const launch = chromium.launchServer({
      executablePath: executable,
      headless: true,
      // The CLI owns signals so evidence is saved after all runtime cleanup.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: options.timeoutMs,
      env,
      args: process.platform === 'linux' ? ['--no-sandbox'] : []
    })
    try {
      browserServer = await bounded(launch, options.timeoutMs, options.signal, 'Chromium launch')
    } catch (error) {
      void launch.then(async (lateServer) => {
        const latePid = lateServer.process().pid
        if (typeof latePid === 'number') scope.track(latePid)
        await lateServer.close()
      }).catch(() => undefined)
      throw error
    }
    const browserProcess = browserServer.process()
    if (typeof browserProcess.pid === 'number') scope.track(browserProcess.pid)
    browser = await bounded(chromium.connect(browserServer.wsEndpoint(), { timeout: options.timeoutMs }), options.timeoutMs, options.signal, 'Chromium connection')
    const context = await bounded(browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR }), options.timeoutMs, options.signal, 'browser context creation')
    const page = await bounded(context.newPage(), options.timeoutMs, options.signal, 'browser page creation')
    page.setDefaultTimeout(options.timeoutMs)
    page.setDefaultNavigationTimeout(options.timeoutMs)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const captureRuntime: CaptureRuntime = {
      options,
      outputDir,
      client: activeClient,
      page,
      model,
      themes,
      references,
      fixtures: activeFixtures,
      editorBuffer,
      terminalFixture,
      cellTerminalFixture: null,
      cellTerminalWorktreeId: null,
      ownedTerminalFixtures: new Map(),
      terminalAcquisitionUncertain: false,
      cellAskFixture: null,
      ownedAskFixtures: new Map(),
      askAcquisitionUncertain: false,
      transcriptFixture,
      loopFixture,
      remoteFixtures,
      viewFixture,
      structuredSessionId,
      dirtyCloseFixture: null,
      scene: newSceneState(),
      manifest,
      secrets,
      pageErrors,
      fixtureInputErrors
    }
    await verifyRuntimeAssets(assets, assetSnapshot, model, {
      port: runtime.port,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    })
    await bounded(page.goto(`http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs
    }), options.timeoutMs, options.signal, 'renderer navigation')
    await waitForUiWindow(captureRuntime)
    await waitForRendererModel(captureRuntime)
    await bounded(Promise.all(activeFixtures.worktrees.map((worktree) =>
      page.locator(`[data-worktree-id=${JSON.stringify(worktree.id)}]`).waitFor({
        state: 'visible', timeout: options.timeoutMs
      })
    )), options.timeoutMs, options.signal, 'fixture worktree rows')
    if (scenario) await scenario(captureRuntime)
    if (!scenario) {
      const markAborted = () => {
        const message = sanitizedError(options.signal ? abortError(options.signal) : new Error('capture was aborted'), secrets)
        for (const cell of cells) {
          const key = `${cell.targetId}\0${cell.theme}`
          if (!results.has(key)) results.set(key, failedCell(cell, references, message))
        }
        manifest!.failures.push('capture aborted by caller signal')
        syncProgress()
      }

      captureThemes: for (const theme of selectedThemes) {
        if (options.signal?.aborted) {
          markAborted()
          break
        }
        try {
          await applyTheme(captureRuntime, themes[theme])
        } catch (error) {
          if (options.signal?.aborted) {
            markAborted()
            break
          }
          throw error
        }
        for (const target of targets) {
          if (options.signal?.aborted) {
            markAborted()
            break
          }
          const cell = { targetId: target.id, theme }
          const key = `${cell.targetId}\0${cell.theme}`
          const result = await captureTargetCell(captureRuntime, target, theme)
          results.set(key, result.capture)
          syncProgress()
          if (!result.isolation.ready) {
            fillBlockedCells(cells, cell, references, results, result.isolation.blocker)
            syncProgress()
            break captureThemes
          }
        }
        if (options.signal?.aborted) break
      }

      fillMissingCells('capture cell was not attempted')
      syncProgress()
    }
    if (!options.signal?.aborted) {
      await verifyRuntimeAssets(assets, assetSnapshot, model, {
        port: runtime.port,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      })
    }
  } catch (error) {
    thrown = error
    if (manifest) {
      const message = sanitizedError(error, secrets)
      fillMissingCells(message)
      manifest.failures.push(message)
      syncProgress()
    }
  } finally {
    if (daemon && !client && thrown) {
      const output = `${daemonErrors()}\\n${daemonOutput()}`.trim()
      if (output.length > 0) thrown = new Error(`${sanitizedError(thrown, secrets)}; daemon: ${sanitizedError(output, secrets)}`)
    }
    const cleanupFailures = await closeOwnedRuntime(scope, client, browser, browserServer, remoteFixtures ?? undefined, fixtures ?? prepared, options.signal)
    if (cleanupFailures.length > 0) {
      const details = cleanupFailures.map((failure) => sanitizedError(failure, secrets))
      if (manifest) manifest.failures.push(...details)
      if (!thrown) thrown = new Error(details.join('; '))
    }
    syncProgress()
  }

  if (thrown) throw new Error(sanitizedError(thrown, secrets))
  if (!manifest) throw new Error('capture completed without a manifest')
  return manifest
}
