import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { FakeDaemon, runCli, type MethodBehavior } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

function seedFailure(error: NonNullable<MethodBehavior['error']>) {
  daemon.addMethod('acme.notes/fail', {}, { error })
  daemon.addCliCommand({ id: 'cli-command:acme.notes/fail', plugin: 'acme.notes', words: 'acme.notes fail', summary: 'Fail.', method: 'acme.notes/fail' })
}

const run = (args: string[]) => runCli(args, { home: daemon.home })

describe('the --json error carries the daemon error reason', () => {
  test('a string data.reason is printed beside the unchanged code and message', async () => {
    seedFailure({ code: RpcErrorCode.Conflict, message: 'setup needs a decision', data: { reason: 'setup-decision-required' } })
    const result = await run(['acme.notes', 'fail', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: 'conflict', message: 'setup needs a decision', reason: 'setup-decision-required' }
    })
  })

  test('an error without data has no reason key', async () => {
    seedFailure({ code: RpcErrorCode.Conflict, message: 'plain conflict' })
    const result = await run(['acme.notes', 'fail', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'conflict', message: 'plain conflict' } })
  })

  test('data whose reason is not a string has no reason key', async () => {
    seedFailure({ code: RpcErrorCode.InvalidParams, message: 'bad', data: { reason: 7 } })
    const result = await run(['acme.notes', 'fail', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'invalid-params', message: 'bad' } })
  })

  test('text mode output is unchanged', async () => {
    seedFailure({ code: RpcErrorCode.Conflict, message: 'setup needs a decision', data: { reason: 'setup-decision-required' } })
    const result = await run(['acme.notes', 'fail'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('quirky: setup needs a decision\n')
  })
})
