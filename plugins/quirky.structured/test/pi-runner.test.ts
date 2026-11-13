import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createPiRunner, resolvePiThroughLoginShell } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { createFakePiRpc, type FakePiRpcFixture } from './fakes/fake-pi-rpc'

async function until(check: () => boolean, attempts = 400) {
  for (let i = 0; i < attempts && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

let home: string
let fake: FakePiRpcFixture
let messages: StructuredMessage[]
let statuses: SessionStatus[]
let asks: AskSpec[]
let resolved: string[]
let runner: StructuredRunner
let session: Session

function build(
  agent: 'pi' | 'omp' = 'pi',
  contextWindow?: number | null,
  limits?: { maxFrameBytes?: number; checkTimeoutMs?: number; abortTimeoutMs?: number },
  fakeOptions: Omit<NonNullable<Parameters<typeof createFakePiRpc>[1]>, 'contextWindow' | 'flavor'> = {}
) {
  fake = createFakePiRpc(home, { ...(contextWindow === undefined ? {} : { contextWindow }), flavor: agent, ...fakeOptions })
  const context: StructuredContext = {
    appendMessage(msg: NewStructuredMessage) {
      const stored = { ...msg, seq: messages.length + 1, at: msg.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus(_id, status) {
      statuses.push(status)
    },
    createAsk(spec) {
      asks.push(spec)
      return new Promise<AskEnvelope>(() => {})
    },
    async setProviderSession() {},
    resolveClaudePath: async () => '/not-used/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async (name) => {
      resolved.push(name)
      return fake.executable
    }
  }
  runner = createPiRunner(context, limits)
  session = {
    id: 's_pi',
    kind: 'structured',
    agent,
    worktreeId: 'wt_1',
    cwd: home,
    title: agent,
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
}
function useCheckResponse(response: Record<string, unknown>) {
  const logPath = join(home, 'fake-pi.jsonl')
  const script = `#!${process.execPath}
const fs = require('node:fs')
const response = ${JSON.stringify(response)}
const logPath = ${JSON.stringify(logPath)}
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line) continue
    const command = JSON.parse(line)
    fs.appendFileSync(logPath, JSON.stringify(command) + '\\n')
    if (command.type === 'get_state') {
      send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { model: { id: 'fake', contextWindow: 200000 } } })
    }
    if (command.type === 'get_commands') send({ ...response, id: response.id ?? command.id })
  }
})
`
  writeFileSync(fake.executable, script, { mode: 0o700 })
  chmodSync(fake.executable, 0o700)
}

function writeStandInShell(name: string, body: string) {
  const shell = join(home, name)
  writeFileSync(shell, `#!/bin/sh\n${body}`, { mode: 0o700 })
  chmodSync(shell, 0o700)
  return shell
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'pi-runner-')))
  messages = []
  statuses = []
  asks = []
  resolved = []
  build()
})

afterEach(async () => {
  await runner.stop(session.id)
  rmSync(home, { recursive: true, force: true })
})

const settled = () => statuses.includes('done')
const results = () => messages.filter((message) => message.role === 'result')
const prompts = () => fake.commands().filter((command) => command.type === 'prompt')
const userCommands = () =>
  fake.commands().filter((command) => command.type === 'prompt' || command.type === 'steer')
const contextUsageOfResult = () =>
  (messages.find((m) => m.role === 'result')?.data as { contextUsage?: unknown } | undefined)?.contextUsage
const journal = () => messages.map(({ role, text }) => [role, text])

describe('pi rpc runner', () => {
  test.each([
    { agent: 'pi' as const, options: { model: 'stub/think' }, args: ['--model', 'stub/think'] },
    { agent: 'pi' as const, options: { model: 'stub/think', effort: 'high' }, args: ['--model', 'stub/think', '--thinking', 'high'] },
    { agent: 'pi' as const, options: { effort: 'off' }, args: ['--thinking', 'off'] },
    { agent: 'omp' as const, options: { model: 'stub/think' }, args: ['--model', 'stub/think'] },
    { agent: 'omp' as const, options: { model: 'stub/think', effort: 'xhigh' }, args: ['--model', 'stub/think', '--thinking', 'xhigh'] },
    { agent: 'omp' as const, options: { effort: 'low' }, args: ['--thinking', 'low'] }
  ])('$agent passes the selected model and thinking level: $options', async ({ agent, options, args }) => {
    build(agent)
    await runner.start(session, 'hello', options)
    await until(() => fake.launch() !== null)
    expect(fake.launch()?.argv).toEqual(['--mode', 'rpc', ...args])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} puts the selected model and thinking level after the no-tools switches`, async () => {
      build(agent)
      await runner.start(session, 'hello', { toolPolicy: 'deny-all', model: 'stub/think', effort: 'high' })
      await until(() => fake.launch() !== null)
      expect(fake.launch()?.argv).toEqual([
        '--mode',
        'rpc',
        '--no-tools',
        '--no-extensions',
        ...(agent === 'pi' ? ['--no-mcp'] : []),
        '--model',
        'stub/think',
        '--thinking',
        'high'
      ])
    })
  }

  test('pi deny-all checks before its first prompt', async () => {
    build('pi', undefined, undefined, { commands: [] })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    expect(journal()).toEqual([['user', 'hello']])
    expect(statuses).toEqual(['working'])
    await until(settled)
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: 'hello' }
    ])
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'pi: hello'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
  })
  test('pi deny-all exits when get_commands lists an extension', async () => {
    build('pi', undefined, undefined, {
      commands: [
        { name: 'llama', source: 'extension' },
        { name: 'fix-tests', source: 'prompt' },
        { name: 'mcp', source: 'extension' },
        { name: 'skill:review', source: 'skill' }
      ]
    })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi loaded extensions in a session that must have no tools: llama, mcp']
    ])
    expect(messages.filter((message) => message.role === 'system').map((message) => message.data)).toEqual([undefined])
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' }
    ])
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
  })

  test('omp deny-all exits when get_state offers a tool', async () => {
    build('omp', undefined, undefined, { tools: ['mcp__standin_touch_marker'] })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'omp offers tools to a session that must have none: mcp__standin_touch_marker']
    ])
    expect(fake.commands()).toEqual([{ id: 'quirky-check-1', type: 'get_state' }])
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
  })

  test('omp deny-all limits long tool lists to eight sanitized names and a remainder count', async () => {
    const tools = Array.from({ length: 10 }, (_, index) => `mcp__s_t${index}`)
    build('omp', undefined, undefined, { tools })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'omp offers tools to a session that must have none: mcp__s_t0, mcp__s_t1, mcp__s_t2, mcp__s_t3, mcp__s_t4, mcp__s_t5, mcp__s_t6, mcp__s_t7 and 2 more']
    ])
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
  })

  test('omp deny-all flattens and truncates tool names and labels non-string names', async () => {
    const longName = 'x'.repeat(81)
    build('omp', undefined, undefined, { tools: ['mcp__line\nbreak', longName, 7 as unknown as string] })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', `omp offers tools to a session that must have none: mcp__line break, ${'x'.repeat(79)}…, unnamed`]
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} deny-all times out when the no-tools check is unanswered`, async () => {
      build(agent, undefined, { checkTimeoutMs: 150 }, { check: 'silent' })
      await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => statuses.at(-1) === 'exited')
      expect(journal()).toEqual([
        ['user', 'hello'],
        ['system', `${agent} did not answer the no-tools check`]
      ])
      expect(fake.commands().some((command) => command.type === 'prompt')).toBe(false)
      expect(statuses).toEqual(['working', 'exited'])
      await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
    })

    test(`${agent} deny-all exits when the no-tools check is refused`, async () => {
      build(agent, undefined, undefined, { check: 'refuse' })
      await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => statuses.at(-1) === 'exited')
      expect(journal()).toEqual([
        ['user', 'hello'],
        ['system', `${agent} could not confirm it has no tools: scripted check failure`]
      ])
      expect(fake.commands().some((command) => command.type === 'prompt')).toBe(false)
      expect(statuses).toEqual(['working', 'exited'])
    })

    test(`${agent} deny-all fails closed when the no-tools reply has no list`, async () => {
      build(agent, undefined, undefined, { check: 'empty' })
      await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => statuses.at(-1) === 'exited')
      const reason = agent === 'pi' ? 'the reply lists no commands' : 'the reply lists no tools'
      expect(journal()).toEqual([
        ['user', 'hello'],
        ['system', `${agent} could not confirm it has no tools: ${reason}`]
      ])
      expect(fake.commands().some((command) => command.type === 'prompt')).toBe(false)
      expect(statuses).toEqual(['working', 'exited'])
    })
  }
  test('pi deny-all uses the refusal fallback when a check has no error text', async () => {
    build()
    useCheckResponse({ type: 'response', command: 'get_commands', success: false })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi could not confirm it has no tools: the check was refused']
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('pi deny-all uses the refusal fallback when the error text is only spaces', async () => {
    build()
    useCheckResponse({ type: 'response', command: 'get_commands', success: false, error: '   ' })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi could not confirm it has no tools: the check was refused']
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('pi deny-all sanitizes and truncates a refusal reason', async () => {
    build()
    const error = `bad\n${'x'.repeat(170)}`
    useCheckResponse({ type: 'response', command: 'get_commands', success: false, error })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', `pi could not confirm it has no tools: ${'bad '}${'x'.repeat(155)}…`]
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('pi deny-all fails closed when commands is not an array', async () => {
    build()
    useCheckResponse({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: 'not-an-array' }
    })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi could not confirm it has no tools: the reply lists no commands']
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('pi deny-all does not accept a check reply with another id', async () => {
    build('pi', undefined, { checkTimeoutMs: 1000 })
    useCheckResponse({
      id: 'unrelated-check',
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: [] }
    })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => fake.commands().some((command) => command.type === 'get_commands'))
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi did not answer the no-tools check']
    ])
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' }
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('omp deny-all gets its model and context from the no-tools check', async () => {
    build('omp', undefined, undefined, { tools: [] })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.commands()).toEqual([
      { id: 'quirky-check-1', type: 'get_state' },
      { type: 'prompt', message: 'hello' }
    ])
    expect(contextUsageOfResult()).toEqual({ contextTokens: 180, contextWindow: 200000 })
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['assistant', 'omp: hello'],
      ['result', 'omp turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} deny-all checks every later prompt`, async () => {
      build(agent)
      await runner.start(session, 'first', { toolPolicy: 'deny-all' })
      const results = () => messages.filter((message) => message.role === 'result')
      await until(() => results().length === 1)
      await runner.send(session.id, 'second')
      await until(() => results().length === 2)
      const expectedCommands =
        agent === 'pi'
          ? [
              { id: 'quirky-state', type: 'get_state' },
              { id: 'quirky-check-1', type: 'get_commands' },
              { type: 'prompt', message: 'first' },
              { id: 'quirky-check-2', type: 'get_commands' },
              { type: 'prompt', message: 'second' }
            ]
          : [
              { id: 'quirky-check-1', type: 'get_state' },
              { type: 'prompt', message: 'first' },
              { id: 'quirky-check-2', type: 'get_state' },
              { type: 'prompt', message: 'second' }
            ]
      expect(fake.commands()).toEqual(expectedCommands)
      expect(journal()).toEqual([
        ['user', 'first'],
        ['assistant', `${agent}: first`],
        ['result', `${agent} turn completed`],
        ['user', 'second'],
        ['assistant', `${agent}: second`],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'done', 'working', 'done'])
    })
  }

  test('pi deny-all checks a message sent during a turn before writing it', async () => {
    await runner.start(session, '[hold]', { toolPolicy: 'deny-all' })
    await until(() => fake.commands().some((command) => command.type === 'prompt'))
    await runner.send(session.id, 'focus')
    await until(settled)
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: '[hold]' },
      { id: 'quirky-check-2', type: 'get_commands' },
      { type: 'prompt', message: 'focus', streamingBehavior: 'steer' }
    ])
    expect(journal()).toEqual([
      ['user', '[hold]'],
      ['user', 'focus'],
      ['assistant', 'steered: focus'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'working', 'done'])
  })

  test('pi deny-all writes a queued message after the prompt before it is answered, behind its own check', async () => {
    await runner.start(session, '[hold]', { toolPolicy: 'deny-all' })
    await runner.send(session.id, 'focus')
    await until(settled)
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: '[hold]' },
      { id: 'quirky-check-2', type: 'get_commands' },
      { type: 'prompt', message: 'focus', streamingBehavior: 'steer' }
    ])
    expect(statuses).toEqual(['working', 'working', 'done'])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} deny-all: a message whose check outlasts the turn starts a new turn`, async () => {
      build(agent)
      await runner.start(session, '[hold] [settle-at-check]', { toolPolicy: 'deny-all' })
      await until(() => prompts().length === 1)
      await runner.send(session.id, 'second')
      await until(() => results().length === 2)

      expect(userCommands()).toEqual([
        { type: 'prompt', message: '[hold] [settle-at-check]' },
        { type: 'prompt', message: 'second', streamingBehavior: 'steer' }
      ])
      expect(journal()).toEqual([
        ['user', '[hold] [settle-at-check]'],
        ['user', 'second'],
        ['assistant', 'settled while the check waited'],
        ['result', `${agent} turn completed`],
        ['assistant', `${agent}: second`],
        ['result', `${agent} turn completed`]
      ])
      expect(results().map((result) => result.data)).toEqual([
        { type: 'agent_end', contextUsage: { contextTokens: 180, contextWindow: 200000 } },
        { type: 'agent_end', contextUsage: { contextTokens: 180, contextWindow: 200000 } }
      ])
      expect(statuses).toEqual(['working', 'working', 'done'])
    })

    test(`${agent}: a message that reaches a CLI that had just settled starts a new turn`, async () => {
      build(agent)
      await runner.start(session, '[hold]')
      await until(() => prompts().length === 1)
      await runner.send(session.id, 'second [late]')
      await until(() => results().length === 2)

      expect(userCommands()).toEqual([
        { type: 'prompt', message: '[hold]' },
        { type: 'prompt', message: 'second [late]', streamingBehavior: 'steer' }
      ])
      expect(journal()).toEqual([
        ['user', '[hold]'],
        ['user', 'second [late]'],
        ['assistant', 'settled before the message arrived'],
        ['result', `${agent} turn completed`],
        ['assistant', `${agent}: second [late]`],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'working', 'done'])
    })

    test(`${agent}: the next message is written only after the one before it is answered`, async () => {
      build(agent)
      await runner.start(session, 'first [slow-ack]')
      await runner.send(session.id, 'second')
      await until(() => results().length === 2)

      expect(fake.commands().filter((command) => command.type === 'prompt' || command.type === 'fake-answered')).toEqual([
        { type: 'prompt', message: 'first [slow-ack]' },
        { type: 'fake-answered', message: 'first [slow-ack]' },
        { type: 'prompt', message: 'second', streamingBehavior: 'steer' }
      ])
      expect(statuses).toEqual(['working', 'working', 'done'])
    })

    test(`${agent}: a rejected message during a run leaves the turn open`, async () => {
      build(agent)
      await runner.start(session, '[hold]')
      await until(() => prompts().length === 1)
      await runner.send(session.id, 'no [reject]')
      await until(() => messages.some((message) => message.role === 'system'))
      await runner.send(session.id, 'focus')
      await until(settled)

      expect(journal()).toEqual([
        ['user', '[hold]'],
        ['user', 'no [reject]'],
        ['system', `${agent} rejected prompt: scripted rejection`],
        ['user', 'focus'],
        ['assistant', 'steered: focus'],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'working', 'working', 'done'])
    })

    const marker = agent === 'pi' ? '[handled]' : '[no-agent]'
    test(`${agent}: a message the CLI handles by itself during a run leaves the turn open`, async () => {
      build(agent)
      await runner.start(session, '[hold]')
      await until(() => prompts().length === 1)
      await runner.send(session.id, `note ${marker}`)
      await until(() => prompts().length === 2)
      // Let the handled/no-agent reply reach the runner before checking the held turn.
      await Bun.sleep(100)
      expect(statuses).toEqual(['working', 'working'])

      await runner.send(session.id, 'focus')
      await until(settled)
      expect(journal()).toEqual([
        ['user', '[hold]'],
        ['user', `note ${marker}`],
        ['user', 'focus'],
        ['assistant', 'steered: focus'],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'working', 'working', 'done'])
    })

    const handled = agent === 'pi' ? '[handled]' : '[no-agent]'
    test(`${agent}: a first message the CLI handles by itself does not end the turn while another waits`, async () => {
      build(agent)
      await runner.start(session, `first ${handled} [slow-ack]`, { toolPolicy: 'deny-all' })
      await runner.send(session.id, 'second')
      await until(() => results().length === 1)

      expect(journal()).toEqual([
        ['user', `first ${handled} [slow-ack]`],
        ['user', 'second'],
        ['assistant', `${agent}: second`],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'working', 'done'])
    })
  }

  test('pi deny-all: a result written while a message waits takes its token count with it', async () => {
    await runner.start(session, '[hold] [settle-at-check]', { toolPolicy: 'deny-all' })
    await until(() => prompts().length === 1)
    await runner.send(session.id, '[tool]')
    await until(() => results().length === 2)

    expect(results().map((result) => result.data)).toEqual([
      { type: 'agent_end', contextUsage: { contextTokens: 180, contextWindow: 200000 } },
      { type: 'agent_end' }
    ])
    expect(statuses).toEqual(['working', 'working', 'done'])
  })

  test('pi deny-all: a turn that settles while a message waits takes its abort deadline with it', async () => {
    build('pi', undefined, { abortTimeoutMs: 300 })
    await runner.start(session, '[tool]', { toolPolicy: 'deny-all' })
    await runner.send(session.id, '[hold]')
    await until(() => prompts().length === 2)
    // Wait beyond the deadline to catch an abort timer carried into the next turn.
    await Bun.sleep(600)
    expect(journal()).toEqual([
      ['user', '[tool]'],
      ['user', '[hold]'],
      ['system', 'tools are disabled for this session'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'working'])
    expect(userCommands()).toEqual([
      { type: 'prompt', message: '[tool]' },
      { type: 'prompt', message: '[hold]', streamingBehavior: 'steer' }
    ])

    await runner.send(session.id, 'go')
    await until(settled)
    expect(journal()).toEqual([
      ['user', '[tool]'],
      ['user', '[hold]'],
      ['system', 'tools are disabled for this session'],
      ['result', 'pi turn completed'],
      ['user', 'go'],
      ['assistant', 'steered: go'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'working', 'working', 'done'])
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: '[tool]' },
      { id: 'quirky-check-2', type: 'get_commands' },
      { type: 'abort' },
      { type: 'prompt', message: '[hold]', streamingBehavior: 'steer' },
      { id: 'quirky-check-3', type: 'get_commands' },
      { type: 'prompt', message: 'go', streamingBehavior: 'steer' }
    ])
  })

  test('pi deny-all checks an idle session before a prompt arrives', async () => {
    build('pi', undefined, undefined, { commands: [] })
    await runner.start(session, undefined, { toolPolicy: 'deny-all' })
    await until(() => fake.commands().some((command) => command.type === 'get_commands'))
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' }
    ])
    expect(messages).toEqual([])
    expect(statuses).toEqual(['running'])
  })

  test('pi deny-all allows prompt templates and skills', async () => {
    build('pi', undefined, undefined, {
      commands: [
        { name: 'fix-tests', source: 'prompt' },
        { name: 'skill:review', source: 'skill' }
      ]
    })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: 'hello' }
    ])
    expect(statuses).toEqual(['working', 'done'])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} default policy does not check even when the CLI has tools`, async () => {
      build(
        agent,
        undefined,
        undefined,
        agent === 'pi'
          ? { commands: [{ name: 'llama', source: 'extension' }] }
          : { tools: ['mcp__a_b'] }
      )
      await runner.start(session, 'hello')
      await until(settled)
      expect(fake.commands()).toEqual([
        { id: 'quirky-state', type: 'get_state' },
        { type: 'prompt', message: 'hello' }
      ])
      expect(journal()).toEqual([
        ['user', 'hello'],
        ['assistant', `${agent}: hello`],
        ['result', `${agent} turn completed`]
      ])
      expect(statuses).toEqual(['working', 'done'])
    })
  }

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} deny-all fails its later check when a new tool appears`, async () => {
      build(
        agent,
        undefined,
        undefined,
        agent === 'pi' ? { commands: [] } : { tools: [] }
      )
      await runner.start(session, '[grow]', { toolPolicy: 'deny-all' })
      await until(() => messages.filter((message) => message.role === 'result').length === 1)
      await runner.send(session.id, 'second')
      await until(() => statuses.at(-1) === 'exited')
      const reason =
        agent === 'pi'
          ? 'pi loaded extensions in a session that must have no tools: late'
          : 'omp offers tools to a session that must have none: mcp__late_tool'
      expect(journal()).toEqual([
        ['user', '[grow]'],
        ['assistant', `${agent}: [grow]`],
        ['result', `${agent} turn completed`],
        ['user', 'second'],
        ['system', reason]
      ])
      expect(fake.commands().filter((command) => command.type === 'prompt')).toEqual([
        { type: 'prompt', message: '[grow]' }
      ])
      expect(statuses).toEqual(['working', 'done', 'working', 'exited'])
      await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
    })
  }

  test('omp deny-all exits when an idle session offers a tool', async () => {
    build('omp', undefined, undefined, { tools: ['mcp__a_b'] })
    await runner.start(session, undefined, { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['system', 'omp offers tools to a session that must have none: mcp__a_b']
    ])
    expect(fake.commands()).toEqual([{ id: 'quirky-check-1', type: 'get_state' }])
    expect(statuses).toEqual(['running', 'exited'])
    await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
  })


  test('spawns pi in rpc mode inside the worktree', async () => {
    await runner.start(session, 'hello')
    await until(() => fake.launch() !== null)
    expect(fake.launch()).toEqual({ argv: ['--mode', 'rpc'], cwd: home })
    expect(resolved).toEqual(['pi'])
  })

  test('omp resolves its own executable', async () => {
    build('omp')
    await runner.start(session, 'hello')
    await until(settled)
    expect(resolved).toEqual(['omp'])
  })

  test('sends the prompt, journals assistant text and settles on agent_settled', async () => {
    await runner.start(session, 'hello there')
    await until(settled)
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello there'],
      ['assistant', 'pi: hello there'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
    expect(fake.commands().find((c) => c.type === 'prompt')).toEqual({ type: 'prompt', message: 'hello there' })
  })

  test('agent_end alone leaves the pi turn working', async () => {
    await runner.start(session, '[end-only]')
    await until(() => messages.some((message) => message.role === 'assistant'))
    // the spawned fixture's timers cannot be advanced by Bun's fake clock
    await Bun.sleep(100)
    expect(messages.filter((message) => message.role === 'result')).toEqual([])
    expect(statuses).toEqual(['working'])
  })

  test('a pi retry after agent_end settles once after the second run', async () => {
    await runner.start(session, '[retry]')
    await until(() => messages.some((message) => message.role === 'system' && message.text === 'pi error: 529 overloaded'))
    expect(messages.filter((message) => message.role === 'result')).toHaveLength(0)
    expect(statuses).toEqual(['working'])

    await until(settled)
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', '[retry]'],
      ['system', 'pi error: 529 overloaded'],
      ['assistant', 'second try'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
    expect(fake.commands().map((command) => command.type)).toEqual(['get_state', 'prompt'])
  })

  test('omp settles a normal turn on session_settled', async () => {
    build('omp')
    await runner.start(session, 'hello omp')
    await until(settled)
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'hello omp'],
      ['assistant', 'omp: hello omp'],
      ['result', 'omp turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
  })

  test('omp stays working after prompt_result until background work settles', async () => {
    build('omp')
    await runner.start(session, '[background]')
    await until(() => messages.some((message) => message.role === 'assistant'))
    await Bun.sleep(100)
    expect(messages.filter((message) => message.role === 'result')).toEqual([])
    expect(statuses).toEqual(['working'])

    await until(settled)
    expect(messages.filter((message) => message.role === 'result')).toHaveLength(1)
    expect(statuses).toEqual(['working', 'done'])
  })

  test('omp keeps invoked prompt_result open even when sessionSettled is true', async () => {
    build('omp')
    await runner.start(session, '[settled-result]')
    await until(() => messages.some((message) => message.role === 'assistant'))
    // the spawned fixture owns the delayed settle frame, not this process's clock
    await Bun.sleep(100)
    expect(statuses).toEqual(['working'])
    expect(messages.filter((message) => message.role === 'result')).toEqual([])
    await runner.send(session.id, 'still working')
    await until(() =>
      fake.commands().some((command) => command.type === 'prompt' && command.streamingBehavior === 'steer')
    )
    expect(statuses).toEqual(['working', 'working'])
    await until(settled)
    await runner.send(session.id, 'next turn')
    await until(() => messages.filter((message) => message.role === 'result').length === 2)
    expect(fake.commands().filter((command) => command.type === 'prompt')).toEqual([
      { type: 'prompt', message: '[settled-result]' },
      { type: 'prompt', message: 'still working', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'next turn' }
    ])
    expect(statuses).toEqual(['working', 'working', 'done', 'working', 'done'])
  })

  test('omp closes a prompt that never reached the agent without a result', async () => {
    build('omp')
    await runner.start(session, '[no-agent]')
    await until(settled)
    expect(messages.filter((message) => message.role === 'result')).toEqual([])
    expect(statuses).toEqual(['working', 'done'])
  })

  test('omp ignores a duplicate no-agent prompt_result after the prompt closes', async () => {
    build('omp')
    await runner.start(session, '[no-agent] [twice]')
    await until(settled)
    // the duplicate is emitted by a timer in another process
    await Bun.sleep(100)
    expect(messages.map((message) => message.role)).toEqual(['user'])
    expect(statuses).toEqual(['working', 'done'])
  })

  test('pi closes a handled prompt without a result', async () => {
    await runner.start(session, '[handled]')
    await until(settled)
    expect(messages.filter((message) => message.role === 'result')).toEqual([])
    expect(statuses).toEqual(['working', 'done'])
  })

  for (const [agent, text] of [
    ['pi', 'note [handled]'],
    ['omp', 'note [no-agent]'],
    ['pi', 'no [reject]'],
    ['omp', 'no [reject]']
  ] as const) {
    test(`${agent}: after a finished turn, "${text}" ends its own turn at once`, async () => {
      build(agent)
      await runner.start(session, 'hello')
      await until(settled)
      await runner.send(session.id, text)
      await until(() => statuses.length === 4)
      expect(statuses).toEqual(['working', 'done', 'working', 'done'])
      expect(results()).toHaveLength(1)
    })
  }

  for (const [agent, marker] of [
    ['pi', '[queued]'],
    ['pi', 'started'],
    ['omp', 'no disposition']
  ] as const) {
    test(`${agent} keeps an accepted ${marker} prompt open until settlement`, async () => {
      build(agent)
      await runner.start(session, marker + ' [end-only]')
      await until(() => messages.some((message) => message.role === 'assistant'))
      await Bun.sleep(100)
      expect(messages.filter((message) => message.role === 'result')).toEqual([])
      expect(statuses).toEqual(['working'])
    })
  }

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} ignores duplicate settle frames after a turn closes`, async () => {
      build(agent)
      await runner.start(session, '[twice]')
      await until(settled)
      await Bun.sleep(100)
      expect(messages.filter((message) => message.role === 'result')).toHaveLength(1)
      expect(statuses).toEqual(['working', 'done'])
    })
  }

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} ignores settle and prompt_result frames without an initial prompt`, async () => {
      build(agent)
      await runner.start(session)
      await until(() => fake.commands().some((command) => command.type === 'get_state'))
      process.kill(await pidOf(), 'SIGUSR1')
      await until(() => existsSync(join(home, 'idle-frames-sent')))
      // allow the other process's flushed frames to reach the runner
      await Bun.sleep(100)
      expect(messages).toEqual([])
      expect(statuses).toEqual(['running'])
    })
  }

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} journals a message that arrives with no open turn and keeps its token count out of the next result`, async () => {
      build(agent)
      await runner.start(session, undefined, { toolPolicy: 'deny-all' })
      await until(() => fake.commands().some((command) => command.id === 'quirky-check-1'))
      process.kill(await pidOf(), 'SIGUSR2')
      await until(() => existsSync(join(home, 'wake-frames-sent')))
      await until(() => messages.length > 0)
      // allow the other process's flushed frames to reach the runner
      await Bun.sleep(100)
      expect(journal()).toEqual([['assistant', 'woke on its own']])
      expect(statuses).toEqual(['running'])
      await runner.send(session.id, '[tool]')
      await until(settled)
      expect(messages.filter((message) => message.role === 'result').map((message) => message.data)).toEqual([{ type: 'agent_end' }])
      expect(statuses).toEqual(['running', 'working', 'done'])
    })
  }

  test('starts idle without a prompt and runs a later send', async () => {
    await runner.start(session)
    expect(statuses).toEqual(['running'])
    await runner.send(session.id, 'later')
    await until(settled)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'result'])
  })

  test('a send after settlement starts a new prompt turn', async () => {
    await runner.start(session, 'first turn')
    const results = () => messages.filter((message) => message.role === 'result')
    await until(() => results().length === 1)

    await runner.send(session.id, 'second turn')
    await until(() => results().length === 2)
    expect(fake.commands().filter((command) => command.type === 'prompt')).toEqual([
      { type: 'prompt', message: 'first turn' },
      { type: 'prompt', message: 'second turn' }
    ])
    expect(statuses).toEqual(['working', 'done', 'working', 'done'])
  })

  test('omp ignores protocol frames that do not change the journal or need a reply', async () => {
    build('omp')
    await runner.start(session, 'ignore unused frames')
    await until(settled)
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'ignore unused frames'],
      ['assistant', 'omp: ignore unused frames'],
      ['result', 'omp turn completed']
    ])
    expect(fake.commands().some((command) => command.type === 'extension_ui_response')).toBe(false)
    expect(fake.commands().map((command) => command.type)).toEqual(['get_state', 'prompt'])
  })

  test('records context usage on the turn-ending message', async () => {
    await runner.start(session, 'usage')
    await until(settled)
    expect(messages.find((m) => m.role === 'result')?.data).toEqual({
      type: 'agent_end',
      contextUsage: { contextTokens: 180, contextWindow: 200000 }
    })
  })

  test('clears context usage before a turn with no token count', async () => {
    await runner.start(session, 'usage', { toolPolicy: 'deny-all' })
    const results = () => messages.filter((m) => m.role === 'result')
    await until(() => results().length === 1)
    expect(results()[0]?.data).toEqual({
      type: 'agent_end',
      contextUsage: { contextTokens: 180, contextWindow: 200000 }
    })

    await runner.send(session.id, '[tool]')
    await until(() => results().length === 2)
    expect(results()[1]?.data).toEqual({ type: 'agent_end' })
  })

  test('context window is null when the process does not report one', async () => {
    build('pi', null)
    await runner.start(session, 'usage')
    await until(settled)
    expect(contextUsageOfResult()).toEqual({ contextTokens: 180, contextWindow: null })
  })

  test('a later zero-usage message keeps the previous context footprint', async () => {
    await runner.start(session, '[zero-last]')
    await until(settled)
    expect(contextUsageOfResult()).toEqual({ contextTokens: 180, contextWindow: 200000 })
    expect(messages.filter((message) => message.role === 'system').map((message) => message.text)).toEqual([
      'pi error: boom'
    ])
  })

  test('journals tool execution when tools are allowed', async () => {
    await runner.start(session, '[tool] [allowed]')
    await until(settled)
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.text)).toEqual(['bash: ls -la', 'file.txt'])
  })

  test('a message sent while working goes out as a prompt the CLI may steer with', async () => {
    await runner.start(session, '[hold]')
    await until(() => fake.commands().some((c) => c.type === 'prompt'))
    await runner.send(session.id, 'focus')
    await until(settled)
    expect(userCommands()).toEqual([
      { type: 'prompt', message: '[hold]' },
      { type: 'prompt', message: 'focus', streamingBehavior: 'steer' }
    ])
    expect(messages.find((message) => message.role === 'user' && message.text === 'focus')?.data).toEqual({
      type: 'prompt',
      message: 'focus',
      streamingBehavior: 'steer'
    })
    expect(messages.find((m) => m.role === 'assistant')?.text).toBe('steered: focus')
  })

  test('extension dialogs are cancelled and never become asks', async () => {
    await runner.start(session, '[ui]')
    await until(settled)
    expect(asks).toEqual([])
    expect(fake.commands().find((c) => c.type === 'extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true
    })
  })

  test('a rejected prompt is journaled and leaves the session done', async () => {
    await runner.start(session, '[reject]')
    await until(settled)
    expect(messages.some((m) => m.role === 'system' && m.text.includes('scripted rejection'))).toBe(true)
  })

  test('deny-all starts with no tools and refuses a tool that runs anyway', async () => {
    await runner.start(session, '[tool]', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.launch()?.argv).toEqual(['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-mcp'])
    expect(fake.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(messages.filter((m) => m.role === 'tool')).toEqual([])
    expect(messages.some((m) => m.role === 'system' && m.text === 'tools are disabled for this session')).toBe(true)
    expect(messages.find((m) => m.role === 'result')?.data).toEqual({ type: 'agent_end' })
    expect(asks).toEqual([])
  })
  test('pi deny-all puts --no-mcp before a selected model', async () => {
    await runner.start(session, 'hello', { toolPolicy: 'deny-all', model: 'picked-model' })
    await until(settled)
    expect(fake.launch()?.argv).toEqual([
      '--mode',
      'rpc',
      '--no-tools',
      '--no-extensions',
      '--no-mcp',
      '--model',
      'picked-model'
    ])
  })

  test('deny-all on omp also starts with no extensions, since --no-tools only drops built-in tools', async () => {
    build('omp')
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.launch()?.argv).toEqual(['--mode', 'rpc', '--no-tools', '--no-extensions'])
  })
  test('an older pi rejects --no-mcp and exits through the normal stderr path', async () => {
    writeFileSync(fake.executable, `#!/bin/sh
case " $* " in
  *" --no-mcp "*)
    printf '%s\\n' 'Error: Unknown option: --no-mcp' >&2
    exit 1
    ;;
esac
exit 0
`, { mode: 0o700 })
    chmodSync(fake.executable, 0o700)
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => statuses.at(-1) === 'exited')
    expect(journal()).toEqual([
      ['user', 'hello'],
      ['system', 'pi exited with code 1; stderr: Error: Unknown option: --no-mcp']
    ])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('omp deny-all aborts and settles after a tool starts', async () => {
    build('omp')
    await runner.start(session, '[tool]', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.commands().some((command) => command.type === 'abort')).toBe(true)
    expect(messages.some((message) => message.role === 'system' && message.text === 'tools are disabled for this session')).toBe(true)
    expect(messages.find((message) => message.role === 'result')?.data).toEqual({ type: 'agent_end' })
    expect(statuses).toEqual(['working', 'done'])
  })
  test('pi deny-all clears the abort deadline when a tool-start turn settles', async () => {
    build('pi', undefined, { abortTimeoutMs: 500 })
    await runner.start(session, '[tool]', { toolPolicy: 'deny-all' })
    await until(settled)
    // The spawned RPC fixture owns a separate clock, so exercise the real abort deadline.
    await Bun.sleep(700)
    expect(journal()).toEqual([
      ['user', '[tool]'],
      ['system', 'tools are disabled for this session'],
      ['result', 'pi turn completed']
    ])
    expect(statuses).toEqual(['working', 'done'])
  })

  test('pi deny-all keeps one abort deadline when a second tool starts', async () => {
    build('pi', undefined, { abortTimeoutMs: 300 })
    await runner.start(session, '[tool] [double]', { toolPolicy: 'deny-all' })
    await until(settled)
    // Wait past twice the deadline to catch a timer restarted by the second tool start.
    await Bun.sleep(600)
    expect(journal()).toEqual([
      ['user', '[tool] [double]'],
      ['system', 'tools are disabled for this session'],
      ['system', 'tools are disabled for this session'],
      ['result', 'pi turn completed']
    ])
    expect(fake.commands().filter((command) => command.type === 'abort')).toHaveLength(2)
    expect(statuses).toEqual(['working', 'done'])
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} deny-all exits when a tool-start abort stays stuck`, async () => {
      build(agent, undefined, { abortTimeoutMs: 150 })
      await runner.start(session, '[tool] [stuck]', { toolPolicy: 'deny-all' })
      await until(() => statuses.at(-1) === 'exited')
      expect(journal()).toEqual([
        ['user', '[tool] [stuck]'],
        ['system', 'tools are disabled for this session'],
        ['system', `${agent} did not stop after a tool started`]
      ])
      expect(fake.commands().filter((command) => command.type === 'abort')).toHaveLength(1)
      expect(messages.filter((message) => message.role === 'result')).toEqual([])
      expect(statuses).toEqual(['working', 'exited'])
      await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
    })
  }

  test('pi deny-all ignores a not-found tool result and checks the next send', async () => {
    await runner.start(session, '[tool] [missing]', { toolPolicy: 'deny-all' })
    await until(settled)
    await runner.send(session.id, 'second')
    await until(() => messages.filter((message) => message.role === 'result').length === 2)
    expect(journal()).toEqual([
      ['user', '[tool] [missing]'],
      ['system', 'tools are disabled for this session'],
      ['result', 'pi turn completed'],
      ['user', 'second'],
      ['assistant', 'pi: second'],
      ['result', 'pi turn completed']
    ])
    expect(fake.commands()).toEqual([
      { id: 'quirky-state', type: 'get_state' },
      { id: 'quirky-check-1', type: 'get_commands' },
      { type: 'prompt', message: '[tool] [missing]' },
      { type: 'abort' },
      { id: 'quirky-check-2', type: 'get_commands' },
      { type: 'prompt', message: 'second' }
    ])
    expect(messages.some((message) => message.role === 'tool')).toBe(false)
    expect(statuses).toEqual(['working', 'done', 'working', 'done'])
  })

  for (const [marker, output, isError] of [
    ['[tool] [allowed]', 'file.txt', false],
    ['[tool] [failed]', 'exit 1', true],
    ['[tool] [missing-ok]', 'Tool bash not found', false],
  ] as const) {
    test(`pi deny-all ends and journals when a tool result is ${output}`, async () => {
      await runner.start(session, marker, { toolPolicy: 'deny-all' })
      await until(() => statuses.at(-1) === 'exited')
      expect(journal()).toEqual([
        ['user', marker],
        ['system', 'tools are disabled for this session'],
        ['tool', output],
        ['system', 'pi ran bash in a session that must have no tools']
      ])
      expect(messages.filter((message) => message.role === 'tool')[0]?.data).toEqual({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: output }] },
        isError
      })
      expect(messages.filter((message) => message.role === 'result')).toEqual([])
      expect(statuses).toEqual(['working', 'exited'])
      await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
    })
  }

  test('default policy journals tool starts and results without aborting', async () => {
    await runner.start(session, '[tool] [allowed]')
    await until(settled)
    expect(journal()).toEqual([
      ['user', '[tool] [allowed]'],
      ['tool', 'bash: ls -la'],
      ['tool', 'file.txt'],
      ['assistant', 'listed'],
      ['result', 'pi turn completed']
    ])
    expect(fake.commands().some((command) => command.type === 'abort')).toBe(false)
  })

  test('stopping during a pending check drops its timeout diagnostic', async () => {
    build('pi', undefined, { checkTimeoutMs: 150 }, { check: 'silent' })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await runner.stop(session.id)
    // Wait past the real check deadline to ensure stop cleared it.
    await Bun.sleep(300)
    expect(messages.filter((message) => message.role === 'system')).toEqual([])
    expect(statuses).toEqual(['working', 'exited'])
  })

  test('a process exit during a pending check prevents its timeout diagnostic', async () => {
    build('pi', undefined, { checkTimeoutMs: 1000 }, { check: 'silent' })
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => fake.commands().some((command) => command.type === 'get_commands'))
    process.kill(-(await pidOf()), 'SIGKILL')
    await until(() => statuses.at(-1) === 'exited')
    // Wait past the real check deadline; the spawned process and runner use separate clocks.
    await Bun.sleep(1200)
    const systemMessages = messages.filter((message) => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]?.text.startsWith('pi exited')).toBe(true)
    expect(journal()[0]).toEqual(['user', 'hello'])
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send(session.id, 'later')).rejects.toThrow('session is not running')
  })


  test('assistant text survives a multibyte character split across stdout chunks', async () => {
    await runner.start(session, '[split]')
    await until(settled)
    expect(messages.find((m) => m.role === 'assistant')?.text).toBe('caf\u00e9 \u2615')
  })

  for (const agent of ['pi', 'omp'] as const) {
    test(`${agent} settles after reading a frame larger than 4 MiB`, async () => {
      build(agent)
      await runner.start(session, '[big]')
      await until(settled)
      expect(messages.find((message) => message.role === 'assistant')?.text).toBe('big')
      expect(messages.filter((message) => message.role === 'result')).toHaveLength(1)
      expect(messages.filter((message) => message.role === 'system')).toEqual([])
    })
  }

  test('reads CRLF-terminated frames and skips a blank CRLF line', async () => {
    await runner.start(session, '[crlf]')
    await until(settled)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'result'])
    expect(statuses).toEqual(['working', 'done'])
  })

  test('an over-limit unterminated frame exits once and rejects later sends', async () => {
    build('pi', undefined, { maxFrameBytes: 1024 * 1024 })
    await runner.start(session, '[flood]')
    const pidsPath = join(home, 'flood-pids.json')
    await until(() => existsSync(pidsPath))
    const pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as { parent: number; child: number }
    try {
      const signalsPath = join(home, 'flood-signals')
      await until(() => {
        if (!existsSync(signalsPath)) return false
        const signals = readFileSync(signalsPath, 'utf8')
        return signals.includes('child\n') && signals.includes('parent\n')
      })
      expect(readFileSync(signalsPath, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['child', 'parent'])
      expect(process.kill(pids.parent, 0)).toBe(true)
      expect(process.kill(pids.child, 0)).toBe(true)
      await until(() => statuses.at(-1) === 'exited', 1000)
      await until(() => {
        try { process.kill(pids.child, 0); return false } catch { return true }
      }, 1000)
      expect(() => process.kill(pids.parent, 0)).toThrow()
    } finally {
      try { process.kill(-pids.parent, 'SIGKILL') } catch {}
    }

    const systemMessages = () => messages.filter((message) => message.role === 'system')
    expect(systemMessages().map((message) => message.text)).toEqual(['pi sent an rpc frame too large to read'])
    expect(statuses.at(-1)).toBe('exited')
    await expect(runner.send(session.id, 'too late')).rejects.toThrow('session is not running')
    // process-close output is asynchronous and must not append a second diagnostic
    await Bun.sleep(300)
    expect(systemMessages()).toHaveLength(1)
  }, 15_000)

  test('an unreadable JSON line is journaled, and an empty line and a non-object value are ignored', async () => {
    await runner.start(session, '[unreadable]')
    await until(settled)
    expect(messages.filter((message) => message.role === 'system').map((message) => message.text)).toEqual([
      'unreadable pi output: invalid-json'
    ])
    expect(messages.filter((message) => message.role === 'result')).toHaveLength(1)
  })

  test('refuses an agent other than pi or omp and refuses resume', async () => {
    await expect(runner.start({ ...session, agent: 'claude' }, 'x')).rejects.toThrow('support pi and omp only')
    await expect(runner.start(session, 'x', { providerSession: { id: 'p', transcriptPath: null } })).rejects.toThrow('cannot be resumed')
  })

  test('stop ends the process and reports exited; a later send fails', async () => {
    await runner.start(session)
    await runner.stop(session.id)
    expect(statuses.at(-1)).toBe('exited')
    await expect(runner.send(session.id, 'x')).rejects.toThrow('not running')
  })

  test('an unexpected process exit is journaled and exits the session', async () => {
    await runner.start(session, '[hold]')
    await until(() => fake.commands().some((command) => command.type === 'prompt'))
    process.kill(-(await pidOf()), 'SIGKILL')
    await until(() => statuses.at(-1) === 'exited')
    expect(messages.some((m) => m.role === 'system' && m.text.startsWith('pi exited'))).toBe(true)
  })

  test('resolves an executable after login-shell profile noise and records shell arguments', async () => {
    const shell = writeStandInShell('login-shell', `printf '%s\\n' "$@" > "\${0%/*}/args"
printf '%s\\n' 'profile noise' '/opt/tools/omp'
`)
    await expect(resolvePiThroughLoginShell(shell, 'omp')).resolves.toBe('/opt/tools/omp')
    expect(readFileSync(join(home, 'args'), 'utf8').trimEnd().split('\n')).toEqual([
      '-l',
      '-c',
      'command -v omp'
    ])
  })

  test('rejects login shells that fail, return only a blank line, or exit unsuccessfully after a path', async () => {
    const cases = [
      ['login-exit-1', 'exit 1\n'],
      ['login-empty', `printf '%s\\n' ''\n`],
      ['login-exit-3', `printf '%s\\n' '/opt/tools/pi'\nexit 3\n`]
    ] as const
    for (const [name, body] of cases) {
      const shell = writeStandInShell(name, body)
      await expect(resolvePiThroughLoginShell(shell, 'pi')).rejects.toThrow(
        'could not find the pi executable on the login shell PATH'
      )
    }
  })

  test('rejects when the login shell executable does not exist', async () => {
    await expect(resolvePiThroughLoginShell(join(home, 'missing-login-shell'), 'pi')).rejects.toThrow()
  })

  test('start fails clearly when no executable resolver exists', async () => {
    const bare = createPiRunner({ appendMessage: () => ({}) as StructuredMessage, setStatus() {}, createAsk: async () => ({}) as AskEnvelope, setProviderSession: async () => {}, resolveClaudePath: async () => '', resolveCodexPath: async () => '' })
    await expect(bare.start(session, 'x')).rejects.toThrow('resolve the pi executable')
  })
})

async function pidOf(): Promise<number> {
  const out = await Bun.$`pgrep -f ${fake.executable}`.text()
  return Number(out.trim().split('\n')[0])
}
