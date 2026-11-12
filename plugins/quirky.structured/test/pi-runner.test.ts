import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createPiRunner } from '../pi-runner'
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
  limits?: { maxFrameBytes?: number }
) {
  fake = createFakePiRpc(home, { ...(contextWindow === undefined ? {} : { contextWindow }), flavor: agent })
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
    await until(() => fake.commands().some((command) => command.type === 'steer'))
    expect(statuses).toEqual(['working', 'working'])
    await until(settled)
    await runner.send(session.id, 'next turn')
    await until(() => messages.filter((message) => message.role === 'result').length === 2)
    expect(fake.commands().filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual([
      '[settled-result]', 'next turn'
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

  test('omp deny-all aborts and settles after a tool starts', async () => {
    build('omp')
    await runner.start(session, '[tool]', { toolPolicy: 'deny-all' })
    await until(settled)
    expect(fake.commands().some((command) => command.type === 'abort')).toBe(true)
    expect(messages.some((message) => message.role === 'system' && message.text === 'tools are disabled for this session')).toBe(true)
    expect(messages.find((message) => message.role === 'result')?.data).toEqual({ type: 'agent_end' })
    expect(statuses).toEqual(['working', 'done'])
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

  test('reads CRLF-terminated frames', async () => {
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

  test('an unreadable JSON line is journaled and a non-object value is ignored', async () => {
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

  test('start fails clearly when no executable resolver exists', async () => {
    const bare = createPiRunner({ appendMessage: () => ({}) as StructuredMessage, setStatus() {}, createAsk: async () => ({}) as AskEnvelope, setProviderSession: async () => {}, resolveClaudePath: async () => '', resolveCodexPath: async () => '' })
    await expect(bare.start(session, 'x')).rejects.toThrow('resolve the pi executable')
  })
})

async function pidOf(): Promise<number> {
  const out = await Bun.$`pgrep -f ${fake.executable}`.text()
  return Number(out.trim().split('\n')[0])
}
