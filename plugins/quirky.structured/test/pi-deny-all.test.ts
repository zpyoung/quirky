import { afterEach, describe, expect, test } from 'bun:test'
import type { AskSpec, ChatItem, ProcessSpawner, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import type { PiVariant } from '../pi-rpc'
import { createPiRunner } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext } from '../runner'
import { fakePiTransports, type Reply } from './fakes/pi-transport'

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

const DENY = 'tools are disabled for this session'
const noSpawn: ProcessSpawner = {
  spawn() {
    throw new Error('the scripted transport must not spawn a process')
  }
}

const state = (extra: Record<string, unknown> = {}): Reply => ({
  success: true,
  data: { sessionId: 'pi-sess-1', sessionFile: '/fake/pi-sess-1.jsonl', isStreaming: false, ...extra }
})

function makeSetup(variant: PiVariant, replies: Record<string, () => Reply> = {}, limits: { checkTimeoutMs?: number; abortTimeoutMs?: number } = {}) {
  const messages: StructuredMessage[] = []
  const statuses: SessionStatus[] = []
  const asks: AskSpec[] = []
  const context: StructuredContext = {
    process: noSpawn,
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
    createAsk(spec) {
      asks.push(spec)
      return new Promise(() => {})
    },
    async cancelAsk() {},
    async setProviderSession() {},
    resolveClaudePath: async () => '/not-used/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async (requested) => `/fake/bin/${requested}`
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
  const fake = fakePiTransports({ replies: { get_state: () => state(), ...replies } })
  const runner = createPiRunner(context, variant, { transport: fake.factory, env: {}, ...limits })
  const texts = () => messages.map((message) => message.text)
  const items = (): ChatItem[] => messages.flatMap((message) => (message.item ? [message.item] : []))
  return { messages, statuses, asks, session, fake, runner, texts, items }
}

type Setup = ReturnType<typeof makeSetup>

for (const variant of ['pi', 'omp'] as const) {
  describe(`${variant} deny-all`, () => {
    let setup: Setup
    const checkCommand = variant === 'pi' ? 'get_commands' : 'get_state'
    const emptyCheck = (): Reply => (variant === 'pi' ? { success: true, data: { commands: [] } } : state({ dumpTools: [] }))
    const begin = async (prompt: string | null = 'hello', replies: Record<string, () => Reply> = {}, limits = {}) => {
      setup = makeSetup(variant, { [checkCommand]: emptyCheck, ...replies }, limits)
      await setup.runner.start(setup.session, prompt ?? undefined, { toolPolicy: 'deny-all' })
      return setup.fake.last()
    }
    afterEach(async () => {
      await setup?.runner.stop(setup.session.id)
    })

    test('starts the child with the no-tools switches before the model and thinking picks', async () => {
      setup = makeSetup(variant, { [checkCommand]: emptyCheck })
      await setup.runner.start(setup.session, 'hello', { toolPolicy: 'deny-all', model: 'a/b', effort: 'high' })
      const switches = variant === 'pi' ? ['--no-tools', '--no-extensions', '--no-mcp'] : ['--no-tools', '--no-extensions']
      expect(setup.fake.last().spec.args).toEqual(['--mode', 'rpc', ...switches, '--model', 'a/b', '--thinking', 'high'])
    })

    test('checks for tools before the first prompt and does not enable ask dialogs', async () => {
      const transport = await begin()
      const order = transport.written.map((frame) => frame.type)
      expect(order.indexOf('prompt')).toBeGreaterThan(order.lastIndexOf(checkCommand))
      expect(transport.commands('prompt')).toMatchObject([{ message: 'hello' }])
      expect(transport.commands('set_ask_dialog')).toEqual([])
    })

    test('ends the session when the agent offers a tool', async () => {
      const offered = variant === 'pi' ? { success: true, data: { commands: [{ name: 'ext', source: 'extension' }] } } : state({ dumpTools: [{ name: 'bash' }] })
      setup = makeSetup(variant, { [checkCommand]: () => offered as Reply })
      await expect(setup.runner.start(setup.session, 'hello', { toolPolicy: 'deny-all' })).resolves.toBeUndefined()
      await until(() => setup.statuses.includes('exited'))
      expect(setup.fake.last().commands('prompt')).toEqual([])
      expect(setup.texts().some((text) => text.includes('must have no tools') || text.includes('must have none'))).toBe(true)
    })

    test('limits a long tool list to eight names and a remainder', async () => {
      const names = Array.from({ length: 11 }, (_, index) => ({ name: `tool-${index}`, source: 'extension' }))
      const offered = variant === 'pi' ? { success: true, data: { commands: names } } : state({ dumpTools: names })
      setup = makeSetup(variant, { [checkCommand]: () => offered as Reply })
      await setup.runner.start(setup.session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => setup.statuses.includes('exited'))
      const reason = setup.texts().find((text) => text.includes('tool-0'))
      expect(reason).toContain('tool-7')
      expect(reason).not.toContain('tool-8')
      expect(reason).toContain('and 3 more')
    })

    test('ends the session when the check is refused or has no list', async () => {
      setup = makeSetup(variant, { [checkCommand]: () => (variant === 'pi' ? { success: true, data: { commands: 'x' } } : state({ dumpTools: 'x' })) })
      await setup.runner.start(setup.session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => setup.statuses.includes('exited'))
      expect(setup.texts().some((text) => text.includes('could not confirm it has no tools'))).toBe(true)
      expect(setup.fake.last().commands('prompt')).toEqual([])
    })

    test('times out an unanswered check', async () => {
      const transport = await begin(null, {}, { checkTimeoutMs: 20 })
      transport.silent.add(checkCommand)
      await expect(setup.runner.send(setup.session.id, 'hello')).rejects.toThrow()
      await until(() => setup.statuses.includes('exited'))
      expect(setup.texts().some((text) => text.includes('could not confirm it has no tools'))).toBe(true)
      expect(transport.commands('prompt')).toEqual([])
    })

    test('checks every later message and ends when a tool has appeared', async () => {
      let tools = false
      const transport = await begin(null, {
        [checkCommand]: () => (tools ? (variant === 'pi' ? { success: true, data: { commands: [{ name: 'x', source: 'extension' }] } } : state({ dumpTools: [{ name: 'x' }] })) : emptyCheck())
      })
      await setup.runner.send(setup.session.id, 'first')
      transport.emit({ type: 'agent_end' })
      tools = true
      await expect(setup.runner.send(setup.session.id, 'second')).rejects.toThrow()
      expect(transport.commands('prompt').length + transport.commands('steer').length).toBe(1)
    })

    test('refuses a tool that starts, aborts the turn and journals the refusal', async () => {
      const transport = await begin()
      transport.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })
      await until(() => transport.commands('abort').length === 1)
      expect(setup.texts()).toContain(DENY)
      expect(setup.items().some((item) => item.kind === 'activity')).toBe(false)
    })

    test('ends the session when an abort after a tool start is never answered', async () => {
      const transport = await begin('hello', { abort: () => ({ success: true }) }, { abortTimeoutMs: 20 })
      transport.silent.add('abort')
      transport.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} })
      await until(() => setup.statuses.includes('exited'))
      expect(setup.texts().some((text) => text.includes('did not stop after a tool started'))).toBe(true)
    })

    test('lets a tool-not-found result pass and ends the session for any other result', async () => {
      const transport = await begin()
      transport.emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'Tool bash not found' }] }
      })
      await Bun.sleep(20)
      expect(setup.statuses.includes('exited')).toBe(false)
      transport.emit({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } })
      await until(() => setup.statuses.includes('exited'))
      expect(setup.texts().some((text) => text.includes('ran bash in a session that must have no tools'))).toBe(true)
    })

    test('cancels extension dialogs without raising an ask', async () => {
      const transport = await begin()
      transport.emit({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Pick', options: ['a', 'b'] })
      await until(() => transport.commands('extension_ui_response').length === 1)
      expect(transport.commands('extension_ui_response')[0]).toMatchObject({ id: 'd1', cancelled: true })
      expect(setup.asks).toEqual([])
    })

    test('records the context footprint on the turn-ending message', async () => {
      const transport = await begin('hello', { [checkCommand]: () => (variant === 'pi' ? { success: true, data: { commands: [] } } : state({ dumpTools: [] })) })
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { totalTokens: 1234 } } })
      transport.emit(variant === 'pi' ? { type: 'agent_settled' } : { type: 'agent_end', messages: [], isTerminal: true, yielded: true })
      const result = setup.messages.find((message) => message.role === 'result')
      expect(result?.data).toEqual({ contextUsage: { contextTokens: 1234, contextWindow: null } })
    })

    test('takes the context window from the startup state', async () => {
      const transport = await begin('hello', { get_state: () => state({ model: { contextWindow: 200000 }, dumpTools: [] }) })
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 10, output: 5 } } })
      transport.emit(variant === 'pi' ? { type: 'agent_settled' } : { type: 'agent_end', messages: [], isTerminal: true, yielded: true })
      expect(setup.messages.find((message) => message.role === 'result')?.data).toEqual({ contextUsage: { contextTokens: 15, contextWindow: 200000 } })
    })

    test('refuses to change the permission mode', async () => {
      await begin(null)
      await expect(setup.runner.configure!(setup.session.id, { permissionMode: 'default' })).rejects.toThrow('no permission modes')
    })
  })

  describe(`${variant} default policy`, () => {
    test('does not check for tools and journals tool calls', async () => {
      const setup = makeSetup(variant)
      await setup.runner.start(setup.session, 'hello', {})
      const transport = setup.fake.last()
      expect(transport.spec.args).not.toContain('--no-tools')
      transport.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })
      expect(transport.commands('abort')).toEqual([])
      expect(setup.items().some((item) => item.kind === 'activity')).toBe(true)
      await setup.runner.stop(setup.session.id)
    })
  })
}
