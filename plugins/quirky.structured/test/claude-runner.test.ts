import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { FakeQuery } from './fakes/fake-query'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

let messages: StructuredMessage[]
let statuses: SessionStatus[]
let asks: { spec: AskSpec; sessionId: string; resolve: (envelope: AskEnvelope) => void }[]
let queries: FakeQuery[]
let providerSessions: { sessionId: string; id: string; transcriptPath?: string | null }[]
let runner: StructuredRunner
let session: Session

function makeContext(): StructuredContext {
  return {
    process: {
      spawn() {
        throw new Error('Claude runner must not spawn a process')
      }
    },
    appendMessage(msg: NewStructuredMessage) {
      const stored = { ...msg, seq: messages.length + 1, at: msg.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus(_id, status) {
      statuses.push(status)
    },
    async cancelAsk() {},
    createAsk(spec, sessionId) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      asks.push({ spec, sessionId, resolve })
      return promise
    },
    async setProviderSession(sessionId, providerSession) {
      providerSessions.push({
        sessionId,
        id: providerSession.id,
        transcriptPath: providerSession.transcriptPath
      })
    },
    resolveClaudePath: async () => '/usr/local/bin/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async () => '/not-used/pi'
  }
}

function envelope(status: Exclude<AskEnvelope['status'], 'unavailable'>, decision?: string, reason?: string): AskEnvelope {
  return {
    status,
    askId: 'a_1',
    answers: decision
      ? {
          decision: { value: decision, source: 'option' },
          ...(reason ? { reason: { value: reason, source: 'input' as const } } : {})
        }
      : {},
    skipped: decision ? (reason ? [] : ['reason']) : ['decision'],
    summary: ''
  }
}

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: 'c1'
})

beforeEach(() => {
  messages = []
  statuses = []
  asks = []
  queries = []
  providerSessions = []
  session = {
    id: 's_1',
    kind: 'structured',
    agent: 'claude',
    worktreeId: 'wt_1',
    cwd: '/work/tree',
    title: 'Claude',
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
  runner = createClaudeRunner(makeContext(), {
    query: (params: ClaudeQueryParams) => {
      const query = new FakeQuery(params)
      queries.push(query)
      return query
    }
  })
})

async function begin(prompt = 'hello') {
  await runner.start(session, prompt)
  return queries[0]
}

describe('configure', () => {
  test('plan mode, model and effort reach the running query', async () => {
    const query = await begin()
    const result = await runner.configure!(session.id, { planMode: true, model: 'opus', effort: 'high' })
    expect(query.permissionModes).toEqual(['plan'])
    expect(query.models).toEqual(['opus'])
    expect(query.flagSettings).toEqual([{ effortLevel: 'high' }])
    expect(result).toMatchObject({ model: 'opus', effort: 'high', planMode: true })
  })

  test('turning plan mode off restores the picked permission mode', async () => {
    const query = await begin()
    await runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    await runner.configure!(session.id, { planMode: true })
    await runner.configure!(session.id, { planMode: false })
    expect(query.permissionModes).toEqual(['acceptEdits', 'plan', 'acceptEdits'])
  })

  test('overlapping configure calls apply in order and report what the SDK was last told', async () => {
    const query = await begin()
    query.permissionModeDelayMs = (mode) => (mode === 'plan' ? 40 : 0)
    const first = runner.configure!(session.id, { planMode: true })
    const second = runner.configure!(session.id, { permissionMode: 'acceptEdits', planMode: false })
    const [, last] = await Promise.all([first, second])
    expect(query.permissionModes).toEqual(['plan', 'acceptEdits'])
    expect(last).toMatchObject({ permissionMode: 'acceptEdits', planMode: false })
  })

  test('a session that is not running refuses', async () => {
    await expect(runner.configure!('s_none', { planMode: true })).rejects.toThrow('session is not running')
  })
})

describe('start', () => {
  test('runs the query with the worktree and resolved executable', async () => {
    const query = await begin()
    expect(query.params.options?.cwd).toBe('/work/tree')
    expect(query.params.options?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(typeof query.params.options?.canUseTool).toBe('function')
    await until(() => query.written.length === 1)
    expect(query.written[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello' } })
  })

  test('a model and effort pick reaches the query options', async () => {
    await runner.start(session, 'hello', { model: 'opus', effort: 'high' })
    expect(queries[0].params.options?.model).toBe('opus')
    expect(queries[0].params.options?.effort).toBe('high')

  })

  test('persists its native ID after SDK init and resumes with the known ID', async () => {
    await runner.start(session, 'first prompt')
    expect(providerSessions).toEqual([])

    const freshInit = { type: 'system', subtype: 'init', session_id: 'fresh-native-id' }
    const nativeSessionId = freshInit.session_id
    queries[0].emit(freshInit)
    await until(() => providerSessions.length === 1)
    expect(providerSessions).toEqual([{ sessionId: 's_1', id: nativeSessionId, transcriptPath: null }])

    const resumedSession = {
      ...session,
      id: 's_2',
      providerSession: { id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    }
    const resumedInit = { type: 'system', subtype: 'init', session_id: nativeSessionId }
    await runner.start(resumedSession, undefined, {
      model: 'sonnet',
      providerSession: { id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    })
    expect(queries[1].params.options?.resume).toBe(nativeSessionId)
    expect(queries[1].params.options).not.toHaveProperty('sessionId')
    expect(queries[1].params.options?.model).toBe('sonnet')
    queries[1].emit(resumedInit)
    await until(() => messages.some((message) => message.data === resumedInit))
    expect(providerSessions).toEqual([
      { sessionId: 's_1', id: nativeSessionId, transcriptPath: null },
      { sessionId: 's_2', id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    ])
    await runner.send('s_2', 'continue later')
    await until(() => queries[1].written.length === 1)
    expect(queries[1].written[0]?.session_id).toBe(nativeSessionId)
    expect(queries[1].written[0]?.message).toEqual({ role: 'user', content: 'continue later' })
  })

  test('opens a native session without submitting an initial model turn', async () => {
    await runner.start(session, undefined)
    expect(providerSessions).toEqual([])
    expect(messages).toEqual([])
    expect(statuses).toEqual(['running'])

    const nativeInit = { type: 'system', subtype: 'init', session_id: 'idle-native-id' }
    queries[0].emit(nativeInit)
    await until(() => providerSessions.length === 1)
    expect(providerSessions).toEqual([{ sessionId: session.id, id: 'idle-native-id', transcriptPath: null }])

    await runner.send(session.id, 'first turn after native init')
    await until(() => queries[0]?.written.length === 1)
    expect(queries[0]?.written[0]?.session_id).toBe('idle-native-id')
    expect(queries[0]?.written[0]?.message).toEqual({
      role: 'user',
      content: 'first turn after native init'
    })
  })


  test('passes the prepared account environment to Claude Code', async () => {
    await runner.start(session, 'hello', { env: { CLAUDE_CONFIG_DIR: '/managed/claude' } })

    expect(queries[0]?.params.options?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/managed/claude' })
  })

  test('journals the prompt, sets working and returns before the session ends', async () => {
    await begin('do it')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ sessionId: 's_1', role: 'user', text: 'do it' })
    expect(statuses).toEqual(['working'])
  })

  test('a stop that arrives while the claude path is resolving prevents the query from starting', async () => {
    let release: (path: string) => void = () => {}
    const resolving = new Promise<string>((resolve) => {
      release = resolve
    })
    const slow = createClaudeRunner(
      { ...makeContext(), resolveClaudePath: () => resolving },
      {
        query: (params: ClaudeQueryParams) => {
          const query = new FakeQuery(params)
          queries.push(query)
          return query
        }
      }
    )
    const starting = slow.start(session, 'hello')
    await tick()
    await slow.stop(session.id)
    release('/usr/local/bin/claude')
    await starting
    await tick()
    expect(queries).toHaveLength(0)
    expect(messages).toHaveLength(0)
    expect(statuses).not.toContain('working')
    await expect(slow.send(session.id, 'late')).rejects.toThrow()
  })

  test('rejects agents other than claude', async () => {
    await expect(runner.start({ ...session, agent: 'codex' }, 'x')).rejects.toThrow(
      'structured sessions support claude only'
    )
    expect(queries).toHaveLength(0)
  })
})

describe('journaling', () => {
  test('system init, assistant text, tool use, tool result and result', async () => {
    const query = await begin()
    const init = { type: 'system', subtype: 'init', session_id: 'c1', model: 'm' }
    query.emit(init)
    const toolUse = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }
    const assistant = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }, toolUse] },
      session_id: 'c1'
    }
    query.emit(assistant)
    const toolResult = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
      session_id: 'c1'
    }
    query.emit(toolResult)
    const result = {
      type: 'result',
      subtype: 'success',
      result: 'All done',
      is_error: false,
      total_cost_usd: 0.0123,
      duration_ms: 2100,
      session_id: 'c1'
    }
    query.emit(result)
    await until(() => messages.length === 6)

    expect(messages.slice(1).map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'result'])
    expect(messages[1].data).toEqual(init)
    expect(messages[2]).toMatchObject({ text: 'Hi there', data: assistant })
    expect(messages[3]).toMatchObject({ text: 'Bash: ls -la', data: toolUse })
    expect(messages[4].text).toContain('file.txt')
    expect(messages[4].data).toEqual(toolResult)
    expect(messages[5].text).toContain('All done')
    expect(messages[5].text).toContain('$0.0123')
    expect(messages[5].text).toContain('2.1s')
    expect(messages[5].data).toEqual(result)
  })

  test('result without cost or duration is just the summary', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'success', result: 'Fine', is_error: false })
    await until(() => messages.length === 2)
    expect(messages[1]).toMatchObject({ role: 'result', text: 'Fine' })
  })

  test('error results report their subtype and errors', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too long'] })
    await until(() => messages.length === 2)
    expect(messages[1].role).toBe('result')
    expect(messages[1].text).toContain('error_max_turns')
    expect(messages[1].text).toContain('too long')
  })
})

describe('status', () => {
  test('working while a turn runs, done on result, working again on send', async () => {
    const query = await begin()
    query.emit(assistantText('x'))
    query.emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    expect(statuses).toEqual(['working', 'done'])
    await runner.send('s_1', 'more')
    expect(statuses).toEqual(['working', 'done', 'working'])
  })


  test('failed results journal the error, tear down the query, and exit without publishing done', async () => {
    const query = await begin()
    const failure = { type: 'result', subtype: 'error_api_error', result: 'provider failed', is_error: true }
    query.emit(failure)
    await until(() => statuses.includes('exited'))
    expect(messages.at(-1)).toMatchObject({ role: 'result', text: 'provider failed', data: failure })
    await until(() => query.closed > 0)
    expect(query.closed).toBeGreaterThan(0)
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send('s_1', 'after failure')).rejects.toThrow()
  })

  test('exited when the query ends', async () => {
    const query = await begin()
    query.end()
    await until(() => statuses.includes('exited'))
    expect(statuses.at(-1)).toBe('exited')
  })

  test('exited with a system message when the query throws', async () => {
    const query = await begin()
    query.fail(new Error('claude crashed'))
    await until(() => statuses.includes('exited'))
    const last = messages.at(-1)!
    expect(last.role).toBe('system')
    expect(last.text).toContain('claude crashed')
  })
})

describe('canUseTool', () => {
  const canUse = (query: FakeQuery, tool = 'Bash', input: Record<string, unknown> = { command: 'ls' }) =>
    (query.params.options!.canUseTool as any)(tool, input, { signal: new AbortController().signal, toolUseID: 'tu' })

  test('AskUserQuestion returns a typed answer under the original question key, not an allow/deny tool choice', async () => {
    const query = await begin()
    const input = { questions: [{ question: 'Choose a destination', options: [{ label: 'Local' }, { label: 'Remote' }] }] }
    const pending = canUse(query, 'AskUserQuestion', input)
    await until(() => asks.length === 1)
    expect(asks[0].spec.questions[0]).toMatchObject({ id: 'q1', question: 'Choose a destination', type: 'select' })
    asks[0].resolve({ status: 'answered', askId: 'ask_native', answers: { q1: { value: 'o2', label: 'Remote', source: 'option' } }, skipped: [], summary: 'Remote' })
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Choose a destination': 'Remote' } } })
  })

  test('a secret native question never creates an Ask or a session-wide permission rule', async () => {
    const query = await begin()
    expect(await canUse(query, 'AskUserQuestion', { questions: [{ question: 'Which account?', isSecret: true }] })).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
    expect(asks).toEqual([])
  })

  test('asks one select question and allows with the original input', async () => {
    const query = await begin()
    const input = { command: 'rm -rf\n  build' }
    const pending = canUse(query, 'Bash', input)
    await until(() => asks.length === 1)
    expect(asks[0].sessionId).toBe('s_1')
    const [question] = asks[0].spec.questions
    expect(question).toMatchObject({ id: 'decision', type: 'select' })
    expect(question.question).toContain('Bash')
    expect(question.question).toContain('rm -rf build')
    expect(question.question).not.toContain('\n')
    expect((question as any).options.map((o: any) => o.value)).toEqual(['allow', 'always', 'deny'])
    expect(statuses.at(-1)).toBe('waiting')
    asks[0].resolve(envelope('answered', 'allow'))
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: input })
    expect(statuses.at(-1)).toBe('working')
  })

  test('deny', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'deny'))
    expect(await pending).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
  })

  test('the ask offers the three decisions with their labels and an optional reason', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    const [decision, reason] = asks[0].spec.questions as any[]
    expect(decision.options).toEqual([
      { value: 'allow', label: 'Allow once' },
      { value: 'always', label: 'Allow for this session' },
      { value: 'deny', label: 'Deny' }
    ])
    expect(reason).toEqual({ id: 'reason', type: 'text', question: 'Reason, if you deny', required: false })
    asks[0].resolve(envelope('answered', 'allow'))
    await pending
  })

  test('a deny reason becomes the denial message', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'deny', 'use the staging db'))
    expect(await pending).toEqual({ behavior: 'deny', message: 'use the staging db' })
  })

  test('a reason typed with an allow is ignored', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'allow', 'whatever'))
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('always allows and adds a session rule for the tool', async () => {
    const query = await begin()
    const pending = canUse(query, 'Edit', { file_path: '/a' })
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'always'))
    expect(await pending).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/a' },
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }
      ]
    })
  })

  test('declined and timed out asks deny', async () => {
    const query = await begin()
    for (const status of ['declined', 'timed_out'] as const) {
      const pending = canUse(query)
      await until(() => asks.length === (status === 'declined' ? 1 : 2))
      asks.at(-1)!.resolve(envelope(status))
      expect(await pending).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
    }
  })
})

describe('send', () => {
  test('pushes a user turn, journals it and sets working', async () => {
    const query = await begin()
    await runner.send('s_1', 'next please')
    await until(() => query.written.length === 2)
    expect(query.written[1]).toMatchObject({ type: 'user', message: { role: 'user', content: 'next please' } })
    expect(messages.at(-1)).toMatchObject({ role: 'user', text: 'next please' })
    expect(statuses.at(-1)).toBe('working')
  })

  test('throws for an unknown session', async () => {
    await expect(runner.send('s_nope', 'x')).rejects.toThrow()
  })

  test('throws once the session has been stopped', async () => {
    await begin()
    await runner.stop('s_1')
    await expect(runner.send('s_1', 'x')).rejects.toThrow()
  })

  test('throws once the query has ended', async () => {
    const query = await begin()
    query.end()
    await until(() => statuses.includes('exited'))
    await expect(runner.send('s_1', 'x')).rejects.toThrow()
  })
})

describe('stop', () => {
  test('interrupts, closes and sets exited once', async () => {
    const query = await begin()
    await runner.stop('s_1')
    expect(query.interrupted).toBe(1)
    expect(query.closed).toBe(1)
    await tick()
    expect(statuses.filter((s) => s === 'exited')).toHaveLength(1)
    expect(statuses.at(-1)).toBe('exited')
  })

  test('is a no-op for an unknown session', async () => {
    await runner.stop('s_nope')
    expect(statuses).toEqual([])
  })
})

describe('chat items', () => {
  const run = async (query: FakeQuery, ...events: any[]) => {
    for (const event of events) query.emit(event)
  }
  const items = () => messages.map((m) => m.item)

  test('every journaled message carries an item', async () => {
    const query = await begin('do it')
    await run(
      query,
      { type: 'system', subtype: 'init', session_id: 'c1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      { type: 'weird' },
      { type: 'result', subtype: 'success', result: 'ok', is_error: false, duration_ms: 5 }
    )
    await until(() => messages.length === 7)
    expect(items().every((item) => item !== undefined)).toBe(true)
    expect(items().map((item) => item!.kind)).toEqual(['user', 'status', 'prose', 'activity', 'activity', 'status', 'turn-end'])
    expect(items()[3]).toMatchObject({ callId: 't1', state: 'running' })
    expect(items()[4]).toMatchObject({ callId: 't1', state: 'done' })
    expect(items()[6]).toEqual({ kind: 'turn-end', state: 'done', durationMs: 5 })
  })

  test('sent messages carry their images and queue id', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-img-'))
    const image = join(dir, 'a.png')
    writeFileSync(image, 'PNG')
    await runner.send('s_1', 'look', { images: [image], queuedId: 'q-1' })
    expect(messages.at(-1)!.item).toEqual({ kind: 'user', text: 'look', images: [image], queuedId: 'q-1' })
    await until(() => query.written.length === 2)
    expect(query.written[1].message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test('an image sent with no text goes out as the image alone, without an empty text block', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-img-'))
    const image = join(dir, 'a.png')
    writeFileSync(image, 'PNG')
    await runner.send('s_1', '', { images: [image] })
    await until(() => query.written.length === 2)
    expect(query.written[1].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test('an image path that became a FIFO is refused without blocking', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-fifo-'))
    const fifo = join(dir, 'a.png')
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    const outcome = await Promise.race([
      runner.send('s_1', 'look', { images: [fifo] }).then(
        () => 'sent',
        (error: Error) => error.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000))
    ])
    expect(outcome).toContain('is not a regular file')
    expect(messages.filter((m) => m.item?.kind === 'user')).toHaveLength(1)
    expect(query.written).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('stopping mid-turn closes running calls as stopped, then ends the turn as stopped', async () => {
    const query = await begin()
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } }] } })
    await until(() => messages.length === 3)
    await runner.stop('s_1')
    expect(items().slice(3).map((item) => item && [item.kind, (item as any).callId, (item as any).state])).toEqual([
      ['activity', 't1', 'stopped'],
      ['file-change', 't2', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
  })

  test('stopping a turn sent before the earlier turn finished closes its calls and ends it as stopped', async () => {
    const query = await begin('first')
    await runner.send('s_1', 'second')
    await run(query, { type: 'result', subtype: 'success', result: 'first done', is_error: false })
    await until(() => items().some((item) => item?.kind === 'turn-end'))
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/a' } }] } })
    await until(() => items().some((item) => (item as any)?.callId === 't9'))
    await runner.stop('s_1')
    const tail = items().slice(-2).map((item) => item && [item.kind, (item as any).callId, (item as any).state])
    expect(tail).toEqual([
      ['activity', 't9', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
  })

  test('a result for the last open turn leaves nothing to stop', async () => {
    const query = await begin('first')
    await runner.send('s_1', 'second')
    await run(query, { type: 'result', subtype: 'success', result: 'one', is_error: false })
    await run(query, { type: 'result', subtype: 'success', result: 'two', is_error: false })
    await until(() => items().filter((item) => item?.kind === 'turn-end').length === 2)
    const before = messages.length
    await runner.stop('s_1')
    expect(messages).toHaveLength(before)
  })

  test('stopping an idle session adds no turn-end', async () => {
    const query = await begin()
    await run(query, { type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    const before = messages.length
    await runner.stop('s_1')
    expect(messages).toHaveLength(before)
  })

  test('a crash mid-turn ends the turn as failed and journals an error item', async () => {
    const query = await begin()
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } })
    await until(() => messages.length === 2)
    query.fail(new Error('claude crashed'))
    await until(() => statuses.includes('exited'))
    expect(items().slice(2).map((item) => item!.kind)).toEqual(['activity', 'turn-end', 'error'])
    expect(items().at(-1)).toEqual({ kind: 'error', reason: 'exited', stderrTail: ['claude crashed'], resumable: false })
  })

  test('partial-message deltas stream as throttled prose, and the final message supersedes them', async () => {
    const query = await begin()
    expect(query.params.options?.includePartialMessages).toBe(true)
    const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
    await run(query, delta('Hel'), { type: 'stream_event', event: { type: 'message_start' } })
    await tick()
    expect(messages.filter((m) => m.item?.kind === 'prose')).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 280))
    await run(query, delta('lo'))
    await tick()
    const streaming = messages.filter((m) => m.item?.kind === 'prose')
    expect(streaming).toHaveLength(1)
    expect(streaming[0]).toMatchObject({ role: 'system', item: { kind: 'prose', text: 'Hello', streaming: true } })
    await run(query, assistantText('Hello'))
    await until(() => messages.some((m) => m.role === 'assistant'))
    expect(messages.at(-1)!.item).toEqual({ kind: 'prose', text: 'Hello' })
  })
})

describe('interrupt', () => {
  const emit = async (query: FakeQuery, ...events: any[]) => {
    for (const event of events) query.emit(event)
    await tick()
  }
  const items = () => messages.map((m) => m.item) as any[]

  test('mid-turn it stops running calls, ends the turn as stopped and leaves the session able to send', async () => {
    const query = await begin()
    await emit(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }] } })
    await until(() => messages.length === 2)
    await runner.interrupt('s_1')
    expect(items().slice(2).map((item) => [item.kind, item.callId, item.state])).toEqual([
      ['activity', 't1', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
    expect(query.interrupted).toBe(1)
    expect(query.closed).toBe(0)
    expect(statuses.at(-1)).toBe('done')
    expect(statuses).not.toContain('exited')
    await emit(query, { type: 'result', subtype: 'error_during_execution', is_error: true })
    expect(statuses).not.toContain('exited')
    await runner.send('s_1', 'again')
    expect(statuses.at(-1)).toBe('working')
    expect(query.written.at(-1).message.content).toBeDefined()
  })

  test('echoes of the interrupt after the turn closed journal nothing', async () => {
    const query = await begin()
    await emit(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a/bye.txt', content: 'x' } }] } })
    await until(() => messages.length === 2)
    await runner.interrupt('s_1')
    const before = messages.length
    await emit(
      query,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'The user doesn\'t want to proceed' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true }
    )
    expect(messages).toHaveLength(before)
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'stopped'])
    expect(items().filter((item) => item.kind === 'turn-end')).toHaveLength(1)
    expect(items().some((item) => item.kind === 'user' && item.text.startsWith('[Request interrupted'))).toBe(false)
  })

  test('a second final for an already closed call emits nothing', async () => {
    const query = await begin()
    await emit(
      query,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'late' }] } }
    )
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'done'])
  })

  test('a live tool result still closes its call as failed', async () => {
    const query = await begin()
    await emit(
      query,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'nope' }] } }
    )
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'failed'])
  })

  test('with no open turn it does nothing', async () => {
    const query = await begin()
    await emit(query, { type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    const before = messages.length
    const status = statuses.length
    await runner.interrupt('s_1')
    expect(messages).toHaveLength(before)
    expect(statuses).toHaveLength(status)
    expect(query.interrupted).toBe(0)
  })

  test('an interrupt the agent ignores falls back to a full stop', async () => {
    const query = await begin()
    query.hangInterrupt = true
    await runner.interrupt('s_1')
    expect(query.closed).toBe(1)
    expect(statuses.at(-1)).toBe('exited')
    expect(items().at(-1).state).toBe('stopped')
  })

  test('a pending approval resolving after the interrupt does not flip the session back to working', async () => {
    const query = await begin()
    const options = query.params.options as any
    const decision = options.canUseTool('Bash', { command: 'ls' })
    await until(() => asks.length === 1)
    await runner.interrupt('s_1')
    asks[0]!.resolve(envelope('declined'))
    await decision
    expect(statuses.at(-1)).toBe('done')
  })
})
