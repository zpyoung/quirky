import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, type ApiCatalog, type Schema } from '@quirky/protocol'
import { createDaemonLink } from '../src/link'
import { cliContextFor } from '../src/plugin-commands'
import { Printer } from '../src/output'
import type { Context } from '../src/commands/types'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const NOTE_PARAMS: Schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    color: { type: 'string', enum: ['red', 'blue'] },
    pinned: { type: 'boolean' },
    priority: { type: 'integer', minimum: 1, maximum: 5 }
  },
  required: ['title']
}

const MODULE_SOURCE = `
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.QUIRKY_TEST_MARKER, 'loaded\\n')

export const commands = {
  greet: async (args, ctx) => {
    const count = await ctx.call('acme.notes/count', {})
    const name = args.positionals[0] ?? 'nobody'
    ctx.out.result({ name, count, shout: args.flags.shout === true }, () =>
      ctx.format.record([['name', name], ['count', String(count)]])
    )
  },
  boom: async (_args, ctx) => {
    throw ctx.fail('it broke')
  },
  misuse: async (_args, ctx) => {
    throw ctx.usage('bad use')
  }
}
`

let daemon: FakeDaemon
let dir: string
let marker: string
let modulePath: string

beforeEach(() => {
  daemon = new FakeDaemon().start()
  dir = realpathSync(mkdtempSync('/tmp/qmod-'))
  marker = join(dir, 'marker')
  modulePath = join(dir, 'cli.ts')
  writeFileSync(modulePath, MODULE_SOURCE)
  daemon.addMethod('acme.notes/add', { description: 'Add a note.', params: NOTE_PARAMS }, { result: { id: 7 } })
  daemon.addMethod('acme.notes/get', { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }, { result: { id: 3 } })
  daemon.addMethod('acme.notes/count', { description: 'Count notes.' }, { result: 3 })
  daemon.addCliCommand({
    id: 'cli-command:acme.notes/add',
    plugin: 'acme.notes',
    words: 'acme.notes add',
    aliasWords: ['notes add'],
    summary: 'Add a note by title.',
    method: 'acme.notes/add',
    positionals: [{ name: 'name', description: 'The note title', required: true, param: 'title' }],
    flags: [
      { name: 'color', param: 'color', type: 'string', description: 'Note color', required: false, repeatable: false, enum: ['red', 'blue'] },
      { name: 'pin', param: 'pinned', type: 'boolean', description: 'Pin it', required: false, repeatable: false },
      { name: 'priority', param: 'priority', type: 'integer', description: '1 to 5', required: false, repeatable: false }
    ]
  })
  daemon.addCliCommand({
    id: 'cli-command:acme.notes/get',
    plugin: 'acme.notes',
    words: 'acme.notes get',
    summary: 'Get a note.',
    method: 'acme.notes/get',
    positionals: [{ name: 'id', description: 'The note ID', required: true, param: 'id' }]
  })
  daemon.addCliCommand({
    id: 'cli-command:acme.notes/greet',
    plugin: 'acme.notes',
    words: 'acme.notes greet',
    aliasWords: ['notes greet'],
    summary: 'Greet through the plugin module.',
    methods: ['acme.notes/count'],
    positionals: [{ name: 'who', description: 'Who to greet', required: false, param: 'who' }],
    flags: [{ name: 'shout', param: 'shout', type: 'boolean', description: 'Loudly', required: false, repeatable: false }],
    module: modulePath
  })
  for (const id of ['boom', 'misuse']) {
    daemon.addCliCommand({ id: `cli-command:acme.notes/${id}`, plugin: 'acme.notes', words: `acme.notes ${id}`, summary: id, module: modulePath })
  }
})
afterEach(() => {
  daemon.stop()
  rmSync(dir, { recursive: true, force: true })
})

const run = (args: string[]) => runCli(args, { home: daemon.home, env: { QUIRKY_TEST_MARKER: marker } })
const loads = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0)
const setCommandApiVersion = (id: string, apiVersion: unknown): void => {
  const entry = daemon.cli.commands.find((command) => command.id === id)
  if (!entry) throw new Error('missing CLI test command')
  if (apiVersion === undefined) Reflect.deleteProperty(entry, 'apiVersion')
  else Reflect.set(entry, 'apiVersion', apiVersion)
}


describe('SC-20: a declared command without a module runs generically', () => {
  test('positionals and flags fill the method params, validated by its schema', async () => {
    const result = await run(['acme.notes', 'add', 'Groceries', '--color', 'red', '--pin', '--priority', '2'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'Groceries', color: 'red', pinned: true, priority: 2 }])
    expect(result.stdout).toBe('id: 7\n')
    expect(JSON.parse((await run(['acme.notes', 'add', 'Tea', '--json'])).stdout)).toEqual({ id: 7 })
  })

  test('a positional bound to a number param is converted before validation', async () => {
    expect((await run(['acme.notes', 'get', '3'])).code).toBe(0)
    expect(daemon.methodCalls('acme.notes/get')).toEqual([{ id: 3 }])
    const bad = await run(['acme.notes', 'get', 'three'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('params.id')
    expect(daemon.methodCalls('acme.notes/get')).toHaveLength(1)
  })

  test('a missing or surplus positional and a bad flag are usage errors before any call', async () => {
    const missing = await run(['acme.notes', 'add'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('missing <name>')
    const surplus = await run(['acme.notes', 'add', 'a', 'b'])
    expect(surplus.code).toBe(2)
    expect(surplus.stderr).toContain('unexpected argument "b"')
    const bad = await run(['acme.notes', 'add', 'a', '--color', 'green'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--color must be one of red, blue')
    const range = await run(['acme.notes', 'add', 'a', '--priority', '9'])
    expect(range.code).toBe(2)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([])
  })
  test('generic RPC commands do not require a local module API floor', async () => {
    setCommandApiVersion('cli-command:acme.notes/add', undefined)
    const result = await run(['acme.notes', 'add', 'Groceries'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'Groceries' }])
  })

})

describe('a declared command with a CLI module', () => {
  test('the module is imported only when its command runs', async () => {
    await run(['acme.notes', 'add', 'x'])
    await run(['acme.notes', '--help'])
    await run(['acme.notes', 'greet', '--help'])
    await run(['api', '--json'])
    expect(loads()).toBe(0)

    const result = await run(['acme.notes', 'greet', 'zed'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('name: zed\ncount: 3\n')
    expect(loads()).toBe(1)
    expect(daemon.methodCalls('acme.notes/count')).toEqual([{}])
  })

  test('the module gets positionals, declared flags and --json from the context', async () => {
    const result = await run(['acme.notes', 'greet', 'zed', '--shout', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ name: 'zed', count: 3, shout: true })
  })

  test('ctx.fail exits 1 with the message on stderr, even under --json', async () => {
    const plain = await run(['acme.notes', 'boom'])
    expect(plain.code).toBe(1)
    expect(plain.stderr).toBe('quirky: it broke\n')
    const json = await run(['acme.notes', 'boom', '--json'])
    expect(json.code).toBe(1)
    expect(json.stderr).toBe('quirky: it broke\n')
    expect(json.stdout).toBe('')
  })

  test('ctx.usage exits 2', async () => {
    const result = await run(['acme.notes', 'misuse'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('bad use')
  })

  test('a module without the command, or one that cannot load, exits 1 with a message', async () => {
    writeFileSync(modulePath, 'export const commands = {}\n')
    const missing = await run(['acme.notes', 'greet'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe('quirky: the CLI module of acme.notes has no command "greet"\n')
    rmSync(modulePath)
    const gone = await run(['acme.notes', 'greet'])
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('could not load the CLI module of acme.notes')
  })
  test('incompatible, missing, and malformed API floors fail before importing the module', async () => {
    for (const apiVersion of ['1.3.0', undefined, '^1.0.0', 1]) {
      setCommandApiVersion('cli-command:acme.notes/greet', apiVersion)
      const result = await run(['acme.notes', 'greet'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('apiVersion')
      expect(loads()).toBe(0)
    }
  })

})

describe('alias words', () => {
  test('an alias word reaches the same command', async () => {
    const result = await run(['notes', 'add', 'Groceries'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'Groceries' }])
    expect((await run(['notes', 'greet', 'zed'])).stdout).toBe('name: zed\ncount: 3\n')
  })

  test('the alias group lists its commands, and the top level lists each command once', async () => {
    const group = await run(['notes', '--help'])
    expect(group.code).toBe(0)
    expect(group.stdout).toContain('usage: quirky notes <command>')
    expect(group.stdout).toContain('notes add <name>')
    const catalog = JSON.parse((await run(['api', '--json'])).stdout) as ApiCatalog
    expect(catalog.commands.filter((command) => command.command.startsWith('notes '))).toEqual([])
  })

  test('an alias word a kernel command already owns loses to the kernel', async () => {
    daemon.addCliCommand({ id: 'cli-command:acme.status/st', plugin: 'acme.status', words: 'acme.status st', aliasWords: ['status'], summary: 'x', method: 'acme.notes/count' })
    const result = await run(['status'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('daemon: 0.0.0-fake')
    expect(daemon.methodCalls('acme.notes/count')).toEqual([])
  })
})

describe('declared commands beat generated ones, and help lists them', () => {
  test('a declared command wins over its own generated command on equal words', async () => {
    const catalog = JSON.parse((await run(['api', '--json'])).stdout) as ApiCatalog
    const adds = catalog.commands.filter((command) => command.command === 'acme.notes add')
    expect(adds).toHaveLength(2)
    const winner = adds.find((command) => !command.shadowedBy)!
    expect(winner.summary).toBe('Add a note by title.')
    expect(winner.usage).toStartWith('acme.notes add <name>')
    expect(winner.positionals).toEqual([{ name: 'name', description: 'The note title', required: true }])
    expect(adds.find((command) => command.shadowedBy)!.shadowedBy).toBe('acme.notes acme.notes add')
    const generatedOnly = catalog.commands.find((command) => command.command === 'acme.notes count')!
    expect(generatedOnly.shadowedBy).toBeUndefined()
  })

  test('group help and command help list the declared commands', async () => {
    const group = await run(['acme.notes', '--help'])
    expect(group.code).toBe(0)
    expect(group.stdout).toMatch(/acme\.notes add <name> \[--color red\|blue\] \[--pin\] \[--priority <integer>\]\s+Add a note by title\./)
    expect(group.stdout).toMatch(/acme\.notes greet \[<who>\] \[--shout\]\s+Greet through the plugin module\./)
    const one = await run(['acme.notes', 'add', '--help'])
    expect(one.stdout).toContain('usage: quirky acme.notes add <name>')
    expect(one.stdout).toContain('<name>  The note title')
    expect(one.stdout).toMatch(/--color red\|blue\s+Note color/)
  })

  test('quirky api text and the skill list declared commands and the global switches', async () => {
    const text = (await run(['api'])).stdout
    expect(text).toContain('acme.notes add <name>')
    const skill = (await run(['skill', 'show'])).stdout
    expect(skill).toContain('quirky acme.notes add <name>')
    expect(skill).toContain('--yes')
    expect(skill).toContain('--retry-request')
    expect(skill).toContain('quirky --version')
  })

  test('a bare group command runs when the group word is typed alone', async () => {
    daemon.addCliCommand({ id: 'cli-command:acme.solo/main', plugin: 'acme.solo', words: 'acme.solo', summary: 'Solo.', method: 'acme.notes/count' })
    const result = await run(['acme.solo'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('3\n')
  })
})
describe('plugin CLI runtime context', () => {
  test('exposes the request base and forwards a per-call timeout through the daemon link', async () => {
    const forwarded: { method: string; params: Record<string, unknown>; options?: { requestId?: string; timeoutMs?: number } }[] = []
    const client = {
      callAny(method: string, params: Record<string, unknown>, options?: { requestId?: string; timeoutMs?: number }) {
        forwarded.push({ method, params, options })
        return Promise.resolve({ ok: true })
      }
    } as unknown as QuirkyClient
    const link = createDaemonLink(() => Promise.resolve(client), { requestBase: 'retry-base' })
    const context = {
      rpc: link,
      requestBase: link.requestBase,
      out: new Printer({ stdout() {}, stderr() {} }, false),
      env: {},
      cwd: '/work',
      readFile: () => '',
      sleep: async () => {},
      now: () => 0,
      openDesktopApp: async () => ({ ok: true as const })
    } satisfies Context
    const cli = cliContextFor(context)

    expect(cli.requestBase).toBe('retry-base')
    await cli.call('quirky.session/pointer', { session: 's_1' }, { timeoutMs: 60_000 })
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({
      method: 'quirky.session/pointer',
      params: { session: 's_1' },
      options: { requestId: expect.stringMatching(/^retry-base:/), timeoutMs: 60_000 }
    })
  })
})
