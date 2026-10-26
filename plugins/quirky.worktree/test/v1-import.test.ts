import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

const EXTERNAL_ID = 'wt_0123456789ab'

/** Writes what v1 left in `quirky.db` for this feature: one repo, the ownership map and the settings rows. */
function writeV1Home(home: string, worktreesRoot: string | null): void {
  const db = new Database(join(home, 'quirky.db'), { create: true })
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL);
    CREATE TABLE worktrees (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  db.query("INSERT INTO repos VALUES ('repo_v1api', 'api', '/fake/api', 1700000000000)").run()
  db.query("INSERT INTO worktrees VALUES (?, 'repo_v1api')").run(EXTERNAL_ID)
  db.query("INSERT INTO worktrees VALUES ('wt_other0000001', 'repo_other')").run()
  if (worktreesRoot !== null) db.query("INSERT INTO settings VALUES ('worktreesRoot', ?)").run(JSON.stringify(worktreesRoot))
  db.close()
}

describe('SC-26: a v1 home carries over', () => {
  test('repos, the worktree ownership map and the worktrees root are imported once', async () => {
    const home = makeTempHome()
    const root = join(realpathSync(makeTempHome('qw-')), 'v1-root')
    writeV1Home(home, root)
    t = await startPluginHarness({ home })
    t.git!.addRepo('/fake/api')

    const repos = (await call(t.client, 'quirky.repo/list')) as Repo[]
    expect(repos).toEqual([
      {
        id: 'repo_v1api',
        name: 'api',
        path: '/fake/api',
        addedAt: 1700000000000,
        kind: 'git',
        displayName: null,
        groupId: null
      }
    ])

    const owned = (await call(t.client, 'quirky.worktree/ownedIds', { repo: 'repo_v1api' })) as string[]
    expect(owned).toContain(EXTERNAL_ID)
    expect(owned).not.toContain('wt_other0000001')

    const setting = (await call(t.client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as { value: string }
    expect(setting.value).toBe(root)
    const created = (await call(t.client, 'quirky.worktree/create', { repo: 'repo_v1api', name: 'feature' })) as Worktree
    expect(created.path.startsWith(root)).toBe(true)
  })

  test('a session in an imported-owned worktree still closes with its repo when git cannot list it', async () => {
    const home = makeTempHome()
    writeV1Home(home, null)
    t = await startPluginHarness({ home })
    const session = (await call(t.client, 'quirky.session/create', { worktree: EXTERNAL_ID, agent: 'shell' })) as { id: string }
    await call(t.client, 'quirky.repo/remove', { repo: 'repo_v1api' })
    expect(t.sessions.closed).toEqual([session.id])
  })

  test('a second start copies nothing again', async () => {
    const home = makeTempHome()
    const root = join(realpathSync(makeTempHome('qw-')), 'v1-root')
    writeV1Home(home, root)
    t = await startPluginHarness({ home })
    t.git!.addRepo('/fake/api')
    await call(t.client, 'quirky.repo/remove', { repo: 'repo_v1api' })
    await call(t.client, 'setting.reset', { id: 'setting:quirky.worktree/worktreesRoot' })
    expect(await call(t.client, 'quirky.repo/list')).toEqual([])

    const { client } = await t.restart()
    expect(await call(client, 'quirky.repo/list')).toEqual([])
    await call(client, 'quirky.worktree/list')
    expect(((await call(client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as { value: string }).value).toBe('~/quirky/workspaces')
  })

  test('a root the user already set is not overwritten', async () => {
    const home = makeTempHome()
    writeV1Home(home, '/v1/root')
    t = await startPluginHarness({ home })
    t.git!.addRepo('/fake/api')
    await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: '/mine' })
    await call(t.client, 'quirky.worktree/list')
    expect(((await call(t.client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as { value: string }).value).toBe('/mine')
  })

  test('a home without a v1 database starts empty', async () => {
    t = await startPluginHarness()
    expect(await call(t.client, 'quirky.repo/list')).toEqual([])
    expect(await call(t.client, 'quirky.worktree/list')).toEqual([])
  })
})
