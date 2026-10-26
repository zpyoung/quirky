import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ApiCatalog, Schema } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const NOTE_PARAMS: Schema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: "The note's title" },
    tags: { type: 'array', items: { type: 'string' } },
    color: { type: 'string', enum: ['red', 'blue'] }
  },
  required: ['title']
}

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addMethod('acme.notes/add', { description: 'Add a note.', params: NOTE_PARAMS }, { result: { id: 7 } })
  daemon.addMethod('acme.notes/count', { description: 'Count notes.' }, { result: 3 })
  daemon.addMethod('quirky.theme/list', { description: 'List themes.' })
  daemon.addMethod('quirky.theme/rename', {
    description: 'Rename a theme.',
    params: { type: 'object', properties: { themeId: { type: 'string' }, name: { type: 'string' } }, required: ['themeId', 'name'] }
  })
  daemon.addMethod('plugin.inspect', {
    plugin: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }, { result: { id: 'acme.tools', dirty: false } })
  daemon.addMethod('distro.inspect', { plugin: null, params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })
  daemon.addMethod('ui.report', { plugin: null, connection: true })
  daemon.addMethod('acme.notes/fail', {}, { error: { code: RpcErrorCode.InvalidParams, message: 'path must be a non-empty string' } })
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const catalog = async () => JSON.parse((await run(['api', '--json'])).stdout) as ApiCatalog

describe('SC-20: quirky api lists everything; --json is the catalog', () => {
  test('the catalog carries the daemon description and every command', async () => {
    const result = await run(['api', '--json'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    const doc = JSON.parse(result.stdout) as ApiCatalog
    expect(doc.schemaVersion).toBe(2)
    expect(doc.methods.map((m) => m.name)).toContain('acme.notes/add')
    expect(doc.events).toEqual([])
    expect(doc.uiCommands).toEqual([])
    const add = doc.commands.find((c) => c.command === 'acme.notes add')!
    expect(add).toMatchObject({ plugin: 'acme.notes', methods: ['acme.notes/add'], summary: 'Add a note.', positionals: [] })
    expect(add.usage).toStartWith('acme.notes add --title <string>')
    expect(add.flags).toContainEqual({
      name: 'title', type: 'string', description: "The note's title", required: true, repeatable: false
    })
    expect(add.flags).toContainEqual({
      name: 'color', type: 'string', description: '', required: false, repeatable: false, enum: ['red', 'blue']
    })
    expect(add.flags.find((f) => f.name === 'tags')).toMatchObject({ repeatable: true })
    expect(add.shadowedBy).toBeUndefined()
    const enable = doc.commands.find((c) => c.command === 'plugin enable')!
    expect(enable).toMatchObject({
      plugin: null,
      methods: ['plugin.enable'],
      positionals: [{ name: 'id', description: 'plugin or contribution ID', required: true }],
      flags: []
    })
    expect(doc.commands.some((c) => c.command === 'api call' && c.positionals[0]?.name === 'method')).toBe(true)
  })

  test('a built-in plugin method shadowed by a kernel command is listed with shadowedBy', async () => {
    const doc = await catalog()
    const entries = doc.commands.filter((c) => c.command === 'theme list')
    expect(entries.map((c) => [c.plugin, c.shadowedBy])).toEqual([
      [null, undefined],
      ['quirky.theme', 'kernel theme list']
    ])
    const rename = doc.commands.find((c) => c.command === 'theme rename')!
    expect(rename).toMatchObject({ plugin: 'quirky.theme', methods: ['quirky.theme/rename'] })
    expect(rename.shadowedBy).toBeUndefined()
  })

  test('commands are sorted by words, kernel first', async () => {
    const doc = await catalog()
    const keys = doc.commands.map((c) => [c.command, c.plugin ?? ''])
    const sorted = [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    expect(keys).toEqual(sorted)
  })

  test('the text form groups commands and ends with the counts', async () => {
    const result = await run(['api'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines.at(-1)).toBe(`${(await catalog()).methods.length} methods, 0 events`)
    expect(lines).toContain('acme.notes')
    expect(lines.some((l) => /^ {2}acme\.notes add --title <string>.*  Add a note\.$/.test(l))).toBe(true)
    expect(lines.indexOf('theme')).toBeGreaterThan(-1)
    expect(lines.some((l) => l.includes('List themes.') && l.endsWith('(shadowed by kernel theme list)'))).toBe(true)
  })

  test('an argument is refused', async () => {
    const result = await run(['api', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "extra"')
  })
})

describe('SC-21: quirky api call reaches any method', () => {
  test('a kernel-style method takes flags from its schema', async () => {
    const result = await run(['api', 'call', 'plugin.inspect', '--path', '/tmp/p', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'acme.tools', dirty: false })
    expect(daemon.methodCalls('plugin.inspect')).toEqual([{ path: '/tmp/p' }])
  })

  test('a plugin method prints its result as text', async () => {
    const result = await run(['api', 'call', 'acme.notes/count'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('3\n')
    expect(daemon.methodCalls('acme.notes/count')).toEqual([{}])
  })

  test('--params and flags combine, and a clash is a usage error', async () => {
    expect((await run(['api', 'call', 'acme.notes/add', '--params', '{"title":"a"}', '--tags', 'x'])).code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'a', tags: ['x'] }])
    const clash = await run(['api', 'call', 'acme.notes/add', '--params', '{"title":"a"}', '--title', 'b'])
    expect(clash.code).toBe(2)
    expect(clash.stderr).toContain('title is given by both --params and --title')
  })

  test('a missing required flag is a usage error before any call', async () => {
    const result = await run(['api', 'call', 'acme.notes/add'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing required flag --title')
    expect(daemon.methodCalls('acme.notes/add')).toEqual([])
  })

  test('a connection method is refused', async () => {
    const result = await run(['api', 'call', 'ui.report'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("ui.report needs a live connection and can't be called from the CLI")
  })

  test('an unknown method is refused', async () => {
    const result = await run(['api', 'call', 'nope.nothing'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown method nope.nothing')
  })

  test('no method is a usage error', async () => {
    const result = await run(['api', 'call'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing <method>')
  })

  test('an empty string reaches the daemon, whose InvalidParams exits 1', async () => {
    const result = await run(['api', 'call', 'acme.notes/fail', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'invalid-params', message: 'path must be a non-empty string' } })
    const empty = await run(['api', 'call', 'distro.inspect', '--path', ''])
    expect(empty.code).toBe(0)
    expect(daemon.methodCalls('distro.inspect')).toEqual([{ path: '' }])
  })

  test('a valued flag followed by a global switch is missing its value, not given the next word', async () => {
    const message = '--path requires a value; write --path=<value> for a value starting with --'
    const result = await run(['api', 'call', 'distro.inspect', '--path', '--json', '/tmp/repo'])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'usage', message } })
    const before = await run(['api', 'call', '--json', 'distro.inspect', '--path', '/tmp/repo', '--path', '--json'])
    expect(before.code).toBe(2)
    expect(daemon.methodCalls('distro.inspect')).toEqual([])
    const help = await run(['api', 'call', 'distro.inspect', '--path', '--help'])
    expect(help.code).toBe(2)
    expect(help.stderr).toContain(message)
    expect(daemon.methodCalls('distro.inspect')).toEqual([])
  })

  test('--json before or after the method name still gives JSON output', async () => {
    for (const args of [
      ['api', 'call', '--json', 'plugin.inspect', '--path', '/tmp/p'],
      ['api', 'call', 'plugin.inspect', '--json', '--path', '/tmp/p'],
      ['api', 'call', 'plugin.inspect', '--path', '/tmp/p', '--json']
    ]) {
      const result = await run(args)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ id: 'acme.tools', dirty: false })
    }
  })

  test('help after the method prints that method\'s help and calls nothing', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await run(['api', 'call', 'plugin.inspect', flag])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('usage: quirky plugin.inspect --path <string>')
      expect(result.stdout).toContain('--path')
    }
    expect(daemon.methodCalls('plugin.inspect')).toEqual([])
  })

  test('help for api call lists the method argument without contacting the daemon', async () => {
    const before = daemon.calls.length
    const result = await run(['api', 'call', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('usage: quirky api call <method>')
    expect(result.stdout).toContain('the method to call')
    expect(daemon.calls.length).toBe(before)
  })
})
