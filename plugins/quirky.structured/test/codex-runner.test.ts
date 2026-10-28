import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createCodexRunner } from '../codex-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment, type CodexAppServerFixture } from './fakes/codex-app-server'

async function until(check: () => boolean) {
  // The child has a real OS event loop; fake timers cannot advance its JSONL I/O.
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

type AskWaiter = { spec: AskSpec; sessionId: string; resolve: (answer: AskEnvelope) => void }
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
}

let setup: Setup

function makeSetup(): Setup {
  const home = mkdtempSync(join(tmpdir(), 'codex-runner-'))
  const fixture = createCodexAppServerFixture(home)
  const messages: StructuredMessage[] = []
  const statuses: SessionStatus[] = []
  const asks: AskWaiter[] = []
  const storedProviderSessions: Setup['storedProviderSessions'] = []
  const context: StructuredContext = {
    appendMessage(message: NewStructuredMessage) {
      const stored: StructuredMessage = {
        sessionId: message.sessionId,
        seq: messages.length + 1,
        role: message.role,
        text: message.text,
        at: message.at ?? Date.now(),
        ...(message.data === undefined ? {} : { data: message.data })
      }
      messages.push(stored)
      return stored
    },
    setStatus(_sessionId, status) {
      statuses.push(status)
    },
    createAsk(spec, sessionId) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      asks.push({ spec, sessionId, resolve })
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
    resolveCodexPath: async () => fixture.executable
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
  return { home, fixture, messages, statuses, asks, storedProviderSessions, runner, session, context }
}

beforeEach(() => {
  setup = makeSetup()
})

afterEach(async () => {
  await setup.runner.stop(setup.session.id)
  rmSync(setup.home, { recursive: true, force: true })
})

describe('Codex app-server runner', () => {
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

  test('initializes before starting a thread and turn, persisting its provider ID first', async () => {
    await setup.runner.start(setup.session, 'summarize', { model: 'gpt-5.5', effort: 'high' })
    await until(() => setup.statuses.includes('done'))

    const calls = setup.fixture.requests()
    expect(calls.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(calls[2].params).toMatchObject({
      cwd: setup.home,
      model: 'gpt-5.5'
    })
    expect(calls[3].params).toEqual({
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
  test('starts a native thread without an initial turn until the caller is attached', async () => {
    await setup.runner.start(setup.session, undefined)
    expect(setup.fixture.requests().map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start'
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

  test('resumes an existing thread without a prompt and sends a later turn on it', async () => {
    const resumed = { ...setup.session, providerSession: { id: 'persisted-thread', transcriptPath: null } }
    await setup.runner.start(resumed, undefined, { providerSession: { id: 'persisted-thread', transcriptPath: null } })
    expect(setup.fixture.requests().map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/resume'])
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

})
