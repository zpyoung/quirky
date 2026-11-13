import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { hookCommand } from '../src/hook-command'
import {
  CLAUDE_HOOK_EVENT_FIRST_VERSIONS,
  ClaudeVersionGate,
  claudeEventsFor,
  claudeSettings,
  commandProbe,
  parseClaudeVersion
} from '../src/claude-settings'

const processRunners: OwnedProcessRunner[] = []
const escapedPidFiles: string[] = []
let nextRunnerId = 0

function makeProcessRunner(): OwnedProcessRunner {
  const runner = createProcessRunner({ owner: `agent-status-probe-test-${++nextRunnerId}` })
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
  removeTempDirs()
})

const FULL_SET = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PostCompact',
  'SessionEnd'
]

describe('parseClaudeVersion', () => {
  test('takes the first x.y.z from a --version output', () => {
    expect(parseClaudeVersion('2.1.310 (Claude Code)\n')).toBe('2.1.310')
    expect(parseClaudeVersion('claude v1.0.60')).toBe('1.0.60')
  })

  test('is null when there is no version', () => {
    expect(parseClaudeVersion('command not found')).toBeNull()
    expect(parseClaudeVersion('')).toBeNull()
    expect(parseClaudeVersion(null)).toBeNull()
  })
})

describe('claudeEventsFor (SC-28)', () => {
  test('1.0.60 gets only the events that release knows', () => {
    expect([...claudeEventsFor('1.0.60')].sort()).toEqual(
      ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit'].sort()
    )
  })

  test('2.1.300 gets the full set including SessionEnd', () => {
    expect([...claudeEventsFor('2.1.300')].sort()).toEqual([...FULL_SET].sort())
  })

  test('SessionEnd waits for 2.1.261', () => {
    expect(claudeEventsFor('2.1.260')).not.toContain('SessionEnd')
    expect(claudeEventsFor('2.1.261')).toContain('SessionEnd')
    expect(claudeEventsFor('2.1.261')).toContain('StopFailure')
  })

  test('an unresolved version gets the 1.0.64 set', () => {
    expect([...claudeEventsFor(null)].sort()).toEqual(
      ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'SessionStart'].sort()
    )
    expect(claudeEventsFor(null)).toEqual(claudeEventsFor('1.0.64'))
  })

  test('PreCompact is never registered', () => {
    for (const v of [null, '1.0.60', '2.1.300', '99.0.0']) expect(claudeEventsFor(v)).not.toContain('PreCompact')
    expect(Object.keys(CLAUDE_HOOK_EVENT_FIRST_VERSIONS)).not.toContain('PreCompact')
  })

  test('compares numerically, not as text', () => {
    expect(claudeEventsFor('1.0.100')).toContain('SessionStart')
    expect(claudeEventsFor('1.0.9')).toEqual([])
  })
})

describe('claudeSettings', () => {
  test('one command hook per event, matcher only on tool and permission events', () => {
    const settings = claudeSettings(['Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>
    }
    const command = hookCommand('claude')
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command, timeout: 10 }] }])
    for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
      expect(settings.hooks[name]).toEqual([{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }])
    }
    expect(Object.keys(settings)).toEqual(['hooks'])
  })
})

describe('ClaudeVersionGate', () => {
  function gateWith(outputs: Array<string | null | Error>) {
    let clock = 0
    const calls: string[] = []
    const gate = new ClaudeVersionGate(async (command) => {
      calls.push(command)
      const next = outputs.shift()
      if (next instanceof Error) throw next
      return next ?? null
    }, () => clock)
    return { gate, calls, advance: (ms: number) => (clock += ms) }
  }

  test('parses the probe output and keeps a success for the gate life', async () => {
    const { gate, calls, advance } = gateWith(['2.1.310 (Claude Code)\n'])
    expect(await gate.version('claude')).toBe('2.1.310')
    advance(24 * 3_600_000)
    expect(await gate.version('claude')).toBe('2.1.310')
    expect(calls).toEqual(['claude'])
  })

  test('keeps a failure for 30 minutes then probes again', async () => {
    const { gate, calls, advance } = gateWith([null, 'claude 2.0.10'])
    expect(await gate.version('claude')).toBeNull()
    advance(29 * 60_000)
    expect(await gate.version('claude')).toBeNull()
    expect(calls).toHaveLength(1)
    advance(2 * 60_000)
    expect(await gate.version('claude')).toBe('2.0.10')
    expect(calls).toHaveLength(2)
  })

  test('treats a throwing probe and unparseable output as failure', async () => {
    const { gate } = gateWith([new Error('boom')])
    expect(await gate.version('claude')).toBeNull()
    const other = gateWith(['not a version'])
    expect(await other.gate.version('claude')).toBeNull()
  })

  test('caches per command and shares one in-flight probe', async () => {
    const { gate, calls } = gateWith(['1.0.60', '2.1.300'])
    const [a, b] = await Promise.all([gate.version('claude'), gate.version('claude')])
    expect(a).toBe('1.0.60')
    expect(b).toBe('1.0.60')
    expect(await gate.version('other-claude')).toBe('2.1.300')
    expect(calls).toEqual(['claude', 'other-claude'])
  })
})

describe('commandProbe', () => {
  function contextFor(processRunner: PluginContext['process'] = makeProcessRunner()): PluginContext {
    return {
      process: processRunner,
      launch: {
        env: () => ({ PATH: process.env.PATH ?? '' }),
        commandArgv: (line: string) => ['/bin/sh', '-c', `exec ${line}`]
      }
    } as unknown as PluginContext
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
    const fake = recordingContext((_argv, options) => {
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
    const dir = makeTempDir()
    const fake = join(dir, 'claude')
    const pidFile = join(dir, 'child.pid')
    escapedPidFiles.push(pidFile)
    writeFileSync(fake, `#!/bin/sh
exec perl -MPOSIX -e 'my $pid_file = $ARGV[0]; my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { POSIX::setsid(); my $temp_file = "$pid_file.tmp.$$"; open my $file, ">", $temp_file or die $!; print {$file} "$$\\n"; close $file or die $!; rename $temp_file, $pid_file or die $!; sleep 30; exit 0; } while (!-e $pid_file) { select undef, undef, undef, 0.01; } print "2.1.310 (Claude Code)\\n";' '${pidFile}'
`, { mode: 0o755 })
    const started = Date.now()
    expect(await commandProbe(contextFor(), { timeoutMs: 1500 })(fake, identity)).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)
    expect(existsSync(pidFile)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).not.toThrow()
  })

  test('returns the stdout of <command> --version', async () => {
    const dir = makeTempDir()
    const fake = join(dir, 'claude')
    writeFileSync(fake, '#!/bin/sh\necho "2.1.310 (Claude Code)"\n', { mode: 0o755 })
    const probe = commandProbe(contextFor())
    expect(parseClaudeVersion(await probe(fake, identity))).toBe('2.1.310')
  })

  test('is null when the command fails or hangs past the timeout', async () => {
    const failing = commandProbe(contextFor())
    expect(await failing('false', identity)).toBeNull()
    const dir = makeTempDir()
    const sleeper = join(dir, 'claude')
    writeFileSync(sleeper, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const hanging = commandProbe(contextFor(), { timeoutMs: 100 })
    const started = Date.now()
    expect(await hanging(sleeper, identity)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
