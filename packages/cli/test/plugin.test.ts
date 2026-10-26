import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })

describe('plugin list', () => {
  test('renders a table with diagnostics indented under their plugin', async () => {
    daemon.addPlugin('acme.alpha', { version: '1.2.0', state: 'active' })
    daemon.addPlugin('acme.beta', {
      source: 'builtin',
      state: 'invalid',
      diagnostics: [
        { level: 'error', message: 'bad manifest' },
        { level: 'warning', message: 'unknown field' }
      ]
    })
    daemon.addPlugin('acme.gamma')
    const result = await run(['plugin', 'list'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0].split(/\s+/)).toEqual(['ID', 'STATE', 'SOURCE', 'VERSION'])
    expect(lines[1].split(/\s+/)).toEqual(['acme.alpha', 'active', 'installed', '1.2.0'])
    expect(lines[2].split(/\s+/)).toEqual(['acme.beta', 'invalid', 'builtin', '1.0.0'])
    expect(lines[3]).toBe('  error: bad manifest')
    expect(lines[4]).toBe('  warning: unknown field')
    expect(lines[5].split(/\s+/)).toEqual(['acme.gamma', 'inactive', 'installed', '1.0.0'])
    expect(lines).toHaveLength(6)
    expect(daemon.methodCalls('plugin.list')).toEqual([{}])
  })

  test('says so when there are no plugins', async () => {
    expect((await run(['plugin', 'list'])).stdout).toBe('no plugins\n')
  })

  test('--json prints the raw result', async () => {
    const plugin = daemon.addPlugin('acme.alpha', { diagnostics: [{ level: 'warning', message: 'w' }] })
    const result = await run(['plugin', 'list', '--json'])
    expect(JSON.parse(result.stdout)).toEqual([plugin])
  })
})

describe('plugin contributions', () => {
  test('sends no params when no flags are given and prints ID and PLUGIN', async () => {
    const effective = daemon.addContribution('acme.alpha', 'command', 'run')
    daemon.addContribution('acme.alpha', 'command', 'old', { status: 'overridden', overriddenBy: 'x' })
    const result = await run(['plugin', 'contributions'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('plugin.contributions')).toEqual([{}])
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0].split(/\s+/)).toEqual(['ID', 'PLUGIN'])
    expect(lines[1].split(/\s+/)).toEqual([effective.id, 'acme.alpha'])
  })

  test('passes --kind, --plugin and --all through', async () => {
    await run(['plugin', 'contributions', '--kind', 'command', '--plugin', 'acme.alpha', '--all'])
    expect(daemon.methodCalls('plugin.contributions')).toEqual([{ kind: 'command', pluginId: 'acme.alpha', all: true }])
  })

  test('--all adds a STATUS column describing every status', async () => {
    daemon.addContribution('p', 'command', 'a')
    daemon.addContribution('p', 'command', 'b', { status: 'overridden', overriddenBy: 'q:command.b' })
    daemon.addContribution('p', 'command', 'c', { status: 'disabled', disabledBy: 'user' })
    daemon.addContribution('p', 'command', 'd', { status: 'disabled', disabledBy: 'plugin', disablingPlugin: 'r' })
    daemon.addContribution('p', 'command', 'e', { status: 'disabled', disabledBy: 'owner' })
    daemon.addContribution('p', 'command', 'f', { status: 'rejected', conflictWith: 'q:command.f' })
    const result = await run(['plugin', 'contributions', '--all'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0].split(/\s{2,}/)).toEqual(['ID', 'PLUGIN', 'STATUS'])
    const statuses = lines.slice(1).map((line) => line.split(/\s{2,}/)[2])
    expect(statuses).toEqual([
      'effective',
      'overridden by q:command.b',
      'disabled by user',
      'disabled by r',
      'disabled (owner disabled)',
      'rejected (conflicts with q:command.f)'
    ])
  })

  test('says so when there are no contributions', async () => {
    expect((await run(['plugin', 'contributions'])).stdout).toBe('no contributions\n')
  })

  test('--json prints the raw result', async () => {
    const contribution = daemon.addContribution('p', 'command', 'a')
    const result = await run(['plugin', 'contributions', '--json'])
    expect(JSON.parse(result.stdout)).toEqual([contribution])
  })
})

describe('plugin enable, disable and activate', () => {
  test('enable and disable send the id and confirm', async () => {
    daemon.addPlugin('acme.alpha')
    const enabled = await run(['plugin', 'enable', 'acme.alpha'])
    expect(enabled.code).toBe(0)
    expect(enabled.stdout).toBe('enabled acme.alpha\n')
    const disabled = await run(['plugin', 'disable', 'acme.alpha'])
    expect(disabled.stdout).toBe('disabled acme.alpha\n')
    expect(daemon.methodCalls('plugin.enable')).toEqual([{ id: 'acme.alpha' }])
    expect(daemon.methodCalls('plugin.disable')).toEqual([{ id: 'acme.alpha' }])
  })

  test('disable accepts a contribution id and --json prints the result', async () => {
    const contribution = daemon.addContribution('acme.alpha', 'command', 'run')
    const result = await run(['plugin', 'disable', contribution.id, '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ ok: true })
    expect(daemon.methodCalls('plugin.disable')).toEqual([{ id: contribution.id }])
  })

  test('an unknown id exits 1 with the daemon message', async () => {
    for (const verb of ['enable', 'disable']) {
      const result = await run(['plugin', verb, 'nope'])
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('quirky: unknown plugin or contribution nope\n')
      expect(result.stdout).toBe('')
    }
  })

  test('activate sends the plugin id and prints its id and state', async () => {
    daemon.addPlugin('acme.alpha')
    const result = await run(['plugin', 'activate', 'acme.alpha'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('id: acme.alpha\nstate: active\n')
    expect(daemon.methodCalls('plugin.activate')).toEqual([{ pluginId: 'acme.alpha' }])
  })

  test('activate --json prints the plugin', async () => {
    daemon.addPlugin('acme.alpha')
    const result = await run(['plugin', 'activate', 'acme.alpha', '--json'])
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'acme.alpha', state: 'active' })
  })

  test('a missing id is a usage error', async () => {
    expect((await run(['plugin', 'enable'])).code).toBe(2)
    expect(daemon.methodCalls('plugin.enable')).toEqual([])
  })
})

describe('help', () => {
  test('lists the plugin group', async () => {
    const result = await run(['plugin', '--help'])
    expect(result.code).toBe(0)
    for (const usage of ['plugin list', 'plugin contributions', 'plugin enable', 'plugin disable', 'plugin activate']) {
      expect(result.stdout).toContain(usage)
    }
    expect((await run(['help'])).stdout).toContain('plugin list')
  })
})
