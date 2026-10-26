import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type ApiDescription, type PluginInfo } from '@quirky/protocol'
import { KERNEL_CLI_GROUPS } from '../../src/plugins/cli-catalog'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, moduleSource, removeTempDirs, writePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>

/** A daemon over temp built-in and installed plugin directories; every plugin gets a `main.ts` and a `cli.ts`. */
async function boot(plugins: { builtin?: Manifest[]; installed?: Manifest[] }) {
  const home = makeTempHome()
  const builtin = makeTempDir('qd-builtin-')
  const installed = join(home, 'plugins')
  const marker = join(makeTempDir(), 'marker.log')
  const write = (root: string, manifest: Manifest) =>
    writePlugin(
      root,
      { name: manifest.id, version: '1.0.0', main: 'main.ts', ...manifest },
      { 'main.ts': moduleSource(marker, manifest.id), 'cli.ts': 'export const commands = {}\n' },
    )
  const dirs = new Map<string, string>()
  for (const manifest of plugins.builtin ?? []) dirs.set(manifest.id, write(builtin, manifest))
  for (const manifest of plugins.installed ?? []) dirs.set(manifest.id, write(installed, manifest))
  const harness = await startHarness({ home, builtinPluginsDir: builtin })
  h = harness
  const client = await harness.connect()
  return {
    dirs,
    describe: () => client.call('api.describe', {}) as Promise<ApiDescription>,
    plugin: async (id: string) => ((await client.call('plugin.list', {})) as PluginInfo[]).find((p) => p.id === id)!,
  }
}

const worktree: Manifest = {
  id: 'quirky.worktree',
  cli: 'cli.ts',
  cliAliases: ['wt'],
  contributes: {
    method: [
      {
        id: 'list',
        description: 'Lists worktrees.\nSecond line.',
        readOnly: true,
        params: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'Repo selector' },
            includeMain: { type: 'boolean', description: 'Include the main worktree' },
            tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, description: 'Tags' },
            filter: { type: 'object', description: 'Free filter' },
            json: { type: 'string' },
          },
          required: ['repo'],
        },
      },
      {
        id: 'remove',
        destructive: true,
        confirm: 'Remove worktree {worktree}?',
        describe: 'list',
        params: { type: 'object', properties: { worktree: { type: 'string' } }, required: ['worktree'] },
      },
      { id: 'attach', connection: true },
    ],
    'cli-command': [
      { id: 'list', summary: 'List worktrees', method: 'list' },
      {
        id: 'rm',
        summary: 'Remove a worktree',
        method: 'remove',
        positionals: [{ name: 'worktree', description: 'The worktree', required: true }],
      },
      {
        id: 'fancy',
        words: 'fancy view',
        summary: 'Runs plugin code',
        methods: ['quirky.worktree/list', 'status.get'],
        positionals: [{ name: 'name', description: 'A name', param: 'title' }],
        flags: {
          'max-rows': { type: 'integer', description: 'Rows', required: true },
          mode: { type: 'string', description: 'Mode', enum: ['a', 'b'], repeatable: true, param: 'kind' },
        },
      },
      { id: 'root', words: '', summary: 'The bare command', method: 'quirky.worktree/list' },
    ],
  },
}

describe('api.describe cli section', () => {
  test('lists a group with its aliases and each declared command with words, module, methods and flags', async () => {
    const s = await boot({ builtin: [worktree] })
    const { cli } = await s.describe()

    expect(cli.groups).toEqual([{ plugin: 'quirky.worktree', words: 'worktree', aliases: ['wt'] }])
    const byId = new Map(cli.commands.map((command) => [command.id, command]))
    expect(cli.commands.map((command) => command.id)).toEqual([
      'cli-command:quirky.worktree/fancy',
      'cli-command:quirky.worktree/list',
      'cli-command:quirky.worktree/rm',
      'cli-command:quirky.worktree/root',
    ])
    const module = join(s.dirs.get('quirky.worktree')!, 'cli.ts')

    expect(byId.get('cli-command:quirky.worktree/fancy')).toEqual({
      id: 'cli-command:quirky.worktree/fancy',
      plugin: 'quirky.worktree',
      words: 'worktree fancy view',
      aliasWords: ['wt fancy view'],
      summary: 'Runs plugin code',
      positionals: [{ name: 'name', description: 'A name', required: false, param: 'title' }],
      flags: [
        { name: 'max-rows', type: 'integer', description: 'Rows', required: true, repeatable: false, param: 'maxRows' },
        {
          name: 'mode',
          type: 'string',
          description: 'Mode',
          required: false,
          repeatable: true,
          enum: ['a', 'b'],
          param: 'kind',
        },
      ],
      method: null,
      methods: ['quirky.worktree/list', 'status.get'],
      module,
    })
    expect(byId.get('cli-command:quirky.worktree/rm')).toMatchObject({
      words: 'worktree rm',
      aliasWords: ['wt rm'],
      positionals: [{ name: 'worktree', description: 'The worktree', required: true, param: 'worktree' }],
      flags: [],
      method: 'quirky.worktree/remove',
      methods: ['quirky.worktree/remove'],
      module,
    })
  })

  test('the bare command takes the group word alone', async () => {
    const s = await boot({ builtin: [worktree] })
    const root = (await s.describe()).cli.commands.find((command) => command.id.endsWith('/root'))!

    expect(root.words).toBe('worktree')
    expect(root.aliasWords).toEqual(['wt'])
    expect(root.method).toBe('quirky.worktree/list')
  })

  test('derives flags from the method params like a generated command, without a params flag', async () => {
    const s = await boot({ builtin: [worktree] })
    const list = (await s.describe()).cli.commands.find((command) => command.id.endsWith('/list'))!

    expect(list.flags).toEqual([
      { name: 'repo', type: 'string', description: 'Repo selector', required: true, repeatable: false, param: 'repo' },
      {
        name: 'include-main',
        type: 'boolean',
        description: 'Include the main worktree',
        required: false,
        repeatable: false,
        param: 'includeMain',
      },
      {
        name: 'tags',
        type: 'string',
        description: 'Tags',
        required: false,
        repeatable: true,
        enum: ['a', 'b'],
        param: 'tags',
      },
      { name: 'filter', type: 'json', description: 'Free filter', required: false, repeatable: false, param: 'filter' },
    ])
    expect(list.module).toBe(join(s.dirs.get('quirky.worktree')!, 'cli.ts'))
  })

  test('a positional fills its param instead of a derived flag, and a plugin without cli has no module', async () => {
    const s = await boot({
      installed: [
        {
          id: 'acme.tools',
          contributes: {
            method: [{ id: 'run', params: { type: 'object', properties: { target: { type: 'string' }, depth: { type: 'integer' } } } }],
            'cli-command': [
              { id: 'run', summary: 'Run', method: 'run', positionals: [{ name: 'target', description: 't' }] },
            ],
          },
        },
      ],
    })
    const [run] = (await s.describe()).cli.commands

    expect(run.flags.map((flag) => flag.name)).toEqual(['depth'])
    expect(run.module).toBeNull()
    expect(run.words).toBe('acme.tools run')
  })

  test('a method-only plugin gets a group and no commands, and a plugin with neither gets none', async () => {
    const s = await boot({
      installed: [
        { id: 'acme.methods', contributes: { method: [{ id: 'go' }] } },
        { id: 'acme.events', contributes: { event: [{ id: 'happened' }] } },
      ],
    })
    const { cli } = await s.describe()

    expect(cli.groups).toEqual([{ plugin: 'acme.methods', words: 'acme.methods', aliases: [] }])
    expect(cli.commands).toEqual([])
  })

  test('a command on another plugin\'s method keeps its full wire name and has no derived flags', async () => {
    const s = await boot({
      installed: [
        { id: 'acme.far', contributes: { 'cli-command': [{ id: 'go', summary: 'Go', method: 'other.plugin/go' }] } },
      ],
    })
    const [go] = (await s.describe()).cli.commands

    expect(go).toMatchObject({ method: 'other.plugin/go', methods: ['other.plugin/go'], flags: [] })
  })
})

describe('api.describe method flags', () => {
  test('carries readOnly, destructive, confirm and connection into the methods list', async () => {
    const s = await boot({ builtin: [worktree] })
    const methods = new Map((await s.describe()).methods.map((method) => [method.name, method]))

    expect(methods.get('quirky.worktree/list')).toMatchObject({ readOnly: true })
    expect(methods.get('quirky.worktree/list')).not.toHaveProperty('destructive')
    expect(methods.get('quirky.worktree/remove')).toMatchObject({
      destructive: true,
      confirm: 'Remove worktree {worktree}?',
    })
    expect(methods.get('quirky.worktree/attach')).toMatchObject({ connection: true })
  })
})

describe('group aliases', () => {
  const plugin = (id: string, cliAliases: string[]): Manifest => ({
    id,
    cliAliases,
    contributes: { method: [{ id: 'go' }] },
  })

  test('lists the accepted aliases on the plugin too', async () => {
    const s = await boot({ builtin: [plugin('quirky.one', ['uno', 'eins'])] })

    expect((await s.describe()).cli.groups).toEqual([{ plugin: 'quirky.one', words: 'one', aliases: ['uno', 'eins'] }])
  })

  test('drops an alias equal to another plugin\'s group word and warns on the plugin', async () => {
    const s = await boot({ installed: [plugin('acme.one', ['two', 'uno']), plugin('two', [])] })
    const { cli } = await s.describe()

    expect(cli.groups).toEqual([
      { plugin: 'acme.one', words: 'acme.one', aliases: ['uno'] },
      { plugin: 'two', words: 'two', aliases: [] },
    ])
    expect((await s.plugin('acme.one')).diagnostics).toEqual([
      { level: 'warning', message: "cliAliases: 'two' is dropped because it is the CLI group word of plugin two" },
    ])
  })

  test('keeps the first claimant of an alias, built-ins before installed, then by plugin ID', async () => {
    const s = await boot({
      builtin: [plugin('quirky.zeta', ['shared'])],
      installed: [plugin('acme.a', ['shared', 'a-only']), plugin('acme.b', ['shared'])],
    })
    const groups = new Map((await s.describe()).cli.groups.map((group) => [group.plugin, group]))

    expect(groups.get('quirky.zeta')!.aliases).toEqual(['shared'])
    expect(groups.get('acme.a')!.aliases).toEqual(['a-only'])
    expect(groups.get('acme.b')!.aliases).toEqual([])
    expect((await s.plugin('acme.b')).diagnostics).toEqual([
      { level: 'warning', message: "cliAliases: 'shared' is dropped because plugin quirky.zeta already uses it" },
    ])
  })

  test('drops an alias that is a kernel group word', async () => {
    expect(KERNEL_CLI_GROUPS).toEqual([
      'api', 'daemon', 'distro', 'help', 'job', 'open', 'plugin', 'setting', 'skill', 'status', 'theme', 'ui',
    ])
    const s = await boot({ installed: [plugin('acme.k', ['status', 'ok'])] })

    expect((await s.describe()).cli.groups[0].aliases).toEqual(['ok'])
    expect((await s.plugin('acme.k')).diagnostics).toEqual([
      { level: 'warning', message: "cliAliases: 'status' is dropped because it is a built-in CLI group" },
    ])
  })

  test('warns once however often the catalog is read', async () => {
    const s = await boot({ installed: [plugin('acme.k', ['status'])] })
    await s.describe()
    await s.describe()

    expect((await s.plugin('acme.k')).diagnostics).toHaveLength(1)
  })

  test('an alias only reaches the commands of groups that exist', async () => {
    const s = await boot({
      installed: [
        {
          id: 'acme.cmd',
          cliAliases: ['ac'],
          cli: 'cli.ts',
          contributes: { 'cli-command': [{ id: 'go', summary: 'Go' }, { id: 'root', words: '', summary: 'Bare' }] },
        },
      ],
    })
    const commands = (await s.describe()).cli.commands

    expect(commands.map((command) => [command.words, command.aliasWords])).toEqual([
      ['acme.cmd go', ['ac go']],
      ['acme.cmd', ['ac']],
    ])
  })
})
