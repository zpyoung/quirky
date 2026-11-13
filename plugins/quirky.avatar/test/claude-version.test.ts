import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import type { RunResult } from '@quirky/protocol'
import { cachedClaudeVersion, claudeVersionAtLeast, probeClaudeVersion } from '../src/hooks/install'
import { makeTestApp } from './support'

const processRunners: OwnedProcessRunner[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(processRunners.splice(0).map((runner) => runner.dispose()))
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function processResult(stdoutText: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function makeRealProcessRunner(): OwnedProcessRunner {
  const runner = createProcessRunner({ owner: 'claude-version-test' })
  processRunners.push(runner)
  return runner
}

async function withTestQuirkyHome<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.QUIRKY_HOME
  const directory = mkdtempSync(join(tmpdir(), 'avatar-version-home-'))
  temporaryDirectories.push(directory)
  process.env.QUIRKY_HOME = directory
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previous
  }
}

function temporaryClaude(stdout: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'avatar-claude-version-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'claude')
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`)
  chmodSync(executable, 0o755)
  return executable
}

describe('Claude version process runner', () => {
  test('uses process.run with the requested or default command and trims stdout', async () => {
    const t = makeTestApp({ runProcess: (argv) => processResult(`  ${argv[0]} 2.1.295 (Claude Code)  \n`) })
    const probe = probeClaudeVersion
    expect(await probe(t.context.process, 'claude-test')).toBe('claude-test 2.1.295 (Claude Code)')
    expect(await probe(t.context.process)).toBe('claude 2.1.295 (Claude Code)')
    expect(t.processRuns).toEqual([
      { argv: ['claude-test', '--version'], options: { timeoutMs: 5_000 } },
      { argv: ['claude', '--version'], options: { timeoutMs: 5_000 } }
    ])
  })


  test('probes a temporary executable through a real process runner', async () => {
    await withTestQuirkyHome(async () => {
      const runner = makeRealProcessRunner()
      const executable = temporaryClaude('  Claude Code 2.1.295  ')
      expect(await probeClaudeVersion(runner, executable)).toBe('Claude Code 2.1.295')
    })
  })

  for (const [name, result] of [
    ['spawn error', processResult('Claude Code 2.1.300', { spawnError: { code: 'ENOENT', message: 'not found' } })],
    ['timeout', processResult('Claude Code 2.1.300', { exitCode: null, stopped: 'timeout' })],
    ['abort', processResult('Claude Code 2.1.300', { exitCode: null, stopped: 'aborted' })],
    ['output overflow', processResult('Claude Code 2.1.300', { exitCode: null, stopped: 'overflow' })],
    ['empty output', processResult('')],
    ['whitespace output', processResult(' \n\t ')]
  ] as const) {
    test(`returns null for ${name}`, async () => {
      const t = makeTestApp({ runProcess: () => result })
      expect(await probeClaudeVersion(t.context.process, 'claude-test')).toBeNull()
      expect(t.processRuns).toEqual([{ argv: ['claude-test', '--version'], options: { timeoutMs: 5_000 } }])
    })
  }

  test('returns null when process.run throws or rejects', async () => {
    const thrown = makeTestApp({ runProcess: () => { throw new Error('thrown') } })
    expect(await probeClaudeVersion(thrown.context.process)).toBeNull()
    expect(thrown.processRuns).toEqual([{ argv: ['claude', '--version'], options: { timeoutMs: 5_000 } }])

    const rejected = makeTestApp({ runProcess: () => Promise.reject(new Error('rejected')) })
    expect(await probeClaudeVersion(rejected.context.process)).toBeNull()
    expect(rejected.processRuns).toEqual([{ argv: ['claude', '--version'], options: { timeoutMs: 5_000 } }])
  })

  test('caches ProcessRunner results until ttlMs expires, then probes again', async () => {
    let now = 10_000
    const originalNow = Date.now
    Date.now = () => now
    try {
      let count = 0
      const t = makeTestApp({ runProcess: () => processResult(`2.1.${300 + count++}`) })
      const cached = cachedClaudeVersion(t.context.process, 60_000)
      expect(await cached()).toBe('2.1.300')
      expect(await cached()).toBe('2.1.300')
      expect(t.processRuns).toHaveLength(1)
      now += 60_001
      expect(await cached()).toBe('2.1.301')
      expect(t.processRuns).toHaveLength(2)
    } finally {
      Date.now = originalNow
    }
  })

  test('catches and caches a rejecting custom probe as null until ttlMs expires', async () => {
    let now = 20_000
    const originalNow = Date.now
    Date.now = () => now
    try {
      let count = 0
      const rejectingProbe = () => {
        count++
        return Promise.reject(new Error('boom'))
      }
      const cached = cachedClaudeVersion(rejectingProbe, 60_000)
      expect(await cached()).toBeNull()
      expect(await cached()).toBeNull()
      expect(count).toBe(1)
      now += 60_001
      expect(await cached()).toBeNull()
      expect(count).toBe(2)
    } finally {
      Date.now = originalNow
    }
  })

  test('keeps the gate version proof fail-closed for null', () => {
    expect(claudeVersionAtLeast(null)).toBe(false)
  })
})
