import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], cwd?: string) => runCli(args, { home: daemon.home, cwd })
const digest = (method: string) => createHash('sha256').update(method).digest('hex').slice(0, 12)
const requestIds = (method: string) => daemon.calls.filter((call) => call.method === method).map((call) => call.requestId)

describe('SC-15: the CLI retries a lost reply with the same request ID', () => {
  test('a reply lost once is retried under the same ID and creates one repo', async () => {
    daemon.dropAfter('repo.add')
    const result = await run(['repo', 'add', '/tmp/w/web'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('added')
    expect(daemon.repos).toHaveLength(1)
    const [first, second, ...rest] = requestIds('repo.add')
    expect(rest).toEqual([])
    expect(first).toBe(second)
    expect(first).toMatch(new RegExp(`^[0-9a-f-]{36}:${digest('repo.add')}#1$`))
    expect(daemon.methodCalls('client.hello')).toHaveLength(2)
  })

  test('three lost replies exit 1 naming the base and --retry-request', async () => {
    daemon.dropAfter('repo.add', 3)
    const result = await run(['repo', 'add', '/tmp/w/web'])
    expect(result.code).toBe(1)
    const ids = requestIds('repo.add')
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    const base = ids[0]!.split(':')[0]
    expect(result.stderr).toBe(`quirky: connection lost; rerun with --retry-request ${base}\n`)
    expect(daemon.repos).toHaveLength(1)
  })

  test('under --json the lost-connection error is a document with its own code', async () => {
    daemon.dropAfter('repo.add', 3)
    const result = await run(['repo', 'add', '/tmp/w/web', '--json'])
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
    const repo = daemon.addRepo('api')
    daemon.dropAfter('worktree.create', 3)
    const lost = await run(['wt', 'create', repo.id, 'feature-x', '--retry-request', 'r-9'])
    expect(lost.code).toBe(1)
    expect(lost.stderr).toBe('quirky: connection lost; rerun with --retry-request r-9\n')
    expect(daemon.worktrees).toHaveLength(1)

    const again = await run(['wt', 'create', repo.id, 'feature-x', '--retry-request', 'r-9'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('feature-x')
    expect(daemon.worktrees).toHaveLength(1)
    expect(new Set(requestIds('worktree.create'))).toEqual(new Set([`r-9:${digest('worktree.create')}#1`]))
  })

  test('--retry-request=<id> works and is not seen by the command', async () => {
    const result = await run(['repo', 'list', '--retry-request=r-1', '--json'])
    expect(result.code).toBe(0)
    expect(requestIds('repo.list')).toEqual([`r-1:${digest('repo.list')}#1`])
  })

  test('an ID over 64 characters is a usage error before any call', async () => {
    const result = await run(['repo', 'list', '--retry-request', 'x'.repeat(65)])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--retry-request must be at most 64 characters')
    expect(daemon.calls).toEqual([])
  })

  test('a missing value is a usage error', async () => {
    const result = await run(['repo', 'list', '--retry-request'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--retry-request requires a value')
    expect(daemon.calls).toEqual([])
  })
})
