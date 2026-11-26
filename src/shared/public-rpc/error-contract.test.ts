import { describe, expect, it } from 'vitest'
import { EXIT_CODE, normalizeErrorCode, requiresNext, type StableErrorCode } from './error-contract'

describe('normalizeErrorCode', () => {
  const cases: [string, StableErrorCode, string][] = [
    ['invalid_argument', 'invalid_argument', 'invalid_argument'],
    ['selector_not_found', 'not_found', 'selector_not_found'],
    ['repo_not_found', 'not_found', 'repo_not_found'],
    ['run_not_found', 'not_found', 'run_not_found'],
    ['task_not_found', 'not_found', 'task_not_found'],
    ['terminal_not_found', 'not_found', 'terminal_not_found'],
    ['tab_not_found', 'not_found', 'tab_not_found'],
    ['method_not_found', 'unavailable', 'capability_missing'],
    ['capability_unsupported', 'unavailable', 'capability_missing'],
    ['method_not_supported', 'unavailable', 'capability_missing'],
    ['runtime_unavailable', 'unavailable', 'runtime_unavailable'],
    ['no_active_terminal', 'unavailable', 'no_active_terminal'],
    ['renderer_unavailable', 'unavailable', 'renderer_unavailable'],
    ['timeout', 'timeout', 'timeout'],
    ['runtime_timeout', 'timeout', 'runtime_timeout'],
    ['unauthorized', 'unauthorized', 'unauthorized'],
    ['forbidden', 'unauthorized', 'forbidden'],
    ['runtime_access_denied', 'unauthorized', 'runtime_access_denied'],
    ['confirmation_required', 'needs_confirmation', 'confirmation_required'],
    ['selector_ambiguous', 'conflict', 'selector_ambiguous'],
    ['terminal_handle_stale', 'conflict', 'terminal_handle_stale'],
    ['stale_delivery', 'conflict', 'stale_delivery'],
    ['conflict', 'conflict', 'conflict'],
    ['internal', 'internal', 'internal'],
    ['needs_confirmation', 'needs_confirmation', 'needs_confirmation'],
    ['not_found', 'not_found', 'not_found'],
    ['unavailable', 'unavailable', 'unavailable'],
    ['something_unheard_of', 'internal', 'something_unheard_of']
  ]

  it.each(cases)('%s -> %s (%s)', (input, code, reason) => {
    expect(normalizeErrorCode(input)).toEqual({ code, reason })
  })
})

describe('EXIT_CODE', () => {
  const expected: Record<StableErrorCode, number> = {
    internal: 1,
    invalid_argument: 2,
    not_found: 3,
    needs_confirmation: 4,
    conflict: 5,
    unavailable: 6,
    timeout: 6,
    unauthorized: 6
  }

  it.each(Object.entries(expected))('%s exits %i', (code, exit) => {
    expect(EXIT_CODE[code as StableErrorCode]).toBe(exit)
  })

  it('covers exactly the eight stable codes', () => {
    expect(Object.keys(EXIT_CODE).toSorted()).toEqual(Object.keys(expected).toSorted())
  })
})

describe('requiresNext', () => {
  it.each(['not_found', 'needs_confirmation', 'conflict', 'unavailable'] as const)(
    '%s requires a next step',
    (code) => {
      expect(requiresNext(code)).toBe(true)
    }
  )

  it.each(['internal', 'invalid_argument', 'timeout', 'unauthorized'] as const)(
    '%s does not',
    (code) => {
      expect(requiresNext(code)).toBe(false)
    }
  )
})
