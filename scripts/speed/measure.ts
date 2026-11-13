import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, Page, Route } from 'playwright'
import { BUDGETS, METRICS, PAIR_COUNTS, type Failure, type Metric, type PairSide } from './contracts.ts'
import { median } from './report.ts'
import { startProbe, type Probe } from '../soak/probe.ts'
import type { ProbeRecord } from '../soak/contracts.ts'
import type { SoakWindows } from '../soak/windows.ts'
import type { SoakWorld } from '../soak/world.ts'
import type { FloodStart, FloodStats, SpeedFixture, SpeedFixtureWorktree } from './fixtures.ts'
const MAX_BROWSER_TRACE_BYTES = 32 * 1024 * 1024

const DEADLINE_MS = 30_000
const OBSERVER_CLEANUP_MS = 2_000
const VIEWPORT = { width: 1400, height: 880 } as const
const CHANGES_PANEL = 'panel:quirky.git/source-control'
const DIFF_VIEW = 'view:quirky.git/diff'
const ECHO_KEYS = 'abcdefghijklmnopqrst'

export function pairSides(index: number): readonly [PairSide, PairSide] {
  return index % 2 === 1 ? ['head', 'base'] : ['base', 'head']
}

export function floodBlocks(count: number): { side: PairSide; first: number; count: number }[] {
  const firstHalf = Math.ceil(count / 2)
  const secondHalf = Math.floor(count / 2)
  const blocks: { side: PairSide; first: number; count: number }[] = []
  if (firstHalf > 0) blocks.push({ side: 'head', first: 1, count: firstHalf })
  if (firstHalf > 0) blocks.push({ side: 'base', first: 1, count: firstHalf })
  if (secondHalf > 0) blocks.push({ side: 'base', first: firstHalf + 1, count: secondHalf })
  if (secondHalf > 0) blocks.push({ side: 'head', first: firstHalf + 1, count: secondHalf })
  return blocks
}

export type FramePacing = { frames: number; medianIntervalMs: number; p90IntervalMs: number; maxIntervalMs: number }

/** Summarizes drawing-frame intervals; rejects missing or invalid pacing evidence. */
export function summarizeFrameIntervals(intervalsMs: readonly number[]): FramePacing {
  if (intervalsMs.length === 0 || intervalsMs.some(interval => !Number.isFinite(interval) || interval <= 0)) {
    const raw = JSON.stringify(intervalsMs, (_key, value: unknown) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value)
    throw new Error(`frame pacing needs positive finite intervals: ${raw}`)
  }
  const sorted = [...intervalsMs].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return {
    frames: sorted.length,
    medianIntervalMs: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p90IntervalMs: sorted[Math.ceil(0.9 * sorted.length) - 1]!,
    maxIntervalMs: sorted[sorted.length - 1]!
  }
}

type SpeedWorktree = SpeedFixtureWorktree
type RestartableWorld = SoakWorld

type BrowserObservationSpec = {
  id: string
  kind: 'echo' | 'switch' | 'diff' | 'flood'
  workerId?: string
  sessionId?: string
  sequence?: number
  key?: string
  targetId?: string
  diffPath?: string
  firstLine?: string
  afterCounter?: number
  offeredBytes?: number
}

type BrowserObservationResult = {
  id: string
  kind: BrowserObservationSpec['kind']
  startedAt: number
  endedAt: number
  durationMs: number
  counter?: number
  trace: { event: string; at: number }[]
}

function echoTimingPhases(observation: BrowserObservationResult): { eventToDomMs: number; domToPaintMs: number } {
  const eventAt = observation.trace.find(({ event }) => event === 'keydown')?.at
  const domAt = observation.trace.find(({ event }) => event === 'dom')?.at
  const paintAt = observation.trace.find(({ event }) => event === 'paint')?.at
  const eventToDomMs = (domAt ?? Number.NaN) - (eventAt ?? Number.NaN)
  const domToPaintMs = (paintAt ?? Number.NaN) - (domAt ?? Number.NaN)
  if (![eventAt, domAt, paintAt, eventToDomMs, domToPaintMs].every(Number.isFinite)
    || eventToDomMs < 0 || domToPaintMs < 0
    || Math.abs(eventToDomMs + domToPaintMs - observation.durationMs) > 0.001) {
    throw new Error('browser echo observer returned invalid event-to-paint timing phases')
  }
  return { eventToDomMs, domToPaintMs }
}

type ObserverEntry = {
  promise: Promise<BrowserObservationResult>
  dispose(error?: Error): void
}
type BrowserTraceSession = { stop(): Promise<string> }
type TraceComplete = { stream?: string; dataLossOccurred: boolean }

type SpeedSample = {
  metric: Metric
  phase: 'warmup' | 'sample' | 'diagnostic'
  sample: number
  durationMs: number | null
  startedAt: number | null
  endedAt: number | null
  worktreeId: string | null
  sessionId: string | null
  destinationWorktreeId: string | null
  destinationSessionId: string | null
  phases: Record<string, number | null>
  fixture: { worktrees: number; terminals: number; sessions: string[]; worktreeIds: string[] }
  daemonPid: number | null
  ptyHostPid: number | null
  ownedPids: number[]
  flood?: Record<string, number | string | null>
}

type MeasurementAttempt = SpeedSample & { side?: PairSide }
type PairAttempt = SpeedSample & { side: PairSide }

export type SpeedMeasurementResult = {
  samples: Record<Metric, number[]>
  attempts: SpeedSample[]
  failures: Failure[]
  diagnostics: string[]
  diagnosticErrors: string[]
  ownedPids: number[]
  redactions: string[]
  pair: {
    samples: Record<PairSide, Record<Metric, number[]>>
    attempts: PairAttempt[]
    failures: Failure[]
  } | null
}

type SessionSnapshot = { pids: Map<string, number>; ownedPids: number[] }
type MetricContext = {
  world: RestartableWorld
  windows: SoakWindows
  fixture: SpeedFixture
  browser: Browser
  page: Page
  context: BrowserContext
  signal: AbortSignal
  out: string
  samples: Record<Metric, number[]>
  attempts: MeasurementAttempt[]
  sessionPids: Map<string, number>
  ptyHostPid: number
  browserPid: number
  redactions: Set<string>
  sessionSequence: Map<string, number>
  currentWorktreeIndex: number
  side?: PairSide
}


/** Describes the measured operation and probe evidence without inferring a cause. */
export function diagnosticFinding(metric: Metric, observationMs: number, phases: Record<string, number | null>, probes: readonly ProbeRecord[]): string {
  const durationMs = metric === 'startup' ? phases.controllerUntilFreshPaintMs : observationMs
  if (durationMs === undefined || durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`${metric} duration is unavailable`)
  const phaseValues = Object.entries(phases).map(([key, value]) =>
    `${key}=${value === null ? 'unavailable' : `${value}${key.endsWith('Ms') ? ' ms' : ''}`}`
  )
  let maxLatencyMs: number | null = null
  let maxOwnLagMs: number | null = null
  for (const probe of probes) {
    maxLatencyMs = maxLatencyMs === null ? probe.ms : Math.max(maxLatencyMs, probe.ms)
    maxOwnLagMs = maxOwnLagMs === null ? probe.ownLagMs : Math.max(maxOwnLagMs, probe.ownLagMs)
  }
  return `Observed ${metric} durationMs=${durationMs} ms. Phases: ${phaseValues.join(', ') || 'unavailable'}. ` +
    `status.get probe count=${probes.length}, maxLatencyMs=${maxLatencyMs === null ? 'unavailable' : `${maxLatencyMs} ms`}, ` +
    `maxOwnLagMs=${maxOwnLagMs === null ? 'unavailable' : `${maxOwnLagMs} ms`}. Timings do not establish a root cause.`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeText(value: string, redactions: Iterable<string>): string {
  let result = value
  for (const secret of redactions) {
    if (secret) result = result.replaceAll(secret, '<redacted>')
  }
  return result
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
    .replace(/([#?&]token=)[^&#\s"']+/gi, '$1<redacted>')
}
function collectRuntimeSecrets(redactions: Set<string>, runtime: unknown): void {
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) return
  for (const [key, value] of Object.entries(runtime)) {
    if (/token/i.test(key) && typeof value === 'string' && value.length > 0) redactions.add(value)
  }
}

function cssValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid object`)
  return value as Record<string, unknown>
}

function terminalPaneSelector(sessionId: string): string {
  return `.qt-pane[data-session="${cssValue(sessionId)}"]`
}

function inputSelector(sessionId: string): string {
  return `${terminalPaneSelector(sessionId)} textarea.xterm-helper-textarea`
}

function worktreeButtonSelector(worktreeId: string): string {
  return `[data-worktree-id="${cssValue(worktreeId)}"] .worktree-row__main`
}

function diffRowSelector(path: string): string {
  return `li.git-row[data-row-path="${cssValue(path)}"]`
}


/** Installs a browser-local event and DOM observer; Playwright serializes this self-contained function into the page. */
export function installBrowserObserver(spec: BrowserObservationSpec): void {
  type FrameObserver = {
    afterFrame(frame: number): void
    afterTask(frame: number): void
  }
  type FrameHook = {
    originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame
    originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame
    wrappedRequestAnimationFrame: typeof globalThis.requestAnimationFrame
    observers: Set<FrameObserver>
    channel: MessageChannel
    frameId: number | null
    callbackSequence: number
    taskPending: boolean
    active: boolean
    afterCallback(): void
    ensureFrame(): void
  }
  const root = globalThis as typeof globalThis & {
    __quirkySpeedObservers?: Map<string, ObserverEntry>
    __quirkySpeedFrameHook?: FrameHook
  }
  const document = root.document
  const paneSelector = spec.sessionId === undefined ? '' : `.qt-pane[data-session="${spec.sessionId.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`
  const actionSelector = spec.kind === 'echo'
    ? `${paneSelector} textarea.xterm-helper-textarea`
    : spec.kind === 'switch'
      ? `[data-worktree-id="${spec.targetId}"] .worktree-row__main`
      : spec.kind === 'diff'
        ? `li.git-row[data-row-path="${spec.diffPath}"]`
        : ''
  const pane = spec.kind === 'switch' || spec.kind === 'diff' ? null : document.querySelector(paneSelector)
  const actionTarget = spec.kind === 'flood' ? null : document.querySelector(actionSelector)
  const rows = pane?.querySelector('.xterm-rows')
  if (spec.kind === 'echo' && (!pane || !rows || !pane.querySelector('textarea.xterm-helper-textarea'))) {
    throw new Error(`missing terminal pane or input for session ${spec.sessionId ?? '<unknown>'}`)
  }
  if (spec.kind === 'switch' && !actionTarget) throw new Error(`missing worktree selector for ${spec.targetId ?? '<unknown>'}`)
  if (spec.kind === 'diff' && !actionTarget) throw new Error(`missing Changes row for ${spec.diffPath ?? '<unknown>'}`)
  if (spec.kind === 'flood' && (!pane || !rows)) throw new Error(`missing flood terminal for session ${spec.sessionId ?? '<unknown>'}`)

  const state = root.__quirkySpeedObservers ?? new Map<string, ObserverEntry>()
  root.__quirkySpeedObservers = state
  if (state.has(spec.id)) throw new Error(`duplicate browser observer ${spec.id}`)

  let hook = root.__quirkySpeedFrameHook
  if (!hook) {
    const channel = new root.MessageChannel()
    const created: FrameHook = {
      originalRequestAnimationFrame: root.requestAnimationFrame,
      originalCancelAnimationFrame: root.cancelAnimationFrame,
      wrappedRequestAnimationFrame: root.requestAnimationFrame,
      observers: new Set(),
      channel,
      frameId: null,
      callbackSequence: 0,
      taskPending: false,
      active: true,
      afterCallback() {
        if (!created.active) return
        const sequence = ++created.callbackSequence
        for (const observer of created.observers) observer.afterFrame(sequence)
        if (!created.taskPending && created.active) {
          created.taskPending = true
          created.channel.port2.postMessage(null)
        }
      },
      ensureFrame() {
        if (!created.active || created.frameId !== null) return
        created.frameId = created.originalRequestAnimationFrame.call(root, () => {
          created.frameId = null
          created.afterCallback()
          created.ensureFrame()
        })
      }
    }
    hook = created
    channel.port1.onmessage = () => {
      if (!created.active) return
      created.taskPending = false
      for (const observer of created.observers) observer.afterTask(created.callbackSequence)
    }
    created.wrappedRequestAnimationFrame = (callback: FrameRequestCallback) => {
      return created.originalRequestAnimationFrame.call(root, (time) => {
        try {
          callback(time)
        } finally {
          created.afterCallback()
        }
      })
    }
    root.__quirkySpeedFrameHook = created
    root.requestAnimationFrame = created.wrappedRequestAnimationFrame
    created.ensureFrame()
  }

  let startAt: number | null = spec.kind === 'flood' ? root.performance.now() : null
  let finished = false
  let readyFrame: number | null = null
  let domAtFrame: number | null = null
  let counterAtFrame: number | undefined
  const trace: BrowserObservationResult['trace'] = []
  const { promise, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers<BrowserObservationResult>()
  void promise.catch(() => undefined)

  const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const visible = (element: Element | null): element is Element => Boolean(element)
    && !(element as HTMLElement).hidden
    && typeof (element as HTMLElement).getClientRects === 'function'
    && (element as HTMLElement).getClientRects().length > 0
  const paneForSession = (): Element | null => spec.sessionId === undefined ? null : document.querySelector(paneSelector)
  const hasEchoAck = (): boolean => {
    const text = normalized(rows?.textContent ?? '')
    const expected = [spec.workerId, spec.sessionId, String(spec.sequence), spec.key]
      .map((part) => escapeRegex(part ?? '')).join('\\s+')
    return new RegExp(`SPEED_ECHO\\s+${expected}(?:\\s|$)`).test(text)
  }
  const hasSwitchReady = (): boolean => {
    const button = document.querySelector(`[data-worktree-id="${spec.targetId}"] .worktree-row__main`)
    if (button?.getAttribute('aria-pressed') !== 'true' || !spec.sessionId) return false
    const targetPane = paneForSession()
    const targetRows = targetPane?.querySelector('.xterm-rows') ?? null
    const targetInput = targetPane?.querySelector('textarea.xterm-helper-textarea') ?? null
    return visible(targetPane) && visible(targetRows) && visible(targetInput) && !(targetInput as HTMLTextAreaElement).disabled
      && (targetInput as HTMLTextAreaElement).tabIndex >= 0
  }
  const hasDiffReady = (): boolean => {
    const path = spec.diffPath?.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const card = path ? document.querySelector(`.git-review__card[data-path="${path}"]`) : null
    if (!card) return false
    const body = card.querySelector('[data-review-body]') as HTMLElement | null
    const editor = card.querySelector('[data-diff-editor] .cm-content') as HTMLElement | null
    if (!visible(body) || !visible(editor) || !spec.firstLine || !(editor.textContent ?? '').includes(spec.firstLine)) return false
    const notices = card.querySelectorAll('.git-review__notice, [role="alert"], [role="region"]')
    for (const notice of notices) {
      if (!visible(notice)) continue
      const text = normalized(notice.textContent ?? '')
      if (/loading diff|unable to load|large diff|too large|not rendered by default/i.test(text)) return false
    }
    return true
  }
  const floodCounter = (): number | null => {
    const text = normalized(rows?.textContent ?? '')
    const marker = new RegExp(`SPEED_FLOOD\\s+${escapeRegex(spec.workerId ?? '')}\\s+${escapeRegex(spec.sessionId ?? '')}\\s+(\\d+)\\s+${Number(spec.offeredBytes)}`, 'g')
    let latest: number | null = null
    for (const match of text.matchAll(marker)) {
      const value = Number(match[1])
      if (Number.isSafeInteger(value) && (latest === null || value > latest)) latest = value
    }
    return latest
  }
  const condition = (): { ready: boolean; counter?: number } => {
    if (spec.kind === 'echo') return { ready: hasEchoAck() }
    if (spec.kind === 'switch') return { ready: hasSwitchReady() }
    if (spec.kind === 'diff') return { ready: hasDiffReady() }
    const counter = floodCounter()
    return { ready: counter !== null && counter > (spec.afterCounter ?? 0), ...(counter === null ? {} : { counter }) }
  }
  const releaseHook = () => {
    if (hook.observers.size > 0) return
    hook.active = false
    if (hook.frameId !== null) hook.originalCancelAnimationFrame.call(root, hook.frameId)
    hook.frameId = null
    hook.channel.port1.onmessage = null
    hook.channel.port1.close()
    hook.channel.port2.close()
    root.requestAnimationFrame = hook.originalRequestAnimationFrame
    delete root.__quirkySpeedFrameHook
  }
  const cleanup = () => {
    if (spec.kind !== 'flood') document.removeEventListener(spec.kind === 'echo' ? 'keydown' : 'click', onAction, true)
    hook.observers.delete(frameObserver)
    releaseHook()
  }
  const finish = (error?: Error, counter?: number) => {
    if (finished) return
    finished = true
    cleanup()
    if (error) {
      rejectResult(error)
      return
    }
    const endedAt = root.performance.now()
    const startedAt = startAt
    if (startedAt === null || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
      rejectResult(new Error(`browser observer ${spec.id} returned invalid timing boundaries`))
      return
    }
    trace.push({ event: 'paint', at: endedAt })
    resolveResult({
      id: spec.id,
      kind: spec.kind,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...(counter === undefined ? {} : { counter }),
      trace
    })
  }
  const frameObserver: FrameObserver = {
    afterFrame(frame) {
      if (finished || startAt === null) return
      try {
        const current = condition()
        if (!current.ready) {
          readyFrame = null
          domAtFrame = null
          counterAtFrame = undefined
          return
        }
        readyFrame = frame
        domAtFrame = root.performance.now()
        counterAtFrame = current.counter
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    },
    afterTask(frame) {
      if (finished || readyFrame !== frame || domAtFrame === null) return
      const domAt = domAtFrame
      const counter = counterAtFrame
      readyFrame = null
      domAtFrame = null
      counterAtFrame = undefined
      try {
        const afterFrame = condition()
        if (!afterFrame.ready) return
        trace.push({ event: 'dom', at: domAt })
        finish(undefined, counter ?? afterFrame.counter)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  const onAction = (event: Event & { key?: string }) => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function' || !(target as Element).closest(actionSelector)) return
    if (spec.kind === 'echo' && event.key !== spec.key) return
    if (startAt !== null) return
    startAt = root.performance.now()
    trace.push({ event: spec.kind === 'echo' ? 'keydown' : 'click', at: startAt })
  }
  const entry: ObserverEntry = {
    promise,
    dispose(error = new Error(`browser observer ${spec.id} was disposed`)) {
      if (finished) return
      finish(error)
    }
  }
  if (spec.kind !== 'flood') document.addEventListener(spec.kind === 'echo' ? 'keydown' : 'click', onAction, true)
  state.set(spec.id, entry)
  hook.observers.add(frameObserver)
  hook.ensureFrame()
}

/** Waits on the in-page observer promise without polling, and always removes its listeners. */
export async function waitForBrowserObserver(
  page: Pick<Page, 'evaluate'>,
  id: string,
  timeoutMs = DEADLINE_MS,
  signal?: AbortSignal,
  closeOwnedContext?: () => Promise<void>,
  cleanupTimeoutMs = OBSERVER_CLEANUP_MS
): Promise<BrowserObservationResult> {
  const pending = page.evaluate((observerId) => {
    const root = globalThis as typeof globalThis & { __quirkySpeedObservers?: Map<string, ObserverEntry> }
    const entry = root.__quirkySpeedObservers?.get(observerId)
    if (!entry) throw new Error(`browser observer ${observerId} is missing`)
    return entry.promise
  }, id)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`browser observer ${id} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const interrupted = signal === undefined ? new Promise<never>(() => undefined) : new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('speed measurement interrupted'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    return await Promise.race([pending, timeout, interrupted])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    await cancelBrowserObserver(page, id, 'browser observer completed or stopped', closeOwnedContext, cleanupTimeoutMs)
  }
}

async function cancelBrowserObserver(
  page: Pick<Page, 'evaluate'>,
  id: string,
  message: string,
  closeOwnedContext?: () => Promise<void>,
  timeoutMs = OBSERVER_CLEANUP_MS
): Promise<void> {
  try {
    await withDeadline(page.evaluate(({ observerId, reason }) => {
      const root = globalThis as typeof globalThis & { __quirkySpeedObservers?: Map<string, ObserverEntry> }
      const observers = root.__quirkySpeedObservers
      observers?.get(observerId)?.dispose(new Error(reason))
      observers?.delete(observerId)
    }, { observerId: id, reason: message }), timeoutMs, `observer ${id} disposal`)
  } catch (error) {
    if (!closeOwnedContext) throw new Error(`observer ${id} teardown timed out: ${errorText(error)}`)
    try {
      await withDeadline(closeOwnedContext(), timeoutMs, `observer ${id} renderer close`)
    } catch (closeError) {
      throw new Error(`observer ${id} teardown timed out and renderer close failed: ${errorText(closeError)}`)
    }
    throw new Error(`observer ${id} teardown timed out; owned context was closed`)
  }
}

function withDeadline<T>(task: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error: Error | null, value?: T) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (error) reject(error)
    else resolve(value as T)
  }
  const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('speed measurement interrupted'))
  timer = setTimeout(() => finish(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  task.then((value) => finish(null, value), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  return promise
}

function fixtureDescriptor(fixture: SpeedFixture): SpeedSample['fixture'] {
  return {
    worktrees: fixture.worktrees.length,
    terminals: fixture.worktrees.reduce((count, worktree) => count + worktree.sessions.length, 0),
    sessions: fixture.worktrees.flatMap((worktree) => [...worktree.sessions]),
    worktreeIds: fixture.worktrees.map((worktree) => worktree.id)
  }
}

async function sessionSnapshot(world: RestartableWorld, expectedIds: string[], knownPids?: Map<string, number>): Promise<SessionSnapshot> {
  const response = record(await world.control.callAny('quirky.terminal/sessions', {}, { timeoutMs: 5_000 }), 'quirky.terminal/sessions')
  if (!Array.isArray(response.sessions)) throw new Error('quirky.terminal/sessions returned no session list')
  const rows = response.sessions.map((value) => record(value, 'terminal session'))
  if (rows.length !== expectedIds.length) throw new Error(`expected ${expectedIds.length} live PTY sessions, found ${rows.length}`)
  const pids = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.sessionId !== 'string' || typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 1 || row.alive !== true) {
      throw new Error('a fixture PTY session is missing, exited, or has an invalid process identity')
    }
    if (pids.has(row.sessionId)) throw new Error(`terminal session ${row.sessionId} was reported more than once`)
    pids.set(row.sessionId, row.pid)
  }
  for (const id of expectedIds) {
    const pid = pids.get(id)
    if (pid === undefined) throw new Error(`fixture PTY session ${id} disappeared`)
    const expectedPid = knownPids?.get(id)
    if (expectedPid !== undefined && expectedPid !== pid) throw new Error(`fixture PTY session ${id} was replaced`)
  }
  if (pids.size !== expectedIds.length) throw new Error('fixture session identity set changed')
  return { pids, ownedPids: [...new Set(pids.values())] }
}

async function ensurePageAlive(page: Page, browser: Browser): Promise<void> {
  if (page.isClosed() || !browser.isConnected()) throw new Error('Chromium page or browser crashed')
}

async function routeLoopback(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    let url: URL
    try {
      url = new URL(route.request().url())
    } catch {
      await route.abort()
      return
    }
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') await route.continue()
    else await route.abort()
  })
}


async function observeAction(
  page: Page,
  spec: BrowserObservationSpec,
  action: () => Promise<unknown>,
  signal: AbortSignal,
  timeoutMs = DEADLINE_MS
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number }> {
  if (signal.aborted) throw new Error('speed measurement interrupted')
  const browser = page.context().browser()
  if (!browser) throw new Error('Chromium page is disconnected from its browser')
  await ensurePageAlive(page, browser)
  const closeContext = () => page.context().close()
  try {
    await withDeadline(page.evaluate(installBrowserObserver, spec), timeoutMs, `${spec.kind} observer install`, signal)
  } catch (error) {
    await cancelBrowserObserver(page, spec.id, errorText(error), closeContext)
    throw error
  }
  const beganAt = performance.now()
  const observationPromise = waitForBrowserObserver(page, spec.id, timeoutMs, signal, closeContext)
  try {
    await withDeadline(action(), timeoutMs, `${spec.kind} action`, signal)
    const observation = await observationPromise
    await ensurePageAlive(page, browser)
    const controllerActionMs = performance.now() - beganAt
    if (!Number.isFinite(controllerActionMs) || controllerActionMs <= 0) throw new Error(`${spec.kind} controller phase returned invalid timing`)
    return { observation, controllerActionMs }
  } catch (error) {
    let cleanupError: unknown
    try {
      await cancelBrowserObserver(page, spec.id, errorText(error), closeContext)
    } catch (caught) {
      cleanupError = caught
    }
    await withDeadline(observationPromise, OBSERVER_CLEANUP_MS, `${spec.kind} observer waiter cleanup`).catch(() => undefined)
    if (cleanupError !== undefined) throw new Error(`${errorText(error)}; ${errorText(cleanupError)}`)
    throw error
  }
}

async function waitForTerminalVisible(page: Page, worktree: SpeedWorktree, sessionIndex = 0, timeoutMs = DEADLINE_MS): Promise<void> {
  const sessionId = worktree.sessions[sessionIndex]!
  const pane = terminalPaneSelector(sessionId)
  const input = inputSelector(sessionId)
  await page.locator(pane).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator(`${pane} .xterm-rows`).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator(input).waitFor({ state: 'visible', timeout: timeoutMs })
}

async function focusEcho(page: Page, worktree: SpeedWorktree, timeoutMs = DEADLINE_MS): Promise<void> {
  const sessionId = worktree.sessions[0]
  const selector = inputSelector(sessionId)
  await page.locator(selector).focus({ timeout: timeoutMs })
  const focused = await page.locator(selector).evaluate((element) => document.activeElement === element)
  if (!focused) throw new Error(`echo input for session ${sessionId} did not receive focus`)
}

async function echoTrial(
  page: Page,
  worktree: SpeedWorktree,
  sequence: number,
  key: string,
  signal: AbortSignal,
  timeoutMs = DEADLINE_MS
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number }> {
  await waitForTerminalVisible(page, worktree, 0, timeoutMs)
  await focusEcho(page, worktree, timeoutMs)
  const sessionId = worktree.sessions[0]
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'echo', workerId: worktree.workerIds[0], sessionId,
    sequence, key
  }
  return await observeAction(page, spec, () => page.keyboard.press(key), signal, timeoutMs)
}



async function switchTrial(
  page: Page,
  worktree: SpeedWorktree,
  signal: AbortSignal
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number }> {
  const selector = worktreeButtonSelector(worktree.id)
  await page.locator(selector).waitFor({ state: 'visible', timeout: DEADLINE_MS })
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'switch', targetId: worktree.id, sessionId: worktree.sessions[0]
  }
  return await observeAction(page, spec, () => page.locator(selector).click({ timeout: DEADLINE_MS }), signal)
}

async function reviewTabs(world: RestartableWorld, worktreeId: string): Promise<string[]> {
  const response = record(await world.control.callAny('quirky.terminal/workspace', { workspace: `id:${worktreeId}` }, { timeoutMs: 5_000 }), 'quirky.terminal/workspace')
  const workspace = record(response.workspace, 'terminal workspace')
  const ids: string[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const value = node as Record<string, unknown>
    if (value.kind === 'group' && Array.isArray(value.tabs)) {
      for (const raw of value.tabs) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const tab = raw as Record<string, unknown>
        const input = tab.input && typeof tab.input === 'object' && !Array.isArray(tab.input)
          ? tab.input as Record<string, unknown>
          : {}
        if (tab.kind === 'view' && tab.viewId === DIFF_VIEW && tab.id && input.mode === 'review') ids.push(String(tab.id))
      }
      return
    }
    if (value.kind === 'split') {
      visit(value.first)
      visit(value.second)
    }
  }
  visit(workspace.root)
  return ids
}

async function closeHostedReview(page: Page, world: RestartableWorld, worktreeId: string): Promise<void> {
  for (const tab of await reviewTabs(world, worktreeId)) {
    await world.control.callAny('quirky.terminal/closeTab', { tab }, { timeoutMs: 5_000 })
  }
  await page.waitForFunction(() => !document.querySelector('[data-review-tab] [data-diff-editor]'), undefined, { timeout: DEADLINE_MS })
  if (await page.locator('[data-review-tab] [data-diff-editor]').count() !== 0) throw new Error('the prior Review editor remained mounted')
}

async function prepareDiffRow(context: MetricContext): Promise<void> {
  await closeHostedReview(context.page, context.world, context.fixture.target.id)
  await context.world.control.callAny('ui.tool.open', { id: CHANGES_PANEL }, { timeoutMs: 5_000 })
  await context.page.locator(diffRowSelector(context.fixture.diffPath)).waitFor({ state: 'visible', timeout: DEADLINE_MS })
}

async function diffTrial(context: MetricContext, signal: AbortSignal): Promise<{ observation: BrowserObservationResult; controllerActionMs: number }> {
  await prepareDiffRow(context)
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'diff', diffPath: context.fixture.diffPath, firstLine: context.fixture.firstLine
  }
  const selector = diffRowSelector(context.fixture.diffPath)
  return await observeAction(context.page, spec, () => context.page.locator(selector).click({ timeout: DEADLINE_MS }), signal)
}

async function verifyPublicDiff(context: MetricContext): Promise<number> {
  const beganAt = performance.now()
  const value = record(await context.world.control.callAny('quirky.git/diff', {
    worktree: context.fixture.target.id,
    path: context.fixture.diffPath,
    source: 'review',
    against: 'base'
  }, { timeoutMs: DEADLINE_MS }), 'quirky.git/diff')
  const duration = performance.now() - beganAt
  if (value.path !== context.fixture.diffPath || value.kind !== 'text' || value.binary !== false
    || value.tooLarge !== undefined || typeof value.modified !== 'string' || value.original !== '') {
    throw new Error('public quirky.git/diff did not return the expected text fixture')
  }
  const lineCount = (value.modified as string).split('\n').length - ((value.modified as string).endsWith('\n') ? 1 : 0)
  if (lineCount !== 5000 || !(value.modified as string).startsWith(context.fixture.firstLine)) {
    throw new Error(`public quirky.git/diff returned ${lineCount} additions instead of 5000`)
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('public diff RPC phase returned invalid timing')
  return duration
}

async function renderedFloodCounter(page: Pick<Page, 'evaluate'>, worktree: SpeedWorktree): Promise<number | null> {
  return await page.evaluate(({ sessionId, workerId }) => {
    const pane = document.querySelector(`.qt-pane[data-session="${sessionId.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
    const text = (pane?.querySelector('.xterm-rows')?.textContent ?? '').replace(/\s+/g, ' ')
    const pattern = new RegExp(`SPEED_FLOOD\\s+${workerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)\\s+65536`, 'g')
    let latest: number | null = null
    for (const match of text.matchAll(pattern)) {
      const counter = Number(match[1])
      if (Number.isSafeInteger(counter) && (latest === null || counter > latest)) latest = counter
    }
    return latest
  }, { sessionId: worktree.sessions[1], workerId: worktree.workerIds[1] })
}

function validateFloodStart(start: FloodStart, worktree: SpeedWorktree): void {
  if (start.workerId !== worktree.workerIds[1] || start.sessionId !== worktree.sessions[1]
    || typeof start.runId !== 'string' || start.runId.length === 0
    || start.offeredBytesPerChunk !== 65_536 || start.intervalMs !== 16
    || start.offeredBytesPerSecond !== 4_096_000 || !Number.isFinite(start.startedAt)) {
    throw new Error('flood worker identity or offered workload does not match the active worktree')
  }
}

function validateFloodStats(stats: FloodStats, start: FloodStart): void {
  if (stats.workerId !== start.workerId || stats.sessionId !== start.sessionId || stats.runId !== start.runId
    || stats.offeredBytesPerChunk !== 65_536 || stats.intervalMs !== 16
    || stats.offeredBytesPerSecond !== 4_096_000
    || !Number.isSafeInteger(stats.bytesWritten) || stats.bytesWritten <= 0
    || !Number.isSafeInteger(stats.firstCounter) || !Number.isSafeInteger(stats.lastCounter)
    || stats.lastCounter <= stats.firstCounter || !Number.isFinite(stats.elapsedMs) || stats.elapsedMs <= 0) {
    throw new Error('flood worker did not report complete forward progress and throughput')
  }
}

async function beginFlood(context: MetricContext, signal: AbortSignal): Promise<{ start: FloodStart; renderedCounter: number }> {
  const worktree = context.fixture.target
  await waitForTerminalVisible(context.page, worktree, 1)
  const before = await renderedFloodCounter(context.page, worktree)
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'flood', workerId: worktree.workerIds[1], sessionId: worktree.sessions[1],
    afterCounter: before ?? 0, offeredBytes: 65_536
  }
  const closeContext = () => context.page.context().close()
  try {
    await withDeadline(context.page.evaluate(installBrowserObserver, spec), DEADLINE_MS, 'flood observer install', signal)
  } catch (error) {
    await cancelBrowserObserver(context.page, spec.id, errorText(error), closeContext)
    throw error
  }
  const progress = waitForBrowserObserver(context.page, spec.id, DEADLINE_MS, signal, closeContext)
  try {
    const start = await withDeadline(context.fixture.startFlood(worktree.id), DEADLINE_MS, 'flood start', signal)
    validateFloodStart(start, worktree)
    const visible = await progress
    if (visible.counter === undefined) throw new Error('flood progress was not rendered in its terminal pane')
    return { start, renderedCounter: visible.counter }
  } catch (error) {
    let cleanupError: unknown
    try {
      await cancelBrowserObserver(context.page, spec.id, errorText(error), closeContext)
    } catch (caught) {
      cleanupError = caught
    }
    await withDeadline(progress, OBSERVER_CLEANUP_MS, 'flood observer waiter cleanup').catch(() => undefined)
    try {
      await context.fixture.stopFlood()
    } catch (stopError) {
      cleanupError = cleanupError === undefined ? stopError : new Error(`${errorText(cleanupError)}; ${errorText(stopError)}`)
    }
    if (cleanupError !== undefined) throw new Error(`${errorText(error)}; flood cleanup failed: ${errorText(cleanupError)}`)
    throw error
  }
}

export async function waitForFloodProgressAfterSnapshot(
  page: Pick<Page, 'evaluate'>,
  worktree: SpeedWorktree,
  start: FloodStart,
  signal: AbortSignal,
  closeOwnedContext?: () => Promise<void>,
  timeoutMs = DEADLINE_MS
): Promise<{ beforeCounter: number; afterCounter: number }> {
  const deadline = performance.now() + timeoutMs
  let beforeCounter = await withDeadline(renderedFloodCounter(page, worktree), timeoutMs, 'final rendered flood counter snapshot', signal)
  const observeNext = async (afterCounter: number): Promise<number> => {
    const spec: BrowserObservationSpec = {
      id: randomUUID(), kind: 'flood', workerId: start.workerId, sessionId: start.sessionId,
      afterCounter, offeredBytes: start.offeredBytesPerChunk
    }
    try {
      await withDeadline(page.evaluate(installBrowserObserver, spec), Math.max(1, deadline - performance.now()), 'flood progress observer install', signal)
    } catch (error) {
      await cancelBrowserObserver(page, spec.id, errorText(error), closeOwnedContext)
      throw error
    }
    const observed = await waitForBrowserObserver(page, spec.id, Math.max(1, deadline - performance.now()), signal, closeOwnedContext)
    if (observed.counter === undefined || observed.counter <= afterCounter) {
      throw new Error('flood stream did not render a counter newer than its final echo snapshot')
    }
    return observed.counter
  }
  if (beforeCounter === null) beforeCounter = await observeNext(0)
  const afterCounter = await observeNext(beforeCounter)
  return { beforeCounter, afterCounter }
}

async function ensureSelectedWorktree(page: Page, worktree: SpeedWorktree, timeoutMs = DEADLINE_MS): Promise<void> {
  const selector = worktreeButtonSelector(worktree.id)
  await page.locator(selector).waitFor({ state: 'visible', timeout: timeoutMs })
  const pressed = await page.locator(selector).getAttribute('aria-pressed')
  if (pressed !== 'true') {
    await page.locator(selector).click({ timeout: timeoutMs })
    await page.waitForFunction(({ targetId }) => {
      const button = document.querySelector(`[data-worktree-id="${targetId}"] .worktree-row__main`)
      return button?.getAttribute('aria-pressed') === 'true'
    }, { targetId: worktree.id }, { timeout: timeoutMs })
  }
  await waitForTerminalVisible(page, worktree, 0, timeoutMs)
  await waitForTerminalVisible(page, worktree, 1, timeoutMs)
}

async function startupTrial(
  context: MetricContext,
  signal: AbortSignal,
  contextSet: Set<BrowserContext>
): Promise<{ durationMs: number; startedAt: number; endedAt: number; phases: Record<string, number | null>; daemonPid: number; ptyPid: number; ownedPids: number[]; observation: BrowserObservationResult }> {
  const worktree = context.fixture.target
  const sessionIds = context.fixture.worktrees.flatMap((item) => [...item.sessions])
  const before = await sessionSnapshot(context.world, sessionIds, context.sessionPids)
  const ptyBefore = context.world.ptyHostPid()
  if (ptyBefore === null || ptyBefore !== context.ptyHostPid) throw new Error('persistent PTY host changed before daemon restart')

  await withDeadline(context.context.close(), OBSERVER_CLEANUP_MS, 'previous browser context close')
  contextSet.delete(context.context)
  const opened = await openContext(context.browser, contextSet, signal)
  context.context = opened.context
  const page = opened.page
  context.page = page

  const restart = await withDeadline(context.world.restartDaemon(signal), DEADLINE_MS + 10_000, 'daemon restart', signal)
  const daemonReadyAt = performance.now()
  if (!Number.isFinite(restart.spawnedAt) || restart.spawnedAt <= 0 || restart.spawnedAt > daemonReadyAt) {
    throw new Error('daemon restart returned an invalid spawn boundary')
  }
  const startupDeadline = restart.spawnedAt + DEADLINE_MS
  const remaining = () => {
    const milliseconds = Math.ceil(startupDeadline - performance.now())
    if (milliseconds <= 0) throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
    return milliseconds
  }
  if (daemonReadyAt > startupDeadline) throw new Error(`startup timed out after ${DEADLINE_MS}ms during daemon health and connection`)

  const runtime = context.world.runtime
  collectRuntimeSecrets(context.redactions, runtime)
  const after = await withDeadline(
    sessionSnapshot(context.world, sessionIds, before.pids),
    remaining(),
    'startup session verification',
    signal
  )
  const ptyAfter = context.world.ptyHostPid()
  if (ptyAfter === null || ptyAfter !== ptyBefore) throw new Error('persistent PTY host changed during daemon restart')
  if (after.ownedPids.length === 0) throw new Error('startup did not preserve any owned session processes')

  const endpoint = async () => {
    const navigationBeganAt = performance.now()
    await page.goto(`http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining()
    })
    await page.locator('.shell-workspace').waitFor({ state: 'visible', timeout: remaining() })
    await ensureSelectedWorktree(page, worktree, remaining())
    const rendererReadyAt = performance.now()
    const sequence = (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1
    const readyEcho = await echoTrial(page, worktree, sequence, 'z', signal, remaining())
    context.sessionSequence.set(worktree.sessions[0], sequence)
    const endedAt = performance.now()
    if (endedAt > startupDeadline) throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
    return { navigationBeganAt, rendererReadyAt, readyEcho, endedAt }
  }
  const ready = await withDeadline(endpoint(), remaining(), 'startup renderer readiness', signal)
  const durationMs = ready.endedAt - restart.spawnedAt
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > DEADLINE_MS) {
    throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
  }
  const phases = {
    daemonHealthAndControlMs: daemonReadyAt - restart.spawnedAt,
    rendererNavigationAndAttachMs: ready.rendererReadyAt - ready.navigationBeganAt,
    readinessInputToPaintMs: ready.readyEcho.observation.durationMs,
    controllerUntilFreshPaintMs: durationMs
  }
  context.currentWorktreeIndex = 0
  return {
    durationMs, startedAt: restart.spawnedAt, endedAt: ready.endedAt, phases,
    daemonPid: context.world.daemonPid, ptyPid: ptyAfter,
    ownedPids: [...new Set([context.world.daemonPid, ptyAfter, context.browserPid, ...after.ownedPids])],
    observation: ready.readyEcho.observation
  }
}

function attempt(
  context: MetricContext,
  metric: Metric,
  phase: SpeedSample['phase'],
  sample: number,
  details: Partial<Pick<SpeedSample, 'worktreeId' | 'sessionId' | 'destinationWorktreeId' | 'destinationSessionId'>> = {}
): MeasurementAttempt {
  return {
    metric, phase, sample, durationMs: null, startedAt: null, endedAt: null,
    worktreeId: null, sessionId: null, destinationWorktreeId: null, destinationSessionId: null,
    phases: {}, fixture: fixtureDescriptor(context.fixture), daemonPid: context.world.daemonPid,
    ptyHostPid: context.world.ptyHostPid(), ownedPids: [...new Set([context.world.daemonPid, context.world.ptyHostPid() ?? -1, context.browserPid, ...context.sessionPids.values()])].filter((pid) => pid > 1),
    ...details,
    ...(context.side === undefined ? {} : { side: context.side })
  }
}

function recordTimed(context: MetricContext, row: SpeedSample, duration: number, start: number, end: number, phases: Record<string, number | null>): void {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`${row.metric} sample returned a nonfinite or nonpositive duration`)
  }
  row.durationMs = duration
  row.startedAt = start
  row.endedAt = end
  row.phases = phases
  context.attempts.push(row)
  if (row.phase === 'sample') context.samples[row.metric].push(duration)
}

function recordFailedAttempt(context: MetricContext, row: SpeedSample): void {
  if (!context.attempts.includes(row)) context.attempts.push(row)
}
async function recordStartupAttempt(
  context: MetricContext,
  phase: SpeedSample['phase'],
  sample: number,
  signal: AbortSignal,
  contextSet: Set<BrowserContext>
): Promise<void> {
  const worktree = context.fixture.target
  const row = attempt(context, 'startup', phase, sample, {
    worktreeId: worktree.id,
    sessionId: worktree.sessions[0]
  })
  try {
    const trial = await startupTrial(context, signal, contextSet)
    row.ownedPids = trial.ownedPids
    row.phases = trial.phases
    row.daemonPid = trial.daemonPid
    row.ptyHostPid = trial.ptyPid
    recordTimed(context, row, trial.durationMs, trial.startedAt, trial.endedAt, trial.phases)
  } catch (error) {
    recordFailedAttempt(context, row)
    throw error
  }
}


async function runEchoAttempt(context: MetricContext, phase: SpeedSample['phase'], sample: number, key: string, signal: AbortSignal): Promise<void> {
  const worktree = context.fixture.target
  const sequence = (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1
  const row = attempt(context, phase === 'diagnostic' ? 'echo' : 'echo', phase, sample, {
    worktreeId: worktree.id, sessionId: worktree.sessions[0]
  })
  try {
    const startedController = performance.now()
    const result = await echoTrial(context.page, worktree, sequence, key, signal)
    const endedController = performance.now()
    context.sessionSequence.set(worktree.sessions[0], sequence)
    const timing = echoTimingPhases(result.observation)
    recordTimed(context, row, result.observation.durationMs, result.observation.startedAt, result.observation.endedAt, {
      controllerActionMs: result.controllerActionMs,
      browserEventToPaintMs: result.observation.durationMs,
      eventToDomMs: timing.eventToDomMs,
      domToPaintMs: timing.domToPaintMs,
      controllerWholeTrialMs: endedController - startedController
    })
    row.worktreeId = worktree.id
    row.sessionId = worktree.sessions[0]
  } catch (error) {
    recordFailedAttempt(context, row)
    throw error
  }
}

async function runSwitchAttempt(context: MetricContext, phase: SpeedSample['phase'], sample: number, worktree: SpeedWorktree, signal: AbortSignal): Promise<void> {
  const row = attempt(context, 'switch', phase, sample, { destinationWorktreeId: worktree.id, destinationSessionId: worktree.sessions[0] })
  try {
    const beganAt = performance.now()
    const result = await switchTrial(context.page, worktree, signal)
    const endedAt = performance.now()
    context.currentWorktreeIndex = context.fixture.worktrees.findIndex((candidate) => candidate.id === worktree.id)
    recordTimed(context, row, result.observation.durationMs, result.observation.startedAt, result.observation.endedAt, {
      controllerActionMs: result.controllerActionMs,
      browserClickToUsableTerminalMs: result.observation.durationMs,
      controllerWholeTrialMs: endedAt - beganAt
    })
  } catch (error) {
    recordFailedAttempt(context, row)
    throw error
  }
}

async function runDiffAttempt(context: MetricContext, phase: SpeedSample['phase'], sample: number, signal: AbortSignal): Promise<void> {
  const row = attempt(context, 'diff', phase, sample, { worktreeId: context.fixture.target.id })
  try {
    const beganAt = performance.now()
    const result = await diffTrial(context, signal)
    const endedAt = performance.now()
    row.worktreeId = context.fixture.target.id
    recordTimed(context, row, result.observation.durationMs, result.observation.startedAt, result.observation.endedAt, {
      controllerActionMs: result.controllerActionMs,
      browserClickToCodeMirrorPaintMs: result.observation.durationMs,
      controllerWholeTrialMs: endedAt - beganAt
    })
  } catch (error) {
    recordFailedAttempt(context, row)
    throw error
  }
}

async function runFloodEchoSeries(context: MetricContext, sampleCount: number, signal: AbortSignal, firstSample = 1): Promise<void> {
  const firstAttemptIndex = context.attempts.length
  await closeHostedReview(context.page, context.world, context.fixture.target.id)
  await ensureSelectedWorktree(context.page, context.fixture.target)
  context.currentWorktreeIndex = 0
  const flood = await beginFlood(context, signal)
  let finalRenderedCounter = flood.renderedCounter
  let failure: unknown
  let failurePhase: SpeedSample['phase'] = 'warmup'
  let failureSample = firstSample
  let stats: FloodStats | undefined
  try {
    for (let warmup = 1; warmup <= 2; warmup++) {
      failurePhase = 'warmup'
      failureSample = warmup
      await runFloodEchoAttempt(context, 'warmup', warmup, ECHO_KEYS[warmup - 1]!, signal)
    }
    for (let offset = 0; offset < sampleCount; offset++) {
      const sample = firstSample + offset
      failurePhase = 'sample'
      failureSample = sample
      await runFloodEchoAttempt(context, 'sample', sample, ECHO_KEYS[(sample + 1) % ECHO_KEYS.length]!, signal)
    }
    failurePhase = 'sample'
    failureSample = firstSample + sampleCount - 1
    const progress = await waitForFloodProgressAfterSnapshot(
      context.page,
      context.fixture.target,
      flood.start,
      signal,
      () => context.context.close()
    )
    finalRenderedCounter = progress.afterCounter
  } catch (error) {
    failure = error
  } finally {
    try {
      stats = await context.fixture.stopFlood()
    } catch (error) {
      failure = failure === undefined
        ? error
        : new Error(`${errorText(failure)}; flood cleanup failed: ${errorText(error)}`)
    }
  }
  if (failure !== undefined) throw new MeasurementFailure('floodEcho', failureSample, failurePhase, failure)
  if (!stats) throw new MeasurementFailure('floodEcho', firstSample + sampleCount - 1, 'sample', new Error('flood cleanup returned no statistics'))
  validateFloodStats(stats, flood.start)
  const actualBytesPerSecond = stats.bytesWritten * 1000 / stats.elapsedMs
  const floodEvidence: Record<string, number | string | null> = {
    runId: stats.runId, workerId: stats.workerId, sessionId: stats.sessionId,
    offeredBytesPerChunk: stats.offeredBytesPerChunk, intervalMs: stats.intervalMs,
    offeredBytesPerSecond: stats.offeredBytesPerSecond, bytesWritten: stats.bytesWritten,
    actualBytesPerSecond, firstCounter: stats.firstCounter, lastCounter: stats.lastCounter,
    elapsedMs: stats.elapsedMs, renderedStartCounter: flood.renderedCounter, renderedEndCounter: finalRenderedCounter
  }
  for (const row of context.attempts.slice(firstAttemptIndex)) {
    if (row.metric === 'floodEcho' && row.phase !== 'diagnostic') row.flood = floodEvidence
  }
}

async function runFloodEchoAttempt(context: MetricContext, phase: SpeedSample['phase'], sample: number, key: string, signal: AbortSignal): Promise<void> {
  const worktree = context.fixture.target
  const row = attempt(context, 'floodEcho', phase, sample, { worktreeId: worktree.id, sessionId: worktree.sessions[0] })
  try {
    const busyPane = `${terminalPaneSelector(worktree.sessions[1])} .xterm-rows`
    await context.page.locator(busyPane).waitFor({ state: 'visible', timeout: DEADLINE_MS })
    const beganAt = performance.now()
    const result = await echoTrial(context.page, worktree, (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1, key, signal)
    const endedAt = performance.now()
    context.sessionSequence.set(worktree.sessions[0], (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1)
    const timing = echoTimingPhases(result.observation)
    recordTimed(context, row, result.observation.durationMs, result.observation.startedAt, result.observation.endedAt, {
      controllerActionMs: result.controllerActionMs,
      browserEventToPaintMs: result.observation.durationMs,
      eventToDomMs: timing.eventToDomMs,
      domToPaintMs: timing.domToPaintMs,
      controllerWholeTrialMs: endedAt - beganAt
    })
    row.worktreeId = worktree.id
    row.sessionId = worktree.sessions[0]
  } catch (error) {
    recordFailedAttempt(context, row)
    throw error
  }
}

async function openContext(browser: Browser, contextSet: Set<BrowserContext>, signal?: AbortSignal): Promise<{ context: BrowserContext; page: Page }> {
  const creation = browser.newContext({ viewport: VIEWPORT })
  let context: BrowserContext
  try {
    context = await withDeadline(creation, DEADLINE_MS, 'browser context creation', signal)
  } catch (error) {
    void creation.then((late) => withDeadline(late.close(), OBSERVER_CLEANUP_MS, 'late browser context close').catch(() => undefined), () => undefined)
    throw error
  }
  contextSet.add(context)
  try {
    await withDeadline(routeLoopback(context), DEADLINE_MS, 'browser loopback routing', signal)
    const pageCreation = context.newPage()
    let page: Page
    try {
      page = await withDeadline(pageCreation, DEADLINE_MS, 'browser page creation', signal)
    } catch (error) {
      void pageCreation.then((late) => withDeadline(late.close(), OBSERVER_CLEANUP_MS, 'late browser page close').catch(() => undefined), () => undefined)
      throw error
    }
    page.setDefaultTimeout(DEADLINE_MS)
    page.setDefaultNavigationTimeout(DEADLINE_MS)
    return { context, page }
  } catch (error) {
    await withDeadline(context.close(), OBSERVER_CLEANUP_MS, 'partial browser context close').catch(() => undefined)
    throw error
  }
}

async function createMetricContext(options: {
  world: RestartableWorld
  windows: SoakWindows
  fixture: SpeedFixture
  samples: Record<Metric, number[]>
  attempts: MeasurementAttempt[]
  out: string
  signal: AbortSignal
  redactions: Set<string>
  side?: PairSide
  pairOwnedPids?: number[]
}): Promise<MetricContext> {
  const { world, windows, fixture, samples, attempts, out, signal, redactions, side, pairOwnedPids } = options
  redactions.add(world.home)
  collectRuntimeSecrets(redactions, world.runtime)
  const initialPage = windows.pages[0]
  if (!initialPage) throw new Error('openWindows returned no browser page')
  const initialContext = initialPage.context()
  const browser = initialContext.browser()
  if (!browser || !browser.isConnected()) throw new Error('openWindows did not expose its connected Chromium browser')
  const fixtureSessions = fixture.worktrees.flatMap((worktree) => [...worktree.sessions])
  if (fixture.worktrees.length !== 10 || fixtureSessions.length !== 20 || new Set(fixtureSessions).size !== 20) {
    throw new Error('speed fixture must contain ten worktrees and twenty unique terminal sessions')
  }
  if (fixture.target.id !== fixture.worktrees[0]?.id || fixture.target.sessions.length !== 2) {
    throw new Error('speed fixture target does not match its first two-pane worktree')
  }
  const initialSnapshot = await sessionSnapshot(world, fixtureSessions)
  const ptyHostPid = world.ptyHostPid()
  if (ptyHostPid === null) throw new Error('speed fixture PTY host is unavailable')
  const browserPid = windows.browserPid
  pairOwnedPids?.push(world.daemonPid, ptyHostPid, browserPid, ...initialSnapshot.ownedPids)
  world.preserveSessions(fixtureSessions)
  const context: MetricContext = {
    world, windows, fixture, browser, page: initialPage, context: initialContext, signal, out,
    samples, attempts, sessionPids: initialSnapshot.pids, ptyHostPid, browserPid,
    redactions, sessionSequence: new Map(), currentWorktreeIndex: 0,
    ...(side === undefined ? {} : { side })
  }
  await routeLoopback(initialContext)
  return context
}


async function writeDiagnosticTrace(out: string, metric: Metric, page: Page, observation: BrowserObservationResult, phases: Record<string, number | null>, signal?: AbortSignal): Promise<string> {
  const timeline = await withDeadline(page.evaluate(({ metric, observation, phases }) => {
    const resources = performance.getEntriesByType('resource').slice(-1000).map((entry) => {
      let pathname = '<invalid-url>'
      try { pathname = new URL(entry.name).pathname } catch {}
      return {
        pathname,
        initiatorType: entry.entryType === 'resource' ? (entry as PerformanceResourceTiming).initiatorType : 'resource',
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: (entry as PerformanceResourceTiming).transferSize
      }
    })
    const navigation = performance.getEntriesByType('navigation').at(-1)
    return {
      version: 1,
      kind: 'browser-performance-timeline',
      metric,
      observation,
      phases,
      navigation: navigation ? { startTime: navigation.startTime, domContentLoadedEventEnd: (navigation as PerformanceNavigationTiming).domContentLoadedEventEnd, loadEventEnd: (navigation as PerformanceNavigationTiming).loadEventEnd } : null,
      resources
    }
  }, { metric, observation, phases }), DEADLINE_MS, 'browser performance timeline read', signal)
  const relativePath = `timelines/${metric}.json`
  mkdirSync(join(out, 'timelines'), { recursive: true })
  writeFileSync(join(out, relativePath), `${JSON.stringify(timeline, null, 2)}\n`)
  return relativePath
}

async function startBrowserTrace(browser: Browser, signal?: AbortSignal): Promise<BrowserTraceSession> {
  const creation = browser.newBrowserCDPSession()
  let session: CDPSession
  try {
    session = await withDeadline(creation, DEADLINE_MS, 'Chromium diagnostic CDP session creation', signal)
  } catch (error) {
    void creation.then(
      (late) => withDeadline(late.detach(), OBSERVER_CLEANUP_MS, 'late Chromium CDP session detach').catch(() => undefined),
      () => undefined
    )
    throw error
  }

  const completed = Promise.withResolvers<TraceComplete>()
  void completed.promise.catch(() => undefined)
  const onComplete = (event: TraceComplete) => completed.resolve(event)
  session.on('Tracing.tracingComplete', onComplete)
  const tracingStart = session.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    streamCompression: 'none',
    traceConfig: {
      recordMode: 'recordUntilFull',
      traceBufferSizeInKb: 16_384,
      includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading']
    }
  })
  try {
    await withDeadline(tracingStart, DEADLINE_MS, 'Chromium diagnostic trace start', signal)
  } catch (error) {
    void tracingStart.then(async () => {
      try {
        await withDeadline(session.send('Tracing.end'), OBSERVER_CLEANUP_MS, 'late Chromium trace stop')
        const result = await withDeadline(completed.promise, OBSERVER_CLEANUP_MS, 'late Chromium trace flush')
        if (result.stream) await withDeadline(session.send('IO.close', { handle: result.stream }), OBSERVER_CLEANUP_MS, 'late Chromium trace stream close')
      } catch {
        return
      } finally {
        session.off('Tracing.tracingComplete', onComplete)
        await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'late Chromium trace session detach').catch(() => undefined)
      }
    }, async () => {
      session.off('Tracing.tracingComplete', onComplete)
      await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'failed Chromium trace session detach').catch(() => undefined)
    }).catch(() => undefined)
    throw error
  }

  let stopped = false
  return {
    async stop(): Promise<string> {
      if (stopped) throw new Error('Chromium diagnostic trace was already stopped')
      stopped = true
      let stream: string | undefined
      const deadline = performance.now() + DEADLINE_MS
      const remaining = () => {
        const milliseconds = Math.ceil(deadline - performance.now())
        if (milliseconds <= 0) throw new Error(`Chromium diagnostic trace exceeded ${DEADLINE_MS}ms`)
        return milliseconds
      }
      try {
        await withDeadline(session.send('Tracing.end'), remaining(), 'Chromium diagnostic trace stop')
        const result = await withDeadline(completed.promise, remaining(), 'Chromium diagnostic trace flush')
        if (result.dataLossOccurred) throw new Error('Chromium diagnostic trace reported data loss')
        stream = result.stream
        if (!stream) throw new Error('Chromium diagnostic trace returned no stream')
        const chunks: string[] = []
        let byteCount = 0
        let eof = false
        try {
          while (!eof) {
            const chunk = await withDeadline(session.send('IO.read', { handle: stream, size: 256 * 1024 }), remaining(), 'Chromium diagnostic trace read')
            const text = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
            byteCount += Buffer.byteLength(text, 'utf8')
            if (byteCount > MAX_BROWSER_TRACE_BYTES) throw new Error(`Chromium diagnostic trace exceeded ${MAX_BROWSER_TRACE_BYTES} bytes`)
            chunks.push(text)
            eof = chunk.eof
          }
        } finally {
          await withDeadline(session.send('IO.close', { handle: stream }), OBSERVER_CLEANUP_MS, 'Chromium trace stream close').catch(() => undefined)
          stream = undefined
        }
        const trace = chunks.join('')
        if (!trace.includes('\"traceEvents\"')) throw new Error('Chromium diagnostic trace contained no timeline events')
        return trace
      } finally {
        if (stream) await withDeadline(session.send('IO.close', { handle: stream }), OBSERVER_CLEANUP_MS, 'Chromium trace stream close').catch(() => undefined)
        session.off('Tracing.tracingComplete', onComplete)
        await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'Chromium trace session detach').catch(() => undefined)
      }
    }
  }
}

function writeBrowserTrace(out: string, metric: Metric, trace: string): string {
  if (!trace.includes('\"traceEvents\"')) throw new Error('Chromium diagnostic trace is missing traceEvents')
  const relativePath = `traces/${metric}.json`
  mkdirSync(join(out, 'traces'), { recursive: true })
  writeFileSync(join(out, relativePath), trace.endsWith('\n') ? trace : `${trace}\n`)
  return relativePath
}
export type DiagnosticStatusEvidence = { successful: boolean; ptyHostPid: number | null }

export async function waitForDiagnosticStatusProbe(
  probe: Pick<Probe, 'daemonExited'>,
  status: DiagnosticStatusEvidence,
  signal?: AbortSignal,
  timeoutMs = DEADLINE_MS
): Promise<number> {
  const deadline = performance.now() + timeoutMs
  while (!status.successful && !probe.daemonExited() && performance.now() < deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('speed diagnostic interrupted')
    await Bun.sleep(Math.max(1, Math.min(25, deadline - performance.now())))
  }
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('speed diagnostic interrupted')
  if (probe.daemonExited()) throw new Error('daemon exited before the independent status.get probe succeeded')
  if (!status.successful) throw new Error(`independent successful status.get probe did not complete within ${timeoutMs}ms`)
  if (status.ptyHostPid === null || !Number.isSafeInteger(status.ptyHostPid) || status.ptyHostPid <= 1) {
    throw new Error('successful status.get probe did not report a PTY host PID')
  }
  return status.ptyHostPid
}
async function diagnosticTrial(
  context: MetricContext,
  metric: Metric,
  contextSet: Set<BrowserContext>,
  signal: AbortSignal,
  diagnosticPaths: string[],
  diagnosticErrors: string[]
): Promise<void> {
  const probeStatus: DiagnosticStatusEvidence = { successful: false, ptyHostPid: null }
  let probe: Probe | undefined
  let probeDaemonPid: number | null = null
  let statusProbePtyHostPid: number | null = null
  const startStatusProbe = () => {
    probeDaemonPid = context.world.daemonPid
    probe = startProbe({
      home: context.world.home,
      startedAt: performance.now(),
      onDaemonLost: () => undefined,
      onPtyHostPid: (pid) => {
        probeStatus.successful = true
        probeStatus.ptyHostPid = pid
        context.world.updatePtyHostPid(pid)
      }
    })
  }
  let floodStart: FloodStart | undefined
  let browserTrace: BrowserTraceSession | undefined
  let tracePath: string | undefined
  let timelinePath: string | undefined
  let floodRunId: string | undefined
  let phases: Record<string, number | null> = {}
  let observation: BrowserObservationResult | undefined
  const resultPath = `diagnostics/${metric}.json`
  mkdirSync(join(context.out, 'diagnostics'), { recursive: true })
  try {
    browserTrace = await startBrowserTrace(context.browser, signal)
    if (metric !== 'startup') startStatusProbe()
    if (metric === 'startup') {
      const trial = await startupTrial(context, signal, contextSet)
      context.currentWorktreeIndex = 0
      phases = trial.phases
      observation = trial.observation
      startStatusProbe()
      if (probeDaemonPid !== trial.daemonPid) throw new Error('startup status probe did not target the replacement daemon')
    } else if (metric === 'echo') {
      const worktree = context.fixture.target
      await closeHostedReview(context.page, context.world, worktree.id)
      await ensureSelectedWorktree(context.page, worktree)
      context.currentWorktreeIndex = 0
      const sequence = (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1
      const startAt = performance.now()
      const trial = await echoTrial(context.page, worktree, sequence, 'y', signal)
      const endAt = performance.now()
      context.sessionSequence.set(worktree.sessions[0], sequence)
      observation = trial.observation
      const timing = echoTimingPhases(trial.observation)
      phases = {
        controllerActionMs: trial.controllerActionMs,
        browserEventToPaintMs: trial.observation.durationMs,
        eventToDomMs: timing.eventToDomMs,
        domToPaintMs: timing.domToPaintMs,
        controllerWholeTrialMs: endAt - startAt
      }
    } else if (metric === 'switch') {
      await closeHostedReview(context.page, context.world, context.fixture.target.id)
      await ensureSelectedWorktree(context.page, context.fixture.target)
      context.currentWorktreeIndex = 0
      const worktrees = context.fixture.worktrees
      const next = (context.currentWorktreeIndex + 1) % worktrees.length
      const startAt = performance.now()
      const trial = await switchTrial(context.page, worktrees[next]!, signal)
      const endAt = performance.now()
      context.currentWorktreeIndex = next
      observation = trial.observation
      phases = { controllerActionMs: trial.controllerActionMs, browserClickToUsableTerminalMs: trial.observation.durationMs, controllerWholeTrialMs: endAt - startAt }
    } else if (metric === 'diff') {
      await ensureSelectedWorktree(context.page, context.fixture.target)
      context.currentWorktreeIndex = 0
      const rpcMs = await verifyPublicDiff(context)
      const startAt = performance.now()
      const trial = await diffTrial(context, signal)
      const endAt = performance.now()
      observation = trial.observation
      phases = { publicDiffRpcMs: rpcMs, controllerActionMs: trial.controllerActionMs, browserClickToCodeMirrorPaintMs: trial.observation.durationMs, controllerWholeTrialMs: endAt - startAt }
    } else {
      await closeHostedReview(context.page, context.world, context.fixture.target.id)
      await ensureSelectedWorktree(context.page, context.fixture.target)
      context.currentWorktreeIndex = 0
      const flood = await beginFlood(context, signal)
      floodStart = flood.start
      floodRunId = flood.start.runId
      const sequence = (context.sessionSequence.get(context.fixture.target.sessions[0]) ?? 0) + 1
      const startAt = performance.now()
      const trial = await echoTrial(context.page, context.fixture.target, sequence, 'x', signal)
      const endAt = performance.now()
      context.sessionSequence.set(context.fixture.target.sessions[0], sequence)
      const endProgress = await waitForFloodProgressAfterSnapshot(
        context.page,
        context.fixture.target,
        flood.start,
        signal,
        () => context.context.close()
      )
      const endCounter = endProgress.afterCounter
      const stats = await context.fixture.stopFlood()
      floodStart = undefined
      validateFloodStats(stats, flood.start)
      observation = trial.observation
      const timing = echoTimingPhases(trial.observation)
      floodRunId = stats.runId
      phases = {
        controllerActionMs: trial.controllerActionMs,
        browserEventToPaintMs: trial.observation.durationMs,
        eventToDomMs: timing.eventToDomMs,
        domToPaintMs: timing.domToPaintMs,
        controllerWholeTrialMs: endAt - startAt,
        offeredBytesPerSecond: stats.offeredBytesPerSecond,
        actualBytesPerSecond: stats.bytesWritten * 1000 / stats.elapsedMs,
        renderedStartCounter: flood.renderedCounter,
        renderedEndCounter: endCounter
      }
    }
    const activeProbe = probe
    if (!activeProbe || probeDaemonPid === null) throw new Error('independent status.get probe was not started')
    statusProbePtyHostPid = await waitForDiagnosticStatusProbe(activeProbe, probeStatus, signal)
    if (probeDaemonPid !== context.world.daemonPid) throw new Error('daemon changed during the diagnostic status.get probe')
    if (statusProbePtyHostPid !== context.world.ptyHostPid()) throw new Error('status.get probe did not confirm the fixture PTY host')
    if (!observation) throw new Error(`${metric} diagnostic produced no browser observation`)
    const activeTrace = browserTrace
    if (!activeTrace) throw new Error('Chromium diagnostic trace was not started')
    browserTrace = undefined
    const traceContents = await activeTrace.stop()
    tracePath = writeBrowserTrace(context.out, metric, traceContents)
    diagnosticPaths.push(tracePath)
    timelinePath = await writeDiagnosticTrace(context.out, metric, context.page, observation, phases, signal)
    diagnosticPaths.push(timelinePath)
    const probeEvidence = {
      probes: activeProbe.probes,
      events: activeProbe.events,
      daemonExited: activeProbe.daemonExited(),
      statusGet: { successful: probeStatus.successful, daemonPid: probeDaemonPid, ptyHostPid: statusProbePtyHostPid }
    }
    const diagnostic = {
      version: 1,
      metric,
      status: 'complete',
      observation,
      phases,
      ...(floodRunId === undefined ? {} : { floodRunId }),
      probe: probeEvidence,
      finding: diagnosticFinding(metric, observation.durationMs, phases, activeProbe.probes),
      trace: tracePath,
      timeline: timelinePath
    }
    writeFileSync(join(context.out, resultPath), `${JSON.stringify(diagnostic, null, 2)}\n`)
    diagnosticPaths.push(resultPath)
  } catch (error) {
    if (browserTrace) {
      const activeTrace = browserTrace
      browserTrace = undefined
      try {
        tracePath = writeBrowserTrace(context.out, metric, await activeTrace.stop())
        diagnosticPaths.push(tracePath)
      } catch (traceError) {
        diagnosticErrors.push(`${metric} browser trace: ${sanitizeText(errorText(traceError), context.redactions)}`)
      }
    }
    const message = sanitizeText(errorText(error), context.redactions)
    diagnosticErrors.push(`${metric}: ${message}`)
    const failureEvidence = {
      version: 1,
      metric,
      status: 'error',
      error: message,
      finding: `Diagnostic evidence error: ${message}`,
      ...(floodRunId === undefined ? {} : { floodRunId }),
      ...(tracePath === undefined ? {} : { trace: tracePath }),
      probe: {
        probes: probe?.probes ?? [],
        events: probe?.events ?? [],
        daemonExited: probe?.daemonExited() ?? false,
        statusGet: { successful: probeStatus.successful, daemonPid: probeDaemonPid, ptyHostPid: probeStatus.ptyHostPid }
      }
    }
    writeFileSync(join(context.out, resultPath), `${JSON.stringify(failureEvidence, null, 2)}\n`)
    diagnosticPaths.push(resultPath)
  } finally {
    probe?.finish()
    probe?.stop()
    if (floodStart) {
      try { await context.fixture.stopFlood() } catch (error) {
        diagnosticErrors.push(`flood cleanup: ${sanitizeText(errorText(error), context.redactions)}`)
      }
    }
  }
}

async function runMeasuredSeries(context: MetricContext, count: number, signal: AbortSignal, contextSet: Set<BrowserContext>): Promise<void> {
  let currentMetric: Metric = 'startup'
  let currentPhase: SpeedSample['phase'] = 'sample'
  let currentIndex = 1
  try {
    for (let sample = 1; sample <= count; sample++) {
      currentMetric = 'startup'
      currentPhase = 'sample'
      currentIndex = sample
      await recordStartupAttempt(context, 'sample', sample, signal, contextSet)
    }

    const page = context.page
    currentMetric = 'echo'
    currentPhase = 'warmup'
    currentIndex = 1
    await ensureSelectedWorktree(page, context.fixture.target)
    context.currentWorktreeIndex = 0
    for (let warmup = 1; warmup <= 2; warmup++) {
      currentIndex = warmup
      await runEchoAttempt(context, 'warmup', warmup, ECHO_KEYS[warmup - 1]!, signal)
    }
    for (let sample = 1; sample <= count; sample++) {
      currentPhase = 'sample'
      currentIndex = sample
      await runEchoAttempt(context, 'sample', sample, ECHO_KEYS[(sample + 1) % ECHO_KEYS.length]!, signal)
    }

    currentMetric = 'switch'
    currentPhase = 'warmup'
    currentIndex = 1
    for (let warmup = 1; warmup <= 2; warmup++) {
      currentIndex = warmup
      const next = (context.currentWorktreeIndex + 1) % context.fixture.worktrees.length
      await runSwitchAttempt(context, 'warmup', warmup, context.fixture.worktrees[next]!, signal)
    }
    for (let sample = 1; sample <= count; sample++) {
      currentPhase = 'sample'
      currentIndex = sample
      const next = (context.currentWorktreeIndex + 1) % context.fixture.worktrees.length
      await runSwitchAttempt(context, 'sample', sample, context.fixture.worktrees[next]!, signal)
    }

    currentMetric = 'diff'
    currentPhase = 'warmup'
    currentIndex = 1
    await ensureSelectedWorktree(page, context.fixture.target)
    context.currentWorktreeIndex = 0
    await verifyPublicDiff(context)
    for (let warmup = 1; warmup <= 2; warmup++) {
      currentIndex = warmup
      await runDiffAttempt(context, 'warmup', warmup, signal)
    }
    for (let sample = 1; sample <= count; sample++) {
      currentPhase = 'sample'
      currentIndex = sample
      await runDiffAttempt(context, 'sample', sample, signal)
    }

    currentMetric = 'floodEcho'
    currentPhase = 'warmup'
    currentIndex = 1
    await runFloodEchoSeries(context, count, signal)
  } catch (error) {
    if (error instanceof MeasurementFailure) throw error
    throw new MeasurementFailure(currentMetric, currentIndex, currentPhase, error)
  }
}

function emptyMetricSamples(): Record<Metric, number[]> {
  return { startup: [], echo: [], switch: [], diff: [], floodEcho: [] }
}

async function runPairedSeries(
  contexts: Record<PairSide, MetricContext>,
  pairCounts: Readonly<Record<Metric, number>>,
  signal: AbortSignal,
  contextSet: Set<BrowserContext>
): Promise<void> {
  const runSide = async (
    side: PairSide,
    metric: Metric,
    phase: SpeedSample['phase'],
    sample: number,
    action: (context: MetricContext, phase: SpeedSample['phase'], sample: number) => Promise<void>
  ): Promise<void> => {
    try {
      await action(contexts[side], phase, sample)
    } catch (error) {
      const marker = error instanceof MeasurementFailure ? error : undefined
      throw new MeasurementFailure(
        marker?.metric ?? metric,
        marker?.sample ?? sample,
        marker?.phase ?? phase,
        new Error(`${side}: ${errorText(marker?.causeValue ?? error)}`)
      )
    }
  }
  const runSides = async (
    sides: readonly PairSide[],
    metric: Metric,
    phase: SpeedSample['phase'],
    sample: number,
    action: (context: MetricContext, phase: SpeedSample['phase'], sample: number) => Promise<void>
  ): Promise<void> => {
    for (const side of sides) await runSide(side, metric, phase, sample, action)
  }
  const runMetric = async (
    metric: Metric,
    count: number,
    action: (context: MetricContext, phase: SpeedSample['phase'], sample: number) => Promise<void>
  ): Promise<void> => {
    for (let warmup = 1; warmup <= 2; warmup++) {
      await runSides(pairSides(warmup), metric, 'warmup', warmup, action)
    }
    for (let sample = 1; sample <= count; sample++) {
      await runSides(pairSides(sample), metric, 'sample', sample, action)
    }
  }

  await runMetric('startup', pairCounts.startup, (context, phase, sample) =>
    recordStartupAttempt(context, phase, sample, signal, contextSet))

  for (const side of ['head', 'base'] as const) {
    await runSide(side, 'echo', 'warmup', 1, async (context) => {
      await ensureSelectedWorktree(context.page, context.fixture.target)
      context.currentWorktreeIndex = 0
    })
  }
  await runMetric('echo', pairCounts.echo, (context, phase, sample) =>
    runEchoAttempt(
      context,
      phase,
      sample,
      phase === 'warmup' ? ECHO_KEYS[sample - 1]! : ECHO_KEYS[(sample + 1) % ECHO_KEYS.length]!,
      signal
    ))

  await runMetric('switch', pairCounts.switch, (context, phase, sample) => {
    const next = (context.currentWorktreeIndex + 1) % context.fixture.worktrees.length
    return runSwitchAttempt(context, phase, sample, context.fixture.worktrees[next]!, signal)
  })

  for (const side of ['head', 'base'] as const) {
    await runSide(side, 'diff', 'warmup', 1, async (context) => {
      await ensureSelectedWorktree(context.page, context.fixture.target)
      context.currentWorktreeIndex = 0
      await verifyPublicDiff(context)
    })
  }
  await runMetric('diff', pairCounts.diff, (context, phase, sample) =>
    runDiffAttempt(context, phase, sample, signal))

  for (const block of floodBlocks(pairCounts.floodEcho)) {
    await runSide(block.side, 'floodEcho', 'sample', block.first, async (context) =>
      runFloodEchoSeries(context, block.count, signal, block.first))
  }
}

function metricSampleCountsValid(samples: Record<Metric, number[]>, expectedCount: number): boolean {
  return METRICS.every((metric) => samples[metric].length === expectedCount)
}

async function readGpuCompositing(browser: Browser, signal: AbortSignal): Promise<string> {
  const creation = browser.newBrowserCDPSession()
  let session: CDPSession
  try {
    session = await withDeadline(creation, DEADLINE_MS, 'Chromium frame-pacing CDP session creation', signal)
  } catch (error) {
    void creation.then(
      (late) => withDeadline(late.detach(), OBSERVER_CLEANUP_MS, 'late frame-pacing CDP detach').catch(() => undefined),
      () => undefined
    )
    throw error
  }

  let status = ''
  let failure: unknown
  try {
    const info = record(await withDeadline(session.send('SystemInfo.getInfo'), DEADLINE_MS, 'Chromium system information', signal), 'Chromium system information')
    const gpu = record(info.gpu, 'Chromium GPU information')
    const featureStatus = record(gpu.featureStatus, 'Chromium GPU feature status')
    status = String(featureStatus.gpu_compositing)
  } catch (error) {
    failure = error
  }
  try {
    await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'frame-pacing CDP detach')
  } catch (error) {
    failure = failure === undefined ? error : new Error(`${errorText(failure)}; ${errorText(error)}`)
  }
  if (failure !== undefined) throw failure
  return status
}

export async function measureBrowserFrameIntervals(page: Page, signal: AbortSignal, frameTimestamp?: number): Promise<number[]> {
  const elementId = `quirky-speed-frame-pacing-${randomUUID()}`
  const measurement = page.evaluate(async ({ id, fixedTimestamp }) => {
    const probe = document.createElement('div')
    try {
      probe.id = id
      probe.setAttribute('aria-hidden', 'true')
      probe.style.position = 'fixed'
      probe.style.top = '0'
      probe.style.left = '0'
      probe.style.width = '1px'
      probe.style.height = '1px'
      probe.style.pointerEvents = 'none'
      probe.style.zIndex = '2147483647'
      probe.style.backgroundColor = 'rgb(0, 0, 0)'
      document.documentElement.append(probe)
      const requestFrame = globalThis.requestAnimationFrame.bind(globalThis)
      const waitForFrame = () => {
        const { promise, resolve } = Promise.withResolvers<number>()
        requestFrame((time) => resolve(fixedTimestamp ?? time))
        return promise
      }
      let previous = await waitForFrame()
      const intervals: number[] = []
      for (let frame = 0; frame < 60; frame++) {
        probe.style.backgroundColor = frame % 2 === 0 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'
        const current = await waitForFrame()
        intervals.push(current - previous)
        previous = current
      }
      return intervals
    } finally {
      probe.remove()
    }
  }, { id: elementId, fixedTimestamp: frameTimestamp })
  try {
    return await withDeadline(measurement, DEADLINE_MS, 'browser frame-pacing measurement', signal)
  } catch (error) {
    try {
      await withDeadline(page.evaluate((id) => {
        document.getElementById(id)?.remove()
      }, elementId), OBSERVER_CLEANUP_MS, 'frame-pacing probe cleanup')
    } catch (cleanupError) {
      throw new Error(`${errorText(error)}; frame-pacing probe cleanup failed: ${errorText(cleanupError)}`)
    }
    throw error
  }
}

/** Runs warmups, renderer-bound trials, and post-run diagnostics against the owned daemon and browser. */
export async function measureSpeed(options: {
  world: RestartableWorld
  windows: SoakWindows
  fixture: SpeedFixture
  samples: number
  out: string
  signal: AbortSignal
  frameTimestamp?: number
  pair?: {
    start(signal: AbortSignal): Promise<{ world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows }>
  }
}): Promise<SpeedMeasurementResult> {
  const { world, windows, fixture, samples: sampleCount, out, signal, frameTimestamp } = options
  const sampleValues = emptyMetricSamples()
  const attempts: MeasurementAttempt[] = []
  const failures: Failure[] = []
  const diagnostics: string[] = []
  const diagnosticErrors: string[] = []
  const redactions = new Set<string>()
  const contexts = new Set<BrowserContext>()
  if (sampleCount < 1 || !Number.isSafeInteger(sampleCount)) throw new Error('speed sample count must be a positive integer')
  if (signal.aborted) throw new Error('speed measurement interrupted')

  const context = await createMetricContext({
    world, windows, fixture, samples: sampleValues, attempts, out, signal, redactions
  })
  const pairResult: SpeedMeasurementResult['pair'] = options.pair ? {
    samples: { head: emptyMetricSamples(), base: emptyMetricSamples() },
    attempts: [],
    failures: []
  } : null
  const pairOwnedPids: number[] = []
  const recordPairFailure = (kind: string, error: unknown) => {
    if (!pairResult) return
    const marker = error instanceof MeasurementFailure ? error : undefined
    pairResult.failures.push({
      kind,
      ...(marker ? { metric: marker.metric, sample: marker.sample } : {}),
      message: sanitizeText(
        marker ? `${marker.phase} ${errorText(marker.causeValue)}` : errorText(error),
        redactions
      )
    })
  }

  try {
    try {
      const gpuCompositing = await readGpuCompositing(context.browser, signal)
      if (gpuCompositing !== 'disabled_software') {
        throw new Error(`browser is not compositing in software: ${gpuCompositing}`)
      }
      let intervalsMs: number[] = []
      let pacing: FramePacing | { frames: number; error: string }
      try {
        intervalsMs = await measureBrowserFrameIntervals(context.page, signal, frameTimestamp)
        pacing = summarizeFrameIntervals(intervalsMs)
      } catch (error) {
        pacing = { frames: intervalsMs.length, error: errorText(error) }
      }
      const framePacing = { version: 1, ...pacing, gpuCompositing, intervalsMs }
      mkdirSync(join(out, 'diagnostics'), { recursive: true })
      const pacingJson = JSON.stringify(framePacing, (_key, value: unknown) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2)
      writeFileSync(join(out, 'diagnostics', 'frame-pacing.json'), `${pacingJson}\n`)
      diagnostics.push('diagnostics/frame-pacing.json')
      await runMeasuredSeries(context, sampleCount, signal, contexts)
      if (!metricSampleCountsValid(sampleValues, sampleCount)) {
        const missing = METRICS.find((metric) => sampleValues[metric].length !== sampleCount) ?? 'startup'
        throw new MeasurementFailure(missing, sampleValues[missing].length + 1, 'sample', new Error('metric did not produce the requested successful sample count'))
      }

      for (const metric of METRICS) {
        const value = median(sampleValues[metric])
        if (value !== null && value > BUDGETS[metric]) {
          await diagnosticTrial(context, metric, contexts, signal, diagnostics, diagnosticErrors)
        }
      }
    } catch (error) {
      const marker = error instanceof MeasurementFailure ? error : undefined
      const message = marker ? errorText(marker.causeValue) : errorText(error)
      failures.push({
        kind: marker?.phase === 'warmup' ? 'warmup-failed' : 'measurement-failed',
        ...(marker ? { metric: marker.metric, sample: marker.sample } : {}),
        message: sanitizeText(`${marker ? `${marker.phase} ` : ''}${message}`, redactions)
      })
    }

    if (options.pair && pairResult) {
      if (signal.aborted) {
        recordPairFailure('pair-interrupted', new Error('speed measurement interrupted'))
      } else {
        let pairedStart: { world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows } | undefined
        try {
          pairedStart = await options.pair.start(signal)
          redactions.add(pairedStart.world.home)
          collectRuntimeSecrets(redactions, pairedStart.world.runtime)
          pairOwnedPids.push(
            pairedStart.world.daemonPid,
            pairedStart.world.ptyHostPid() ?? -1,
            pairedStart.windows.browserPid
          )
        } catch (error) {
          recordPairFailure(signal.aborted ? 'pair-interrupted' : 'pair-setup-failed', error)
        }

        if (pairedStart && signal.aborted) {
          recordPairFailure('pair-interrupted', new Error('speed measurement interrupted'))
        } else if (pairedStart) {
          let baseContext: MetricContext | undefined
          try {
            baseContext = await createMetricContext({
              world: pairedStart.world,
              windows: pairedStart.windows,
              fixture: pairedStart.fixture,
              samples: pairResult.samples.base,
              attempts: pairResult.attempts,
              out,
              signal,
              redactions,
              side: 'base',
              pairOwnedPids
            })
          } catch (error) {
            recordPairFailure(signal.aborted ? 'pair-interrupted' : 'pair-setup-failed', error)
          }

          if (baseContext) {
            const headContext: MetricContext = {
              ...context,
              samples: pairResult.samples.head,
              attempts: pairResult.attempts,
              side: 'head'
            }
            const pairCounts = sampleCount === 1
              ? { startup: 1, echo: 1, switch: 1, diff: 1, floodEcho: 1 }
              : PAIR_COUNTS
            try {
              await runPairedSeries(
                { head: headContext, base: baseContext },
                pairCounts,
                signal,
                contexts
              )
            } catch (error) {
              recordPairFailure(signal.aborted ? 'pair-interrupted' : 'pair-measurement-failed', error)
            }
          }
        }
      }
    }
  } finally {
    for (const browserContext of contexts) {
      try { await withDeadline(browserContext.close(), OBSERVER_CLEANUP_MS, 'browser context cleanup') } catch (error) {
        failures.push({ kind: 'context-cleanup-failed', message: sanitizeText(errorText(error), redactions) })
      }
    }
  }

  const pairAttempts = pairResult?.attempts ?? []
  const ownedPids = [...new Set([
    ...attempts.flatMap((sample) => sample.ownedPids),
    ...pairAttempts.flatMap((sample) => sample.ownedPids),
    ...pairOwnedPids
  ])].filter((pid) => pid > 1)
  return {
    samples: sampleValues,
    attempts,
    failures,
    diagnostics,
    diagnosticErrors,
    ownedPids,
    redactions: [...redactions],
    pair: pairResult
  }
}

class MeasurementFailure extends Error {
  constructor(readonly metric: Metric, readonly sample: number, readonly phase: SpeedSample['phase'], readonly causeValue: unknown) {
    super(errorText(causeValue))
  }
}

/** Replaces known secrets and disposable-home paths in uploaded textual speed evidence. */
export function sanitizeSpeedArtifacts(out: string, redactions: Iterable<string>): void {
  const secretValues = [...redactions]
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !/\.(?:json|jsonl|md|log|txt|trace)$/i.test(entry.name)) continue
      const content = readFileSync(path, 'utf8')
      writeFileSync(path, sanitizeText(content, secretValues))
    }
  }
  visit(out)
}
