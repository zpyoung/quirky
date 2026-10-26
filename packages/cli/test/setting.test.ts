import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const FONT = 'setting:acme.notes/fontSize'
const MODE = 'setting:acme.notes/mode'

describe('setting list', () => {
  test('renders ID, TYPE, VALUE and DEFAULT with values as JSON', async () => {
    daemon.addSetting('acme.notes', 'fontSize', { value: 16, stored: { value: 16, valid: true } })
    daemon.addSetting('acme.notes', 'mode', { type: 'enum', default: 'list', value: 'list', values: ['list', 'grid'] })
    const result = await run(['setting', 'list'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0].split(/\s+/)).toEqual(['ID', 'TYPE', 'VALUE', 'DEFAULT'])
    expect(lines[1].split(/\s+/)).toEqual([FONT, 'number', '16', '13'])
    expect(lines[2].split(/\s+/)).toEqual([MODE, 'enum', '"list"', '"list"'])
    expect(daemon.methodCalls('setting.list')).toEqual([{}])
  })

  test('an invalid stored value is called out next to the value in effect', async () => {
    daemon.addSetting('acme.notes', 'fontSize', { value: 13, stored: { value: 'big', valid: false } })
    const result = await run(['setting', 'list'])
    expect(result.stdout.trimEnd().split('\n')[1]).toBe(`${FONT}  number  13 (stored "big" is invalid)  13`)
  })

  test('--plugin sends pluginId and filters', async () => {
    daemon.addSetting('acme.notes', 'fontSize')
    daemon.addSetting('acme.other', 'size')
    const result = await run(['setting', 'list', '--plugin', 'acme.other'])
    expect(daemon.methodCalls('setting.list')).toEqual([{ pluginId: 'acme.other' }])
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('setting:acme.other/size')
  })

  test('says so when there are no settings', async () => {
    expect((await run(['setting', 'list'])).stdout).toBe('no settings\n')
  })

  test('--json prints the raw result', async () => {
    const setting = daemon.addSetting('acme.notes', 'fontSize', { stored: { value: 'big', valid: false } })
    const result = await run(['setting', 'list', '--json'])
    expect(JSON.parse(result.stdout)).toEqual([setting])
  })
})

describe('setting get', () => {
  test('prints the value as JSON', async () => {
    daemon.addSetting('acme.notes', 'fontSize')
    daemon.addSetting('acme.notes', 'mode', { type: 'string', default: 'list', value: 'list' })
    expect((await run(['setting', 'get', FONT])).stdout).toBe('13\n')
    expect((await run(['setting', 'get', MODE])).stdout).toBe('"list"\n')
    expect(daemon.methodCalls('setting.get')).toEqual([{ id: FONT }, { id: MODE }])
  })

  test('--json prints the whole setting', async () => {
    const setting = daemon.addSetting('acme.notes', 'fontSize')
    expect(JSON.parse((await run(['setting', 'get', FONT, '--json'])).stdout)).toEqual(setting)
  })

  test('an unknown setting exits 1 with the daemon message on stderr', async () => {
    const result = await run(['setting', 'get', 'setting:acme.notes/ghost'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no setting setting:acme.notes/ghost')
  })

  test('a missing id is a usage error', async () => {
    const result = await run(['setting', 'get'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing <id>')
    expect(daemon.methodCalls('setting.get')).toEqual([])
  })
})

describe('setting set', () => {
  beforeEach(() => {
    daemon.addSetting('acme.notes', 'fontSize')
  })

  test.each([
    ['16', 16],
    ['1.5', 1.5],
    ['grid', 'grid'],
    ['true', true],
    ['"16"', '16'],
    ['not json {', 'not json {']
  ])('parses %s as %p', async (raw, expected) => {
    const result = await run(['setting', 'set', FONT, raw])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('setting.set')).toEqual([{ id: FONT, value: expected }])
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`)
  })

  test('--json prints the updated setting', async () => {
    const result = await run(['setting', 'set', FONT, '16', '--json'])
    expect(JSON.parse(result.stdout)).toMatchObject({ id: FONT, value: 16, stored: { value: 16, valid: true } })
  })

  test('a refused value exits 1 with the daemon message on stderr', async () => {
    daemon.settingErrors.set(FONT, { code: RpcErrorCode.InvalidParams, message: `${FONT} must be at most 32` })
    const result = await run(['setting', 'set', FONT, '40'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`${FONT} must be at most 32`)
  })

  test('an unknown setting exits 1', async () => {
    const result = await run(['setting', 'set', 'setting:acme.notes/ghost', '1'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no setting setting:acme.notes/ghost')
  })

  test('missing arguments are usage errors', async () => {
    const noId = await run(['setting', 'set'])
    expect(noId.code).toBe(2)
    expect(noId.stderr).toContain('missing <id>')
    const noValue = await run(['setting', 'set', FONT])
    expect(noValue.code).toBe(2)
    expect(noValue.stderr).toContain('missing <value>')
    expect(daemon.methodCalls('setting.set')).toEqual([])
  })
})

describe('setting reset', () => {
  test('prints the default as JSON', async () => {
    daemon.addSetting('acme.notes', 'fontSize', { value: 16, stored: { value: 16, valid: true } })
    const result = await run(['setting', 'reset', FONT])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('13\n')
    expect(daemon.methodCalls('setting.reset')).toEqual([{ id: FONT }])
  })

  test('--json prints the setting without a stored value', async () => {
    daemon.addSetting('acme.notes', 'fontSize', { value: 16, stored: { value: 16, valid: true } })
    const parsed = JSON.parse((await run(['setting', 'reset', FONT, '--json'])).stdout)
    expect(parsed.value).toBe(13)
    expect(parsed.stored).toBeUndefined()
  })

  test('an unknown setting exits 1; a missing id is a usage error', async () => {
    const unknown = await run(['setting', 'reset', 'setting:acme.notes/ghost'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('no setting')
    expect((await run(['setting', 'reset'])).code).toBe(2)
  })
})

describe('help', () => {
  test('lists the setting group', async () => {
    const result = await run(['setting', '--help'])
    expect(result.code).toBe(0)
    for (const usage of ['setting list', 'setting get', 'setting set', 'setting reset']) {
      expect(result.stdout).toContain(usage)
    }
  })
})
