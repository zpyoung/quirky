import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectGroup, Repo, RepoDetails } from '@quirky/protocol'
import { commands } from '../cli'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { call, commitFiles, failure, git, isolateGitConfig, makeRepo } from './git-fixtures'
import { startPluginHarness, testCliContext, type PluginHarness } from './harness'

const { scratch } = isolateGitConfig()

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

async function start() {
  t = await startPluginHarness({ realGit: true })
  const home = scratch()
  const root = join(home, 'ws')
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  return { t, client: t.client, home, root }
}

type Flags = Record<string, unknown>
async function run(name: string, positionals: string[], flags: Flags, client: PluginHarness['client'], json = false) {
  const { ctx, lines } = testCliContext(client, { json })
  await commands[name]!({ positionals, flags }, ctx)
  return lines
}

describe('SC-2: repo add through the CLI', () => {
  test('refuses a plain folder with the hint, then adds it with --folder', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'notes.txt'), 'x')
    const { ctx } = testCliContext(client, { cwd: home })
    const err = await failure(commands.add!({ positionals: ['notes'], flags: {} }, ctx))
    expect(err.message).toBe(`not a git repository: ${notes}; pass --folder to add it as a folder project`)
    expect(err.data.reason).toBe('not-a-repository')

    const lines = await run('add', [notes], { folder: true }, client, true)
    expect(JSON.parse(lines[0]!)).toMatchObject({ name: 'notes', kind: 'folder', path: realpathSync(notes) })
  })
})

describe('SC-4 and SC-5: clone and create through the CLI', () => {
  test('clone prints the record; a repeat fails', async () => {
    const { client, home, root } = await start()
    const source = makeRepo(join(home, 'src'))
    const bare = join(home, 'origin.git')
    git(home, 'clone', '-q', '--bare', source, bare)
    const lines = await run('clone', [bare], {}, client)
    expect(lines[0]).toMatch(new RegExp(`^id: repo_[0-9a-f]+\\nname: origin\\npath: ${join(root, 'origin')}$`))
    const err = await failure(run('clone', [bare], {}, client))
    expect(err.data.reason).toBe('destination-exists')

    const named = await run('clone', [bare], { location: join(home, 'elsewhere'), name: 'other' }, client, true)
    expect(JSON.parse(named[0]!)).toMatchObject({ name: 'other', path: join(home, 'elsewhere', 'other') })
  })

  test('create initialises a repo in the worktrees folder', async () => {
    const { client, root } = await start()
    const lines = await run('create', ['scratch'], {}, client, true)
    expect(JSON.parse(lines[0]!)).toMatchObject({ name: 'scratch', path: join(root, 'scratch'), kind: 'git' })
  })
})

describe('SC-6 and SC-7: scan and import through the CLI', () => {
  function apps(home: string): string {
    const root = join(home, 'apps')
    makeRepo(join(root, 'web'))
    makeRepo(join(root, 'cli'))
    makeRepo(join(root, 'a', 'b', 'c', 'deep'))
    return realpathSync(root)
  }

  test('scan --json prints the result and --max-depth widens it; text is a table', async () => {
    const { client, home } = await start()
    const root = apps(home)
    const json = JSON.parse((await run('scan', [root], {}, client, true))[0]!)
    expect(json.repos.map((r: { name: string }) => r.name)).toEqual(['cli', 'web'])
    const deeper = JSON.parse((await run('scan', [root], { 'max-depth': 4 }, client, true))[0]!)
    expect(deeper.repos.map((r: { name: string }) => r.name)).toEqual(['deep', 'cli', 'web'])
    const text = (await run('scan', [root], {}, client))[0]!
    expect(text.split('\n')[0]).toMatch(/^NAME\s+PATH$/)
    expect(text).toContain(join(root, 'web'))
    expect((await run('scan', [join(home, 'nothing-here-at-all')], {}, client).catch((e) => e)).message).toContain('no such directory')
  })

  test('scan resolves a relative path against the CLI cwd', async () => {
    const { client, home } = await start()
    const root = apps(home)
    const { ctx, lines } = testCliContext(client, { cwd: home, json: true })
    await commands.scan!({ positionals: ['apps'], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!).repos).toHaveLength(2)
  })

  test('import --group reports each outcome and counts', async () => {
    const { client, home } = await start()
    const root = apps(home)
    await call(client, 'quirky.repo/add', { path: join(root, 'cli') })
    const json = JSON.parse((await run('import', [root], { group: 'apps' }, client, true))[0]!)
    expect(json).toMatchObject({ imported: 1, alreadyKnown: 1, failed: 0 })
    const text = (await run('import', [root], { group: 'apps' }, client))[0]!
    expect(text).toContain('imported 0, already known 2, failed 0')
    expect(text).toContain('group apps')
    expect(((await call(client, 'quirky.repo/groupList')) as ProjectGroup[])[0]).toMatchObject({ name: 'apps', parentPath: root })
  })
})

describe('SC-60 and SC-34: set and show through the CLI', () => {
  test('set takes every flag, show --json returns them with the hooks, and text shows key: value lines', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: echo shared\nmystery: 1\n' })
    await call(client, 'quirky.repo/add', { path: dir })
    await run(
      'set',
      ['api'],
      {
        'display-name': 'API',
        'default-base': 'origin/develop',
        'worktree-location': '../api-ws',
        'setup-policy': 'ask',
        'agent-startup': 'wait-for-setup',
        'command-source': 'run-both',
        'setup-script': 'make deps'
      },
      client
    )
    const shown = JSON.parse((await run('show', ['api'], {}, client, true))[0]!) as RepoDetails
    expect(shown.repo.displayName).toBe('API')
    expect(shown.settings).toEqual({
      defaultBase: 'origin/develop',
      worktreeLocation: '../api-ws',
      setupPolicy: 'ask',
      agentStartup: 'wait-for-setup',
      commandSource: 'run-both',
      setupScript: 'make deps',
      archiveScript: ''
    })
    expect(shown.hooks.setup).toMatchObject({ text: 'echo shared\nmake deps', source: 'both' })
    expect(shown.hooks.warnings).toEqual(['unrecognised key mystery'])

    const text = (await run('show', ['api'], {}, client))[0]!
    expect(text).toContain('name: api')
    expect(text).toContain('display name: API')
    expect(text).toContain('default base: origin/develop')
    expect(text).toContain('command source: run-both')
    expect(text).toContain('setup: quirky.yaml + local settings (shared script not trusted)')
    expect(text).toContain('warning: unrecognised key mystery')
  })

  test('set with no flags is a usage error', async () => {
    const { client, home } = await start()
    await call(client, 'quirky.repo/add', { path: makeRepo(join(home, 'api')) })
    const { ctx } = testCliContext(client)
    await expect(commands.set!({ positionals: ['api'], flags: {} }, ctx)).rejects.toThrow(/usage: nothing to set/)
  })

  test('trust-hooks defaults to all and takes --kind', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: a\n  archive: b\n' })
    await call(client, 'quirky.repo/add', { path: dir })
    await run('trust-hooks', ['api'], { kind: 'setup' }, client)
    let shown = JSON.parse((await run('show', ['api'], {}, client, true))[0]!) as RepoDetails
    expect([shown.hooks.setup?.shared?.trusted, shown.hooks.archive?.shared?.trusted]).toEqual([true, false])
    const lines = await run('trust-hooks', ['api'], {}, client)
    expect(lines[0]).toBe('trusted setup, archive hooks of api')
    shown = JSON.parse((await run('show', ['api'], {}, client, true))[0]!) as RepoDetails
    expect(shown.hooks.archive?.shared?.trusted).toBe(true)
    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: changed\n' })
    const again = JSON.parse((await run('show', ['api'], {}, client, true))[0]!) as RepoDetails
    expect(again.hooks.setup?.shared).toMatchObject({ trusted: false, changed: true })
  })
})

describe('SC-10: group commands', () => {
  test('the whole lifecycle from the CLI', async () => {
    const { client, home } = await start()
    await call(client, 'quirky.repo/add', { path: makeRepo(join(home, 'api')) })
    await call(client, 'quirky.repo/add', { path: makeRepo(join(home, 'web')) })
    const list = async () => JSON.parse((await run('group-list', [], {}, client, true))[0]!) as ProjectGroup[]

    expect(await run('group-list', [], {}, client)).toEqual(['no groups'])
    await run('group-create', ['backend'], {}, client)
    await run('group-add', ['backend', 'api'], {}, client)
    await run('group-add', ['backend', 'web'], {}, client)
    expect((await list())[0]!.repoIds).toHaveLength(2)

    const text = (await run('group-list', [], {}, client))[0]!
    expect(text.split('\n')[0]).toMatch(/^ID\s+NAME\s+PROJECTS\s+COLLAPSED\s+PARENT$/)
    expect(text).toMatch(/backend\s+api, web\s+no\s+-/)

    await run('group-rename', ['backend', 'services'], {}, client)
    await run('group-collapse', ['services'], {}, client)
    expect(await list()).toMatchObject([{ name: 'services', collapsed: true }])
    await run('group-collapse', ['services'], { expand: true }, client)
    expect((await list())[0]!.collapsed).toBe(false)
    await run('group-remove', ['services', 'web'], {}, client)
    expect((await list())[0]!.repoIds).toHaveLength(1)
    expect(await run('group-delete', ['services'], {}, client)).toEqual(['deleted group services'])
    expect(await list()).toEqual([])
    expect(((await call(client, 'quirky.repo/list')) as Repo[]).every((r) => r.groupId === null)).toBe(true)
  })

  test('group-create takes --parent-path', async () => {
    const { client } = await start()
    await run('group-create', ['apps'], { 'parent-path': '/tmp/w/apps' }, client)
    expect(((await call(client, 'quirky.repo/groupList')) as ProjectGroup[])[0]!.parentPath).toBe('/tmp/w/apps')
  })
})

describe('SC-61: the manifest', () => {
  test('lists every new method with a params schema and every new command through the real CLI', async () => {
    const { t: harness, client } = await start()
    const catalog = (await call(client, 'api.describe')) as {
      methods: { name: string; params?: unknown }[]
      cli: { commands: { words: string; plugin: string }[] }
    }
    const methods = new Map(catalog.methods.map((m) => [m.name, m]))
    for (const name of ['list', 'add', 'clone', 'create', 'scan', 'import', 'remove', 'resolve', 'show', 'set', 'hooks', 'trustHooks', 'groupList', 'groupCreate', 'groupRename', 'groupDelete', 'groupAdd', 'groupRemove', 'groupCollapse']) {
      expect(methods.get(`quirky.repo/${name}`)?.params).toBeDefined()
    }
    const words = catalog.cli.commands.filter((c) => c.plugin === 'quirky.repo').map((c) => c.words).sort()
    expect(words).toEqual(
      ['add', 'clone', 'create', 'group add', 'group collapse', 'group create', 'group delete', 'group list', 'group remove', 'group rename', 'import', 'list', 'rm', 'scan', 'set', 'show', 'trust-hooks']
        .map((word) => `repo ${word}`)
        .sort()
    )

    const proc = spawnCli(['repo', 'group', 'create', 'viacli', '--json'], { home: harness.h.home })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toMatchObject({ name: 'viacli' })
  })

  test('a refusal under --json carries the reason', async () => {
    const { t: harness, home } = await start()
    const plain = join(home, 'plain')
    mkdirSync(plain, { recursive: true })
    const proc = spawnCli(['repo', 'add', plain, '--json'], { home: harness.h.home })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(1)
    expect(JSON.parse(stdout + stderr)).toMatchObject({ error: { reason: 'not-a-repository' } })
  })
})
