import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { LaunchHookInput, PluginContext, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
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
  return { sessionId: 's1', worktreeId: 'w1', repoId: 'r1', cwd: '/tmp', agent: 'claude', env: {}, args: [], jsonArgs: {}, ...overrides }
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
  const processRunners: OwnedProcessRunner[] = []
  const escapedPidFiles: string[] = []
  let nextRunnerId = 0

  function makeProcessRunner(): OwnedProcessRunner {
    const runner = createProcessRunner({ owner: `ask-probe-test-${++nextRunnerId}` })
    processRunners.push(runner)
    return runner
  }

  function killEscapedChildren(): void {
    for (const pidFile of escapedPidFiles.splice(0)) {
      if (!existsSync(pidFile)) continue
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }

  afterEach(async () => {
    killEscapedChildren()
    await Promise.all(processRunners.splice(0).map((runner) => runner.dispose()))
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
      process: makeProcessRunner(),
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

  function runResult(overrides: Partial<RunResult> = {}): RunResult {
    const stdoutText = overrides.stdoutText ?? '2.1.310 (Claude Code)\n'
    return {
      stdout: Buffer.from(stdoutText),
      stdoutText,
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      ...overrides
    }
  }

  function recordingContext(
    run: ProcessRunner['run'] = async () => runResult(),
    launchOverrides: {
      commandArgv?: (line: string) => string[]
      env?: (metadata: unknown) => Record<string, string>
    } = {}
  ) {
    const calls: { argv: string[]; options?: RunOptions }[] = []
    const commandArgvCalls: string[] = []
    const envInputs: unknown[] = []
    const env = { HOME: '/probe/home', PATH: '/probe/bin' }
    const processRunner: ProcessRunner = {
      run: async (argv, options) => {
        calls.push({ argv: [...argv], options })
        return run(argv, options)
      }
    }
    const context = {
      process: processRunner,
      launch: {
        commandArgv: (line: string) => {
          commandArgvCalls.push(line)
          return launchOverrides.commandArgv?.(line) ?? ['/bin/sh', '-l', '-c', line]
        },
        env: (metadata: unknown) => {
          envInputs.push(metadata)
          return launchOverrides.env?.(metadata) ?? env
        }
      }
    } as unknown as PluginContext
    return { context, calls, commandArgvCalls, envInputs, env }
  }

  function expectRunCall(
    call: { argv: string[]; options?: RunOptions },
    env: Record<string, string>,
    timeoutMs: number
  ): void {
    expect(call.argv).toEqual(['/bin/sh', '-l', '-c', "'claude' '--version'"])
    expect(call.options).toBeDefined()
    const { signal, ...options } = call.options!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(options).toEqual({ env, timeoutMs, killGraceMs: 0, maxOutputBytes: 1048576 })
  }

  const identity = { sessionId: 's', worktreeId: 'w' }

  test('runs the version command with exact runner options and launch metadata', async () => {
    const fake = recordingContext()
    const output = '2.1.310 (Claude Code)\n'
    expect(await commandProbe(fake.context)('claude', identity)).toBe(output)
    expect(await commandProbe(fake.context, { timeoutMs: 200 })('claude', identity)).toBe(output)
    expect(fake.commandArgvCalls).toEqual(["'claude' '--version'", "'claude' '--version'"])
    expect(fake.envInputs).toEqual([
      { sessionId: 's', worktreeId: 'w', agent: 'claude' },
      { sessionId: 's', worktreeId: 'w', agent: 'claude' }
    ])
    expect(fake.calls).toHaveLength(2)
    expectRunCall(fake.calls[0]!, fake.env, 3000)
    expectRunCall(fake.calls[1]!, fake.env, 200)
  })

  test('returns null for every unsuccessful runner result', async () => {
    const failures = [
      runResult({ exitCode: 1 }),
      runResult({ exitCode: null, stopped: 'timeout' }),
      runResult({ exitCode: null, stopped: 'aborted' }),
      runResult({ exitCode: null, stopped: 'overflow' }),
      runResult({ exitCode: null, spawnError: { code: 'ENOENT', message: 'missing' } })
    ]
    for (const failure of failures) {
      const fake = recordingContext(async () => failure)
      expect(await commandProbe(fake.context)('claude', identity)).toBeNull()
      expect(fake.calls).toHaveLength(1)
    }
  })

  test('returns null when the runner rejects', async () => {
    const fake = recordingContext(async () => {
      throw new Error('runner disposed')
    })
    expect(await commandProbe(fake.context)('claude', identity)).toBeNull()
    expect(fake.calls).toHaveLength(1)
  })

  test('returns null when launch throws or the command does not tokenize', async () => {
    const commandArgvFailure = recordingContext(undefined, {
      commandArgv: () => {
        throw new Error('no shell')
      }
    })
    expect(await commandProbe(commandArgvFailure.context)('claude', identity)).toBeNull()
    expect(commandArgvFailure.calls).toHaveLength(0)

    const envFailure = recordingContext(undefined, {
      env: () => {
        throw new Error('no environment')
      }
    })
    expect(await commandProbe(envFailure.context)('claude', identity)).toBeNull()
    expect(envFailure.calls).toHaveLength(0)

    const unclosedQuote = recordingContext()
    expect(await commandProbe(unclosedQuote.context)('claude "unterminated', identity)).toBeNull()
    expect(unclosedQuote.calls).toHaveLength(0)
  })

  test('keeps the whole-call deadline when an aborted fake runner holds the call', async () => {
    const fake = recordingContext(async (_argv, options) => {
      const { promise, resolve } = Promise.withResolvers<RunResult>()
      options?.signal?.addEventListener('abort', () => {
        resolve(runResult({ exitCode: null, stopped: 'aborted' }))
      }, { once: true })
      return promise
    })
    const started = Date.now()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const { promise, reject } = Promise.withResolvers<never>()
      deadline = setTimeout(() => reject(new Error('probe did not abort the runner')), 900)
      const output = await Promise.race([
        commandProbe(fake.context, { timeoutMs: 200 })('claude', identity),
        promise
      ])
      expect(output).toBeNull()
      expect(fake.calls).toHaveLength(1)
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      clearTimeout(deadline)
    }
  })

  test('returns at the whole-call deadline while an escaped child holds stdout open', async () => {
    const fake = installFake({})
    const pidFile = `${fake.launcher}.child.pid`
    escapedPidFiles.push(pidFile)
    writeFileSync(fake.launcher, `#!/bin/sh
exec perl -MPOSIX -e 'my $pid_file = $ARGV[0]; my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { POSIX::setsid(); my $temp_file = "$pid_file.tmp.$$"; open my $file, ">", $temp_file or die $!; print {$file} "$$\\n"; close $file or die $!; rename $temp_file, $pid_file or die $!; sleep 30; exit 0; } while (!-e $pid_file) { select undef, undef, undef, 0.01; } print "2.1.310 (Claude Code)\\n";' '${pidFile}'
`)
    const started = Date.now()
    expect(await commandProbe(fake.context, { timeoutMs: 1500 })(fake.launcher, identity)).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)
    expect(existsSync(pidFile)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).not.toThrow()
  })

  test('reads the stdout of the fake agent started with --version', async () => {
    const fake = installFake({ version: { stdout: '2.1.0 (Claude Code)\n' } })
    const output = await commandProbe(fake.context)(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })
    expect(output).toBe('2.1.0 (Claude Code)\n')
    expect(fake.envInputs).toEqual([{ sessionId: 's1', worktreeId: 'w1', agent: 'claude' }])
    expect(JSON.parse(fake.log().trim().split('\n')[0]!)).toMatchObject({ type: 'version', argv: ['--version'] })
  })

  test('a non-zero exit is null', async () => {
    const fake = installFake({ version: { stdout: '2.1.0', exitCode: 1 } })
    expect(await commandProbe(fake.context)(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
  })

  test('a probe that outlives the timeout is killed and returns null', async () => {
    const fake = installFake({})
    writeFileSync(fake.launcher, '#!/bin/sh\nexec sleep 30\n')
    const started = Date.now()
    expect(await commandProbe(fake.context, { timeoutMs: 200 })(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test('a probe that ignores SIGTERM is killed with its children and the call does not wait for it', async () => {
    const fake = installFake({})
    const pidFile = `${fake.launcher}.pid`
    const childFile = `${fake.launcher}.child`
    writeFileSync(fake.launcher, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nsleep 30 &\necho $! > '${childFile}'\nwait\n`)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const started = Date.now()
    // long enough for a loaded machine to start the shell, far short of its 30 s sleep
    expect(await commandProbe(fake.context, { timeoutMs: 1500 })(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
    const pids = [pidFile, childFile].map((file) => Number(readFileSync(file, 'utf8').trim()))
    expect(pids.every((pid) => pid > 0)).toBe(true)
    const deadline = Date.now() + 2000
    while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(25)
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    expect(pids.map(alive)).toEqual([false, false])
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

  test('a bare --version is logged as a version event, never a start, and defaults to 0.0.0 (fake)', async () => {
    const fake = installFake({})
    expect(await commandProbe(fake.context)(fake.launcher, { sessionId: 's1', worktreeId: 'w1' })).toBe('0.0.0 (fake)')
    expect(fake.log().trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['version'])
  })

  test('a missing command or a throwing context is null', async () => {
    const fake = installFake({})
    expect(await commandProbe(fake.context)('/nonexistent/claude', { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
    const broken = { launch: { commandArgv: () => { throw new Error('no shell') }, env: () => ({}) } } as unknown as PluginContext
    expect(await commandProbe(broken)('claude', { sessionId: 's1', worktreeId: 'w1' })).toBeNull()
  })
})
