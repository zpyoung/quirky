import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()
function testBuiltins(fakeHosting = false, includeAgentStatus = false): string {
  const directory = join(scratch(), 'builtin')
  mkdirSync(directory, { recursive: true })
  const plugins = ['quirky.repo', 'quirky.worktree', 'quirky.session', 'quirky.agents', 'quirky.git', 'quirky.sidebar-extras']
  for (const name of [...plugins, ...(includeAgentStatus ? ['quirky.agent-status'] : [])]) {
    symlinkSync(join(builtinsDir(), name), join(directory, name))
  }
  if (fakeHosting) writeFakeHostingPlugin(directory)
  return directory
}

function writeFakeHostingPlugin(directory: string): void {
  const pluginDir = join(directory, 'quirky.hosting')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'quirky-plugin.json'), JSON.stringify({
    id: 'quirky.hosting',
    name: 'Fake hosting cache fixture',
    version: '1.0.0',
    main: 'main.ts',
    contributes: {
      method: [
        {
          id: 'cachedReviews',
          description: 'Returns controlled review snapshots without fetching.',
          readOnly: true,
          params: {
            type: 'object',
            properties: { worktrees: { type: 'array', items: { type: 'string' } } },
            required: ['worktrees'],
            additionalProperties: false
          },
          result: {
            type: 'object',
            properties: { workspaces: { type: 'array', items: { type: 'object' } } },
            required: ['workspaces'],
            additionalProperties: false
          }
        },
        {
          id: 'testSetCache',
          description: 'Controls the fake cache for API projection tests.',
          params: {
            type: 'object',
            properties: {
              workspaces: { type: 'array', items: {} },
              error: { type: 'string' }
            },
            required: ['workspaces'],
            additionalProperties: false
          },
          result: { type: 'boolean' }
        },
        {
          id: 'testCalls',
          description: 'Reads cache call arguments for API projection tests.',
          readOnly: true,
          params: { type: 'object', additionalProperties: false },
          result: { type: 'array', items: { type: 'object' } }
        }
      ]
    }
  }))
  writeFileSync(join(pluginDir, 'main.ts'), `
export function activate(context) {
  let workspaces = []
  let failure
  const calls = []
  context.provide('method:quirky.hosting/cachedReviews', (params) => {
    calls.push(params)
    if (failure !== undefined) throw new Error(failure)
    return { workspaces }
  })
  context.provide('method:quirky.hosting/testSetCache', (params) => {
    workspaces = params.workspaces
    failure = params.error
    return true
  })
  context.provide('method:quirky.hosting/testCalls', () => calls)
}
`)
}

export type ActivityWindow = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'

export type ExtrasPreferences = {
  workspaceActivityWindow: ActivityWindow
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: Exclude<ActivityWindow, 'live-only'>
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
  hideAutomationCreated: boolean
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
  automationHiddenIds: string[]
  automationHiddenCount: number
  reviewHiddenIds: string[]
  reviewHiddenCount: number
  workspaces: {
    worktreeId: string
    activityAt: number
    live: boolean | null
    reason: 'selected' | 'all' | 'recent' | 'old' | 'live' | 'sleeping' | 'main' | 'folder' | 'unknown'
    error?: string
    reviewReason?: 'completed' | 'passing' | 'unknown'
    reviewError?: string
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
  fakeHosting: boolean
  agentStatus: boolean
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

export const setFakeHostingCache = (
  client: QuirkyClient,
  workspaces: Record<string, unknown>[],
  error?: string
) => call(client, 'quirky.hosting/testSetCache', { workspaces, ...(error === undefined ? {} : { error }) })

export const fakeHostingCalls = (client: QuirkyClient) =>
  call<{ worktrees: string[] }[]>(client, 'quirky.hosting/testCalls')


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

export async function boot(options: { fakeHosting?: boolean; agentStatus?: boolean } = {}): Promise<TestEnvironment> {
  const fakeHosting = options.fakeHosting ?? false
  const agentStatus = options.agentStatus ?? false
  const home = makeTempHome('qse-')
  let harness: Harness | undefined
  try {
    harness = await startHarness({ home, builtinPluginsDir: testBuiltins(fakeHosting, agentStatus) })
    const client = await harness.connect('cli', 'sidebar-extras-tests')
    const root = scratch()
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot, { recursive: true })
    await call(client, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: realpathSync(worktreeRoot)
    })
    return { harness, client, worktreeRoot: realpathSync(worktreeRoot), fakeHosting, agentStatus }
  } catch (error) {
    if (harness) await harness.cleanup()
    else rmSync(home, { recursive: true, force: true })
    throw error
  }
}

export async function restart(env: TestEnvironment): Promise<TestEnvironment> {
  const home = env.harness.home
  const worktreeRoot = env.worktreeRoot
  const fakeHosting = env.fakeHosting
  const agentStatus = env.agentStatus
  for (const client of env.harness.clients) client.close()
  await env.harness.daemon.stop()
  env.harness.pty.stop()
  const harness = await startHarness({ home, builtinPluginsDir: testBuiltins(fakeHosting, agentStatus) })
  // Assign before connecting so the fixture's afterEach can clean up a replacement that fails to connect.
  env.harness = harness
  const client = await harness.connect('cli', 'sidebar-extras-tests-restarted')
  return { harness, client, worktreeRoot, fakeHosting, agentStatus }
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
