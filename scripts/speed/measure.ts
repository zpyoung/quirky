import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, Page, Route } from 'playwright'
import { BUDGETS, METRICS, PAIR_COUNTS, type Failure, type FrameTiming, type Metric, type PairSide } from './contracts.ts'
import { extractFrameTiming, type FrameTimingObservation } from './frame-timing.ts'
import { median } from './report.ts'
import { watchReplacementRuntime } from './startup.ts'
import { startProbe, type Probe } from '../soak/probe.ts'
import type { ProbeRecord } from '../soak/contracts.ts'
import type { SoakWindows } from '../soak/windows.ts'
import type { DaemonSpawn, SoakWorld } from '../soak/world.ts'
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

export type FrameIntervalCapture = {
  intervalsMs: number[]
  duplicateTimestamps: number
  invalidTimestamps: number
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

type BrowserObservationMarks = FrameTimingObservation['marks']

type BrowserObservationResult = {
  id: string
  kind: BrowserObservationSpec['kind']
  startedAt: number
  endedAt: number
  durationMs: number
  counter?: number
  trace: { event: string; at: number }[]
  pacing: FrameIntervalCapture
  marks: BrowserObservationMarks
}

type BrowserObservation = { observation: BrowserObservationResult }

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

export type SpeedSample = {
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
  pacing: FrameIntervalCapture
  frameTiming?: FrameTiming
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

async function diffSetupRpc(world: RestartableWorld, method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await world.control.callAny(method, params, { timeoutMs: 5_000 })
  } catch (error) {
    throw new Error(`${method}: ${errorText(error)}`)
  }
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
    beforeApplicationFrame(): boolean | null
    afterApplicationFrame(requestedAt: number, deliveredAt: number, wasReady: boolean | null): void
    afterFrame(frame: number, timestamp: number, nativeFrame: boolean, deliveredAt: number): void
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
    afterCallback(timestamp: number, nativeFrame: boolean, deliveredAt: number): void
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
      afterCallback(timestamp, nativeFrame, deliveredAt) {
        if (!created.active) return
        const sequence = ++created.callbackSequence
        for (const observer of created.observers) observer.afterFrame(sequence, timestamp, nativeFrame, deliveredAt)
        if (!created.taskPending && created.active) {
          created.taskPending = true
          created.channel.port2.postMessage(null)
        }
      },
      ensureFrame() {
        if (!created.active || created.frameId !== null) return
        created.frameId = created.originalRequestAnimationFrame.call(root, (timestamp) => {
          created.frameId = null
          created.afterCallback(timestamp, true, root.performance.now())
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
      const requestedAt = root.performance.now()
      return created.originalRequestAnimationFrame.call(root, (timestamp) => {
        const deliveredAt = root.performance.now()
        const readiness = new Map<FrameObserver, boolean | null>()
        for (const observer of created.observers) readiness.set(observer, observer.beforeApplicationFrame())
        try {
          callback(timestamp)
        } finally {
          for (const observer of created.observers) {
            observer.afterApplicationFrame(requestedAt, deliveredAt, readiness.get(observer) ?? null)
          }
          created.afterCallback(timestamp, false, deliveredAt)
        }
      })
    }
    root.__quirkySpeedFrameHook = created
    root.requestAnimationFrame = created.wrappedRequestAnimationFrame
    created.ensureFrame()
  }

  const marks: BrowserObservationMarks = {
    action: `quirky-speed-${spec.id}-action`,
    end: `quirky-speed-${spec.id}-paint`
  }
  const addPerformanceMark = (name: string, startTime?: number) => {
    try {
      if (startTime === undefined) root.performance.mark(name)
      else root.performance.mark(name, { startTime })
    } catch {
      return
    }
  }
  const clearPerformanceMark = (name: string) => {
    try {
      root.performance.clearMarks(name)
    } catch {
      return
    }
  }
  let startAt: number | null = null
  if (spec.kind === 'flood') {
    startAt = root.performance.now()
    addPerformanceMark(marks.action, startAt)
  }
  let finished = false
  let readyFrame: number | null = null
  let domAtFrame: number | null = null
  let counterAtFrame: number | undefined
  let domReadyAt: number | null = null
  let lastReady = false
  let candidateMarkSequence = 0
  let candidate: NonNullable<BrowserObservationMarks['candidate']> | null = null
  let pacingPrevious: number | null = null
  const pacing: FrameIntervalCapture = { intervalsMs: [], duplicateTimestamps: 0, invalidTimestamps: 0 }
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
  const markCandidate = (
    kind: NonNullable<BrowserObservationMarks['candidate']>['kind'],
    requestedAt: number,
    deliveredAt: number
  ) => {
    if (!Number.isFinite(requestedAt) || !Number.isFinite(deliveredAt) || deliveredAt < requestedAt) return
    if (candidate) {
      clearPerformanceMark(candidate.requested)
      clearPerformanceMark(candidate.delivered)
    }
    const suffix = `${spec.id}-candidate-${++candidateMarkSequence}`
    const requested = `quirky-speed-${suffix}-requested`
    const delivered = `quirky-speed-${suffix}-delivered`
    addPerformanceMark(requested, requestedAt)
    addPerformanceMark(delivered, deliveredAt)
    candidate = { kind, requested, delivered }
    marks.candidate = candidate
  }
  const clearCandidate = () => {
    if (!candidate) return
    clearPerformanceMark(candidate.requested)
    clearPerformanceMark(candidate.delivered)
    candidate = null
    delete marks.candidate
  }
  const resetReadiness = () => {
    readyFrame = null
    domAtFrame = null
    counterAtFrame = undefined
    domReadyAt = null
    lastReady = false
    clearCandidate()
  }
  let mutationObserver: MutationObserver | undefined
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
    mutationObserver?.disconnect()
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
    addPerformanceMark(marks.end, endedAt)
    trace.push({ event: 'paint', at: endedAt })
    resolveResult({
      id: spec.id,
      kind: spec.kind,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...(counter === undefined ? {} : { counter }),
      trace,
      pacing,
      marks
    })
  }
  const frameObserver: FrameObserver = {
    beforeApplicationFrame() {
      if (finished || startAt === null) return null
      try {
        return condition().ready
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return null
      }
    },
    afterApplicationFrame(requestedAt, deliveredAt, wasReady) {
      if (finished || startAt === null || wasReady === null) return
      try {
        const current = condition()
        if (!current.ready) {
          resetReadiness()
          return
        }
        lastReady = true
        if (!wasReady) {
          domReadyAt = null
          markCandidate('application-raf', requestedAt, deliveredAt)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    },
    afterFrame(frame, timestamp, nativeFrame, deliveredAt) {
      if (finished || startAt === null) return
      if (nativeFrame) {
        if (!Number.isFinite(timestamp)) {
          pacing.invalidTimestamps++
        } else {
          if (pacingPrevious !== null) {
            const interval = timestamp - pacingPrevious
            if (interval > 0) pacing.intervalsMs.push(interval)
            else if (interval === 0) pacing.duplicateTimestamps++
            else pacing.invalidTimestamps++
          }
          pacingPrevious = timestamp
        }
      }
      try {
        const current = condition()
        if (!current.ready) {
          resetReadiness()
          return
        }
        lastReady = true
        readyFrame = frame
        domAtFrame = deliveredAt
        counterAtFrame = current.counter
        if (!candidate && domReadyAt !== null) {
          markCandidate('ready-to-frame', domReadyAt, deliveredAt)
          domReadyAt = null
        }
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
        if (!afterFrame.ready) {
          resetReadiness()
          return
        }
        trace.push({ event: 'dom', at: domAt })
        finish(undefined, counter ?? afterFrame.counter)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  mutationObserver = new root.MutationObserver(() => {
    if (finished || startAt === null) return
    try {
      const current = condition()
      if (!current.ready) {
        resetReadiness()
        return
      }
      if (!lastReady && candidate?.kind !== 'application-raf') domReadyAt = root.performance.now()
      lastReady = true
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
  mutationObserver.observe(document.documentElement, {
    attributes: true, childList: true, characterData: true, subtree: true
  })
  const onAction = (event: Event & { key?: string }) => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function' || !(target as Element).closest(actionSelector)) return
    if (spec.kind === 'echo' && event.key !== spec.key) return
    if (startAt !== null) return
    startAt = root.performance.now()
    addPerformanceMark(marks.action, startAt)
    try {
      lastReady = condition().ready
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
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
  cleanupTimeoutMs = OBSERVER_CLEANUP_MS,
  onObservation?: () => void
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
    const observation = await Promise.race([pending, timeout, interrupted])
    onObservation?.()
    return observation
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
class TraceCleanupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceCleanupError'
  }
}

class TraceSetupError extends Error {
  constructor(message: string, readonly cleanup: Promise<void>) {
    super(message)
    this.name = 'TraceSetupError'
  }
}

function isTraceCleanupError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TraceCleanupError'
}

function frameTimingFallback(observation: BrowserObservationResult, reason: string): FrameTiming {
  const wallMs = observation.endedAt - observation.startedAt
  if (!Number.isFinite(wallMs) || wallMs <= 0
    || !Number.isFinite(observation.durationMs) || Math.abs(observation.durationMs - wallMs) > 0.001) {
    throw new Error('browser observation returned invalid raw frame-timing boundaries')
  }
  return { status: 'unavailable', wallMs, effectiveMs: wallMs, deductionMs: 0, candidate: null, reason }
}

export async function captureObservedFrameTiming<T extends BrowserObservation>(
  options: {
    startTrace(): Promise<BrowserTraceSession>
    observe(): Promise<T>
    signal?: AbortSignal
  }
): Promise<T & { frameTiming: FrameTiming }> {
  if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
  let trace: BrowserTraceSession | undefined
  let traceError: unknown
  let setupCleanup: Promise<void> | undefined
  try {
    trace = await options.startTrace()
  } catch (error) {
    traceError = error
    if (error instanceof TraceSetupError) setupCleanup = error.cleanup
  }
  const awaitSetupCleanup = async () => {
    if (!setupCleanup) return
    try {
      await withDeadline(setupCleanup, OBSERVER_CLEANUP_MS, 'late Chromium trace setup cleanup')
    } catch (error) {
      throw new TraceCleanupError(errorText(error))
    }
  }

  let result: T
  try {
    result = await options.observe()
  } catch (rawError) {
    if (trace) {
      try {
        await trace.stop()
      } catch (cleanupError) {
        if (isTraceCleanupError(cleanupError)) throw new Error(`${errorText(rawError)}; ${errorText(cleanupError)}`)
      }
    }
    try {
      await awaitSetupCleanup()
    } catch (cleanupError) {
      throw new Error(`${errorText(rawError)}; ${errorText(cleanupError)}`)
    }
    throw rawError
  }

  if (options.signal?.aborted) {
    if (trace) {
      try {
        await trace.stop()
      } catch (cleanupError) {
        if (isTraceCleanupError(cleanupError)) throw cleanupError
      }
    }
    await awaitSetupCleanup()
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
  }

  if (!trace) {
    if (isTraceCleanupError(traceError)) throw traceError
    await awaitSetupCleanup()
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
    const frameTiming = frameTimingFallback(result.observation, `trace-start-failed: ${errorText(traceError)}`)
    return { ...result, frameTiming }
  }

  let traceContents: string
  try {
    traceContents = await trace.stop()
  } catch (error) {
    if (isTraceCleanupError(error)) throw error
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
    const frameTiming = frameTimingFallback(result.observation, `trace-flush-failed: ${errorText(error)}`)
    return { ...result, frameTiming }
  }
  if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
  const frameTiming = extractFrameTiming(traceContents, {
    startedAt: result.observation.startedAt,
    endedAt: result.observation.endedAt,
    marks: result.observation.marks
  })
  return { ...result, frameTiming }
}

type StartupWatch<T> = {
  expectSpawn(spawn: DaemonSpawn): void
  runtime: Promise<T>
  dispose(): void
}

export async function coordinateStartupAttempt<TRuntime, TRestart, TNavigation>(
  options: {
    signal: AbortSignal
    watch(signal: AbortSignal): StartupWatch<TRuntime>
    restart(signal: AbortSignal, onSpawn: (spawn: DaemonSpawn) => void): Promise<TRestart>
    navigate(runtime: TRuntime, signal: AbortSignal): Promise<{ value: TNavigation; paintedAt: number }>
    verify(restart: TRestart, navigation: TNavigation, signal: AbortSignal): Promise<void>
    onRuntime?(runtime: TRuntime): void
    onSpawn?(spawn: DaemonSpawn): void
    now?: () => number
  }
): Promise<{
  spawnedAt: number
  runtimeAt: number
  restartAt: number
  paintedAt: number
  verifiedAt: number
  restart: TRestart
  navigation: TNavigation
}> {
  if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
  const now = options.now ?? (() => performance.now())
  const attemptController = new AbortController()
  const forwardAbort = () => attemptController.abort(
    options.signal.reason instanceof Error ? options.signal.reason : new Error('speed measurement interrupted')
  )
  options.signal.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal.aborted) forwardAbort()
  let watcher: StartupWatch<TRuntime> | undefined
  let restartPromise: Promise<TRestart> | undefined
  let navigationPromise: Promise<{ value: TNavigation; paintedAt: number }> | undefined
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    watcher?.dispose()
  }
  let spawnedAt: number | undefined
  let runtimeAt: number | undefined
  let restartAt: number | undefined
  try {
    watcher = options.watch(attemptController.signal)
    const onSpawn = (spawn: DaemonSpawn) => {
      if (spawnedAt !== undefined) throw new Error('daemon restart notified more than one replacement spawn')
      watcher!.expectSpawn(spawn)
      spawnedAt = spawn.spawnedAt
      options.onSpawn?.(spawn)
    }
    try {
      restartPromise = options.restart(attemptController.signal, onSpawn).then((value) => {
        restartAt = now()
        return value
      })
    } catch (error) {
      restartPromise = Promise.reject(error)
    }
    void restartPromise.catch(() => undefined)
    navigationPromise = watcher.runtime.then(async (runtime) => {
      runtimeAt = now()
      if (spawnedAt === undefined) throw new Error('replacement runtime arrived before spawn notification')
      options.onRuntime?.(runtime)
      return await options.navigate(runtime, attemptController.signal)
    })
    void navigationPromise.catch(() => undefined)

    const [restart, navigation] = await Promise.all([restartPromise, navigationPromise])
    if (spawnedAt === undefined || runtimeAt === undefined || restartAt === undefined) {
      throw new Error('startup race completed without spawn, runtime, or health timestamps')
    }
    await options.verify(restart, navigation.value, attemptController.signal)
    if (attemptController.signal.aborted) {
      throw attemptController.signal.reason instanceof Error
        ? attemptController.signal.reason
        : new Error('speed measurement interrupted')
    }
    return {
      spawnedAt, runtimeAt, restartAt, paintedAt: navigation.paintedAt, verifiedAt: now(),
      restart, navigation: navigation.value
    }
  } catch (error) {
    if (!attemptController.signal.aborted) attemptController.abort(error)
    let cleanupError: unknown
    try {
      dispose()
    } catch (caught) {
      cleanupError = caught
    }
    await Promise.allSettled([restartPromise, navigationPromise].filter((promise): promise is Promise<unknown> => promise !== undefined))
    if (cleanupError !== undefined) throw new Error(`${errorText(error)}; startup watcher cleanup failed: ${errorText(cleanupError)}`)
    throw error
  } finally {
    options.signal.removeEventListener('abort', forwardAbort)
    dispose()
  }
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
  timeoutMs = DEADLINE_MS,
  traceMode: 'none' | 'active' | 'owned' = 'none'
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number; controllerEndpointAt: number; frameTiming?: FrameTiming }> {
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
  const observe = async () => {
    const beganAt = performance.now()
    let controllerEndpointAt = Number.NaN
    const observationPromise = waitForBrowserObserver(
      page, spec.id, timeoutMs, signal, closeContext, OBSERVER_CLEANUP_MS,
      () => { controllerEndpointAt = performance.now() }
    )
    try {
      await withDeadline(action(), timeoutMs, `${spec.kind} action`, signal)
      const observation = await observationPromise
      await ensurePageAlive(page, browser)
      const controllerActionMs = controllerEndpointAt - beganAt
      if (!Number.isFinite(controllerActionMs) || controllerActionMs <= 0) throw new Error(`${spec.kind} controller phase returned invalid timing`)
      return { observation, controllerActionMs, controllerEndpointAt }
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
  if (traceMode !== 'owned') return await observe()
  return await captureObservedFrameTiming({ startTrace: () => startBrowserTrace(browser, signal), observe, signal })
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
  timeoutMs = DEADLINE_MS,
  traceMode: 'none' | 'active' | 'owned' = 'none'
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number; controllerEndpointAt: number; frameTiming?: FrameTiming }> {
  await waitForTerminalVisible(page, worktree, 0, timeoutMs)
  await focusEcho(page, worktree, timeoutMs)
  const sessionId = worktree.sessions[0]
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'echo', workerId: worktree.workerIds[0], sessionId,
    sequence, key
  }
  return await observeAction(page, spec, () => page.keyboard.press(key), signal, timeoutMs, traceMode)
}

async function switchTrial(
  page: Page,
  worktree: SpeedWorktree,
  signal: AbortSignal,
  traceMode: 'none' | 'active' | 'owned' = 'none'
): Promise<{ observation: BrowserObservationResult; controllerActionMs: number; controllerEndpointAt: number; frameTiming?: FrameTiming }> {
  const selector = worktreeButtonSelector(worktree.id)
  await page.locator(selector).waitFor({ state: 'visible', timeout: DEADLINE_MS })
  const spec: BrowserObservationSpec = {
    id: randomUUID(), kind: 'switch', targetId: worktree.id, sessionId: worktree.sessions[0]
  }
  return await observeAction(page, spec, () => page.locator(selector).click({ timeout: DEADLINE_MS }), signal, DEADLINE_MS, traceMode)
}

async function reviewTabs(world: RestartableWorld, worktreeId: string): Promise<string[]> {
  const response = record(await diffSetupRpc(world, 'quirky.terminal/workspace', { workspace: `id:${worktreeId}` }), 'quirky.terminal/workspace')
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
    await diffSetupRpc(world, 'quirky.terminal/closeTab', { tab, yes: true })
  }
  await page.waitForFunction(() => !document.querySelector('[data-review-tab] [data-diff-editor]'), undefined, { timeout: DEADLINE_MS })
  if (await page.locator('[data-review-tab] [data-diff-editor]').count() !== 0) throw new Error('the prior Review editor remained mounted')
}

async function prepareDiffRow(context: MetricContext): Promise<void> {
  await closeHostedReview(context.page, context.world, context.fixture.target.id)
  await diffSetupRpc(context.world, 'ui.tool.open', { id: CHANGES_PANEL })
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

  let startupDeadline: number | undefined
  let spawn: DaemonSpawn | undefined
  let after: SessionSnapshot | undefined
  let ptyAfter: number | null = null
  let postPaintVerificationMs: number | undefined
  const remaining = () => {
    if (startupDeadline === undefined) throw new Error('startup deadline is unavailable before replacement spawn')
    const milliseconds = Math.ceil(startupDeadline - performance.now())
    if (milliseconds <= 0) throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
    return milliseconds
  }

  const coordinated = await coordinateStartupAttempt({
    signal,
    watch: (watchSignal) => watchReplacementRuntime({
      home: context.world.home, signal: watchSignal, timeoutMs: DEADLINE_MS
    }),
    restart: (restartSignal, onSpawn) => withDeadline(
      context.world.restartDaemon(restartSignal, onSpawn),
      DEADLINE_MS + 10_000,
      'daemon restart',
      restartSignal
    ),
    onSpawn: (value) => {
      spawn = value
      startupDeadline = value.spawnedAt + DEADLINE_MS
      if (!Number.isFinite(value.spawnedAt) || value.spawnedAt <= 0) throw new Error('daemon restart returned an invalid spawn boundary')
    },
    onRuntime: (runtime) => collectRuntimeSecrets(context.redactions, runtime),
    navigate: async (runtime, navigationSignal) => {
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
        const readyEcho = await echoTrial(page, worktree, sequence, 'z', navigationSignal, remaining())
        context.sessionSequence.set(worktree.sessions[0], sequence)
        const paintedAt = readyEcho.controllerEndpointAt
        if (paintedAt > (startupDeadline ?? Number.NEGATIVE_INFINITY)) {
          throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
        }
        return {
          value: { navigationBeganAt, rendererReadyAt, readyEcho },
          paintedAt
        }
      }
      try {
        return await withDeadline(endpoint(), remaining(), 'startup renderer readiness', navigationSignal)
      } catch (error) {
        try {
          await withDeadline(context.context.close(), OBSERVER_CLEANUP_MS, 'startup renderer cleanup')
          contextSet.delete(context.context)
        } catch (cleanupError) {
          throw new Error(`${errorText(error)}; startup renderer cleanup failed: ${errorText(cleanupError)}`)
        }
        throw error
      }
    },
    verify: async (restart, navigation, verifySignal) => {
      const verificationBeganAt = performance.now()
      if (!spawn || !Number.isFinite(restart.spawnedAt) || restart.spawnedAt !== spawn.spawnedAt) {
        throw new Error('daemon restart returned an invalid spawn boundary')
      }
      if (context.world.runtime.pid !== context.world.daemonPid) {
        throw new Error('replacement runtime and daemon process identity do not match')
      }
      if (navigation.readyEcho.observation.startedAt >= navigation.readyEcho.observation.endedAt) {
        throw new Error('startup readiness echo returned invalid painted observation timing')
      }
      after = await withDeadline(
        sessionSnapshot(context.world, sessionIds, before.pids),
        remaining(),
        'startup post-paint session verification',
        verifySignal
      )
      ptyAfter = context.world.ptyHostPid()
      if (ptyAfter === null || ptyAfter !== ptyBefore) throw new Error('persistent PTY host changed during daemon restart')
      if (after.ownedPids.length === 0) throw new Error('startup did not preserve any owned session processes')
      postPaintVerificationMs = performance.now() - verificationBeganAt
    }
  })

  const ready = coordinated.navigation
  const durationMs = coordinated.paintedAt - coordinated.spawnedAt
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > DEADLINE_MS) {
    throw new Error(`startup timed out after ${DEADLINE_MS}ms`)
  }
  if (!after || ptyAfter === null || postPaintVerificationMs === undefined) {
    throw new Error('startup completed without post-paint preservation verification')
  }
  const phases = {
    runtimePublicationMs: coordinated.runtimeAt - coordinated.spawnedAt,
    daemonHealthAndControlMs: coordinated.restartAt - coordinated.spawnedAt,
    rendererNavigationAndAttachMs: ready.rendererReadyAt - ready.navigationBeganAt,
    readinessInputToPaintMs: ready.readyEcho.observation.durationMs,
    postPaintVerificationMs,
    controllerUntilFreshPaintMs: durationMs
  }
  context.currentWorktreeIndex = 0
  return {
    durationMs, startedAt: coordinated.spawnedAt, endedAt: coordinated.paintedAt, phases,
    daemonPid: context.world.daemonPid, ptyPid: ptyAfter,
    ownedPids: [...new Set([context.world.daemonPid, ptyAfter, context.browserPid, ...after.ownedPids])],
    observation: ready.readyEcho.observation
  }
}

function emptyFrameIntervalCapture(): FrameIntervalCapture {
  return { intervalsMs: [], duplicateTimestamps: 0, invalidTimestamps: 0 }
}

function recordObservationEvidence(
  row: SpeedSample,
  observation: BrowserObservationResult,
  frameTiming?: FrameTiming
): void {
  row.pacing = observation.pacing
  if (row.metric === 'echo' || row.metric === 'switch' || row.metric === 'floodEcho') {
    row.frameTiming = frameTiming ?? frameTimingFallback(observation, 'frame-timing-capture-missing')
  } else if (frameTiming) {
    row.frameTiming = frameTiming
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
    pacing: emptyFrameIntervalCapture(),
    ...details,
    ...(context.side === undefined ? {} : { side: context.side })
  }
}

function recordTimed(context: MetricContext, row: SpeedSample, duration: number, start: number, end: number, phases: Record<string, number | null>): void {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`${row.metric} sample returned a nonfinite or nonpositive duration`)
  }
  if (row.frameTiming && (row.frameTiming.status !== 'complete' && row.frameTiming.status !== 'unavailable'
    || !Number.isFinite(row.frameTiming.wallMs) || Math.abs(row.frameTiming.wallMs - duration) > 0.001
    || !Number.isFinite(row.frameTiming.effectiveMs) || row.frameTiming.effectiveMs <= 0 || row.frameTiming.effectiveMs > duration
    || !Number.isFinite(row.frameTiming.deductionMs) || row.frameTiming.deductionMs < 0
    || Math.abs(row.frameTiming.effectiveMs + row.frameTiming.deductionMs - duration) > 0.001
    || row.frameTiming.status === 'unavailable' && (row.frameTiming.deductionMs !== 0 || row.frameTiming.effectiveMs !== duration || row.frameTiming.candidate !== null || !row.frameTiming.reason))) {
    row.frameTiming = frameTimingFallback(
      { startedAt: start, endedAt: end, durationMs: duration } as BrowserObservationResult,
      'invalid-frame-timing-result'
    )
  }
  row.durationMs = duration
  row.startedAt = start
  row.endedAt = end
  row.phases = phases
  context.attempts.push(row)
  if (row.phase === 'sample') context.samples[row.metric].push(row.frameTiming?.effectiveMs ?? duration)
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
    row.pacing = trial.observation.pacing
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
  const row = attempt(context, 'echo', phase, sample, {
    worktreeId: worktree.id, sessionId: worktree.sessions[0]
  })
  try {
    const startedController = performance.now()
    const result = await echoTrial(context.page, worktree, sequence, key, signal, DEADLINE_MS, 'owned')
    recordObservationEvidence(row, result.observation, result.frameTiming)
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
    const result = await switchTrial(context.page, worktree, signal, 'owned')
    recordObservationEvidence(row, result.observation, result.frameTiming)
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
    recordObservationEvidence(row, result.observation)
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
    const result = await echoTrial(context.page, worktree, (context.sessionSequence.get(worktree.sessions[0]) ?? 0) + 1, key, signal, DEADLINE_MS, 'owned')
    recordObservationEvidence(row, result.observation, result.frameTiming)
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

function traceWithDataLoss(trace: string, dataLossOccurred: boolean): string {
  const trimmed = trace.trimEnd()
  const closingBrace = trimmed.lastIndexOf('}')
  if (closingBrace !== trimmed.length - 1 || closingBrace < 0) return trace
  const prefix = trimmed.slice(0, closingBrace).trimEnd()
  const comma = prefix.endsWith('{') ? '' : ','
  return `${prefix}${comma}"dataLossOccurred":${dataLossOccurred}${trimmed.slice(closingBrace)}`
}

async function startBrowserTrace(browser: Browser, signal?: AbortSignal): Promise<BrowserTraceSession> {
  const creation = browser.newBrowserCDPSession()
  let session: CDPSession
  try {
    session = await withDeadline(creation, DEADLINE_MS, 'Chromium diagnostic CDP session creation', signal)
  } catch (error) {
    const cleanup = creation.then(async (late) => {
      try {
        await withDeadline(late.detach(), OBSERVER_CLEANUP_MS, 'late Chromium CDP session detach')
      } catch (cleanupError) {
        throw new TraceCleanupError(errorText(cleanupError))
      }
    }, () => undefined)
    void cleanup.catch(() => undefined)
    throw new TraceSetupError(errorText(error), cleanup)
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
      includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading', 'toplevel']
    }
  })
  try {
    await withDeadline(tracingStart, DEADLINE_MS, 'Chromium diagnostic trace start', signal)
  } catch (error) {
    const cleanup = tracingStart.then(async () => {
      let stream: string | undefined
      try {
        await withDeadline(session.send('Tracing.end'), OBSERVER_CLEANUP_MS, 'late Chromium trace stop')
        stream = (await withDeadline(completed.promise, OBSERVER_CLEANUP_MS, 'late Chromium trace flush')).stream
      } catch {
        // A late flush failure is telemetry-only; resource closure below remains mandatory.
      }
      const cleanupErrors: string[] = []
      if (stream) {
        try {
          await withDeadline(session.send('IO.close', { handle: stream }), OBSERVER_CLEANUP_MS, 'late Chromium trace stream close')
        } catch (cleanupError) {
          cleanupErrors.push(errorText(cleanupError))
        }
      }
      try {
        session.off('Tracing.tracingComplete', onComplete)
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      try {
        await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'late Chromium trace session detach')
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      if (cleanupErrors.length > 0) throw new TraceCleanupError(cleanupErrors.join('; '))
    }, async () => {
      const cleanupErrors: string[] = []
      try {
        session.off('Tracing.tracingComplete', onComplete)
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      try {
        await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'failed Chromium trace session detach')
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      if (cleanupErrors.length > 0) throw new TraceCleanupError(cleanupErrors.join('; '))
    })
    const boundedCleanup = withDeadline(cleanup, OBSERVER_CLEANUP_MS * 4, 'late Chromium trace setup cleanup')
    void boundedCleanup.catch(() => undefined)
    throw new TraceSetupError(errorText(error), boundedCleanup)
  }

  let stopped = false
  return {
    async stop(): Promise<string> {
      if (stopped) throw new Error('Chromium diagnostic trace was already stopped')
      stopped = true
      let stream: string | undefined
      let traceText: string | undefined
      let traceError: unknown
      const deadline = performance.now() + DEADLINE_MS
      const remaining = () => {
        const milliseconds = Math.ceil(deadline - performance.now())
        if (milliseconds <= 0) throw new Error(`Chromium diagnostic trace exceeded ${DEADLINE_MS}ms`)
        return milliseconds
      }
      try {
        await withDeadline(session.send('Tracing.end'), remaining(), 'Chromium diagnostic trace stop')
        const result = await withDeadline(completed.promise, remaining(), 'Chromium diagnostic trace flush')
        stream = result.stream
        if (!stream) throw new Error('Chromium diagnostic trace returned no stream')
        const chunks: string[] = []
        let byteCount = 0
        let eof = false
        while (!eof) {
          const chunk = await withDeadline(session.send('IO.read', { handle: stream, size: 256 * 1024 }), remaining(), 'Chromium diagnostic trace read')
          const text = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
          byteCount += Buffer.byteLength(text, 'utf8')
          if (byteCount > MAX_BROWSER_TRACE_BYTES) throw new Error(`Chromium diagnostic trace exceeded ${MAX_BROWSER_TRACE_BYTES} bytes`)
          chunks.push(text)
          eof = chunk.eof
        }
        traceText = traceWithDataLoss(chunks.join(''), result.dataLossOccurred)
        if (Buffer.byteLength(traceText) > MAX_BROWSER_TRACE_BYTES) {
          throw new Error(`Chromium diagnostic trace exceeded ${MAX_BROWSER_TRACE_BYTES} bytes`)
        }
        if (!traceText.includes('"traceEvents"')) throw new Error('Chromium diagnostic trace contained no timeline events')
      } catch (error) {
        traceError = error
      }

      const cleanupErrors: string[] = []
      if (stream) {
        try {
          await withDeadline(session.send('IO.close', { handle: stream }), OBSERVER_CLEANUP_MS, 'Chromium trace stream close')
        } catch (cleanupError) {
          cleanupErrors.push(errorText(cleanupError))
        }
      }
      try {
        session.off('Tracing.tracingComplete', onComplete)
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      try {
        await withDeadline(session.detach(), OBSERVER_CLEANUP_MS, 'Chromium diagnostic trace session detach')
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
      if (cleanupErrors.length > 0) {
        throw new TraceCleanupError([...(traceError === undefined ? [] : [errorText(traceError)]), ...cleanupErrors].join('; '))
      }
      if (traceError !== undefined) throw traceError
      return traceText!
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
  let traceStartCleanup: Promise<void> | undefined
  let traceFault: string | null = null
  let traceContents: string | undefined
  let frameTiming: FrameTiming | undefined
  let tracePath: string | undefined
  let timelinePath: string | undefined
  let floodRunId: string | undefined
  let phases: Record<string, number | null> = {}
  let observation: BrowserObservationResult | undefined
  const resultPath = `diagnostics/${metric}.json`
  mkdirSync(join(context.out, 'diagnostics'), { recursive: true })
  try {
    try {
      browserTrace = await startBrowserTrace(context.browser, signal)
    } catch (error) {
      if (signal.aborted || isTraceCleanupError(error)) throw error
      traceFault = `trace-start-failed: ${errorText(error)}`
      if (error instanceof TraceSetupError) traceStartCleanup = error.cleanup
    }
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
      const trial = await echoTrial(context.page, worktree, sequence, 'y', signal, DEADLINE_MS, 'active')
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
      const trial = await switchTrial(context.page, worktrees[next]!, signal, 'active')
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
      const trial = await echoTrial(context.page, context.fixture.target, sequence, 'x', signal, DEADLINE_MS, 'active')
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
    if (traceStartCleanup) {
      try {
        await withDeadline(traceStartCleanup, OBSERVER_CLEANUP_MS * 4, 'late Chromium trace setup cleanup')
      } catch (error) {
        throw new TraceCleanupError(errorText(error))
      }
      traceStartCleanup = undefined
    }
    if (browserTrace) {
      const activeTrace = browserTrace
      browserTrace = undefined
      try {
        traceContents = await activeTrace.stop()
      } catch (error) {
        if (isTraceCleanupError(error)) throw error
        traceFault = `trace-flush-failed: ${errorText(error)}`
      }
    }
    if (traceContents) {
      tracePath = writeBrowserTrace(context.out, metric, traceContents)
      diagnosticPaths.push(tracePath)
    }
    if (metric === 'echo' || metric === 'switch' || metric === 'floodEcho') {
      frameTiming = traceContents
        ? extractFrameTiming(traceContents, { startedAt: observation.startedAt, endedAt: observation.endedAt, marks: observation.marks })
        : frameTimingFallback(observation, traceFault ?? 'diagnostic-trace-unavailable')
    }
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
      ...(frameTiming === undefined ? {} : { frameTiming }),
      ...(traceFault === null ? {} : { traceError: traceFault }),
      probe: probeEvidence,
      finding: diagnosticFinding(metric, observation.durationMs, phases, activeProbe.probes),
      ...(tracePath === undefined ? {} : { trace: tracePath }),
      timeline: timelinePath
    }
    writeFileSync(join(context.out, resultPath), `${JSON.stringify(diagnostic, null, 2)}\n`)
    diagnosticPaths.push(resultPath)
  } catch (error) {
    if (browserTrace) {
      const activeTrace = browserTrace
      browserTrace = undefined
      try {
        traceContents = await activeTrace.stop()
      } catch (traceError) {
        if (isTraceCleanupError(traceError)) {
          diagnosticErrors.push(`${metric} browser trace cleanup: ${sanitizeText(errorText(traceError), context.redactions)}`)
        } else {
          traceFault = `trace-flush-failed: ${errorText(traceError)}`
        }
      }
      if (traceContents) {
        try {
          tracePath = writeBrowserTrace(context.out, metric, traceContents)
          diagnosticPaths.push(tracePath)
        } catch (traceError) {
          diagnosticErrors.push(`${metric} browser trace artifact: ${sanitizeText(errorText(traceError), context.redactions)}`)
        }
      }
    }
    if (traceStartCleanup) {
      try {
        await withDeadline(traceStartCleanup, OBSERVER_CLEANUP_MS * 4, 'late Chromium trace setup cleanup')
      } catch (cleanupError) {
        diagnosticErrors.push(`${metric} browser trace cleanup: ${sanitizeText(errorText(cleanupError), context.redactions)}`)
      }
      traceStartCleanup = undefined
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
      ...(traceFault === null ? {} : { traceError: traceFault }),
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
type FramePacingAggregate = {
  observedAttempts: number
  intervalsMs: number[]
  duplicateTimestamps: number
  invalidTimestamps: number
  frames: number
  medianIntervalMs: number | null
  p90IntervalMs: number | null
  maxIntervalMs: number | null
  unavailableSamples: number
}

function aggregateFramePacing(metric: Metric, rows: readonly SpeedSample[]): FramePacingAggregate {
  const completed = rows.filter((row) => row.metric === metric && row.phase === 'sample'
    && typeof row.durationMs === 'number' && Number.isFinite(row.durationMs))
  const intervalsMs = completed.flatMap((row) => row.pacing.intervalsMs)
  const summary = intervalsMs.length > 0 ? summarizeFrameIntervals(intervalsMs) : null
  const accountsFrames = metric === 'echo' || metric === 'switch' || metric === 'floodEcho'
  return {
    observedAttempts: completed.length,
    intervalsMs,
    duplicateTimestamps: completed.reduce((sum, row) => sum + row.pacing.duplicateTimestamps, 0),
    invalidTimestamps: completed.reduce((sum, row) => sum + row.pacing.invalidTimestamps, 0),
    frames: intervalsMs.length,
    medianIntervalMs: summary?.medianIntervalMs ?? null,
    p90IntervalMs: summary?.p90IntervalMs ?? null,
    maxIntervalMs: summary?.maxIntervalMs ?? null,
    unavailableSamples: accountsFrames ? completed.filter((row) => row.frameTiming?.status === 'unavailable').length : 0
  }
}

function framePacingDiagnostic(
  gpuCompositing: string,
  preflight: FrameIntervalCapture,
  preflightError: string | null,
  soloAttempts: readonly SpeedSample[],
  pairAttempts: readonly PairAttempt[]
): Record<string, unknown> {
  const summary = preflight.intervalsMs.length > 0 ? summarizeFrameIntervals(preflight.intervalsMs) : null
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric,
    {
      solo: aggregateFramePacing(metric, soloAttempts),
      head: aggregateFramePacing(metric, pairAttempts.filter((row) => row.side === 'head')),
      base: aggregateFramePacing(metric, pairAttempts.filter((row) => row.side === 'base'))
    }
  ]))
  return {
    version: 2,
    gpuCompositing,
    preflight: {
      ...preflight,
      frames: preflight.intervalsMs.length,
      medianIntervalMs: summary?.medianIntervalMs ?? null,
      p90IntervalMs: summary?.p90IntervalMs ?? null,
      maxIntervalMs: summary?.maxIntervalMs ?? null,
      error: preflightError
    },
    metrics
  }
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

  for (let sample = 1; sample <= pairCounts.startup; sample++) {
    await runSides(pairSides(sample), 'startup', 'sample', sample, (context, phase, index) =>
      recordStartupAttempt(context, phase, index, signal, contextSet))
  }

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

export async function measureBrowserFrameIntervals(page: Page, signal: AbortSignal, frameTimestamp?: number): Promise<FrameIntervalCapture> {
  const elementId = `quirky-speed-frame-pacing-${randomUUID()}`
  const measurement = page.evaluate(async ({ id, fixedTimestamp }) => {
    const probe = document.createElement('div')
    const cleanupKey = `__${id}`
    const root = globalThis
    const requestFrame = root.requestAnimationFrame.bind(root)
    const cancelFrame = root.cancelAnimationFrame.bind(root)
    let frameId: number | null = null
    let cancelPending: (() => void) | undefined
    let cancelled = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      if (frameId !== null) cancelFrame(frameId)
      frameId = null
      cancelPending?.()
    }
    Reflect.set(root, cleanupKey, { cancel })
    const waitForFrame = () => {
      const { promise, resolve, reject } = Promise.withResolvers<number>()
      cancelPending = () => reject(new Error('browser frame-pacing probe was cancelled'))
      frameId = requestFrame((timestamp) => {
        frameId = null
        cancelPending = undefined
        resolve(fixedTimestamp ?? timestamp)
      })
      return promise
    }
    const capture: FrameIntervalCapture = { intervalsMs: [], duplicateTimestamps: 0, invalidTimestamps: 0 }
    let previous: number | null = null
    let callbacks = 0
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
      const first = await waitForFrame()
      callbacks++
      if (Number.isFinite(first)) previous = first
      else capture.invalidTimestamps++
      while (capture.intervalsMs.length < 60 && callbacks < 120) {
        probe.style.backgroundColor = callbacks % 2 === 0 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'
        const current = await waitForFrame()
        callbacks++
        if (!Number.isFinite(current)) {
          capture.invalidTimestamps++
          continue
        }
        if (previous !== null) {
          const interval = current - previous
          if (interval > 0) capture.intervalsMs.push(interval)
          else if (interval === 0) capture.duplicateTimestamps++
          else capture.invalidTimestamps++
        }
        previous = current
      }
      return capture
    } finally {
      cancel()
      Reflect.deleteProperty(root, cleanupKey)
      probe.remove()
    }
  }, { id: elementId, fixedTimestamp: frameTimestamp })
  try {
    return await withDeadline(measurement, DEADLINE_MS, 'browser frame-pacing measurement', signal)
  } catch (error) {
    try {
      await withDeadline(page.evaluate((id) => {
        const root = globalThis as typeof globalThis & Record<string, unknown>
        const probeState = Reflect.get(root, `__${id}`)
        if (probeState && typeof probeState === 'object' && 'cancel' in probeState && typeof probeState.cancel === 'function') {
          probeState.cancel()
        }
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
    start(signal: AbortSignal): Promise<{
      head: { world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows }
      base: { world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows }
    }>
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
  let gpuCompositing = 'unavailable'
  let preflightCapture = emptyFrameIntervalCapture()
  let preflightError: string | null = 'frame pacing preflight did not run'
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
      gpuCompositing = await readGpuCompositing(context.browser, signal)
      if (gpuCompositing !== 'disabled_software') {
        throw new Error(`browser is not compositing in software: ${gpuCompositing}`)
      }
      try {
        preflightCapture = await measureBrowserFrameIntervals(context.page, signal, frameTimestamp)
        preflightError = preflightCapture.intervalsMs.length > 0 ? null : 'no positive native frame intervals were observed'
      } catch (error) {
        if (errorText(error).includes('frame-pacing probe cleanup failed')) throw error
        preflightError = errorText(error)
      }
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
        for (const browserContext of contexts) {
          try {
            await withDeadline(browserContext.close(), OBSERVER_CLEANUP_MS, 'solo browser context cleanup')
          } catch (error) {
            failures.push({ kind: 'context-cleanup-failed', message: sanitizeText(errorText(error), redactions) })
          }
        }
        contexts.clear()

        let pairedStart: {
          head: { world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows }
          base: { world: RestartableWorld; fixture: SpeedFixture; windows: SoakWindows }
        } | undefined
        try {
          pairedStart = await options.pair.start(signal)
          for (const side of ['head', 'base'] as const) {
            const subject = pairedStart[side]
            redactions.add(subject.world.home)
            collectRuntimeSecrets(redactions, subject.world.runtime)
            pairOwnedPids.push(
              subject.world.daemonPid,
              subject.world.ptyHostPid() ?? -1,
              subject.windows.browserPid
            )
          }
        } catch (error) {
          recordPairFailure(signal.aborted ? 'pair-interrupted' : 'pair-setup-failed', error)
        }

        if (pairedStart && signal.aborted) {
          recordPairFailure('pair-interrupted', new Error('speed measurement interrupted'))
        } else if (pairedStart) {
          let headContext: MetricContext | undefined
          let baseContext: MetricContext | undefined
          try {
            headContext = await createMetricContext({
              world: pairedStart.head.world,
              windows: pairedStart.head.windows,
              fixture: pairedStart.head.fixture,
              samples: pairResult.samples.head,
              attempts: pairResult.attempts,
              out,
              signal,
              redactions,
              side: 'head',
              pairOwnedPids
            })
            baseContext = await createMetricContext({
              world: pairedStart.base.world,
              windows: pairedStart.base.windows,
              fixture: pairedStart.base.fixture,
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

          if (headContext && baseContext) {
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
  try {
    mkdirSync(join(out, 'diagnostics'), { recursive: true })
    const pacing = framePacingDiagnostic(gpuCompositing, preflightCapture, preflightError, attempts, pairAttempts)
    writeFileSync(join(out, 'diagnostics', 'frame-pacing.json'), `${JSON.stringify(pacing, null, 2)}\n`)
    diagnostics.push('diagnostics/frame-pacing.json')
  } catch (error) {
    failures.push({
      kind: 'diagnostic-evidence-error',
      message: sanitizeText(`frame pacing diagnostic: ${errorText(error)}`, redactions)
    })
  }
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
