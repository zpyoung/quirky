import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright'
import { type UiModel, type UiSlotEntry, type ThemeInfo } from '@quirky/protocol'
import { connectDaemon, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope'
import {
  createCaptureTerminalFixture,
  createIsolatedRuntimeEnvironment,
  FIXTURE_THEME_PLUGIN_ID,
  openFixtureEditorBuffer,
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  type CaptureTerminalFixture,
  type EditorFixtureBuffer,
  type PreparedCaptureFixtureHome,
  type RegisteredCaptureFixtures
} from './fixtures'
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

const VIEWPORT = { width: 1340, height: 600 } as const
const UI_DIST_RELATIVE = 'packages/ui/dist'
const DAEMON_ENTRY = 'packages/daemon/src/main.ts'
const BUILD_ENTRY = 'packages/ui/build.ts'
const CAPTURE_ROOT = 'captures'
const CAPTURE_PROGRESS_FILE = 'capture-progress.json'
const GOLDEN_ROOT = 'docs/quirk/specs/2026-10-28-ui-redesign/img'
export type CaptureCell = { targetId: string; theme: CaptureTheme }

type RuntimeClient = {
  callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>
  close(): void
}

type RendererTheme = ThemeInfo & { plugin: string | null }

type CaptureRuntime = {
  options: CaptureOptions
  outputDir: string
  client: RuntimeClient
  page: Page
  model: UiModel
  themes: Record<CaptureTheme, RendererTheme>
  fixtures: RegisteredCaptureFixtures
  editorBuffer: EditorFixtureBuffer | null
  terminalFixture: CaptureTerminalFixture | null
  pendingUiCommand: Promise<unknown> | null
  manifest: CaptureManifest
  secrets: string[]
  pageErrors: string[]
}
class CaptureRuntimeError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizedError(error: unknown, secrets: string[]): string {
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'capture was aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
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

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function evidence(path: string, bytes: Uint8Array): ImageEvidence {
  return { path: resolve(path), sha256: sha256(bytes) }
}

function referenceEvidence(repoRoot: string): Record<CaptureTheme, ImageEvidence> {
  const references = {} as Record<CaptureTheme, ImageEvidence>
  for (const theme of THEMES) {
    const path = join(repoRoot, GOLDEN_ROOT, `golden-${theme}.png`)
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`approved ${theme} reference PNG is missing: ${path}`)
    const bytes = readFileSync(path)
    const dimensions = pngDimensions(bytes)
    if (!dimensions || dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
      throw new Error(`approved ${theme} reference must be a ${VIEWPORT.width}x${VIEWPORT.height} PNG`)
    }
    references[theme] = evidence(path, bytes)
  }
  return references
}

export function discoverCaptureTargets(model: UiModel): CaptureTarget[] {
  const toTarget = (entry: UiSlotEntry, kind: CaptureTarget['kind']): CaptureTarget => ({
    id: entry.id,
    plugin: entry.plugin,
    title: entry.title,
    kind
  })
  const targets = [
    { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' as const },
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

export function captureCells(targets: CaptureTarget[]): CaptureCell[] {
  return [
    ...targets.map((target) => ({ targetId: target.id, theme: 'dark' as const })),
    ...targets.map((target) => ({ targetId: target.id, theme: 'light' as const }))
  ]
}

function validateOptions(options: CaptureOptions): { repoRoot: string; outputDir: string } {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('capture timeout must be a positive finite number')
  if (!Array.isArray(options.only)) throw new Error('--only selectors must be an array')
  const repoRoot = resolve(options.repoRoot)
  const outputDir = resolve(options.outputDir)
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) throw new Error(`repository root is not a directory: ${repoRoot}`)
  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) throw new Error(`capture output directory must already exist: ${outputDir}`)
  const progressPath = join(outputDir, CAPTURE_PROGRESS_FILE)
  if (existsSync(progressPath)) throw new Error(`refusing to overwrite existing capture progress: ${progressPath}`)
  return { repoRoot, outputDir }
}

function uiAssetPath(repoRoot: string, pluginId: string, moduleUrl: string): string {
  const pathname = new URL(moduleUrl, 'http://quirky.capture.invalid').pathname
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  if (parts.length < 3 || parts[0] !== 'plugins' || parts[1] !== pluginId) {
    throw new Error(`invalid public UI module URL for ${pluginId}`)
  }
  const pluginRoot = resolve(repoRoot, 'plugins', pluginId)
  const path = resolve(pluginRoot, ...parts.slice(2))
  const fromPlugin = relative(pluginRoot, path)
  if (fromPlugin === '' || fromPlugin === '..' || fromPlugin.startsWith(`..${sep}`) || isAbsolute(fromPlugin)) {
    throw new Error(`UI module path escapes its plugin directory: ${pluginId}`)
  }
  return path
}

function verifyUiAssets(repoRoot: string, model?: UiModel): void {
  const uiDir = join(repoRoot, UI_DIST_RELATIVE)
  const assets = [
    'index.html',
    'main.js',
    'main.css',
    'xterm.css',
    'vendor/react.js',
    'vendor/react-dom.js',
    'vendor/react-dom-client.js',
    'vendor/jsx-runtime.js'
  ]
  for (const asset of assets) {
    const path = join(uiDir, asset)
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`UI asset is missing: ${path}; build the UI or omit --skip-build`)
  }
  if (model) {
    for (const [pluginId, module] of Object.entries(model.modules)) {
      const asset = uiAssetPath(repoRoot, pluginId, module.url)
      if (!existsSync(asset) || !statSync(asset).isFile()) {
        throw new Error(`built UI module for ${pluginId} is missing: ${asset}; build the UI or omit --skip-build`)
      }
    }
  }
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

async function waitForRuntime(home: string, child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeInfo> {
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

async function rpc(
  client: RuntimeClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  throwIfAborted(signal)
  return await bounded(client.callAny(method, params, { timeoutMs }), timeoutMs, signal, method)
}

function chooseTheme(themes: RendererTheme[], appearance: CaptureTheme): RendererTheme {
  const candidates = themes.filter((theme) => theme.appearance === appearance && theme.plugin !== FIXTURE_THEME_PLUGIN_ID)
  const selected = candidates.find((theme) => theme.id !== 'default') ??
    candidates[0] ??
    themes.find((theme) => theme.appearance === appearance)
  if (!selected) throw new Error(`no ${appearance} appearance theme is available`)
  return selected
}

function writeThemeSelection(outputDir: string, themes: Record<CaptureTheme, RendererTheme>, references: Record<CaptureTheme, ImageEvidence>): void {
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
      await runtime.page.locator('.app .layout').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      return
    }
    await Bun.sleep(100)
  }
  throw new Error('renderer did not connect to the isolated daemon')
}

async function waitForRendererModel(runtime: CaptureRuntime, model: UiModel): Promise<void> {
  const staticSlots = model.sidebarSections.length + model.activityItems.length + model.statusBars.length
  const expectedPanels = model.panels.length
  await bounded(runtime.page.waitForFunction(({ staticSlots: expectedSlots, panels }) => {
    const mounted = document.querySelectorAll('[data-plugin-slot]').length
    const toggles = document.querySelectorAll('button.panel-toggle').length
    return mounted >= expectedSlots && toggles === panels
  }, { staticSlots, panels: expectedPanels }, { timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, 'renderer contribution model')
}

function targetSlotSelector(target: CaptureTarget): string {
  const attr = JSON.stringify(target.id)
  return target.kind === 'overlay' ? `[data-plugin-overlay=${attr}]` : `[data-plugin-slot=${attr}]`
}

async function closeCurrentSurface(runtime: CaptureRuntime): Promise<void> {
  await resolveUnsavedCloseOverlay(runtime)
  const settings = runtime.page.getByRole('dialog', { name: 'Settings', exact: true })
  if (await settings.count() > 0 && await settings.isVisible()) {
    const cancel = settings.getByRole('button', { name: 'Cancel', exact: true })
    if (await cancel.count() > 0) await cancel.click({ timeout: runtime.options.timeoutMs })
  }
  await bounded(runtime.page.keyboard.press('Escape'), runtime.options.timeoutMs, runtime.options.signal, 'close renderer overlay')
  await rpc(runtime.client, 'ui.palette.set', { open: false }, runtime.options.timeoutMs, runtime.options.signal)
  await rpc(runtime.client, 'ui.view.close', {}, runtime.options.timeoutMs, runtime.options.signal)
  await rpc(runtime.client, 'ui.panel.close', {}, runtime.options.timeoutMs, runtime.options.signal)
  await rpc(runtime.client, 'ui.sidebar.set', { visible: true }, runtime.options.timeoutMs, runtime.options.signal)
}

async function openSettings(runtime: CaptureRuntime): Promise<void> {
  const button = runtime.page.locator('button.gear[aria-label="Settings"]')
  if (await button.count() !== 1) throw new Error('host Settings control is unavailable')
  await button.click({ timeout: runtime.options.timeoutMs })
  await runtime.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
}

function fixtureViewInput(
  fixtures: RegisteredCaptureFixtures,
  target: CaptureTarget,
  editorBuffer: EditorFixtureBuffer | null,
  terminalFixture: CaptureTerminalFixture | null
): Record<string, unknown> {
  const worktree = fixtures.primaryWorktree
  const input: Record<string, unknown> = {
    worktree: worktree.id,
    worktreeId: worktree.id,
    workspace: worktree.id,
    repo: fixtures.repo.id,
    repoId: fixtures.repo.id
  }
  if (target.plugin === 'quirky.git' && target.id.endsWith('/diff')) {
    input.path = 'src/app.ts'
    input.source = 'unstaged'
  }
  if (target.plugin === 'quirky.editor' && target.id === 'view:quirky.editor/document' && editorBuffer) {
    input.bufferId = editorBuffer.id
    input.tabId = editorBuffer.tabId
    input.mode = editorBuffer.mode
  }
  if (terminalFixture && ['quirky.terminal', 'quirky.session', 'quirky.session-info', 'quirky.terminal-dock'].includes(target.plugin ?? '')) {
    input.session = terminalFixture.sessionId
    input.sessionId = terminalFixture.sessionId
    input.tabId = terminalFixture.tabId
    input.pane = terminalFixture.paneId
    input.paneId = terminalFixture.paneId
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
  const pending = runtime.client.callAny('ui.command.run', {
    id: 'command:quirky.editor/close',
    args: { bufferId: buffer.id, tabId: buffer.tabId }
  }, { timeoutMs: runtime.options.timeoutMs })
  runtime.pendingUiCommand = pending
  void pending.catch(() => undefined)
  await runtime.page.getByRole('dialog', { name: 'Unsaved Changes', exact: true }).waitFor({
    state: 'visible',
    timeout: runtime.options.timeoutMs
  })
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
  const toggles = runtime.page.locator('button.panel-toggle')
  const index = await toggles.evaluateAll((buttons, title) => buttons.findIndex((button) => button.getAttribute('aria-label') === title), target.title)
  if (index >= 0) await toggles.nth(index).click({ timeout: runtime.options.timeoutMs })
  else await rpc(runtime.client, 'ui.panel.open', { id: target.id }, runtime.options.timeoutMs, runtime.options.signal)
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
      if (target.id !== 'host:shell') throw new Error(`unsupported host target ${target.id}`)
      return
    case 'view': {
      const input = fixtureViewInput(runtime.fixtures, target, runtime.editorBuffer, runtime.terminalFixture)
      await rpc(runtime.client, 'ui.view.open', { id: target.id, input }, runtime.options.timeoutMs, runtime.options.signal)
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
      if (target.id === 'overlay:quirky.editor/quick-open') {
        await openWorktreeContext(runtime)
        await rpc(runtime.client, 'ui.command.run', { id: 'command:quirky.editor/quick-open' }, runtime.options.timeoutMs, runtime.options.signal)
        await runtime.page.locator('.qe-quick-open').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
        await runtime.page.getByLabel('Go to file').fill('app.ts', { timeout: runtime.options.timeoutMs })
        await runtime.page.getByRole('option').filter({ hasText: 'src/app.ts' }).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      } else if (target.id === 'overlay:quirky.editor/close') {
        await openUnsavedCloseOverlay(runtime)
      }
      return
    case 'sidebar-section':
    case 'activity-item':
    case 'status-bar':
      if (target.plugin === 'quirky.editor' || target.plugin === 'quirky.git') await openWorktreeContext(runtime)
      return
  }
}

async function waitForStateShown(runtime: CaptureRuntime, target: CaptureTarget): Promise<void> {
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
  if (target.kind === 'host') {
    const element = target.id === 'host:shell'
      ? runtime.page.locator('.app .layout')
      : runtime.page.getByRole('dialog', { name: target.title, exact: true })
    await element.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
    const details = await element.evaluate((node) => ({
      text: (node.textContent ?? '').trim(),
      rect: node.getBoundingClientRect().toJSON(),
      visible: getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none'
    }))
    if (!details.visible || details.rect.width <= 0 || details.rect.height <= 0) throw new Error(`${target.id} is hidden or has zero size`)
    if (target.id !== 'host:shell' && details.text.length === 0) throw new Error(`${target.id} is empty`)
    if (target.id === 'host:palette' && await runtime.page.getByLabel('Filter commands').count() === 0) {
      throw new Error('host palette did not mount its command filter')
    }
    return
  }
  if (target.plugin === 'quirky.browser' && target.id === 'view:quirky.browser/page') {
    throw new Error('native browser panes are unavailable in the browser renderer; no Watch fixture session is available')
  }

  const selector = targetSlotSelector(target)
  const root = runtime.page.locator(selector)
  await bounded(root.waitFor({ state: 'attached', timeout: runtime.options.timeoutMs }), runtime.options.timeoutMs, runtime.options.signal, `slot ${target.id} mount`)
  if (await root.count() !== 1) throw new Error(`slot ${target.id} did not mount in the renderer DOM`)
  const readinessTimeout = Math.min(target.kind === 'overlay' ? 1_500 : 10_000, runtime.options.timeoutMs)
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
  }, selector, { timeout: readinessTimeout }), readinessTimeout, runtime.options.signal, `slot ${target.id} content`)
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
  if (!dimensions || dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
    throw new Error(`renderer screenshot was not ${VIEWPORT.width}x${VIEWPORT.height}`)
  }
  return evidence(path, bytes)
}

async function captureOne(runtime: CaptureRuntime, target: CaptureTarget, theme: CaptureTheme): Promise<CaptureEvidence> {
  const cell = { targetId: target.id, theme }
  const path = capturePath(runtime.outputDir, cell)
  const errorStart = runtime.pageErrors.length
  let image: ImageEvidence | null = null
  try {
    throwIfAborted(runtime.options.signal)
    await openTarget(runtime, target)
    await inspectSurface(runtime, target)
    if (await verifyThemeBeforeCapture(runtime, runtime.themes[theme])) await inspectSurface(runtime, target)
    if (runtime.pageErrors.length > errorStart) {
      throw new Error(`renderer raised: ${runtime.pageErrors.slice(errorStart).join('; ')}`)
    }
    image = await screenshot(runtime, path)
    if (target.id === 'overlay:quirky.editor/close') await resolveUnsavedCloseOverlay(runtime)
    return { ...cell, image, status: 'captured' }
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
    return { ...cell, image, status: 'failed', error: message }
  }
}

function failedCell(cell: CaptureCell, error: string): CaptureEvidence {
  return { ...cell, image: null, status: 'failed', error }
}

async function closeOwnedRuntime(
  scope: ProcessScope,
  client: RuntimeClient | undefined,
  browser: Browser | undefined,
  server: BrowserServer | undefined,
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
  const references = referenceEvidence(repoRoot)
  const executable = resolve(options.browserExecutable ?? chromium.executablePath())
  assertBrowserExecutable(executable)

  const scope = createProcessScope()
  const secrets = [scope.home]
  let env: Record<string, string> = {}
  let prepared: PreparedCaptureFixtureHome | undefined
  let fixtures: RegisteredCaptureFixtures | undefined
  let editorBuffer: EditorFixtureBuffer | null = null
  let terminalFixture: CaptureTerminalFixture | null = null
  let daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let daemonOutput = () => ''
  let daemonErrors = () => ''
  let client: RuntimeClient | undefined
  let browserServer: BrowserServer | undefined
  let browser: Browser | undefined
  let manifest: CaptureManifest | undefined
  let cells: CaptureCell[] = []
  const results = new Map<string, CaptureEvidence>()
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

  try {
    env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot, uiDir: join(repoRoot, UI_DIST_RELATIVE) })
    throwIfAborted(options.signal)
    if (options.skipBuild) verifyUiAssets(repoRoot)
    else await runOwnedCommand(scope, [process.execPath, join(repoRoot, BUILD_ENTRY)], repoRoot, env, options.timeoutMs, options.signal)

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
    secrets.push(runtime.token)

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
    const model = record(await rpc(activeClient, 'ui.contributions', {}, options.timeoutMs, options.signal)) as unknown as UiModel
    if (!Array.isArray(model.views) || !Array.isArray(model.panels) || !Array.isArray(model.sidebarSections) ||
      !Array.isArray(model.activityItems) || !Array.isArray(model.statusBars) || !Array.isArray(model.overlays) ||
      !Array.isArray(model.settingsSections) || !model.modules || typeof model.modules !== 'object') {
      throw new Error('ui.contributions returned an invalid surface inventory')
    }
    const targets = selectCaptureTargets(discoverCaptureTargets(model), options.only)
    cells = captureCells(targets)
    const commit = (await runOwnedCommand(scope, ['git', '-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot, env, options.timeoutMs, options.signal)).stdout
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('could not identify the repository commit for the capture manifest')
    verifyUiAssets(repoRoot, model)

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
      references,
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
    const terminalSurfacePlugins = ['quirky.terminal', 'quirky.session', 'quirky.session-info', 'quirky.agent-status', 'quirky.terminal-dock']
    const needsTerminalFixture = targets.some((target) =>
      target.id === 'view:quirky.session/worktree' || terminalSurfacePlugins.includes(target.plugin ?? '')
    )
    if (needsTerminalFixture) {
      try {
        terminalFixture = await createCaptureTerminalFixture(activeClient, activeFixtures, { timeoutMs: options.timeoutMs, signal: options.signal })
      } catch (error) {
        manifest.failures.push(`terminal fixture input: ${sanitizedError(error, secrets)}`)
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
    const context = await bounded(browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 }), options.timeoutMs, options.signal, 'browser context creation')
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
      fixtures: activeFixtures,
      editorBuffer,
      terminalFixture,
      pendingUiCommand: null,
      manifest,
      secrets,
      pageErrors
    }
    await bounded(page.goto(`http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs
    }), options.timeoutMs, options.signal, 'renderer navigation')
    await waitForUiWindow(captureRuntime)
    await waitForRendererModel(captureRuntime, model)

    const markAborted = () => {
      const message = sanitizedError(options.signal ? abortError(options.signal) : new Error('capture was aborted'), secrets)
      for (const cell of cells) {
        const key = `${cell.targetId}\0${cell.theme}`
        if (!results.has(key)) results.set(key, failedCell(cell, message))
      }
      manifest!.failures.push('capture aborted by caller signal')
      syncProgress()
    }

    for (const theme of THEMES) {
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
        const result = await captureOne(captureRuntime, target, theme)
        results.set(key, result)
        syncProgress()
      }
      if (options.signal?.aborted) break
    }

    manifest.captures = cells.map((cell) => results.get(`${cell.targetId}\0${cell.theme}`) ?? failedCell(cell, 'capture cell was not attempted'))
    for (const capture of manifest.captures) {
      if (capture.status === 'failed' && !manifest.failures.some((failure) => failure.startsWith(`${capture.targetId} (${capture.theme}):`))) {
        manifest.failures.push(`${capture.targetId} (${capture.theme}): ${capture.error ?? 'capture failed'}`)
      }
    }
    syncProgress()
  } catch (error) {
    thrown = error
    if (manifest) {
      manifest.failures.push(sanitizedError(error, secrets))
      syncProgress()
    }
  } finally {
    if (daemon && !client && thrown) {
      const output = `${daemonErrors()}\\n${daemonOutput()}`.trim()
      if (output.length > 0) thrown = new Error(`${sanitizedError(thrown, secrets)}; daemon: ${sanitizedError(output, secrets)}`)
    }
    const cleanupFailures = await closeOwnedRuntime(scope, client, browser, browserServer, fixtures ?? prepared, options.signal)
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
