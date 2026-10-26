import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type ApiDescription, type ApiMethodEntry, type Schema } from '@quirky/protocol'
import { resolveCommands } from '../src/catalog'
import { COMMANDS } from '../src/commands'
import type { Command } from '../src/commands/types'
import { formatGeneric } from '../src/format'
import { generatedCommands, groupOf } from '../src/generated'
import { createDaemonLink } from '../src/link'
import { run as runMain } from '../src/main'
import { suggestCommands } from '../src/suggest'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const NOTE_PARAMS: Schema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: "The note's title" },
    body: { type: 'string', description: 'The note text' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags; repeat the flag' },
    pinned: { type: 'boolean', description: 'Pin the note' },
    priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 to 5' },
    color: { type: 'string', enum: ['red', 'blue'] },
    meta: { type: 'object', additionalProperties: true }
  },
  required: ['title']
}

let daemon: FakeDaemon

function seedNotes(d: FakeDaemon) {
  d.addMethod('acme.notes/add', { description: 'Add a note.\nMore detail.', params: NOTE_PARAMS }, { result: { id: 7, title: 'Groceries' } })
  d.addMethod('acme.notes/count', { description: 'Count notes.' })
  d.addMethod('acme.notes/list', { description: 'List notes.' })
  d.addMethod('acme.notes/raw', { params: { type: 'object', properties: { json: { type: 'boolean' } } } })
}

beforeEach(() => {
  daemon = new FakeDaemon().start()
  seedNotes(daemon)
})
afterEach(() => daemon.stop())

const run = (args: string[], env: Record<string, string> = {}) => runCli(args, { home: daemon.home, env })
const methodCalls = () => daemon.calls.filter((call) => call.method.includes('/'))

describe('SC-9 a plugin method is a command', () => {
  test('sends the params exactly and prints one JSON document', async () => {
    const result = await run([
      'acme.notes', 'add', '--title', 'Groceries', '--tags', 'home', '--tags', 'weekly',
      '--pinned', '--priority', '2', '--meta', '{"src":"cli"}', '--json'
    ])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([
      { title: 'Groceries', tags: ['home', 'weekly'], pinned: true, priority: 2, meta: { src: 'cli' } }
    ])
    expect(JSON.parse(result.stdout)).toEqual({ id: 7, title: 'Groceries' })
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })
})

describe('SC-10 flag forms', () => {
  const sent = async (args: string[]) => {
    const result = await run(['acme.notes', 'add', ...args])
    expect(result.code).toBe(0)
    return daemon.methodCalls('acme.notes/add').at(-1)
  }

  test('a string flag keeps digits as a string', async () => {
    expect(await sent(['--title', '42'])).toEqual({ title: '42' })
  })
  test('an integer flag takes a space or =', async () => {
    expect(await sent(['--title', 'a', '--priority', '3'])).toEqual({ title: 'a', priority: 3 })
    expect(await sent(['--title', 'a', '--priority=3'])).toEqual({ title: 'a', priority: 3 })
  })
  test('a boolean flag is a switch or =false', async () => {
    expect(await sent(['--title', 'a', '--pinned'])).toEqual({ title: 'a', pinned: true })
    expect(await sent(['--title', 'a', '--pinned=false'])).toEqual({ title: 'a', pinned: false })
  })
  test('an enum flag takes one of its values', async () => {
    expect(await sent(['--title', 'a', '--color', 'blue'])).toEqual({ title: 'a', color: 'blue' })
  })
  test('an array flag repeats', async () => {
    expect(await sent(['--title', 'a', '--tags', 'a', '--tags', 'b'])).toEqual({ title: 'a', tags: ['a', 'b'] })
  })
  test('an object flag takes JSON', async () => {
    expect(await sent(['--title', 'a', '--meta', '{"k":1}'])).toEqual({ title: 'a', meta: { k: 1 } })
  })
  test('a camelCase property gets a kebab-case flag', async () => {
    daemon.addMethod('acme.notes/move', {
      params: { type: 'object', properties: { fooBar: { type: 'string' } } }
    })
    expect((await run(['acme.notes', 'move', '--foo-bar', 'x'])).code).toBe(0)
    expect(daemon.methodCalls('acme.notes/move')).toEqual([{ fooBar: 'x' }])
  })
})

describe('SC-11 usage errors', () => {
  test.each([
    [['--title', 'a', '--priority', 'high'], '--priority must be an integer, got "high"'],
    [['--title', 'a', '--color', 'green'], '--color must be one of red, blue, got "green"'],
    [['--title', 'a', '--pinned=yes'], '--pinned is a switch; got "yes"'],
    [['--title', 'a', '--meta', '{oops'], '--meta must be JSON: '],
    [['--title', 'a', '--priority', '9'], '--priority must be at most 5'],
    [['--title'], '--title requires a value'],
    [['--title', '--pinned'], '--title requires a value; write --title=<value> for a value starting with --'],
    [['--params', '{"title":1}'], 'params.title must be a string'],
    [[], 'missing required flag --title'],
    [['--title', 'a', 'extra'], 'unexpected argument "extra"']
  ])('%j -> %s', async (args, message) => {
    const result = await run(['acme.notes', 'add', ...args])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`quirky: ${message}`)
    expect(result.stderr).toContain("run 'quirky help' for usage")
    expect(methodCalls()).toEqual([])
  })

  test('every missing required flag is named, in declared order', async () => {
    daemon.addMethod('acme.notes/pair', {
      params: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] }
    })
    const result = await run(['acme.notes', 'pair'])
    expect(result.stderr).toContain('quirky: missing required flag --a, --b')
  })

  test('--params must be a JSON object', async () => {
    const result = await run(['acme.notes', 'add', '--params', '[1]'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('quirky: --params must be a JSON object')
  })
})

describe('SC-12 --params', () => {
  test('(a) supplies the whole object, including required properties', async () => {
    const result = await run(['acme.notes', 'add', '--params', '{"title":"a","tags":["x"]}'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'a', tags: ['x'] }])
  })

  test('(b) a property given both ways is a usage error', async () => {
    const result = await run(['acme.notes', 'add', '--params', '{"title":"a"}', '--title', 'b'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('quirky: title is given by both --params and --title')
    expect(methodCalls()).toEqual([])
  })

  test('(c) --json stays the global switch', async () => {
    const result = await run(['acme.notes', 'raw', '--params', '{"json":true}'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/raw')).toEqual([{ json: true }])
  })

  test('flags and --params combine when they name different properties', async () => {
    await run(['acme.notes', 'add', '--params', '{"title":"a"}', '--pinned'])
    expect(daemon.methodCalls('acme.notes/add')).toEqual([{ title: 'a', pinned: true }])
  })
})

describe('schema property names that collide with object internals or reserved flags', () => {
  const addPair = () =>
    daemon.addMethod('acme.notes/odd', {
      params: {
        type: 'object',
        properties: { constructor: { type: 'string' }, ['__proto__']: { type: 'string' }, toString: { type: 'string' } }
      } as Schema
    })

  test('omitted, they are not treated as supplied', async () => {
    addPair()
    const result = await run(['acme.notes', 'odd'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.notes/odd')).toEqual([{}])
  })

  test('a required constructor property is reported missing only when it is', async () => {
    daemon.addMethod('acme.notes/needs', {
      params: { type: 'object', properties: { constructor: { type: 'string' } }, required: ['constructor'] } as Schema
    })
    const missing = await run(['acme.notes', 'needs'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('quirky: missing required flag --constructor')
    expect((await run(['acme.notes', 'needs', '--constructor', 'x'])).code).toBe(0)
    expect(daemon.methodCalls('acme.notes/needs')).toEqual([{ constructor: 'x' }])
  })

  test('given, they are sent', async () => {
    addPair()
    const result = await run(['acme.notes', 'odd', '--constructor', 'c', '--__proto__', 'p', '--to-string', 't'])
    expect(result.code).toBe(0)
    const [sent] = daemon.methodCalls('acme.notes/odd')
    expect(Object.keys(sent).sort()).toEqual(['__proto__', 'constructor', 'toString'])
    expect(Object.getOwnPropertyDescriptor(sent, '__proto__')?.value).toBe('p')
    expect(sent.constructor).toBe('c')
    expect(sent.toString).toBe('t')
  })

  test('a __proto__ property given as JSON is sent, not swallowed as a prototype', async () => {
    daemon.addMethod('acme.notes/proto', {
      params: { type: 'object', properties: { ['__proto__']: { type: 'object', additionalProperties: true } } }
    })
    expect((await run(['acme.notes', 'proto', '--__proto__', '{"a":1}'])).code).toBe(0)
    const [sent] = daemon.methodCalls('acme.notes/proto')
    expect(Object.getOwnPropertyDescriptor(sent, '__proto__')?.value).toEqual({ a: 1 })
  })

  test('a required property named like a reserved flag is reported by path, not as a missing flag', async () => {
    for (const name of ['params', 'json', 'help']) {
      daemon.addMethod(`acme.notes/${name}`, {
        params: { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] }
      })
      const result = await run(['acme.notes', name])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`quirky: params.${name} is required`)
      expect(result.stderr).not.toContain('missing required flag')
    }
    expect(methodCalls()).toEqual([])
  })
})

describe('SC-13 groups and shadowing', () => {
  beforeEach(() => {
    daemon.addMethod('quirky.repo/list', { plugin: 'quirky.repo' })
    daemon.addMethod('quirky.repo/rename', {
      plugin: 'quirky.repo',
      params: {
        type: 'object',
        properties: { repoId: { type: 'string' }, name: { type: 'string' } },
        required: ['repoId', 'name']
      }
    })
    daemon.addMethod('job/list', { plugin: 'job' })
    daemon.addMethod('status/list', { plugin: 'status' })
  })

  test('a built-in plugin is a group without the quirky. prefix', async () => {
    const result = await run(['repo', 'rename', '--repo-id', 'r1', '--name', 'x'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('quirky.repo/rename')).toEqual([{ repoId: 'r1', name: 'x' }])
  })

  test('a bare kernel group lists its generated commands too', async () => {
    const result = await run(['repo'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('incomplete command "repo"')
    expect(result.stderr).toMatch(/repo rename /)
    expect(result.stderr).toMatch(/repo list /)
  })

  describe.each([
    ['the daemon is unavailable', () => new Error('could not connect to quirkyd')],
    ['api.describe fails', () => new RpcError(RpcErrorCode.Internal, 'describe failed')]
  ])('when %s', (_, failure) => {
    test('a bare kernel group falls back to the kernel listing', async () => {
      const err: string[] = []
      const code = await runMain({
        argv: ['repo'],
        env: {},
        cwd: '/',
        writer: { stdout: () => {}, stderr: (text) => err.push(text) },
        link: createDaemonLink(() => Promise.reject(failure())),
        openDesktopApp: async () => ({ ok: true })
      })
      expect(code).toBe(2)
      expect(err.join('')).toContain('incomplete command "repo"')
      expect(err.join('')).toMatch(/repo list /)
      expect(err.join('')).not.toMatch(/repo rename /)
    })
  })

  test('kernel group help never contacts the daemon', async () => {
    for (const args of [['repo', '--help'], ['repo', '-h'], ['help', 'repo']]) {
      expect((await run(args)).code).toBe(0)
    }
    expect(daemon.calls).toEqual([])
  })

  test('kernel commands win on shared words', async () => {
    daemon.addRepo('alpha')
    expect(JSON.parse((await run(['repo', 'list', '--json'])).stdout)).toHaveLength(1)
    expect((await run(['job', 'list'])).stdout).toBe('no jobs\n')
    expect(methodCalls()).toEqual([])
  })

  test('status list is the kernel status refusing the extra word', async () => {
    const result = await run(['status', 'list'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "list"')
    expect(methodCalls()).toEqual([])
  })
})

describe('SC-14 text forms', () => {
  test.each([
    ['done', 'done'],
    [3, '3'],
    [null, 'ok'],
    [{ ok: true }, 'ok'],
    [{ id: 7, title: 'Groceries', tags: ['home'] }, 'id: 7\ntitle: Groceries\ntags: ["home"]'],
    [[], 'none'],
    [['a', { b: 1 }], '"a"\n{"b":1}']
  ])('%j prints %j', async (result, printed) => {
    daemon.addMethod('acme.notes/show', {}, { result })
    expect((await run(['acme.notes', 'show'])).stdout).toBe(`${printed}\n`)
  })

  test('a list of objects is a table', async () => {
    daemon.addMethod('acme.notes/table', {}, { result: [{ id: 7, title: 'A' }, { id: 8, title: 'B' }] })
    const lines = (await run(['acme.notes', 'table'])).stdout.trimEnd().split('\n')
    expect(lines.map((line) => line.split(/\s+/))).toEqual([['ID', 'TITLE'], ['7', 'A'], ['8', 'B']])
  })
})

describe('formatGeneric', () => {
  test('a table spans the union of scalar keys, with - for missing and null cells', () => {
    const text = formatGeneric([{ id: 1, tags: ['x'] }, { id: 2, note: null, extra: 'e' }])
    expect(text.split('\n').map((line) => line.split(/\s+/))).toEqual([
      ['ID', 'NOTE', 'EXTRA'],
      ['1', '-', '-'],
      ['2', '-', 'e']
    ])
  })

  test('null values print as - in a record', () => {
    expect(formatGeneric({ a: null, b: false })).toBe('a: -\nb: false')
  })
})

describe('SC-15 a disabled method is unknown', () => {
  test('exits 2 and suggests commands in the same group', async () => {
    daemon.methods.delete('acme.notes/add')
    const result = await run(['acme.notes', 'add', '--title', 'a'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('quirky: unknown command "acme.notes add"')
    expect(result.stderr).toMatch(/did you mean: .*quirky acme\.notes list/)
    expect(result.stderr).not.toContain('quirky wt')
  })
})

describe('SC-16 help', () => {
  test('plugin command help is built from the declaration', async () => {
    const result = await run(['acme.notes', 'add', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      [
        'usage: quirky acme.notes add --title <string> [--body <string>] [--tags <string>]... [--pinned] [--priority <integer>] [--color red|blue] [--meta <json>] [--params <json>]',
        '',
        'Add a note.',
        '',
        'options:',
        "  --title <string>      required  The note's title",
        '  --body <string>                 The note text',
        '  --tags <string>...              Tags; repeat the flag',
        '  --pinned                        Pin the note',
        '  --priority <integer>            1 to 5',
        '  --color red|blue',
        '  --meta <json>',
        '  --params <json>                 all params as one JSON object',
        '',
        'global: --json prints machine-readable JSON',
        ''
      ].join('\n')
    )
  })

  test('plugin group help lists its commands with descriptions', async () => {
    const result = await run(['acme.notes', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('usage: quirky acme.notes <command>')
    expect(result.stdout).toMatch(/acme\.notes add .*Add a note\./)
    expect(result.stdout).toMatch(/acme\.notes count .*Count notes\./)
    expect(result.stdout).toMatch(/acme\.notes list .*List notes\./)
  })

  test('help <words> is the same as <words> --help', async () => {
    const viaHelp = await run(['help', 'acme.notes', 'add'])
    expect(viaHelp.stdout).toBe((await run(['acme.notes', 'add', '--help'])).stdout)
  })

  test('a bare plugin group is an incomplete command', async () => {
    const result = await run(['acme.notes'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('incomplete command "acme.notes"')
  })

  test('root and kernel help never contact the daemon', async () => {
    for (const args of [[], ['--help'], ['help'], ['wt', '--help'], ['wt', 'create', '--help'], ['help', 'wt', 'create']]) {
      expect((await run(args)).code).toBe(0)
    }
    expect(daemon.calls).toEqual([])
  })
})

describe('SC-17 unknown commands', () => {
  test('a typo in a kernel command suggests the real one', async () => {
    const result = await run(['wt', 'lst'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(
      'quirky: unknown command "wt lst"\ndid you mean: quirky wt list\nrun \'quirky help\' for usage\n'
    )
  })

  test('a typo in a plugin group suggests the real command', async () => {
    const result = await run(['acme.note', 'add'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('did you mean: quirky acme.notes add')
  })

  test('nothing close prints no suggestion line', async () => {
    const result = await run(['zzz'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('quirky: unknown command "zzz"\nrun \'quirky help\' for usage\n')
  })
})

describe('SC-18 unknown flags on generated commands', () => {
  test('names the valid flags, ending with the globals', async () => {
    const result = await run(['acme.notes', 'raw', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag --bogus for acme.notes raw\nvalid flags: --params, --json, --help')
  })
})

describe('SC-19 JSON errors', () => {
  const failure = async (args: string[]) => {
    const result = await run([...args, '--json'])
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    return { code: result.code, body: JSON.parse(result.stdout) }
  }

  test('an unknown command carries suggestions', async () => {
    expect(await failure(['wt', 'lst'])).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'unknown command "wt lst"', suggestions: ['wt list'] } }
    })
  })

  test('a missing required flag is a usage error', async () => {
    expect(await failure(['acme.notes', 'add'])).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'missing required flag --title' } }
    })
  })

  test('a schema failure in --params is a usage error', async () => {
    expect(await failure(['acme.notes', 'add', '--params', '{"title":1}'])).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'params.title must be a string' } }
    })
  })

  test('a daemon not-found is code not-found, exit 1', async () => {
    const { code, body } = await failure(['plugin', 'enable', 'nope'])
    expect(code).toBe(1)
    expect(body.error.code).toBe('not-found')
  })

  test.each([
    [RpcErrorCode.InvalidParams, 'invalid-params'],
    [RpcErrorCode.Conflict, 'conflict'],
    [RpcErrorCode.MethodNotFound, 'method-not-found'],
    [RpcErrorCode.Unauthorized, 'unauthorized'],
    [RpcErrorCode.Internal, 'internal']
  ])('a daemon error %i maps to %s', async (rpcCode, name) => {
    daemon.addMethod('acme.notes/bad', {}, { error: { code: rpcCode, message: 'nope' } })
    expect(await failure(['acme.notes', 'bad'])).toEqual({ code: 1, body: { error: { code: name, message: 'nope' } } })
  })

  test('the flag position of --json does not matter, and the last --json=<bool> wins', async () => {
    const early = await run(['--json', 'wt', 'lst'])
    expect(JSON.parse(early.stdout).error.code).toBe('usage')
    const off = await run(['wt', 'lst', '--json', '--json=false'])
    expect(off.stdout).toBe('')
    expect(off.stderr).toContain('quirky: unknown command "wt lst"')
  })

  test('an unreachable daemon is daemon-unavailable, exit 1', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runMain({
      argv: ['status', '--json'],
      env: {},
      cwd: '/',
      writer: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      link: createDaemonLink(() => Promise.reject(new Error('could not connect to quirkyd'))),
      openDesktopApp: async () => ({ ok: true })
    })
    expect(code).toBe(1)
    expect(err).toEqual([])
    expect(JSON.parse(out.join(''))).toEqual({
      error: { code: 'daemon-unavailable', message: 'could not connect to quirkyd' }
    })
  })

  test('an unreachable daemon in text mode keeps the plain message', async () => {
    const err: string[] = []
    const code = await runMain({
      argv: ['status'],
      env: {},
      cwd: '/',
      writer: { stdout: () => {}, stderr: (text) => err.push(text) },
      link: createDaemonLink(() => Promise.reject(new Error('could not connect to quirkyd'))),
      openDesktopApp: async () => ({ ok: true })
    })
    expect(code).toBe(1)
    expect(err.join('')).toBe('quirky: could not connect to quirkyd\n')
  })

  test('job run failure under --json prints only the run document', async () => {
    daemon.addJob('job:acme.poll/tick')
    daemon.jobRuns.set('job:acme.poll/tick', { startedAt: 10, finishedAt: 25, status: 'failed', error: 'boom' })
    const result = await run(['job', 'run', 'job:acme.poll/tick', '--json'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout).status).toBe('failed')
  })
})

describe('rawArgs commands', () => {
  test('receive every token after their words, global switches included', async () => {
    const seen: string[][] = []
    const raw: Command = {
      name: 'rawtest',
      summary: '',
      positionals: [],
      flags: {},
      methods: [],
      plugin: null,
      rawArgs: true,
      async run(args) {
        seen.push(args.positionals)
      }
    }
    COMMANDS.push(raw)
    try {
      const code = await runMain({
        argv: ['rawtest', '--json', 'x', '--weird', 'y', '--', '--json'],
        env: {},
        cwd: '/',
        writer: { stdout: () => {}, stderr: () => {} },
        link: createDaemonLink(() => Promise.reject(new Error('unused'))),
        openDesktopApp: async () => ({ ok: true })
      })
      expect(code).toBe(0)
      expect(seen).toEqual([['--json', 'x', '--weird', 'y', '--', '--json']])
    } finally {
      COMMANDS.pop()
    }
  })
})

describe('generatedCommands', () => {
  const entry = (overrides: Partial<ApiMethodEntry>): ApiMethodEntry => ({
    name: 'acme.notes/add',
    plugin: 'acme.notes',
    params: { type: 'object' },
    result: {},
    ...overrides
  })
  const description = (...methods: ApiMethodEntry[]): ApiDescription => ({
    schemaVersion: 1,
    daemonVersion: 'x',
    protocolVersion: 1,
    methods,
    events: [],
    uiCommands: []
  })

  test('groupOf drops only a leading quirky.', () => {
    expect(groupOf('quirky.repo')).toBe('repo')
    expect(groupOf('acme.quirky.x')).toBe('acme.quirky.x')
  })

  test('kernel methods produce no command', () => {
    expect(generatedCommands(description(entry({ name: 'repo.list', plugin: null })))).toEqual([])
  })

  test('maps schema types to flags, skipping reserved flag names', () => {
    const [command] = generatedCommands(
      description(
        entry({
          description: 'First line.\nSecond.',
          params: {
            type: 'object',
            properties: {
              n: { type: 'number' },
              nums: { type: 'array', items: { type: 'integer' } },
              objs: { type: 'array', items: { type: 'object' } },
              any: {},
              json: { type: 'boolean' },
              help: { type: 'boolean' },
              params: { type: 'string' },
              level: { type: 'integer', enum: [1, 2] }
            },
            required: ['n']
          }
        })
      )
    )
    expect(command.name).toBe('acme.notes add')
    expect(command.summary).toBe('First line.')
    expect(command.methods).toEqual(['acme.notes/add'])
    expect(command.plugin).toBe('acme.notes')
    expect(command.flags).toEqual({
      n: { type: 'number', description: '', required: true },
      nums: { type: 'integer', description: '', repeatable: true },
      objs: { type: 'json', description: '' },
      any: { type: 'json', description: '' },
      level: { type: 'integer', description: '', enum: [1, 2] },
      params: { type: 'json', description: 'all params as one JSON object' }
    })
  })
})

describe('resolveCommands', () => {
  const kernel = COMMANDS.filter((command) => ['status', 'repo list', 'job list'].includes(command.name))
  const gen = (plugin: string, name: string): Command => ({
    name,
    summary: '',
    positionals: [],
    flags: {},
    methods: [],
    plugin,
    async run() {}
  })

  test('kernel commands shadow equal names and extensions of their words', () => {
    const { active, shadowed } = resolveCommands(kernel, [
      gen('quirky.repo', 'repo list'),
      gen('quirky.repo', 'repo rename'),
      gen('status', 'status list'),
      gen('job', 'job list')
    ])
    expect(active.map((command) => command.name)).toEqual(['repo rename'])
    expect(shadowed.map((command) => [command.name, command.shadowedBy])).toEqual([
      ['repo list', 'kernel repo list'],
      ['job list', 'kernel job list'],
      ['status list', 'kernel status']
    ])
  })

  test('built-ins win over installed plugins, which win by sort order', () => {
    const { active, shadowed } = resolveCommands([], [
      gen('zeta', 'dup x'),
      gen('alpha', 'dup x'),
      gen('quirky.dup', 'dup x')
    ])
    expect(active.map((command) => command.plugin)).toEqual(['quirky.dup'])
    expect(shadowed.map((command) => command.shadowedBy)).toEqual(['quirky.dup dup x', 'quirky.dup dup x'])
  })
})

describe('suggestCommands', () => {
  const names = ['wt list', 'wt create', 'acme.notes add', 'acme.notes list', 'status']

  test('offers near misses, prefixes and group members, closest first', () => {
    expect(suggestCommands('wt lst', names)).toEqual(['wt list'])
    expect(suggestCommands('acme.note add', names)).toEqual(['acme.notes add'])
    expect(suggestCommands('stat', names)).toEqual(['status'])
  })

  test('falls back to the typed group when nothing is close', () => {
    expect(suggestCommands('acme.notes remove', names)).toEqual(['acme.notes add', 'acme.notes list'])
  })

  test('never offers the typed text or more than three', () => {
    expect(suggestCommands('status', names)).toEqual([])
    expect(suggestCommands('acme.notes', ['acme.notes a', 'acme.notes b', 'acme.notes c', 'acme.notes d'])).toHaveLength(3)
  })

  test('says nothing when nothing is close', () => {
    expect(suggestCommands('zzz', names)).toEqual([])
  })
})
