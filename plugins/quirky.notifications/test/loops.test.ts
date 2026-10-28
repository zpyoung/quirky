import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Rig, type Decided, type NotifyEvent } from './support'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'

type RunnerContext = {
  appendMessage(input: { sessionId: string; role: 'user' | 'assistant' | 'system'; text: string; data?: unknown }): unknown
  setStatus(sessionId: string, status: 'running' | 'working' | 'waiting' | 'done' | 'exited'): void
  setProviderSession(sessionId: string, session: { id: string; transcriptPath?: string | null }): Promise<void>
  createAsk(spec: unknown, sessionId: string): Promise<unknown>
}
type TurnResult = { text: string; status: 'done' | 'waiting' }
type LoopScript = (input: { sessionId: string; text: string; context: RunnerContext }) => TurnResult | Promise<TurnResult>

class LoopProbeRunner {
  readonly sends: string[] = []
  constructor(private readonly context: RunnerContext, private readonly script: LoopScript, private readonly onStop?: () => void) {}

  async start(session: { id: string }, prompt?: string): Promise<void> {
    await this.context.setProviderSession(session.id, { id: `notification-fixture-${session.id}`, transcriptPath: null })
    this.context.setStatus(session.id, prompt === undefined || prompt === '' ? 'running' : 'working')
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.sends.push(text)
    this.context.appendMessage({ sessionId, role: 'user', text })
    this.context.setStatus(sessionId, 'working')
    const result = await this.script({ sessionId, text, context: this.context })
    this.context.appendMessage({ sessionId, role: 'assistant', text: result.text })
    this.context.setStatus(sessionId, result.status)
  }

  async stop(sessionId: string): Promise<void> {
    this.onStop?.()
    this.context.setStatus(sessionId, 'exited')
  }
}

const globals = globalThis as typeof globalThis & {
  __QUIRKY_TEST_STRUCTURED_RUNNER__?: (context: RunnerContext) => unknown
}
let scriptedRunner: LoopProbeRunner | undefined
const ENV_KEYS = ['QUIRKY_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
let rig: Rig | undefined
let providerHome: string | undefined
let priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
let previousFactory: ((context: RunnerContext) => unknown) | undefined
let hadFactory = false

afterEach(async () => {
  try {
    await rig?.cleanup()
  } finally {
    rig = undefined
    scriptedRunner = undefined
    if (hadFactory) globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = previousFactory
    else delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
    for (const key of ENV_KEYS) {
      const value = priorEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    priorEnv = {}
    if (providerHome) rmSync(providerHome, { recursive: true, force: true })
    providerHome = undefined
  }
})

async function start(script: LoopScript, options: { cooldownMs?: number; onStop?: () => void } = {}): Promise<Rig> {
  priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof priorEnv
  providerHome = mkdtempSync('/tmp/qn-loop-providers-')
  const claudeHome = join(providerHome, 'claude')
  const codexHome = join(providerHome, 'codex')
  mkdirSync(claudeHome, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  process.env.QUIRKY_HOME = providerHome
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.CODEX_HOME = codexHome
  hadFactory = Object.hasOwn(globals, '__QUIRKY_TEST_STRUCTURED_RUNNER__')
  previousFactory = globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context) => (scriptedRunner = new LoopProbeRunner(context, script, options.onStop))
  rig = await Rig.start(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs })
  await rig.setting('agentTaskComplete', false)
  return rig
}

const repeatConfig = (body: string, patch: Record<string, unknown> = {}) => ({
  promptSource: { kind: 'repeat', body },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false,
  ...patch
})

async function createLoop(workspace: Rig, name: string, config: Record<string, unknown>) {
  return workspace.client.callAny('quirky.loops/create', {
    worktreeId: workspace.worktrees.main!.id,
    agent: 'claude',
    name,
    config
  }) as Promise<{ id: string; sessionId: string | null }>
}

function lastLoopDecision(workspace: Rig): Decided {
  return workspace.decisions().filter((decision) => decision.source === 'loop').at(-1)!
}

async function waitForLoopDecisions(workspace: Rig, count: number): Promise<void> {
  await waitFor(() => workspace.decisions().filter((decision) => decision.source === 'loop').length >= count || undefined, 10_000)
}

function loopNotification(workspace: Rig, title: string): NotifyEvent {
  return workspace.notifies().find((event) => event.title === title)!
}

describe('loop notifications through the central policy', () => {
  test('completion uses the loop title, name body and stable event key', async () => {
    const workspace = await start(() => ({ text: 'LOOP_DONE', status: 'done' }))
    const loop = await createLoop(workspace, 'Finished parser', repeatConfig('Finish parser', {
      done: { check: { command: 'true', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      caps: { maxIterations: 2 }
    }))
    await waitForLoopDecisions(workspace, 1)
    expect(lastLoopDecision(workspace)).toMatchObject({ source: 'loop', result: 'delivered', worktreeId: workspace.worktrees.main!.id })
    expect(loopNotification(workspace, 'Loop completed')).toMatchObject({
      title: 'Loop completed',
      body: 'Finished parser',
      key: `loop:${loop.id}:completed`,
      worktreeId: workspace.worktrees.main!.id
    })
  })

  test('safety pauses use a reason detail and loop-specific key', async () => {
    const workspace = await start(() => ({ text: 'LOOP_BLOCKED: waiting for a design decision', status: 'done' }))
    const loop = await createLoop(workspace, 'Blocked parser', repeatConfig('Finish parser', { caps: { maxIterations: 4 } }))
    await waitForLoopDecisions(workspace, 1)
    expect(lastLoopDecision(workspace)).toMatchObject({ source: 'loop', result: 'delivered' })
    expect(loopNotification(workspace, 'Loop paused')).toMatchObject({
      title: 'Loop paused',
      body: 'Blocked parser: agent-blocked: waiting for a design decision',
      key: `loop:${loop.id}:paused`
    })
  })

  test('cap events retain the cap title and respect the worktree cooldown', async () => {
    const workspace = await start(() => ({ text: 'Iteration complete', status: 'done' }), { cooldownMs: 5000 })
    const first = await createLoop(workspace, 'First loop', repeatConfig('Make progress', { caps: { maxIterations: 1 } }))
    await waitForLoopDecisions(workspace, 1)
    expect(lastLoopDecision(workspace)).toMatchObject({ source: 'loop', result: 'delivered' })
    expect(loopNotification(workspace, 'Loop reached its cap')).toMatchObject({
      title: 'Loop reached its cap',
      body: 'First loop: cap-iterations',
      key: `loop:${first.id}:cap`
    })

    await createLoop(workspace, 'Second loop', repeatConfig('Make progress', { caps: { maxIterations: 1 } }))
    await waitForLoopDecisions(workspace, 2)
    expect(lastLoopDecision(workspace)).toMatchObject({ source: 'loop', result: 'cooldown' })
    expect(workspace.notifies().filter((event) => event.title === 'Loop reached its cap')).toHaveLength(1)
  })

  test('disabled notifications suppress loop banners but still record attention', async () => {
    const disabled = await start(() => ({ text: 'Iteration complete', status: 'done' }))
    await disabled.setting('enabled', false)
    const disabledLoop = await createLoop(disabled, 'Disabled loop', repeatConfig('Make progress', { caps: { maxIterations: 1 } }))
    await waitForLoopDecisions(disabled, 1)
    expect(lastLoopDecision(disabled)).toMatchObject({ source: 'loop', result: 'disabled' })
    expect(disabled.notifies()).toHaveLength(0)
    expect(disabled.attentions()).toContainEqual(expect.objectContaining({ source: 'loop', worktreeId: disabled.worktrees.main!.id }))
    expect(typeof disabledLoop.id).toBe('string')
  })

  test('focus suppression gates loop banners but still records attention', async () => {
    const focused = await start(() => ({ text: 'Iteration complete', status: 'done' }))
    await focused.win.focus()
    await focused.win.open(focused.worktrees.main!.id)
    await createLoop(focused, 'Focused loop', repeatConfig('Make progress', { caps: { maxIterations: 1 } }))
    await waitForLoopDecisions(focused, 1)
    expect(lastLoopDecision(focused)).toMatchObject({ source: 'loop', result: 'suppressed-focus' })
    expect(focused.notifies()).toHaveLength(0)
    expect(focused.attentions()).toContainEqual(expect.objectContaining({ source: 'loop', worktreeId: focused.worktrees.main!.id }))
  })

  test('user pauses do not deliver loop banners or attention markers', async () => {
    const gate = Promise.withResolvers<void>()
    const workspace = await start(async () => {
      await gate.promise
      return { text: 'Iteration complete', status: 'done' }
    }, { onStop: () => gate.resolve() })
    const loop = await createLoop(workspace, 'User paused', repeatConfig('Pause after work', { caps: { maxIterations: 3 } }))
    await waitFor(() => scriptedRunner?.sends.length === 1 ? true : undefined, 10_000)
    await workspace.client.callAny('quirky.loops/pause', { loopId: loop.id, mode: 'after-iteration' })
    gate.resolve()
    await waitForAsync(async () => {
      const snapshot = await workspace.client.callAny('quirky.loops/get', { loopId: loop.id }) as { state: string }
      return snapshot.state === 'paused' ? snapshot : undefined
    }, 10_000)
    // The notifications policy drains producer events asynchronously.
    await workspace.settle()
    expect(workspace.notifies()).toHaveLength(0)
    expect(workspace.attentions().filter((event) => event.source === 'loop')).toHaveLength(0)
  })

  test('needs-you events pass through the same policy and keep the loop-specific event key', async () => {
    const workspace = await start(async ({ sessionId, context }) => {
      void context.createAsk({ questions: [{ id: 'go', type: 'confirm', question: 'Continue the loop?' }] }, sessionId).catch(() => {})
      return { text: 'Waiting for approval', status: 'waiting' }
    }, { cooldownMs: 10 })
    const loop = await createLoop(workspace, 'Needs approval', repeatConfig('Continue safely', { caps: { maxIterations: 3 } }))
    const snapshot = await waitForAsync(async () => {
      const current = await workspace.client.callAny('quirky.loops/get', { loopId: loop.id }) as { state: string; sessionId: string | null }
      return current.state === 'needs-you' ? current : undefined
    }, 10_000)
    await waitForLoopDecisions(workspace, 1)
    const notification = loopNotification(workspace, 'Loop needs you')
    expect(notification.title).toBe('Loop needs you')
    expect(notification.body.startsWith('Needs approval')).toBe(true)
    expect(notification.key).toBe(`loop:${loop.id}:needs-you`)
    const asks = await workspace.client.callAny('quirky.ask/list', { pendingOnly: true }) as { id: string; sessionId: string | null }[]
    const ask = asks.find((candidate) => candidate.sessionId === snapshot.sessionId)
    expect(ask).toBeDefined()
    if (ask) await workspace.client.callAny('quirky.ask/cancel', { askId: ask.id })
  })
})

