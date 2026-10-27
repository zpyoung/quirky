import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { QuirkyClient, type Session } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startAgentsE2E, type E2E, type FakeEvent } from '../support/e2e'

const DAEMON_MAIN = resolve(import.meta.dir, '../../../../packages/daemon/src/main.ts')

type Start = Extract<FakeEvent, { type: 'start' }>

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

/** One row of the v1 `sessions` table, which is all a v1 home keeps about a session. */
type V1Row = { id: string; agent: string; title: string; createdAt: number }

let e2e: E2E
let probe: QuirkyClient | undefined

beforeEach(async () => {
  e2e = await startAgentsE2E({ fakes: { claude: true, codex: true } })
}, 30_000)

afterEach(async () => {
  probe?.close()
  probe = undefined
  await e2e.cleanup()
})

/**
 * Turns the running daemon's home into a v1 home that has not been opened by this version:
 * stops the daemon, writes `rows` into the `sessions` table of `quirky.db`, drops the session
 * plugin's own store so its first migration imports them, and starts `quirkyd` again with the
 * environment the harness gave the first one.
 */
async function reopenAsV1Home(rows: V1Row[], worktreeId: string): Promise<void> {
  const runtime = readRuntime(e2e.home)!
  await e2e.call('daemon.stop', {})
  await until(() => !isAlive(runtime.pid), 15_000, 'the first daemon to stop')

  const db = new Database(join(e2e.home, 'quirky.db'))
  try {
    for (const row of rows) {
      db.query('INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        row.id,
        'terminal',
        row.agent,
        worktreeId,
        e2e.repo,
        row.title,
        'exited',
        row.createdAt,
        row.createdAt,
        0
      )
    }
  } finally {
    db.close()
  }
  const store = join(e2e.home, 'plugin-data', 'quirky.session', 'store.db')
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${store}${suffix}`, { force: true })

  const root = dirname(e2e.home)
  const restarted = e2e.processScope.spawn([process.execPath, DAEMON_MAIN], {
    env: {
      QUIRKY_HOME: e2e.home,
      HOME: e2e.userHome,
      SHELL: join(root, 'shells', 'sh'),
      PATH: `${e2e.fakebin}:/usr/bin:/bin`,
      QUIRKY_AGENT_SEARCH_DIRS: '',
      QUIRKY_PORT: '0',
      QUIRKY_TEST_AGENT_TIME_SCALE: '1',
      ...e2e.processScope.env
    },
    stdout: Bun.file(join(root, 'daemon-2.log')),
    stderr: Bun.file(join(root, 'daemon-2.log'))
  })
  await until(
    async () => {
      if (restarted.exitCode !== null) throw new Error(`the second daemon exited ${restarted.exitCode}`)
      const info = readRuntime(e2e.home)
      return info !== null && info.pid !== runtime.pid && (await isDaemonAlive(info))
    },
    20_000,
    'the second daemon to start'
  )
  probe = await QuirkyClient.connect(rpcUrl(readRuntime(e2e.home)!), { role: 'cli', name: 'compat-e2e' })
}

const cliJson = async <T>(args: string[]): Promise<T> => {
  const result = await e2e.cli(args)
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function startOf(fake: string, sessionId: string): Promise<Start> {
  const events = await e2e.waitForFakeLog(fake, (log) => log.some((event) => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId), 15_000)
  return events.find((event): event is Start => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId)!
}

describe('SC-38: v1 sessions and commands keep working', () => {
  const V1: V1Row[] = [
    { id: 's_v1claude', agent: 'claude', title: 'Claude', createdAt: 1_000 },
    { id: 's_v1codex', agent: 'codex', title: 'Codex', createdAt: 2_000 }
  ]

  async function reopen(): Promise<void> {
    const worktrees = await cliJson<{ id: string }[]>(['worktree', 'list', '--json'])
    await reopenAsV1Home(V1, worktrees[0]!.id)
  }

  test(
    'SC-38: the old records list unchanged, with no launch record',
    async () => {
      await reopen()
      const listed = await cliJson<Session[]>(['session', 'list', '--json'])
      expect(listed.map((s) => [s.id, s.agent, s.kind, s.title, s.status, s.cwd])).toEqual([
        ['s_v1claude', 'claude', 'terminal', 'Claude', 'exited', e2e.repo],
        ['s_v1codex', 'codex', 'terminal', 'Codex', 'exited', e2e.repo]
      ])
      expect(listed.map((s) => [s.launch, s.providerSession, s.promptDelivery, s.resumedFrom])).toEqual(Array(2).fill([null, null, null, null]))

      const table = await e2e.cli(['session', 'list'])
      expect(table.code).toBe(0)
      expect(table.stdout).toContain('s_v1claude')
      expect(table.stdout).toContain('s_v1codex')
    },
    90_000
  )

  test(
    "SC-38: `session new --agent claude --prompt hi` gets agent-status's --settings argument before the prompt",
    async () => {
      await reopen()
      const created = await cliJson<Session>(['session', 'new', '--agent', 'claude', '--prompt', 'hi', '--json'])
      expect(created).toMatchObject({ agent: 'claude', status: 'running', promptDelivery: 'command-line' })
      const started = await startOf('claude', created.id)
      const settings = started.argv.indexOf('--settings')
      expect(settings).toBeGreaterThanOrEqual(0)
      expect(started.argv[settings + 1]).toMatch(/claude-settings-[^/]+\.json$/)
      expect(started.argv.at(-1)).toBe('hi')
      expect(settings).toBeLessThan(started.argv.length - 1)

      const listed = await cliJson<Session[]>(['session', 'list', '--json'])
      expect(listed.map((s) => s.id).slice(0, 2)).toEqual(['s_v1claude', 's_v1codex'])
      expect(listed.map((s) => s.id)).toContain(created.id)
    },
    90_000
  )

  test(
    'SC-38: --agent is optional, and the default agent is chosen when it is left out',
    async () => {
      await reopen()
      const created = await cliJson<Session>(['session', 'new', '--prompt', 'hi', '--json'])
      expect(created.agent).toBe('claude')
      const started = await startOf('claude', created.id)
      expect(started.argv.at(-1)).toBe('hi')
    },
    90_000
  )

  test(
    'SC-31: a session from before this item resumes with the catalog command and no arguments, and records that',
    async () => {
      await reopen()
      const claude = await cliJson<Session>(['session', 'resume', 's_v1claude', '--provider-session', 'abc', '--json'])
      expect(claude).toMatchObject({ agent: 'claude', resumedFrom: 's_v1claude', cwd: e2e.repo, launch: { command: 'claude', args: '', env: {} } })
      const started = await startOf('claude', claude.id)
      expect(started.argv).not.toContain('--dangerously-skip-permissions')
      expect(started.argv.slice(-2)).toEqual(['--resume', 'abc'])

      const codex = await cliJson<Session>(['session', 'resume', 's_v1codex', '--provider-session', 'thread-1', '--json'])
      expect(codex.launch).toEqual({ command: 'codex', args: '', env: {} })
      const codexStart = await startOf('codex', codex.id)
      expect(codexStart.argv.slice(-2)).toEqual(['resume', 'thread-1'])
      expect(codexStart.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')

      const old = (await cliJson<Session[]>(['session', 'list', '--json'])).find((s) => s.id === 's_v1claude')
      expect(old).toMatchObject({ launch: null, providerSession: null })
    },
    90_000
  )
})
