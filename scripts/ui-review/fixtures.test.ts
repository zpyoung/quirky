import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCaptureFixtureHome, registerCaptureFixtures, type PreparedCaptureFixtureHome } from './fixtures'

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
      if (method === 'quirky.repo/add') return { id: 'repo:ui-review-fixture' }
      if (method === 'quirky.worktree/list') {
        return [{
          id: 'worktree:ui-review-main', repoId: 'repo:ui-review-fixture', path: prepared.repoPath,
          name: 'ui-review-fixture', isMain: true, kind: 'git'
        }]
      }
      if (method === 'quirky.worktree/create') {
        created += 1
        const name = String(params.name)
        return { worktree: {
          id: `worktree:ui-review-${created}`, repoId: 'repo:ui-review-fixture',
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

