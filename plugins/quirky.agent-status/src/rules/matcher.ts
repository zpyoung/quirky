/**
 * The client of the matcher process: runs rule evaluations and wait-pattern matches off the
 * daemon's event loop under a time budget. A request that overruns the budget gets its process
 * killed and replaced, so one pathological user regex never stalls anything else.
 */
import { fileURLToPath } from 'node:url'
import type { MatcherRequest } from './matcher-worker'
import type { EffectiveRules, RuleSources } from './sources'
import type { EvaluateInput, Evaluation, LineMatch, Origin, RuleFile, Verdict } from './types'

const BASE_BUDGET_MS = 250
const START_TIMEOUT_MS = 5000
const SHUT_DOWN: Unavailable = { unavailable: 'the matcher was shut down' }
const ENTRY = fileURLToPath(new URL('./matcher-worker.ts', import.meta.url))

export type TimedOut = { timedOut: true }
export type Unavailable = { unavailable: string }

/** The per-request budget: 250 ms times a positive `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`. */
export function budgetFrom(env: Record<string, string | undefined>): number {
  const scale = Number(env.QUIRKY_TEST_AGENT_STATUS_TIME_SCALE)
  return BASE_BUDGET_MS * (Number.isFinite(scale) && scale > 0 ? scale : 1)
}

type Reply = { result: unknown } | TimedOut | Unavailable
type Waiter = { id: number; settle: (reply: Reply) => void }
type Child = ReturnType<typeof Bun.spawn>

export type MatcherOptions = {
  env?: Record<string, string | undefined>
  /** Overrides the command that starts the matcher process; tests use it to simulate a process that cannot start. */
  command?: string[]
}

/**
 * Evaluates rule files and wait patterns in one long-lived child process, one request at a time.
 * Every method answers with `{ timedOut: true }` when the budget ran out or `{ unavailable }`
 * when the process could not run; none of them throws.
 */
export class Matcher {
  private readonly budgetMs: number
  private readonly command: string[]
  private child: Child | null = null
  private spawning: Child | null = null
  private starting: Promise<Child | Unavailable> | null = null
  private waiter: Waiter | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private disposed = false

  constructor(options: MatcherOptions = {}) {
    this.budgetMs = budgetFrom(options.env ?? process.env)
    this.command = options.command ?? [process.execPath, ENTRY]
  }

  /** Runs `file` against `input`. */
  evaluate(file: RuleFile, input: EvaluateInput, origin: Origin): Promise<Evaluation | TimedOut | Unavailable> {
    return this.request((id) => ({ id, op: 'evaluate', file, input, origin })) as Promise<Evaluation | TimedOut | Unavailable>
  }

  /** The newest of `lines` matching `pattern`; the caller screens the pattern with `unsafePatternReason` first. */
  matchLines(pattern: string, ignoreCase: boolean, lines: string[]): Promise<LineMatch | null | TimedOut | Unavailable> {
    return this.request((id) => ({ id, op: 'line', pattern, ignoreCase, lines })) as Promise<LineMatch | null | TimedOut | Unavailable>
  }

  /** Stops the matcher process; later calls report it unavailable. */
  dispose(): void {
    this.disposed = true
    this.spawning?.kill('SIGKILL')
    this.waiter?.settle(SHUT_DOWN)
    this.kill()
  }

  private async request(build: (id: number) => MatcherRequest): Promise<unknown> {
    const run = this.tail.then(() => this.execute(build))
    this.tail = run.catch(() => undefined)
    const reply = await run
    return 'result' in reply ? reply.result : reply
  }

  private async execute(build: (id: number) => MatcherRequest): Promise<Reply> {
    if (this.disposed) return SHUT_DOWN
    const started = await this.start()
    if (this.disposed) return SHUT_DOWN
    if ('unavailable' in started) return started
    const child = started
    return new Promise<Reply>((resolve) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        settle({ timedOut: true })
        if (this.child === child) this.kill()
      }, this.budgetMs)
      const settle = (reply: Reply) => {
        clearTimeout(timer)
        if (this.waiter?.id === id) this.waiter = null
        resolve(reply)
      }
      this.waiter = { id, settle }
      try {
        child.send(build(id))
      } catch (error) {
        settle({ unavailable: `could not reach the matcher process: ${error instanceof Error ? error.message : String(error)}` })
        this.kill()
      }
    })
  }

  private start(): Promise<Child | Unavailable> {
    if (this.child) return Promise.resolve(this.child)
    this.starting ??= this.spawn().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private spawn(): Promise<Child | Unavailable> {
    return new Promise((resolve) => {
      let child: Child
      let ready = false
      const fail = (reason: string) => {
        clearTimeout(timer)
        if (this.spawning === child) this.spawning = null
        if (child && this.child === child) this.child = null
        child?.kill('SIGKILL')
        resolve({ unavailable: reason })
      }
      const timer = setTimeout(() => fail('the matcher process did not start in time'), START_TIMEOUT_MS)
      try {
        child = Bun.spawn(this.command, {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          serialization: 'json',
          ipc: (message) => {
            if (message?.ready === true && !ready) {
              ready = true
              clearTimeout(timer)
              this.spawning = null
              if (this.disposed) {
                child.kill('SIGKILL')
                resolve(SHUT_DOWN)
                return
              }
              this.child = child
              resolve(child)
              return
            }
            if (this.waiter && message?.id === this.waiter.id) this.waiter.settle({ result: message.result })
          },
          onExit: () => {
            if (!ready) return fail('the matcher process exited before it was ready')
            if (this.child === child) {
              this.child = null
              this.waiter?.settle({ unavailable: 'the matcher process exited' })
            }
          },
        })
        child.unref()
        this.spawning = child
      } catch (error) {
        fail(`could not start the matcher process: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  private kill(): void {
    const child = this.child
    this.child = null
    child?.kill('SIGKILL')
  }
}

export type AgentEvaluation = { source: EffectiveRules | null; verdict: Verdict | null; pendingQuiet?: string; unavailable?: string }

/**
 * Evaluates `agent`'s effective rules and, when a source's patterns run too long, marks that
 * source ignored and falls through to the next one. `source` is the set the answer came from.
 */
export async function evaluateForAgent(sources: RuleSources, matcher: Matcher, agent: string, input: EvaluateInput): Promise<AgentEvaluation> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const source = await sources.effective(agent)
    if (source === null) return { source: null, verdict: null }
    const result = await matcher.evaluate(source.set, input, source.origin)
    if ('timedOut' in result) {
      sources.reportTimeout(source.origin)
      continue
    }
    if ('unavailable' in result) return { source, verdict: null, unavailable: result.unavailable }
    return { source, ...result }
  }
  return { source: null, verdict: null }
}
