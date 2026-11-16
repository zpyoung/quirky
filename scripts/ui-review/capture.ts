import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserServer, type Locator, type Page } from 'playwright'
import { type UiModel, type UiSlotEntry, type UiToolEntry, type ThemeInfo } from '@quirky/protocol'
import { connectDaemon, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope'
import {
  closeCaptureTerminalFixture,
  createCaptureTerminalFixture,
  createLoopFixture,
  createIsolatedRuntimeEnvironment,
  createTranscriptFixture,
  openFixtureEditorBuffer,
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type CaptureTerminalFixture,
  type EditorFixtureBuffer,
  type FixtureRpcClient,
  type LoopFixture,
  type PreparedCaptureFixtureHome,
  type RegisteredCaptureFixtures,
  type TranscriptFixture
} from './fixtures'
import { createRemoteFixtures, type RemoteFixtures } from './remote-fixtures'
import { captureBrowserExecutable } from './browser'
import {
  CAPTURE_SCHEMA_VERSION,
  THEMES,
  type CaptureEvidence,
  type CaptureManifest,
  type CaptureOptions,
  type CaptureTarget,
  type CaptureTheme,
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

function namedOverlayTrigger(command: string, trigger: Promise<unknown>): Promise<unknown> {
  OVERLAY_TRIGGER_NAMES.set(trigger, command)
  return trigger
}

const CELL_TERMINAL_TARGETS: ReadonlySet<string> = new Set([
  'view:quirky.accounts/session-accessory',
  'overlay:quirky.accounts/switch-dialog',
  'overlay:quirky.handoff/dialog'
])
const REMOTE_TARGETS: ReadonlySet<string> = new Set([
  'view:quirky.orchestration/remote-worker-output',
  'view:quirky.worktree/remote'
])
const TERMINAL_SURFACE_PLUGINS: ReadonlySet<string> = new Set([
  'quirky.terminal',
  'quirky.session',
  'quirky.session-info',
  'quirky.agent-status',
  'quirky.terminal-dock'
])

type RuntimeClient = FixtureRpcClient & { close(): void }

type RendererTheme = ThemeInfo & { plugin: string | null }

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
  transcriptFixture: TranscriptFixture | null
  loopFixture: LoopFixture | null
  remoteFixtures: RemoteFixtures | null
  structuredSessionId: string | null
  pendingUiCommand: Promise<unknown> | null
  scene: SceneState
  manifest: CaptureManifest
  secrets: string[]
  pageErrors: string[]
  fixtureInputErrors: ReadonlyMap<string, string>
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

export function discoverCaptureTargets(model: UiModel): CaptureTarget[] {
  const toTarget = (entry: UiSlotEntry, kind: CaptureTarget['kind']): CaptureTarget => {
    const separator = entry.id.indexOf(':')
    const slash = entry.id.indexOf('/', separator + 1)
    const plugin = separator >= 0 && slash > separator
      ? entry.id.slice(separator + 1, slash)
      : entry.plugin
    return { id: entry.id, plugin, title: entry.title, kind }
  }
  const targets = [
    { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' as const },
    { id: 'host:scoped', plugin: null, title: 'Quirky scoped to one project', kind: 'host' as const },
    { id: 'host:popups', plugin: null, title: 'Quirky with its popups open', kind: 'host' as const },
    ...model.views.map((entry) => toTarget(entry, 'view')),
    ...model.panels.map((entry) => toTarget(entry, 'panel')),
    ...model.sidebarSections.map((entry) => toTarget(entry, 'sidebar-section')),
    ...model.activityItems.map((entry) => toTarget(entry, 'activity-item')),
    ...model.statusBars.map((entry) => toTarget(entry, 'status-bar')),
    ...model.overlays.map((entry) => toTarget(entry, 'overlay')),
    ...model.settingsSections.map((entry) => toTarget(entry, 'settings-section')),
    { id: 'host:settings', plugin: null, title: 'Settings', kind: 'host' as const },
    { id: 'host:palette', plugin: null, title: 'Command palette', kind: 'host' as const }
  ]
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.id)) throw new Error(`duplicate UI capture target ID ${target.id}`)
    seen.add(target.id)
  }
  return targets
}

export function selectCaptureTargets(targets: CaptureTarget[], selectors: string[]): CaptureTarget[] {
  if (selectors.length === 0) return targets
  const selected = new Set<string>()
  for (const selector of selectors) {
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

async function openAccountsSessionContext(runtime: CaptureRuntime): Promise<void> {
  const view = runtime.model.views.find((candidate) => candidate.id === 'view:quirky.session/worktree')
  if (!view) throw new Error('the local session worktree view is unavailable for Accounts fixture preparation')
  const target: CaptureTarget = { id: view.id, plugin: view.plugin, title: view.title, kind: 'view' }
  const input = fixtureViewInput(
    runtime.fixtures,
    target,
    runtime.editorBuffer,
    runtime.terminalFixture,
    runtime.structuredSessionId,
    {
      transcript: runtime.transcriptFixture,
      loop: runtime.loopFixture,
      remote: runtime.remoteFixtures,
      cellTerminal: runtime.cellTerminalFixture
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

async function closeCurrentSurface(runtime: CaptureRuntime): Promise<void> {
  await clearScene(runtime)
  await resolveUnsavedCloseOverlay(runtime)
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
async function openSettings(runtime: CaptureRuntime): Promise<void> {
  const more = runtime.page.locator('button[aria-label="More"]')
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
  }
): Record<string, unknown> {
  const worktree = fixtures.primaryWorktree
  const input: Record<string, unknown> = {
    worktree: worktree.id,
    worktreeId: worktree.id,
    workspace: worktree.id,
    repo: fixtures.repo.id,
    repoId: fixtures.repo.id
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
  if (!buffer || !buffer.tabId) throw new Error('the fixture editor tab is unavailable for unsaved-close capture')
  await openWorktreeContext(runtime)
  const content = `${readFileSync(buffer.path, 'utf8')}\n// Unsaved review draft\n`
  const draft = record(await rpc(runtime.client, 'quirky.editor/draft', {
    bufferId: buffer.id,
    content,
    expectedRevision: buffer.contentRevision
  }, runtime.options.timeoutMs, runtime.options.signal))
  if (draft.dirty !== true || typeof draft.contentRevision !== 'number') throw new Error('the editor fixture draft did not become dirty')
  buffer.contentRevision = draft.contentRevision
  const pending = namedOverlayTrigger('command:quirky.editor/close', rpc(runtime.client, 'ui.command.run', {
    id: 'command:quirky.editor/close',
    args: { bufferId: buffer.id, tabId: buffer.tabId }
  }, runtime.options.timeoutMs, runtime.options.signal))
  runtime.pendingUiCommand = pending
  void pending.catch(() => undefined)
  await waitForOverlay(runtime, runtime.page.getByRole('dialog', { name: 'Unsaved Changes', exact: true }), 'Unsaved Changes', pending)
}

async function resolveUnsavedCloseOverlay(runtime: CaptureRuntime): Promise<void> {
  const pending = runtime.pendingUiCommand
  if (!pending) return
  let failure: unknown
  try {
    const dialog = runtime.page.getByRole('dialog', { name: 'Unsaved Changes', exact: true })
    if (await dialog.count() > 0 && await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: runtime.options.timeoutMs })
    }
    await bounded(pending, runtime.options.timeoutMs, undefined, 'editor close decision')
  } catch (error) {
    failure = error
  }
  try {
    const buffer = runtime.editorBuffer
    if (buffer) {
      const state = record(await rpc(runtime.client, 'quirky.editor/state', { bufferId: buffer.id }, runtime.options.timeoutMs))
      const requests = Array.isArray(state.closeRequests) ? state.closeRequests.map(record) : []
      if (buffer.tabId && requests.some((request) => request.tabId === buffer.tabId)) {
        await bounded(runtime.client.callAny('quirky.editor/close', {
          bufferId: buffer.id,
          tabId: buffer.tabId,
          choice: 'cancel'
        }, { timeoutMs: runtime.options.timeoutMs }), runtime.options.timeoutMs, undefined, 'clear editor close request')
      }
      const current = Array.isArray(state.buffers) ? state.buffers.map(record).find((entry) => entry.id === buffer.id) : undefined
      if (current?.dirty === true && typeof current.contentRevision === 'number') {
        const clean = await rpc(runtime.client, 'quirky.editor/draft', {
          bufferId: buffer.id,
          content: readFileSync(buffer.path, 'utf8'),
          expectedRevision: current.contentRevision
        }, runtime.options.timeoutMs)
        const revision = record(clean).contentRevision
        if (typeof revision === 'number') buffer.contentRevision = revision
      } else if (typeof current?.contentRevision === 'number') {
        buffer.contentRevision = current.contentRevision
      }
    }
  } catch (error) {
    failure ??= error
  } finally {
    runtime.pendingUiCommand = null
  }
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
      if (target.id === 'view:quirky.accounts/session-accessory') {
        await openAccountsSessionContext(runtime)
        await prepareAccountsStaleSession(runtime, 'codex')
      }
      const input = fixtureViewInput(runtime.fixtures, target, runtime.editorBuffer, runtime.terminalFixture, runtime.structuredSessionId, {
        transcript: runtime.transcriptFixture,
        loop: runtime.loopFixture,
        remote: runtime.remoteFixtures,
        cellTerminal: runtime.cellTerminalFixture
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
        await openAccountsSessionContext(runtime)
        await prepareAccountsStaleSession(runtime, 'claude')
        await waitForOverlay(
          runtime,
          runtime.page.locator('[data-plugin-overlay="overlay:quirky.accounts/switch-dialog"] [role="dialog"]'),
          'Accounts switch dialog'
        )
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
      if (target.plugin === 'quirky.editor' || target.plugin === 'quirky.git') await openWorktreeContext(runtime)
      await openSurfaceTool(runtime, target)
      return
  }
}

/**
 * The tool that hosts a sidebar section or activity item, or null for a surface that always shows,
 * such as a status bar item. Throws when no registered tool lists the target.
 */
export function hostingToolFor(model: Pick<UiModel, 'tools'>, target: CaptureTarget): string | null {
  if (target.kind !== 'sidebar-section' && target.kind !== 'activity-item') return null
  const tool = findHostingTool(model, target)
  return tool.id
}

function findHostingTool(model: Pick<UiModel, 'tools'>, target: CaptureTarget): UiToolEntry {
  const tool = model.tools?.find((candidate) => candidate.id === target.id || candidate.aliases.includes(target.id))
  if (!tool) throw new Error(`no tool hosts ${target.id}`)
  return tool
}

/** Opens the tool a sidebar section or activity item lives in, through `ui.tool.open`; a status bar item needs none. */
export async function openSurfaceTool(runtime: Pick<CaptureRuntime, 'client' | 'model' | 'options'>, target: CaptureTarget): Promise<void> {
  const id = hostingToolFor(runtime.model, target)
  if (id === null) return
  const tool = findHostingTool(runtime.model, target)
  if (target.kind === 'sidebar-section' && tool.contributionId !== target.id) {
    throw new Error(`${target.id} is not shown by its tool ${tool.id}, which shows ${tool.contributionId ?? 'the host Inbox'} instead`)
  }
  await rpc(runtime.client, 'ui.tool.open', { id }, runtime.options.timeoutMs, runtime.options.signal)
}

export async function waitForStateShown(runtime: Pick<CaptureRuntime, 'client' | 'options'>, target: CaptureTarget): Promise<void> {
  if (target.kind === 'host' || target.kind === 'settings-section' || target.kind === 'overlay') return
  const deadline = Date.now() + runtime.options.timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(runtime.options.signal)
    const state = record(await rpc(runtime.client, 'ui.state', {}, runtime.options.timeoutMs, runtime.options.signal))
    const slots = Array.isArray(state.slots) ? state.slots : []
    const slot = slots.map(record).find((entry) => entry.id === target.id)
    if (slot?.shown === true) return
    await Bun.sleep(75)
  }
  throw new Error(`public UI state did not show ${target.id}`)
}

async function inspectSurface(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
  await waitForStateShown(runtime, target)
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
    if (target.id === 'host:palette' && await runtime.page.getByLabel('Filter commands').count() === 0) {
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
  const readinessTimeout = Math.min(target.kind === 'overlay' ? 1_500 : 10_000, runtime.options.timeoutMs)
  try {
    await bounded(runtime.page.waitForFunction((slotSelector) => {
      const node = document.querySelector(slotSelector)
      if (!node) return false
      const body = node.classList.contains('plugin-slot') ? node.querySelector('.plugin-slot-body') : node
      const element = body ?? node
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const ownVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      const visibleChild = [...element.querySelectorAll('*')].some((child) => {
        const childStyle = getComputedStyle(child)
        const childRect = child.getBoundingClientRect()
        return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && childRect.width > 0 && childRect.height > 0
      })
      if (!ownVisible && !visibleChild) return false
      if (node.querySelector('[aria-busy=\"true\"], [role=\"progressbar\"]')) return false
      const loadingLeaf = [...element.querySelectorAll('*')].some((child) => {
        if (child.children.length > 0 || !/^loading(?:\b|…)/i.test((child.textContent ?? '').trim())) return false
        const childStyle = getComputedStyle(child)
        const childRect = child.getBoundingClientRect()
        return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && childRect.width > 0 && childRect.height > 0
      })
      if (loadingLeaf) return false
      if (node.querySelector('[role=\"alert\"], .plugin-slot-error')) return true
      const text = (element.textContent ?? '').trim()
      if (/^loading\b/i.test(text)) return false
      return text.length > 0 || visibleChild
    }, mountSelector, { timeout: readinessTimeout }), readinessTimeout, runtime.options.signal, `slot ${target.id} content`)
  } catch (error) {
    const timeoutMessage = `slot ${target.id} content exceeded ${readinessTimeout}ms`
    if (runtime.options.signal?.aborted ||
      (!errorMessage(error).includes(timeoutMessage) && !/Timeout.*exceeded/i.test(errorMessage(error)))) throw error
    const details = await root.evaluate((node) => {
      const body = node.classList.contains('plugin-slot') ? node.querySelector('.plugin-slot-body') : node
      const element = body ?? node
      return {
        text: (element.textContent ?? '').trim(),
        busy: node.querySelector('[aria-busy=\"true\"], [role=\"progressbar\"]') !== null
      }
    })
    throw new Error(`${timeoutMessage} (busy: ${details.busy}, text: ${JSON.stringify(details.text.slice(0, 120))})`)
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
  if (details.error) throw new Error(`slot ${target.id} reported an error: ${details.error}`)
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
    path,
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    timeout: runtime.options.timeoutMs
  }), runtime.options.timeoutMs, diagnostic ? undefined : runtime.options.signal, 'renderer screenshot')
  const dimensions = pngDimensions(bytes)
  if (!dimensions || dimensions.width !== SCREENSHOT_SIZE.width || dimensions.height !== SCREENSHOT_SIZE.height) {
    throw new Error(`renderer screenshot was not ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`)
  }
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
    const themeChanged = await verifyThemeBeforeCapture(runtime, runtime.themes[theme])
    if (themeChanged) await inspectSurface(runtime, target)
    await waitForTasksCapture(runtime, target)
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
    const message = sanitizedError(error, runtime.secrets)
    if (!image && !existsSync(path)) {
      try {
        image = await screenshot(runtime, path, true)
      } catch {
        image = null
      }
    } else if (!image && existsSync(path)) {
      try { image = evidence(path, readFileSync(path)) } catch { image = null }
    }
    if (runtime.pendingUiCommand) {
      try { await resolveUnsavedCloseOverlay(runtime) } catch (closeError) {
        runtime.manifest.failures.push(`editor close overlay cleanup: ${sanitizedError(closeError, runtime.secrets)}`)
      }
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

export async function isolateCell(
  runtime: CaptureRuntime,
  target: CaptureTarget,
  theme: CaptureTheme,
  failed: boolean
): Promise<{ ready: true } | { ready: false; blocker: string }> {
  const cell = `${target.id} (${theme})`
  const recordCleanupFailure = (error: unknown) => {
    runtime.manifest.failures.push(`${cell} cleanup: ${sanitizedError(error, runtime.secrets)}`)
  }
  try {
    await closeCurrentSurface(runtime)
  } catch (error) {
    recordCleanupFailure(error)
  }
  const terminal = runtime.cellTerminalFixture
  if (terminal) {
    try {
      await closeCaptureTerminalFixture(runtime.client, terminal, runtime.options)
    } catch (error) {
      recordCleanupFailure(error)
    } finally {
      runtime.cellTerminalFixture = null
    }
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
  const cell = { targetId: target.id, theme }
  runtime.cellTerminalFixture = null
  let terminalFailure: string | null = null
  if (CELL_TERMINAL_TARGETS.has(target.id)) {
    try {
      runtime.cellTerminalFixture = await createCaptureTerminalFixture(
        runtime.client,
        runtime.fixtures,
        runtime.options,
        target.title
      )
    } catch (error) {
      terminalFailure = `terminal fixture input: ${sanitizedError(error, runtime.secrets)}`
      runtime.manifest.failures.push(terminalFailure)
    }
  }

  const fixtureFailure = terminalFailure ?? runtime.fixtureInputErrors.get(target.id)
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
  const isolation = await isolateCell(runtime, target, theme, capture.status === 'failed')
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
    const model = record(await rpc(activeClient, 'ui.contributions', {}, options.timeoutMs, options.signal)) as unknown as UiModel
    if (!Array.isArray(model.views) || !Array.isArray(model.panels) || !Array.isArray(model.sidebarSections) ||
      !Array.isArray(model.activityItems) || !Array.isArray(model.statusBars) || !Array.isArray(model.overlays) ||
      !Array.isArray(model.settingsSections) || !model.modules || typeof model.modules !== 'object') {
      throw new Error('ui.contributions returned an invalid surface inventory')
    }
    const targets = selectCaptureTargets(discoverCaptureTargets(model), options.only)
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
      transcriptFixture,
      loopFixture,
      remoteFixtures,
      structuredSessionId,
      pendingUiCommand: null,
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
