import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type PluginContext, type PluginStore, type QuirkyEvent, type Session, type StructuredMessage, type Worktree } from '@quirky/protocol'
import type { LoopCreateInput } from '../src/types'
import { normalizeLoopConfig } from '../src/config'
import { loopMigrations } from '../src/store'
import { LoopService } from '../src/service'

const roots: string[] = []
const runtimes: Runtime[] = []
const activeServices: LoopService[] = []
afterEach(async () => {
  for (const runtime of runtimes) runtime.releasePendingOperations()
  await Promise.all(activeServices.splice(0).map((service) => service.shutdown()))
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type ScriptedTurn = 'settle' | 'exit' | 'hold'

class Runtime {
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
  pendingAsks: { id: string; sessionId: string; envelope: { status: 'pending' } }[] = []
  private sessionCount = 0
  private sendBarrier: { entered: () => void; wait: Promise<void>; release: () => void } | null = null
  private activeSendRelease: (() => void) | null = null
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
      async createFileResource() { throw new Error('not used') },
      clients: { accept() { throw new Error('Loop engine tests must not admit remote clients') } },
      openStore(migrations) {
        for (const migration of migrations) {
          if (typeof migration === 'string') runtime.database.exec(migration)
          else migration(runtime.pluginStore)
          version++
        }
        return runtime.pluginStore
      },
      getSetting: () => undefined, storedSettingValue: () => undefined,
      error(kind, message) { return Object.assign(new Error(message), { code: kind }) },
      pty: {} as PluginContext['pty'], notify: () => undefined, launch: {} as PluginContext['launch']
    } as PluginContext
  }

  close(): void {
    this.database.close()
  }
  holdNextSend(): { entered: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    this.sendBarrier = { entered: entered.resolve, wait: released.promise, release: released.resolve }
    this.activeSendRelease = released.resolve
    return { entered: entered.promise, release: released.resolve }
  }
  releasePendingOperations(): void {
    const barrier = this.sendBarrier
    this.sendBarrier = null
    barrier?.entered()
    barrier?.release()
    this.activeSendRelease?.()
    this.activeSendRelease = null
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
      return rows
    }
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

function service(runtime: Runtime, now: () => number = Date.now): LoopService {
  const loops = new LoopService(runtime.context, { pollMs: 2, userIdleMs: 0, noBusyEdgeMs: 25, now })
  activeServices.push(loops)
  return loops
}

function loopUntil(runtime: Runtime, loops: LoopService, id: string, match: (snapshot: ReturnType<LoopService['get']>) => boolean) {
  return runtime.until(() => {
    const snapshot = loops.get(id)
    return match(snapshot) ? snapshot : null
  })
}

describe('LoopService background engine', () => {
  test('rejects unsupported agents, presets, blank prompts and invalid numeric config before provider launch', async () => {
    const runtime = rig()
    const loops = service(runtime)
    await loops.start()
    await expect(loops.create({ ...input(), agent: 'shell' as 'claude' })).rejects.toThrow(/agent/i)
    await expect(loops.create({ ...input(), preset: 'queue' as 'until-done' })).rejects.toThrow(/until-done/i)
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

  test('installs private git exclusion before running and never writes .gitignore', async () => {
    const runtime = rig('git')
    const env = {
      ...process.env,
      HOME: join(runtime.root, 'home'),
      QUIRKY_HOME: join(runtime.root, 'quirky-home'),
      CLAUDE_CONFIG_DIR: join(runtime.root, 'provider-home', 'claude'),
      CODEX_HOME: join(runtime.root, 'provider-home', 'codex'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
    expect(Bun.spawnSync(['git', 'init', '-q', runtime.worktree.path], { env }).exitCode).toBe(0)
    const loops = service(runtime)
    await loops.start()
    await loops.create(input())
    const exclude = Bun.spawnSync(['git', '-C', runtime.worktree.path, 'rev-parse', '--git-path', 'info/exclude'], { env }).stdout.toString().trim()
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
    expect(runtime.created).toHaveLength(1)
    expect(restarted.iterations(created.id).map(({ n, attempt }) => [n, attempt])).toEqual([[1, 1], [1, 2]])
  })

  test('excludes approval holds from active time while charging the working turn', async () => {
    const runtime = rig()
    const clock = new ManualClock()
    runtime.turns.push('hold')
    const loops = service(runtime, clock.now)
    await loops.start()
    const created = await loops.create(input({
      ...input().config,
      caps: { maxActiveMinutes: 1 },
      askBeforeNext: true
    }))
    await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.phase === 'working')
    clock.advance(5000)
    const sessionId = runtime.sends[0]!.session
    const ask = { id: 'ask-clock', sessionId, envelope: { status: 'pending' as const } }
    runtime.sessions.set(sessionId, { ...runtime.sessions.get(sessionId)!, status: 'waiting' })
    runtime.emit('quirky.session/changed', { session: runtime.sessions.get(sessionId) })
    const held = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'needs-you')
    expect(held.activeMs).toBe(5000)
    runtime.pendingAsks = [ask]
    runtime.emit('quirky.ask/created', { ask })
    clock.advance(100_000)
    runtime.pendingAsks = []
    runtime.emit('quirky.ask/resolved', { askId: ask.id })
    runtime.respond(sessionId, 'finished after approval')
    const paused = await loopUntil(runtime, loops, created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('ask-before-next')
    expect(paused.activeMs).toBe(5000)
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
