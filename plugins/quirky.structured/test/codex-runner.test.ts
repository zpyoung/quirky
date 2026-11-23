import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCommand, AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createCodexRunner } from '../codex-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment, type CodexAppServerFixture } from './fakes/codex-app-server'
import {
  createProcessRunner,
  type OwnedProcessRunner,
  type ProcessSpawner,
  type SpawnOptions
} from '../../../packages/process/src/api'
import { CodexConnection } from '../codex-connection'

async function until(check: () => boolean) {
  // The child has a real OS event loop; fake timers cannot advance its JSONL I/O.
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

type AskWaiter = { spec: AskSpec; sessionId: string; from?: string; resolve: (answer: AskEnvelope) => void }
type Setup = {
  home: string
  fixture: CodexAppServerFixture
  messages: StructuredMessage[]
  statuses: SessionStatus[]
  asks: AskWaiter[]
  storedProviderSessions: { sessionId: string; id: string; transcriptPath?: string | null }[]
  runner: StructuredRunner
  session: Session
  context: StructuredContext
  processRunner: OwnedProcessRunner
  spawnCalls: { argv: readonly string[]; options: SpawnOptions }[]
  reported: AgentCommand[][]
  usage: Parameters<NonNullable<StructuredContext['reportUsage']>>[1][]
}

let setup: Setup

function makeSetup(fixtureOptions?: Parameters<typeof createCodexAppServerFixture>[1]): Setup {
  const home = mkdtempSync(join(tmpdir(), 'codex-runner-'))
  const fixture = createCodexAppServerFixture(home, fixtureOptions)
  const processRunner = createProcessRunner({ owner: 'codex-runner-test' })
  const spawnCalls: Setup['spawnCalls'] = []
  const process: ProcessSpawner = {
    spawn(argv, options) {
      spawnCalls.push({ argv: [...argv], options })
      return processRunner.spawn(argv, options)
    }
  }
  const messages: StructuredMessage[] = []
  const statuses: SessionStatus[] = []
  const asks: AskWaiter[] = []
  const storedProviderSessions: Setup['storedProviderSessions'] = []
  const reported: AgentCommand[][] = []
  const usage: Setup['usage'] = []
  const context: StructuredContext = {
    process,
    reportCommands(_sessionId, commands) {
      reported.push(commands)
    },
    appendMessage(message: NewStructuredMessage) {
      const stored: StructuredMessage = {
        sessionId: message.sessionId,
        seq: messages.length + 1,
        role: message.role,
        text: message.text,
        at: message.at ?? Date.now(),
        ...(message.data === undefined ? {} : { data: message.data }),
        ...(message.item === undefined ? {} : { item: message.item })
      }
      messages.push(stored)
      return stored
    },
    setStatus(_sessionId, status) {
      statuses.push(status)
    },
    async cancelAsk() {},
    reportUsage(_sessionId, report) {
      usage.push(report)
    },
    createAsk(spec, sessionId, options) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      asks.push({ spec, sessionId, ...(options?.from === undefined ? {} : { from: options.from }), resolve })
      return promise
    },
    async setProviderSession(sessionId, providerSession) {
      storedProviderSessions.push({
        sessionId,
        id: providerSession.id,
        transcriptPath: providerSession.transcriptPath
      })
    },
    resolveClaudePath: async () => '/not-used/claude',
    resolveCodexPath: async () => fixture.executable,
    resolvePiPath: async () => '/not-used/pi'
  }
  const session: Session = {
    id: 's_codex',
    kind: 'structured',
    agent: 'codex',
    worktreeId: 'wt_1',
    cwd: home,
    title: 'Codex',
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
  const runner = createCodexRunner(context, { env: isolatedProviderEnvironment(home) })
  return { home, fixture, messages, statuses, asks, storedProviderSessions, runner, session, context, processRunner, spawnCalls, reported, usage }
}

beforeEach(() => {
  setup = makeSetup()
})

afterEach(async () => {
  await setup.runner.stop(setup.session.id)
  await setup.processRunner.dispose()
  rmSync(setup.home, { recursive: true, force: true })
})

describe('Codex app-server runner', () => {
  test('starts the app-server through the process spawner with the session environment and ownership', async () => {
    await setup.runner.start(setup.session, '')

    expect(setup.spawnCalls).toHaveLength(1)
    expect(setup.spawnCalls[0]?.argv).toEqual([setup.fixture.executable, 'app-server'])
    expect(setup.spawnCalls[0]?.options).toMatchObject({
      timeoutMs: null,
      stdin: 'pipe',
      stderrTailBytes: 49_152,
      killGraceMs: 2_000,
      cwd: setup.session.cwd
    })
    expect(setup.spawnCalls[0]?.options.env).toEqual(isolatedProviderEnvironment(setup.home))
    expect(setup.processRunner.live()).toHaveLength(1)
    expect(setup.processRunner.live()[0]).toMatchObject({
      owner: 'codex-runner-test',
      command: setup.fixture.executable
    })
    const pid = setup.processRunner.live()[0]!.pid

    await setup.runner.stop(setup.session.id)

    expect(setup.processRunner.live()).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('reports an app-server spawn error when the executable is missing', async () => {
    setup.context.resolveCodexPath = async () => '/nonexistent/codex'

    await expect(setup.runner.start(setup.session)).rejects.toThrow(/^could not start Codex app-server: /)
  })

  test('fails a killed connection once and keeps the same error for later requests', async () => {
    const failures: Error[] = []
    const connection = new CodexConnection(setup.context.process, setup.fixture.executable, setup.home, isolatedProviderEnvironment(setup.home), {
      notification() {},
      serverRequest() {},
      failure(error) {
        failures.push(error)
      }
    })
    await until(() => setup.processRunner.live().length === 1)
    const pid = setup.processRunner.live()[0]!.pid

    process.kill(pid, 'SIGKILL')
    await until(() => failures.length === 1)

    expect(failures[0]?.message).toBe('Codex app-server stdout closed')
    await expect(connection.request('x', {})).rejects.toBe(failures[0])
    expect(failures).toHaveLength(1)
    await connection.close()
  })

 
  test('native question frames preserve provider identity and receive the real typed answer instead of an approval decision', async () => {
    await setup.runner.start(setup.session, '[native question]')
    await until(() => setup.asks.length === 1)
    expect(setup.asks[0]!.spec.questions[0]).toMatchObject({ id: 'destination', type: 'select' })
    setup.asks[0]!.resolve({
      status: 'answered', askId: 'ask_native', answers: { destination: { value: 'o2', label: 'Remote', source: 'option' } }, skipped: [], summary: 'Target: Remote'
    })
    await until(() => setup.statuses.at(-1) === 'done')
    expect(setup.fixture.requests().find((entry) => entry.id === 'question-1')).toMatchObject({
      result: { answers: { destination: { answers: ['Remote'] } } }
    })
  })

  test('secret native questions fail before Ask creation and never return an approval', async () => {
    await setup.runner.start(setup.session, '[native secret]')
    await until(() => setup.statuses.at(-1) === 'done')
    expect(setup.asks).toEqual([])
    expect(setup.fixture.requests().find((entry) => entry.id === 'question-1')).toMatchObject({
      error: { code: -32602, message: 'Secret native questions must be collected out of band' }
    })
  })

  test('stopping while resolving the executable prevents app-server spawn', async () => {
    const path = Promise.withResolvers<string>()
    let resolving = false
    const runner = createCodexRunner(
      {
        ...setup.context,
        resolveCodexPath: () => {
          resolving = true
          return path.promise
        }
      },
      { env: isolatedProviderEnvironment(setup.home) }
    )
    const starting = runner.start(setup.session, 'do not launch')
    await until(() => resolving)
    await runner.stop(setup.session.id)
    path.resolve(setup.fixture.executable)
    await starting
    expect(setup.fixture.requests()).toEqual([])
  })
  test('includes native stderr when startup exits before initialize', async () => {
    const script = readFileSync(setup.fixture.executable, 'utf8')
    const pidMarker = 'const environmentLogPath = '
    const initializeMarker = "send({ id: message.id, result: { userAgent: 'codex-fixture', platformFamily: 'unix', platformOs: 'macos' } })"
    expect(script).toContain(pidMarker)
    expect(script).toContain(initializeMarker)
    writeFileSync(
      setup.fixture.executable,
      script
        .replace(pidMarker, "fs.writeFileSync(logPath + '.startup-pid', String(process.pid))\nconst environmentLogPath = ")
        .replace(initializeMarker, "process.stderr.write('fixture initialization diagnostic', () => process.exit(1))")
    )

    await expect(setup.runner.start(setup.session)).rejects.toThrow(
      'Codex app-server stdout closed; stderr: fixture initialization diagnostic'
    )
    const pid = Number(readFileSync(setup.fixture.logPath + '.startup-pid', 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })


  test('initializes before starting a thread and turn, persisting its provider ID first', async () => {
    await setup.runner.start(setup.session, 'summarize', { model: 'gpt-5.5', effort: 'high' })
    await until(() => setup.statuses.includes('done'))

    const calls = setup.fixture.requests()
    expect(calls.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/start', 'skills/list', 'turn/start'])
    expect(calls[2].params).toMatchObject({
      cwd: setup.home,
      model: 'gpt-5.5'
    })
    expect(calls[4].params).toEqual({
      threadId: 'scripted-thread',
      input: [{ type: 'text', text: 'summarize' }],
      model: 'gpt-5.5',
      effort: 'high'
    })
    expect(setup.storedProviderSessions).toEqual([{ sessionId: 's_codex', id: 'scripted-thread', transcriptPath: null }])
    expect(setup.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'summarize'],
      ['assistant', 'Codex: summarize'],
      ['result', 'Codex turn completed']
    ])
    expect(setup.statuses).toEqual(['working', 'done'])
  })

  test('starts later turns with the same model and effort after completion', async () => {
    await setup.runner.start(setup.session, 'first', { model: 'gpt-5.5', effort: 'xhigh' })
    await until(() => setup.statuses.includes('done'))
    await setup.runner.send(setup.session.id, 'second')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: second'))

    const turns = setup.fixture.requests().filter((request) => request.method === 'turn/start')
    expect(turns.map((request) => request.params)).toEqual([
      { threadId: 'scripted-thread', input: [{ type: 'text', text: 'first' }], model: 'gpt-5.5', effort: 'xhigh' },
      { threadId: 'scripted-thread', input: [{ type: 'text', text: 'second' }], model: 'gpt-5.5', effort: 'xhigh' }
    ])
  })
  test('the next turn carries the model and effort picked while the session runs', async () => {
    await setup.runner.start(setup.session, 'first', { model: 'gpt-5.5', effort: 'low' })
    await until(() => setup.statuses.includes('done'))
    const result = await setup.runner.configure!(setup.session.id, { model: 'gpt-5.6', effort: 'high' })
    expect(result).toEqual({ model: 'gpt-5.6', effort: 'high', permissionMode: 'default' })
    await setup.runner.send(setup.session.id, 'second')
    await until(() => setup.fixture.requests().filter((request) => request.method === 'turn/start').length === 2)
    const second = setup.fixture.requests().filter((request) => request.method === 'turn/start')[1]!
    expect(second.params).toMatchObject({ model: 'gpt-5.6', effort: 'high' })
  })

  test('the opening permission mode sets the thread approval policy, sandbox and reviewer', async () => {
    await setup.runner.start(setup.session, undefined, { permissionMode: 'full-access' })
    const threadStart = setup.fixture.requests().find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(threadStart?.params).not.toHaveProperty('approvalsReviewer')
    expect(await setup.runner.configure!(setup.session.id, {})).toEqual({ permissionMode: 'full-access' })
  })

  test('a permission mode picked mid-session goes out once, with the next turn/start', async () => {
    await setup.runner.start(setup.session, 'first')
    await until(() => setup.statuses.includes('done'))
    expect(await setup.runner.configure!(setup.session.id, { permissionMode: 'read-only' })).toEqual({ permissionMode: 'read-only' })
    await setup.runner.send(setup.session.id, 'second')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: second'))
    await setup.runner.configure!(setup.session.id, { permissionMode: 'auto-review' })
    await setup.runner.send(setup.session.id, 'third')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: third'))
    await setup.runner.send(setup.session.id, 'fourth')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: fourth'))
    const turns = setup.fixture.requests().filter((request) => request.method === 'turn/start').map((request) => request.params as Record<string, unknown>)
    expect(turns[0]).not.toHaveProperty('approvalPolicy')
    expect(turns[1]).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, approvalsReviewer: 'user' })
    expect(turns[2]).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, approvalsReviewer: 'auto_review' })
    // app-server keeps turn overrides for later turns, so an unchanged mode sends none
    expect(turns[3]).not.toHaveProperty('approvalPolicy')
  })

  test('opening in auto-review asks app-server for the auto reviewer', async () => {
    await setup.runner.start(setup.session, undefined, { permissionMode: 'auto-review' })
    const threadStart = setup.fixture.requests().find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' })
  })

  test('a permission mode Codex does not offer is refused', async () => {
    await setup.runner.start(setup.session, undefined)
    await expect(setup.runner.configure!(setup.session.id, { permissionMode: 'yolo' })).rejects.toThrow('Codex has no permission mode yolo')
  })

  test('starts a native thread without an initial turn until the caller is attached', async () => {
    await setup.runner.start(setup.session, undefined)
    await until(() => setup.fixture.requests().some((request) => request.method === 'skills/list'))
    expect(setup.fixture.requests().map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'skills/list'
    ])
    expect(setup.statuses).toEqual(['running'])
    expect(setup.messages).toEqual([])

    await setup.runner.send(setup.session.id, 'first custody-recorded turn')
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().filter((request) => request.method === 'turn/start')).toHaveLength(1)
    expect(setup.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'first custody-recorded turn'
    ])
  })

  test('starts later turns with the same model and effort after completion', async () => {
    await setup.runner.start(setup.session, 'first', { model: 'gpt-5.5', effort: 'xhigh' })
    await until(() => setup.statuses.includes('done'))
    await setup.runner.send(setup.session.id, 'second')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: second'))

    const turns = setup.fixture.requests().filter((request) => request.method === 'turn/start')
    expect(turns.map((request) => request.params)).toEqual([
      { threadId: 'scripted-thread', input: [{ type: 'text', text: 'first' }], model: 'gpt-5.5', effort: 'xhigh' },
      { threadId: 'scripted-thread', input: [{ type: 'text', text: 'second' }], model: 'gpt-5.5', effort: 'xhigh' }
    ])
  })
  test('journals native cumulative token usage as per-turn deltas', async () => {
    const marker = "  notify('turn/started', { threadId, turn })"
    const usageNotification = `${marker}
  const turnNumber = Number(turn.id.slice(5))
  notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: { total: {
      inputTokens: turnNumber === 1 ? 100 : 117,
      outputTokens: turnNumber === 1 ? 20 : 26,
      cachedInputTokens: turnNumber === 1 ? 8 : 11,
      reasoningOutputTokens: turnNumber === 1 ? 4 : 8
    } }
  })`
    const server = readFileSync(setup.fixture.executable, 'utf8')
    writeFileSync(setup.fixture.executable, server.replace(marker, usageNotification))

    await setup.runner.start(setup.session, 'first usage turn')
    await until(() => setup.messages.filter((message) => message.role === 'result').length === 1)
    await setup.runner.send(setup.session.id, 'second usage turn')
    await until(() => setup.messages.filter((message) => message.role === 'result').length === 2)

    const evidence = setup.messages.filter((message) => {
      const data = message.data
      return typeof data === 'object' && data !== null && 'type' in data &&
        data.type === 'thread/tokenUsage/updated'
    })
    expect(evidence).toHaveLength(2)
    expect(evidence[0]).toMatchObject({
      data: {
        type: 'thread/tokenUsage/updated',
        turnUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 8, reasoningOutputTokens: 4 }
      }
    })
    expect(evidence[1]).toMatchObject({
      data: {
        type: 'thread/tokenUsage/updated',
        turnUsage: { inputTokens: 17, outputTokens: 6, cachedInputTokens: 3, reasoningOutputTokens: 4 }
      }
    })
  })
  test('a turn Codex starts by itself shows working, can be interrupted and ends as stopped', async () => {
    const marker = "  if (text.includes('[failed]')) return finish(threadId, turn, 'failed')"
    // after the first turn completes the server opens a held turn with no turn/start from Quirky
    const selfStart = `  if (text.includes('[self-start]')) {
    finish(threadId, turn)
    const own = { id: 'turn-own', status: 'inProgress', items: [] }
    active.set(threadId, { turn: own, text: 'on its own', held: true, scriptedRequestsRemaining: 0 })
    setTimeout(() => notify('turn/started', { threadId, turn: own }), 50)
    return
  }
${marker}`
    const server = readFileSync(setup.fixture.executable, 'utf8')
    writeFileSync(setup.fixture.executable, server.replace(marker, selfStart))

    await setup.runner.start(setup.session, 'go [self-start]')
    await until(() => setup.statuses.includes('done'))
    await until(() => setup.statuses.at(-1) === 'working')
    expect(setup.statuses).toEqual(['working', 'done', 'working'])
    await setup.runner.interrupt(setup.session.id)
    expect(setup.fixture.requests().filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([
      { threadId: 'scripted-thread', turnId: 'turn-own' }
    ])
    expect(setup.statuses.at(-1)).toBe('done')
    const turnEnds = setup.messages.filter((message) => (message.item as { kind?: string } | undefined)?.kind === 'turn-end')
    expect(turnEnds.map((message) => (message.item as { state: string }).state)).toEqual(['done', 'stopped'])
  })

  test('a refused send is not journaled or left working', async () => {
    await setup.runner.start(setup.session, 'first accepted turn')
    await until(() => setup.statuses.includes('done'))
    await expect(setup.runner.send(setup.session.id, '[rpc-error]')).rejects.toThrow('scripted turn request error')
    expect(setup.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'first accepted turn'
    ])
    expect(setup.statuses).toEqual(['working', 'done', 'exited'])
  })


  test('steers an active turn with its expected ID and records input only after acceptance', async () => {
    await setup.runner.start(setup.session, '[hold] first')
    await setup.runner.send(setup.session.id, 'focus on tests')
    await until(() => setup.statuses.includes('done'))

    const steer = setup.fixture.requests().find((request) => request.method === 'turn/steer')
    expect(steer?.params).toEqual({
      threadId: 'scripted-thread',
      input: [{ type: 'text', text: 'focus on tests' }],
      expectedTurnId: 'turn-1'
    })
    expect(setup.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      '[hold] first',
      'focus on tests'
    ])
    expect(setup.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant', 'result'])
  })

  test('appended instructions go out as developerInstructions on thread/start and thread/resume', async () => {
    await setup.runner.start(setup.session, undefined, { appendInstructions: 'draw visuals' })
    expect(setup.fixture.requests().find((request) => request.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'draw visuals'
    })
    await setup.runner.stop(setup.session.id)
    const resumed = { ...setup.session, providerSession: { id: 'persisted-thread', transcriptPath: null } }
    await setup.runner.start(resumed, undefined, {
      appendInstructions: 'draw visuals',
      providerSession: { id: 'persisted-thread', transcriptPath: null }
    })
    expect(setup.fixture.requests().find((request) => request.method === 'thread/resume')?.params).toMatchObject({
      developerInstructions: 'draw visuals'
    })
  })

  test('without instructions thread/start carries no developerInstructions', async () => {
    await setup.runner.start(setup.session, undefined)
    expect(setup.fixture.requests().find((request) => request.method === 'thread/start')?.params).not.toHaveProperty('developerInstructions')
  })

  test('resumes an existing thread without a prompt and sends a later turn on it', async () => {
    const resumed = { ...setup.session, providerSession: { id: 'persisted-thread', transcriptPath: null } }
    await setup.runner.start(resumed, undefined, { providerSession: { id: 'persisted-thread', transcriptPath: null } })
    await until(() => setup.fixture.requests().some((request) => request.method === 'skills/list'))
    expect(setup.fixture.requests().map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'skills/list'])
    expect(setup.statuses).toEqual(['running'])
    await setup.runner.send(resumed.id, 'continue later')
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().find((request) => request.method === 'turn/start')?.params).toMatchObject({
      threadId: 'persisted-thread',
      input: [{ type: 'text', text: 'continue later' }]
    })
    expect(setup.storedProviderSessions).toEqual([{ sessionId: 's_codex', id: 'persisted-thread', transcriptPath: null }])
  })

  test('waits for every concurrent approval and replies with native decisions', async () => {
    await setup.runner.start(setup.session, '[approve twice] edit and run')
    await until(() => setup.asks.length === 2)
    expect(setup.statuses.at(-1)).toBe('waiting')
    setup.asks[0].resolve({ status: 'answered', askId: 'ask-1', answers: { decision: { value: 'allow', source: 'option' } }, skipped: [], summary: '' })
    await until(() => setup.fixture.requests().some((request) => request.id === 'approval-1'))
    expect(setup.statuses.at(-1)).toBe('waiting')
    setup.asks[1].resolve({ status: 'answered', askId: 'ask-2', answers: { decision: { value: 'deny', source: 'option' } }, skipped: [], summary: '' })
    await until(() => setup.statuses.includes('done'))

    const replies = setup.fixture.requests().filter((request) => request.method === undefined && (request.id === 'approval-1' || request.id === 2))
    expect(replies).toEqual([
      { id: 'approval-1', result: { decision: 'accept' } },
      { id: 2, result: { decision: 'decline' } }
    ])
  })

  test('fails closed on an unknown server request', async () => {
    await setup.runner.start(setup.session, '[unknown] continue')
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests()).toContainEqual(expect.objectContaining({
      id: 'unknown-1',
      error: expect.objectContaining({ code: -32601 })
    }))
  })

  test('a failed turn exits without publishing done', async () => {
    await setup.runner.start(setup.session, '[failed]')
    await until(() => setup.statuses.includes('exited'))
    expect(setup.statuses).not.toContain('done')
    expect(setup.messages.some((message) => message.role === 'system' && message.text.includes('scripted turn failure'))).toBe(true)
  })

  test('stopping an active turn terminates the owned process group', async () => {
    await setup.runner.start(setup.session, '[descendant] keep alive')
    const childPid = Number(readFileSync(setup.fixture.logPath + '.pid', 'utf8'))

    await setup.runner.stop(setup.session.id)
    await until(() => {
      try {
        process.kill(childPid, 0)
        return false
      } catch {
        return true
      }
    })
    expect(setup.statuses.at(-1)).toBe('exited')
    expect(setup.statuses).not.toContain('done')
  })
  test('bounds close when an escaped descendant retains app-server stdio', async () => {
    const escapedPidPath = setup.fixture.logPath + '.escaped-pid'
    try {
      await setup.runner.start(setup.session, '[escaped-stdio] complete turn')
      await until(() => setup.statuses.includes('done') && existsSync(escapedPidPath))

      const threadStart = setup.fixture.requests().find((request) => request.method === 'thread/start')
      expect(threadStart?.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })

      // Real OS pipe descriptors are held by the escaped child; fake timers cannot release them.
      const deadline = Promise.withResolvers<boolean>()
      const timer = setTimeout(() => deadline.resolve(false), 1_500)
      let stoppedInTime: boolean
      try {
        stoppedInTime = await Promise.race([
          setup.runner.stop(setup.session.id).then(() => true),
          deadline.promise
        ])
      } finally {
        clearTimeout(timer)
      }
      expect(stoppedInTime).toBe(true)
      expect(setup.statuses.at(-1)).toBe('exited')
    } finally {
      try {
        const escapedPid = Number(readFileSync(escapedPidPath, 'utf8'))
        if (Number.isSafeInteger(escapedPid) && escapedPid > 0) process.kill(escapedPid, 'SIGKILL')
      } catch {
        // The escaped child may already have exited or not have been created.
      }
      await setup.runner.stop(setup.session.id)
    }
  })


  test('journals chat items: user, running then finished command under one callId, prose and turn-end', async () => {
    await setup.runner.start(setup.session, '[approve] run it')
    await until(() => setup.asks.length === 1)
    const [decision, reason] = setup.asks[0]!.spec.questions as any[]
    expect(decision.options.map((option: any) => [option.value, option.label])).toEqual([
      ['allow', 'Allow once'],
      ['always', 'Allow for this session'],
      ['deny', 'Deny']
    ])
    expect(reason).toMatchObject({ id: 'reason', type: 'text', required: false })
    setup.asks[0]!.resolve({ status: 'answered', askId: 'a1', answers: { decision: { value: 'allow', source: 'option' } }, skipped: ['reason'], summary: '' })
    await until(() => setup.statuses.includes('done'))
    const items = setup.messages.map((message) => message.item)
    expect(items.every((item) => item !== undefined)).toBe(true)
    expect(items[0]).toEqual({ kind: 'user', text: '[approve] run it' })
    const command = items.filter((item) => item?.kind === 'activity') as any[]
    expect(command.map((item) => [item.callId, item.state])).toEqual([
      ['command-turn-1', 'running'],
      ['command-turn-1', 'done']
    ])
    expect(items.at(-1)).toMatchObject({ kind: 'turn-end', state: 'done' })
    expect(items.some((item) => item?.kind === 'prose' && item.text.startsWith('Codex: '))).toBe(true)
  })

  test('a denial with a reason declines, then tells the agent why', async () => {
    await setup.runner.start(setup.session, '[approve] run it')
    await until(() => setup.asks.length === 1)
    setup.asks[0]!.resolve({
      status: 'answered',
      askId: 'a1',
      answers: { decision: { value: 'deny', source: 'option' }, reason: { value: 'not on prod', source: 'input' } },
      skipped: [],
      summary: ''
    })
    await until(() => setup.fixture.requests().some((request) => request.method === 'turn/steer' || (request.method === 'turn/start' && JSON.stringify(request.params).includes('Denied'))))
    expect(setup.fixture.requests().find((request) => request.id === 'approval-1')).toEqual({ id: 'approval-1', result: { decision: 'decline' } })
    const followUp = setup.fixture.requests().find((request) => JSON.stringify(request.params?.input ?? '').includes('Denied: not on prod'))
    expect(followUp?.method).toBeDefined()
    await until(() => setup.messages.some((message) => message.role === 'user' && message.text === 'Denied: not on prod'))
  })

  test('a denial without a reason sends no follow-up', async () => {
    await setup.runner.start(setup.session, '[approve] run it')
    await until(() => setup.asks.length === 1)
    setup.asks[0]!.resolve({ status: 'answered', askId: 'a1', answers: { decision: { value: 'deny', source: 'option' } }, skipped: ['reason'], summary: '' })
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().filter((request) => request.method === 'turn/steer')).toEqual([])
  })

  test('image paths go to the app-server as localImage inputs', async () => {
    await setup.runner.start(setup.session, undefined)
    const image = join(setup.home, 'shot.png')
    writeFileSync(image, 'PNG')
    await setup.runner.send(setup.session.id, 'look at this', { images: [image], queuedId: 'q1' })
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().find((request) => request.method === 'turn/start')?.params).toMatchObject({
      input: [{ type: 'text', text: 'look at this' }, { type: 'localImage', path: image }]
    })
    expect(setup.messages.find((message) => message.role === 'user')?.item).toEqual({ kind: 'user', text: 'look at this', images: [image], queuedId: 'q1' })
  })

  test('an image sent with no text goes to the app-server as the localImage input alone', async () => {
    await setup.runner.start(setup.session, undefined)
    const image = join(setup.home, 'shot.png')
    writeFileSync(image, 'PNG')
    await setup.runner.send(setup.session.id, '', { images: [image] })
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().find((request) => request.method === 'turn/start')?.params).toMatchObject({ input: [{ type: 'localImage', path: image }] })
  })

  test('stopping mid-turn closes the running call as stopped, then ends the turn as stopped', async () => {
    await setup.runner.start(setup.session, '[approve] run it')
    await until(() => setup.asks.length === 1)
    await setup.runner.stop(setup.session.id)
    const items = setup.messages.map((message) => message.item) as any[]
    expect(items.slice(-2).map((item) => [item.kind, item.state])).toEqual([['activity', 'stopped'], ['turn-end', 'stopped']])
    expect(items.at(-2).callId).toBe('command-turn-1')
  })

  test('interrupting mid-turn ends the turn as stopped and keeps the session usable', async () => {
    await setup.runner.start(setup.session, '[approve] run it')
    await until(() => setup.asks.length === 1)
    await setup.runner.interrupt(setup.session.id)
    const items = setup.messages.map((message) => message.item) as any[]
    expect(items.slice(-2).map((item) => [item.kind, item.state])).toEqual([['activity', 'stopped'], ['turn-end', 'stopped']])
    expect(setup.statuses.at(-1)).toBe('done')
    await Bun.sleep(100)
    expect(setup.statuses).not.toContain('exited')
    expect(setup.fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(true)
    setup.asks[0]!.resolve({ status: 'declined', askId: 'a1', answers: {}, skipped: ['decision'], summary: '' })
    await setup.runner.send(setup.session.id, 'again')
    await until(() => setup.messages.some((message) => message.item?.kind === 'user' && (message.item as any).text === 'again'))
    expect(setup.statuses).not.toContain('exited')
  })

  test('interrupting with no open turn does nothing', async () => {
    await setup.runner.start(setup.session, 'quick')
    await until(() => setup.statuses.includes('done'))
    const before = setup.messages.length
    await setup.runner.interrupt(setup.session.id)
    expect(setup.messages).toHaveLength(before)
    expect(setup.fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
  })

  test('an interrupt the app-server ignores falls back to a full stop', async () => {
    await setup.runner.start(setup.session, '[approve] [ignore-interrupt] run it')
    await until(() => setup.asks.length === 1)
    await setup.runner.interrupt(setup.session.id)
    expect(setup.statuses.at(-1)).toBe('exited')
  })

  test('a failed turn ends as failed and journals an error item', async () => {
    await setup.runner.start(setup.session, '[failed]')
    await until(() => setup.statuses.includes('exited'))
    const items = setup.messages.map((message) => message.item) as any[]
    expect(items.at(-2)).toMatchObject({ kind: 'turn-end', state: 'failed' })
    expect(items.at(-1)).toMatchObject({ kind: 'error', reason: 'exited', resumable: true })
  })
})

describe('Codex skills', () => {
  const SKILLS = [
    { name: 'imagegen', description: 'Generate or edit raster images', path: '/codex/skills/imagegen/SKILL.md', scope: 'system', enabled: true, pluginId: null },
    { name: 'pdf:pdf', description: 'Long PDF description', shortDescription: 'Work with PDFs', path: '/codex/plugins/pdf/SKILL.md', scope: 'user', enabled: true, pluginId: 'pdf@openai' },
    { name: 'off', description: 'Disabled', path: '/codex/skills/off/SKILL.md', scope: 'user', enabled: false, pluginId: null }
  ]

  beforeEach(async () => {
    await setup.runner.stop(setup.session.id)
    await setup.processRunner.dispose()
    rmSync(setup.home, { recursive: true, force: true })
    setup = makeSetup({ skills: SKILLS })
  })

  test('reports enabled skills from skills/list before the first message, plugin skills as plugin entries', async () => {
    await setup.runner.start(setup.session, undefined)
    await until(() => setup.reported.length === 1)
    expect(setup.fixture.requests().find((request) => request.method === 'skills/list')?.params).toEqual({ cwds: [setup.home] })
    expect(setup.reported).toEqual([
      [
        { name: 'imagegen', kind: 'skill', description: 'Generate or edit raster images' },
        { name: 'pdf:pdf', kind: 'plugin', description: 'Work with PDFs' }
      ]
    ])
  })

  test('an app-server that never answers skills/list still starts and runs a plain message at once', async () => {
    await setup.runner.stop(setup.session.id)
    await setup.processRunner.dispose()
    rmSync(setup.home, { recursive: true, force: true })
    setup = makeSetup({ skills: 'silent' })
    const started = Date.now()
    await setup.runner.start(setup.session, 'plain message')
    await until(() => setup.messages.some((message) => message.role === 'assistant' && message.text === 'Codex: plain message'))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(setup.reported).toEqual([])
  })

  test('a skill named anywhere in the message is attached as a skill input item; unknown names and paths are not', async () => {
    await setup.runner.start(setup.session, undefined)
    await setup.runner.send(setup.session.id, 'read /tmp/x and use /pdf:pdf then /off and /imagegen')
    await until(() => setup.statuses.includes('done'))
    expect(setup.fixture.requests().find((request) => request.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: 'read /tmp/x and use /pdf:pdf then /off and /imagegen' },
      { type: 'skill', name: 'pdf:pdf', path: '/codex/plugins/pdf/SKILL.md' },
      { type: 'skill', name: 'imagegen', path: '/codex/skills/imagegen/SKILL.md' }
    ])
  })
})

describe('Codex sub-agents', () => {
  type AgentSnapshot = {
    kind: 'agent'
    id: string
    name: string
    task: string
    state: string
    agent?: string
    prompt?: string
    model?: string
    nativeId?: string
    steps: string
    tokens?: number
    report?: string
    error?: string
    cutOff?: boolean
  }
  const PARENT = 'scripted-thread'
  const ANSWER_ALLOW: AskEnvelope = { status: 'answered', askId: 'a', answers: { decision: { value: 'allow', source: 'option' } }, skipped: [], summary: '' }

  const itemsOf = () => setup.messages.map((message) => message.item as Record<string, unknown> | undefined).filter((item) => item !== undefined) as Record<string, unknown>[]
  const agentSnapshots = (id: string) => itemsOf().filter((item) => item.kind === 'agent' && item.id === id) as unknown as AgentSnapshot[]
  const latestAgent = (id: string) => agentSnapshots(id).at(-1)
  const interrupts = () => setup.fixture.requests().filter((request) => request.method === 'turn/interrupt').map((request) => request.params)
  const turnEnds = () => itemsOf().filter((item) => item.kind === 'turn-end')

  async function runWith(options: NonNullable<Parameters<typeof makeSetup>[0]>) {
    await setup.runner.stop(setup.session.id)
    await setup.processRunner.dispose()
    rmSync(setup.home, { recursive: true, force: true })
    setup = makeSetup(options)
    await setup.runner.start(setup.session, 'go')
  }

  const spawnCall = (receivers: string[], extra: Record<string, unknown> = {}) => ({
    method: 'item/completed',
    params: {
      threadId: PARENT,
      turnId: 'turn-1',
      item: {
        id: 'collab-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: PARENT,
        receiverThreadIds: receivers,
        prompt: 'Find the flaky test',
        model: 'gpt-5.5',
        agentsStates: Object.fromEntries(receivers.map((id) => [id, { status: 'running', message: null }])),
        ...extra
      }
    }
  })

  test('a child thread becomes an agent item and a later spawn call fills in its prompt and model', async () => {
    await runWith({ turnScript: { hold: true, notifications: [spawnCall(['child-1'])] }, childThreads: [{ id: 'child-1', agentNickname: 'Scout' }] })
    await until(() => latestAgent('child-1')?.prompt !== undefined)

    expect(agentSnapshots('child-1')[0]).toMatchObject({ name: 'Scout', nativeId: 'child-1', steps: 'full', state: 'working', task: '' })
    expect(latestAgent('child-1')).toMatchObject({ prompt: 'Find the flaky test', task: 'Find the flaky test', model: 'gpt-5.5', state: 'working' })
    expect(latestAgent('child-1')?.agent).toBeUndefined()
    expect(itemsOf().some((item) => item.kind === 'status' && String(item.text).includes('collabAgentToolCall'))).toBe(false)
  })

  test('a spawn call seen before its thread/started supplies the prompt at spawn', async () => {
    await runWith({ turnScript: { hold: true }, childThreads: [{ id: 'first', notifications: [spawnCall(['late'])] }, { id: 'late', agentRole: 'explorer' }] })
    await until(() => latestAgent('late') !== undefined)

    expect(agentSnapshots('late')).toHaveLength(1)
    expect(latestAgent('late')).toMatchObject({ name: 'explorer', prompt: 'Find the flaky test', model: 'gpt-5.5' })
  })

  test('an unnamed child is called agent', async () => {
    await runWith({ turnScript: { hold: true }, childThreads: [{ id: 'child-1' }] })
    await until(() => latestAgent('child-1') !== undefined)
    expect(latestAgent('child-1')?.name).toBe('agent')
  })

  test('child items are tagged with the child and never end or settle the parent turn', async () => {
    const item = { id: 'cmd-1', type: 'commandExecution', status: 'inProgress', command: 'ls', cwd: '/' }
    await runWith({
      turnScript: { hold: true },
      childThreads: [
        {
          id: 'child-1',
          agentNickname: 'Scout',
          notifications: [
            { method: 'item/started', params: { threadId: 'child-1', turnId: 'child-turn-1', item } },
            { method: 'item/agentMessage/delta', params: { threadId: 'child-1', turnId: 'child-turn-1', itemId: 'msg-1', delta: 'found it' } },
            { method: 'item/completed', params: { threadId: 'child-1', turnId: 'child-turn-1', item: { ...item, status: 'completed', aggregatedOutput: 'x' } } },
            { method: 'item/completed', params: { threadId: 'child-1', turnId: 'child-turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'found it' } } },
            { method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'child-turn-1', status: 'completed', items: [] } } }
          ]
        }
      ]
    })
    await until(() => itemsOf().some((entry) => entry.kind === 'prose' && entry.agent === 'child-1'))

    const calls = itemsOf().filter((entry) => entry.kind === 'activity')
    expect(calls.map((entry) => [entry.state, entry.agent])).toEqual([['running', 'child-1'], ['done', 'child-1']])
    expect(itemsOf().find((entry) => entry.kind === 'prose')).toMatchObject({ text: 'found it', agent: 'child-1' })
    expect(turnEnds()).toEqual([])
    expect(setup.statuses).not.toContain('done')
  })

  test('a nested child is tagged with its parent agent', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [{ id: 'child-1', agentNickname: 'Lead' }, { id: 'child-2', parentThreadId: 'child-1', agentNickname: 'Helper' }]
    })
    await until(() => latestAgent('child-2') !== undefined)
    expect(latestAgent('child-2')?.agent).toBe('child-1')
    expect(latestAgent('child-1')?.agent).toBeUndefined()
  })

  test('collab items and sub-agent activity drive agent state without status lines', async () => {
    await runWith({
      turnScript: {
        hold: true,
        notifications: [
          spawnCall(['c-done', 'c-failed', 'c-stopped', 'c-active'], {
            tool: 'wait',
            agentsStates: {
              'c-done': { status: 'completed', message: 'all green' },
              'c-failed': { status: 'errored', message: 'boom' },
              'c-stopped': { status: 'shutdown', message: null },
              'c-active': { status: 'running', message: null }
            }
          }),
          { method: 'item/started', params: { threadId: PARENT, turnId: 'turn-1', item: { id: 'act-1', type: 'subAgentActivity', kind: 'interrupted', agentThreadId: 'c-activity', agentPath: '/root/a' } } }
        ]
      },
      childThreads: [{ id: 'c-done' }, { id: 'c-failed' }, { id: 'c-stopped' }, { id: 'c-active' }, { id: 'c-activity' }]
    })
    await until(() => latestAgent('c-activity')?.state === 'stopped')

    expect(latestAgent('c-done')).toMatchObject({ state: 'done', report: 'all green' })
    expect(latestAgent('c-failed')).toMatchObject({ state: 'failed', error: 'boom' })
    expect(latestAgent('c-stopped')?.state).toBe('stopped')
    expect(latestAgent('c-active')?.state).toBe('working')
    expect(latestAgent('c-done')?.cutOff).toBeUndefined()
    expect(itemsOf().some((item) => item.kind === 'status' && /collabAgentToolCall|subAgentActivity/.test(String(item.text)))).toBe(false)
  })

  test('a child approval is accepted, labeled with the agent and flips it to needs-you while pending', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [
        {
          id: 'child-1',
          agentNickname: 'Scout',
          serverRequests: [{ method: 'item/commandExecution/requestApproval', params: { threadId: 'child-1', turnId: 'child-turn-1', command: 'rm -rf build', reason: 'clean' } }]
        }
      ]
    })
    await until(() => setup.asks.length === 1)

    expect(setup.asks[0]!.from).toBe('child-1')
    expect(setup.asks[0]!.spec.title).toBe('Scout asks')
    expect(latestAgent('child-1')?.state).toBe('needs-you')
    setup.asks[0]!.resolve(ANSWER_ALLOW)
    await until(() => latestAgent('child-1')?.state === 'working')
    await until(() => setup.fixture.requests().some((request) => request.result !== undefined && (request.result as { decision?: string }).decision === 'accept'))
  })

  test('a child approval for a turn that is not its active turn is declined without asking', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [{ id: 'child-1', serverRequests: [{ method: 'item/commandExecution/requestApproval', params: { threadId: 'child-1', turnId: 'stale-turn', command: 'ls' } }] }]
    })
    await until(() => setup.fixture.requests().some((request) => (request.result as { decision?: string } | undefined)?.decision === 'decline'))
    expect(setup.asks).toEqual([])
  })

  test('a request from a thread with no agent is declined', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [{ id: 'ghost', announce: false, serverRequests: [{ method: 'item/commandExecution/requestApproval', params: { threadId: 'ghost', turnId: 'child-turn-1', command: 'ls' } }] }]
    })
    await until(() => setup.fixture.requests().some((request) => (request.result as { decision?: string } | undefined)?.decision === 'decline'))
    expect(setup.asks).toEqual([])
  })

  test('a child native question is asked under the agent label', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [
        {
          id: 'child-1',
          agentNickname: 'Scout',
          serverRequests: [
            {
              method: 'item/tool/requestUserInput',
              params: { threadId: 'child-1', turnId: 'child-turn-1', questions: [{ id: 'destination', header: 'Target', question: 'Where next?', isSecret: false, options: [{ label: 'Local' }, { label: 'Remote' }] }] }
            }
          ]
        }
      ]
    })
    await until(() => setup.asks.length === 1)
    expect(setup.asks[0]).toMatchObject({ from: 'child-1', spec: { title: 'Scout asks' } })
    expect(latestAgent('child-1')?.state).toBe('needs-you')
    setup.asks[0]!.resolve({ status: 'declined', askId: 'a', answers: {}, skipped: ['destination'], summary: '' })
    await until(() => latestAgent('child-1')?.state === 'working')
  })

  test('a parent approval keeps its plain ask', async () => {
    await setup.runner.start(setup.session, 'please [approve]')
    await until(() => setup.asks.length === 1)
    expect(setup.asks[0]!.from).toBeUndefined()
    expect(setup.asks[0]!.spec.title).toBeUndefined()
    setup.asks[0]!.resolve(ANSWER_ALLOW)
    await until(() => setup.statuses.includes('done'))
  })

  test('stopAgent interrupts the agent and its live descendants, deepest first, and leaves the parent turn open', async () => {
    await runWith({
      turnScript: { hold: true },
      childThreads: [{ id: 'child-1', turnId: 't-1' }, { id: 'child-2', parentThreadId: 'child-1', turnId: 't-2' }, { id: 'other', turnId: 't-3' }]
    })
    await until(() => latestAgent('other') !== undefined)

    await setup.runner.stopAgent!(setup.session.id, 'child-1')

    expect(interrupts()).toEqual([{ threadId: 'child-2', turnId: 't-2' }, { threadId: 'child-1', turnId: 't-1' }])
    expect(latestAgent('child-1')?.state).toBe('stopped')
    expect(latestAgent('child-2')?.state).toBe('stopped')
    expect(latestAgent('other')?.state).toBe('working')
    expect(turnEnds()).toEqual([])

    await setup.runner.stopAgent!(setup.session.id, 'child-1')
    await setup.runner.stopAgent!(setup.session.id, 'nobody')
    expect(interrupts()).toHaveLength(2)
  })

  test('interrupt stops every live child before the parent turn', async () => {
    await runWith({ turnScript: { hold: true }, childThreads: [{ id: 'child-1', turnId: 't-1' }, { id: 'child-2', turnId: 't-2' }] })
    await until(() => latestAgent('child-2') !== undefined)

    await setup.runner.interrupt(setup.session.id)

    expect(interrupts()).toEqual([{ threadId: 'child-1', turnId: 't-1' }, { threadId: 'child-2', turnId: 't-2' }, { threadId: PARENT, turnId: 'turn-1' }])
    expect(latestAgent('child-1')).toMatchObject({ state: 'stopped' })
    expect(latestAgent('child-2')).toMatchObject({ state: 'stopped' })
    expect(latestAgent('child-1')?.cutOff).toBeUndefined()
    expect(turnEnds().map((item) => item.state)).toEqual(['stopped'])
  })

  test('child token usage feeds the agent and the session without touching the parent turn usage', async () => {
    const usage = (total: Record<string, number>) => ({ method: 'thread/tokenUsage/updated', params: { threadId: 'child-1', tokenUsage: { total } } })
    await runWith({
      turnScript: { hold: true },
      childThreads: [
        {
          id: 'child-1',
          notifications: [
            usage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 8, reasoningOutputTokens: 4 }),
            usage({ inputTokens: 130, outputTokens: 30, cachedInputTokens: 18, reasoningOutputTokens: 4 })
          ]
        }
      ]
    })
    await until(() => setup.usage.length === 2)

    expect(setup.usage).toEqual([
      { tokens: { input: 92, output: 24, cacheRead: 8, cacheWrite: 0 } },
      { tokens: { input: 20, output: 10, cacheRead: 10, cacheWrite: 0 } }
    ])
    expect(latestAgent('child-1')?.tokens).toBe(164)
    expect(setup.messages.some((message) => (message.data as { type?: string } | undefined)?.type === 'thread/tokenUsage/updated')).toBe(false)
  })

  test('a notification from a thread with no thread/started goes to the unattributed agent, journaled once before it', async () => {
    const message = (id: string) => ({ method: 'item/completed', params: { threadId: 'ghost', turnId: 'x', item: { id, type: 'agentMessage', text: id } } })
    await runWith({ turnScript: { hold: true }, childThreads: [{ id: 'ghost', announce: false, notifications: [message('m1'), message('m2')] }] })
    await until(() => itemsOf().filter((item) => item.kind === 'prose').length === 2)

    expect(agentSnapshots('unattributed')).toHaveLength(1)
    expect(agentSnapshots('unattributed')[0]).toMatchObject({ name: 'Unattributed', steps: 'full' })
    const order = itemsOf().map((item) => (item.kind === 'agent' ? 'agent' : item.kind))
    expect(order.indexOf('agent')).toBeLessThan(order.indexOf('prose'))
    expect(itemsOf().filter((item) => item.kind === 'prose').map((item) => item.agent)).toEqual(['unattributed', 'unattributed'])
  })

  test('ending the run cuts off agents that are still live', async () => {
    await runWith({ turnScript: { hold: true }, childThreads: [{ id: 'child-1' }, { id: 'child-2', notifications: [spawnCall([], { agentsStates: {} })] }] })
    await until(() => latestAgent('child-2') !== undefined)

    await setup.runner.stop(setup.session.id)

    expect(latestAgent('child-1')).toMatchObject({ state: 'stopped', cutOff: true })
    expect(latestAgent('child-2')).toMatchObject({ state: 'stopped', cutOff: true })
  })

  test('a deny-all session still refuses a child thread', async () => {
    await setup.runner.stop(setup.session.id)
    await setup.processRunner.dispose()
    rmSync(setup.home, { recursive: true, force: true })
    setup = makeSetup({ turnScript: { hold: true }, childThreads: [{ id: 'child-1' }], configRead: { mcpServers: {} } })
    await setup.runner.start(setup.session, 'go', { toolPolicy: 'deny-all' })
    await until(() => setup.messages.some((message) => message.text.includes('tools are disabled')))
    expect(agentSnapshots('child-1')).toEqual([])
  })
})
