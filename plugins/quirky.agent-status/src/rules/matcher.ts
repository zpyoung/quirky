/**
 * The client of the matcher process: runs rule evaluations and wait-pattern matches off the
 * daemon's event loop under a time budget. A request that overruns the budget gets its process
 * killed and replaced, so one pathological user regex never stalls anything else.
 */
import { fileURLToPath } from 'node:url'
import type { ProcessSpawner, SpawnedProcess } from '@quirky/protocol'
import { isRecord } from '../normalize/shared'
import { InvalidMatcherFrameError, readMatcherFrames, type MatcherRequest } from './matcher-protocol'
import type { EffectiveRules, RuleSources } from './sources'
import type { EvaluateInput, Evaluation, LineMatch, Origin, RuleFile, Verdict } from './types'

const BASE_BUDGET_MS = 250
const START_TIMEOUT_MS = 5000
const SHUT_DOWN: Unavailable = { unavailable: 'the matcher was shut down' }
const INVALID_FRAME: Unavailable = { unavailable: 'could not read from the matcher process: invalid matcher frame' }
const ENTRY = fileURLToPath(new URL('./matcher-worker.ts', import.meta.url))

export type TimedOut = { timedOut: true }
export type Unavailable = { unavailable: string }
/** The caller's deadline passed while the request was still queued; it was never run. */
export type Expired = { expired: true }

const EXPIRED: Expired = { expired: true }

/** The per-request budget: 250 ms times a positive `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`. */
export function budgetFrom(env: Record<string, string | undefined>): number {
  const scale = Number(env.QUIRKY_TEST_AGENT_STATUS_TIME_SCALE)
  return BASE_BUDGET_MS * (Number.isFinite(scale) && scale > 0 ? scale : 1)
}

type Reply = { result: unknown } | TimedOut | Unavailable | Expired
type RequestTicket = {
  started: boolean
  settled: boolean
  deadline?: number
  deadlineTimer?: ReturnType<typeof setTimeout>
  settle: (reply: Reply) => void
}
type Waiter = {
  id: number
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  settle: (reply: Reply) => void
}
type Generation = {
  child: SpawnedProcess
  frames: AsyncGenerator<unknown>
  ready: boolean
  retired: boolean
  waiter: Waiter | null
  settleStart: (result: Generation | Unavailable) => void
  failure?: Unavailable
  stopPromise?: Promise<void>
}
type StartResult = Generation | Unavailable

export type MatcherOptions = {
  env?: Record<string, string | undefined>
  /** Overrides the command that starts the matcher process; tests use it to simulate a process that cannot start. */
  command?: string[]
}

/**
 * Evaluates rule files and wait patterns in one long-lived child process, one request at a time.
 * Every method answers with `{ timedOut: true }` when the budget ran out, `{ unavailable }`
 * when the process could not run, or `{ expired: true }` when its `deadline` (epoch ms) passed
 * while it still waited its turn; none of them throws. A request already running is not cut
 * short by its deadline, only by the budget.
 */
export class Matcher {
  private readonly budgetMs: number
  private readonly command: string[]
  private readonly pending = new Set<RequestTicket>()
  private current: Generation | null = null
  private starting: Promise<StartResult> | null = null
  private retirement: Promise<void> = Promise.resolve()
  private tail: Promise<void> = Promise.resolve()
  private nextId = 1
  private disposed = false

  constructor(private readonly spawner: ProcessSpawner, options: MatcherOptions = {}) {
    this.budgetMs = budgetFrom(options.env ?? process.env)
    this.command = options.command ?? [process.execPath, ENTRY]
  }

  /** Runs `file` against `input`. */
  evaluate(file: RuleFile, input: EvaluateInput, origin: Origin, deadline?: number): Promise<Evaluation | TimedOut | Unavailable | Expired> {
    return this.request((id) => ({ id, op: 'evaluate', file, input, origin }), deadline) as Promise<Evaluation | TimedOut | Unavailable | Expired>
  }

  /** The newest of `lines` matching `pattern`; the caller screens the pattern with `unsafePatternReason` first. */
  matchLines(pattern: string, ignoreCase: boolean, lines: string[], deadline?: number): Promise<LineMatch | null | TimedOut | Unavailable | Expired> {
    return this.request((id) => ({ id, op: 'line', pattern, ignoreCase, lines }), deadline) as Promise<LineMatch | null | TimedOut | Unavailable | Expired>
  }

  /** Stops the matcher process; later calls report it unavailable. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const ticket of [...this.pending]) {
      const expired = !ticket.started && ticket.deadline !== undefined && Date.now() >= ticket.deadline
      ticket.settle(expired ? EXPIRED : SHUT_DOWN)
    }
    if (this.current) void this.retire(this.current, SHUT_DOWN)
  }

  private request(build: (id: number) => MatcherRequest, deadline?: number): Promise<unknown> {
    if (this.disposed) {
      const reply = deadline !== undefined && Date.now() >= deadline ? EXPIRED : SHUT_DOWN
      return Promise.resolve(reply)
    }

    const { promise, resolve } = Promise.withResolvers<Reply>()
    let ticket: RequestTicket
    ticket = {
      started: false,
      settled: false,
      deadline,
      settle: (reply) => {
        if (ticket.settled) return
        ticket.settled = true
        clearTimeout(ticket.deadlineTimer)
        this.pending.delete(ticket)
        resolve(reply)
      }
    }
    this.pending.add(ticket)

    if (deadline !== undefined) {
      ticket.deadlineTimer = setTimeout(() => {
        if (!ticket.started) ticket.settle(EXPIRED)
      }, Math.max(0, deadline - Date.now()))
    }

    const run = this.tail.then(async () => {
      if (ticket.settled) return
      if (deadline !== undefined && Date.now() >= deadline) {
        ticket.settle(EXPIRED)
        return
      }
      ticket.started = true
      try {
        ticket.settle(await this.execute(build, ticket))
      } catch (error) {
        ticket.settle({ unavailable: `could not reach the matcher process: ${errorMessage(error)}` })
      }
    })
    this.tail = run.catch(() => undefined)
    return promise.then(reply => 'result' in reply ? reply.result : reply)
  }

  private async execute(build: (id: number) => MatcherRequest, ticket: RequestTicket): Promise<Reply> {
    if (ticket.settled || this.disposed) return SHUT_DOWN
    const started = await this.start()
    if (ticket.settled || this.disposed) return SHUT_DOWN
    if ('unavailable' in started) return started
    if (started.retired || this.current !== started) return started.failure ?? { unavailable: 'the matcher process exited' }

    const generation = started
    const id = this.nextId++
    const { promise, resolve } = Promise.withResolvers<Reply>()
    let waiter: Waiter
    waiter = {
      id,
      settled: false,
      settle: (reply) => {
        if (waiter.settled) return
        waiter.settled = true
        clearTimeout(waiter.timer)
        if (generation.waiter === waiter) generation.waiter = null
        ticket.settle(reply)
        resolve(reply)
      }
    }
    generation.waiter = waiter
    waiter.timer = setTimeout(() => {
      if (generation.retired || this.current !== generation || generation.waiter !== waiter) return
      waiter.settle({ timedOut: true })
      void this.retire(generation)
    }, this.budgetMs)

    try {
      const frame = `${JSON.stringify(build(id))}\n`
      void Promise.resolve(generation.child.write(frame)).then(
        accepted => {
          if (!accepted) this.failWaiter(generation, waiter, { unavailable: 'could not reach the matcher process: stdin is closed' })
        },
        error => this.failWaiter(generation, waiter, { unavailable: `could not reach the matcher process: ${errorMessage(error)}` })
      )
    } catch (error) {
      this.failWaiter(generation, waiter, { unavailable: `could not reach the matcher process: ${errorMessage(error)}` })
    }
    return promise
  }

  private start(): Promise<StartResult> {
    if (this.disposed) return Promise.resolve(SHUT_DOWN)
    const generation = this.current
    if (generation?.ready && !generation.retired) return Promise.resolve(generation)
    if (this.starting) return this.starting

    const starting = this.spawn()
    this.starting = starting
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = null
      },
      () => {
        if (this.starting === starting) this.starting = null
      }
    )
    return starting
  }

  private async spawn(): Promise<StartResult> {
    await this.retirement
    if (this.disposed) return SHUT_DOWN

    let child: SpawnedProcess
    try {
      child = this.spawner.spawn(this.command, {
        timeoutMs: null,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore'
      })
    } catch (error) {
      return { unavailable: `could not start the matcher process: ${errorMessage(error)}` }
    }

    if (child.pid === null) {
      try {
        const exit = await child.exited
        return { unavailable: `could not start the matcher process: ${exit.spawnError?.message ?? 'unknown error'}` }
      } catch (error) {
        return { unavailable: `could not start the matcher process: ${errorMessage(error)}` }
      }
    }

    let frames: AsyncGenerator<unknown>
    try {
      frames = readMatcherFrames(child.stdout)
    } catch (error) {
      this.retirement = this.stop(child)
      return { unavailable: `could not read from the matcher process: ${errorMessage(error)}` }
    }

    const { promise, resolve } = Promise.withResolvers<StartResult>()
    let startSettled = false
    const settleStart = (result: StartResult) => {
      if (startSettled) return
      startSettled = true
      resolve(result)
    }
    const generation: Generation = {
      child,
      frames,
      ready: false,
      retired: false,
      waiter: null,
      settleStart
    }
    this.current = generation
    const readyTimer = setTimeout(() => {
      void this.retire(generation, { unavailable: 'the matcher process did not start in time' })
    }, START_TIMEOUT_MS)
    generation.settleStart = (result) => {
      clearTimeout(readyTimer)
      settleStart(result)
    }

    void this.readOutput(generation).catch(error => this.failRead(generation, error))
    void child.exited.then(
      () => this.retire(generation, { unavailable: generation.ready ? 'the matcher process exited' : 'the matcher process exited before it was ready' }),
      () => this.retire(generation, { unavailable: generation.ready ? 'the matcher process exited' : 'the matcher process exited before it was ready' })
    )
    return promise
  }

  private async readOutput(generation: Generation): Promise<void> {
    try {
      for await (const frame of generation.frames) {
        if (generation.retired || this.current !== generation) return
        this.acceptFrame(generation, frame)
        if (generation.retired) return
      }
      if (!generation.retired) {
        void this.retire(generation, { unavailable: generation.ready ? 'the matcher process exited' : 'the matcher process exited before it was ready' })
      }
    } catch (error) {
      this.failRead(generation, error)
    }
  }

  private acceptFrame(generation: Generation, frame: unknown): void {
    if (!isRecord(frame)) {
      void this.retire(generation, INVALID_FRAME)
      return
    }
    if (Object.hasOwn(frame, 'ready')) {
      if (frame.ready !== true || Object.keys(frame).length !== 1) {
        void this.retire(generation, INVALID_FRAME)
        return
      }
      if (!generation.ready) {
        generation.ready = true
        generation.settleStart(generation)
      }
      return
    }
    if (!generation.ready || typeof frame.id !== 'number' || !Number.isSafeInteger(frame.id) || frame.id <= 0 ||
        !Object.hasOwn(frame, 'result')) {
      void this.retire(generation, INVALID_FRAME)
      return
    }
    const waiter = generation.waiter
    if (waiter && waiter.id === frame.id) waiter.settle({ result: frame.result })
  }

  private failRead(generation: Generation, error: unknown): void {
    if (generation.retired || this.current !== generation) return
    const unavailable = error instanceof InvalidMatcherFrameError
      ? INVALID_FRAME
      : { unavailable: `could not read from the matcher process: ${errorMessage(error)}` }
    void this.retire(generation, unavailable)
  }

  private failWaiter(generation: Generation, waiter: Waiter, failure: Unavailable): void {
    if (generation.retired || this.current !== generation || generation.waiter !== waiter || waiter.settled) return
    void this.retire(generation, failure)
  }

  private retire(generation: Generation, failure?: Unavailable): Promise<void> {
    if (generation.retired) return generation.stopPromise ?? Promise.resolve()
    generation.retired = true
    if (this.current === generation) this.current = null
    const unavailable = failure ?? {
      unavailable: generation.ready ? 'the matcher process exited' : 'the matcher process exited before it was ready'
    }
    if (!generation.ready) generation.settleStart(unavailable)
    generation.failure = unavailable
    generation.waiter?.settle(unavailable)
    void generation.frames.return(undefined).catch(() => undefined)
    generation.stopPromise = this.stop(generation.child)
    this.retirement = generation.stopPromise
    return generation.stopPromise
  }

  private stop(child: SpawnedProcess): Promise<void> {
    let stopping: Promise<unknown>
    try {
      stopping = child.stop({ signal: 'SIGKILL' })
    } catch {
      stopping = child.exited
    }
    return Promise.resolve(stopping).then(() => undefined, () => undefined)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type AgentEvaluation = { source: EffectiveRules | null; verdict: Verdict | null; pendingQuiet?: string; unavailable?: string; expired?: true }

/**
 * Evaluates `agent`'s effective rules and, when a source's patterns run too long, marks that
 * source ignored and falls through to the next one. `source` is the set the answer came from.
 * With a `deadline` (epoch ms), a request still queued behind others when it passes comes back
 * `expired` with no verdict.
 */
export async function evaluateForAgent(
  sources: RuleSources,
  matcher: Matcher,
  agent: string,
  input: EvaluateInput,
  deadline?: number
): Promise<AgentEvaluation> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const source = await sources.effective(agent)
    if (source === null) return { source: null, verdict: null }
    const result = await matcher.evaluate(source.set, input, source.origin, deadline)
    if ('expired' in result) return { source, verdict: null, expired: true }
    if ('timedOut' in result) {
      sources.reportTimeout(source.origin, source.version)
      continue
    }
    if ('unavailable' in result) return { source, verdict: null, unavailable: result.unavailable }
    return { source, ...result }
  }
  return { source: null, verdict: null }
}
