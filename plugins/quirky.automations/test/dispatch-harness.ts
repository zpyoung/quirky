import { Database } from 'bun:sqlite'
import type { PluginStore, StoreValue } from '@quirky/protocol'
import type {
  AutomationDefinition,
  AutomationRun,
  AutomationStore
} from '../types'
import type {
  AutomationDispatchContext,
  AutomationDispatchHooks,
  AutomationTarget,
  AutomationTargetResolution,
  AutomationTargetResolver
} from '../dispatch-contract'
import { createAutomationStore, migrations } from '../store'

export type PublicCall = { method: string; params: Record<string, unknown> }
export type ScriptedSession = {
  id: string
  kind: 'structured' | 'terminal'
  agent: string
  worktreeId: string
  cwd: string
  title: string
  status: 'starting' | 'running' | 'working' | 'waiting' | 'done' | 'exited'
  createdAt: number
  lastActivityAt: number
  exitCode: number | null
  exitSignal: string | null
  exitCause: null
  restorable: false
  launchSettings: Record<string, unknown> | null
}
export type ScriptedMessage = {
  sessionId: string
  seq: number
  role: 'user' | 'assistant' | 'result' | 'system' | 'tool'
  text: string
  at: number
  data?: unknown
}

export type ScriptedCheckResult = {
  ran: boolean
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdoutTail: string
  stderrTail: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  error?: string
}

export interface DispatchHarness {
  database: Database
  store: AutomationStore
  context: AutomationDispatchContext
  hooks: AutomationDispatchHooks
  calls: PublicCall[]
  sessions: Map<string, ScriptedSession>
  messages: Map<string, ScriptedMessage[]>
  changedRuns: string[]
  appendMessage(sessionId: string, role: ScriptedMessage['role'], text: string, data?: unknown): ScriptedMessage
  setStatus(sessionId: string, status: ScriptedSession['status'], exitCode?: number | null): void
  resolution: AutomationTargetResolution
  setCheckResult(value: ScriptedCheckResult): void
  setCheckError(error: Error | null): void
  setCheckGate(value: Promise<ScriptedCheckResult>): void
  checkWasStarted: Promise<void>
  checkCancelCount: number
  setWorktreeResult(value: Record<string, unknown>): void
  onCreate: ((session: ScriptedSession, prompt: string) => void) | null
  onSend: ((session: ScriptedSession, prompt: string) => void) | null
  setNow(value: number): void
  addDefinition(definition: AutomationDefinition): AutomationDefinition
  addRun(definition: AutomationDefinition, trigger?: 'manual' | 'scheduled'): AutomationRun
  waitForRunStatus(runId: string, status: AutomationRun['status']): Promise<AutomationRun>
  close(): void
}

export function makeDefinition(id: string, now: number, patch: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id,
    name: `Automation ${id}`,
    prompt: 'Make the requested change.',
    agentId: 'claude',
    projectId: 'repo-a',
    workspaceMode: 'existing',
    workspaceId: 'wt-existing',
    baseBranch: null,
    reuseSession: false,
    runContext: null,
    sourceContext: null,
    launchOverrides: null,
    precheck: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: now - 60_000,
    enabled: true,
    nextRunAt: now - 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    owner: {
      kind: 'local',
      repoId: 'repo-a',
      repoPath: '/repo-a',
      workspaceId: 'wt-existing',
      workspacePath: '/repo-a/work',
      workspaceInstanceId: 'instance-a'
    },
    ...patch
  }
}

export function createDispatchHarness(now = 1_800_000_000_000): DispatchHarness {
  const database = new Database(':memory:')
  const pluginStore: PluginStore = {
    get version() { return migrations.length },
    run(sql: string, ...params: StoreValue[]) {
      const result = database.query(sql).run(...params)
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]) {
      return database.query(sql).get(...params) as T | null
    },
    all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]) {
      return database.query(sql).all(...params) as T[]
    },
    exec(sql: string) { database.exec(sql) },
    transaction<T>(work: () => T) { return database.transaction(work)() }
  }
  for (const migration of migrations) {
    if (typeof migration === 'string') database.exec(migration)
    else migration(pluginStore)
  }
  const store = createAutomationStore(pluginStore)
  const calls: PublicCall[] = []
  const sessions = new Map<string, ScriptedSession>()
  const messages = new Map<string, ScriptedMessage[]>()
  const listeners = new Set<(event: { type: string; data?: unknown }) => void>()
  const changedRuns: string[] = []
  const changeWaiters = new Map<string, Set<() => void>>()
  const repoTarget: AutomationTarget = {
    repoId: 'repo-a',
    repoPath: '/repo-a',
    cwd: '/repo-a/work',
    workspaceId: 'wt-existing',
    workspaceDisplayName: 'work',
    owner: {
      kind: 'local',
      repoId: 'repo-a',
      repoPath: '/repo-a',
      workspaceId: 'wt-existing',
      workspacePath: '/repo-a/work',
      workspaceInstanceId: 'instance-a'
    }
  }
  let resolution: AutomationTargetResolution = { available: true, target: repoTarget }
  let checkResult: ScriptedCheckResult = {
    ran: true, pass: true, exitCode: 0, timedOut: false, aborted: false,
    stdoutTail: '', stderrTail: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1
  }
  let checkGate: Promise<ScriptedCheckResult> | null = null
  let checkError: Error | null = null
  const checkStarted = Promise.withResolvers<void>()
  const checkWasStarted = checkStarted.promise
  let checkCancelCount = 0
  let worktreeResult: Record<string, unknown> | null = null
  let onCreate: ((session: ScriptedSession, prompt: string) => void) | null = null
  let onSend: ((session: ScriptedSession, prompt: string) => void) | null = null
  let nextSession = 0
  let nowValue = now

  const announce = (event: { type: string; data?: unknown }) => {
    for (const listener of listeners) listener(event)
  }
  const appendMessage = (
    sessionId: string,
    role: ScriptedMessage['role'],
    text: string,
    data?: unknown
  ): ScriptedMessage => {
    const entries = messages.get(sessionId) ?? []
    const message: ScriptedMessage = {
      sessionId,
      seq: (entries.at(-1)?.seq ?? 0) + 1,
      role,
      text,
      at: nowValue,
      ...(data === undefined ? {} : { data })
    }
    entries.push(message)
    messages.set(sessionId, entries)
    announce({ type: 'quirky.structured/message', data: { message } })
    return message
  }
  const setStatus = (sessionId: string, status: ScriptedSession['status'], exitCode: number | null = null) => {
    const session = sessions.get(sessionId)
    if (!session) return
    session.status = status
    session.exitCode = exitCode
    session.lastActivityAt = nowValue
    announce({ type: 'quirky.session/changed', data: { session } })
  }
  const makeSession = (params: Record<string, unknown>): ScriptedSession => {
    const id = `s_${++nextSession}`
    const worktreeId = String(params.worktree).replace(/^id:/, '')
    const launchSettings = params.agent === undefined ? null : {
      agent: params.agent,
      options: {
        ...(typeof params.model === 'string' ? { model: { value: params.model, source: 'explicit' } } : {}),
        ...(typeof params.options === 'object' && params.options !== null
          ? Object.fromEntries(Object.entries(params.options).map(([key, value]) => [key, { value, source: 'explicit' }]))
          : {})
      },
      summary: 'scripted native launch'
    }
    const session: ScriptedSession = {
      id,
      kind: 'structured',
      agent: String(params.agent),
      worktreeId,
      cwd: worktreeId === 'wt-created' ? '/repo-a/created' : '/repo-a/work',
      title: String(params.agent),
      status: 'working',
      createdAt: nowValue,
      lastActivityAt: nowValue,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false,
      launchSettings
    }
    sessions.set(id, session)
    messages.set(id, [])
    const prompt = String(params.prompt ?? '')
    appendMessage(id, 'user', prompt)
    return session
  }
  const getCheck = async (): Promise<ScriptedCheckResult> => {
    checkStarted.resolve()
    if (checkError) throw checkError
    return checkGate ?? checkResult
  }

  const context: AutomationDispatchContext = {
    async call(method, params = {}) {
      const copied = { ...params }
      calls.push({ method, params: copied })
      if (method === 'quirky.checks/run') return getCheck()
      if (method === 'quirky.checks/cancel') {
        checkCancelCount += 1
        return { cancelled: true }
      }
      if (method === 'quirky.worktree/create') {
        if (worktreeResult) return worktreeResult
        return {
          worktree: { id: 'wt-created', path: '/repo-a/created', name: String(params.name), repoId: 'repo-a' },
          setup: { ran: 'skipped' },
          warnings: []
        }
      }
      if (method === 'quirky.agents/resolveLaunch') {
        const options = typeof params.options === 'object' && params.options !== null ? params.options as Record<string, unknown> : {}
        return {
          structured: {
            ...(typeof params.model === 'string' ? { model: params.model } : {}),
            ...(typeof options.effort === 'string' ? { effort: options.effort } : {})
          },
          launchSettings: { agent: params.agent, summary: 'resolved' }
        }
      }
      if (method === 'quirky.structured/create') {
        const session = makeSession(copied)
        onCreate?.(session, String(params.prompt ?? ''))
        return session
      }
      if (method === 'quirky.structured/send') {
        const session = sessions.get(String(params.session))
        if (!session || session.kind !== 'structured' || session.status === 'exited') throw new Error('session unavailable')
        const prompt = String(params.text ?? '')
        appendMessage(session.id, 'user', prompt)
        setStatus(session.id, 'working')
        onSend?.(session, prompt)
        return { ok: true }
      }
      if (method === 'quirky.structured/messages') {
        const sessionId = String(params.session)
        const afterSeq = Number(params.afterSeq ?? 0)
        return (messages.get(sessionId) ?? []).filter((message) => message.seq > afterSeq)
      }
      if (method === 'quirky.structured/stop') {
        setStatus(String(params.session), 'exited', 1)
        return { ok: true }
      }
      if (method === 'quirky.session/get') {
        const session = sessions.get(String(params.session))
        if (!session) throw new Error(`session ${String(params.session)} was not found`)
        return session
      }
      if (method === 'quirky.session/list') return [...sessions.values()]
      throw new Error(`unexpected public daemon call ${method}`)
    },
    subscribe(listener) {
      listeners.add(listener as (event: { type: string; data?: unknown }) => void)
      return () => listeners.delete(listener as (event: { type: string; data?: unknown }) => void)
    },
    error(kind, message) { return Object.assign(new Error(message), { kind }) },
    log() {}
  }
  const targets: AutomationTargetResolver = {
    async capture(definition) { return definition },
    async resolve() { return resolution },
    assertExpectedOwner() {}
  }
  const lanes = new Map<string, Promise<unknown>>()
  const waitForRunStatus = async (runId: string, status: AutomationRun['status']): Promise<AutomationRun> => {
    while (true) {
      const current = store.getRun(runId)
      if (!current) throw new Error(`run ${runId} was removed before reaching ${status}`)
      if (current.status === status) return current
      const { promise, resolve } = Promise.withResolvers<void>()
      const notify = () => resolve()
      const waiters = changeWaiters.get(runId) ?? new Set<() => void>()
      waiters.add(notify)
      changeWaiters.set(runId, waiters)
      const afterSubscribe = store.getRun(runId)
      if (!afterSubscribe || afterSubscribe.status === status) {
        waiters.delete(notify)
        if (!afterSubscribe) throw new Error(`run ${runId} was removed before reaching ${status}`)
        continue
      }
      await promise
      waiters.delete(notify)
      if (waiters.size === 0) changeWaiters.delete(runId)
    }
  }
  const hooks: AutomationDispatchHooks = {
    store,
    targets,
    clock: () => nowValue,
    inLane<T>(id: string, work: () => T | Promise<T>): Promise<T> {
      const previous = (lanes.get(id) ?? Promise.resolve()) as Promise<unknown>
      const current = previous.then(work, work)
      const settled = current.then(() => undefined, () => undefined)
      lanes.set(id, settled)
      return current.finally(() => { if (lanes.get(id) === settled) lanes.delete(id) })
    },
    changed(_automationId, runId) {
      changedRuns.push(runId)
      for (const notify of changeWaiters.get(runId) ?? []) notify()
    }
  }
  return {
    database,
    store,
    context,
    hooks,
    calls,
    sessions,
    messages,
    changedRuns,
    appendMessage,
    setStatus,
    get resolution() { return resolution },
    set resolution(value: AutomationTargetResolution) { resolution = value },
    setCheckResult(value: ScriptedCheckResult) { checkResult = value },
    setCheckError(error: Error | null) { checkError = error },
    setCheckGate(value: Promise<ScriptedCheckResult>) { checkGate = value },
    checkWasStarted,
    get checkCancelCount() { return checkCancelCount },
    setWorktreeResult(value: Record<string, unknown>) { worktreeResult = value },
    get onCreate() { return onCreate },
    set onCreate(value: ((session: ScriptedSession, prompt: string) => void) | null) { onCreate = value },
    get onSend() { return onSend },
    set onSend(value: ((session: ScriptedSession, prompt: string) => void) | null) { onSend = value },
    setNow(value: number) { nowValue = value },
    addDefinition(definition: AutomationDefinition) { return store.insert(definition) },
    addRun(definition: AutomationDefinition, trigger: 'manual' | 'scheduled' = 'scheduled') {
      store.insert(definition)
      return store.createRun(definition.id, { trigger, scheduledFor: nowValue, now: nowValue })
    },
    waitForRunStatus,
    close() { database.close() }
  }
}

export function makeCheckResult(overrides: Partial<ScriptedCheckResult> = {}): ScriptedCheckResult {
  return {
    ran: true, pass: true, exitCode: 0, timedOut: false, aborted: false,
    stdoutTail: '', stderrTail: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 4,
    ...overrides
  }
}
