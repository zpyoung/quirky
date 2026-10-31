import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type FixtureStatus,
  type PreparedCaptureFixtureHome
} from './fixtures'

const temporaryHomes: string[] = []

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-ui-review-fixture-test-'))
  temporaryHomes.push(home)
  return home
}

function fakeFixtureClient(
  prepared: PreparedCaptureFixtureHome,
  failAt?: string
): { callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> } {
  let created = 0
  return {
    async callAny(method: string, params: Record<string, unknown> = {}, _options?: { timeoutMs?: number }) {
      if (method === failAt) throw new Error(`fixture RPC failed at ${method}`)
      if (method === 'quirky.repo/add') return { id: `repo:${String(params.path).split('/').pop()}` }
      if (method === 'quirky.worktree/list') {
        const repoId = String(params.repo)
        const project = prepared.projects.find((candidate) => `repo:${candidate.name}` === repoId)!
        return [{ id: `worktree:${project.name}-main`, repoId, path: project.path, name: project.name, isMain: true, kind: 'git' }]
      }
      if (method === 'quirky.worktree/create') {
        created += 1
        const name = String(params.name)
        return { worktree: {
          id: `worktree:ui-review-${created}`, repoId: String(params.repo),
          path: join(prepared.worktreesRoot, name), name, isMain: false, kind: 'git'
        } }
      }
      return { ok: true }
    }
  }
}

test('removes fixture files when public registration fails', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const client = fakeFixtureClient(prepared, 'quirky.worktree/create')

  await expect(registerCaptureFixtures(client, prepared, { timeoutMs: 2_000 })).rejects.toThrow(/fixture RPC failed/)

  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.worktreesRoot)).toBe(false)
})

test('repeated cleanup is safe after a successful fixture registration', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  registered.cleanup()
  registered.cleanup()

  expect(existsSync(prepared.repoPath)).toBe(false)
})


test('registers three projects whose worktrees cover every status dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  expect(prepared.projects).toHaveLength(3)
  for (const project of prepared.projects) expect(existsSync(join(project.path, '.git'))).toBe(true)
  expect(new Set(registered.worktrees.map((worktree) => worktree.repoId)).size).toBe(3)
  expect(new Set(registered.worktrees.map((worktree) => worktree.status))).toEqual(
    new Set<FixtureStatus>(['working', 'needs-you', 'failing', 'done', 'idle'])
  )
  expect(registered.worktrees.every((worktree) => worktree.id.length > 0 && worktree.path.startsWith(home))).toBe(true)
  expect(registered.primaryWorktree.repoId).toBe(registered.repo.id)
  registered.cleanup()
  for (const project of prepared.projects) expect(existsSync(project.path)).toBe(false)
})

test('seeds one agent session per non-idle worktree and waits for its status', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const hooksBySession = new Map<string, string[]>()
  const sessions = new Map<string, string>()
  const displayOf: Record<string, string> = { UserPromptSubmit: 'working', PermissionRequest: 'waiting', StopFailure: 'failed', Stop: 'done' }
  const client = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.terminal/newTab') {
        const session = `session:${sessions.size + 1}`
        sessions.set(session, String(params.workspace))
        return { session, tab: 'tab', pane: 'pane' }
      }
      if (method === 'quirky.agent-status/list') {
        return [...hooksBySession].map(([sessionId, events]) => ({ sessionId, display: displayOf[events.at(-1)!] }))
      }
      return { ok: true }
    }
  }
  const posted: Array<{ url: string; token: string | null }> = []
  const fakeFetch = async (url: string, init: RequestInit) => {
    const session = new URL(url).searchParams.get('session')!
    const event = (JSON.parse(String(init.body)) as { hook_event_name: string }).hook_event_name
    hooksBySession.set(session, [...(hooksBySession.get(session) ?? []), event])
    posted.push({ url, token: new Headers(init.headers).get('x-quirky-hook-token') })
    return { ok: true, status: 200 }
  }

  await seedWorktreeStatuses(client, registered, { port: 4321, hookToken: 'hook-token-value-1234' }, { timeoutMs: 2_000, fetch: fakeFetch })

  const wanted = registered.worktrees.filter((worktree) => worktree.status !== 'idle')
  expect(sessions.size).toBe(wanted.length)
  expect([...hooksBySession.values()].map((events) => displayOf[events.at(-1)!]).sort()).toEqual(['done', 'failed', 'waiting', 'working'])
  expect(posted.every((hook) => hook.url.startsWith('http://127.0.0.1:4321/hook/claude?session=') && hook.token === 'hook-token-value-1234')).toBe(true)
  registered.cleanup()
})

test('a rejected agent hook fails seeding instead of leaving a silent idle dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const client = { async callAny() { return { session: 'session:1' } } }

  await expect(seedWorktreeStatuses(client, registered, { port: 1, hookToken: 'x'.repeat(24) }, {
    timeoutMs: 2_000,
    fetch: async () => ({ ok: false, status: 401 })
  })).rejects.toThrow(/rejected with status 401/)
  registered.cleanup()
})
