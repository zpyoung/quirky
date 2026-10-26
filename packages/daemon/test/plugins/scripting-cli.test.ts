import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { runCli } from '../../../cli/test/fixtures/fake-daemon'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

// SC-19's "daemon unreachable" row is covered in-process by packages/cli/test/generated.test.ts.

const NOTE_PARAMS = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', description: "The note's title" },
    body: { type: 'string', description: 'The note text' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags; repeat the flag' },
    pinned: { type: 'boolean', description: 'Pin the note' },
    priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 to 5' },
    color: { type: 'string', enum: ['red', 'blue'] },
    meta: { type: 'object', additionalProperties: true }
  }
}

/** Methods whose handler returns a fixed result, one per row of SC-14's table. */
const SHAPES: Record<string, unknown> = {
  word: 'done',
  number: 3,
  nothing: null,
  flag: { ok: true },
  record: { id: 7, title: 'Groceries', tags: ['home'] },
  table: [
    { id: 7, title: 'A' },
    { id: 8, title: 'B' }
  ],
  empty: [],
  mixed: ['a', { b: 1 }]
}

const NOTES_MANIFEST = {
  id: 'acme.notes',
  contributes: {
    method: [
      { id: 'add', description: 'Add a note.', params: NOTE_PARAMS, result: { type: 'object' } },
      { id: 'list', description: 'List notes.', params: { type: 'object', properties: { limit: { type: 'integer' } } } },
      { id: 'count', description: 'Count notes.', result: { type: 'integer' } },
      { id: 'raw', description: 'Takes a param named json.', params: { type: 'object', properties: { json: { type: 'boolean' } } } },
      ...Object.keys(SHAPES).map((id) => ({ id, description: `Returns a ${id}.` }))
    ]
  }
}

const NOTES_BEHAVIOR = {
  activate: `
    const shapes = ${JSON.stringify(SHAPES)}
    const handle = (id: string, result: (params: any) => unknown) =>
      context.provide('method:acme.notes/' + id, (params: any) => {
        record('call ' + id + ' ' + JSON.stringify(params))
        return result(params)
      })
    handle('add', (params) => ({ id: 7, title: params.title }))
    handle('list', () => [{ id: 7, title: 'A' }])
    handle('count', () => 3)
    handle('raw', () => ({ ok: true }))
    for (const [id, value] of Object.entries(shapes)) handle(id, () => value)`
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

/** A real daemon with `acme.notes` installed and inactive, plus a handle on the real CLI. */
async function boot() {
  const home = makeTempHome('qs-')
  const marker = join(makeTempDir('qs-m-'), 'marker.log')
  writeModulePlugin(join(home, 'plugins'), marker, NOTES_MANIFEST, NOTES_BEHAVIOR)
  const harness = await startHarness({ home, builtinPluginsDir: null })
  harnesses.push(harness)
  const client = await harness.connect()
  const lines = () => readMarker(marker)
  return {
    client,
    cli: (...args: string[]) => runCli(args, { home }),
    /** Every method call the plugin received, as [method, params]. */
    calls: () =>
      lines()
        .filter((line) => line.startsWith('call '))
        .map((line) => {
          const [, id, ...rest] = line.split(' ')
          return [id, JSON.parse(rest.join(' '))] as [string, unknown]
        }),
    activated: () => lines().some((line) => line.startsWith('activate ')),
    state: async () => (await client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.notes')!.state
  }
}

type Env = Awaited<ReturnType<typeof boot>>

/** Runs a command that must succeed and returns the single call `acme.notes` received. */
async function sentParams(s: Env, ...args: string[]) {
  const result = await s.cli('acme.notes', 'add', ...args)
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  return s.calls().at(-1)![1]
}

describe('SC-9: a plugin method is a CLI command', () => {
  test('sends the params exactly and prints the result as one JSON document', async () => {
    const s = await boot()
    expect(await s.state()).toBe('inactive')
    const result = await s.cli(
      'acme.notes', 'add', '--title', 'Groceries', '--tags', 'home', '--tags', 'weekly',
      '--pinned', '--priority', '2', '--meta', '{"src":"cli"}', '--json'
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(s.calls()).toEqual([
      ['add', { title: 'Groceries', tags: ['home', 'weekly'], pinned: true, priority: 2, meta: { src: 'cli' } }]
    ])
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual({ id: 7, title: 'Groceries' })
    expect(await s.state()).toBe('active')
  })
})

describe('SC-10: each schema type has one flag form', () => {
  test('a string flag keeps digits as a string', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', '42')).toEqual({ title: '42' })
  })

  test('an integer flag takes a space or =', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', 'a', '--priority', '3')).toEqual({ title: 'a', priority: 3 })
    expect(await sentParams(s, '--title', 'a', '--priority=3')).toEqual({ title: 'a', priority: 3 })
  })

  test('a boolean flag is a switch or =false', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', 'a', '--pinned')).toEqual({ title: 'a', pinned: true })
    expect(await sentParams(s, '--title', 'a', '--pinned=false')).toEqual({ title: 'a', pinned: false })
  })

  test('an enum flag takes one of its values', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', 'a', '--color', 'blue')).toEqual({ title: 'a', color: 'blue' })
  })

  test('an array flag repeats', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', 'a', '--tags', 'a', '--tags', 'b')).toEqual({ title: 'a', tags: ['a', 'b'] })
  })

  test('an object flag takes JSON', async () => {
    const s = await boot()
    expect(await sentParams(s, '--title', 'a', '--meta', '{"k":1}')).toEqual({ title: 'a', meta: { k: 1 } })
  })

  test('a camelCase property gets a kebab-case flag', async () => {
    const home = makeTempHome('qs-')
    const marker = join(makeTempDir('qs-m-'), 'marker.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      {
        id: 'acme.notes',
        contributes: {
          method: [{ id: 'move', params: { type: 'object', properties: { fooBar: { type: 'string' } } } }]
        }
      },
      { activate: "context.provide('method:acme.notes/move', (params: any) => { record('call ' + JSON.stringify(params)); return null })" }
    )
    const harness = await startHarness({ home, builtinPluginsDir: null })
    harnesses.push(harness)
    const result = await runCli(['acme.notes', 'move', '--foo-bar', 'x'], { home })
    expect(result.code).toBe(0)
    expect(readMarker(marker).filter((line) => line.startsWith('call '))).toEqual(['call {"fooBar":"x"}'])
  })
})

describe('SC-11: a bad flag value is a usage error, and the method is not called', () => {
  const rows: [string[], string][] = [
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
  ]

  test.each(rows)('add %j -> %s', async (args, message) => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'add', ...args)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`quirky: ${message}`)
    expect(result.stderr).toContain("run 'quirky help' for usage")
    expect(await s.state()).toBe('inactive')
    expect(s.activated()).toBe(false)
    expect(s.calls()).toEqual([])
  })
})

describe('SC-12: --params gives the whole params object', () => {
  test('(a) calls the method with the object after checking it against the schema', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'add', '--params', '{"title":"a","tags":["x"]}')
    expect(result.code).toBe(0)
    expect(s.calls()).toEqual([['add', { title: 'a', tags: ['x'] }]])

    const bad = await s.cli('acme.notes', 'add', '--params', '{"title":1}')
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('quirky: params.title must be a string')
    expect(s.calls()).toHaveLength(1)
  })

  test('(b) a property given both ways exits 2', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'add', '--params', '{"title":"a"}', '--title', 'b')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('quirky: title is given by both --params and --title')
    expect(await s.state()).toBe('inactive')
    expect(s.calls()).toEqual([])
  })

  test('(c) a param named json is set through --params, and --json stays the global switch', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'raw', '--params', '{"json":true}')
    expect(result.code).toBe(0)
    expect(s.calls()).toEqual([['raw', { json: true }]])
    expect(result.stdout).toBe('ok\n')

    const asJson = await s.cli('acme.notes', 'raw', '--params', '{"json":true}', '--json')
    expect(asJson.code).toBe(0)
    expect(JSON.parse(asJson.stdout)).toEqual({ ok: true })
  })
})

describe('SC-14: a generated command prints a readable text form', () => {
  const printed: [string, string][] = [
    ['word', 'done\n'],
    ['number', '3\n'],
    ['nothing', 'ok\n'],
    ['flag', 'ok\n'],
    ['record', 'id: 7\ntitle: Groceries\ntags: ["home"]\n'],
    ['empty', 'none\n'],
    ['mixed', '"a"\n{"b":1}\n']
  ]

  test.each(printed)('%s prints %j', async (id, text) => {
    const s = await boot()
    const result = await s.cli('acme.notes', id)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(text)
  })

  test('a list of objects is a table with ID and TITLE columns', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'table')
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines.map((line) => line.split(/\s+/))).toEqual([['ID', 'TITLE'], ['7', 'A'], ['8', 'B']])
  })
})

describe('SC-16: help covers kernel and plugin commands from their declarations', () => {
  test('root help lists kernel commands and points to quirky api', async () => {
    const s = await boot()
    const result = await s.cli('--help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('wt list')
    expect(result.stdout).toContain('session new')
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe("run 'quirky api' to list every command, including plugins'")
    expect(s.activated()).toBe(false)
  })

  test('group help for a plugin lists its commands with their descriptions', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', '--help')
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/acme\.notes add .*Add a note\./)
    expect(result.stdout).toMatch(/acme\.notes count .*Count notes\./)
    expect(result.stdout).toMatch(/acme\.notes list .*List notes\./)
    expect(s.activated()).toBe(false)
  })

  test('command help shows the usage line, the description and one line per flag', async () => {
    const s = await boot()
    const result = await s.cli('acme.notes', 'add', '--help')
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
    expect(await s.state()).toBe('inactive')
  })

  test('a kernel command has the same shape, from its declaration', async () => {
    const s = await boot()
    const result = await s.cli('wt', 'create', '--help')
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0]).toStartWith('usage: quirky wt create ')
    expect(lines).toContain('options:')
    expect(lines.some((line) => /^ {2}--base <string> +ref to branch from$/.test(line))).toBe(true)
    expect(lines.at(-1)).toBe('global: --json prints machine-readable JSON')
  })
})

describe('SC-17: an unknown command gets suggestions', () => {
  test('a typo in a kernel command suggests the real one', async () => {
    const s = await boot()
    const result = await s.cli('wt', 'lst')
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('quirky: unknown command "wt lst"')
    expect(result.stderr).toContain('did you mean: quirky wt list')
  })

  test('a typo in a plugin group suggests the real command', async () => {
    const s = await boot()
    const result = await s.cli('acme.note', 'add')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command "acme.note add"')
    expect(result.stderr).toContain('did you mean: quirky acme.notes add')
  })

  test('nothing close prints no suggestion line', async () => {
    const s = await boot()
    const result = await s.cli('zzz')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command "zzz"')
    expect(result.stderr).not.toContain('did you mean')
  })
})

describe('SC-18: an unknown flag names the valid ones, and a valued flag needs its value', () => {
  test('an unknown flag lists the valid flags', async () => {
    const s = await boot()
    const result = await s.cli('wt', 'list', '--bogus')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag --bogus for wt list')
    expect(result.stderr).toContain('valid flags: --repo, --json, --help')
  })

  test.each([
    [['--prompt'], '--prompt requires a value'],
    [['--prompt', '--json'], '--prompt requires a value; write --prompt=<value> for a value starting with --']
  ])('session new ... %j -> %s, and no session starts', async (tail, message) => {
    const s = await boot()
    const result = await s.cli('session', 'new', '--agent', 'claude', '--worktree', 'w1', ...tail)
    expect(result.code).toBe(2)
    expect(result.stderr + result.stdout).toContain(message)
    expect(await s.client.call('session.list', {})).toEqual([])
  })
})

describe('SC-19: under --json, an error is JSON on stdout', () => {
  async function failure(s: Env, ...args: string[]) {
    const result = await s.cli(...args, '--json')
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    return { code: result.code, body: JSON.parse(result.stdout) }
  }

  test('an unknown command carries suggestions', async () => {
    const s = await boot()
    expect(await failure(s, 'wt', 'lst')).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'unknown command "wt lst"', suggestions: ['wt list'] } }
    })
  })

  test('a missing required flag is a usage error', async () => {
    const s = await boot()
    expect(await failure(s, 'acme.notes', 'add')).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'missing required flag --title' } }
    })
  })

  test('a daemon not-found is code not-found, exit 1', async () => {
    const s = await boot()
    const { code, body } = await failure(s, 'plugin', 'enable', 'nope')
    expect(code).toBe(1)
    expect(body.error.code).toBe('not-found')
    expect(typeof body.error.message).toBe('string')
  })

  test('a schema failure in --params is a usage error', async () => {
    const s = await boot()
    expect(await failure(s, 'acme.notes', 'add', '--params', '{"title":1}')).toEqual({
      code: 2,
      body: { error: { code: 'usage', message: 'params.title must be a string' } }
    })
  })

  test('a daemon invalid-params error exits 1', async () => {
    const s = await boot()
    expect(await failure(s, 'api', 'call', 'repo.add', '--path', '')).toEqual({
      code: 1,
      body: { error: { code: 'invalid-params', message: 'path must be a non-empty string' } }
    })
  })
})
