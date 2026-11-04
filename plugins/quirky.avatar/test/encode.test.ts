import { describe, expect, test } from 'bun:test'
import type { GateOutcome } from '../src/contracts'
import { encodeDecision } from '../src/hooks/encode'

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>
const BLOCKING: GateOutcome[] = ['deny', 'held', 'retry']

describe('Claude PreToolUse', () => {
  test('allow carries the reason', () => {
    expect(parse(encodeDecision('claude', 'PreToolUse', { outcome: 'allow', reason: 'reads are allowed' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'reads are allowed' }
    })
  })

  test.each(BLOCKING)('%s is a deny with the reason', (outcome) => {
    expect(parse(encodeDecision('claude', 'PreToolUse', { outcome, reason: 'nope' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' }
    })
  })

  test('passthrough is an empty object', () => {
    expect(encodeDecision('claude', 'PreToolUse', { outcome: 'passthrough', reason: '' })).toBe('{}')
  })
})

describe('Codex PreToolUse', () => {
  test('allow is an empty object, because the allow is completed at PermissionRequest', () => {
    expect(encodeDecision('codex', 'PreToolUse', { outcome: 'allow', reason: 'fine' })).toBe('{}')
  })

  test.each(BLOCKING)('%s is a deny with the reason', (outcome) => {
    expect(parse(encodeDecision('codex', 'PreToolUse', { outcome, reason: 'nope' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' }
    })
  })

  test('passthrough is an empty object', () => {
    expect(encodeDecision('codex', 'PreToolUse', { outcome: 'passthrough', reason: '' })).toBe('{}')
  })
})

describe.each(['claude', 'codex'] as const)('%s PermissionRequest', (agent) => {
  test('allow answers behavior allow', () => {
    expect(parse(encodeDecision(agent, 'PermissionRequest', { outcome: 'allow', reason: 'allowed earlier' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
    })
  })

  test.each(BLOCKING)('%s answers behavior deny with a message', (outcome) => {
    expect(parse(encodeDecision(agent, 'PermissionRequest', { outcome, reason: 'nope' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nope' } }
    })
  })

  test('passthrough is an empty object', () => {
    expect(encodeDecision(agent, 'PermissionRequest', { outcome: 'passthrough', reason: '' })).toBe('{}')
  })
})

describe.each(['pi', 'omp'] as const)('%s tool_call', (agent) => {
  test('allow and passthrough are empty, which the extension turns into undefined', () => {
    expect(encodeDecision(agent, 'tool_call', { outcome: 'allow', reason: 'fine' })).toBe('')
    expect(encodeDecision(agent, 'tool_call', { outcome: 'passthrough', reason: '' })).toBe('')
  })

  test.each(BLOCKING)('%s blocks with the reason', (outcome) => {
    expect(parse(encodeDecision(agent, 'tool_call', { outcome, reason: 'nope' }))).toEqual({ block: true, reason: 'nope' })
  })
})

test('the output is a single line the shim can print verbatim', () => {
  expect(encodeDecision('claude', 'PreToolUse', { outcome: 'deny', reason: 'two\nlines' })).not.toContain('\n')
})
