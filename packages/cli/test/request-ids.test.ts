import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { ConnectionLost, RpcError, RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { ConnectionLostError, DaemonUnavailableError, createDaemonLink } from '../src/link'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addPlugin('acme.tools')
})
afterEach(() => daemon.stop())

const run = (args: string[], cwd?: string) => runCli(args, { home: daemon.home, cwd })
const digest = (method: string) => createHash('sha256').update(method).digest('hex').slice(0, 12)
const requestIds = (method: string) => daemon.calls.filter((call) => call.method === method).map((call) => call.requestId)

describe('SC-15: the CLI retries a lost reply with the same request ID', () => {
  test('a reply lost once is retried under the same ID and runs the method once', async () => {
    daemon.dropAfter('plugin.enable')
    const result = await run(['plugin', 'enable', 'acme.tools'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('enabled acme.tools')
    expect(daemon.executions.filter((method) => method === 'plugin.enable')).toHaveLength(1)
    const [first, second, ...rest] = requestIds('plugin.enable')
    expect(rest).toEqual([])
    expect(first).toBe(second)
    expect(first).toMatch(new RegExp(`^[0-9a-f-]{36}:${digest('plugin.enable')}#1$`))
    expect(daemon.methodCalls('client.hello')).toHaveLength(2)
  })

  test('three lost replies exit 1 naming the base and --retry-request', async () => {
    daemon.dropAfter('plugin.enable', 3)
    const result = await run(['plugin', 'enable', 'acme.tools'])
    expect(result.code).toBe(1)
    const ids = requestIds('plugin.enable')
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    const base = ids[0]!.split(':')[0]
    expect(result.stderr).toBe(`quirky: connection lost; rerun with --retry-request ${base}\n`)
    expect(daemon.executions.filter((method) => method === 'plugin.enable')).toHaveLength(1)
  })

  test('under --json the lost-connection error is a document with its own code', async () => {
    daemon.dropAfter('plugin.enable', 3)
    const result = await run(['plugin', 'enable', 'acme.tools', '--json'])
    expect(result.code).toBe(1)
    const { error } = JSON.parse(result.stdout)
    expect(error.code).toBe('connection-lost')
    expect(error.message).toStartWith('connection lost; rerun with --retry-request ')
  })

  test('every call of an invocation shares the base and counts per method', async () => {
    daemon.results.set('plugin.uninstall', { ok: true })
    daemon.requireConfirmation('plugin.uninstall', { action: 'Uninstall plugin acme.tools?' })
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(0)
    const [first, second] = requestIds('plugin.uninstall')
    expect(first).toMatch(new RegExp(`:${digest('plugin.uninstall')}#1$`))
    expect(second).toMatch(new RegExp(`:${digest('plugin.uninstall')}#2$`))
    expect(first!.split(':')[0]).toBe(second!.split(':')[0])
  })
})

describe('SC-16: --retry-request reissues a command with a given ID', () => {
  test('the rerun gets the first outcome and creates nothing new', async () => {
    daemon.dropAfter('plugin.disable', 3)
    const lost = await run(['plugin', 'disable', 'acme.tools', '--retry-request', 'r-9'])
    expect(lost.code).toBe(1)
    expect(lost.stderr).toBe('quirky: connection lost; rerun with --retry-request r-9\n')
    expect(daemon.executions.filter((method) => method === 'plugin.disable')).toHaveLength(1)

    const again = await run(['plugin', 'disable', 'acme.tools', '--retry-request', 'r-9'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('disabled acme.tools')
    expect(daemon.executions.filter((method) => method === 'plugin.disable')).toHaveLength(1)
    expect(new Set(requestIds('plugin.disable'))).toEqual(new Set([`r-9:${digest('plugin.disable')}#1`]))
  })

  test('--retry-request=<id> works and is not seen by the command', async () => {
    const result = await run(['plugin', 'list', '--retry-request=r-1', '--json'])
    expect(result.code).toBe(0)
    expect(requestIds('plugin.list')).toEqual([`r-1:${digest('plugin.list')}#1`])
  })

  test('an ID over 64 characters is a usage error before any call', async () => {
    const result = await run(['plugin', 'list', '--retry-request', 'x'.repeat(65)])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--retry-request must be at most 64 characters')
    expect(daemon.calls).toEqual([])
  })

  test('a missing value is a usage error', async () => {
    const result = await run(['plugin', 'list', '--retry-request'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--retry-request requires a value')
    expect(daemon.calls).toEqual([])
  })
})

describe('a lost reply followed by a failed reconnect', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

  test('surfaces the request base so the mutation can be retried', async () => {
    let connects = 0
    const link = createDaemonLink(
      async () => {
        if (++connects > 1) throw refused()
        return {
          callAny: async () => {
            throw new ConnectionLost()
          },
          close() {}
        } as unknown as QuirkyClient
      },
      { requestBase: 'recover-me' }
    )
    const error = await link.callAny('quirky.repo/add', { path: '/x' }).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectionLostError)
    expect((error as ConnectionLostError).base).toBe('recover-me')
    expect((error as Error).message).toBe('connection lost; rerun with --retry-request recover-me')
  })

  test('preserves RPC authorization failures from connection setup', async () => {
    const authorization = new RpcError(RpcErrorCode.Unauthorized, 'unauthorized')
    const link = createDaemonLink(async () => {
      throw authorization
    })
    const error = await link.callAny('status.get', {}).catch((failure) => failure)
    expect(error).toBe(authorization)
  })

  test('preserves permission failures from connection setup', async () => {
    const permission = Object.assign(new Error('could not connect to quirkyd: Permission denied'), { code: 'EACCES' })
    const link = createDaemonLink(async () => {
      throw permission
    })
    const error = await link.callAny('status.get', {}).catch((failure) => failure)
    expect(error).toBe(permission)
  })

  test('a call that never reached the daemon is still DaemonUnavailable', async () => {
    const link = createDaemonLink(async () => {
      throw refused()
    })
    const error = await link.callAny('quirky.repo/add', {}).catch((e) => e)
    expect(error).toBeInstanceOf(DaemonUnavailableError)
  })
  test('does not automatically replay uncertain destructive or owner runtime calls', async () => {
    for (const [method, isDestructive] of [
      ['quirky.worktree/remove', () => true],
      ['quirky.cli/runtimeCall', () => false]
    ] as const) {
      let connects = 0
      let calls = 0
      const link = createDaemonLink(async () => {
        connects++
        return {
          callAny: async () => {
            calls++
            throw new ConnectionLost()
          },
          close() {}
        } as unknown as QuirkyClient
      }, { requestBase: 'do-not-replay', isDestructive })
      const error = await link.callAny(method, {}).catch((failure) => failure)
      expect(error).toBeInstanceOf(ConnectionLostError)
      expect(connects).toBe(1)
      expect(calls).toBe(1)
      link.close()
    }
  })
})
