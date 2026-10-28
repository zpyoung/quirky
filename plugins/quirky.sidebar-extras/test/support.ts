import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()
function testBuiltins(): string {
  const directory = join(scratch(), 'builtin')
  mkdirSync(directory, { recursive: true })
  for (const name of ['quirky.repo', 'quirky.worktree', 'quirky.session', 'quirky.agents', 'quirky.git', 'quirky.sidebar-extras']) {
    symlinkSync(join(builtinsDir(), name), join(directory, name))
  }
  return directory
}

export type ActivityWindow = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'

export type ExtrasPreferences = {
  workspaceActivityWindow: ActivityWindow
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: Exclude<ActivityWindow, 'live-only'>
}

export type ExtrasState = {
  client: string
  preferences: ExtrasPreferences
  active: { worktreeId: string; instanceId: string } | null
  visits: Record<string, number>
  exits: Record<string, number>
}

export type ActivityProjection = ExtrasState & {
  visibleIds: string[]
  hiddenIds: string[]
  hiddenCount: number
  filterCount: number
  workspaces: {
    worktreeId: string
    activityAt: number
    live: boolean | null
    reason: 'selected' | 'all' | 'recent' | 'old' | 'live' | 'sleeping' | 'main' | 'folder' | 'unknown'
    error?: string
  }[]
}

export type DirtyResult = {
  worktreeId: string | null
  count: number
  capped: boolean
  title: string
  dirty: boolean
  available: boolean
  error?: string
}

export type TestEnvironment = {
  harness: Harness
  client: QuirkyClient
  worktreeRoot: string
}

export type TestClock = {
  now(): number
  set(value: number): void
  run<T>(operation: () => Promise<T>): Promise<T>
  restore(): void
}

export const call = <T = unknown>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params) as Promise<T>

export const extras = <T = unknown>(
  client: QuirkyClient,
  method: 'state' | 'set' | 'activate' | 'projection' | 'dirty',
  params: Record<string, unknown> = {}
) => call<T>(client, `quirky.sidebar-extras/${method}`, params)

export const openWorktreeView = (client: QuirkyClient, worktree: string) =>
  call(client, 'ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree } })

export function fakeClock(initial: number): TestClock {
  const realNow = Date.now
  let value = initial
  let disposed = false
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  const frozenNow = () => value
  const restoreNow = () => {
    clearTimeout(recoveryTimer)
    recoveryTimer = undefined
    if (Date.now === frozenNow) Date.now = realNow
  }
  return {
    now: () => value,
    set(next) {
      value = next
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (disposed) throw new Error('test clock is already restored')
      Date.now = frozenNow
      // Restore even if a shared Date.now-based infrastructure deadline is waiting on this scope.
      recoveryTimer = setTimeout(restoreNow, 10_000)
      try {
        return await operation()
      } finally {
        restoreNow()
      }
    },
    restore() {
      if (disposed) return
      disposed = true
      restoreNow()
    }
  }
}

export async function boot(): Promise<TestEnvironment> {
  const home = makeTempHome('qse-')
  let harness: Harness | undefined
  try {
    harness = await startHarness({ home, builtinPluginsDir: testBuiltins() })
    const client = await harness.connect('cli', 'sidebar-extras-tests')
    const root = scratch()
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot, { recursive: true })
    await call(client, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: realpathSync(worktreeRoot)
    })
    return { harness, client, worktreeRoot: realpathSync(worktreeRoot) }
  } catch (error) {
    if (harness) await harness.cleanup()
    else rmSync(home, { recursive: true, force: true })
    throw error
  }
}

export async function restart(env: TestEnvironment): Promise<TestEnvironment> {
  const home = env.harness.home
  const worktreeRoot = env.worktreeRoot
  for (const client of env.harness.clients) client.close()
  await env.harness.daemon.stop()
  env.harness.pty.stop()
  const harness = await startHarness({ home, builtinPluginsDir: testBuiltins() })
  // Assign before connecting so the fixture's afterEach can clean up a replacement that fails to connect.
  env.harness = harness
  const client = await harness.connect('cli', 'sidebar-extras-tests-restarted')
  return { harness, client, worktreeRoot }
}

export async function createGitProject(client: QuirkyClient, files: Record<string, string> = { 'README.md': 'clean\n' }) {
  const path = makeRepo(scratch(), files)
  const repo = await call<Repo>(client, 'quirky.repo/add', { path })
  const worktrees = await call<Worktree[]>(client, 'quirky.worktree/list', { repo: repo.id })
  const main = worktrees.find((worktree) => worktree.isMain)!
  return { repo, path, main }
}

export async function createWorktree(client: QuirkyClient, repoId: string, name: string): Promise<Worktree> {
  const result = await call<WorktreeCreateResult>(client, 'quirky.worktree/create', { repo: repoId, name })
  return result.worktree
}

export async function createFolderProject(client: QuirkyClient) {
  const path = scratch()
  mkdirSync(path, { recursive: true })
  const folderPath = realpathSync(path)
  writeFileSync(join(folderPath, 'notes.txt'), 'folder workspace\n')
  const repo = await call<Repo>(client, 'quirky.repo/add', { path: folderPath, folder: true })
  const worktrees = await call<Worktree[]>(client, 'quirky.worktree/list', { repo: repo.id })
  return { repo, path: folderPath, primary: worktrees[0]! }
}

export const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

export const runSidebarCli = (env: TestEnvironment, args: string[]) =>
  runCli(['sidebar-extras', ...args], { home: env.harness.home })
