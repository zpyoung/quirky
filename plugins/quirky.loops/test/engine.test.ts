import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { RpcErrorCode, type PluginContext, type PluginStore, type QuirkyEvent, type RunOptions, type RunResult, type Session, type StructuredMessage, type Worktree } from '@quirky/protocol'
import * as supervision from '@quirky/supervision'
import type { StructuredSample, StructuredWatch, SupervisionEngine } from '@quirky/supervision'

import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import type { LoopCreateInput } from '../src/types'
import { normalizeLoopConfig } from '../src/config'
import { loopMigrations } from '../src/store'
import { LoopService } from '../src/service'
import { HostPowerService } from '../../../packages/daemon/src/host-power'

const roots: string[] = []
const runtimes: Runtime[] = []
const activeServices: LoopService[] = []
const processRunners: OwnedProcessRunner[] = []
const syncProcessMocks: { mockRestore(): void }[] = []
afterEach(async () => {
  for (const mock of syncProcessMocks.splice(0)) mock.mockRestore()
  for (const runtime of runtimes) runtime.releasePendingOperations()
  await Promise.all(activeServices.splice(0).map((service) => service.shutdown()))
  await Promise.all(processRunners.splice(0).map((runner) => runner.dispose()))
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type ScriptedTurn = 'settle' | 'exit' | 'hold'
type SendBarrier = { entered: () => void; wait: Promise<void>; release: () => void; settled: () => void }
type JournalReadGate = { entered: () => void; wait: Promise<void>; release: () => void }
type HeldJournalRead = { entered: Promise<void>; release: () => void }
type ProcessHandler = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>
type ProcessCall = { argv: string[]; options?: RunOptions }

function runResult(stdoutText = '', overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function forbidSynchronousExecFileSync(): void {
  const mock = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
    throw new Error('synchronous process execution is forbidden')
  })
  syncProcessMocks.push(mock)
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

class Runtime {
  readonly processCalls: ProcessCall[] = []
  processHandler: ProcessHandler | null = null
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  readonly events: QuirkyEvent[] = []
  readonly sends: { session: string; text: string; expectedAfterSeq: number }[] = []
  readonly sendAttempts: { session: string; text: string; expectedAfterSeq: number }[] = []
  readonly stopped: string[] = []
  readonly closed: string[] = []
  readonly resumed: string[] = []
  readonly created: string[] = []
  readonly sessions = new Map<string, Session>()
  readonly journals = new Map<string, StructuredMessage[]>()
  readonly subscribers = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  readonly waiters = new Set<() => void>()
  readonly turns: ScriptedTurn[] = []
  readonly cumulativeCosts: number[] = []
  readonly failedJournalResponsesAfterSend: unknown[] = []
  readonly failedJournalCursors: number[] = []
  readonly journalCursorsAfterFailure: number[] = []
  pendingAsks: { id: string; sessionId: string; envelope: { status: 'pending' } }[] = []
  private sessionCount = 0
  private sendBarrier: SendBarrier | null = null
  private activeSendRelease: (() => void) | null = null
  private journalReadGateAfterFailure: JournalReadGate | null = null
  private journalReadGate: JournalReadGate | null = null
  private readonly database: Database
  private readonly pluginStore: PluginStore
  readonly context: PluginContext
  readonly worktree: Worktree
  readonly root: string

  constructor(root: string, kind: 'folder' | 'git' = 'folder') {
    this.root = root
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'quirky-home'), { recursive: true })
    this.database = new Database(join(root, 'quirky-home', 'loops.sqlite'))
    let version = 0
    this.pluginStore = {
      get version() { return version },
      run: (sql, ...params) => {
        const result = this.database.query(sql).run(...params)
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
      },
      get: <T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]) => this.database.query(sql).get(...params) as T | null,
      all: <T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]) => this.database.query(sql).all(...params) as T[],
      exec: (sql) => this.database.exec(sql),
      transaction: <T>(work: () => T) => this.database.transaction(work)()
    }
    this.worktree = {
      id: 'wt-a', repoId: 'repo-a', path: join(root, 'workspace'), branch: kind === 'git' ? 'main' : null,
      head: '', isMain: false, name: 'workspace', kind, displayName: null, comment: '', status: 'todo', pinned: false,
      unread: false, parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false,
      removing: false, groupId: null, projectGroupId: null, lastActivityAt: 1, instanceId: 'instance-a'
    } as Worktree
    mkdirSync(this.worktree.path, { recursive: true })
    const home = join(root, 'home')
    const quirkyHome = join(root, 'quirky-home')
    const claudeHome = join(root, 'provider-home', 'claude')
    const codexHome = join(root, 'provider-home', 'codex')
    for (const directory of [home, quirkyHome, claudeHome, codexHome]) mkdirSync(directory, { recursive: true })
    const runtime = this
    this.context = {
      pluginId: 'quirky.loops', dir: root, dataDir: join(quirkyHome, 'plugin-data'), home,
      hostPower: new HostPowerService(() => {}, null).forPlugin('quirky.loops', () => false),
      workerEntrypoint: () => '', log: () => undefined, provide: () => undefined,
      emit(event, data) {
        runtime.events.push({ type: `quirky.loops/${event}`, data } as QuirkyEvent)
        runtime.wakeWaiters()
        return true
      },
      subscribe(listener) {
        runtime.subscribers.add(listener)
        return () => runtime.subscribers.delete(listener)
      },
      async call(method, params = {}) { return await runtime.call(method, params) },
      forward: async () => { throw new Error('The isolated Loop fixture has no authenticated client caller') },
      async createFileResource() { throw new Error('not used') },
      clients: { accept() { throw new Error('Loop engine tests must not admit remote clients') } },
      openStore(migrations) {
        for (let index = version; index < migrations.length; index++) {
          const migration = migrations[index]!
          if (typeof migration === 'string') runtime.database.exec(migration)
          else migration(runtime.pluginStore)
          version++
        }
        return runtime.pluginStore
      },
      getSetting: () => undefined, storedSettingValue: () => undefined,
      error(kind, message) { return Object.assign(new Error(message), { code: kind }) },
      process: {
        run: async (argv, options) => {
          if (argv[0] === 'git' && !argv.includes('--git-path')) {
            await nextTurn()
            throw new Error('Loop engine tests must not run evidence git')
          }
          runtime.processCalls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
          const handler = runtime.processHandler
          if (handler === null) throw new Error('Loop engine tests must not run subprocesses')
          return await handler(argv, options)
        },
        spawn: () => { throw new Error('Loop engine tests must not spawn subprocesses') },
      },
      pty: {} as PluginContext['pty'], notify: () => undefined, launch: {} as PluginContext['launch']
    } as PluginContext
  }

  close(): void {
    this.database.close()
  }
  storedJournalCursor(loopId: string): number {
    return this.pluginStore.get<{ journal_cursor: number }>(
      'SELECT journal_cursor FROM loops WHERE id = ?', loopId
    )?.journal_cursor ?? 0
  }
  holdNextSend(): { entered: Promise<void>; release: () => void; settled: Promise<void> } {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    this.sendBarrier = {
      entered: entered.resolve,
      wait: released.promise,
      release: released.resolve,
      settled: settled.resolve
    }
    this.activeSendRelease = released.resolve
    return { entered: entered.promise, release: released.resolve, settled: settled.promise }
  }
  holdJournalReadAfterFailure(): HeldJournalRead {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    this.journalReadGateAfterFailure = {
      entered: entered.resolve,
      wait: released.promise,
      release: released.resolve
    }
    return { entered: entered.promise, release: released.resolve }
  }
  releasePendingOperations(): void {
    const barrier = this.sendBarrier
    this.sendBarrier = null
    barrier?.entered()
    barrier?.release()
    this.activeSendRelease?.()
    this.activeSendRelease = null
    for (const gate of [this.journalReadGateAfterFailure, this.journalReadGate]) {
      gate?.entered()
      gate?.release()
    }
    this.journalReadGateAfterFailure = null
    this.journalReadGate = null
  }

  private wakeWaiters(): void {
    for (const wake of this.waiters) wake()
  }

  until<T>(read: () => T | null): Promise<T> {
    const current = read()
    if (current !== null) return Promise.resolve(current)
    const { promise, resolve } = Promise.withResolvers<T>()
    const wake = () => {
      const result = read()
      if (result === null) return
      this.waiters.delete(wake)
      resolve(result)
    }
    this.waiters.add(wake)
    wake()
    return promise
  }

  emit(type: string, data: unknown): void {
    const event = { type, data } as QuirkyEvent
    for (const listener of this.subscribers) void listener(event)
    this.wakeWaiters()
  }

  private append(sessionId: string, role: StructuredMessage['role'], text: string, data?: unknown): StructuredMessage {
    const rows = this.journals.get(sessionId) ?? []
    const message: StructuredMessage = {
      sessionId,
      seq: (rows.at(-1)?.seq ?? 0) + 1,
      role,
      text,
      at: Date.now(),
      ...(data === undefined ? {} : { data })
    }
    rows.push(message)
    this.journals.set(sessionId, rows)
    this.emit('quirky.structured/message', { message })
    return message
  }

  respond(sessionId: string, text: string, status: Session['status'] = 'done', totalCostUsd?: number): void {
    if (totalCostUsd !== undefined) this.append(sessionId, 'result', '', { total_cost_usd: totalCostUsd })
    this.append(sessionId, 'assistant', text)
    const session = this.sessions.get(sessionId)!
    this.sessions.set(sessionId, { ...session, status, lastActivityAt: Date.now() })
    this.emit('quirky.structured/settled', { sessionId, state: status, at: Date.now(), lastAssistantMessage: text })
  }
  externalUser(sessionId: string, text: string): void {
    this.append(sessionId, 'user', text)
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'quirky.worktree/show') return this.worktree
    if (method === 'quirky.structured/create') {
      const id = `session-${++this.sessionCount}`
      const session: Session = {
        id, kind: 'structured', agent: params.agent as string, worktreeId: this.worktree.id, cwd: this.worktree.path,
        title: 'Loop', status: 'running', createdAt: Date.now(), lastActivityAt: Date.now(), exitCode: null,
        exitSignal: null, exitCause: null, restorable: false, providerSession: { id: `provider-${id}`, transcriptPath: null }
      }
      this.sessions.set(id, session)
      this.journals.set(id, [])
      this.created.push(id)
      return session
    }
    if (method === 'quirky.structured/resume') {
      const oldId = String(params.session)
      const old = this.sessions.get(oldId)
      if (!old?.providerSession) throw new Error(`missing provider session for ${oldId}`)
      this.resumed.push(oldId)
      const id = `session-${++this.sessionCount}`
      const session: Session = { ...old, id, status: 'running', createdAt: Date.now(), lastActivityAt: Date.now(), resumedFrom: oldId }
      this.sessions.set(id, session)
      this.journals.set(id, [])
      return session
    }
    if (method === 'quirky.structured/send') {
      const sessionId = String(params.session)
      const expected = params.expectedAfterSeq as number
      const text = String(params.text)
      this.sendAttempts.push({ session: sessionId, text, expectedAfterSeq: expected })
      const barrier = this.sendBarrier
      if (barrier) {
        this.sendBarrier = null
        barrier.entered()
        await barrier.wait
        this.activeSendRelease = null
        barrier.settled()
      }
      const session = this.sessions.get(sessionId)
      const journal = this.journals.get(sessionId) ?? []
      const currentSeq = journal.at(-1)?.seq ?? 0
      const idle = session?.status === 'done' || session?.status === 'running'
      if (!session || !idle || params.requireIdle !== true || currentSeq !== expected) {
        throw Object.assign(new Error('send conflict'), { code: RpcErrorCode.Conflict })
      }
      this.sends.push({ session: sessionId, text, expectedAfterSeq: expected })
      this.append(sessionId, 'user', text)
      this.sessions.set(sessionId, { ...session, status: 'working', lastActivityAt: Date.now() })
      const turn = this.turns.shift() ?? 'settle'
      if (turn === 'settle') this.respond(sessionId, `completed ${this.sends.length}`, 'done', this.cumulativeCosts.shift())
      if (turn === 'exit') this.sessions.set(sessionId, { ...this.sessions.get(sessionId)!, status: 'exited', exitCode: 9 })
      return { ok: true }
    }
    if (method === 'quirky.structured/messages') {
      const sessionId = String(params.session)
      const afterSeq = Number(params.afterSeq ?? 0)
      let rows = (this.journals.get(sessionId) ?? []).filter((item) => item.seq > afterSeq)
      if (params.tail === true && typeof params.limit === 'number') rows = rows.slice(-params.limit)
      else if (typeof params.limit === 'number') rows = rows.slice(0, params.limit)
      if (this.failedJournalCursors.length > 0) {
        this.journalCursorsAfterFailure.push(afterSeq)
        this.wakeWaiters()
        const gate = this.journalReadGate
        this.journalReadGate = null
        if (gate) {
          gate.entered()
          await gate.wait
        }
      }
      if (this.sends.length > 0 && this.failedJournalResponsesAfterSend.length > 0) {
        this.failedJournalCursors.push(afterSeq)
        const response = this.failedJournalResponsesAfterSend.shift()
        this.journalReadGate = this.journalReadGateAfterFailure
        this.journalReadGateAfterFailure = null
        this.wakeWaiters()
        return response
      }
      return rows
    }
    if (method === 'quirky.checks/run') {
      return {
        checkId: String(params.checkId),
        ran: true,
        pass: true,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdoutTail: '',
        stderrTail: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0
      }
    }
    if (method === 'quirky.checks/cancel') return { cancelled: false }
    if (method === 'quirky.session/get') {
      const session = this.sessions.get(String(params.session))
      if (!session) throw Object.assign(new Error('unknown session'), { code: 'not-found' })
      return session
    }
    if (method === 'quirky.structured/stop') {
      const sessionId = String(params.session)
      this.stopped.push(sessionId)
      const session = this.sessions.get(sessionId)
      if (session) this.sessions.set(sessionId, { ...session, status: 'exited', exitCode: null })
      this.wakeWaiters()
      return { ok: true }
    }
    if (method === 'quirky.session/close') {
      const sessionId = String(params.session)
      this.closed.push(sessionId)
      this.sessions.delete(sessionId)
      this.journals.delete(sessionId)
      this.emit('quirky.session/removed', { sessionId })
      return { ok: true }
    }
    if (method === 'quirky.ask/list') return this.pendingAsks
    throw new Error(`unhandled public API method ${method}`)
  }
}

function rig(kind: 'folder' | 'git' = 'folder'): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'quirky-loop-engine-'))
  roots.push(root)
  const runtime = new Runtime(root, kind)
  runtimes.push(runtime)
  return runtime
}

function input(config: LoopCreateInput['config'] = {
  promptSource: { kind: 'repeat', body: 'finish the implementation' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: { maxIterations: 1 },
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}): LoopCreateInput {
  return { worktree: 'id:wt-a', agent: 'claude', config }
}

class ManualClock {
  current = 1000
  now = (): number => this.current
  advance(ms: number): void {
    this.current += ms
  }
}

type SupervisionCall = { method: string; args: unknown[] }

function wrapSupervisionMethod(
  engine: SupervisionEngine,
  method: Extract<keyof SupervisionEngine, string>,
  calls: SupervisionCall[],
  observeSample?: (sample: StructuredSample, decision: supervision.WatchDecision<unknown>) => void,
  beforeWatch?: (input: StructuredWatch<unknown>) => void
): void {
  const target = engine as unknown as Record<string, (...args: unknown[]) => unknown>
  const original = target[method]!.bind(engine)
  spyOn(target, method).mockImplementation((...args) => {
    calls.push({ method, args })
    if (method !== 'watchStructured') return original(...args)
    const input = args[0] as StructuredWatch<unknown>
    beforeWatch?.(input)
    if (!observeSample) return original(input)
    return original({
      ...input,
      onSample: async (sample: StructuredSample, signal: AbortSignal) => {
        const decision = await input.onSample(sample, signal)
        observeSample(sample, decision)
        return decision
      }
    })
  })
}

function spyOnSupervisionEngine(
  observeSample?: (sample: StructuredSample, decision: supervision.WatchDecision<unknown>) => void,
  beforeWatch?: (input: StructuredWatch<unknown>) => void
) {
  const calls: SupervisionCall[] = []
  const create = supervision.createSupervision
  const factory = spyOn(supervision, 'createSupervision')
  factory.mockImplementation((context, options) => {
    const engine = create(context, options)
    for (const method of [
      'create', 'resume', 'send', 'readMessages', 'watchStructured', 'wake',
      'runCheck', 'cancelCheck', 'stop', 'stopOwned', 'dispose'
    ] as const) {
      wrapSupervisionMethod(engine, method, calls, observeSample, beforeWatch)
    }
    return engine
  })
  syncProcessMocks.push(factory)
  return { calls, factory }
}

function service(runtime: Runtime, now: () => number = Date.now): LoopService {
  const loops = new LoopService(runtime.context, { pollMs: 2, userIdleMs: 0, noBusyEdgeMs: 25, now })
  activeServices.push(loops)
  return loops
}


async function assertApprovalHoldAccounting(emitSessionEvent: boolean, sampleBeforeApproval: boolean): Promise<void> {
  const runtime = rig()
  const clock = new ManualClock()
  runtime.turns.push('hold')
  const workingSample = Promise.withResolvers<void>()
  const heldSample = Promise.withResolvers<void>()
  let heldSampleStatus: Session['status'] | null = null
  spyOnSupervisionEngine((sample) => {
    if (!sample.session.ok) return
    const status = sample.session.value.status
    if (status === 'working') workingSample.resolve()
    if (heldSampleStatus === status) {
      heldSampleStatus = null
      heldSample.resolve()
    }
  })
  const loops = service(runtime, clock.now)
  await loops.start()
  const created = await loops.create(input({
    ...input().config,
    caps: { maxActiveMinutes: 1 },
    askBeforeNext: true
  }))
  await runtime.until(() => runtime.sends.length === 1 ? true : null)
  await workingSample.promise

  const sessionId = runtime.sends[0]!.session
  const ask = { id: 'ask-clock', sessionId, envelope: { status: 'pending' as const } }
  const journal = Promise.withResolvers<unknown>()

  if (sampleBeforeApproval) {
    runtime.failedJournalResponsesAfterSend.push(journal.promise)
    runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
    await runtime.until(() => runtime.failedJournalCursors.length === 1 ? true : null)
    await flushFakeRpcs()
  }

  clock.advance(1000)
  runtime.sessions.set(sessionId, { ...runtime.sessions.get(sessionId)!, status: 'waiting' })
  runtime.pendingAsks = [ask]
  if (!sampleBeforeApproval) runtime.failedJournalResponsesAfterSend.push(journal.promise)
  heldSampleStatus = sampleBeforeApproval ? 'working' : 'waiting'
  if (emitSessionEvent || sampleBeforeApproval) {
    runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
  }
  await runtime.until(() => runtime.failedJournalCursors.length === 1 ? true : null)
  await flushFakeRpcs()

  const held = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'needs-you')
  expect(held.activeMs).toBe(1000)
  clock.advance(5000)
  journal.resolve([])
  await heldSample.promise

  runtime.pendingAsks = []
  runtime.emit('quirky.ask/resolved', { askId: ask.id })
  runtime.respond(sessionId, 'finished after approval')
  const paused = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')
  expect(paused.pauseReason).toBe('ask-before-next')
  expect(paused.activeMs).toBe(1000)
}


function loopUntil(runtime: Runtime, loops: LoopService, id: string, match: (snapshot: ReturnType<LoopService['get']>) => boolean) {
  return runtime.until(() => {
    const snapshot = loops.get(id)
    return match(snapshot) ? snapshot : null
  })
}
function flushFakeRpcs(): Promise<void> {
  const flushed = Promise.withResolvers<void>()
  setImmediate(flushed.resolve)
  return flushed.promise
}
async function assertJournalFailureRetainsLoopCursor(response: unknown): Promise<void> {
  const runtime = rig()
  runtime.turns.push('hold')
  const failedWatchSample = Promise.withResolvers<{
    sample: StructuredSample
    decision: supervision.WatchDecision<unknown>
  }>()
  let busyBeforeSettledEdge = false
  let settledBeforeWatch = false
  let postSendReadBeforeWatch = false
  let failureArmed = false
  const recovery: { gate?: HeldJournalRead; cursor?: number } = {}
  const engine = spyOnSupervisionEngine(
    (sample: StructuredSample, decision: supervision.WatchDecision<unknown>) => {
      if (sample.session.ok && sample.session.value.status === 'done') {
        failedWatchSample.resolve({ sample, decision })
      }
    },
    () => {
      if (failureArmed) return
      const sessionId = runtime.sends[0]?.session
      if (sessionId === undefined) return
      failureArmed = true
      const sendIndex = runtime.calls.findIndex(({ method }) => method === 'quirky.structured/send')
      postSendReadBeforeWatch = sendIndex >= 0 && runtime.calls.some(
        (call, index) => index > sendIndex && call.method === 'quirky.structured/messages'
      )
      busyBeforeSettledEdge = runtime.sessions.get(sessionId)?.status === 'working'
      recovery.cursor = runtime.storedJournalCursor(created.id)
      runtime.failedJournalResponsesAfterSend.push(response)
      recovery.gate = runtime.holdJournalReadAfterFailure()
      runtime.respond(sessionId, 'settled after journal recovery')
      settledBeforeWatch = true
    }
  )
  const loops = service(runtime)
  await loops.start()
  const created = await loops.create(input())

  try {
    const { sample: failedSample, decision: failedDecision } = await failedWatchSample.promise
    const heldRead = recovery.gate
    const storedCursorBeforeFailure = recovery.cursor
    if (heldRead === undefined || storedCursorBeforeFailure === undefined) {
      throw new Error('the watch did not capture the recovery journal baseline')
    }

    expect(engine.calls.some(({ method }) => method === 'watchStructured')).toBe(true)
    expect(postSendReadBeforeWatch).toBe(true)
    expect(busyBeforeSettledEdge).toBe(true)
    expect(settledBeforeWatch).toBe(true)
    expect(failedSample.afterSeq).toBe(0)
    expect(failedSample.session).toMatchObject({ ok: true, value: { status: 'done' } })
    expect(failedSample.journal).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
    expect(failedDecision).toMatchObject({ kind: 'continue' })

    await runtime.until(() => runtime.failedJournalCursors.length === 1 ? true : null)
    await runtime.until(() => runtime.journalCursorsAfterFailure.length > 0 ? true : null)
    await heldRead.entered

    expect(runtime.failedJournalCursors).toEqual([0])
    expect(runtime.journalCursorsAfterFailure[0]).toBe(0)
    expect(runtime.journalCursorsAfterFailure[0]).toBe(runtime.failedJournalCursors[0])
    expect(storedCursorBeforeFailure).toBe(1)
    expect(runtime.storedJournalCursor(created.id)).toBe(storedCursorBeforeFailure)
    expect(loops.get(created.id)).toMatchObject({ state: 'running', iterationsCompleted: 0 })
    expect(loops.get(created.id).iterationsCompleted).toBe(0)
    expect(loops.iterations(created.id).some((attempt) => attempt.endReason === 'settled')).toBe(false)

    heldRead.release()
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')
    expect(loops.iterations(created.id)).toMatchObject([{ endReason: 'settled' }])
  } finally {
    recovery.gate?.release()
  }
}


describe('LoopService background engine', () => {
  test('rejects unsupported agents, presets, blank prompts and invalid numeric config before provider launch', async () => {
    const runtime = rig()
    const loops = service(runtime)
    await loops.start()
    await expect(loops.create({ ...input(), agent: 'shell' as 'claude' })).rejects.toThrow(/agent/i)
    await expect(loops.create(input({ ...input().config, promptSource: { kind: 'repeat', body: '  ' } }))).rejects.toThrow(/prompt/i)
    await expect(loops.create(input({ ...input().config, caps: { maxIterations: 1.5 } }))).rejects.toThrow(/maxIterations/i)
    await expect(loops.create(input({
      ...input().config,
      done: { check: { command: 'true', timeoutSeconds: 601, runWhen: 'every-iteration' } }
    }))).rejects.toThrow(/timeoutSeconds/i)
    await expect(loops.create(input({ ...input().config, caps: { maxCostUsd: 0 } }))).rejects.toThrow(/maxCostUsd/i)
    expect(runtime.created).toEqual([])
    expect(await loops.list()).toEqual([])
  })


  test('applies documented config defaults and accepts finite fractional cost caps', () => {
    const config = normalizeLoopConfig({
      promptSource: { kind: 'repeat', body: 'finish it' },
      pacing: { kind: 'on-idle' },
      done: { check: { command: 'test -f result.txt' } },
      caps: { maxCostUsd: 0.5 },
      protectedPaths: ['secret/**']
    })
    expect(config).toMatchObject({
      sessionPolicy: 'fresh',
      done: { check: { timeoutSeconds: 300, runWhen: 'every-iteration' } },
      caps: { maxCostUsd: 0.5 },
      noProgress: false,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false,
      protectedPaths: ['secret/**']
    })
    expect(config.caps.maxIterations).toBeUndefined()
  })

  test('allows concurrent loops in one worktree and warns on the second without preventing it', async () => {
    const runtime = rig()
    runtime.turns.push('hold', 'hold')
    const loops = service(runtime)
    await loops.start()
    const first = await loops.create(input({ ...input().config, caps: {} }))
    await runtime.until(() => runtime.sends.length === 1 ? true : null)
    const second = await loops.create(input({ ...input().config, caps: {} }))
    expect(second.warnings).toContain('worktree-has-running-loop')
    await runtime.until(() => runtime.sends.length === 2 ? true : null)
    expect(await loops.list({ worktreeId: 'wt-a' })).toHaveLength(2)
    await loops.stop(first.id, true)
    await loops.stop(second.id, true)
  })

  test('creates folder notes once, records a settled turn and pauses at the iteration cap', async () => {
    const runtime = rig('folder')
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input())
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')

    const notes = readFileSync(created.notesPath, 'utf8')
    expect(notes).toContain('Edit freely')
    writeFileSync(created.notesPath, 'user-edited note')
    const ended = loops.get(created.id)
    expect(ended).toMatchObject({ state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 1 })
    expect(loops.iterations(created.id)).toMatchObject([{ n: 1, attempt: 1, endReason: 'settled' }])
    expect(readFileSync(created.notesPath, 'utf8')).toBe('user-edited note')
    expect(runtime.sends[0]?.text).toContain('This is iteration 1 of 1.')
    expect(runtime.events.filter((event) => event.type === 'quirky.loops/notification')).toHaveLength(1)
  })

  test('routes loop effects, turn watching, checks and shutdown through one shared engine', async () => {
    const engine = spyOnSupervisionEngine()
    const runtime = rig()
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({
      ...input().config,
      done: { check: { command: 'test -f result.txt', timeoutSeconds: 30, runWhen: 'every-iteration' } }
    }))
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'completed')
    await loops.shutdown()

    expect(engine.factory).toHaveBeenCalledTimes(1)
    for (const method of ['create', 'readMessages', 'send', 'watchStructured', 'runCheck', 'stop', 'dispose']) {
      expect(engine.calls.some((call) => call.method === method), method).toBe(true)
    }
    expect(runtime.calls.find(({ method }) => method === 'quirky.checks/run')?.params).toEqual({
      checkId: `${created.id}:1:1`,
      command: 'test -f result.txt',
      cwd: runtime.worktree.path,
      timeoutSeconds: 30
    })
  })

  test('keeps specified agent and check RPCs behind the supervision engine', () => {
    const directRpc = /quirky\.(?:structured\/(?:create|resume|send|messages|stop(?:Owned)?)|checks\/(?:run|cancel))/
    for (const file of ['driver.ts', 'service.ts', 'evidence.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(directRpc)
    }
  })

  test('holds the loop journal cursor after an unverifiable journal read', async () => {
    await assertJournalFailureRetainsLoopCursor(null)
  })

  test('holds the loop journal cursor after a foreign-session journal row', async () => {
    const foreignRow: StructuredMessage = {
      sessionId: 'foreign-session',
      seq: 2,
      role: 'assistant',
      text: 'settled after journal recovery',
      at: Date.now()
    }
    await assertJournalFailureRetainsLoopCursor([foreignRow])
  })

  test('waits for private exclusion before persisting, publishing or starting a git loop', async () => {
    forbidSynchronousExecFileSync()
    const runtime = rig('git')
    runtime.turns.push('hold')
    const loops = service(runtime)
    await loops.start()
    const pending = Promise.withResolvers<RunResult>()
    runtime.processHandler = async () => pending.promise
    let settled = false
    const creation = loops.create(input())
    void creation.then(() => {
      settled = true
    }, () => {
      settled = true
    })

    await nextTurn()
    expect(runtime.processCalls).toEqual([{
      argv: ['git', '-C', runtime.worktree.path, 'rev-parse', '--git-path', 'info/exclude'],
      options: { rerunnable: true, maxOutputBytes: 1048576 }
    }])
    expect(settled).toBe(false)
    expect(await loops.list()).toEqual([])
    expect(runtime.events.filter((event) => event.type === 'quirky.loops/changed')).toEqual([])
    expect(runtime.created).toEqual([])

    pending.resolve(runResult('.git/info/exclude\n'))
    const created = await creation
    expect(readFileSync(join(runtime.worktree.path, '.git', 'info', 'exclude'), 'utf8')).toBe('/.quirky/loops/\n')
    expect(existsSync(created.notesPath)).toBe(true)
  })

  test('resolves relative exclusions, adds a newline and avoids duplicate entries', async () => {
    forbidSynchronousExecFileSync()
    const runtime = rig('git')
    runtime.turns.push('hold', 'hold')
    const excludePath = join(runtime.worktree.path, '.git', 'info', 'exclude')
    mkdirSync(join(runtime.worktree.path, '.git', 'info'), { recursive: true })
    writeFileSync(excludePath, 'existing rule')
    runtime.processHandler = async () => runResult('.git/info/exclude\n')
    const loops = service(runtime)
    await loops.start()

    const first = await loops.create(input())
    const second = await loops.create(input())

    expect(readFileSync(excludePath, 'utf8')).toBe('existing rule\n/.quirky/loops/\n')
    expect(readFileSync(excludePath, 'utf8').split('/.quirky/loops/')).toHaveLength(2)
    for (const created of [first, second]) {
      expect(readFileSync(created.notesPath, 'utf8')).toContain('Edit freely')
      expect(existsSync(join(created.notesPath, '..', 'log.md'))).toBe(true)
    }
    expect(existsSync(join(runtime.worktree.path, '.gitignore'))).toBe(false)
    expect(runtime.processCalls).toHaveLength(2)
    expect(runtime.processCalls.every(({ argv, options }) =>
      argv[0] === 'git' && argv[1] === '-C' && argv[2] === runtime.worktree.path &&
      options?.rerunnable === true && options.maxOutputBytes === 1048576
    )).toBe(true)
  })

  test('uses an absolute private exclusion path as returned', async () => {
    forbidSynchronousExecFileSync()
    const runtime = rig('git')
    runtime.turns.push('hold')
    const excludePath = join(runtime.worktree.path, 'git-metadata', 'info', 'exclude')
    runtime.processHandler = async () => runResult(`${excludePath}\n`)
    const loops = service(runtime)
    await loops.start()

    await loops.create(input())

    expect(readFileSync(excludePath, 'utf8')).toBe('/.quirky/loops/\n')
    expect(existsSync(join(runtime.worktree.path, '.git', 'info', 'exclude'))).toBe(false)
    expect(runtime.processCalls).toEqual([{
      argv: ['git', '-C', runtime.worktree.path, 'rev-parse', '--git-path', 'info/exclude'],
      options: { rerunnable: true, maxOutputBytes: 1048576 }
    }])
  })

  test('rejects incomplete exclusion reads before persisting or starting a loop', async () => {
    forbidSynchronousExecFileSync()
    const failures: {
      name: string
      result?: RunResult
      rejection?: Error
      message: string
    }[] = [
      { name: 'nonzero exit', result: runResult('.git/info/exclude\n', { exitCode: 1 }), message: 'git rev-parse failed' },
      { name: 'signal', result: runResult('.git/info/exclude\n', { exitCode: null, signal: 'SIGTERM' }), message: 'git rev-parse failed' },
      { name: 'signal reported with exit code', result: runResult('.git/info/exclude\n', { signal: 'SIGTERM' }), message: 'git rev-parse failed' },
      {
        name: 'spawn failure',
        result: runResult('.git/info/exclude\n', { exitCode: null, spawnError: { code: 'ENOENT', message: 'not found' } }),
        message: 'git rev-parse failed'
      },
      {
        name: 'spawn failure reported with exit code',
        result: runResult('.git/info/exclude\n', { spawnError: { code: 'ENOENT', message: 'not found' } }),
        message: 'git rev-parse failed'
      },
      { name: 'timeout', result: runResult('.git/info/exclude\n', { exitCode: null, stopped: 'timeout' }), message: 'git rev-parse failed' },
      { name: 'abort', result: runResult('.git/info/exclude\n', { exitCode: null, stopped: 'aborted' }), message: 'git rev-parse failed' },
      { name: 'overflow', result: runResult('.git/info/exclude\n', { exitCode: null, stopped: 'overflow' }), message: 'git rev-parse failed' },
      { name: 'timeout reported with exit code', result: runResult('.git/info/exclude\n', { stopped: 'timeout' }), message: 'git rev-parse failed' },
      { name: 'abort reported with exit code', result: runResult('.git/info/exclude\n', { stopped: 'aborted' }), message: 'git rev-parse failed' },
      { name: 'overflow reported with exit code', result: runResult('.git/info/exclude\n', { stopped: 'overflow' }), message: 'git rev-parse failed' },
      { name: 'runner rejection', rejection: new Error('private runner diagnostic'), message: 'git rev-parse failed' },
      { name: 'empty path', result: runResult(' \n\t'), message: 'git did not return a private info/exclude path' }
    ]

    for (const failure of failures) {
      const runtime = rig('git')
      const excludePath = join(runtime.worktree.path, '.git', 'info', 'exclude')
      mkdirSync(join(runtime.worktree.path, '.git', 'info'), { recursive: true })
      writeFileSync(excludePath, 'original contents\n')
      runtime.processHandler = async () => {
        if (failure.rejection) throw failure.rejection
        return failure.result!
      }
      const loops = service(runtime)
      await loops.start()

      const error = await loops.create(input()).then(() => null, (caught: unknown) => caught)
      expect(error, failure.name).toMatchObject({
        code: 'conflict',
        message: `could not prepare loop notes and private git exclusion: ${failure.message}`
      })
      expect(runtime.processCalls, failure.name).toHaveLength(1)
      expect(runtime.processCalls[0], failure.name).toEqual({
        argv: ['git', '-C', runtime.worktree.path, 'rev-parse', '--git-path', 'info/exclude'],
        options: { rerunnable: true, maxOutputBytes: 1048576 }
      })
      expect(await loops.list(), failure.name).toEqual([])
      expect(runtime.created, failure.name).toEqual([])
      expect(runtime.events.filter((event) => event.type === 'quirky.loops/changed'), failure.name).toEqual([])
      expect(readFileSync(excludePath, 'utf8'), failure.name).toBe('original contents\n')
    }
  })

  test('installs private git exclusion before running and never writes .gitignore', async () => {
    forbidSynchronousExecFileSync()
    const runtime = rig('git')
    runtime.turns.push('hold')
    const env = {
      ...process.env,
      HOME: join(runtime.root, 'home'),
      QUIRKY_HOME: join(runtime.root, 'quirky-home'),
      CLAUDE_CONFIG_DIR: join(runtime.root, 'provider-home', 'claude'),
      CODEX_HOME: join(runtime.root, 'provider-home', 'codex'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
    const processRunner = createProcessRunner({ owner: 'loop-engine-git-test' })
    processRunners.push(processRunner)
    const initialized = await processRunner.run(['git', 'init', '-q', runtime.worktree.path], { env })
    expect(initialized.exitCode).toBe(0)
    runtime.processHandler = (argv, options) => processRunner.run(argv, options)
    const loops = service(runtime)
    await loops.start()
    await loops.create(input())
    const excluded = await processRunner.run(
      ['git', '-C', runtime.worktree.path, 'rev-parse', '--git-path', 'info/exclude'],
      { env }
    )
    expect(excluded.exitCode).toBe(0)
    const exclude = excluded.stdoutText.trim()
    const excludePath = exclude.startsWith('/') ? exclude : join(runtime.worktree.path, exclude)
    expect(readFileSync(excludePath, 'utf8')).toContain('/.quirky/loops/')
    expect(existsSync(join(runtime.worktree.path, '.gitignore'))).toBe(false)
  })


  test('delivers queued steer and edited prompt on the next resumed send', async () => {
    const runtime = rig()
    const loops = service(runtime)
    await loops.start()
    const config = { ...input().config, caps: { maxIterations: 2 }, askBeforeNext: true }
    const created = await loops.create(input(config))
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.pauseReason === 'ask-before-next')
    await loops.edit(created.id, { promptSource: { kind: 'repeat', body: 'Use the revised task.' } })
    await loops.steer(created.id, 'use banana')
    await loops.resume(created.id, 1)
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'ask-before-next')
    expect(loops.get(created.id).config.caps.maxIterations).toBe(3)

    expect(runtime.sends).toHaveLength(2)
    expect(new Set(runtime.sends.map((send) => send.session)).size).toBe(2)
    await runtime.until(() => runtime.created.every((id) => runtime.closed.includes(id)) ? true : null)
    expect(runtime.closed).toEqual(expect.arrayContaining(runtime.created))
    expect(runtime.sends[1]?.text).toContain('Use the revised task.')
    expect(runtime.sends[1]?.text.split('use banana')).toHaveLength(2)
    expect(loops.iterations(created.id).map(({ n, attempt }) => [n, attempt])).toEqual([[1, 1], [2, 1]])
  })

  test('reuses one structured session for continue iterations and omits repeated preambles', async () => {
    const runtime = rig()
    runtime.turns.push('settle', 'settle')
    const loops = service(runtime)
    await loops.start()
    const config = { ...input().config, sessionPolicy: 'continue' as const, caps: { maxIterations: 2 } }
    const created = await loops.create(input(config))
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'cap-iterations')

    expect(runtime.created).toHaveLength(1)
    expect(runtime.sends.map((send) => send.session)).toEqual([runtime.created[0], runtime.created[0]])
    expect(runtime.sends[0]?.text).toContain('automated background loop')
    expect(runtime.sends[1]?.text).not.toContain('automated background loop')
    expect(loops.iterations(created.id).map(({ n, attempt }) => [n, attempt])).toEqual([[1, 1], [2, 1]])
  })

  test('retries one crashed iteration with attempt numbering and never counts failed turns', async () => {
    const runtime = rig()
    runtime.turns.push('exit', 'exit')
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({ ...input().config, caps: {} }))
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.pauseReason === 'crashed')
    expect(loops.iterations(created.id).map(({ n, attempt, endReason }) => [n, attempt, endReason])).toEqual([
      [1, 1, 'crashed'], [1, 2, 'crashed']
    ])
    expect(loops.get(created.id).iterationsCompleted).toBe(0)
    expect(runtime.created).toHaveLength(2)
  })

  test('re-reads the journal after a guarded-send conflict and leaves steer queued until acceptance', async () => {
    const runtime = rig()
    const gate = runtime.holdNextSend()
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input())
    await gate.entered
    const sessionId = runtime.sendAttempts[0]!.session
    await loops.steer(created.id, 'use banana')
    runtime.externalUser(sessionId, 'human input before guarded delivery')
    gate.release()
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'cap-iterations')

    expect(runtime.sendAttempts).toHaveLength(2)
    expect(runtime.sendAttempts[0]?.expectedAfterSeq).toBe(0)
    expect(runtime.sendAttempts[1]?.expectedAfterSeq).toBe(1)
    expect(runtime.sendAttempts[0]?.text).not.toContain('use banana')
    expect(runtime.sends).toHaveLength(1)
    expect(runtime.sends[0]?.text).toContain('use banana')
    expect(loops.iterations(created.id)).toMatchObject([{ n: 1, attempt: 1, endReason: 'settled' }])
  })

  test('stop now racing an unaccepted send records no prompt and stops the owned process', async () => {
    const runtime = rig()
    const gate = runtime.holdNextSend()
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({ ...input().config, caps: {} }))
    await gate.entered
    const stopping = loops.stop(created.id, true)
    await runtime.until(() => runtime.stopped.length === 1 ? true : null)
    gate.release()
    const stopped = await stopping

    expect(stopped.state).toBe('stopped')
    expect(runtime.sends).toHaveLength(0)
    expect(loops.iterations(created.id)).toMatchObject([{ endReason: 'stopped', promptSent: '' }])
    expect(loops.get(created.id).iterationsCompleted).toBe(0)
  })

  test('stop now cancels a working turn and records it without incrementing completed iterations', async () => {
    const runtime = rig()
    runtime.turns.push('hold')
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({ ...input().config, caps: {} }))
    await runtime.until(() => runtime.sends.length === 1 ? true : null)
    const stopped = await loops.stop(created.id, true)
    expect(stopped.state).toBe('stopped')
    expect(runtime.stopped).toContain(runtime.created[0])
    expect(loops.get(created.id).iterationsCompleted).toBe(0)
    expect(loops.iterations(created.id)).toMatchObject([{ endReason: 'stopped' }])
  })

  test('pause and after-iteration stop allow the current turn to settle before transitioning', async () => {
    const pauseRuntime = rig()
    pauseRuntime.turns.push('hold')
    const pauseLoops = service(pauseRuntime)
    await pauseLoops.start()
    const pauseLoop = await pauseLoops.create(input({ ...input().config, caps: {} }))
    await pauseRuntime.until(() => pauseRuntime.sends.length === 1 ? true : null)
    const pauseSession = pauseRuntime.sends[0]!.session
    expect((await pauseLoops.pause(pauseLoop.id)).state).toBe('running')
    pauseRuntime.respond(pauseSession, 'settled before pause')
    const paused = await loopUntil(pauseRuntime, pauseLoops, pauseLoop.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('user')
    expect(paused.iterationsCompleted).toBe(1)
    expect(pauseLoops.iterations(pauseLoop.id)).toMatchObject([{ endReason: 'settled' }])
    expect(pauseRuntime.events.filter((event) => event.type === 'quirky.loops/notification')).toHaveLength(0)

    const stopRuntime = rig()
    stopRuntime.turns.push('hold')
    const stopLoops = service(stopRuntime)
    await stopLoops.start()
    const stopLoop = await stopLoops.create(input({ ...input().config, caps: {} }))
    await stopRuntime.until(() => stopRuntime.sends.length === 1 ? true : null)
    const stopSession = stopRuntime.sends[0]!.session
    expect((await stopLoops.stop(stopLoop.id)).state).toBe('running')
    stopRuntime.respond(stopSession, 'settled before stop')
    const stopped = await loopUntil(stopRuntime, stopLoops, stopLoop.id, (snapshot) => snapshot.state === 'stopped')
    expect(stopped.iterationsCompleted).toBe(1)
    expect(stopLoops.iterations(stopLoop.id)).toMatchObject([{ endReason: 'settled' }])
  })

  test('restart pauses an unfinished attempt and native-resumes continue at the same iteration', async () => {
    const engine = spyOnSupervisionEngine()
    const runtime = rig()
    runtime.turns.push('hold', 'settle')
    const first = service(runtime)
    await first.start()
    const created = await first.create(input({ ...input().config, sessionPolicy: 'continue', caps: { maxIterations: 1 } }))
    await runtime.until(() => runtime.sends.length === 1 ? true : null)
    await first.shutdown()
    activeServices.splice(activeServices.indexOf(first), 1)

    const restarted = service(runtime)
    await restarted.start()
    expect(restarted.get(created.id)).toMatchObject({ state: 'paused', pauseReason: 'interrupted-by-restart' })
    expect(restarted.iterations(created.id)).toMatchObject([{ n: 1, attempt: 1, endReason: 'interrupted' }])
    await restarted.resume(created.id)
    await loopUntil(runtime, restarted, created.id, (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'cap-iterations')
    expect(runtime.resumed).toEqual([runtime.created[0]])
    expect(engine.factory).toHaveBeenCalledTimes(2)
    expect(engine.calls.some(({ method }) => method === 'resume')).toBe(true)
    expect(runtime.created).toHaveLength(1)
    expect(restarted.iterations(created.id).map(({ n, attempt }) => [n, attempt])).toEqual([[1, 1], [1, 2]])
  })
  test('shutdown returns before a held send and restart interrupts without replay', async () => {
    const runtime = rig()
    const send = runtime.holdNextSend()
    const first = service(runtime)
    await first.start()
    const created = await first.create(input({ ...input().config, sessionPolicy: 'continue', caps: {} }))
    await send.entered

    let shutdownReturned = false
    const shuttingDown = first.shutdown().then(() => {
      shutdownReturned = true
    })
    try {
      await runtime.until(() => runtime.stopped.length > 0 ? true : null)
      await flushFakeRpcs()
      expect(shutdownReturned).toBe(true)

      activeServices.splice(activeServices.indexOf(first), 1)
      const restarted = service(runtime)
      await restarted.start()
      expect(restarted.get(created.id)).toMatchObject({ state: 'paused', pauseReason: 'interrupted-by-restart' })
      expect(restarted.iterations(created.id)).toMatchObject([{ n: 1, attempt: 1, endReason: 'interrupted' }])
      expect(runtime.sendAttempts).toHaveLength(1)
      expect(runtime.sends).toHaveLength(0)
      expect(runtime.created).toHaveLength(1)

      send.release()
      await send.settled
      await flushFakeRpcs()
      expect(runtime.sendAttempts).toHaveLength(1)
      expect(runtime.sends).toHaveLength(0)
    } finally {
      send.release()
      await send.settled
      await shuttingDown
    }
  })

  test('excludes approval holds from active time when a session event wakes the watcher', async () => {
    await assertApprovalHoldAccounting(true, false)
  })

  test('excludes approval holds from active time when fallback polling wakes the watcher', async () => {
    await assertApprovalHoldAccounting(false, false)
  })

  test('charges working time before an approval event interrupts a held working sample', async () => {
    await assertApprovalHoldAccounting(true, true)
  })

  test('approval time cannot satisfy the no-busy settlement timeout after a stale sample', async () => {
    const runtime = rig()
    const clock = new ManualClock()
    runtime.turns.push('hold')
    const call = runtime.context.call.bind(runtime.context)
    const send = spyOn(runtime.context, 'call').mockImplementation(async (method, params) => {
      const value = await call(method, params)
      if (method === 'quirky.structured/send') {
        const sessionId = String(params?.session)
        runtime.sessions.set(sessionId, { ...runtime.sessions.get(sessionId)!, status: 'running' })
      }
      return value
    })
    let idleSample = Promise.withResolvers<'continue' | 'done'>()
    spyOnSupervisionEngine((sample, decision) => {
      if (sample.session.ok && sample.session.value.status === 'running') idleSample.resolve(decision.kind)
    })
    const loops = service(runtime, clock.now)
    const journal = Promise.withResolvers<unknown>()
    try {
      await loops.start()
      const created = await loops.create(input())
      expect(await idleSample.promise).toBe('continue')
      const sessionId = runtime.sends[0]!.session
      runtime.failedJournalResponsesAfterSend.push(journal.promise)
      runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
      await runtime.until(() => runtime.failedJournalCursors.length === 1 ? true : null)
      await flushFakeRpcs()
      runtime.pendingAsks = [{ id: 'ask-idle-clock', sessionId, envelope: { status: 'pending' } }]
      runtime.sessions.set(sessionId, { ...runtime.sessions.get(sessionId)!, status: 'waiting' })
      runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
      await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'needs-you')

      clock.advance(5000)
      runtime.pendingAsks = []
      runtime.sessions.set(sessionId, { ...runtime.sessions.get(sessionId)!, status: 'running' })
      runtime.emit('quirky.ask/resolved', { askId: 'ask-idle-clock' })
      idleSample = Promise.withResolvers<'continue' | 'done'>()
      journal.resolve([])
      expect(await idleSample.promise).toBe('continue')
      idleSample = Promise.withResolvers<'continue' | 'done'>()
      expect(await idleSample.promise).toBe('continue')
      expect(loops.get(created.id).iterationsCompleted).toBe(0)
      expect(loops.get(created.id).state).toBe('running')

      clock.advance(25)
      runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
      const paused = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')
      expect(paused.iterationsCompleted).toBe(1)
      expect(loops.iterations(created.id)).toMatchObject([{ endReason: 'settled' }])
    } finally {
      journal.resolve([])
      send.mockRestore()
    }
  })

  test('pauses a configured cost cap when provider usage is unavailable instead of treating it as zero', async () => {
    const runtime = rig()
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({ ...input().config, caps: { maxCostUsd: 0.5 } }))
    const paused = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused).toMatchObject({ pauseReason: 'cap-cost', pauseDetail: 'usage-unavailable', costUsd: null })
    expect(loops.iterations(created.id)[0]?.costUsd).toBeNull()
  })

  test('accumulates measured cumulative provider USD toward a cost cap without pricing tokens', async () => {
    const runtime = rig()
    runtime.cumulativeCosts.push(0.2, 0.4)
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({
      ...input().config,
      sessionPolicy: 'continue',
      caps: { maxCostUsd: 0.3 }
    }))
    const paused = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')

    expect(paused).toMatchObject({ pauseReason: 'cap-cost', costUsd: 0.4 })
    expect(runtime.created).toHaveLength(1)
    expect(loops.iterations(created.id).map((iteration) => iteration.costUsd)).toEqual([0.2, 0.2])
  })

  test('holds for pending approval and settles only after the current turn resolves', async () => {
    const runtime = rig()
    runtime.turns.push('hold')
    const loops = service(runtime)
    await loops.start()
    const created = await loops.create(input({ ...input().config, caps: {} }))
    await runtime.until(() => runtime.sends.length === 1 ? true : null)
    const sessionId = runtime.sends[0]!.session
    const ask = { id: 'ask-a', sessionId, envelope: { status: 'pending' as const } }
    runtime.pendingAsks = [ask]
    runtime.emit('quirky.ask/created', { ask })
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'needs-you')
    expect(runtime.events.filter((event) => event.type === 'quirky.loops/notification')).toHaveLength(1)
    expect(loops.iterations(created.id)).toHaveLength(0)
    runtime.pendingAsks = []
    runtime.emit('quirky.ask/resolved', { askId: ask.id })
    runtime.respond(sessionId, 'finished after approval')
    const settled = await runtime.until(() => loops.iterations(created.id).length === 1 ? loops.iterations(created.id)[0]! : null)
    expect(settled.endReason).toBe('settled')
    expect(loops.get(created.id).iterationsCompleted).toBe(1)
  })
})
