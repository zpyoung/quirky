import { describe, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { markPublicContractError } from './cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

function selectorNotFound(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_not_found', message: 'selector_not_found' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

function selectorAmbiguous(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_ambiguous', message: 'selector_ambiguous' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

describe('ambiguous selector recovery', () => {
  it('names the ambiguous --repo value and the exact forms for twin projects', () => {
    const output = formatCliError(selectorAmbiguous(), {
      commandPath: ['worktree', 'create'],
      repoSelector: 'app'
    })

    expect(output).toContain('More than one project matches --repo "app"')
    expect(output).toContain('id:<repo-id> or path:<absolute-path>')
    expect(output).toContain('quirky repo list --json')
  })

  it('carries the ambiguous --worktree value into the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(selectorAmbiguous(), true, {
      commandPath: ['terminal', 'create'],
      worktreeSelector: 'name:feature'
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'selector_ambiguous',
        data: {
          ambiguousSelectors: [{ flag: '--worktree', selector: 'name:feature' }],
          nextSteps: expect.arrayContaining([expect.stringContaining('identity:<identity.key>')])
        }
      }
    })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        data: {
          nextSteps: expect.arrayContaining([
            'List the exact values with `quirky worktree list --json`.'
          ])
        }
      }
    })
    log.mockRestore()
  })

  it('keeps the listing on the paired server the command chose', () => {
    const output = formatCliError(selectorAmbiguous(), {
      commandPath: ['repo', 'show'],
      repoSelector: 'app',
      remoteServerSelected: true
    })

    expect(output).toContain('`quirky repo list --json`, passing the same server flag')
  })

  it('stays silent when no selector flag was passed', () => {
    expect(formatCliError(selectorAmbiguous(), { commandPath: ['repo', 'list'] })).toBe(
      'selector_ambiguous'
    )
  })
})

describe('worktree selector recovery', () => {
  it('names the offending value and the valid forms on a bare repo id', () => {
    const output = formatCliError(selectorNotFound(), {
      commandPath: ['orchestration', 'worker-start'],
      worktreeSelector: 'id:github:stablyai/orca'
    })

    expect(output).toContain('No Quirky workspace matched the worktree selector')
    expect(output).toContain('id:github:stablyai/orca')
    expect(output).toContain('Did you mean: id:github:stablyai/orca::<absolute-path>')
    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('a bare repository id is not a worktree id')
  })

  it('carries the same recovery into the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(selectorNotFound(), true, {
      commandPath: ['terminal', 'create'],
      worktreeSelector: 'path:/nope'
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'selector_not_found',
        data: { selector: 'path:/nope', validSelectorForms: expect.arrayContaining(['current']) }
      }
    })
    log.mockRestore()
  })

  it('keeps the selector grammar when the error already carries mutation recovery data', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(
      new RuntimeRpcFailureError({
        id: 'req_selector',
        ok: false,
        error: {
          code: 'selector_not_found',
          message: 'selector_not_found',
          // The mutation-recovery layer already attached its request id.
          data: { orchestrationRequestId: 'req_abc', nextSteps: ['Run request-show first.'] }
        },
        _meta: { runtimeId: 'runtime_local' }
      }),
      true,
      { commandPath: ['orchestration', 'worker-start'], worktreeSelector: 'bare-repo-id' }
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        data: {
          orchestrationRequestId: 'req_abc',
          selector: 'bare-repo-id',
          validSelectorForms: expect.arrayContaining(['current']),
          nextSteps: expect.arrayContaining(['Run request-show first.'])
        }
      }
    })
    log.mockRestore()
  })

  it('keeps both recoveries in the text message for a local selector error', () => {
    const output = formatCliError(
      new RuntimeClientError('selector_not_found', 'selector_not_found', {
        orchestrationRequestId: 'req_abc',
        nextSteps: ['Run request-show first.']
      }),
      { worktreeSelector: 'bare-repo-id' }
    )

    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('Run request-show first.')
  })

  it('stays silent when no worktree selector was passed', () => {
    expect(formatCliError(selectorNotFound(), { commandPath: ['worktree', 'show'] })).toBe(
      'selector_not_found'
    )
  })
})

describe('CLI error recovery', () => {
  it('prints did-you-mean next steps for an unknown-command error carrying data', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown command: worktree remov', {
      suggestions: ['worktree rm'],
      nextSteps: ['Did you mean: quirky worktree rm']
    })

    const output = formatCliError(error)

    expect(output).toContain('Unknown command: worktree remov')
    expect(output).toContain('Next step: Did you mean: quirky worktree rm')
  })

  it('prefers structured recovery over generic computer hints in text output', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown flag --forcce', {
      nextSteps: ['Did you mean: --force']
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Did you mean: --force')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('prefers RPC recovery over generic computer hints in text output', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_recovery',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown runtime argument',
        data: { nextSteps: ['Use the runtime-specific option'] }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Use the runtime-specific option')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('keeps generic computer hints when an RPC error has no recovery data', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_fallback',
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid computer argument' },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Fix the command flags or RPC params')
  })

  it('does not replace mutation recovery with generic runtime startup advice', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'Re-issue the same command with --retry-request mutation_1.',
      { orchestrationRequestId: 'mutation_1' }
    )

    const output = formatCliError(error)

    expect(output).toContain('--retry-request mutation_1')
    expect(output).not.toContain('quirky open')
  })
})

describe('stale terminal handle recovery', () => {
  function staleHandle(): RuntimeRpcFailureError {
    return new RuntimeRpcFailureError({
      id: 'req_stale',
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' },
      _meta: { runtimeId: 'runtime_local' }
    })
  }

  it('points a terminal verb with no server selected at --environment', () => {
    const output = formatCliError(staleHandle(), {
      commandPath: ['terminal', 'send'],
      remoteServerSelected: false
    })

    expect(output).toContain('terminal_handle_stale')
    expect(output).toContain('Next step: Terminal handles belong to the Quirky server')
    expect(output).toContain('--environment <server>')
  })

  it('adds the hint to the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(staleHandle(), true, {
      commandPath: ['terminal', 'read'],
      remoteServerSelected: false
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'terminal_handle_stale',
        data: { nextSteps: [expect.stringContaining('--environment <server>')] }
      }
    })
    log.mockRestore()
  })

  it('stays silent once a server was already selected', () => {
    expect(
      formatCliError(staleHandle(), {
        commandPath: ['terminal', 'send'],
        remoteServerSelected: true
      })
    ).toBe('terminal_handle_stale')
  })
})

describe('legacy and public error codes in --json', () => {
  type ReportedError = { error: { code: string; data: Record<string, unknown> } }

  function reported(error: unknown, context: Parameters<typeof reportCliError>[2]): ReportedError {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true, context)
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]))
    log.mockRestore()
    return payload
  }

  it('keeps the original code for a legacy command and adds the stable one under data', () => {
    const payload = reported(selectorNotFound(), { commandPath: ['worktree', 'show'] })

    expect(payload.error.code).toBe('selector_not_found')
    expect(payload.error.data).toMatchObject({
      stableCode: 'not_found',
      reason: 'selector_not_found',
      next: [{ command: 'quirky schema worktree show', why: expect.any(String) }]
    })
  })

  it('keeps an unknown legacy code and reports it as the reason of an internal error', () => {
    const payload = reported(new RuntimeClientError('incompatible_runtime', 'too old'), {
      commandPath: ['status']
    })

    expect(payload.error.code).toBe('incompatible_runtime')
    expect(payload.error.data).toMatchObject({
      stableCode: 'internal',
      reason: 'incompatible_runtime'
    })
    expect(payload.error.data.next).toBeUndefined()
  })

  it('gives a hand-written public command such as ui state the stable code', () => {
    const payload = reported(new RuntimeClientError('renderer_unavailable', 'no window'), {
      commandPath: ['ui', 'state']
    })

    expect(payload.error.code).toBe('unavailable')
    expect(payload.error.data.reason).toBe('renderer_unavailable')
    expect(payload.error.data.stableCode).toBeUndefined()
  })

  it('keeps the original code for the legacy browser tab list', () => {
    const payload = reported(new RuntimeClientError('browser_error', 'no browser'), {
      commandPath: ['tab', 'list']
    })

    expect(payload.error.code).toBe('browser_error')
    expect(payload.error.data.stableCode).toBe('internal')
  })

  it('puts the stable code in error.code for an error a public command marked', () => {
    const payload = reported(markPublicContractError(selectorNotFound()), {
      commandPath: ['tab', 'list']
    })

    expect(payload.error.code).toBe('not_found')
    expect(payload.error.data.reason).toBe('selector_not_found')
    expect(payload.error.data.stableCode).toBeUndefined()
    expect(payload.error.data.next).toHaveLength(1)
  })

  it('treats a context that opts in, and the rpc command, as public', () => {
    expect(
      reported(selectorNotFound(), { commandPath: ['tab', 'list'], publicContract: true }).error
        .code
    ).toBe('not_found')
    expect(reported(selectorNotFound(), { commandPath: ['rpc'] }).error.code).toBe('not_found')
  })

  it('leaves an error a legacy command raised unmarked even after a public one was', () => {
    markPublicContractError(selectorNotFound())

    expect(reported(selectorNotFound(), { commandPath: ['worktree', 'show'] }).error.code).toBe(
      'selector_not_found'
    )
  })
})
