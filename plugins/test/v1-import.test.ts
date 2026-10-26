import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { base64ToBytes, QuirkyClient, type AskEnvelope, type AskSpec, type Repo, type Session } from '../../packages/protocol/src'
import { rpcUrl } from '../../packages/protocol/src/node'
import { createFakeGit, useTestGit } from '../../packages/git/src/testing'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../packages/daemon/test/helpers'
import { removeTempDirs } from '../../packages/daemon/test/plugins/fixtures'
import { restartDaemon, seedPtySession } from '../quirky.session/test/support'
import { worktreeIdForPath } from '../quirky.worktree/paths'

// plugins/test is not a workspace package, so the workspace packages are imported by path (the same modules the plugins resolve)
const SCROLLBACK = 'setting:quirky.terminal/scrollback'
const API_PATH = '/fake/api'
const askSpec: AskSpec = { questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] }

let h: Harness | undefined
afterEach(async () => {
  useTestGit(null)
  await h?.cleanup()
  h = undefined
  removeTempDirs()
})

type Started = Awaited<ReturnType<typeof restartDaemon>>

/** Fills the v1 tables the daemon still creates in `quirky.db`: repo api, its main worktree, a running shell session, a pending ask and the scrollback setting. */
function writeV1Home(home: string, scrollback: number): void {
  const db = new Database(join(home, 'quirky.db'), { create: true })
  try {
    const mainId = worktreeIdForPath(API_PATH)
    db.query('INSERT INTO repos VALUES (?, ?, ?, ?)').run('repo_api', 'api', API_PATH, 1700000000000)
    db.query('INSERT INTO worktrees VALUES (?, ?)').run(mainId, 'repo_api')
    db.query('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(
      's_v1', 'terminal', 'shell', mainId, API_PATH, 'Shell', 'running', 1, 1, 'repo_api'
    )
    db.query('INSERT INTO asks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ask_v1', JSON.stringify(askSpec), 's_v1', mainId, 1000, 'pending', '{}', '[]')
    db.query('INSERT INTO settings VALUES (?, ?)').run('terminalScrollback', JSON.stringify(scrollback))
  } finally {
    db.close()
  }
}

/** A v1 home with the PTY host still holding `s_v1`, and no daemon running on it yet. */
async function v1Home(scrollback: number): Promise<Harness> {
  const git = createFakeGit()
  git.addRepo(API_PATH)
  useTestGit(git)
  const harness = await startHarness({ home: makeTempHome('qv-'), builtinPluginsDir: null })
  await harness.daemon.stop()
  seedPtySession(harness, 's_v1', 'v1 output')
  writeV1Home(harness.home, scrollback)
  return harness
}

const start = (harness: Harness): Promise<Started> => restartDaemon(harness, { builtinPluginsDir: builtinsDir() })

describe('SC-26: a v1 home carries over', () => {
  test('SC-26: a v1 home\'s data carries over', async () => {
    h = await v1Home(4000)
    const first = await start(h)
    let counts: number[]
    try {
      const { client } = first
      const repos = (await client.callAny('quirky.repo/list', {})) as Repo[]
      expect(repos.map((repo) => [repo.id, repo.name, repo.path])).toEqual([['repo_api', 'api', API_PATH]])

      const sessions = (await client.callAny('quirky.session/list', {})) as Session[]
      expect(sessions.map((s) => [s.id, s.status])).toEqual([['s_v1', 'running']])
      const ui = await QuirkyClient.connect(rpcUrl(first.daemon.runtime), { role: 'ui' })
      try {
        const attached = (await ui.callAny('quirky.terminal/attach', { session: 's_v1', cols: 80, rows: 24 })) as { replay: string }
        expect(new TextDecoder().decode(base64ToBytes(attached.replay))).toBe('v1 output')
      } finally {
        ui.close()
      }

      const asks = (await client.callAny('quirky.ask/list', {})) as { id: string; envelope: AskEnvelope }[]
      expect(asks.map((ask) => [ask.id, ask.envelope.status])).toEqual([['ask_v1', 'pending']])
      expect(await client.callAny('setting.get', { id: SCROLLBACK })).toMatchObject({ value: 4000 })
      counts = [repos.length, sessions.length, asks.length]
    } finally {
      await first.stop()
    }

    // rows added to the v1 file after the first start must not be copied by a later one
    const db = new Database(join(h.home, 'quirky.db'))
    db.query('INSERT INTO repos VALUES (?, ?, ?, ?)').run('repo_late', 'late', '/fake/late', 1)
    db.query('INSERT INTO asks VALUES (?, ?, NULL, NULL, 2, ?, ?, ?)').run('ask_late', JSON.stringify(askSpec), 'pending', '{}', '[]')
    db.close()

    const second = await start(h)
    try {
      const { client } = second
      const again = [
        ((await client.callAny('quirky.repo/list', {})) as unknown[]).length,
        ((await client.callAny('quirky.session/list', {})) as unknown[]).length,
        ((await client.callAny('quirky.ask/list', {})) as unknown[]).length
      ]
      expect(again).toEqual(counts)
    } finally {
      await second.stop()
    }
  })

  test('a v1 scrollback above the range is clamped to 10000', async () => {
    h = await v1Home(50000)
    const started = await start(h)
    try {
      await started.client.callAny('quirky.terminal/read', { session: 's_v1' })
      expect(await started.client.callAny('setting.get', { id: SCROLLBACK })).toMatchObject({ value: 10000 })
    } finally {
      await started.stop()
    }
  })
})
