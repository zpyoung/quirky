import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], extra: { cwd?: string; env?: Record<string, string> } = {}) =>
  runCli(args, { home: daemon.home, ...extra })

describe('status', () => {
  test('prints key: value lines', async () => {
    const result = await run(['status'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('daemon: 0.0.0-fake')
    expect(result.stdout).toContain(`home: ${daemon.home}`)
    expect(result.stdout).toContain('pty host: alive (pid 4242)')
  })

  test('--json prints one JSON document, before or after the command', async () => {
    for (const args of [['--json', 'status'], ['status', '--json']]) {
      const result = await run(args)
      expect(result.code).toBe(0)
      const body = JSON.parse(result.stdout)
      expect(body.daemonVersion).toBe('0.0.0-fake')
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
    }
  })
})

describe('usage', () => {
  test('unknown command exits 2', async () => {
    const result = await run(['frobnicate'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command "frobnicate"')
  })

  test('unknown flag and missing argument exit 2', async () => {
    const unknown = await run(['status', '--bogus'])
    expect(unknown.code).toBe(2)
    const missing = await run(['plugin', 'enable'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('missing <id>')
    expect(daemon.calls).toEqual([])
  })

  test('a command group without a subcommand exits 2', async () => {
    expect((await run(['plugin'])).code).toBe(2)
  })

  test('help, --help and <command> --help exit 0 on stdout', async () => {
    for (const args of [['help'], ['--help'], [], ['setting', '--help'], ['help', 'setting', 'set'], ['plugin', '--help']]) {
      const result = await run(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('usage:')
    }
    expect((await run(['setting', 'list', '--help'])).stdout).toContain('--plugin')
  })

  test('help never contacts the daemon', async () => {
    await run(['help'])
    expect(daemon.calls).toEqual([])
  })

  test('a --help after -- is a positional, not a help request', async () => {
    const result = await run(['setting', 'list', '--', '--help'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "--help"')
    expect(result.stdout).toBe('')
  })

  test('a --help in the value slot of a valued flag is the missing-value error', async () => {
    const result = await run(['setting', 'list', '--plugin', '--help'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--plugin requires a value; write --plugin=<value> for a value starting with --')
    expect(result.stdout).toBe('')
    expect((await run(['setting', 'list', '--plugin=--help', '--help'])).code).toBe(0)
  })
})

describe('flag parsing', () => {

  test('a valued flag without a value exits 2 and makes no call', async () => {
    const atEnd = await run(['setting', 'list', '--plugin'])
    expect(atEnd.code).toBe(2)
    expect(atEnd.stderr).toContain('--plugin requires a value')
    const dashed = await run(['setting', 'list', '--plugin', '--json'])
    expect(dashed.code).toBe(2)
    expect(JSON.parse(dashed.stdout).error.message).toBe(
      '--plugin requires a value; write --plugin=<value> for a value starting with --'
    )
    expect(dashed.stderr).toBe('')
    expect(daemon.methodCalls('setting.list')).toEqual([])
  })

  test('a value starting with -- is passed with =', async () => {
    const result = await run(['setting', 'list', '--plugin=--x'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('setting.list')).toEqual([{ pluginId: '--x' }])
  })

  test('a missing required flag is reported by name before any call', async () => {
    const result = await run(['skill', 'install'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing required flag --dir')
    expect(daemon.calls).toEqual([])
  })
})
