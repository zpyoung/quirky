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
  daemon.addMethod('quirky.repo/list', { description: 'List repos.' })
  daemon.addMethod('quirky.repo/rename', {
    description: 'Rename a repo.',
    params: { type: 'object', properties: { repoId: { type: 'string' }, name: { type: 'string' } }, required: ['repoId', 'name'] }
  })
  daemon.addMethod('git.status', {
    plugin: null,
    params: { type: 'object', properties: { worktreeId: { type: 'string' } }, required: ['worktreeId'] }
  }, { result: { branch: 'main', dirty: false } })
  daemon.addMethod('repo.add', { plugin: null, params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })
  daemon.addMethod('terminal.attach', { plugin: null, connection: true })
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
    expect(doc.schemaVersion).toBe(1)
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
    const repoAdd = doc.commands.find((c) => c.command === 'repo add')!
    expect(repoAdd).toMatchObject({
      plugin: null,
      methods: ['repo.add'],
      positionals: [{ name: 'path', description: 'path to the git repository', required: true }],
      flags: []
    })
    expect(doc.commands.some((c) => c.command === 'api call' && c.positionals[0]?.name === 'method')).toBe(true)
  })

  test('a built-in plugin method shadowed by a kernel command is listed with shadowedBy', async () => {
    const doc = await catalog()
    const entries = doc.commands.filter((c) => c.command === 'repo list')
    expect(entries.map((c) => [c.plugin, c.shadowedBy])).toEqual([
      [null, undefined],
      ['quirky.repo', 'kernel repo list']
    ])
    const rename = doc.commands.find((c) => c.command === 'repo rename')!
    expect(rename).toMatchObject({ plugin: 'quirky.repo', methods: ['quirky.repo/rename'] })
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
    const repoStart = lines.indexOf('repo')
    expect(repoStart).toBeGreaterThan(-1)
    expect(lines.some((l) => l.includes('List repos.') && l.endsWith('(shadowed by kernel repo list)'))).toBe(true)
  })

  test('an argument is refused', async () => {
    const result = await run(['api', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "extra"')
  })
})

describe('SC-21: quirky api call reaches any method', () => {
  test('a kernel-style method takes flags from its schema', async () => {
    const result = await run(['api', 'call', 'git.status', '--worktree-id', 'w1', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ branch: 'main', dirty: false })
    expect(daemon.methodCalls('git.status')).toEqual([{ worktreeId: 'w1' }])
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
    const result = await run(['api', 'call', 'terminal.attach'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("terminal.attach needs a live connection and can't be called from the CLI")
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
    const empty = await run(['api', 'call', 'repo.add', '--path', ''])
    expect(empty.code).toBe(0)
    expect(daemon.methodCalls('repo.add')).toEqual([{ path: '' }])
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
