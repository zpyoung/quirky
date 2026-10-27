import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { LaunchHookInput, PluginContext } from '@quirky/protocol'
import { SUPPRESSION_PROMPT } from '../src/core/claude-flags'
import { ClaudeVersionGate, commandProbe, suppressionHook } from '../suppression'

const FAKE_AGENT = resolve(import.meta.dir, '../../quirky.agents/test/support/fake-agent.ts')
const THIRTY_MINUTES = 30 * 60_000

function clock(start = 1_000_000) {
  let value = start
  return { now: () => value, advance: (ms: number) => void (value += ms) }
}

function probeOf(outputs: (string | null)[]) {
  const calls: string[] = []
  const probe = async (command: string) => {
    calls.push(command)
    return outputs.length > 1 ? outputs.shift()! : outputs[0]!
  }
  return { probe, calls }
}

describe('ClaudeVersionGate', () => {
  test('a passing verdict is cached for the gate life, however much time passes', async () => {
    const time = clock()
    const { probe, calls } = probeOf(['2.1.0 (Claude Code)'])
    const gate = new ClaudeVersionGate(probe, time.now)
    expect(await gate.allows('claude')).toBe(true)
    time.advance(24 * 60 * 60_000)
    expect(await gate.allows('claude')).toBe(true)
    expect(calls).toEqual(['claude'])
  })

  test('a failing verdict is kept for 30 minutes, then probed again', async () => {
    const time = clock()
    const { probe, calls } = probeOf(['1.0.50', '1.0.51'])
    const gate = new ClaudeVersionGate(probe, time.now)
    expect(await gate.allows('claude')).toBe(false)
    time.advance(THIRTY_MINUTES - 1)
    expect(await gate.allows('claude')).toBe(false)
    expect(calls).toHaveLength(1)
    time.advance(1)
    expect(await gate.allows('claude')).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('a timeout, a throw and unreadable output all fail', async () => {
    const time = clock()
    const timedOut = new ClaudeVersionGate(async () => null, time.now)
    expect(await timedOut.allows('claude')).toBe(false)
    const thrown = new ClaudeVersionGate(async () => {
      throw new Error('boom')
    }, time.now)
    expect(await thrown.allows('claude')).toBe(false)
    const garbage = new ClaudeVersionGate(async () => 'not a version', time.now)
    expect(await garbage.allows('claude')).toBe(false)
  })

  test('concurrent calls for one command share one probe', async () => {
    let release!: (output: string) => void
    let calls = 0
    const gate = new ClaudeVersionGate(() => {
      calls++
      return new Promise<string>((resolveProbe) => (release = resolveProbe))
    }, clock().now)
    const first = gate.allows('claude')
    const second = gate.allows('claude')
    release('2.0.0')
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toBe(1)
  })

  test('each command has its own verdict', async () => {
    const calls: string[] = []
    const gate = new ClaudeVersionGate(async (command) => {
      calls.push(command)
      return command === 'claude' ? '2.0.0' : '1.0.0'
    }, clock().now)
    expect(await gate.allows('claude')).toBe(true)
    expect(await gate.allows('claude-old')).toBe(false)
    expect(calls).toEqual(['claude', 'claude-old'])
  })
})

function hookInput(overrides: Partial<LaunchHookInput> = {}): LaunchHookInput {
  return { sessionId: 's1', worktreeId: 'w1', repoId: 'r1', cwd: '/tmp', agent: 'claude', env: {}, args: [], ...overrides }
}

function contextFor(agent: { command: string; args: string } | Error): PluginContext {
  return {
    call: async (method: string) => {
      if (method !== 'quirky.agents/get') throw new Error(`unexpected call ${method}`)
      if (agent instanceof Error) throw agent
      return agent
    }
  } as unknown as PluginContext
}

const passing = () => new ClaudeVersionGate(async () => '2.1.0 (Claude Code)', clock().now)
const failing = () => new ClaudeVersionGate(async () => '1.0.50', clock().now)

describe('suppressionHook', () => {
  test('returns both pairs when the gate passes', async () => {
    const hook = suppressionHook(contextFor({ command: 'claude', args: '' }), passing())
    expect(await hook(hookInput())).toEqual({
      args: ['--disallowedTools', 'AskUserQuestion', '--append-system-prompt', SUPPRESSION_PROMPT]
    })
  })

  test('returns {} when the gate fails', async () => {
    const hook = suppressionHook(contextFor({ command: 'claude', args: '' }), failing())
    expect(await hook(hookInput())).toEqual({})
  })

  test('returns {} and does not throw when quirky.agents/get throws', async () => {
    const hook = suppressionHook(contextFor(new Error('no such agent')), passing())
    expect(await hook(hookInput())).toEqual({})
  })

  test('returns {} when the configured text does not tokenize', async () => {
    const hook = suppressionHook(contextFor({ command: 'claude', args: '--model "unterminated' }), passing())
    expect(await hook(hookInput())).toEqual({})
  })

  test('returns {} when the agent record has no command', async () => {
    const hook = suppressionHook(contextFor({ command: undefined, args: undefined } as never), passing())
    expect(await hook(hookInput())).toEqual({})
  })

  test('SC-26: configured aliases already cover both flags, so no pair is added', async () => {
    const hook = suppressionHook(
      contextFor({ command: 'claude', args: '--disallowed-tools=Bash --append-system-prompt-file p.md' }),
      passing()
    )
    expect(await hook(hookInput())).toEqual({ args: [] })
  })

  test('flags in the command string and in earlier hook args count too', async () => {
    const hook = suppressionHook(contextFor({ command: "claude --append-system-prompt 'be terse'", args: '' }), passing())
    expect(await hook(hookInput({ args: ['--disallowedTools', 'Bash'] }))).toEqual({ args: [] })
    expect(await hook(hookInput())).toEqual({ args: ['--disallowedTools', 'AskUserQuestion'] })
  })

  test('probes the configured command string, with the hook input as identity', async () => {
    const seen: unknown[] = []
    const gate = new ClaudeVersionGate(async (command, identity) => {
      seen.push([command, identity])
      return '2.1.0'
    }, clock().now)
    const hook = suppressionHook(contextFor({ command: '/opt/bin/claude --flag', args: '' }), gate)
    await hook(hookInput())
    expect(seen).toEqual([['/opt/bin/claude --flag', { sessionId: 's1', worktreeId: 'w1' }]])
  })
})

describe('commandProbe', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function installFake(behavior: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'qa-ask-probe-'))
    dirs.push(dir)
    const home = join(dir, 'home')
    mkdirSync(home)
    const launcher = join(dir, 'claude')
    writeFileSync(launcher, `#!${process.execPath}\nimport ${JSON.stringify(FAKE_AGENT)}\n`)
    chmodSync(launcher, 0o755)
    writeFileSync(`${launcher}.json`, JSON.stringify(behavior))
    const envInputs: unknown[] = []
    const context = {
      launch: {
        commandArgv: (command: string) => ['/bin/sh', '-c', `exec ${command}`],
        env: (input: unknown) => {
          envInputs.push(input)
          return { HOME: home, PATH: '/usr/bin:/bin' }
        }
      }
    } as unknown as PluginContext
    return { launcher, context, envInputs, log: () => readFileSync(`${launcher}.log.jsonl`, 'utf8') }
  }

  test('reads the stdout of the fake agent started with --version', async () => {
    const fake = installFake({ version: { stdout: '2.1.0 (Claude Code)\n' } })
    const output = await commandProbe(fake.context)(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })
    expect(output).toBe('2.1.0 (Claude Code)\n')
    expect(fake.envInputs).toEqual([{ sessionId: 's1', worktreeId: 'w1', agent: 'claude' }])
    expect(JSON.parse(fake.log().trim().split('\n')[0]!)).toMatchObject({ type: 'start', argv: ['--version'] })
  })

  test('a non-zero exit is null', async () => {
    const fake = installFake({ version: { stdout: '2.1.0', exitCode: 1 } })
    expect(await commandProbe(fake.context)(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
  })

  test('a probe that outlives the timeout is killed and returns null', async () => {
    const fake = installFake({})
    const started = Date.now()
    expect(await commandProbe(fake.context, { timeoutMs: 200 })(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test('shell syntax in the configured command is never interpreted', async () => {
    const fake = installFake({ version: { stdout: '2.1.0' } })
    const pwned = join(dirname(fake.launcher), 'pwned')
    const identity = { sessionId: 's1', worktreeId: 'w1' }
    for (const command of [`${fake.launcher}; touch ${pwned}`, `${fake.launcher} $(touch ${pwned})`, `${fake.launcher} \`touch ${pwned}\``, `${fake.launcher} && touch ${pwned}`]) {
      await commandProbe(fake.context, { timeoutMs: 300 })(command, identity)
    }
    expect(existsSync(pwned)).toBe(false)
  })

  test('a command whose path has a space or a quote still runs', async () => {
    const fake = installFake({ version: { stdout: '2.1.0' } })
    for (const name of ['my dir', "it's"]) {
      const dir = join(dirname(fake.launcher), name)
      mkdirSync(dir)
      const launcher = join(dir, 'claude')
      copyFileSync(fake.launcher, launcher)
      copyFileSync(`${fake.launcher}.json`, `${launcher}.json`)
      const probe = commandProbe(fake.context)
      expect(await probe(`'${launcher.replaceAll("'", "'\\''")}'`, { sessionId: 's1', worktreeId: 'w1' })).toBe('2.1.0')
      expect(await probe(launcher.replaceAll(/([ '])/g, '\\$1'), { sessionId: 's1', worktreeId: 'w1' })).toBe('2.1.0')
    }
  })

  test('a command that does not tokenize is null without starting a process', async () => {
    const fake = installFake({ version: { stdout: '2.1.0' } })
    expect(await commandProbe(fake.context)(`${fake.launcher} "open`, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    expect(existsSync(`${fake.launcher}.log.jsonl`)).toBe(false)
  })

  test('a missing command or a throwing context is null', async () => {
    const fake = installFake({})
    expect(await commandProbe(fake.context)('/nonexistent/claude', { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    const broken = { launch: { commandArgv: () => { throw new Error('no shell') }, env: () => ({}) } } as unknown as PluginContext
    expect(await commandProbe(broken)('claude', { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
  })
})
