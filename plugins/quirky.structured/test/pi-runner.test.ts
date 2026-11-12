import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createPiRunner } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { createFakePiRpc, type FakePiRpcFixture } from './fakes/fake-pi-rpc'

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
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

function build(agent: 'pi' | 'omp' = 'pi', contextWindow?: number | null) {
  fake = createFakePiRpc(home, contextWindow === undefined ? {} : { contextWindow })
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
  runner = createPiRunner(context)
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
const contextUsageOfResult = () =>
  (messages.find((m) => m.role === 'result')?.data as { contextUsage?: unknown } | undefined)?.contextUsage

describe('pi rpc runner', () => {
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

  test('sends the prompt, journals assistant text and settles on agent_end', async () => {
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

  test('starts idle without a prompt and runs a later send', async () => {
    await runner.start(session)
    expect(statuses).toEqual(['running'])
    await runner.send(session.id, 'later')
    await until(settled)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'result'])
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

  test('journals tool execution when tools are allowed', async () => {
    await runner.start(session, '[tool] [allowed]')
    await until(settled)
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.text)).toEqual(['bash: ls -la', 'file.txt'])
  })

  test('a steer while working goes out as a steer command', async () => {
    await runner.start(session, '[hold]')
    await until(() => fake.commands().some((c) => c.type === 'prompt'))
    await runner.send(session.id, 'focus')
    await until(settled)
    expect(fake.commands().find((c) => c.type === 'steer')).toEqual({ type: 'steer', message: 'focus' })
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
    expect(fake.launch()?.argv).toEqual(['--mode', 'rpc', '--no-tools', '--no-extensions'])
    expect(fake.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(messages.filter((m) => m.role === 'tool')).toEqual([])
    expect(messages.some((m) => m.role === 'system' && m.text === 'tools are disabled for this session')).toBe(true)
    expect(messages.find((m) => m.role === 'result')?.data).toEqual({ type: 'agent_end' })
    expect(asks).toEqual([])
  })

  test('deny-all on omp also starts with no extensions, since --no-tools only drops built-in tools', async () => {
    build('omp')
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.launch()?.argv).toEqual(['--mode', 'rpc', '--no-tools', '--no-extensions'])
  })

  test('assistant text survives a multibyte character split across stdout chunks', async () => {
    await runner.start(session, '[split]')
    await until(settled)
    expect(messages.find((m) => m.role === 'assistant')?.text).toBe('caf\u00e9 \u2615')
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
    await runner.start(session)
    process.kill(-(await pidOf()), 'SIGKILL')
    await until(() => statuses.at(-1) === 'exited')
    expect(messages.some((m) => m.role === 'system' && m.text.startsWith('pi exited'))).toBe(true)
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
