import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCliError, reportCliError } from '../cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { exitCodeFor } from './exit-codes'

function failure(code: string, message = 'boom', data?: unknown): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req-1',
    ok: false,
    error: { code, message, ...(data === undefined ? {} : { data }) },
    _meta: { runtimeId: 'runtime-1' }
  })
}

describe('exitCodeFor', () => {
  const table: [string, number][] = [
    ['internal', 1],
    ['runtime_error', 1],
    ['something_unheard_of', 1],
    ['invalid_argument', 2],
    ['not_found', 3],
    ['selector_not_found', 3],
    ['terminal_not_found', 3],
    ['needs_confirmation', 4],
    ['confirmation_required', 4],
    ['conflict', 5],
    ['selector_ambiguous', 5],
    ['terminal_handle_stale', 5],
    ['unavailable', 6],
    ['runtime_unavailable', 6],
    ['method_not_found', 6],
    ['timeout', 6],
    ['runtime_timeout', 6],
    ['unauthorized', 6],
    ['runtime_access_denied', 6]
  ]

  it.each(table)('maps %s to exit %i', (code, exit) => {
    expect(exitCodeFor(new RuntimeClientError(code, 'x'))).toBe(exit)
  })

  it('reads the code from a runtime failure envelope', () => {
    expect(exitCodeFor(failure('selector_not_found'))).toBe(3)
  })

  it('exits 1 for an error that is not a client error', () => {
    expect(exitCodeFor(new Error('plain'))).toBe(1)
    expect(exitCodeFor('a string')).toBe(1)
  })
})

describe('reportCliError in json mode', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function printedError(): {
    code: string
    message: string
    data?: {
      reason?: string
      stableCode?: string
      next?: { command: string; why: string }[]
      nextSteps?: string[]
    }
  } {
    expect(logSpy).toHaveBeenCalledTimes(1)
    return JSON.parse(String(logSpy.mock.calls[0][0])).error
  }

  it('keeps the original code for a legacy command and adds the stable code under data', () => {
    reportCliError(failure('selector_not_found'), true, { commandPath: ['worktree', 'show'] })
    const error = printedError()
    expect(error.code).toBe('selector_not_found')
    expect(error.data?.stableCode).toBe('not_found')
    expect(error.data?.reason).toBe('selector_not_found')
  })

  it('puts the stable code in error.code and keeps the original code as the reason for a public command', () => {
    reportCliError(failure('selector_not_found'), true, { commandPath: ['rpc'] })
    const error = printedError()
    expect(error.code).toBe('not_found')
    expect(error.data?.stableCode).toBeUndefined()
    expect(error.data?.reason).toBe('selector_not_found')
  })

  it('synthesizes a schema next step for not_found', () => {
    reportCliError(failure('selector_not_found'), true, { commandPath: ['worktree', 'show'] })
    expect(printedError().data?.next).toEqual([
      { command: 'quirky schema worktree show', why: expect.any(String) }
    ])
  })

  it('turns method_not_found from an old runtime into unavailable/capability_missing with a status next step', () => {
    reportCliError(failure('method_not_found'), true, { commandPath: ['ui', 'state'] })
    const error = printedError()
    expect(error.code).toBe('unavailable')
    expect(error.data?.reason).toBe('capability_missing')
    expect(error.data?.next).toEqual([
      { command: 'quirky status', why: 'runtime predates public-cli.v1; update it' }
    ])
  })

  it('synthesizes quirky status for a runtime that is not reachable', () => {
    reportCliError(new RuntimeClientError('runtime_unavailable', 'down'), true, {
      commandPath: ['rpc']
    })
    const error = printedError()
    expect(error.code).toBe('unavailable')
    expect(error.data?.reason).toBe('runtime_unavailable')
    expect(error.data?.next?.[0]?.command).toBe('quirky status')
  })

  it('spells the confirmation command from the invocation when the runtime sent none', () => {
    reportCliError(failure('confirmation_required'), true, {
      commandPath: ['rpc'],
      rawArgs: ['rpc', 'worktree.remove', '--params', '{"id":"a b"}']
    })
    const error = printedError()
    expect(error.code).toBe('needs_confirmation')
    expect(error.data?.next?.[0]?.command).toBe(
      `quirky rpc worktree.remove --params '{"id":"a b"}' --yes`
    )
  })

  it('keeps next steps and reason the runtime already sent', () => {
    reportCliError(
      failure('needs_confirmation', 'preview', {
        reason: 'preview',
        next: [{ command: 'quirky tab close t1 --yes', why: 'confirm' }],
        effects: ['closes tab t1']
      }),
      true,
      { commandPath: ['tab', 'close'] }
    )
    const error = printedError()
    expect(error.code).toBe('needs_confirmation')
    expect(error.data).toMatchObject({
      reason: 'preview',
      next: [{ command: 'quirky tab close t1 --yes', why: 'confirm' }],
      effects: ['closes tab t1']
    })
  })

  it('maps an unknown code to internal and keeps it as the reason', () => {
    reportCliError(failure('runtime_error', 'kaput'), true, { commandPath: ['rpc'] })
    const error = printedError()
    expect(error.code).toBe('internal')
    expect(error.data?.reason).toBe('runtime_error')
    expect(error.data?.next).toBeUndefined()
  })

  it('keeps an unknown code on a legacy command and reports internal under data', () => {
    reportCliError(failure('runtime_error', 'kaput'), true, { commandPath: ['status'] })
    const error = printedError()
    expect(error.code).toBe('runtime_error')
    expect(error.data?.stableCode).toBe('internal')
    expect(error.data?.reason).toBe('runtime_error')
  })

  it('reports a local usage error as invalid_argument with no extra reason', () => {
    reportCliError(new RuntimeClientError('invalid_argument', 'bad flag'), true, {
      commandPath: ['file', 'open']
    })
    const error = printedError()
    expect(error.code).toBe('invalid_argument')
    expect(error.data?.reason).toBeUndefined()
  })

  it('keeps the legacy recovery steps alongside the contract fields', () => {
    reportCliError(
      new RuntimeClientError('selector_not_found', 'no such worktree', {
        nextSteps: ['Run `quirky worktree list`.']
      }),
      true,
      { commandPath: ['worktree', 'show'] }
    )
    expect(printedError().data?.nextSteps).toEqual(['Run `quirky worktree list`.'])
  })
})

describe('formatCliError in text mode', () => {
  it('prints Next lines for the steps the runtime sent', () => {
    const text = formatCliError(
      failure('needs_confirmation', 'preview', {
        next: [{ command: 'quirky tab close t1 --yes', why: 'confirm' }]
      })
    )
    expect(text).toBe('preview\nNext: quirky tab close t1 --yes  (confirm)')
  })

  it('prints the compat hint for a runtime that lacks the method', () => {
    expect(formatCliError(failure('method_not_found', 'no such method'))).toBe(
      'no such method\nNext: quirky status  (runtime predates public-cli.v1; update it)'
    )
  })

  it('leaves a legacy error with its existing recovery text only', () => {
    const text = formatCliError(
      new RuntimeClientError('selector_not_found', 'gone', { nextSteps: ['look around'] })
    )
    expect(text).toBe('gone\nNext step: look around')
  })
})
