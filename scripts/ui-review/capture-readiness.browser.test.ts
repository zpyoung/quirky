import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { captureApplication, captureTargetCell, targetSlotSelector, withCaptureRuntime, type CaptureRuntime } from './capture'
import { captureBrowserExecutable } from './browser'
import { pngDimensions, SCREENSHOT_SIZE } from './goldens'
import type { CaptureEvidence, CaptureManifest, CaptureTarget, CaptureTheme } from './contracts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const targetIds = [
  'view:quirky.git/diff',
  'view:quirky.session/worktree',
  'status-bar:quirky.git/ahead-behind',
  'status-bar:quirky.reviews/checks',
  'view:quirky.accounts/session-accessory',
  'overlay:quirky.accounts/switch-dialog',
  'overlay:quirky.editor/close',
  'overlay:quirky.editor/quick-open',
  'view:quirky.ask/card',
  'overlay:quirky.session/chat-dialogs'
] as const
const themes = ['dark', 'light'] as const satisfies readonly CaptureTheme[]
const overallDeadlineMs = 3_540_000
const progressFile = 'capture-progress.json'

type ProgressCell = {
  targetId: string
  theme: CaptureTheme
  status: 'captured' | 'failed'
  image: { path: string; sha256: string } | null
  error?: string
}

type ProgressManifest = Pick<CaptureManifest, 'createdAt' | 'targets' | 'captures' | 'failures'>

type CellTiming = {
  kind: 'cell'
  targetId: string
  theme: CaptureTheme
  status: 'captured' | 'failed'
  elapsedMs: number
  intervalMs: number | null
  image: { path: string; sha256: string } | null
  error?: string
}

type SetupTiming = {
  kind: 'setup'
  runtimeSetupThroughInventoryMs: number
  manifestElapsedMs: number
  manifestToFirstCellMs: number | null
}

type ProgressRecord = CellTiming | SetupTiming
const setupTimingKey = '__manifest_timing__'

function recordProgress(
  outputDir: string,
  startedAt: number,
  startedWallTime: number,
  records: Map<string, ProgressRecord>
): void {
  let progress: ProgressManifest
  try {
    progress = JSON.parse(readFileSync(join(outputDir, progressFile), 'utf8')) as ProgressManifest
  } catch {
    return
  }

  const elapsedMs = Math.round(performance.now() - startedAt)
  const completions = [...records.values()].filter((record): record is CellTiming => record.kind === 'cell')
  for (const cell of progress.captures as ProgressCell[]) {
    const key = `${cell.targetId}\0${cell.theme}`
    if (records.has(key)) continue
    const previous = completions.at(-1)
    const record: CellTiming = {
      kind: 'cell',
      targetId: cell.targetId,
      theme: cell.theme,
      status: cell.status,
      elapsedMs,
      intervalMs: previous ? elapsedMs - previous.elapsedMs : null,
      image: cell.image,
      error: cell.error
    }
    records.set(key, record)
    completions.push(record)
  }

  if (!records.has(setupTimingKey) && progress.createdAt) {
    const manifestElapsedMs = Date.parse(progress.createdAt) - startedWallTime
    if (Number.isFinite(manifestElapsedMs)) {
      records.set(setupTimingKey, {
        kind: 'setup',
        runtimeSetupThroughInventoryMs: manifestElapsedMs,
        manifestElapsedMs,
        manifestToFirstCellMs: null
      })
    }
  }
  const setup = records.get(setupTimingKey)
  const firstCell = completions[0]
  if (setup?.kind === 'setup' && firstCell && setup.manifestToFirstCellMs === null) {
    setup.manifestToFirstCellMs = Math.max(0, firstCell.elapsedMs - setup.manifestElapsedMs)
  }
}

function assertFullCapture(manifest: CaptureManifest): void {
  expect(manifest.scope).toBe('full')
  expect(manifest.failures).toEqual([])
  expect(manifest.captures).toHaveLength(2 * manifest.targets.length)

  const targetOrder = manifest.targets.map((target) => target.id)
  expect(manifest.captures.map(({ targetId, theme }) => `${theme}\0${targetId}`)).toEqual([
    ...targetOrder.map((targetId) => `dark\0${targetId}`),
    ...targetOrder.map((targetId) => `light\0${targetId}`)
  ])

  for (const targetId of targetIds) {
    expect(targetOrder.filter((id) => id === targetId)).toHaveLength(1)
    const cells = manifest.captures.filter((cell) => cell.targetId === targetId)
    expect(cells.map((cell) => cell.theme)).toEqual([...themes])
    for (const cell of cells) {
      expect(cell.status).toBe('captured')
      expect(cell.image).not.toBeNull()
    }
  }

  for (const cell of manifest.captures) {
    expect(cell.status).toBe('captured')
    expect(cell.image).not.toBeNull()
    const bytes = readFileSync(cell.image!.path)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(pngDimensions(bytes)).toEqual({ width: 2800, height: 1760 })
    expect(pngDimensions(bytes)).toEqual(SCREENSHOT_SIZE)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(cell.image!.sha256)
  }
}
type JsonRpcMessage = {
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

type RpcAnswer = { result?: unknown; error?: { code: number; message: string } }
type RequestResponder = (answer: RpcAnswer) => void
type RequestHandler = (request: JsonRpcMessage, respond: RequestResponder) => boolean
type ResponseHandler = (response: JsonRpcMessage, request: JsonRpcMessage, forward: () => void) => boolean
type MessageWaiter<T> = {
  predicate: (message: T) => boolean
  resolve: (message: T) => void
  reject: (error: Error) => void
}
type RpcResponseEvent = { response: JsonRpcMessage; request: JsonRpcMessage }
type CaptureCellResult = {
  capture: CaptureEvidence
  isolation: { ready: true } | { ready: false; blocker: string }
}

type RendererRpcProxy = {
  setRequestHandler(handler: RequestHandler | null): void
  setResponseHandler(handler: ResponseHandler | null): void
  waitForRequest(predicate: (request: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>
  waitForResponse(predicate: (response: JsonRpcMessage, request: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>
}

function parseJsonRpcMessage(message: string | Buffer): JsonRpcMessage | null {
  if (typeof message !== 'string') return null
  try {
    const value: unknown = JSON.parse(message)
    return typeof value === 'object' && value !== null ? value as JsonRpcMessage : null
  } catch {
    return null
  }
}

function waitForMessage<T>(
  history: T[],
  waiters: MessageWaiter<T>[],
  predicate: (message: T) => boolean,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  const existing = history.find(predicate)
  if (existing) return Promise.resolve(existing)
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`))
  }

  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const waiter: MessageWaiter<T> = { predicate, resolve, reject }
  const timeout = AbortSignal.timeout(timeoutMs)
  const fail = (error: Error) => {
    const index = waiters.indexOf(waiter)
    if (index < 0) return
    waiters.splice(index, 1)
    reject(error)
  }
  const onTimeout = () => fail(new Error(`${label} did not arrive within ${timeoutMs}ms`))
  const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error(`${label} aborted`))
  waiters.push(waiter)
  timeout.addEventListener('abort', onTimeout, { once: true })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (timeout.aborted) onTimeout()
  if (signal?.aborted) onAbort()
  void promise.finally(() => {
    timeout.removeEventListener('abort', onTimeout)
    signal?.removeEventListener('abort', onAbort)
  }).catch(() => undefined)
  return promise
}

function waitForBoundedPromise<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`))
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const { promise: failure, reject } = Promise.withResolvers<never>()
  const onTimeout = () => reject(new Error(`${label} did not finish within ${timeoutMs}ms`))
  const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error(`${label} aborted`))
  timeout.addEventListener('abort', onTimeout, { once: true })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (timeout.aborted) onTimeout()
  if (signal?.aborted) onAbort()
  return Promise.race([operation, failure]).finally(() => {
    timeout.removeEventListener('abort', onTimeout)
    signal?.removeEventListener('abort', onAbort)
  })
}

function publishMessage<T>(history: T[], waiters: MessageWaiter<T>[], message: T): void {
  history.push(message)
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index]!
    if (!waiter.predicate(message)) continue
    waiters.splice(index, 1)
    waiter.resolve(message)
  }
}

async function installRendererRpcProxy(runtime: CaptureRuntime): Promise<RendererRpcProxy> {
  const pageUrl = new URL(runtime.page.url())
  const token = new URLSearchParams(pageUrl.hash.slice(1)).get('token')
  if (!token) throw new Error('capture renderer URL did not include its private RPC token')
  const rpcUrl = new URL('/rpc', `ws://${pageUrl.host}`)
  rpcUrl.searchParams.set('token', token)

  const requests: JsonRpcMessage[] = []
  const responses: RpcResponseEvent[] = []
  const requestWaiters: MessageWaiter<JsonRpcMessage>[] = []
  const responseWaiters: MessageWaiter<RpcResponseEvent>[] = []
  let requestHandler: RequestHandler | null = null
  let responseHandler: ResponseHandler | null = null

  await runtime.page.routeWebSocket(rpcUrl.href, (webSocketRoute) => {
    const server = webSocketRoute.connectToServer()
    const requestsById = new Map<string | number, JsonRpcMessage>()
    webSocketRoute.onMessage((message) => {
      const request = parseJsonRpcMessage(message)
      if (!request || typeof request.method !== 'string' || request.id === undefined || request.id === null) {
        server.send(message)
        return
      }

      requestsById.set(request.id, request)
      publishMessage(requests, requestWaiters, request)
      const respond: RequestResponder = (answer) => {
        webSocketRoute.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }))
        requestsById.delete(request.id!)
      }
      if (requestHandler?.(request, respond)) return
      server.send(message)
    })
    server.onMessage((message) => {
      const response = parseJsonRpcMessage(message)
      const request = response?.id === undefined || response.id === null ? undefined : requestsById.get(response.id)
      if (!response || !request) {
        webSocketRoute.send(message)
        return
      }

      const pair = { response, request }
      publishMessage(responses, responseWaiters, pair)
      const forward = () => {
        webSocketRoute.send(message)
        requestsById.delete(response.id!)
      }
      if (responseHandler?.(response, request, forward)) return
      forward()
    })
  })

  const socketOpened = runtime.page.waitForEvent('websocket', { timeout: runtime.options.timeoutMs })
  await runtime.page.reload({ waitUntil: 'domcontentloaded', timeout: runtime.options.timeoutMs })
  await socketOpened
  await runtime.page.locator('.shell-workspace').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })

  return {
    setRequestHandler(handler) {
      requestHandler = handler
    },
    setResponseHandler(handler) {
      responseHandler = handler
    },
    waitForRequest(predicate) {
      return waitForMessage(
        requests,
        requestWaiters,
        predicate,
        runtime.options.timeoutMs,
        runtime.options.signal,
        'renderer RPC request'
      )
    },
    waitForResponse(predicate) {
      return waitForMessage(
        responses,
        responseWaiters,
        ({ response, request }) => predicate(response, request),
        runtime.options.timeoutMs,
        runtime.options.signal,
        'renderer RPC response'
      ).then(({ response }) => response)
    }
  }
}

function wrapClientCalls(
  runtime: CaptureRuntime,
  handler: (
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } | undefined,
    forward: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>
  ) => Promise<unknown>
): () => void {
  const original = runtime.client.callAny.bind(runtime.client)
  runtime.client.callAny = (method, params, options) => handler(method, params ?? {}, options, original)
  return () => { runtime.client.callAny = original }
}

function targetFor(runtime: CaptureRuntime, id: string): CaptureTarget {
  const target = runtime.manifest.targets.find((candidate) => candidate.id === id)
  if (!target) throw new Error(`capture runtime did not discover ${id}`)
  return target
}

async function captureRuntimeCell(
  runtime: CaptureRuntime,
  targetId: string,
  theme: CaptureTheme,
  outputLabel: string
): Promise<CaptureCellResult> {
  const originalOutputDir = runtime.outputDir
  runtime.outputDir = join(originalOutputDir, outputLabel)
  mkdirSync(runtime.outputDir, { recursive: true })
  try {
    return await captureTargetCell(runtime, targetFor(runtime, targetId), theme)
  } finally {
    runtime.outputDir = originalOutputDir
  }
}

function assertEvidenceImage(evidence: CaptureEvidence, status: 'captured' | 'failed'): void {
  expect(evidence.status).toBe(status)
  expect(evidence.image).not.toBeNull()
  const image = evidence.image!
  const bytes = readFileSync(image.path)
  expect(bytes.byteLength).toBeGreaterThan(0)
  expect(pngDimensions(bytes)).toEqual(SCREENSHOT_SIZE)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(image.sha256)
}

function logScenarioEvidence(label: string, evidence: CaptureEvidence): void {
  console.log(`${label}: ${JSON.stringify({
    targetId: evidence.targetId,
    theme: evidence.theme,
    status: evidence.status,
    error: evidence.error,
    image: evidence.image
  })}`)
}

async function activateTheme(runtime: CaptureRuntime, theme: CaptureTheme): Promise<void> {
  const expected = runtime.themes[theme]
  const background = expected.colors.bg
  if (typeof background !== 'string') throw new Error(`capture runtime theme ${expected.id} has no background color`)
  const active = await runtime.client.callAny('theme.set', { id: expected.id }) as { active?: unknown; chosen?: unknown }
  expect(active).toMatchObject({ active: expected.id, chosen: expected.id })
  await runtime.page.waitForFunction((color) =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase() === color.toLowerCase(),
  background, { timeout: runtime.options.timeoutMs })
}

async function withPrivateCaptureRuntime(
  label: string,
  scenario: (runtime: CaptureRuntime) => Promise<void>
): Promise<void> {
  const scratch = mkdtempSync(join('/tmp', `quirky-capture-readiness-${label}-`))
  const home = join(scratch, 'home')
  const outputDir = join(scratch, 'output')
  const previousHome = process.env.QUIRKY_HOME
  mkdirSync(home, { recursive: true })
  mkdirSync(outputDir)
  process.env.QUIRKY_HOME = home
  let retainOutput = false

  console.log(`${label} browser scenario output: ${outputDir}`)
  try {
    await withCaptureRuntime({
      repoRoot,
      outputDir,
      only: [],
      skipBuild: false,
      browserExecutable: captureBrowserExecutable(),
      themes,
      timeoutMs: 180_000,
      signal: AbortSignal.timeout(600_000)
    }, scenario)
  } catch (error) {
    retainOutput = true
    console.error(`retaining ${label} browser scenario output at ${outputDir}`)
    throw error
  } finally {
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    if (!retainOutput) rmSync(scratch, { recursive: true, force: true })
  }
}
type TransitionState = { seen: boolean; detached: boolean; sameRoot: boolean }

type TransitionObservation = {
  snapshot(): Promise<TransitionState>
  waitForDetached(timeoutMs: number): Promise<void>
  dispose(): Promise<void>
}

let transitionObserverSequence = 0

async function observeTransition(
  runtime: CaptureRuntime,
  rootSelector: string | null,
  elementSelector: string
): Promise<TransitionObservation> {
  const marker = `__capture_transition_${++transitionObserverSequence}`
  const observed: TransitionState = { seen: false, detached: false, sameRoot: true }
  const onConsole = (message: { text(): string }) => {
    const event = message.text().slice(marker.length + 1)
    if (!message.text().startsWith(`${marker}:`)) return
    if (event === 'seen') observed.seen = true
    if (event === 'detached') observed.detached = true
    if (event === 'root-changed') {
      observed.sameRoot = false
      if (observed.seen) observed.detached = true
    }
  }
  runtime.page.on('console', onConsole)
  const handle = await runtime.page.evaluateHandle(({ rootSelector, elementSelector, marker }) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document.documentElement
    if (!root) throw new Error(`transition observer root did not mount: ${rootSelector}`)
    const state: TransitionState = { seen: false, detached: false, sameRoot: true }
    let observer: MutationObserver
    const report = (event: string) => console.debug(`${marker}:${event}`)
    const inspect = () => {
      const currentRoot = rootSelector ? document.querySelector(rootSelector) : document.documentElement
      if (currentRoot !== root || !root.isConnected) {
        state.sameRoot = false
        report('root-changed')
        if (state.seen) {
          state.detached = true
          report('detached')
        }
        observer.disconnect()
        return
      }
      const element = root.querySelector(elementSelector)
      if (element) {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        if (!state.seen && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
          state.seen = true
          report('seen')
        }
      } else if (state.seen) {
        state.detached = true
        report('detached')
        observer.disconnect()
      }
    }
    observer = new MutationObserver(inspect)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    inspect()
    return { state, stop: () => observer.disconnect() }
  }, { rootSelector, elementSelector, marker }).catch((error) => {
    runtime.page.off('console', onConsole)
    throw error
  })

  return {
    snapshot: async () => {
      try {
        const state = await handle.evaluate((observation) => ({ ...observation.state }))
        observed.seen ||= state.seen
        observed.detached ||= state.detached
        observed.sameRoot &&= state.sameRoot
      } catch {}
      return { ...observed }
    },
    waitForDetached: async (timeoutMs) => {
      await runtime.page.waitForFunction((observation) =>
        observation.state.seen && observation.state.detached && observation.state.sameRoot,
      handle, { timeout: timeoutMs })
    },
    dispose: async () => {
      runtime.page.off('console', onConsole)
      await handle.evaluate((observation) => observation.stop()).catch(() => undefined)
      await handle.dispose().catch(() => undefined)
    }
  }
}
type AskTrackingOptions = {
  stripAskId?: boolean
  beforeCall?: (method: string, params: Record<string, unknown>) => void
}

type AskTracking = {
  readonly askId: string | null
  readonly inputKeys: readonly string[] | null
  readonly observation: TransitionObservation | null
  dispose(): Promise<void>
}

function trackAskFixture(runtime: CaptureRuntime, options: AskTrackingOptions = {}): AskTracking {
  let askId: string | null = null
  let inputKeys: readonly string[] | null = null
  let observation: TransitionObservation | null = null
  let observeQuestionsPanel = false
  const questionsSelector = '[data-plugin-slot=\"panel:quirky.ask/questions\"]'
  const restore = wrapClientCalls(runtime, async (method, params, callOptions, forward) => {
    options.beforeCall?.(method, params)
    if (method === 'ui.view.open' && params.id === 'view:quirky.ask/card') {
      const inputValue = params.input
      if (typeof inputValue !== 'object' || inputValue === null || Array.isArray(inputValue)) {
        throw new Error('Ask-card fixture view input was not an object')
      }
      const input = { ...inputValue as Record<string, unknown> }
      inputKeys = Object.keys(input)
      askId = typeof input.askId === 'string' ? input.askId : null
      observeQuestionsPanel = askId !== null
      if (options.stripAskId && askId !== null) {
        delete input.askId
        return await forward(method, { ...params, input }, callOptions)
      }
    }

    if (method === 'ui.panel.open' && params.id === 'panel:quirky.ask/questions' &&
      observeQuestionsPanel && askId !== null) {
      const result = await forward(method, params, callOptions)
      await runtime.page.locator(questionsSelector).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
      observation = await observeTransition(runtime, questionsSelector, `[data-ask-result=${JSON.stringify(askId)}]`)
      observeQuestionsPanel = false
      return result
    }

    return await forward(method, params, callOptions)
  })

  return {
    get askId() { return askId },
    get inputKeys() { return inputKeys },
    get observation() { return observation },
    async dispose() {
      restore()
      await observation?.dispose()
    }
  }
}

async function assertAskAbsent(runtime: CaptureRuntime, askId: string): Promise<void> {
  const questionsSelector = '[data-plugin-slot=\"panel:quirky.ask/questions\"]'
  await runtime.client.callAny('ui.panel.open', { id: 'panel:quirky.ask/questions' })
  try {
    await runtime.page.locator(questionsSelector).waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
    expect(await runtime.page.locator(`[data-ask-card=${JSON.stringify(askId)}]`).count()).toBe(0)
    expect(await runtime.page.locator(`[data-ask-result=${JSON.stringify(askId)}]`).count()).toBe(0)

    const pending = await runtime.client.callAny('quirky.ask/list', { pendingOnly: true, askId })
    expect(pending).toEqual([])
    const uiState = await runtime.client.callAny('ui.state', {}) as {
      slots?: Array<{ id?: string; report?: { pending?: Array<{ askId?: string }> } }>
    }
    const report = uiState.slots?.find((slot) => slot.id === 'panel:quirky.ask/questions')?.report
    expect(Array.isArray(report?.pending)).toBe(true)
    expect(report?.pending?.some((ask) => ask.askId === askId)).toBe(false)
  } finally {
    await runtime.client.callAny('ui.panel.close', {})
  }
}

test('full production inventory captures every target in dark then light with verified images', async () => {
  const scratch = mkdtempSync(join('/tmp', 'quirky-capture-readiness-'))
  const home = join(scratch, 'home')
  const outputDir = join(scratch, 'output')
  const previousHome = process.env.QUIRKY_HOME
  mkdirSync(home, { recursive: true })
  mkdirSync(outputDir)
  process.env.QUIRKY_HOME = home

  const startedAt = performance.now()
  const startedWallTime = Date.now()
  const progressRecords = new Map<string, ProgressRecord>()
  // Capture progress is written atomically per cell; sample it for diagnostic timings without changing production flow.
  const progressTimer = setInterval(() => recordProgress(outputDir, startedAt, startedWallTime, progressRecords), 250)
  progressTimer.unref()
  let retainOutput = false

  console.log(`full-order baseline output directory: ${outputDir}`)
  console.log('fixture setup order: editor → shared terminal → transcript → loop → stored views → remote coordinator → structured session → renderer startup → dark targets → light targets')
  try {
    const manifest = await captureApplication({
      repoRoot,
      outputDir,
      only: [],
      skipBuild: false,
      browserExecutable: captureBrowserExecutable(),
      themes,
      timeoutMs: 180_000,
      signal: AbortSignal.timeout(overallDeadlineMs)
    })
    recordProgress(outputDir, startedAt, startedWallTime, progressRecords)

    const setupTiming = progressRecords.get(setupTimingKey)
    const cellCompletions = [...progressRecords.values()].filter((record): record is CellTiming => record.kind === 'cell')
    const failedCells = manifest.captures.filter((cell) => cell.status === 'failed')
    const requestedTargets = manifest.captures.filter((cell) => targetIds.includes(cell.targetId as typeof targetIds[number]))

    console.log(`full-order baseline phases: ${JSON.stringify({ totalCaptureAndCleanupMs: Math.round(performance.now() - startedAt), setup: setupTiming ?? null, cellCompletions })}`)
    console.log(`full-order baseline targets: ${JSON.stringify(manifest.targets.map((target) => target.id))}`)
    console.log(`full-order baseline results: ${JSON.stringify({ targetCount: manifest.targets.length, cellCount: manifest.captures.length, capturedCount: manifest.captures.length - failedCells.length, failedCount: failedCells.length, failures: manifest.failures, failedCells, requestedTargets })}`)

    assertFullCapture(manifest)
  } catch (error) {
    retainOutput = true
    recordProgress(outputDir, startedAt, startedWallTime, progressRecords)
    const partial = (() => {
      try { return JSON.parse(readFileSync(join(outputDir, progressFile), 'utf8')) as ProgressManifest } catch { return null }
    })()
    console.error(`partial baseline report: ${JSON.stringify({ setup: progressRecords.get(setupTimingKey) ?? null, cellCompletions: [...progressRecords.values()].filter((record): record is CellTiming => record.kind === 'cell'), failures: partial?.failures ?? [], failedCells: partial?.captures.filter((cell) => cell.status === 'failed') ?? [] })}`)
    console.error(`retaining full-order diagnostic output at ${outputDir}`)
    throw error
  } finally {
    clearInterval(progressTimer)
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    if (!retainOutput) rmSync(scratch, { recursive: true, force: true })
  }
}, overallDeadlineMs + 60_000)

test('Ask/chat mounted negatives and isolation: omitted Ask input and refused New chat proceed to the next valid cell in both themes', async () => {
  await withPrivateCaptureRuntime('ask-chat-negative', async (runtime) => {
    const proxy = await installRendererRpcProxy(runtime)
    for (const theme of themes) {
      await activateTheme(runtime, theme)

      const tracking = trackAskFixture(runtime, { stripAskId: true })
      let askResult: CaptureCellResult | null = null
      let askFlash: TransitionState | null = null
      try {
        askResult = await captureRuntimeCell(runtime, 'view:quirky.ask/card', theme, `ask-input-omitted-${theme}`)
        askFlash = tracking.observation ? await tracking.observation.snapshot() : null
      } finally {
        await tracking.dispose()
      }
      const askId = tracking.askId
      if (!askId || !askResult) throw new Error('Ask input omission scenario did not acquire and capture its owned ID')
      expect(tracking.inputKeys).toEqual(['askId'])
      expect(askResult.isolation).toEqual({ ready: true })
      assertEvidenceImage(askResult.capture, 'failed')
      logScenarioEvidence(`Ask input omitted ${theme}`, askResult.capture)
      expect(askFlash).toMatchObject({ seen: true, detached: true })
      expect(runtime.ownedAskFixtures.size).toBe(0)
      expect(runtime.askAcquisitionUncertain).toBe(false)
      const failedAskImage = askResult.capture.image!

      await assertAskAbsent(runtime, askId)
      const gitNext = await captureRuntimeCell(runtime, 'view:quirky.git/diff', theme, `after-ask-omission-${theme}`)
      expect(gitNext.isolation).toEqual({ ready: true })
      assertEvidenceImage(gitNext.capture, 'captured')
      logScenarioEvidence(`Git diff after Ask input omission ${theme}`, gitNext.capture)
      expect(askResult.capture.status).toBe('failed')
      expect(askResult.capture.image).toEqual(failedAskImage)
      assertEvidenceImage(askResult.capture, 'failed')

      const newChat = { triggers: 0, parameters: undefined as Record<string, unknown> | undefined }
      const restoreNewChat = wrapClientCalls(runtime, async (method, params, callOptions, forward) => {
        if (method === 'ui.command.run' && params.id === 'command:quirky.session/new-chat') {
          newChat.triggers += 1
          newChat.parameters = params
          return {}
        }
        return await forward(method, params, callOptions)
      })
      let chatResult: CaptureCellResult | null = null
      try {
        chatResult = await captureRuntimeCell(
          runtime,
          'overlay:quirky.session/chat-dialogs',
          theme,
          `new-chat-trigger-refused-${theme}`
        )
      } finally {
        restoreNewChat()
      }
      if (!chatResult) throw new Error('New chat trigger refusal did not produce a capture result')
      expect(newChat.triggers).toBe(1)
      const triggerParameters = newChat.parameters
      if (!triggerParameters) throw new Error('New chat trigger request parameters were not recorded')
      expect(triggerParameters).toEqual({
        id: 'command:quirky.session/new-chat',
        args: { workspace: runtime.fixtures.primaryWorktree.id }
      })
      expect(chatResult.isolation).toEqual({ ready: true })
      assertEvidenceImage(chatResult.capture, 'failed')
      logScenarioEvidence(`New chat trigger refused ${theme}`, chatResult.capture)
      const chatDialog = `${targetSlotSelector(targetFor(runtime, 'overlay:quirky.session/chat-dialogs'))} [role=\"dialog\"]`
      expect(await runtime.page.locator(chatDialog).count()).toBe(0)
      const failedChatImage = chatResult.capture.image!

      const quickOpenNext = await captureRuntimeCell(
        runtime,
        'overlay:quirky.editor/quick-open',
        theme,
        `after-new-chat-refusal-${theme}`
      )
      expect(quickOpenNext.isolation).toEqual({ ready: true })
      assertEvidenceImage(quickOpenNext.capture, 'captured')
      logScenarioEvidence(`Quick Open after New chat refusal ${theme}`, quickOpenNext.capture)
      expect(chatResult.capture.status).toBe('failed')
      expect(chatResult.capture.image).toEqual(failedChatImage)
      assertEvidenceImage(chatResult.capture, 'failed')
      expect(await runtime.page.locator(chatDialog).count()).toBe(0)
    }
    proxy.setRequestHandler(null)
    proxy.setResponseHandler(null)
  })
}, 900_000)

test('Ask/chat mounted negatives and isolation: real Ask loading, error, and unavailable states fail in both themes', async () => {
  await withPrivateCaptureRuntime('ask-renderer-states', async (runtime) => {
    const proxy = await installRendererRpcProxy(runtime)
    const stateCases = ['loading', 'error', 'unavailable'] as const
    for (const theme of themes) {
      await activateTheme(runtime, theme)
      for (const stateCase of stateCases) {
        const tracking = trackAskFixture(runtime)
        let handled = false
        const heldResponse = { respond: undefined as RequestResponder | undefined }
        const text = stateCase === 'loading'
          ? 'Loading question…'
          : stateCase === 'error'
            ? 'Could not load the question: test-only renderer list failure'
            : 'This question is no longer available.'
        const visibleState = runtime.page.getByText(text, { exact: true })
          .waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
        proxy.setRequestHandler((request, respond) => {
          if (handled || request.method !== 'quirky.ask/list' ||
            request.params?.askId !== tracking.askId) return false
          handled = true
          if (stateCase === 'loading') {
            heldResponse.respond = respond
            return true
          }
          if (stateCase === 'error') {
            respond({ error: { code: -32_001, message: 'test-only renderer list failure' } })
          } else {
            respond({ result: [] })
          }
          return true
        })

        const cellPromise = captureRuntimeCell(
          runtime,
          'view:quirky.ask/card',
          theme,
          `ask-${stateCase}-${theme}`
        )
        void cellPromise.catch(() => undefined)
        let result: CaptureCellResult | null = null
        let flash: TransitionState | null = null
        try {
          const request = await proxy.waitForRequest((candidate) =>
            candidate.method === 'quirky.ask/list' && candidate.params?.askId === tracking.askId
          )
          expect(request.params?.askId).toBe(tracking.askId)
          await visibleState
          result = await cellPromise
          flash = tracking.observation ? await tracking.observation.snapshot() : null
        } finally {
          proxy.setRequestHandler(null)
          const releaseHeld = heldResponse.respond
          if (releaseHeld) {
            try { releaseHeld({ result: [] }) } catch {}
          }
          await tracking.dispose()
          await cellPromise.catch(() => undefined)
        }

        if (!result || !tracking.askId) throw new Error(`Ask ${stateCase} scenario did not finish`)
        expect(tracking.inputKeys).toEqual(['askId'])
        expect(handled).toBe(true)
        expect(result.isolation).toEqual({ ready: true })
        assertEvidenceImage(result.capture, 'failed')
        logScenarioEvidence(`Ask ${stateCase} ${theme}`, result.capture)
        expect(flash).toMatchObject({ seen: true, detached: true })
        expect(runtime.ownedAskFixtures.size).toBe(0)
        await assertAskAbsent(runtime, tracking.askId)
      }
    }
    proxy.setResponseHandler(null)
  })
}, 900_000)

test('Ask/chat mounted negatives and isolation: recovery waits for the held renderer read and natural flash', async () => {
  await withPrivateCaptureRuntime('ask-recovery-drain', async (runtime) => {
    const proxy = await installRendererRpcProxy(runtime)
    await activateTheme(runtime, 'dark')
    let cancelStarted = false
    const recoveryBarrier = { release: undefined as (() => void) | undefined }
    const tracking = trackAskFixture(runtime, {
      beforeCall(method) {
        if (method === 'quirky.ask/cancel') cancelStarted = true
      }
    })
    const recoveryRequestIds = new Set<string | number>()
    const isOwnedResolvedResponse = (response: JsonRpcMessage, request: JsonRpcMessage): boolean => {
      if (request.method !== 'quirky.ask/list' || request.params?.askId !== tracking.askId) return false
      const rows = Array.isArray(response.result)
        ? response.result as Array<{ id?: string; envelope?: { status?: string } }>
        : []
      return rows.some((row) => row.id === tracking.askId &&
        row.envelope?.status !== undefined && row.envelope.status !== 'pending')
    }
    proxy.setRequestHandler((request, respond) => {
      if (request.method === 'quirky.ask/list' && request.params?.pendingOnly === true) {
        respond({ result: [] })
        return true
      }
      if (cancelStarted && request.method === 'quirky.ask/list' &&
        request.params?.askId === tracking.askId && request.id !== undefined && request.id !== null) {
        recoveryRequestIds.add(request.id)
      }
      return false
    })
    proxy.setResponseHandler((response, request, forward) => {
      if (request.id !== undefined && request.id !== null && recoveryRequestIds.has(request.id) &&
        isOwnedResolvedResponse(response, request)) {
        recoveryBarrier.release = forward
        return true
      }
      return false
    })

    const pendingRead = proxy.waitForRequest((request) =>
      request.method === 'quirky.ask/list' && request.params?.pendingOnly === true
    )
    const recoveryRead = proxy.waitForResponse((response, request) =>
      request.id !== undefined && request.id !== null && recoveryRequestIds.has(request.id) &&
      isOwnedResolvedResponse(response, request)
    )
    let captureSettled = false
    const capturePromise = captureRuntimeCell(runtime, 'view:quirky.ask/card', 'dark', 'ask-recovery-dark')
      .then((result) => {
        captureSettled = true
        return result
      }, (error: unknown) => {
        captureSettled = true
        throw error
      })
    void capturePromise.catch(() => undefined)

    let result: CaptureCellResult | null = null
    let flash: TransitionState | null = null
    try {
      const emptyPendingRead = await pendingRead
      expect(emptyPendingRead.params?.pendingOnly).toBe(true)
      const response = await recoveryRead
      const askId = tracking.askId
      if (!askId) throw new Error('Ask recovery scenario did not acquire an owned ID')
      const rows = response.result as Array<{ id?: string; envelope?: { status?: string } }>
      const resolvedAsk = rows.find((row) => row.id === askId)
      expect(resolvedAsk).toBeDefined()
      expect(resolvedAsk?.envelope?.status).not.toBe('pending')
      const releaseRecovery = recoveryBarrier.release
      if (!releaseRecovery) throw new Error('Ask ID recovery response was not held')
      expect(captureSettled).toBe(false)
      expect(runtime.ownedAskFixtures.has(askId)).toBe(true)
      expect(await runtime.client.callAny('quirky.ask/list', { pendingOnly: true, askId })).toEqual([])

      releaseRecovery()
      recoveryBarrier.release = undefined
      result = await capturePromise
      flash = tracking.observation ? await tracking.observation.snapshot() : null
    } finally {
      const releasePending = recoveryBarrier.release
      if (releasePending) {
        try { releasePending() } catch {}
      }
      recoveryBarrier.release = undefined
      proxy.setRequestHandler(null)
      proxy.setResponseHandler(null)
      await tracking.dispose()
      await capturePromise.catch(() => undefined)
    }

    const askId = tracking.askId
    if (!askId || !result) throw new Error('Ask recovery scenario did not complete its owned drain')
    expect(tracking.inputKeys).toEqual(['askId'])
    expect(result.capture.status).toBe('failed')
    expect(result.capture.error).toContain('owned Ask pending observation recovered')
    expect(result.isolation).toEqual({ ready: true })
    assertEvidenceImage(result.capture, 'failed')
    logScenarioEvidence('Ask recovery with held response', result.capture)
    expect(flash).toMatchObject({ seen: true, detached: true })
    expect(runtime.ownedAskFixtures.has(askId)).toBe(false)
    const failedImage = result.capture.image!

    await assertAskAbsent(runtime, askId)
    const next = await captureRuntimeCell(runtime, 'view:quirky.git/diff', 'dark', 'after-ask-recovery-dark')
    expect(next.isolation).toEqual({ ready: true })
    assertEvidenceImage(next.capture, 'captured')
    logScenarioEvidence('Next cell after Ask recovery', next.capture)
    expect(result.capture.status).toBe('failed')
    expect(result.capture.image).toEqual(failedImage)
    assertEvidenceImage(result.capture, 'failed')
  })
}, 900_000)

test('Ask/chat mounted negatives and isolation: early result flash is latched before cancellation reply', async () => {
  await withPrivateCaptureRuntime('ask-early-flash', async (runtime) => {
    await activateTheme(runtime, 'dark')
    const tracking = trackAskFixture(runtime)
    const actualCancelReply = Promise.withResolvers<unknown>()
    const flashDetached = Promise.withResolvers<TransitionState>()
    const releaseCancelReply = Promise.withResolvers<void>()
    let cancelCalls = 0
    const restoreCancelReply = wrapClientCalls(runtime, async (method, params, callOptions, forward) => {
      if (method === 'quirky.ask/cancel' && params.askId === tracking.askId) {
        cancelCalls += 1
        const response = await forward(method, params, callOptions)
        actualCancelReply.resolve(response)
        const observation = tracking.observation
        if (!observation) throw new Error('owned Ask flash observer was not installed before cancellation')
        await observation.waitForDetached(runtime.options.timeoutMs)
        flashDetached.resolve(await observation.snapshot())
        await waitForBoundedPromise(
          releaseCancelReply.promise,
          runtime.options.timeoutMs,
          runtime.options.signal,
          'release owned Ask cancellation reply'
        )
        return response
      }
      return await forward(method, params, callOptions)
    })

    let captureSettled = false
    const capturePromise = captureRuntimeCell(runtime, 'view:quirky.ask/card', 'dark', 'ask-early-flash-dark')
      .then((result) => {
        captureSettled = true
        return result
      }, (error: unknown) => {
        captureSettled = true
        throw error
      })
    void capturePromise.catch(() => undefined)
    let result: CaptureCellResult | null = null
    let flash: TransitionState | null = null
    try {
      await waitForBoundedPromise(
        actualCancelReply.promise,
        runtime.options.timeoutMs,
        runtime.options.signal,
        'owned Ask cancellation RPC reply'
      )
      expect(cancelCalls).toBe(1)
      flash = await waitForBoundedPromise(
        flashDetached.promise,
        runtime.options.timeoutMs,
        runtime.options.signal,
        'owned Ask flash appearance and natural detachment'
      )
      const askId = tracking.askId
      if (!askId) throw new Error('early-flash scenario did not acquire an owned Ask ID')
      expect(flash).toMatchObject({ seen: true, detached: true, sameRoot: true })
      expect(captureSettled).toBe(false)
      expect(runtime.ownedAskFixtures.has(askId)).toBe(true)
      expect(await runtime.client.callAny('quirky.ask/list', { pendingOnly: true, askId })).toEqual([])

      releaseCancelReply.resolve()
      result = await capturePromise
    } finally {
      releaseCancelReply.resolve()
      restoreCancelReply()
      await capturePromise.catch(() => undefined)
      await tracking.dispose()
    }

    const askId = tracking.askId
    if (!askId || !result) throw new Error('early-flash scenario did not finish its owned cleanup')
    expect(tracking.inputKeys).toEqual(['askId'])
    expect(result.isolation).toEqual({ ready: true })
    assertEvidenceImage(result.capture, 'captured')
    logScenarioEvidence('Ask early-flash cancellation', result.capture)
    expect(flash).toMatchObject({ seen: true, detached: true, sameRoot: true })
    expect(runtime.ownedAskFixtures.has(askId)).toBe(false)
    const originalImage = result.capture.image!

    await assertAskAbsent(runtime, askId)
    const next = await captureRuntimeCell(runtime, 'view:quirky.git/diff', 'dark', 'after-early-flash-dark')
    expect(next.isolation).toEqual({ ready: true })
    assertEvidenceImage(next.capture, 'captured')
    logScenarioEvidence('Next cell after early Ask flash', next.capture)
    expect(result.capture.image).toEqual(originalImage)
    assertEvidenceImage(result.capture, 'captured')
  })
}, 900_000)

test('dirty-close dialog detaches before a real Quick Open mount in both themes', async () => {
  await withPrivateCaptureRuntime('editor-close-quick-open', async (runtime) => {
    const closeTarget = targetFor(runtime, 'overlay:quirky.editor/close')
    const quickOpenTarget = targetFor(runtime, 'overlay:quirky.editor/quick-open')
    const closeDialog = `${targetSlotSelector(closeTarget)} [role=\"dialog\"]`
    for (const theme of themes) {
      await activateTheme(runtime, theme)

      const closeObserver = await observeTransition(runtime, null, closeDialog)
      let closeState: TransitionState | null = null
      let closeResult: CaptureCellResult | null = null
      try {
        closeResult = await captureRuntimeCell(runtime, closeTarget.id, theme, `editor-close-${theme}`)
        closeState = await closeObserver.snapshot()
      } finally {
        await closeObserver.dispose()
      }
      if (!closeResult) throw new Error('Editor close cell did not complete')
      expect(closeResult.isolation).toEqual({ ready: true })
      assertEvidenceImage(closeResult.capture, 'captured')
      logScenarioEvidence(`Editor close ${theme}`, closeResult.capture)
      expect(closeState).toEqual({ seen: true, detached: true, sameRoot: true })
      expect(await runtime.page.locator(closeDialog).count()).toBe(0)

      const quickObserver = await observeTransition(runtime, null, '.qe-quick-open')
      let quickState: TransitionState | null = null
      let quickResult: CaptureCellResult | null = null
      try {
        quickResult = await captureRuntimeCell(runtime, quickOpenTarget.id, theme, `quick-open-after-close-${theme}`)
        quickState = await quickObserver.snapshot()
      } finally {
        await quickObserver.dispose()
      }
      if (!quickResult) throw new Error('Quick Open after Editor close did not complete')
      expect(quickResult.isolation).toEqual({ ready: true })
      assertEvidenceImage(quickResult.capture, 'captured')
      logScenarioEvidence(`Quick Open after Editor close ${theme}`, quickResult.capture)
      expect(quickState).toEqual({ seen: true, detached: true, sameRoot: true })
      expect(await runtime.page.locator('.qe-quick-open').count()).toBe(0)
    }
  })
}, 900_000)
