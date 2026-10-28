import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCaptureTerminalFixture, prepareCaptureFixtureHome, registerCaptureFixtures, type PreparedCaptureFixtureHome } from './fixtures'

type RpcCall = { method: string; params: Record<string, unknown> }

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
  calls: RpcCall[],
  failAt?: string
): { callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> } {
  let created = 0
  return {
    async callAny(method: string, params: Record<string, unknown> = {}, _options?: { timeoutMs?: number }) {
      calls.push({ method, params })
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
      if (method === 'quirky.terminal/newTab') return { session: 'session:fixture', tab: 'tab:fixture', pane: 'pane:fixture' }
      return { ok: true }
    }
  }
}

test('prepares a real fixture repository and isolated light-theme declaration under a fresh home', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })

  expect(existsSync(join(prepared.repoPath, '.git'))).toBe(true)
  expect(existsSync(prepared.files.source)).toBe(true)
  expect(existsSync(prepared.files.markdown)).toBe(true)
  expect(existsSync(prepared.files.notebook)).toBe(true)
  expect(existsSync(prepared.files.svg)).toBe(true)
  const theme = JSON.parse(readFileSync(join(prepared.themePluginDir, 'quirky-plugin.json'), 'utf8')) as {
    contributes: { theme: Array<{ appearance: string; id: string; colors: Record<string, string> }> }
  }
  expect(theme.contributes.theme).toContainEqual(expect.objectContaining({
    id: 'light',
    appearance: 'light',
    colors: {
      bg: '#ffffff',
      'bg-raised': '#f4f5f7',
      'bg-hover': '#e7e9ef',
      'bg-active': '#e7e9ef',
      border: '#e3e5ea',
      text: '#1b1d22',
      muted: '#80868f',
      accent: '#5b6cff',
      amber: '#c98a0b',
      green: '#1f9d63',
      grey: '#80868f',
      dim: '#80868f',
      danger: '#d6455d',
      'terminal-background': '#ffffff',
      'terminal-foreground': '#1b1d22',
      'terminal-cursor': '#1b1d22'
    }
  }))

  prepared.cleanup()
  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.worktreesRoot)).toBe(false)
  expect(existsSync(prepared.themePluginDir)).toBe(false)
})

test('uses public repo/worktree RPCs and removes all fixture files when registration fails', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const calls: RpcCall[] = []
  const client = fakeFixtureClient(prepared, calls, 'quirky.worktree/create')

  await expect(registerCaptureFixtures(client, prepared, { timeoutMs: 2_000 })).rejects.toThrow(/fixture RPC failed/)

  expect(calls.map((call) => call.method)).toEqual([
    'setting.set', 'setting.set', 'quirky.repo/add', 'quirky.worktree/list', 'quirky.worktree/create'
  ])
  expect(calls.find((call) => call.method === 'quirky.repo/add')?.params).toEqual({ path: prepared.repoPath })
  expect(calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({
    repo: 'repo:ui-review-fixture', setup: 'skip', noParent: true, activate: false
  })
  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.worktreesRoot)).toBe(false)
  expect(existsSync(prepared.themePluginDir)).toBe(false)
})

test('repeated cleanup is safe after a successful fixture registration', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const calls: RpcCall[] = []
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared, calls), prepared, { timeoutMs: 2_000 })

  expect(registered.worktrees).toHaveLength(3)
  expect(calls.filter((call) => call.method === 'quirky.worktree/create')).toHaveLength(2)
  registered.cleanup()
  registered.cleanup()

  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.themePluginDir)).toBe(false)
})

test('sends only a shell-session request without a command or automation prompt', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const calls: RpcCall[] = []
  const client = fakeFixtureClient(prepared, calls)
  const registered = await registerCaptureFixtures(client, prepared, { timeoutMs: 2_000 })

  const terminal = await createCaptureTerminalFixture(client, registered, { timeoutMs: 2_000 })
  expect(terminal).toEqual({ sessionId: 'session:fixture', tabId: 'tab:fixture', paneId: 'pane:fixture' })
  expect(calls.find((call) => call.method === 'quirky.terminal/newTab')?.params).toEqual({
    workspace: registered.primaryWorktree.id,
    cwd: registered.primaryWorktree.path,
    agent: 'shell',
    title: 'UI Review Fixture Shell',
    activate: true
  })
  registered.cleanup()
})
