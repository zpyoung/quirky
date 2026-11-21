import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCommand, AskEnvelope, AskSpec, ChatItem, ProcessSpawner, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createProcessRunner } from '../../../packages/process/src/api'
import { PiRpc, piLaunchArgs, spawnPiTransport, type PiVariant } from '../pi-rpc'
import { createPiRunner } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext } from '../runner'
import { fakePiTransports, type FakePiTransport, type Reply } from './fakes/pi-transport'

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

type AskWaiter = { spec: AskSpec; sessionId: string; options?: { nativeQuestion?: boolean; onAsk?: (askId: string) => void }; resolve(envelope: AskEnvelope): void }

const noSpawn: ProcessSpawner = {
  spawn() {
    throw new Error('the scripted transport must not spawn a process')
  }
}

function makeSetup(variant: PiVariant, replies?: Record<string, () => Reply>) {
  const messages: StructuredMessage[] = []
  const statuses: SessionStatus[] = []
  const asks: AskWaiter[] = []
  const providerSessions: { sessionId: string; id: string; transcriptPath?: string | null }[] = []
  const resolved: PiVariant[] = []
  const cancelledAsks: string[] = []
  const reported: AgentCommand[][] = []
  const usage: Parameters<NonNullable<StructuredContext['reportUsage']>>[1][] = []
  const summaries = { mode: 'ai' as 'ai' | 'latest-tool' }
  const context: StructuredContext = {
    process: noSpawn,
    reportCommands: (_id, commands) => void reported.push(commands),
    reportUsage: (_id, report) => void usage.push(report),
    agentSummaries: () => summaries.mode,
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
    setStatus: (_id, status) => void statuses.push(status),
    createAsk(spec, sessionId, options) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      asks.push({ spec, sessionId, ...(options === undefined ? {} : { options }), resolve })
      return promise
    },
    async cancelAsk(askId) {
      cancelledAsks.push(askId)
    },
    async setProviderSession(sessionId, providerSession) {
      providerSessions.push({ sessionId, id: providerSession.id, transcriptPath: providerSession.transcriptPath })
    },
    resolveClaudePath: async () => '/not-used/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async (requested) => {
      resolved.push(requested)
      return `/fake/bin/${requested}`
    }
  }
  const session: Session = {
    id: `s_${variant}`,
    kind: 'structured',
    agent: variant,
    worktreeId: 'wt_1',
    cwd: '/fake/worktree',
    title: variant,
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
  const fake = fakePiTransports(replies === undefined ? {} : { replies })
  const runner = createPiRunner(context, variant, { transport: fake.factory, env: { BASE: 'kept', DROP: 'gone' } })
  const items = (): ChatItem[] => messages.flatMap((message) => (message.item ? [message.item] : []))
  const ofKind = <K extends ChatItem['kind']>(kind: K) => items().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
  const settle = (transport: FakePiTransport) =>
    variant === 'pi' ? transport.emit({ type: 'agent_settled' }) : transport.emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
  const answered = (askId: string, answers: AskEnvelope['answers']): AskEnvelope => ({ status: 'answered', askId, answers, skipped: [], summary: '' })
  return { messages, statuses, asks, providerSessions, resolved, cancelledAsks, reported, usage, summaries, context, session, fake, runner, items, ofKind, settle, answered }
}

type Setup = ReturnType<typeof makeSetup>

for (const variant of ['pi', 'omp'] as const) {
  describe(`${variant} structured runner`, () => {
    let setup: Setup
    const begin = async (prompt: string | null = 'hello', options: Parameters<Setup['runner']['start']>[2] = {}) => {
      setup = makeSetup(variant)
      await setup.runner.start(setup.session, prompt ?? undefined, options)
      return setup.fake.last()
    }
    afterEach(async () => {
      await setup?.runner.stop(setup.session.id)
    })

    test('start resolves the executable, passes picks and env, stores the provider session and sends the first prompt', async () => {
      const transport = await begin('hello', { model: 'anthropic/sonnet', effort: 'high', env: { QUIRKY_SESSION_TOKEN: 'tok', DROP: null } })
      expect(setup.resolved).toEqual([variant])
      expect(transport.spec.executable).toBe(`/fake/bin/${variant}`)
      expect(transport.spec.cwd).toBe('/fake/worktree')
      expect(transport.spec.args).toEqual(['--mode', 'rpc', '--model', 'anthropic/sonnet', '--thinking', 'high'])
      expect(transport.spec.env).toMatchObject({ BASE: 'kept', QUIRKY_SESSION_TOKEN: 'tok' })
      expect(transport.spec.env.DROP).toBeUndefined()
      expect(setup.providerSessions).toEqual([{ sessionId: setup.session.id, id: 'pi-sess-1', transcriptPath: '/fake/pi-sess-1.jsonl' }])
      expect(transport.commands('prompt')).toMatchObject([{ message: 'hello' }])
      expect(setup.ofKind('user')).toEqual([{ kind: 'user', text: 'hello' }])
      expect(setup.statuses.at(-1)).toBe('working')
      expect(transport.commands('set_ask_dialog').length).toBe(variant === 'omp' ? 1 : 0)
    })

    test('appended instructions reach the launch as --append-system-prompt, on start, resume and an omp relaunch', async () => {
      const text = 'draw visuals\n[quirky visual level: off]'
      expect((await begin('hello', { appendInstructions: text })).spec.args).toEqual(['--mode', 'rpc', '--append-system-prompt', text])
      await setup.runner.stop(setup.session.id)

      setup = makeSetup(variant)
      await setup.runner.start(setup.session, undefined, {
        appendInstructions: text,
        providerSession: { id: 'pi-sess-1', transcriptPath: null }
      })
      expect(setup.fake.last().spec.args).toEqual([
        '--mode',
        'rpc',
        variant === 'pi' ? '--session' : '--resume',
        'pi-sess-1',
        '--append-system-prompt',
        text
      ])
    })

    test('start without a prompt leaves the session running and sends nothing', async () => {
      const transport = await begin(null)
      expect(transport.commands('prompt')).toEqual([])
      expect(setup.statuses.at(-1)).toBe('running')
    })

    test('resume passes the saved session to the agent and refuses a different session', async () => {
      setup = makeSetup(variant)
      await setup.runner.start(setup.session, undefined, { providerSession: { id: 'pi-sess-1', transcriptPath: null } })
      expect(setup.fake.last().spec.args).toEqual(['--mode', 'rpc', variant === 'pi' ? '--session' : '--resume', 'pi-sess-1'])
      await setup.runner.stop(setup.session.id)

      setup = makeSetup(variant)
      await expect(setup.runner.start(setup.session, undefined, { providerSession: { id: 'someone-else', transcriptPath: null } })).rejects.toThrow('expected someone-else')
      expect(setup.fake.last().closed).toBe(true)
    })

    test('streamed text journals throttled partials and one final prose item, then the turn ends', async () => {
      const transport = await begin()
      let now = 1_000
      const clock = spyOn(Date, 'now').mockImplementation(() => now)
      try {
        transport.emit({ type: 'agent_start' })
        transport.emit({ type: 'message_update', messageId: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } })
        now += 300
        transport.emit({ type: 'message_update', messageId: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'wor' } })
        now += 10
        transport.emit({ type: 'message_update', messageId: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'ld' } })
      } finally {
        clock.mockRestore()
      }
      transport.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Hello world' }] } })
      expect(setup.messages.filter((m) => m.item?.kind === 'prose').map((m) => [m.role, m.item])).toEqual([
        ['system', { kind: 'prose', text: 'Hello wor', streaming: true }],
        ['assistant', { kind: 'prose', text: 'Hello world' }]
      ])
      setup.settle(transport)
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'done' }])
      expect(setup.statuses.at(-1)).toBe('done')
    })

    test('a provider error marks the turn failed', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'No API key' } })
      setup.settle(transport)
      expect(setup.ofKind('status').map((item) => item.text)).toContain('No API key')
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'failed' }])
    })

    test('a tool call journals a running item and a closing item with the same callId', async () => {
      const transport = await begin()
      transport.emit(
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'bun test plugins/x' } },
        { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b\nc' }] } },
        { type: 'tool_execution_start', toolCallId: 'c3', toolName: 'read', args: { path: 'a.ts' } }
      )
      expect(setup.items().map((item) => [item.kind, (item as { state?: string }).state])).toEqual([
        ['user', undefined],
        ['tests', 'running'],
        ['file-change', 'running'],
        ['activity', 'running']
      ])
      transport.emit(
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: '3 pass\n1 fail' }] } },
        { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'edit', isError: false, result: { content: [], details: { diff: '+1 b\n+2 c\n-1 a\n 3 ctx' } } },
        { type: 'tool_execution_end', toolCallId: 'c3', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'ENOENT' }] } }
      )
      const calls = setup.items().filter((item) => 'callId' in item)
      expect(calls.slice(3)).toMatchObject([
        { kind: 'tests', callId: 'c1', command: 'bun test plugins/x', passed: 3, failed: 1, state: 'done' },
        { kind: 'file-change', callId: 'c2', path: 'a.ts', added: 2, removed: 1, state: 'done' },
        { kind: 'activity', callId: 'c3', tool: 'read', summary: 'a.ts', state: 'failed', detail: 'ENOENT' }
      ])
    })

    test('the todo tool journals steps, and a call still open when the turn settles is closed', async () => {
      const transport = await begin()
      transport.emit(
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'todo', args: { op: 'init' } },
        {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'todo',
          isError: false,
          result: { content: [], details: { phases: [{ name: 'Tasks', tasks: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'three', status: 'pending' }] }] } }
        },
        { type: 'tool_execution_start', toolCallId: 'c9', toolName: 'grep', args: { pattern: 'x' } }
      )
      expect(setup.ofKind('steps')).toEqual([
        { kind: 'steps', callId: 't1', steps: [{ text: 'one', state: 'done' }, { text: 'two', state: 'active' }, { text: 'three', state: 'pending' }] }
      ])
      setup.settle(transport)
      const closed = setup.ofKind('activity').filter((item) => item.callId === 'c9')
      expect(closed.map((item) => item.state)).toEqual(['running', 'done'])
    })

    test('an approval dialog becomes an approval ask and the allow answer reaches the agent', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run rm -rf?', message: 'This deletes files' })
      await until(() => setup.asks.length === 1)
      expect(setup.asks[0]!.options?.nativeQuestion).toBeUndefined()
      expect(setup.asks[0]!.spec.questions.map((q) => q.id)).toEqual(['decision', 'reason'])
      expect(setup.asks[0]!.spec.questions[0]!.question).toBe('Run rm -rf?: This deletes files')
      expect(setup.statuses.at(-1)).toBe('waiting')
      setup.asks[0]!.resolve(setup.answered('ask_1', { decision: { value: 'always', source: 'option' } }))
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: true })
      expect(setup.statuses.at(-1)).toBe('working')
    })

    test('a denied approval answers the agent and follows up with the reason', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Allow dangerous command?', options: ['Allow', 'Block'] })
      await until(() => setup.asks.length === 1)
      setup.asks[0]!.resolve(setup.answered('ask_2', { decision: { value: 'deny', source: 'option' }, reason: { value: 'too risky', source: 'input' } }))
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toEqual({ type: 'extension_ui_response', id: 'ui-2', value: 'Block' })
      await until(() => transport.commands('steer').length === 1)
      expect(transport.commands('steer')[0]).toMatchObject({ message: 'Denied: too risky' })
    })

    test('a select that is not an approval becomes a question and answers with the chosen label', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-3', method: 'select', title: 'Which branch?', options: ['main', 'dev'] })
      await until(() => setup.asks.length === 1)
      expect(setup.asks[0]!.options?.nativeQuestion).toBe(true)
      setup.asks[0]!.resolve(setup.answered('ask_3', { answer: { value: 'o2', label: 'dev', source: 'option' } }))
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toEqual({ type: 'extension_ui_response', id: 'ui-3', value: 'dev' })
    })

    test('an unanswered or declined question cancels the dialog, and input uses a text question', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-4', method: 'input', title: 'Branch name' })
      await until(() => setup.asks.length === 1)
      expect(setup.asks[0]!.spec.questions[0]).toMatchObject({ type: 'text', multiline: false })
      setup.asks[0]!.resolve({ status: 'declined', askId: 'ask_4', answers: {}, skipped: [], summary: '' })
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toEqual({ type: 'extension_ui_response', id: 'ui-4', cancelled: true })
    })

    test('an omp-style ask frame answers every question in order', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, {
        type: 'extension_ui_request',
        id: 'ui-5',
        method: 'ask',
        questions: [
          { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
          { id: 'features', question: 'Which features?', multi: true, options: [{ label: 'Auth' }, { label: 'Search' }] },
          { id: 'note', question: 'Anything else?', options: [] }
        ]
      })
      await until(() => setup.asks.length === 1)
      setup.asks[0]!.resolve(
        setup.answered('ask_5', {
          db: { value: 'o2', label: 'SQLite', source: 'option' },
          features: { values: ['o1', 'o2'], labels: ['Auth', 'Search'], source: 'options' },
          note: { value: 'no', source: 'input' }
        })
      )
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toEqual({
        type: 'extension_ui_response',
        id: 'ui-5',
        answers: [
          { id: 'db', selectedOptions: ['SQLite'] },
          { id: 'features', selectedOptions: ['Auth', 'Search'] },
          { id: 'note', selectedOptions: [], customInput: 'no' }
        ]
      })
    })

    test('a send while the agent is working steers it, and a send when idle starts a new prompt', async () => {
      const transport = await begin()
      await setup.runner.send(setup.session.id, 'actually do this', { queuedId: 'q1' })
      expect(transport.commands('steer')).toMatchObject([{ message: 'actually do this' }])
      expect(transport.commands('prompt').length).toBe(1)
      expect(setup.ofKind('user').at(-1)).toEqual({ kind: 'user', text: 'actually do this', queuedId: 'q1' })
      setup.settle(transport)
      await setup.runner.send(setup.session.id, 'next')
      expect(transport.commands('prompt')).toMatchObject([{ message: 'hello' }, { message: 'next', streamingBehavior: 'steer' }])
      expect(setup.statuses.at(-1)).toBe('working')
    })

    test('images go to the agent as base64 image content', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-runner-'))
      try {
        const image = join(dir, 'shot.png')
        writeFileSync(image, Buffer.from('png-bytes'))
        const transport = await begin(null)
        await setup.runner.send(setup.session.id, 'look', { images: [image] })
        expect(transport.commands('prompt')[0]).toMatchObject({ message: 'look', images: [{ type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' }] })
        expect(setup.ofKind('user')).toEqual([{ kind: 'user', text: 'look', images: [image] }])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('images that fit one by one but not in one frame are refused clearly and nothing is written', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-runner-'))
      try {
        const first = join(dir, 'a.png')
        const second = join(dir, 'b.png')
        writeFileSync(first, Buffer.alloc(13 * 1024 * 1024))
        writeFileSync(second, Buffer.alloc(13 * 1024 * 1024))
        const transport = await begin(null)
        await expect(setup.runner.send(setup.session.id, 'look', { images: [first, second] })).rejects.toThrow('too large to send together')
        expect(transport.commands('prompt')).toEqual([])
        expect(setup.ofKind('user')).toEqual([])
        expect(setup.ofKind('error')).toHaveLength(1)
        await setup.runner.send(setup.session.id, 'one', { images: [first] })
        expect(transport.commands('prompt')).toHaveLength(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('configure switches the model by provider/id and sets the thinking level, returning what is in force', async () => {
      const transport = await begin(null, { model: 'anthropic/old', effort: 'low' })
      const settings = await setup.runner.configure!(setup.session.id, { model: 'openai/gpt-x', effort: 'high' })
      expect(transport.commands('set_model')).toMatchObject([{ provider: 'openai', modelId: 'gpt-x' }])
      expect(transport.commands('set_thinking_level')).toMatchObject([{ level: 'high' }])
      expect(settings).toEqual({ model: 'openai/gpt-x', effort: 'high' })
    })

    test('overlapping configure calls apply in arrival order', async () => {
      const transport = await begin(null, { model: 'anthropic/old' })
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      transport.replies.set('get_available_models', () => ({ success: true, data: { models: [{ provider: 'a', id: 'solo' }] } }))
      const originalWrite = transport.write.bind(transport)
      transport.write = (frame) => {
        if (frame.type === 'get_available_models') void held.then(() => originalWrite(frame))
        else originalWrite(frame)
      }
      const first = setup.runner.configure!(setup.session.id, { model: 'solo' })
      const second = setup.runner.configure!(setup.session.id, { model: 'openai/gpt-x' })
      await Bun.sleep(5)
      release()
      await first
      expect(await second).toEqual({ model: 'openai/gpt-x' })
      expect(transport.commands('set_model').at(-1)).toMatchObject({ provider: 'openai', modelId: 'gpt-x' })
    })

    test('models lists the available models as provider/id', async () => {
      const transport = await begin(null)
      transport.replies.set('get_available_models', () => ({
        success: true,
        data: { models: [{ provider: 'openai', id: 'gpt-x', name: 'GPT X' }, { provider: 'a', id: 'bare' }, { id: 'orphan' }] }
      }))
      expect(await setup.runner.models!(setup.session.id)).toEqual([
        { id: 'openai/gpt-x', label: 'GPT X (openai)' },
        { id: 'a/bare', label: 'a/bare' }
      ])
    })

    test('configure resolves a bare model id through the available models and rejects an ambiguous one', async () => {
      const transport = await begin(null)
      transport.replies.set('get_available_models', () => ({
        success: true,
        data: { models: [{ provider: 'a', id: 'solo' }, { provider: 'a', id: 'twin' }, { provider: 'b', id: 'twin' }] }
      }))
      expect(await setup.runner.configure!(setup.session.id, { model: 'solo' })).toEqual({ model: 'solo' })
      expect(transport.commands('set_model')).toMatchObject([{ provider: 'a', modelId: 'solo' }])
      await expect(setup.runner.configure!(setup.session.id, { model: 'twin' })).rejects.toThrow('use provider/model')
    })

    test('configure surfaces an agent refusal and keeps the previous settings', async () => {
      const transport = await begin(null, { model: 'anthropic/old' })
      transport.replies.set('set_model', () => ({ success: false, error: 'Model not found: x/y' }))
      await expect(setup.runner.configure!(setup.session.id, { model: 'x/y' })).rejects.toThrow('Model not found')
      transport.replies.set('set_model', () => ({ success: true }))
      expect(await setup.runner.configure!(setup.session.id, { effort: 'medium' })).toEqual({ model: 'anthropic/old', effort: 'medium' })
    })

    test('an image path that is not a regular file is refused before anything is journaled or sent', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-runner-'))
      try {
        const transport = await begin(null)
        await expect(setup.runner.send(setup.session.id, 'look', { images: [dir] })).rejects.toThrow('not a regular file')
        expect(transport.commands('prompt')).toEqual([])
        expect(setup.ofKind('user')).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a prompt the agent handled itself ends the turn at once', async () => {
      setup = makeSetup(variant)
      await setup.runner.start(setup.session, undefined)
      const transport = setup.fake.last()
      transport.replies.set('prompt', () => ({ success: true, data: variant === 'pi' ? { disposition: 'handled' } : { agentInvoked: false } }))
      await setup.runner.send(setup.session.id, '/compact')
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'done' }])
      expect(setup.statuses.at(-1)).toBe('done')
    })

    test('a prompt the agent rejects becomes an error item and a failed turn', async () => {
      setup = makeSetup(variant)
      await setup.runner.start(setup.session, undefined)
      const transport = setup.fake.last()
      transport.replies.set('prompt', () => ({ success: false, error: 'No model selected' }))
      await expect(setup.runner.send(setup.session.id, 'hi')).rejects.toThrow('No model selected')
      expect(setup.ofKind('error')).toEqual([{ kind: 'error', reason: 'protocol', stderrTail: ['No model selected'], resumable: true }])
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'failed' }])
      expect(setup.statuses.at(-1)).toBe('done')
    })

    test('a steer the agent rejects rejects send once and records one error item', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' })
      transport.replies.set('steer', () => ({ success: false, error: 'cannot steer' }))
      await expect(setup.runner.send(setup.session.id, 'more')).rejects.toThrow('cannot steer')
      expect(setup.ofKind('error')).toHaveLength(1)
    })

    test('a transport write failure rejects send so the caller can restore the queued message', async () => {
      const transport = await begin(null)
      transport.failWrites.set('prompt', new Error('pi message exceeds the frame limit'))
      await expect(setup.runner.send(setup.session.id, 'big')).rejects.toThrow('exceeds the frame limit')
      expect(setup.ofKind('error')).toHaveLength(1)
    })

    test('a cancelled dialog settles the wait, sends nothing for it and returns the status to working', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-c', method: 'confirm', title: 'Go?' })
      await until(() => setup.asks.length === 1)
      expect(setup.statuses.at(-1)).toBe('waiting')
      transport.emit({ type: 'extension_ui_request', id: 'ui-x', method: 'cancel', targetId: 'ui-c' })
      await until(() => setup.statuses.at(-1) === 'working')
      setup.asks[0]!.resolve(setup.answered('ask_c', { decision: { value: 'allow', source: 'option' } }))
      await Bun.sleep(10)
      expect(transport.commands('extension_ui_response')).toEqual([])
    })

    test('a cancelled dialog cancels its own ask once', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-c', method: 'confirm', title: 'Go?' })
      await until(() => setup.asks.length === 1)
      setup.asks[0]!.options?.onAsk?.('ask_c')
      transport.emit({ type: 'extension_ui_request', id: 'ui-x', method: 'cancel', targetId: 'ui-c' })
      await until(() => setup.statuses.at(-1) === 'working')
      transport.emit({ type: 'extension_ui_request', id: 'ui-y', method: 'cancel', targetId: 'ui-c' })
      await Bun.sleep(10)
      expect(setup.cancelledAsks).toEqual(['ask_c'])
      expect(transport.commands('extension_ui_response')).toEqual([])
    })

    test('an exit while the provider session is being stored fails the start and closes the child', async () => {
      setup = makeSetup(variant)
      const context: StructuredContext = {
        ...setup.context,
        setProviderSession: async () => {
          setup.fake.last().exit(1, ['died early'])
        }
      }
      const runner = createPiRunner(context, variant, { transport: setup.fake.factory })
      await expect(runner.start(setup.session, 'hello')).rejects.toThrow('died early')
      expect(setup.fake.last().commands('prompt')).toEqual([])
      await expect(runner.send(setup.session.id, 'again')).rejects.toThrow('not running')
    })

    test('stop aborts, closes the child, stops open calls and ends the turn as stopped', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 99' } })
      await setup.runner.stop(setup.session.id)
      expect(transport.commands('abort').length).toBe(1)
      expect(transport.closed).toBe(true)
      expect(setup.ofKind('activity').map((item) => item.state)).toEqual(['running', 'stopped'])
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'stopped' }])
      expect(setup.statuses.at(-1)).toBe('exited')
      await expect(setup.runner.send(setup.session.id, 'late')).rejects.toThrow('not running')
    })

    test('interrupt aborts, ends the turn as stopped and keeps the child open for the next send', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 99' } })
      await setup.runner.interrupt(setup.session.id)
      expect(transport.commands('abort').length).toBe(1)
      expect(transport.closed).toBe(false)
      expect(setup.ofKind('activity').map((item) => item.state)).toEqual(['running', 'stopped'])
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'stopped' }])
      expect(setup.statuses.at(-1)).toBe('done')
      expect(setup.statuses).not.toContain('exited')
      transport.emit({ type: 'agent_end' })
      expect(setup.ofKind('turn-end')).toHaveLength(1)
      await setup.runner.send(setup.session.id, 'again')
      expect(transport.commands('prompt')).toHaveLength(2)
      expect(setup.statuses.at(-1)).toBe('working')
    })

    test('interrupt with no open turn does nothing', async () => {
      const transport = await begin(null)
      await setup.runner.interrupt(setup.session.id)
      expect(transport.commands('abort')).toEqual([])
      expect(setup.ofKind('turn-end')).toEqual([])
    })

    test('an abort the agent never answers falls back to a full stop', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' })
      transport.silent.add('abort')
      await setup.runner.interrupt(setup.session.id)
      expect(transport.closed).toBe(true)
      expect(setup.statuses.at(-1)).toBe('exited')
    })

    test('stop answers pending dialogs with nothing and still exits', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'extension_ui_request', id: 'ui-9', method: 'confirm', title: 'Go?' })
      await until(() => setup.asks.length === 1)
      await setup.runner.stop(setup.session.id)
      setup.asks[0]!.resolve({ status: 'unavailable', askId: 'x', answers: {}, skipped: [], summary: '', reason: 'gone' })
      await Bun.sleep(10)
      expect(transport.commands('extension_ui_response')).toEqual([])
    })

    test('an exit while working journals the stderr tail as a resumable error and fails the turn', async () => {
      const transport = await begin()
      transport.emit({ type: 'agent_start' }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })
      transport.exit(1, ['loading model', 'fatal: out of memory'])
      expect(setup.ofKind('error')).toEqual([{ kind: 'error', reason: 'exited', stderrTail: ['loading model', 'fatal: out of memory'], resumable: true }])
      expect(setup.ofKind('activity').map((item) => item.state)).toEqual(['running', 'failed'])
      expect(setup.ofKind('turn-end')).toMatchObject([{ state: 'failed' }])
      expect(setup.statuses.at(-1)).toBe('exited')
      await expect(setup.runner.send(setup.session.id, 'again')).rejects.toThrow('not running')
    })

    test('a clean exit while idle journals nothing', async () => {
      const transport = await begin(null)
      transport.exit(0)
      expect(setup.ofKind('error')).toEqual([])
      expect(setup.statuses.at(-1)).toBe('exited')
    })

    test('an exit before the session is ready fails the start with the stderr tail', async () => {
      setup = makeSetup(variant)
      const silent = fakePiTransports({ silent: ['get_state'] })
      const runner = createPiRunner(setup.context, variant, { transport: silent.factory })
      const started = runner.start(setup.session, 'hello')
      await until(() => silent.started.length === 1)
      silent.last().exit(2, ['Stored session working directory does not exist'])
      await expect(started).rejects.toThrow('Stored session working directory does not exist')
      expect(setup.ofKind('error')).toEqual([])
    })
  })
}

describe('omp approval modes', () => {
  let setup: Setup
  afterEach(async () => {
    await setup?.runner.stop(setup.session.id)
  })

  test('the opening approval mode reaches the command line and the reported settings', async () => {
    setup = makeSetup('omp')
    await setup.runner.start(setup.session, undefined, { permissionMode: 'write' })
    expect(setup.fake.last().spec.args).toEqual(['--mode', 'rpc', '--approval-mode', 'write'])
    expect(await setup.runner.configure!(setup.session.id, {})).toEqual({ permissionMode: 'write' })
  })

  test('switching mode relaunches omp on the same conversation and keeps the chat running', async () => {
    setup = makeSetup('omp')
    await setup.runner.start(setup.session, undefined, { permissionMode: 'always-ask', model: 'a/m', env: { TOKEN: 't' } })
    const first = setup.fake.last()
    expect(await setup.runner.configure!(setup.session.id, { permissionMode: 'yolo' })).toEqual({ model: 'a/m', permissionMode: 'yolo' })
    const second = setup.fake.last()
    expect(second).not.toBe(first)
    // the fake's session file does not exist on disk, so the relaunch resumes by id
    expect(second.spec.args).toEqual(['--mode', 'rpc', '--resume', 'pi-sess-1', '--model', 'a/m', '--approval-mode', 'yolo'])
    expect(second.spec.env).toMatchObject({ TOKEN: 't' })
    expect(second.commands('set_ask_dialog')).toHaveLength(1)
    expect(first.closed).toBe(true)
    expect(setup.statuses).not.toContain('exited')
    await setup.runner.send(setup.session.id, 'next')
    expect(second.commands('prompt')).toMatchObject([{ message: 'next' }])
    expect(first.commands('prompt')).toEqual([])
  })

  test('the relaunch resumes from the session file when it exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-mode-'))
    try {
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, '')
      setup = makeSetup('omp')
      setup.fake.prepare = (transport) => transport.replies.set('get_state', () => ({ success: true, data: { sessionId: 'pi-sess-1', sessionFile: file } }))
      await setup.runner.start(setup.session, undefined, { permissionMode: 'always-ask' })
      await setup.runner.configure!(setup.session.id, { permissionMode: 'write' })
      expect(setup.fake.last().spec.args).toEqual(['--mode', 'rpc', '--resume', file, '--approval-mode', 'write'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the relaunch keeps the appended instructions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-mode-'))
    try {
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, '')
      setup = makeSetup('omp')
      setup.fake.prepare = (transport) => transport.replies.set('get_state', () => ({ success: true, data: { sessionId: 'pi-sess-1', sessionFile: file } }))
      await setup.runner.start(setup.session, undefined, { permissionMode: 'always-ask', appendInstructions: 'draw visuals' })
      await setup.runner.configure!(setup.session.id, { permissionMode: 'write' })
      expect(setup.fake.last().spec.args).toEqual([
        '--mode', 'rpc', '--resume', file, '--approval-mode', 'write', '--append-system-prompt', 'draw visuals'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a turn in progress refuses the switch and leaves the process alone', async () => {
    setup = makeSetup('omp')
    await setup.runner.start(setup.session, 'busy', { permissionMode: 'always-ask' })
    setup.fake.last().emit({ type: 'agent_start' })
    await expect(setup.runner.configure!(setup.session.id, { permissionMode: 'yolo' })).rejects.toThrow("wait for the turn to end before changing omp's approval mode")
    expect(setup.fake.started).toHaveLength(1)
    expect(await setup.runner.configure!(setup.session.id, {})).toEqual({ permissionMode: 'always-ask' })
  })

  test('a relaunch that fails keeps the old process serving the chat', async () => {
    setup = makeSetup('omp')
    await setup.runner.start(setup.session, undefined, { permissionMode: 'always-ask' })
    const first = setup.fake.last()
    setup.fake.prepare = (transport) => transport.replies.set('get_state', () => ({ success: true, data: { sessionId: 'another' } }))
    await expect(setup.runner.configure!(setup.session.id, { permissionMode: 'yolo' })).rejects.toThrow('expected pi-sess-1')
    expect(setup.fake.last().closed).toBe(true)
    expect(first.closed).toBe(false)
    expect(await setup.runner.configure!(setup.session.id, {})).toEqual({ permissionMode: 'always-ask' })
    await setup.runner.send(setup.session.id, 'still here')
    expect(first.commands('prompt')).toMatchObject([{ message: 'still here' }])
  })

  test('pi refuses a permission mode', async () => {
    setup = makeSetup('pi')
    await setup.runner.start(setup.session, undefined, {})
    await expect(setup.runner.configure!(setup.session.id, { permissionMode: 'yolo' })).rejects.toThrow('pi has no permission modes')
  })
})

describe('pi launch arguments', () => {
  test('only omp takes an approval mode', () => {
    expect(piLaunchArgs('omp', { approvalMode: 'yolo' })).toEqual(['--mode', 'rpc', '--approval-mode', 'yolo'])
    expect(piLaunchArgs('pi', { approvalMode: 'yolo' })).toEqual(['--mode', 'rpc'])
  })

  test('pi resumes with --session and omp with --resume', () => {
    expect(piLaunchArgs('pi', { appendInstructions: 'a b' })).toEqual(['--mode', 'rpc', '--append-system-prompt', 'a b'])
    expect(piLaunchArgs('omp', { appendInstructions: '' })).toEqual(['--mode', 'rpc'])
    expect(piLaunchArgs('pi', { resume: 'abc' })).toEqual(['--mode', 'rpc', '--session', 'abc'])
    expect(piLaunchArgs('omp', { resume: 'abc', model: 'm', effort: 'low' })).toEqual(['--mode', 'rpc', '--resume', 'abc', '--model', 'm', '--thinking', 'low'])
  })
})

describe('pi stdio transport', () => {
  test('frames split on LF only, responses correlate by id and a failing command rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-rpc-'))
    try {
      const script = join(dir, 'agent.ts')
      writeFileSync(
        script,
        `
        process.stdout.write(JSON.stringify({ type: 'ready', note: 'a\\u2028b' }) + '\\r\\n')
        let input = ''
        process.stdin.on('data', (chunk) => {
          input += chunk
          for (;;) {
            const newline = input.indexOf('\\n')
            if (newline < 0) break
            const command = JSON.parse(input.slice(0, newline))
            input = input.slice(newline + 1)
            if (command.type === 'boom') { process.stderr.write('one\\ntwo\\n'); process.exit(3) }
            const ok = command.type !== 'bad'
            process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: ok, ...(ok ? { data: { echoed: command.value } } : { error: 'nope' }) }) + '\\n')
          }
        })
        `
      )
      const events: Record<string, unknown>[] = []
      const exits: unknown[] = []
      const processRunner = createProcessRunner({ owner: 'pi-rpc-test' })
      const rpc = new PiRpc(
        { executable: process.execPath, args: [script], cwd: dir, env: process.env },
        { event: (frame) => events.push(frame), exit: (exit) => exits.push(exit) },
        processRunner,
        spawnPiTransport
      )
      expect(await rpc.request('echo', { value: 7 })).toEqual({ echoed: 7 })
      await expect(rpc.request('bad')).rejects.toThrow('nope')
      expect(events).toEqual([{ type: 'ready', note: 'a b' }])
      await expect(rpc.request('boom')).rejects.toThrow('exited with code 3')
      expect(exits).toMatchObject([{ code: 3, stderrTail: ['one', 'two'] }])
      await rpc.close()
      await processRunner.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('an outgoing frame carrying an image at the structured cap is sent whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-rpc-big-'))
    try {
      const script = join(dir, 'agent.ts')
      writeFileSync(
        script,
        `
        let input = ''
        process.stdin.on('data', (chunk) => {
          input += chunk
          for (;;) {
            const newline = input.indexOf('\\n')
            if (newline < 0) break
            const line = input.slice(0, newline)
            input = input.slice(newline + 1)
            const command = JSON.parse(line)
            process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data: { bytes: command.images[0].data.length } }) + '\\n')
          }
        })
        `
      )
      const processRunner = createProcessRunner({ owner: 'pi-rpc-big-test' })
      const rpc = new PiRpc(
        { executable: process.execPath, args: [script], cwd: dir, env: process.env },
        { event: () => {}, exit: () => {} },
        processRunner,
        spawnPiTransport
      )
      const data = Buffer.alloc(3 * 1024 * 1024 + 4096, 1).toString('base64')
      expect(await rpc.request('prompt', { message: 'look', images: [{ type: 'image', data, mimeType: 'image/png' }] }, 60_000)).toEqual({ bytes: data.length })
      await expect(rpc.request('prompt', { message: 'x', images: [{ data: 'a'.repeat(40 * 1024 * 1024) }] })).rejects.toThrow('frame limit')
      await rpc.close()
      await processRunner.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pi and omp commands', () => {
  let setup: Setup | undefined
  afterEach(async () => {
    await setup?.runner.stop(setup.session.id)
    setup = undefined
  })

  const PI_COMMANDS = [
    { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt', sourceInfo: { scope: 'project', origin: 'top-level' } },
    { name: 'skill:review', description: 'Review a diff', source: 'skill', sourceInfo: { scope: 'user', origin: 'top-level' } },
    { name: 'skill:deploy', description: 'Deploy', source: 'skill', sourceInfo: { scope: 'user', origin: 'package' } },
    { name: 'todos', source: 'extension', sourceInfo: { scope: 'user', origin: 'top-level' } }
  ]

  test('pi reports get_commands at start, with package entries as plugin entries', async () => {
    setup = makeSetup('pi', { get_commands: () => ({ success: true, data: { commands: PI_COMMANDS } }) })
    await setup.runner.start(setup.session, undefined)
    expect(setup.fake.last().commands('get_commands')).toHaveLength(1)
    expect(setup.reported).toEqual([
      [
        { name: 'fix-tests', kind: 'command', description: 'Fix failing tests' },
        { name: 'skill:review', kind: 'skill', description: 'Review a diff' },
        { name: 'skill:deploy', kind: 'plugin', description: 'Deploy' },
        { name: 'todos', kind: 'command' }
      ]
    ])
  })

  test('pi moves a skill picked mid-message to the front, where pi expands it, but journals what was typed', async () => {
    setup = makeSetup('pi', { get_commands: () => ({ success: true, data: { commands: PI_COMMANDS } }) })
    await setup.runner.start(setup.session, 'fix the login /skill:review focus on auth')
    expect(setup.fake.last().commands('prompt')).toMatchObject([{ message: '/skill:review fix the login focus on auth' }])
    expect(setup.ofKind('user')).toEqual([{ kind: 'user', text: 'fix the login /skill:review focus on auth' }])
  })

  test('omp reports get_available_commands with built-ins start-only, follows available_commands_update, and never moves a built-in', async () => {
    setup = makeSetup('omp', {
      get_available_commands: () => ({
        success: true,
        data: {
          commands: [
            { name: 'compact', description: 'Compact the session', input: { hint: '[focus]' }, source: 'builtin' },
            { name: 'skill:review', description: 'Review a diff', input: { hint: 'arguments' }, source: 'skill' },
            { name: 'docs', description: 'From MCP', source: 'mcp_prompt' },
            { name: 'odd', source: 'unknown' }
          ]
        }
      })
    })
    await setup.runner.start(setup.session, 'please /compact now')
    const transport = setup.fake.last()
    expect(setup.reported[0]).toEqual([
      { name: 'compact', kind: 'builtin', description: 'Compact the session', argumentHint: '[focus]', startOnly: true },
      { name: 'skill:review', kind: 'skill', description: 'Review a diff' },
      { name: 'docs', kind: 'mcp', description: 'From MCP' }
    ])
    expect(transport.commands('prompt')).toMatchObject([{ message: 'please /compact now' }])
    transport.emit({ type: 'available_commands_update', commands: [{ name: 'skill:new', source: 'skill' }] })
    expect(setup.reported.at(-1)).toEqual([{ name: 'skill:new', kind: 'skill' }])
  })
})

type SubSetup = Setup

const lifecycle = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: 'subagent_lifecycle',
  payload: { id, agent: 'explore', agentSource: 'bundled', description: `task ${id}`, status, index: 0, ...extra }
})
const inner = (id: string, event: Record<string, unknown>) => ({ type: 'subagent_event', payload: { id, event } })

describe('omp subagents', () => {
  let setup: SubSetup
  const begin = async (options: Parameters<Setup['runner']['start']>[2] = {}) => {
    setup = makeSetup('omp')
    await setup.runner.start(setup.session, 'go', options)
    return setup.fake.last()
  }
  const agents = () => setup.ofKind('agent')
  const lastOf = (id: string) => agents().filter((item) => item.id === id).at(-1)
  afterEach(async () => {
    await setup?.runner.stop(setup.session.id)
  })

  test('the subscription is sent outside deny-all and never inside it', async () => {
    const transport = await begin()
    expect(transport.commands('set_subagent_subscription')).toMatchObject([{ level: 'events' }])
    await setup.runner.stop(setup.session.id)
    const denied = await begin({ toolPolicy: 'deny-all' })
    expect(denied.commands('set_subagent_subscription')).toEqual([])
  })

  test('pi never sends the subscription', async () => {
    const pi = makeSetup('pi')
    await pi.runner.start(pi.session, 'go')
    expect(pi.fake.last().commands('set_subagent_subscription')).toEqual([])
    await pi.runner.stop(pi.session.id)
  })

  test('lifecycle spawns, ends and tags agents; the task call itself is no activity', async () => {
    const transport = await begin()
    transport.emit(
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'task1', toolName: 'task', args: { tasks: [] } },
      lifecycle('a1', 'started', { parentToolCallId: 'task1', detached: true }),
      lifecycle('a1', 'completed', { parentToolCallId: 'task1' }),
      { type: 'tool_execution_end', toolCallId: 'task1', toolName: 'task', result: { content: [] } }
    )
    expect(setup.ofKind('activity')).toEqual([])
    expect(agents().map((item) => item.state)).toEqual(['working', 'done'])
    expect(agents()[0]).toMatchObject({ id: 'a1', nativeId: 'a1', name: 'explore', task: 'task a1', prompt: 'task a1', background: true, steps: 'full' })
    expect(setup.items().filter((item) => item.kind === 'agent').every((item) => item.agent === undefined)).toBe(true)
  })

  test('failed and aborted map to failed and stopped', async () => {
    const transport = await begin()
    transport.emit(lifecycle('a1', 'started'), lifecycle('a1', 'failed'), lifecycle('a2', 'started'), lifecycle('a2', 'aborted'))
    expect(lastOf('a1')?.state).toBe('failed')
    expect(lastOf('a2')?.state).toBe('stopped')
  })

  test('progress sets tokens and the AI summary, and no summary under latest-tool', async () => {
    const transport = await begin()
    transport.emit(lifecycle('a1', 'started'))
    transport.emit({ type: 'subagent_progress', payload: { index: 0, agent: 'explore', task: 't', progress: { id: 'a1', tokens: 120, lastIntent: 'reading files' } } })
    expect(lastOf('a1')).toMatchObject({ tokens: 120, summary: 'reading files' })
    setup.summaries.mode = 'latest-tool'
    transport.emit({ type: 'subagent_progress', payload: { index: 0, agent: 'explore', task: 't', progress: { id: 'a1', tokens: 150, lastIntent: 'writing' } } })
    expect(lastOf('a1')?.tokens).toBe(150)
    expect(lastOf('a1')?.summary).toBeUndefined()
  })

  test('subagent events journal tagged prose and tool calls and never touch the parent turn', async () => {
    const transport = await begin()
    transport.emit(
      { type: 'agent_start' },
      lifecycle('a1', 'started'),
      inner('a1', { type: 'agent_start' }),
      inner('a1', { type: 'tool_execution_start', toolCallId: 'k1', toolName: 'bash', args: { command: 'ls' } }),
      inner('a1', { type: 'tool_execution_end', toolCallId: 'k1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] } }),
      inner('a1', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'found it' }], usage: { input: 5, output: 5 } } }),
      inner('a1', { type: 'agent_end', isTerminal: true, yielded: true }),
      inner('a1', { type: 'agent_settled' })
    )
    expect(setup.ofKind('activity').map((item) => [item.state, item.agent])).toEqual([['running', 'a1'], ['done', 'a1']])
    expect(setup.ofKind('prose')).toEqual([{ kind: 'prose', text: 'found it', agent: 'a1' }])
    expect(setup.ofKind('turn-end')).toEqual([])
    expect(setup.usage).toEqual([])
    expect(setup.statuses.at(-1)).toBe('working')
  })

  test('streaming prose is keyed per agent', async () => {
    const transport = await begin()
    transport.emit(lifecycle('a1', 'started'), lifecycle('a2', 'started'))
    const delta = (id: string, d: string) => inner(id, { type: 'message_update', messageId: 'm1', assistantMessageEvent: { type: 'text_delta', delta: d } })
    transport.emit(delta('a1', 'one '), delta('a2', 'two '))
    await Bun.sleep(300)
    transport.emit(delta('a1', 'more'), delta('a2', 'more'))
    const streamed = setup.ofKind('prose').filter((item) => item.streaming)
    expect(streamed.map((item) => [item.agent, item.text])).toEqual([['a1', 'one more'], ['a2', 'two more']])
  })

  test('a nested task call inside a subagent makes a nested agent, and an unknown parent goes to unattributed', async () => {
    const transport = await begin()
    transport.emit(
      { type: 'tool_execution_start', toolCallId: 'task1', toolName: 'task', args: {} },
      lifecycle('a1', 'started', { parentToolCallId: 'task1' }),
      inner('a1', { type: 'tool_execution_start', toolCallId: 'task2', toolName: 'task', args: {} }),
      lifecycle('a2', 'started', { parentToolCallId: 'task2' }),
      lifecycle('a3', 'started', { parentToolCallId: 'nope' })
    )
    expect(setup.ofKind('activity')).toEqual([])
    const tagOf = (id: string) => setup.ofKind('agent').find((item) => item.id === id) && setup.items().find((item) => item.kind === 'agent' && item.id === id)?.agent
    expect(tagOf('a1')).toBeUndefined()
    expect(tagOf('a2')).toBe('a1')
    expect(tagOf('a3')).toBe('unattributed')
    expect(agents().filter((item) => item.id === 'unattributed')).toHaveLength(1)
  })

  test('an event for an unknown agent is journaled under unattributed', async () => {
    const transport = await begin()
    transport.emit(inner('ghost', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
    expect(lastOf('unattributed')).toMatchObject({ state: 'working' })
    expect(setup.ofKind('prose')).toEqual([{ kind: 'prose', text: 'hi', agent: 'unattributed' }])
  })

  test('stopAgent cancels the agent and its descendants deepest first and journals them stopped', async () => {
    const transport = await begin()
    transport.emit(
      { type: 'tool_execution_start', toolCallId: 'task1', toolName: 'task', args: {} },
      lifecycle('a1', 'started', { parentToolCallId: 'task1' }),
      inner('a1', { type: 'tool_execution_start', toolCallId: 'task2', toolName: 'task', args: {} }),
      lifecycle('a2', 'started', { parentToolCallId: 'task2' })
    )
    await setup.runner.stopAgent?.(setup.session.id, 'a1')
    expect(transport.commands('cancel_subagent').map((frame) => frame.subagentId)).toEqual(['a2', 'a1'])
    expect(lastOf('a1')?.state).toBe('stopped')
    expect(lastOf('a2')?.state).toBe('stopped')
    expect(setup.ofKind('turn-end')).toEqual([])
    await setup.runner.stopAgent?.(setup.session.id, 'a1')
    expect(transport.commands('cancel_subagent')).toHaveLength(2)
  })

  test('interrupt cancels every live agent before aborting', async () => {
    const transport = await begin()
    transport.emit({ type: 'agent_start' }, lifecycle('a1', 'started', { detached: true }))
    await setup.runner.interrupt(setup.session.id)
    const order = transport.written.map((frame) => frame.type).filter((type) => type === 'cancel_subagent' || type === 'abort')
    expect(order).toEqual(['cancel_subagent', 'abort'])
    expect(lastOf('a1')?.state).toBe('stopped')
  })

  test('a detached agent and its open calls survive the parent agent_end', async () => {
    const transport = await begin()
    transport.emit(
      { type: 'agent_start' },
      lifecycle('a1', 'started', { detached: true }),
      inner('a1', { type: 'tool_execution_start', toolCallId: 'k1', toolName: 'bash', args: { command: 'sleep 9' } })
    )
    setup.settle(transport)
    expect(setup.ofKind('turn-end')).toHaveLength(1)
    expect(lastOf('a1')?.state).toBe('working')
    expect(setup.ofKind('activity').map((item) => item.state)).toEqual(['running'])
  })

  test('an agent that ends reports its final tokens as input once', async () => {
    const transport = await begin()
    transport.emit(lifecycle('a1', 'started'))
    transport.emit({ type: 'subagent_progress', payload: { index: 0, agent: 'explore', task: 't', progress: { id: 'a1', tokens: 700 } } })
    transport.emit(lifecycle('a1', 'completed'), lifecycle('a1', 'completed'))
    expect(setup.usage).toEqual([{ tokens: { input: 700, output: 0, cacheRead: 0, cacheWrite: 0 } }])
  })

  test('run end journals live agents as cut off and stops their open calls', async () => {
    const transport = await begin()
    transport.emit(lifecycle('a1', 'started', { detached: true }), inner('a1', { type: 'tool_execution_start', toolCallId: 'k1', toolName: 'bash', args: { command: 'ls' } }))
    await setup.runner.stop(setup.session.id)
    expect(lastOf('a1')).toMatchObject({ state: 'stopped', cutOff: true })
    expect(setup.ofKind('activity').map((item) => item.state)).toEqual(['running', 'stopped'])
  })

  test('deny-all ignores subagent frames and still refuses tools', async () => {
    const transport = await begin({ toolPolicy: 'deny-all' })
    transport.emit(lifecycle('a1', 'started'))
    expect(agents()).toEqual([])
  })
})

describe('pi subagent tool', () => {
  let setup: Setup
  afterEach(async () => {
    await setup?.runner.stop(setup.session.id)
  })

  test('a subagent tool call is an agent with no steps, ended by the result', async () => {
    setup = makeSetup('pi')
    await setup.runner.start(setup.session, 'go')
    const transport = setup.fake.last()
    transport.emit(
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'subagent', args: { agent: 'scout', task: 'find x' } },
      { type: 'tool_execution_end', toolCallId: 'p1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'x is here' }] } },
      { type: 'tool_execution_start', toolCallId: 'p2', toolName: 'subagent', args: { foo: 'bar' } },
      { type: 'tool_execution_end', toolCallId: 'p2', toolName: 'subagent', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } }
    )
    expect(setup.ofKind('activity')).toEqual([])
    const agents = setup.ofKind('agent')
    expect(agents[0]).toMatchObject({ id: 'p1', name: 'scout', task: 'find x', prompt: 'find x', steps: 'none', state: 'working' })
    expect(agents[1]).toMatchObject({ id: 'p1', state: 'done', report: 'x is here' })
    expect(agents[2]).toMatchObject({ id: 'p2', name: 'subagent', state: 'working' })
    expect(agents[3]).toMatchObject({ id: 'p2', state: 'failed', error: 'boom' })
    expect(agents.every((item) => item.tokens === undefined)).toBe(true)
    expect(setup.usage).toEqual([])
  })

  test('stopAgent is a no-op', async () => {
    setup = makeSetup('pi')
    await setup.runner.start(setup.session, 'go')
    setup.fake.last().emit({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'subagent', args: { task: 't' } })
    await setup.runner.stopAgent?.(setup.session.id, 'p1')
    expect(setup.ofKind('agent').at(-1)?.state).toBe('working')
  })
})
