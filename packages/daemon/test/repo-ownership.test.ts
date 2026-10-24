import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { worktreeIdForPath } from '../src/service'
import { makeTempHome, startHarness, type Harness } from './helpers'

let h: Harness | undefined

afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<{ h: Harness; client: QuirkyClient; root: string }> {
  h = await startHarness(options)
  const client = await h.connect('cli')
  const root = realpathSync(makeTempHome('qd-wt-'))
  await client.call('settings.set', { worktreesRoot: root })
  return { h, client, root }
}

async function sessionIds(client: QuirkyClient): Promise<string[]> {
  return (await client.call('session.list', {})).map((s) => s.id)
}

describe('repo.remove ownership', () => {
  test('removing one repo leaves a same-named repo sessions alone', async () => {
    const { h, client } = await start()
    h.git.addRepo('/fake/one/app')
    h.git.addRepo('/fake/two/app')
    const one = await client.call('repo.add', { path: '/fake/one/app' })
    const two = await client.call('repo.add', { path: '/fake/two/app' })
    const oneMain = (await client.call('worktree.list', { repoId: one.id }))[0]!
    const twoMain = (await client.call('worktree.list', { repoId: two.id }))[0]!
    const oneFeature = await client.call('worktree.create', { repoId: one.id, name: 'feature' })
    const twoFeature = await client.call('worktree.create', { repoId: two.id, name: 'feature' })
    const closing = [
      await client.call('session.create', { worktreeId: oneMain.id, agent: 'shell' }),
      await client.call('session.create', { worktreeId: oneFeature.id, agent: 'shell' })
    ]
    const staying = [
      await client.call('session.create', { worktreeId: twoMain.id, agent: 'shell' }),
      await client.call('session.create', { worktreeId: twoFeature.id, agent: 'shell' })
    ]

    await client.call('repo.remove', { repoId: one.id })
    expect(await sessionIds(client)).toEqual(staying.map((s) => s.id))
    for (const session of closing) {
      expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
    }
  })

  test('a session in an externally created worktree closes with its repo after the directory is gone', async () => {
    const { h, client } = await start()
    h.git.addRepo('/fake/alpha')
    h.git.addRepo('/fake/beta')
    const alpha = await client.call('repo.add', { path: '/fake/alpha' })
    const beta = await client.call('repo.add', { path: '/fake/beta' })
    h.git.worktreesByRepo
      .get('/fake/alpha')!
      .push({ path: '/fake/elsewhere/hand-made', branch: 'hand-made', head: 'c'.repeat(40), isMain: false })
    const worktrees = await client.call('worktree.list', { repoId: alpha.id })
    const external = worktrees.find((w) => w.name === 'hand-made')!
    const betaMain = (await client.call('worktree.list', { repoId: beta.id }))[0]!
    const closing = await client.call('session.create', { worktreeId: external.id, agent: 'shell' })
    const staying = await client.call('session.create', { worktreeId: betaMain.id, agent: 'shell' })
    h.git.worktreesByRepo.delete('/fake/alpha')

    await client.call('repo.remove', { repoId: alpha.id })
    expect(await sessionIds(client)).toEqual([staying.id])
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === closing.id)).toBe(true)
  })

  test('a failed close keeps the repo so removal can be retried', async () => {
    const { h, client } = await start()
    h.git.addRepo('/fake/alpha')
    const alpha = await client.call('repo.add', { path: '/fake/alpha' })
    const main = (await client.call('worktree.list', { repoId: alpha.id }))[0]!
    const session = await client.call('session.create', { worktreeId: main.id, agent: 'shell' })

    h.pty.failRequests('forget', 'pty host unavailable')
    await expect(client.call('repo.remove', { repoId: alpha.id })).rejects.toThrow()
    expect(await client.call('repo.list', {})).toHaveLength(1)
    expect(await sessionIds(client)).toEqual([session.id])

    h.pty.failRequests('forget', null)
    await client.call('repo.remove', { repoId: alpha.id })
    expect(await client.call('repo.list', {})).toEqual([])
    expect(await sessionIds(client)).toEqual([])
  })

  test('a legacy session row without a repo id resolves through the recorded worktree ids', async () => {
    const home = makeTempHome()
    const externalPath = '/fake/elsewhere/legacy'
    const externalId = worktreeIdForPath(externalPath)
    const legacy = new Database(join(home, 'quirky.db'), { create: true })
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        exit_code INTEGER
      );
    `)
    legacy
      .query("INSERT INTO sessions VALUES ('s_legacy', 'terminal', 'shell', ?, ?, 'Shell', 'running', 1, 1, NULL)")
      .run(externalId, externalPath)
    legacy.close()

    const started = await start({ home })
    started.h.git.addRepo('/fake/alpha')
    started.h.git.worktreesByRepo
      .get('/fake/alpha')!
      .push({ path: externalPath, branch: 'legacy', head: 'c'.repeat(40), isMain: false })
    const alpha = await started.client.call('repo.add', { path: '/fake/alpha' })
    await started.client.call('worktree.list', { repoId: alpha.id })
    started.h.git.worktreesByRepo.delete('/fake/alpha')

    expect(await sessionIds(started.client)).toEqual(['s_legacy'])
    await started.client.call('repo.remove', { repoId: alpha.id })
    expect(await sessionIds(started.client)).toEqual([])
  })
})

describe('worktree directories', () => {
  test('a second repo with the same name gets its own directory under the worktrees root', async () => {
    const { h, client, root } = await start()
    h.git.addRepo('/fake/one/app')
    h.git.addRepo('/fake/two/app')
    await client.call('repo.add', { path: '/fake/one/app' })
    const two = await client.call('repo.add', { path: '/fake/two/app' })

    const worktree = await client.call('worktree.create', { repoId: two.id, name: 'feature' })
    const suffix = two.id.replace(/^repo_/, '').slice(0, 6)
    expect(worktree.path).toBe(join(root, `app-${suffix}`, 'feature'))
  })

  test('a repo with a unique name keeps the plain directory', async () => {
    const { h, client, root } = await start()
    h.git.addRepo('/fake/alpha')
    const alpha = await client.call('repo.add', { path: '/fake/alpha' })
    const worktree = await client.call('worktree.create', { repoId: alpha.id, name: 'feature' })
    expect(worktree.path).toBe(join(root, 'alpha', 'feature'))
  })
})
