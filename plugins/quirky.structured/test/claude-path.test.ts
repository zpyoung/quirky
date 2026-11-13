import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { resolveClaudeThroughLoginShell } from '../claude-path'

const dirs: string[] = []
const ownedRunners: OwnedProcessRunner[] = []
let nextOwner = 0
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(ownedRunners.splice(0).map((runner) => runner.dispose()))
})

function fakeShell(body: string): string {
  const dir = mkdtempSync('/tmp/qs-shell-')
  dirs.push(dir)
  const path = join(dir, 'sh')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function runResult(stdoutText: string, overrides: Partial<RunResult> = {}): RunResult {
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

function scriptedRunner(outcome: RunResult | Error) {
  const calls: { argv: string[]; options?: RunOptions }[] = []
  const runner: ProcessRunner = {
    run: async (argv, options) => {
      calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  }
  return { runner, calls }
}

function realRunner() {
  const runner = createProcessRunner({ owner: `structured-claude-path-test-${nextOwner++}` })
  ownedRunners.push(runner)
  return runner
}

function assertCall(calls: { argv: string[]; options?: RunOptions }[], shell: string) {
  expect(calls).toEqual([
    {
      argv: [shell, '-l', '-c', 'command -v claude'],
      options: {
        timeoutMs: 30000,
        signal: expect.any(AbortSignal),
        killGraceMs: 0,
        maxOutputBytes: 1048576
      }
    }
  ])
}

function abortingRunner() {
  const calls: { argv: string[]; options?: RunOptions }[] = []
  const runner: ProcessRunner = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      const { promise, resolve } = Promise.withResolvers<RunResult>()
      const signal = options?.signal
      if (!signal) return Promise.reject(new Error('missing abort signal'))
      const abort = () => resolve(runResult('', { exitCode: null, signal: 'SIGTERM', stopped: 'aborted' }))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      return promise
    }
  }
  return { runner, calls }
}

describe('resolveClaudeThroughLoginShell', () => {
  test('runs the login-shell lookup through the runner with bounded options', async () => {
    const shell = '/bin/zsh'
    const { runner, calls } = scriptedRunner(runResult('noise\n/opt/bin/claude\n', { exitCode: 3 }))
    expect(await resolveClaudeThroughLoginShell(runner, shell)).toBe('/opt/bin/claude')
    assertCall(calls, shell)
  })

  const failures: { name: string; outcome: RunResult | Error }[] = [
    { name: 'timeout', outcome: runResult('/opt/bin/claude', { stopped: 'timeout' }) },
    { name: 'abort', outcome: runResult('/opt/bin/claude', { stopped: 'aborted' }) },
    { name: 'output overflow', outcome: runResult('/opt/bin/claude', { stopped: 'overflow' }) },
    {
      name: 'spawn error',
      outcome: runResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing shell' } })
    },
    { name: 'empty last line', outcome: runResult(' \n\t ') },
    { name: 'rejected run', outcome: new Error('runner disposed') }
  ]

  for (const failure of failures) {
    test(`throws when the runner reports ${failure.name}`, async () => {
      const { runner } = scriptedRunner(failure.outcome)
      await expect(resolveClaudeThroughLoginShell(runner, '/bin/zsh')).rejects.toThrow(
        'could not find the claude executable on the login shell PATH'
      )
    })
  }

  test('aborts a runner call that resolves only after its signal is aborted', async () => {
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis)
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) =>
      originalSetTimeout(handler, delay === 30000 ? 20 : delay, ...args)
    )
    const { runner, calls } = abortingRunner()
    const started = Date.now()
    try {
      await expect(resolveClaudeThroughLoginShell(runner, '/bin/zsh')).rejects.toThrow(
        'could not find the claude executable on the login shell PATH'
      )
      expect(Date.now() - started).toBeLessThan(1000)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options?.signal?.aborted).toBe(true)
    } finally {
      timerSpy.mockRestore()
    }
  })

  test('finds claude with a real process runner', async () => {
    const shell = fakeShell('[ "$1" = "-l" ] && [ "$2" = "-c" ] && [ "$3" = "command -v claude" ] && printf "noise\\n/opt/bin/claude\\n"')
    expect(await resolveClaudeThroughLoginShell(realRunner(), shell)).toBe('/opt/bin/claude')
  })

  test('throws when the shell prints no executable', async () => {
    await expect(resolveClaudeThroughLoginShell(realRunner(), fakeShell('exit 1'))).rejects.toThrow(
      'could not find the claude executable on the login shell PATH'
    )
  })
})
