import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import { makeTempHome, type Harness } from '../../../packages/daemon/test/helpers'
import {
  call,
  createSession,
  makeBuiltinDir,
  restartDaemon,
  seedPtySession,
  SESSION_PLUGINS,
  startPluginHarness,
  storedSessions,
  writeV1Sessions
} from './support'

let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

/** A home as the previous version left it: a PTY host holding `live` sessions and rows in `quirky.db`. */
async function v1Home(sessions: Parameters<typeof writeV1Sessions>[1], live: string[]): Promise<Harness> {
  const harness = await startPluginHarness({ real: [], fakes: ['quirky.worktree'] }, { home: makeTempHome() })
  await harness.daemon.stop()
  for (const id of live) seedPtySession(harness, id, 'v1 output')
  writeV1Sessions(harness.home, sessions)
  return harness
}

describe('SC-26: a v1 home carries over', () => {
  test('sessions import once, keep their PTY session and their repo', async () => {
    h = await v1Home(
      [
        { id: 's_v1', repoId: 'repo_alpha' },
        { id: 's_gone', title: 'Shell 2', repoId: null },
        { id: 's_claude', agent: 'claude', title: 'Claude', worktreeId: 'wt_beta', repoId: 'repo_beta' }
      ],
      ['s_v1', 's_claude']
    )
    const first = await restartDaemon(h, { builtinPluginsDir: makeBuiltinDir(h.home, SESSION_PLUGINS, 'builtin-all') })
    try {
      const sessions = await call<Session[]>(first.client, 'quirky.session/list')
      expect(sessions.map((s) => [s.id, s.status])).toEqual([
        ['s_v1', 'running'],
        ['s_gone', 'exited'],
        ['s_claude', 'running']
      ])
      expect(sessions[0]).toMatchObject({ kind: 'terminal', agent: 'shell', title: 'Shell', worktreeId: 'wt_main', cwd: '/fake/alpha' })
      expect(await call(first.client, 'quirky.session/get', { session: 's_v1' })).toMatchObject({ id: 's_v1' })
      expect(h.pty.sessions.has('s_v1')).toBe(true)
      expect(h.pty.requests.some((r) => r.type === 'forget')).toBe(false)
      expect(storedSessions(h.home)).toEqual([
        { id: 's_claude', repo_id: 'repo_beta' },
        { id: 's_gone', repo_id: null },
        { id: 's_v1', repo_id: 'repo_alpha' }
      ])
    } finally {
      await first.stop()
    }

    writeV1Sessions(h.home, [{ id: 's_late' }])
    const second = await restartDaemon(h, { builtinPluginsDir: makeBuiltinDir(h.home, SESSION_PLUGINS, 'builtin-all') })
    try {
      const ids = (await call<Session[]>(second.client, 'quirky.session/list')).map((s) => s.id)
      expect(ids).toEqual(['s_v1', 's_gone', 's_claude'])
    } finally {
      await second.stop()
    }
  })

  test('a v1 home whose sessions table predates repo ownership imports with no repo', async () => {
    h = await v1Home([], [])
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(h.home, 'quirky.db'))
    db.exec('DROP TABLE sessions')
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, worktree_id TEXT NOT NULL,
      cwd TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, exit_code INTEGER)`)
    db.query("INSERT INTO sessions VALUES ('s_legacy', 'terminal', 'shell', 'wt_main', '/fake/alpha', 'Shell', 'running', 1, 1, NULL)").run()
    db.close()
    seedPtySession(h, 's_legacy')
    const restarted = await restartDaemon(h, { builtinPluginsDir: makeBuiltinDir(h.home, SESSION_PLUGINS, 'builtin-all') })
    try {
      expect((await call<Session[]>(restarted.client, 'quirky.session/list')).map((s) => s.id)).toEqual(['s_legacy'])
      expect(storedSessions(h.home)).toEqual([{ id: 's_legacy', repo_id: null }])
    } finally {
      await restarted.stop()
    }
  })

  test('a home with no v1 database starts empty', async () => {
    h = await startPluginHarness(SESSION_PLUGINS)
    const client = await h.connect('cli')
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('a v1 database without a sessions table imports nothing', async () => {
    const home = makeTempHome()
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(home, 'quirky.db'), { create: true })
    db.exec('CREATE TABLE repos (id TEXT PRIMARY KEY)')
    db.close()
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    const client = await h.connect('cli')
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })
})

describe('session ownership', () => {
  test('a new session records the repo of its worktree', async () => {
    h = await startPluginHarness(SESSION_PLUGINS)
    const client = await h.connect('cli')
    const main = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const beta = await createSession(client, { worktree: 'id:wt_beta', agent: 'shell' })
    expect(storedSessions(h.home).map((row) => [row.id, row.repo_id]).sort()).toEqual(
      [
        [main.id, 'repo_alpha'],
        [beta.id, 'repo_beta']
      ].sort()
    )
  })
})
