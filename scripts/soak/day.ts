import { UI_TOOL_SLOTS, type QuirkyClient, type UiToolSlot } from '@quirky/protocol'
import type { DayInputs, PanelKey, PhaseRecord, SwitchRecord, TaskInteractionRecord } from './contracts.ts'
import type { SoakWindows } from './windows.ts'

export const SWITCH_SECONDS = 60
export const PANEL_PHASE_SECONDS = 120
export const SWITCH_FOLLOW_MS = 10_000
export const MOUNT_TIMEOUT_MS = 30_000
export const RECONCILE_MS = 5_000
export const STOP_DRAIN_MS = 10_000
export const TASK_FOLLOW_MS = 10_000

export const NAMED_PANELS: readonly { panel: 'checks' | 'explorer' | 'tasks'; tool: string }[] = [
  { panel: 'checks', tool: 'panel:quirky.reviews/checks' },
  { panel: 'explorer', tool: 'panel:quirky.editor/explorer' },
  { panel: 'tasks', tool: 'sidebar-section:quirky.tasks/tasks' },
]

export const PANEL_PHASES: readonly { name: 'review' | 'agents'; tools: Record<UiToolSlot, string> }[] = [
  {
    name: 'review',
    tools: {
      'left-top': 'sidebar-section:quirky.worktree/worktrees',
      'left-bottom': 'sidebar-section:quirky.tasks/tasks',
      'right-top': 'panel:quirky.git/source-control',
      'right-bottom': 'panel:quirky.reviews/checks',
      'bottom-left': 'panel:quirky.terminal/sessions',
      'bottom-right': 'panel:quirky.editor/explorer',
    },
  },
  {
    name: 'agents',
    tools: {
      'left-top': 'sidebar-section:quirky.worktree/worktrees',
      'left-bottom': 'sidebar-section:quirky.tasks/tasks',
      'right-top': 'panel:quirky.git/source-control',
      'right-bottom': 'panel:quirky.session-info/info',
      'bottom-left': 'panel:quirky.ask/questions',
      'bottom-right': 'panel:quirky.vault/history',
    },
  },
]

export type DayAction =
  | { at: number; kind: 'phase'; seq: number; phase: number }
  | { at: number; kind: 'switch'; seq: number; index: number; to: string }
  | { at: number; kind: 'task'; seq: number; index: number }

export function dayIdentity(action: DayAction | SwitchRecord | PhaseRecord | TaskInteractionRecord): string {
  if ('kind' in action) {
    return action.kind === 'phase' ? `phase:${action.seq}` : `${action.kind}:${action.index}:${action.seq}`
  }
  return 'phase' in action ? `phase:${action.seq}` : `switch:${action.index}:${action.seq}`
}

export function daySchedule(options: {
  seconds: number
  windows: readonly { index: number; worktree: string }[]
  worktrees: readonly string[]
}): DayAction[] {
  const { seconds, windows, worktrees } = options
  if (!Number.isFinite(seconds) || seconds <= 0) return []

  const actions: DayAction[] = []
  for (const { index } of windows) {
    const at = 15 + index * 5
    if (at + TASK_FOLLOW_MS / 1000 <= seconds) actions.push({ at, kind: 'task', seq: 0, index })
  }
  const switchGraceSeconds = SWITCH_FOLLOW_MS / 1000 + RECONCILE_MS / 1000
  if (windows.length > 0 && worktrees.length > 0) {
    for (const window of windows) {
      const start = worktrees.indexOf(window.worktree)
      for (let seq = 0; ; seq += 1) {
        const at = SWITCH_SECONDS * (seq + 1) + window.index * SWITCH_SECONDS / windows.length
        if (at + switchGraceSeconds > seconds) break
        const targetIndex = ((start + seq + 1) % worktrees.length + worktrees.length) % worktrees.length
        actions.push({ at, kind: 'switch', seq, index: window.index, to: worktrees[targetIndex]! })
      }
    }
  }

  for (let seq = 1; ; seq += 1) {
    const at = PANEL_PHASE_SECONDS * seq
    if (at + MOUNT_TIMEOUT_MS / 1000 > seconds) break
    actions.push({ at, kind: 'phase', seq, phase: seq % 2 })
  }

  return actions.sort((left, right) => {
    const byTime = left.at - right.at
    if (byTime !== 0) return byTime
    if (left.kind !== right.kind) return left.kind === 'phase' ? -1 : right.kind === 'phase' ? 1 : left.kind === 'task' ? -1 : 1
    return left.kind !== 'phase' && right.kind !== 'phase' ? left.index - right.index : 0
  })
}

export function panelOfRequest(method: string, params: unknown): PanelKey | null {
  const values = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : null

  if (method === 'quirky.git/status') return 'changes'
  if (method === 'quirky.reviews/checksRefresh' && values?.force === true) return 'checks'
  if (method === 'quirky.reviews/state' && typeof values?.worktree === 'string') return 'checks'
  if (method === 'quirky.editor/explorer' && (values?.action === 'list' || values?.action === 'refresh')) return 'explorer'
  if (method === 'quirky.tasks/state' || method === 'quirky.tasks/prepare') return 'tasks'
  if (method === 'quirky.session-info/get') return 'session-info'
  if (method === 'soak.faults/feedbackRefresh') return 'feedback'
  return null
}

export type { DayInputs }

type PhaseResult = { applyMs: number; missing: { index: number; panel: PanelKey }[]; error: string | null }
export type DayResult = { switches: SwitchRecord[]; phases: PhaseRecord[]; taskInteractions: TaskInteractionRecord[]; drainError: string | null }
export type DayDriver = { stop(): Promise<DayResult> }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bounded<T>(task: Promise<T>, milliseconds: number, signal: AbortSignal, label: string): Promise<T> {
  const pending = Promise.withResolvers<T>()
  const deadline = performance.now() + milliseconds
  const abort = () => pending.reject(new Error('day action was interrupted'))
  const timer = setTimeout(() => pending.reject(new Error(label)), Math.max(0, milliseconds))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  task.then((value) => {
    if (performance.now() >= deadline) pending.reject(new Error(label))
    else pending.resolve(value)
  }, pending.reject)
  return pending.promise.finally(() => {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  })
}

/** Applies a shared layout and proves every newly opened data panel before one deadline. */
export async function applyPhase(options: {
  control: QuirkyClient; windows: SoakWindows; phase: number; previous: number | null; signal: AbortSignal
}): Promise<PhaseResult> {
  const { control, windows, phase, previous, signal } = options
  const since = performance.now()
  const deadline = since + MOUNT_TIMEOUT_MS
  const missing: PhaseResult['missing'] = []
  const phaseAbort = new AbortController()
  const abort = () => phaseAbort.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const remaining = () => Math.max(0, deadline - performance.now())
  const call = (method: string, params: Record<string, unknown>) => {
    if (phaseAbort.signal.aborted) return Promise.reject(new Error('day action was interrupted'))
    if (remaining() <= 0) return Promise.reject(new Error(`phase did not finish within ${MOUNT_TIMEOUT_MS}ms`))
    return bounded(control.callAny(method, params, { timeoutMs: remaining() }), remaining(), phaseAbort.signal,
      `phase did not finish within ${MOUNT_TIMEOUT_MS}ms`)
  }
  let error: string | null = null
  try {
    const layout = PANEL_PHASES[phase]
    if (!layout) throw new Error(`unknown panel phase ${phase}`)
    if (!windows.liveness || !windows.waitForRequest) throw new Error('windows lack phase instrumentation')
    for (const slot of UI_TOOL_SLOTS) {
      const id = layout.tools[slot]
      await call('ui.tool.move', { id, slot })
      await call('ui.tool.open', { id })
    }
    const live = windows.liveness()
    const errors = await Promise.all(live.map(async ({ index, connId }) => {
      const state = await call('ui.window.state', { connId })
      if (state === null || typeof state !== 'object' || !('layout' in state)) return `window ${index}: layout is unreadable`
      const windowLayout = state.layout
      if (windowLayout === null || typeof windowLayout !== 'object' || !('tools' in windowLayout)) return `window ${index}: tools are unreadable`
      const tools = windowLayout.tools
      if (tools === null || typeof tools !== 'object' || !('open' in tools)) return `window ${index}: open tools are unreadable`
      const open = tools.open
      if (open === null || typeof open !== 'object') return `window ${index}: open tools are unreadable`
      for (const slot of UI_TOOL_SLOTS) {
        const actual: unknown = slot in open ? Reflect.get(open, slot) : undefined
        if (actual !== layout.tools[slot]) return `window ${index}: ${slot} shows ${String(actual)}, expected ${layout.tools[slot]}`
      }
      return null
    }))
    const mismatch = errors.find((value) => value !== null)
    if (mismatch) throw new Error(mismatch)
    const before = previous === null ? undefined : PANEL_PHASES[previous]
    const newlyShown = NAMED_PANELS.filter(({ tool }) => Object.values(layout.tools).includes(tool)
      && (!before || !Object.values(before.tools).includes(tool)))
    const proofs = live.flatMap(({ index }) => newlyShown.map(({ panel }) => ({ index, panel })))
    const results = await Promise.all(proofs.map(async ({ index, panel }) => {
      const request = await bounded(windows.waitForRequest!(index,
        (method, params) => panelOfRequest(method, params) === panel,
        { since, timeoutMs: remaining(), signal: phaseAbort.signal }), remaining(), phaseAbort.signal,
        `window ${index}: ${panel} panel did not mount within ${MOUNT_TIMEOUT_MS}ms`
      ).catch((reason: unknown) => {
        if (signal.aborted) throw reason
        return null
      })
      return request === null
    }))
    results.forEach((absent, index) => { if (absent) missing.push(proofs[index]!) })
    const first = missing[0]
    if (first) error = `window ${first.index}: ${first.panel} panel did not mount within ${MOUNT_TIMEOUT_MS}ms`
  } catch (reason) {
    error = message(reason)
  } finally {
    phaseAbort.abort()
    signal.removeEventListener('abort', abort)
  }
  if (error !== null && previous === null) throw new Error(error)
  return { applyMs: Math.max(0, performance.now() - since), missing, error }
}

function until(at: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || performance.now() >= at) return Promise.resolve()
  const pending = Promise.withResolvers<void>()
  const done = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', done)
    pending.resolve()
  }
  const timer = setTimeout(done, at - performance.now())
  signal.addEventListener('abort', done, { once: true })
  return pending.promise
}

function tasksPreference(value: unknown): { revision: number; preset: string } {
  if (value === null || typeof value !== 'object' || !('revision' in value)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || !('preferences' in value) || value.preferences === null || typeof value.preferences !== 'object'
    || !('defaultTaskViewPreset' in value.preferences) || typeof value.preferences.defaultTaskViewPreset !== 'string') {
    throw new Error('Tasks state is unreadable')
  }
  return { revision: value.revision, preset: value.preferences.defaultTaskViewPreset }
}

async function interactWithTasks(
  control: QuirkyClient, windows: SoakWindows, index: number, signal: AbortSignal
): Promise<Omit<TaskInteractionRecord, 'at' | 'seq'>> {
  const since = performance.now()
  const deadline = since + TASK_FOLLOW_MS
  const remaining = () => Math.max(0, deadline - performance.now())
  const method = 'quirky.tasks/preferences'
  const call = (name: string, params: Record<string, unknown>) => {
    if (signal.aborted) return Promise.reject(new Error('day action was interrupted'))
    if (remaining() <= 0) return Promise.reject(new Error(`Tasks interaction did not finish within ${TASK_FOLLOW_MS}ms`))
    return bounded(control.callAny(name, params, { timeoutMs: remaining() }), remaining(), signal,
      `Tasks interaction did not finish within ${TASK_FOLLOW_MS}ms`)
  }
  try {
    const before = tasksPreference(await call('quirky.tasks/state', {}))
    const next = before.preset === 'all' ? 'issues' : 'all'
    const proofSince = performance.now()
    await call(method, { defaultTaskViewPreset: next })
    const after = tasksPreference(await call('quirky.tasks/state', {}))
    if (after.preset !== next || after.revision <= before.revision) throw new Error('Tasks preference change was not confirmed')
    if (!windows.waitForRequest) throw new Error('windows lack Tasks request instrumentation')
    const proof = await bounded(windows.waitForRequest(index, (name) => name === 'quirky.tasks/state',
      { since: proofSince, timeoutMs: remaining(), signal }), remaining(), signal,
      `window ${index}: did not request Tasks state within ${TASK_FOLLOW_MS}ms`)
    if (proof === null) throw new Error(`window ${index}: did not request Tasks state within ${TASK_FOLLOW_MS}ms`)
    return { kind: 'task', index, method, ok: true, proof: { at: proof.at, method: proof.method }, error: null }
  } catch (error) {
    return { kind: 'task', index, method, ok: false, proof: null, error: message(error) }
  }
}

/** Runs the scheduled workload sequentially and seals its records after a bounded abort drain. */
export function startDay(options: {
  control: QuirkyClient; windows: SoakWindows; schedule: readonly DayAction[]; startedAt: number; signal: AbortSignal
}): DayDriver {
  const { control, windows, schedule, startedAt, signal } = options
  const aborter = new AbortController()
  const abort = () => aborter.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const switches: SwitchRecord[] = []
  const phases: PhaseRecord[] = []
  const taskInteractions: TaskInteractionRecord[] = []
  let previous = 0
  let sealed = false
  let stopPromise: Promise<DayResult> | undefined
  const work = (async () => {
    for (const action of schedule) {
      await until(startedAt + action.at * 1000, aborter.signal)
      if (aborter.signal.aborted || sealed) return
      const at = (performance.now() - startedAt) / 1000
      if (action.kind === 'phase') {
        const result = await applyPhase({ control, windows, phase: action.phase, previous, signal: aborter.signal })
        if (aborter.signal.aborted || sealed) return
        phases.push({ at, seq: action.seq, phase: action.phase, ok: result.error === null && result.missing.length === 0, ...result })
        previous = action.phase
      } else if (action.kind === 'task') {
        const result = await interactWithTasks(control, windows, action.index, aborter.signal)
        if (aborter.signal.aborted || sealed) return
        taskInteractions.push({ at, seq: action.seq, ...result })
      } else {
        const from = windows.liveness?.().find(({ index }) => index === action.index)?.worktree ?? ''
        let result: Omit<SwitchRecord, 'at' | 'seq'>
        try {
          if (!windows.navigate) throw new Error('windows lack navigation instrumentation')
          result = await windows.navigate(action.index, action.to, { signal: aborter.signal, followTimeoutMs: SWITCH_FOLLOW_MS })
        } catch (reason) {
          result = {
            index: action.index, from, requested: action.to,
            settled: windows.liveness?.().find(({ index }) => index === action.index)?.worktree ?? from,
            proof: null, ok: false, followMs: null, error: message(reason)
          }
        }
        if (aborter.signal.aborted || sealed) return
        switches.push({ at, seq: action.seq, ...result })
      }
    }
  })()
  return {
    stop() {
      if (stopPromise) return stopPromise
      aborter.abort()
      stopPromise = (async () => {
        let drainError: string | null = null
        try {
          await bounded(work, STOP_DRAIN_MS, new AbortController().signal, `active action did not drain within ${STOP_DRAIN_MS}ms`)
        } catch (reason) {
          drainError = message(reason)
        }
        sealed = true
        signal.removeEventListener('abort', abort)
        return { switches: switches.slice(), phases: phases.slice(), taskInteractions: taskInteractions.slice(), drainError }
      })()
      return stopPromise
    }
  }
}
