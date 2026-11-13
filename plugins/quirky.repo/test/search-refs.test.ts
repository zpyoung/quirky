import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type Repo } from '@quirky/protocol'
import { commands } from '../cli'
import { call, failure, git, isolateGitConfig, makeRepo } from './git-fixtures'
import { startPluginHarness, testCliContext, type PluginHarness } from './harness'

const { scratch } = isolateGitConfig()

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

async function start() {
  t = await startPluginHarness({ realGit: true })
  return { t, client: t.client, home: scratch() }
}

async function addRepo(client: PluginHarness['client'], home: string, name = 'repo'): Promise<{ dir: string; repo: Repo; head: string }> {
  const dir = makeRepo(join(home, name))
  const head = git(dir, 'rev-parse', 'HEAD')
  const repo = (await call(client, 'quirky.repo/add', { path: dir })) as Repo
  return { dir, repo, head }
}

describe('quirky.repo/searchRefs', () => {
  test('returns branch and tag collisions, peeled annotated targets, and empty matches', async () => {
    const { client, home } = await start()
    const { dir, repo, head } = await addRepo(client, home)
    git(dir, 'branch', 'shared')
    git(dir, 'tag', 'shared')
    git(dir, 'tag', '-a', 'annotated', '-m', 'annotated tag', 'HEAD')

    const result = await call(client, 'quirky.repo/searchRefs', { repo: `id:${repo.id}`, query: ' shared ' })
    expect(result).toEqual({
      refs: [
        { name: 'shared', kind: 'branch', ref: 'refs/heads/shared', target: head },
        { name: 'shared', kind: 'tag', ref: 'refs/tags/shared', target: head }
      ],
      truncated: false
    })
    expect(await call(client, 'quirky.repo/searchRefs', { repo: repo.id, query: 'annotated' })).toMatchObject({
      refs: [{ name: 'annotated', kind: 'tag', ref: 'refs/tags/annotated', target: head }]
    })
    expect(await call(client, 'quirky.repo/searchRefs', { repo: repo.id, query: 'absent' })).toEqual({ refs: [], truncated: false })
  })

  test('defaults to 50 results and reports truncation', async () => {
    const { client, home } = await start()
    const { dir, repo } = await addRepo(client, home)
    const refs = Array.from({ length: 51 }, (_, i) => `create refs/heads/default-limit-${String(i).padStart(2, '0')} HEAD\n`).join('')
    const update = Bun.spawnSync(['git', 'update-ref', '--stdin'], { cwd: dir, stdin: new TextEncoder().encode(refs) })
    expect(update.exitCode).toBe(0)

    const result = (await call(client, 'quirky.repo/searchRefs', { repo: repo.id, query: 'default-limit-' })) as {
      refs: unknown[]
      truncated: boolean
    }
    expect(result.refs).toHaveLength(50)
    expect(result.truncated).toBe(true)
  })

  test('is read-only in the described API', async () => {
    const { client } = await start()
    const catalog = (await call(client, 'api.describe')) as { methods: { name: string; readOnly?: boolean }[] }
    expect(catalog.methods.find((method) => method.name === 'quirky.repo/searchRefs')?.readOnly).toBe(true)
  })

  test('refuses invalid queries and limits', async () => {
    const { client, home } = await start()
    const { repo } = await addRepo(client, home)
    for (const query of ['', '   ', 'q'.repeat(201)]) {
      expect((await failure(call(client, 'quirky.repo/searchRefs', { repo: repo.id, query }))).code).toBe(RpcErrorCode.InvalidParams)
    }
    for (const limit of [0, 201, 1.5]) {
      expect((await failure(call(client, 'quirky.repo/searchRefs', { repo: repo.id, query: 'x', limit }))).code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('refuses folders and preserves selector not-found errors', async () => {
    const { client, home } = await start()
    const folderPath = join(home, 'plain')
    mkdirSync(folderPath, { recursive: true })
    const folder = (await call(client, 'quirky.repo/add', { path: folderPath, folder: true })) as Repo

    const folderError = await failure(call(client, 'quirky.repo/searchRefs', { repo: folder.id, query: 'x' }))
    expect(folderError).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: `${folder.name} is not a Git repository`,
      data: { reason: 'not-git' }
    })
    expect((await failure(call(client, 'quirky.repo/searchRefs', { repo: 'id:missing', query: 'x' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('translates Git failures with the last stderr line', async () => {
    const { client, home } = await start()
    const { dir, repo } = await addRepo(client, home)
    rmSync(dir, { recursive: true, force: true })

    const error = await failure(call(client, 'quirky.repo/searchRefs', { repo: repo.id, query: 'x' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toMatch(new RegExp(`^could not read refs of ${repo.name}: .+`))
  })

  test('prints JSON results and a human table with shortened targets', async () => {
    const { client, home } = await start()
    const { dir, repo, head } = await addRepo(client, home)
    git(dir, 'branch', 'shared')
    git(dir, 'tag', 'shared')

    const jsonContext = testCliContext(client, { json: true })
    await commands['search-refs']!({ positionals: [`id:${repo.id}`], flags: { query: 'shared', limit: 1 } }, jsonContext.ctx)
    expect(JSON.parse(jsonContext.lines[0]!)).toEqual({
      refs: [{ name: 'shared', kind: 'branch', ref: 'refs/heads/shared', target: head }],
      truncated: true
    })

    const tableContext = testCliContext(client)
    await commands['search-refs']!({ positionals: [repo.id], flags: { query: 'shared' } }, tableContext.ctx)
    expect(tableContext.lines).toHaveLength(1)
    expect(tableContext.lines[0]).toContain('KIND')
    expect(tableContext.lines[0]).toContain('NAME')
    expect(tableContext.lines[0]).toContain('TARGET')
    expect(tableContext.lines[0]).toContain('shared')
    expect(tableContext.lines[0]).toContain(head.slice(0, 12))
    expect(tableContext.lines[0]).not.toContain(head)

    const noMatchContext = testCliContext(client)
    await commands['search-refs']!({ positionals: [repo.id], flags: { query: 'absent' } }, noMatchContext.ctx)
    expect(noMatchContext.lines).toEqual(['no refs match absent'])
  })
})
