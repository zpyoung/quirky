import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandHelp, usageOf } from '../src/command-spec'
import { COMMANDS, helpText } from '../src/commands'
import type { Command } from '../src/commands/types'

const shape = (parts: Partial<Command>): Command => ({
  name: 'demo',
  summary: 'a demo.',
  positionals: [],
  flags: {},
  methods: [],
  plugin: null,
  async run() {},
  ...parts
})

describe('usageOf', () => {
  test('renders positionals, then flags in declared order', () => {
    const command = shape({
      name: 'wt create',
      positionals: [
        { name: 'repoId', description: '', required: true },
        { name: 'name', description: '', required: true }
      ],
      flags: { base: { type: 'string', description: '' } }
    })
    expect(usageOf(command)).toBe('wt create <repoId> <name> [--base <string>]')
  })

  test('optional positionals, required flags, switches, enums and repeatable flags', () => {
    const command = shape({
      name: 'acme add',
      positionals: [{ name: 'target', description: '', required: false }],
      flags: {
        title: { type: 'string', description: '', required: true },
        tags: { type: 'string', description: '', repeatable: true },
        pinned: { type: 'boolean', description: '' },
        force: { type: 'boolean', description: '', required: true },
        priority: { type: 'integer', description: '' },
        color: { type: 'string', description: '', enum: ['red', 'blue'] },
        level: { type: 'integer', description: '', enum: [1, 2], required: true },
        ids: { type: 'number', description: '', required: true, repeatable: true },
        meta: { type: 'json', description: '' }
      }
    })
    expect(usageOf(command)).toBe(
      'acme add [<target>] --title <string> [--tags <string>]... [--pinned] --force [--priority <integer>] ' +
        '[--color red|blue] --level 1|2 --ids <number>... [--meta <json>]'
    )
  })

  test('a command without arguments is just its name', () => {
    expect(usageOf(shape({ name: 'status' }))).toBe('status')
  })
})

describe('commandHelp', () => {
  test('lays out usage, summary, arguments, options and the global line', () => {
    const command = shape({
      name: 'acme add',
      summary: 'Add a note.',
      positionals: [{ name: 'target', description: 'where to add it', required: false }],
      flags: {
        title: { type: 'string', description: "The note's title", required: true },
        body: { type: 'string', description: 'The note text' },
        tags: { type: 'string', description: 'Tags; repeat the flag', repeatable: true },
        priority: { type: 'integer', description: '1 to 5' },
        color: { type: 'string', description: '', enum: ['red', 'blue'] }
      }
    })
    expect(commandHelp(command)).toBe(
      [
        'usage: quirky acme add [<target>] --title <string> [--body <string>] [--tags <string>]... [--priority <integer>] [--color red|blue]',
        '',
        'Add a note.',
        '',
        'arguments:',
        '  [<target>]  where to add it',
        '',
        'options:',
        "  --title <string>      required  The note's title",
        '  --body <string>                 The note text',
        '  --tags <string>...              Tags; repeat the flag',
        '  --priority <integer>            1 to 5',
        '  --color red|blue',
        '',
        'global: --json prints machine-readable JSON'
      ].join('\n')
    )
  })

  test('omits the sections a command does not have', () => {
    expect(commandHelp(shape({ name: 'status', summary: 'show daemon status' }))).toBe(
      'usage: quirky status\n\nshow daemon status\n\nglobal: --json prints machine-readable JSON'
    )
  })
})

describe('kernel command declarations', () => {
  const sources = new Map<string, string>()
  const sourceOf = (file: string) => {
    if (!sources.has(file)) sources.set(file, readFileSync(join(import.meta.dir, '../src/commands', `${file}.ts`), 'utf8'))
    return sources.get(file) as string
  }
  const sourceFiles = ['ask', 'job', 'open', 'plugin', 'repo', 'session', 'setting', 'status', 'term', 'theme', 'ui', 'worktree', 'support']

  test('every kernel command is declared as a kernel command with a summary', () => {
    for (const command of COMMANDS) {
      expect(command.plugin).toBeNull()
      expect(command.summary.length).toBeGreaterThan(0)
      expect(usageOf(command).startsWith(command.name)).toBe(true)
    }
  })

  test('each listed method is called by the command file or its helpers', () => {
    const text = sourceFiles.map(sourceOf).join('\n')
    for (const command of COMMANDS) {
      for (const method of command.methods) expect(text).toContain(`'${method}'`)
    }
  })

  test('methods follow what the run code calls', () => {
    const methods = (name: string) => COMMANDS.find((command) => command.name === name)?.methods
    expect(methods('session new')).toEqual(['worktree.list', 'session.create', 'session.createStructured'])
    expect(methods('ask')).toEqual(['ask.create', 'ask.wait', 'ask.cancel'])
    expect(methods('open')).toEqual([])
    expect(methods('help')).toEqual([])
  })

  test('required flags match what the commands demand', () => {
    const required = (name: string) =>
      Object.entries(COMMANDS.find((command) => command.name === name)?.flags ?? {})
        .filter(([, spec]) => spec.required)
        .map(([flag]) => flag)
    expect(required('ask')).toEqual(['spec'])
    expect(required('ask wait')).toEqual(['id'])
    expect(required('ask cancel')).toEqual(['id'])
    expect(required('session new')).toEqual(['agent'])
  })
})

describe('helpText', () => {
  test('an exact command gets its full help', () => {
    const text = helpText(['wt', 'create'])
    expect(text).toContain('usage: quirky wt create <repoId> <name> [--base <string>]')
    expect(text).toContain('options:')
  })

  test('the top level lists every command and points to quirky api', () => {
    const lines = helpText().split('\n')
    expect(lines[0]).toBe('usage: quirky [--json] <command> [options]')
    expect(lines.at(-1)).toBe("run 'quirky api' to list every command, including plugins")
    expect(lines.some((line) => line.includes('session new --agent <string>'))).toBe(true)
  })

  test('a group lists its commands without the api pointer', () => {
    const text = helpText(['setting'])
    expect(text).toContain('usage: quirky setting <command>')
    expect(text).toContain('setting set <id> <value>')
    expect(text).not.toContain('quirky api')
  })
})
