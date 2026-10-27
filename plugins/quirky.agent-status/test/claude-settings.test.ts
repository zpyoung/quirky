import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { hookCommand } from '../src/hook-command'
import {
  CLAUDE_HOOK_EVENT_FIRST_VERSIONS,
  ClaudeVersionGate,
  claudeEventsFor,
  claudeSettings,
  commandProbe,
  parseClaudeVersion,
  writeClaudeSettings
} from '../src/claude-settings'

afterEach(() => removeTempDirs())

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

describe('writeClaudeSettings', () => {
  test('writes the file for the event set and returns its path', () => {
    const dir = makeTempDir()
    const path = writeClaudeSettings(dir, '2.1.300')
    expect(path.startsWith(join(dir, 'claude-settings-'))).toBe(true)
    expect(path.endsWith('.json')).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeSettings(claudeEventsFor('2.1.300')))
  })

  test('versions with one event set share a file, different sets get different files', () => {
    const dir = makeTempDir()
    expect(writeClaudeSettings(dir, '2.1.300')).toBe(writeClaudeSettings(dir, '2.1.400'))
    expect(writeClaudeSettings(dir, null)).toBe(writeClaudeSettings(dir, '1.0.64'))
    expect(writeClaudeSettings(dir, '1.0.60')).not.toBe(writeClaudeSettings(dir, '2.1.300'))
    expect(writeClaudeSettings(dir, '2.1.260')).not.toBe(writeClaudeSettings(dir, '2.1.261'))
  })

  test('leaves a current file alone and rewrites a stale one', () => {
    const dir = makeTempDir()
    const path = writeClaudeSettings(dir, '2.1.300')
    const past = new Date(Date.now() - 60_000)
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs
    expect(writeClaudeSettings(dir, '2.1.300')).toBe(path)
    expect(statSync(path).mtimeMs).toBe(before)

    writeFileSync(path, '{"hooks":{}}\n')
    expect(writeClaudeSettings(dir, '2.1.300')).toBe(path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeSettings(claudeEventsFor('2.1.300')))
  })

  test('creates the data dir when missing', () => {
    const dir = join(makeTempDir(), 'nested', 'data')
    const path = writeClaudeSettings(dir, null)
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks.SessionStart).toBeDefined()
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
  function contextFor(script: string): PluginContext {
    return {
      launch: {
        env: () => ({ PATH: process.env.PATH ?? '' }),
        commandArgv: () => ['/bin/sh', '-c', script]
      }
    } as unknown as PluginContext
  }

  test('returns the stdout of <command> --version', async () => {
    const dir = makeTempDir()
    const fake = join(dir, 'claude')
    writeFileSync(fake, '#!/bin/sh\necho "2.1.310 (Claude Code)"\n', { mode: 0o755 })
    const context = { launch: { env: () => ({ PATH: process.env.PATH ?? '' }), commandArgv: (line: string) => ['/bin/sh', '-c', line] } }
    const probe = commandProbe(context as unknown as PluginContext)
    expect(parseClaudeVersion(await probe(fake, { sessionId: 's', worktreeId: 'w' }))).toBe('2.1.310')
  })

  test('is null when the command fails or hangs past the timeout', async () => {
    const failing = commandProbe(contextFor('false'))
    expect(await failing('claude', { sessionId: 's', worktreeId: 'w' })).toBeNull()
    const hanging = commandProbe(contextFor('sleep 30'), { timeoutMs: 100 })
    const started = Date.now()
    expect(await hanging('claude', { sessionId: 's', worktreeId: 'w' })).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
