import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCliError, reportCliError } from './cli-error'
import { RuntimeClientError } from './runtime/types'

const PLACEHOLDER_NEXT = [{ command: 're-run with --yes', why: 'confirms the effects listed' }]

function destructivePreview(): RuntimeClientError {
  return new RuntimeClientError('needs_confirmation', 'preview', {
    reason: 'preview',
    next: PLACEHOLDER_NEXT,
    effects: ['delete workspace old-spike']
  })
}

describe('needs_confirmation next step', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  const rawArgs = ['action', 'run', 'workspace.delete', '--workspace', 'old spike']

  it('replaces the runtime placeholder with the invocation plus --yes in JSON output', () => {
    reportCliError(destructivePreview(), true, {
      commandPath: ['action', 'run'],
      rawArgs,
      publicContract: true
    })
    const { error } = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(error.code).toBe('needs_confirmation')
    expect(error.data.next).toEqual([
      {
        command: `quirky action run workspace.delete --workspace 'old spike' --yes`,
        why: 'confirms the effects listed'
      }
    ])
    expect(error.data.effects).toEqual(['delete workspace old-spike'])
  })

  it('replaces the runtime placeholder in human output too', () => {
    const text = formatCliError(destructivePreview(), { commandPath: ['action', 'run'], rawArgs })
    expect(text).toBe(
      `preview\nNext: quirky action run workspace.delete --workspace 'old spike' --yes  (confirms the effects listed)`
    )
  })

  it('does not append a second --yes when the invocation already had one', () => {
    reportCliError(destructivePreview(), true, {
      commandPath: ['action', 'run'],
      rawArgs: ['action', 'run', 'workspace.delete', '--yes'],
      publicContract: true
    })
    const { error } = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(error.data.next[0].command).toBe('quirky action run workspace.delete --yes')
  })

  it('keeps a step that is already an executable quirky command', () => {
    reportCliError(
      new RuntimeClientError('needs_confirmation', 'preview', {
        next: [{ command: 'quirky tab close t1 --yes', why: 'confirm' }]
      }),
      true,
      { commandPath: ['tab', 'close'], rawArgs: ['tab', 'close', 't1'], publicContract: true }
    )
    const { error } = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(error.data.next).toEqual([{ command: 'quirky tab close t1 --yes', why: 'confirm' }])
  })

  it('leaves the placeholder alone when the invocation is unknown', () => {
    reportCliError(destructivePreview(), true, { commandPath: ['action', 'run'] })
    const { error } = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(error.data.next).toEqual(PLACEHOLDER_NEXT)
  })

  it('does not rewrite next steps of other error codes', () => {
    reportCliError(new RuntimeClientError('conflict', 'moved', { next: PLACEHOLDER_NEXT }), true, {
      commandPath: ['rpc'],
      rawArgs: ['rpc', 'x'],
      publicContract: true
    })
    const { error } = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(error.data.next).toEqual(PLACEHOLDER_NEXT)
  })
})
