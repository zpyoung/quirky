import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import {
  deriveTestResult,
  isTestCommand,
  parseTestCounts,
  shellCommandOf,
  tailOf
} from './test-result-derivation'

function payload(head: string): NonNullable<AgentJournalToolCallItem['output']> {
  return { head, byteLength: Buffer.byteLength(head), digest: 'd', truncated: false }
}

function bash(
  command: string,
  rest: Partial<AgentJournalToolCallItem> = {}
): AgentJournalToolCallItem {
  return {
    kind: 'tool-call',
    name: 'Bash',
    callId: 'toolu_1',
    input: { command },
    state: 'completed',
    ...rest
  }
}

describe('test command detection', () => {
  it.each([
    'pytest -q',
    'python -m pytest tests/',
    'pnpm test',
    'pnpm run test:unit',
    'npm test -- --watch=false',
    'bun test src/a.test.ts',
    'cd app && vitest run',
    'jest --ci',
    'go test ./...',
    'cargo test -p core',
    'make test'
  ])('recognises %s', (command) => {
    expect(isTestCommand(command)).toBe(true)
  })

  it.each(['ls -la', 'git status', 'pnpm install', 'echo pytestable', 'cat jest.config.ts'])(
    'ignores %s',
    (command) => {
      expect(isTestCommand(command)).toBe(false)
    }
  )
})

describe('parseTestCounts', () => {
  it('reads a pytest summary', () => {
    expect(parseTestCounts('=== 2 failed, 41 passed, 3 skipped in 1.20s ===')).toEqual({
      passed: 41,
      failed: 2,
      skipped: 3
    })
  })

  it('reads a vitest summary through terminal colors', () => {
    const output =
      ' Test Files  1 passed (1)\n      Tests  \u001b[1m\u001b[32m41 passed\u001b[39m\u001b[22m (41)\n'
    expect(parseTestCounts(output)).toEqual({ passed: 41 })
  })

  it('reads a jest summary', () => {
    expect(parseTestCounts('Tests:       1 failed, 2 skipped, 7 passed, 10 total')).toEqual({
      passed: 7,
      failed: 1,
      skipped: 2
    })
  })

  it('reads go test lines and keeps the last mention', () => {
    expect(parseTestCounts('--- FAIL: TestA\nFAIL\n3 passed\n5 passed\n')).toEqual({ passed: 5 })
  })

  it('reads a cargo summary', () => {
    expect(
      parseTestCounts('test result: FAILED. 12 passed; 1 failed; 0 ignored; 0 measured')
    ).toEqual({ passed: 12, failed: 1, skipped: 0 })
  })

  it('finds nothing in output without counts', () => {
    expect(parseTestCounts('ok  \texample.com/pkg\t0.2s')).toEqual({})
  })
})

describe('tailOf', () => {
  it('keeps the last 8 lines', () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    expect(tailOf(output)?.split('\n')).toEqual(
      Array.from({ length: 8 }, (_, index) => `line ${index + 12}`)
    )
  })

  it('keeps at most 800 characters, from the end', () => {
    const tail = tailOf(`${'x'.repeat(5000)}END`)
    expect(tail).toHaveLength(800)
    expect(tail?.endsWith('END')).toBe(true)
  })

  it('has no tail for empty output', () => {
    expect(tailOf('  \n\n')).toBeUndefined()
  })
})

describe('shellCommandOf', () => {
  it('reads Claude, Codex and pi shell inputs', () => {
    expect(shellCommandOf(bash('pytest'))).toBe('pytest')
    expect(shellCommandOf({ name: 'shell', input: { command: 'cargo test', cwd: '/w' } })).toBe(
      'cargo test'
    )
    expect(shellCommandOf({ name: 'bash', input: { command: 'go test ./...' } })).toBe(
      'go test ./...'
    )
  })

  it('joins an argv-style command', () => {
    expect(shellCommandOf({ name: 'execute', input: { command: ['bash', '-lc', 'pytest'] } })).toBe(
      'bash -lc pytest'
    )
  })

  it('is null for edit tools and inputs without a command', () => {
    expect(shellCommandOf({ name: 'Edit', input: { command: 'pytest' } })).toBeNull()
    expect(shellCommandOf({ name: 'Read', input: { file_path: '/a' } })).toBeNull()
    expect(shellCommandOf({ name: 'Bash', input: null })).toBeNull()
  })
})

describe('deriveTestResult', () => {
  it('yields nothing for a command that is not a test run', () => {
    expect(deriveTestResult(bash('ls -la'), 'toolu_1')).toBeNull()
    expect(
      deriveTestResult({ kind: 'tool-call', name: 'Read', input: {}, state: 'completed' }, 'x')
    ).toBeNull()
  })

  it('is running with no counts while the call runs', () => {
    expect(deriveTestResult(bash('pnpm test', { state: 'running' }), 'toolu_1')).toEqual({
      kind: 'test-result',
      callId: 'toolu_1',
      command: 'pnpm test',
      state: 'running'
    })
  })

  it('passes with counts and a tail from the whole output', () => {
    const output = `${'noise\n'.repeat(500)}Tests  41 passed (41)\n`
    const result = deriveTestResult(
      bash('pnpm test', { exitCode: 0, output: payload(output) }),
      'toolu_1'
    )
    expect(result).toMatchObject({ state: 'passed', passed: 41 })
    expect(result?.tail?.split('\n')).toHaveLength(8)
    expect(result?.tail?.endsWith('Tests  41 passed (41)')).toBe(true)
  })

  it('fails when the call failed, whatever the output says', () => {
    expect(
      deriveTestResult(bash('pytest', { state: 'failed', output: payload('3 passed') }), 'c')
    ).toMatchObject({ state: 'failed', passed: 3 })
  })

  it('fails on a non-zero exit code', () => {
    expect(deriveTestResult(bash('cargo test', { exitCode: 101 }), 'c')?.state).toBe('failed')
  })

  it('fails when counts show failures although the exit code is zero', () => {
    expect(
      deriveTestResult(
        bash('pytest || true', { exitCode: 0, output: payload('1 failed, 4 passed') }),
        'c'
      )
    ).toMatchObject({ state: 'failed', failed: 1, passed: 4 })
  })

  it('passes with no exit code when counts show no failures', () => {
    expect(deriveTestResult(bash('vitest run', { output: payload('5 passed') }), 'c')?.state).toBe(
      'passed'
    )
  })

  it('keeps the tail within 8 lines and 800 characters', () => {
    const output = Array.from({ length: 40 }, () => 'y'.repeat(300)).join('\n')
    const tail = deriveTestResult(bash('jest', { output: payload(output) }), 'c')?.tail
    expect(tail?.split('\n').length).toBeLessThanOrEqual(8)
    expect(tail?.length).toBeLessThanOrEqual(800)
  })

  it('collapses a multi-line command to one line', () => {
    expect(deriveTestResult(bash('cd a &&\n  pytest   -q'), 'c')?.command).toBe('cd a && pytest -q')
  })
})
