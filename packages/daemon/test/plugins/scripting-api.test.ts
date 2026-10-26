import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_SCHEMA_VERSION, PROTOCOL_VERSION, type ApiCatalog, type Schema } from '@quirky/protocol'
import { runCli } from '../../../cli/test/fixtures/fake-daemon'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

type Manifest = { id: string } & Record<string, unknown>

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

/** A real daemon over temp built-in and installed plugin directories; `cli` runs the real `quirky` against it. */
async function boot(plugins: { builtin?: [Manifest, ModuleBehavior?][]; installed?: [Manifest, ModuleBehavior?][] }) {
  const home = makeTempHome()
  const builtin = makeTempDir('qd-b-')
  const marker = join(makeTempDir('qd-m-'), 'marker.log')
  for (const [manifest, behavior] of plugins.builtin ?? []) writeModulePlugin(builtin, marker, manifest, behavior)
  for (const [manifest, behavior] of plugins.installed ?? []) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const harness = await startHarness({ home, builtinPluginsDir: builtin })
  h = harness
  const client = await harness.connect()
  const cli = (...args: string[]) => runCli(args, { home })
  return {
    harness,
    client,
    cli,
    lines: () => readMarker(marker),
    state: async (id: string) => (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!.state,
    async catalog(): Promise<ApiCatalog> {
      const result = await cli('api', '--json')
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      return JSON.parse(result.stdout) as ApiCatalog
    }
  }
}

const addParams: Schema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', description: "The note's title" },
    body: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    pinned: { type: 'boolean' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    color: { type: 'string', enum: ['red', 'blue'] },
    meta: { type: 'object' }
  }
}
const noteResult: Schema = { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } } }

const notes: [Manifest, ModuleBehavior] = [
  {
    id: 'acme.notes',
    contributes: {
      method: [
        { id: 'add', description: 'Add a note.', params: addParams, result: noteResult },
        { id: 'list', description: 'List notes.', params: { type: 'object', properties: { limit: { type: 'integer' } } }, result: { type: 'array', items: noteResult } },
        { id: 'count', description: 'Count notes.', result: { type: 'integer' } }
      ],
      event: [{ id: 'added', description: 'A note was added.', data: { type: 'object', properties: { id: { type: 'integer' } } } }],
      command: [{ id: 'open', title: 'Open note', args: { type: 'object', required: ['noteId'], properties: { noteId: { type: 'string' } } } }]
    }
  },
  {
    activate: `
      context.provide('method:acme.notes/add', (params) => ({ id: 7, title: params.title }))
      context.provide('method:acme.notes/list', () => [{ id: 7, title: 'a' }])
      context.provide('method:acme.notes/count', () => 3)`
  }
]

describe('SC-1: a plugin method\'s schema is in the catalog, and listing it loads nothing', () => {
  test('the catalog carries the method, event, UI command and command, and acme.notes stays inactive', async () => {
    const s = await boot({ installed: [notes] })
    expect(await s.state('acme.notes')).toBe('inactive')

    const catalog = await s.catalog()

    expect(catalog.methods.find((m) => m.name === 'acme.notes/add')).toEqual({
      name: 'acme.notes/add',
      plugin: 'acme.notes',
      description: 'Add a note.',
      params: addParams,
      result: noteResult
    })
    expect(catalog.events.find((e) => e.name === 'acme.notes/added')).toMatchObject({
      plugin: 'acme.notes',
      data: { type: 'object', properties: { id: { type: 'integer' } } }
    })
    expect(catalog.uiCommands.find((c) => c.id === 'command:acme.notes/open')).toMatchObject({
      plugin: 'acme.notes',
      args: { type: 'object', required: ['noteId'], properties: { noteId: { type: 'string' } } }
    })
    expect(catalog.commands.find((c) => c.command === 'acme.notes add')).toMatchObject({
      plugin: 'acme.notes',
      methods: ['acme.notes/add']
    })
    expect(await s.state('acme.notes')).toBe('inactive')
    expect(s.lines()).toEqual([])
  })
})

describe('SC-13: a built-in\'s group drops quirky., and kernel commands win on shared words', () => {
  const listAndRename: [Manifest, ModuleBehavior] = [
    {
      id: 'quirky.repo',
      contributes: {
        method: [
          { id: 'list', description: 'List repos.' },
          {
            id: 'rename',
            description: 'Rename a repo.',
            params: { type: 'object', required: ['repoId', 'name'], properties: { repoId: { type: 'string' }, name: { type: 'string' } } }
          }
        ]
      }
    },
    {
      activate: `
        context.provide('method:quirky.repo/list', () => [{ id: 'builtin-repo' }])
        context.provide('method:quirky.repo/rename', (params) => { record('rename ' + JSON.stringify(params)); return params })`
    }
  ]
  const listOnly = (id: string): [Manifest] => [{ id, contributes: { method: [{ id: 'list', description: `List ${id}.` }] } }]

  test('repo rename calls the built-in and the shared words run the kernel commands', async () => {
    const s = await boot({ builtin: [listAndRename], installed: [listOnly('job'), listOnly('status')] })

    const rename = await s.cli('repo', 'rename', '--repo-id', 'r1', '--name', 'x')
    expect(rename.code).toBe(0)
    expect(s.lines()).toContain('rename {"repoId":"r1","name":"x"}')

    const repoList = await s.cli('repo', 'list')
    expect(repoList.code).toBe(0)
    expect(repoList.stdout).not.toContain('builtin-repo')
    const jobList = await s.cli('job', 'list')
    expect(jobList.code).toBe(0)
    expect(s.lines().filter((line) => line.startsWith('activate'))).toEqual(['activate quirky.repo'])

    const statusList = await s.cli('status', 'list')
    expect(statusList.code).toBe(2)
    expect(statusList.stderr).toContain('unexpected argument "list"')
  })

  test('the catalog marks the shadowed commands, and api call still reaches the built-in method', async () => {
    const s = await boot({ builtin: [listAndRename], installed: [listOnly('job'), listOnly('status')] })

    const catalog = await s.catalog()
    const entry = (command: string, plugin: string | null) =>
      catalog.commands.find((c) => c.command === command && c.plugin === plugin)
    expect(entry('repo list', 'quirky.repo')?.shadowedBy).toBe('kernel repo list')
    expect(entry('job list', 'job')?.shadowedBy).toBe('kernel job list')
    expect(entry('status list', 'status')?.shadowedBy).toBe('kernel status')
    expect(entry('repo rename', 'quirky.repo')).toMatchObject({ methods: ['quirky.repo/rename'] })
    expect(entry('repo rename', 'quirky.repo')?.shadowedBy).toBeUndefined()
    expect(entry('repo list', null)?.methods).toEqual(['repo.list'])

    const called = await s.cli('api', 'call', 'quirky.repo/list', '--json')
    expect(called.code).toBe(0)
    expect(JSON.parse(called.stdout)).toEqual([{ id: 'builtin-repo' }])
  })
})

describe('SC-15: a plugin method can be disabled and enabled without touching the CLI', () => {
  test('a disabled method is an unknown command with suggestions, and is unlisted until enabled', async () => {
    const s = await boot({ installed: [notes] })
    const commandNames = async () => (await s.catalog()).commands.map((c) => c.command)
    const methodNames = async () => (await s.catalog()).methods.map((m) => m.name)

    expect((await s.cli('plugin', 'disable', 'method:acme.notes/add')).code).toBe(0)
    const refused = await s.cli('acme.notes', 'add', '--title', 'a')
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('unknown command')
    expect(refused.stderr).toContain('acme.notes list')
    expect(await commandNames()).not.toContain('acme.notes add')
    expect(await methodNames()).not.toContain('acme.notes/add')

    expect((await s.cli('plugin', 'enable', 'method:acme.notes/add')).code).toBe(0)
    const added = await s.cli('acme.notes', 'add', '--title', 'a')
    expect(added.code).toBe(0)
    expect(added.stdout).toContain('id: 7')
    expect(await commandNames()).toContain('acme.notes add')
    expect(await methodNames()).toContain('acme.notes/add')
  })
})

describe('SC-20: quirky api lists everything, and --json is the catalog', () => {
  test('the text form groups commands and ends with the method and event counts', async () => {
    const s = await boot({ installed: [notes] })
    const catalog = await s.catalog()

    const result = await s.cli('api')
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines.at(-1)).toBe(`${catalog.methods.length} methods, ${catalog.events.length} events`)
    expect(lines).toContain('acme.notes')
    expect(lines).toContain('repo')
    expect(lines.find((line) => line.includes('acme.notes add --title'))).toContain('Add a note.')
  })

  test('the JSON form has the catalog shape with sorted lists and the kernel\'s positionals', async () => {
    const s = await boot({ installed: [notes] })
    const catalog = await s.catalog()
    const status = await s.client.call('status.get', {})

    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION)
    expect(catalog.schemaVersion).toBe(2)
    expect(catalog.daemonVersion).toBe(status.daemonVersion)
    expect(catalog.protocolVersion).toBe(PROTOCOL_VERSION)
    const sorted = (names: string[]) => expect(names).toEqual([...names].sort())
    sorted(catalog.methods.map((m) => m.name))
    sorted(catalog.events.map((e) => e.name))
    sorted(catalog.uiCommands.map((c) => c.id))
    sorted(catalog.commands.map((c) => c.command))

    const repoAdd = catalog.commands.find((c) => c.command === 'repo add')!
    expect(repoAdd.plugin).toBeNull()
    expect(repoAdd.methods).toEqual(['repo.add'])
    expect(repoAdd.positionals.map((p) => p.name)).toEqual(['path'])
    expect(repoAdd.positionals[0].required).toBe(true)

    const add = catalog.commands.find((c) => c.command === 'acme.notes add')!
    expect(add.summary).toBe('Add a note.')
    expect(add.flags.find((f) => f.name === 'title')).toMatchObject({ type: 'string', required: true, repeatable: false, description: "The note's title" })
  })
})

describe('SC-21: quirky api call reaches any method', () => {
  test('calls kernel and plugin methods and refuses connection and unknown methods', async () => {
    const s = await boot({ installed: [notes] })
    s.harness.git.addRepo('/fake/alpha')
    const repo = await s.client.call('repo.add', { path: '/fake/alpha' })

    const list = await s.cli('api', 'call', 'repo.list', '--json')
    expect(list.code).toBe(0)
    expect(JSON.parse(list.stdout)).toEqual(await s.client.call('repo.list', {}))
    expect(JSON.parse(list.stdout).map((r: { id: string }) => r.id)).toContain(repo.id)

    const count = await s.cli('api', 'call', 'acme.notes/count')
    expect(count.code).toBe(0)
    expect(count.stdout.trim()).toBe('3')

    const attach = await s.cli('api', 'call', 'terminal.attach')
    expect(attach.code).toBe(2)
    expect(attach.stderr).toContain("terminal.attach needs a live connection and can't be called from the CLI")

    const unknown = await s.cli('api', 'call', 'nope.nothing')
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown method nope.nothing')
  })

  test('a daemon refusal under --json is a JSON error on stdout with nothing on stderr', async () => {
    const s = await boot({ installed: [notes] })
    const refused = await s.cli('api', 'call', 'repo.add', '--path', '', '--json')
    expect(refused.code).toBe(1)
    expect(refused.stderr).toBe('')
    expect(JSON.parse(refused.stdout)).toMatchObject({ error: { code: 'invalid-params' } })
  })
})

describe('SC-22: the skill is generated from the catalog', () => {
  test('skill show prints the frontmatter, the conventions, one line per command, and the same bytes twice', async () => {
    const s = await boot({ installed: [notes] })

    const first = await s.cli('skill', 'show')
    expect(first.code).toBe(0)
    expect(first.stderr).toBe('')
    expect(first.stdout).toMatch(/^---\nname: quirky\n/)
    expect(first.stdout).toContain('quirky api --json')
    expect(first.stdout).toContain('--help')
    expect(first.stdout).toContain('--json')
    expect(first.stdout).toContain('exit')
    expect(first.stdout).toMatch(/quirky acme\.notes add --title <string> .*Add a note\./)

    const second = await s.cli('skill', 'show')
    expect(second.stdout).toBe(first.stdout)
  })
})

describe('SC-23: the skill installs into a folder and reports when it is stale', () => {
  test('status moves from missing to up-to-date, goes stale when a plugin is enabled, and an unchanged install is a no-op', async () => {
    const extra: [Manifest] = [
      { id: 'acme.extra', contributes: { method: [{ id: 'sync', description: 'Sync the extras.' }] } }
    ]
    const s = await boot({ installed: [notes, extra] })
    const dir = makeTempDir('qd-s-')
    const file = join(dir, 'quirky', 'SKILL.md')
    const status = async () => (await s.cli('skill', 'status', '--dir', dir)).stdout.trim()
    expect((await s.cli('plugin', 'disable', 'acme.extra')).code).toBe(0)

    expect(await status()).toBe('missing')
    const installed = await s.cli('skill', 'install', '--dir', dir)
    expect(installed.code).toBe(0)
    expect(installed.stdout.trim()).toBe('installed')
    expect(await status()).toBe('up-to-date')
    expect(readFileSync(file, 'utf8')).not.toContain('acme.extra sync')

    const before = statSync(file).mtimeMs
    await Bun.sleep(20)
    expect((await s.cli('skill', 'install', '--dir', dir)).stdout.trim()).toBe('up-to-date')
    expect(statSync(file).mtimeMs).toBe(before)

    expect((await s.cli('plugin', 'enable', 'acme.extra')).code).toBe(0)
    expect(await status()).toBe('stale')
    expect((await s.cli('skill', 'install', '--dir', dir)).stdout.trim()).toBe('installed')
    expect(await status()).toBe('up-to-date')
    expect(readFileSync(file, 'utf8')).toContain('acme.extra sync')
    expect(existsSync(join(s.harness.home, '.claude'))).toBe(false)
  })
})
