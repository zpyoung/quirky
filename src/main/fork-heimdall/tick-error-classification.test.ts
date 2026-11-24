import { describe, expect, it } from 'vitest'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { isExecutionHostContactLoss } from './tick-error-classification'

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('isExecutionHostContactLoss', () => {
  it.each([
    ['a lost SSH link', coded('link lost', 'CONNECTION_LOST')],
    ['an SSH request with no answer', coded('timed out', 'SSH_MUX_REQUEST_TIMEOUT')],
    ['an SSH host this process does not serve', new SshHostNotServedError('box-1')],
    ['an unavailable remote runtime', coded('down', 'runtime_unavailable')],
    ['a closed remote runtime socket', new Error('Remote Quirky runtime connection closed')]
  ])('reports %s as lost contact', (_label, error) => {
    expect(isExecutionHostContactLoss(error)).toBe(true)
  })

  it.each([
    [
      'a deterministic orchestration miss',
      coded('Question msg_1 was not found in Run run_1', 'question_not_found')
    ],
    ['an uncoded local bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a non-Error throw', 'host offline']
  ])('treats %s as a local failure', (_label, error) => {
    expect(isExecutionHostContactLoss(error)).toBe(false)
  })
})
