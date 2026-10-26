import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme.tools', name: 'Acme', version: '1.0.0' }

function result(manifest: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, ...manifest }), {
    dirName: 'acme.tools',
    dir: '/plugins/acme.tools',
    source: 'installed',
  })
}

function errorsOf(manifest: Record<string, unknown>): string[] {
  const parsed = result(manifest)
  if (parsed.ok) throw new Error('expected the manifest to be rejected')
  return parsed.errors
}

const contributes = (kind: string, ...entries: Record<string, unknown>[]) => ({ contributes: { [kind]: entries } })
const methods = (...entries: Record<string, unknown>[]) => contributes('method', ...entries)
const commands = (...entries: Record<string, unknown>[]) => contributes('cli-command', ...entries)

describe('manifest cli and cliAliases', () => {
  test('accepts a relative cli path and valid aliases', () => {
    expect(result({ cli: 'cli.ts', cliAliases: ['tools', 'tl-2'] }).ok).toBe(true)
  })

  test('checks cli like main', () => {
    expect(errorsOf({ cli: '../cli.ts' })).toEqual([
      "field 'cli' must be a relative path inside the plugin directory, got '../cli.ts'",
    ])
    expect(errorsOf({ cli: '/abs/cli.ts' })).toEqual([
      "field 'cli' must be a relative path inside the plugin directory, got '/abs/cli.ts'",
    ])
    expect(errorsOf({ cli: '' })).toEqual(["field 'cli' must be a non-empty string"])
    expect(errorsOf({ cli: 3 })).toEqual(["field 'cli' must be a non-empty string"])
  })

  test('requires cliAliases to be an array of strings', () => {
    expect(errorsOf({ cliAliases: 'wt' })).toEqual(["field 'cliAliases' must be an array of strings"])
    expect(errorsOf({ cliAliases: ['ok', 4] })).toEqual(['cliAliases[1] must be a string'])
  })

  test('rejects aliases that are not lowercase words', () => {
    expect(errorsOf({ cliAliases: ['Tools', '1x', 'a b', ''] })).toEqual([
      "cliAliases: 'Tools' must be a lowercase word such as 'tools' or 'my-tools'",
      "cliAliases: '1x' must be a lowercase word such as 'tools' or 'my-tools'",
      "cliAliases: 'a b' must be a lowercase word such as 'tools' or 'my-tools'",
      "cliAliases: '' must be a lowercase word such as 'tools' or 'my-tools'",
    ])
  })

  test('rejects duplicate aliases and the plugin\'s own group word', () => {
    expect(errorsOf({ cliAliases: ['tl', 'tl'] })).toEqual(["cliAliases: duplicate alias 'tl'"])
    const builtin = parseManifest(
      JSON.stringify({ id: 'quirky.tools', name: 'Tools', version: '1.0.0', cliAliases: ['tools', 'tl'] }),
      { dirName: 'quirky.tools', dir: '/plugins/quirky.tools', source: 'builtin' },
    )
    expect(builtin).toEqual({ ok: false, errors: ["cliAliases: 'tools' is the plugin's own group word"] })
  })
})

describe('method entries', () => {
  test('accepts readOnly, connection and a destructive method with confirm and describe', () => {
    const parsed = result(
      methods(
        { id: 'peek', readOnly: true },
        { id: 'attach', connection: true },
        { id: 'wipe', destructive: true, confirm: 'Wipe {target}?', describe: 'peek' },
        { id: 'wipeAll', destructive: true, confirm: 'Wipe all?', describe: 'acme.tools/peek' },
      ),
    )
    expect(parsed.ok).toBe(true)
  })

  test('requires booleans for the flags', () => {
    expect(errorsOf(methods({ id: 'a', readOnly: 'yes', destructive: 1, connection: null }))).toEqual([
      'method a: readOnly must be a boolean',
      'method a: destructive must be a boolean',
      'method a: connection must be a boolean',
    ])
  })

  test('requires a confirm text when destructive', () => {
    expect(errorsOf(methods({ id: 'wipe', destructive: true }))).toEqual([
      'method wipe: confirm is required when destructive is true',
    ])
    expect(errorsOf(methods({ id: 'wipe', destructive: true, confirm: '' }))).toEqual([
      'method wipe: confirm must be a non-empty string',
    ])
    expect(errorsOf(methods({ id: 'wipe', destructive: true, confirm: 5 }))).toEqual([
      'method wipe: confirm must be a non-empty string',
    ])
  })

  test('refuses confirm and describe unless the method is destructive', () => {
    expect(errorsOf(methods({ id: 'a', confirm: 'Sure?' }))).toEqual(['method a: confirm needs destructive: true'])
    expect(errorsOf(methods({ id: 'a', destructive: false, confirm: 'Sure?' }))).toEqual([
      'method a: confirm needs destructive: true',
    ])
    expect(errorsOf(methods({ id: 'a', describe: 'peek' }))).toEqual(['method a: describe needs destructive: true'])
  })

  test('checks describe is a name or a full ID of a readOnly method of the same plugin', () => {
    expect(errorsOf(methods({ id: 'wipe', destructive: true, confirm: 'x', describe: 'bad name' }))).toEqual([
      'method wipe: describe must be a method name or <pluginId>/<name>',
    ])
    expect(errorsOf(methods({ id: 'wipe', destructive: true, confirm: 'x', describe: 'missing' }))).toEqual([
      "method wipe: describe 'missing' is not a readOnly method of this plugin",
    ])
    expect(
      errorsOf(methods({ id: 'peek' }, { id: 'wipe', destructive: true, confirm: 'x', describe: 'peek' })),
    ).toEqual(["method wipe: describe 'peek' is not a readOnly method of this plugin"])
    expect(
      errorsOf(methods({ id: 'peek', readOnly: true }, { id: 'wipe', destructive: true, confirm: 'x', describe: 'other.plugin/peek' })),
    ).toEqual(["method wipe: describe 'other.plugin/peek' is not a readOnly method of this plugin"])
  })

  test('still rejects unknown fields', () => {
    expect(errorsOf(methods({ id: 'a', secret: true }))).toEqual(['method a: unknown field `secret`'])
  })
})

describe('cli-command entries', () => {
  const generic = { id: 'list', summary: 'List things', method: 'list' }
  const listMethod = { id: 'list' }

  test('accepts a generic command, a bare command and a module command', () => {
    const parsed = result({
      cli: 'cli.ts',
      contributes: {
        method: [listMethod, { id: 'make' }],
        'cli-command': [
          generic,
          { id: 'root', words: '', summary: 'The bare command', method: 'make' },
          { id: 'nested', words: 'deep dive', summary: 'Runs code' },
          {
            id: 'full',
            summary: 'Everything',
            method: 'acme.tools/list',
            methods: ['acme.tools/list', 'status.get'],
            positionals: [{ name: 'target', description: 'the target', required: true, param: 'targetId' }, { name: 'extra', description: 'more' }],
            flags: {
              'max-rows': { type: 'integer', description: 'rows', required: true, param: 'maxRows' },
              mode: { type: 'string', description: 'mode', enum: ['a', 'b'], repeatable: true },
              payload: { type: 'json', description: 'raw' },
              flag: { type: 'boolean', description: 'on' },
              ratio: { type: 'number', description: 'r' },
            },
          },
        ],
      },
    })
    expect(parsed.ok).toBe(true)
  })

  test('requires a string summary and rejects unknown fields', () => {
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go' }) })).toEqual(['cli-command go: summary is required'])
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 4 }) })).toEqual([
      'cli-command go: summary must be a non-empty string',
    ])
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', title: 't' }) })).toEqual([
      'cli-command go: unknown field `title`',
    ])
  })

  test('checks words', () => {
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', words: 3 }) })).toEqual([
      'cli-command go: words must be a string',
    ])
    const bad = ['Go', 'a  b', ' a', 'a ', '1a', 'a_b']
    for (const words of bad) {
      expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', words }) })).toEqual([
        `cli-command go: words '${words}' must be space-separated lowercase words`,
      ])
    }
  })

  test('applies the word rule to the id when words is omitted', () => {
    expect(result({ cli: 'c.ts', ...commands({ id: 'do-it', summary: 's' }) }).ok).toBe(true)
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'DoIt', summary: 's' }) })).toEqual([
      "cli-command DoIt: words 'DoIt' must be space-separated lowercase words",
    ])
  })

  test('checks method, methods and the string types', () => {
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', method: 3 }) })).toEqual([
      'cli-command go: method must be a method name or <pluginId>/<name>',
    ])
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', method: 'a/b/c' }) })).toEqual([
      'cli-command go: method must be a method name or <pluginId>/<name>',
    ])
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', methods: 'x' }) })).toEqual([
      'cli-command go: methods must be a list of method names',
    ])
    expect(errorsOf({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', methods: ['ok', ''] }) })).toEqual([
      'cli-command go: methods must be a list of method names',
    ])
  })

  test('checks positionals', () => {
    const entry = (positionals: unknown) => ({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', positionals }) })
    expect(errorsOf(entry('x'))).toEqual(['cli-command go: positionals must be a list'])
    expect(errorsOf(entry(['x']))).toEqual(['cli-command go: positionals[0] must be an object'])
    expect(errorsOf(entry([{ description: 'd' }]))).toEqual(['cli-command go: positionals[0].name must be a lowercase word'])
    expect(errorsOf(entry([{ name: 'a' }]))).toEqual(['cli-command go: positionals[0].description must be a string'])
    expect(errorsOf(entry([{ name: 'a', description: 'd', required: 'y', param: '' }]))).toEqual([
      'cli-command go: positionals[0].required must be a boolean',
      'cli-command go: positionals[0].param must be a non-empty string',
    ])
    expect(errorsOf(entry([{ name: 'a', description: 'd', extra: 1 }]))).toEqual([
      'cli-command go: positionals[0] has unknown field `extra`',
    ])
    expect(
      errorsOf(entry([{ name: 'a', description: 'd' }, { name: 'a', description: 'e' }])),
    ).toEqual(["cli-command go: positionals[1] repeats the name 'a'"])
  })

  test('checks flags', () => {
    const entry = (flags: unknown) => ({ cli: 'c.ts', ...commands({ id: 'go', summary: 's', flags }) })
    expect(errorsOf(entry([]))).toEqual(['cli-command go: flags must be an object'])
    expect(errorsOf(entry({ Bad: { type: 'string', description: 'd' } }))).toEqual([
      "cli-command go: flag 'Bad' must be a kebab-case name",
    ])
    expect(errorsOf(entry({ yes: { type: 'boolean', description: 'd' } }))).toEqual([
      "cli-command go: flag 'yes' is reserved",
    ])
    for (const reserved of ['help', 'json', 'params', 'retry-request', 'version', 'confirmation']) {
      expect(errorsOf(entry({ [reserved]: { type: 'string', description: 'd' } }))).toEqual([
        `cli-command go: flag '${reserved}' is reserved`,
      ])
    }
    expect(errorsOf(entry({ a: 'x' }))).toEqual(["cli-command go: flag 'a' must be an object"])
    expect(errorsOf(entry({ a: { type: 'array', description: 'd' } }))).toEqual([
      "cli-command go: flag 'a' type must be one of string, integer, number, boolean, json",
    ])
    expect(errorsOf(entry({ a: { type: 'string' } }))).toEqual(["cli-command go: flag 'a' description must be a string"])
    expect(
      errorsOf(entry({ a: { type: 'string', description: 'd', required: 1, repeatable: 'x', enum: 'ab', param: '' } })),
    ).toEqual([
      "cli-command go: flag 'a' required must be a boolean",
      "cli-command go: flag 'a' repeatable must be a boolean",
      "cli-command go: flag 'a' enum must be a non-empty list of strings or numbers",
      "cli-command go: flag 'a' param must be a non-empty string",
    ])
    expect(errorsOf(entry({ a: { type: 'string', description: 'd', color: 1 } }))).toEqual([
      "cli-command go: flag 'a' has unknown field `color`",
    ])
  })

  test('requires cli when there is no method', () => {
    expect(errorsOf(commands({ id: 'go', summary: 's' }))).toEqual([
      "cli-command go: needs the manifest field 'cli' because it declares no method",
    ])
    expect(result({ contributes: { method: [listMethod], 'cli-command': [generic] } }).ok).toBe(true)
  })

  test('requires a short method to be declared by the plugin, and leaves full names alone', () => {
    expect(errorsOf(commands({ id: 'go', summary: 's', method: 'nothing' }))).toEqual([
      "cli-command go: method 'nothing' is not a method this plugin declares",
    ])
    expect(result(commands({ id: 'go', summary: 's', method: 'other.plugin/list' })).ok).toBe(true)
  })

  test('rejects two commands with the same effective words', () => {
    const manifest = {
      cli: 'c.ts',
      ...commands(
        { id: 'a', summary: 's', words: 'list' },
        { id: 'list', summary: 's' },
        { id: 'b', summary: 's', words: '' },
        { id: 'c', summary: 's', words: '' },
      ),
    }
    expect(errorsOf(manifest)).toEqual([
      "cli-command list: words 'list' are already used by cli-command a",
      'cli-command c: words are already used by cli-command b (the bare group command)',
    ])
  })
})
