import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { QuirkyClient, Repo, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { spawnCli } from '../../../../packages/cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../../packages/daemon/test/plugins/fixtures'
import { createProcessScope } from '../../../../scripts/test-support/process-scope'
import { startHeadlessWindow, type HeadlessWindow } from '../../../../packages/ui/test/fixtures/headless-window'
import { git } from '../../../quirky.repo/test/git-fixtures'
import { makeOrigin, makeProject } from '../../../quirky.worktree/test/fixtures/repos'

export const PANEL = 'panel:quirky.git/source-control'
export const DIFF_VIEW = 'view:quirky.git/diff'
export const SESSION_VIEW = 'view:quirky.session/worktree'

/** The files project api and its origin start with. */
export const BASE_FILES: Record<string, string> = {
  'README.md': 'one\ntwo\n',
  'math.ts': 'a\nb\nc\nd\ne\n',
  'old.ts': 'export const a = 1\nexport const b = 2\n',
  'a.ts': 'one\n',
  'b.ts': 'bee\n',
  'c.ts': 'sea\n',
  'd.ts': 'dee\n'
}

export type World = {
  harness: Harness
  win: HeadlessWindow
  agent: QuirkyClient
  repo: Repo
  repoDir: string
  originDir: string
  feat: Worktree
  /** The same worktree's directory. */
  dir: string
  /** Runs git in feat and returns its trimmed stdout. */
  git(...args: string[]): string
  write(rel: string, text: string): void
  /** Commits `files` in feat. */
  commit(files: Record<string, string>, message?: string): void
  /** Another worktree of the project on branch zoe/<name>, with no base of its own. */
  addWorktree(name: string): Promise<Worktree>
  /** A clone of the origin for moving the remote. */
  peer(name: string): Peer
  /** Starts the real CLI in feat and resolves with its result. */
  cli(args: string[]): { done: Promise<{ code: number; stdout: string; stderr: string }> }
  state(): Promise<UiState>
  /** The panel's last report. */
  report(): Promise<any>
  /** The explicit top-level diff mount's report; embedded hosted views have no slot report. */
  viewReport(): Promise<any>
  run(command: string, args?: unknown): Promise<unknown>
  /** Console errors and failed plugin slots seen since the window opened; empty when all is well. */
  problems(): string[]
  cleanup(): Promise<void>
}

export type Peer = {
  dir: string
  git(...args: string[]): string
  commit(files: Record<string, string>, message?: string): string
  push(branch: string, ...flags: string[]): void
}

export type BootOptions = {
  /** Push feat to origin and give it an upstream; default true. */
  published?: boolean
  files?: Record<string, string>
  /** Leave the panel closed. */
  noPanel?: boolean
}

/** React's development warning for `root.unmount()` in an effect cleanup, which every plugin's mount function does. */
const UNMOUNT_WARNING = 'Attempted to synchronously unmount a root'

let current: World | null = null
let consoleError: typeof console.error | null = null
type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean }
let actEnvironment: boolean | undefined

/** Stops the window and the daemon of the world `boot` made. */
export async function shutdown(): Promise<void> {
  if (!current) return
  const world = current
  current = null
  await world.cleanup()
  if (consoleError) console.error = consoleError
  consoleError = null
  ;(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  removeTempDirs()
}

/**
 * A real daemon with the built-in plugins, a headless window on it, and project api (a clone of
 * a bare origin) with worktree feat on zoe/feat cut from origin/main. feat is open with the Source
 * Control panel shown.
 */
export async function boot(scratch: () => string, options: BootOptions = {}): Promise<World> {
  const harness = await startHarness({ home: makeTempHome('qgw-'), builtinPluginsDir: builtinsDir() })
  const agent = await harness.connect('cli', 'setup')
  const root = realpathSync(makeTempDir('qgw-root-'))
  await agent.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const originDir = makeOrigin(join(scratch(), 'origin.git'), { files: options.files ?? BASE_FILES })
  const repoDir = makeProject(join(scratch(), 'api'), { origin: originDir })
  const repo = (await agent.callAny('quirky.repo/add', { path: repoDir })) as Repo
  const made = (await agent.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'feat',
    branchName: 'zoe/feat',
    base: 'origin/main',
    setup: 'skip'
  })) as WorktreeCreateResult
  const feat = made.worktree
  const dir = feat.path
  if (options.published !== false) git(dir, 'push', '-q', '-u', 'origin', 'zoe/feat')

  const errors: string[] = []
  consoleError = console.error
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '))
  // the in-process daemon reads git's output through Response; happy-dom's aborts in-flight bodies when the window closes
  const NativeResponse = globalThis.Response
  // happy-dom tests of other files turn React's act environment on for the whole process
  actEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false
  const win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  // Happy DOM has no layout; use the terminal acceptance fixture's measured-stage convention.
  const elementPrototype = Element.prototype
  const originalRect = elementPrototype.getBoundingClientRect
  elementPrototype.getBoundingClientRect = function () {
    return this.matches('.qt-groups, .qt-panes, .qt-body')
      ? new DOMRect(0, 0, 1024, 768)
      : originalRect.call(this)
  }
  // Match terminal e2e fixtures: Happy DOM has no 2D canvas context either.
  const canvasPrototype = HTMLCanvasElement.prototype
  const originalContext = canvasPrototype.getContext
  const context2d = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true })
  canvasPrototype.getContext = function (type: string) {
    return type === '2d' ? context2d : null
  } as typeof originalContext
  globalThis.Response = NativeResponse
  const state = async () => (await agent.callAny('ui.state', {})) as UiState
  const world: World = {
    harness,
    win,
    agent,
    repo,
    repoDir,
    originDir,
    feat,
    dir,
    git: (...args) => git(dir, ...args),
    write(rel, content) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), content)
    },
    commit(files, message = 'feat work') {
      for (const [path, content] of Object.entries(files)) world.write(path, content)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', message)
    },
    async addWorktree(name) {
      const made = (await agent.callAny('quirky.worktree/create', {
        repo: repo.id,
        name,
        branchName: `zoe/${name}`,
        base: 'origin/main',
        setup: 'skip'
      })) as WorktreeCreateResult
      await agent.callAny('quirky.worktree/set', { worktree: made.worktree.id, baseRef: null })
      return made.worktree
    },
    peer(name) {
      const peerDir = join(scratch(), name)
      mkdirSync(dirname(peerDir), { recursive: true })
      git(dirname(peerDir), 'clone', '-q', originDir, peerDir)
      const run = (...args: string[]) => git(peerDir, ...args)
      for (const [key, value] of [['user.name', 'Peer'], ['user.email', 'peer@example.com'], ['commit.gpgsign', 'false']]) run('config', key!, value!)
      return {
        dir: peerDir,
        git: run,
        commit(files, message = 'peer') {
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(peerDir, path)), { recursive: true })
            writeFileSync(join(peerDir, path), content)
          }
          run('add', '-A')
          run('commit', '-q', '-m', message)
          return run('rev-parse', 'HEAD')
        },
        push: (branch, ...flags) => void run('push', '-q', ...flags, 'origin', `HEAD:refs/heads/${branch}`)
      }
    },
    cli(args) {
      const proc = spawnCli(args, { home: harness.home, cwd: dir })
      return { done: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ code, stdout, stderr })) }
    },
    state,
    report: async () => (await state()).slots.find((slot) => slot.id === PANEL)?.report,
    viewReport: async () => (await state()).slots.find((slot) => slot.id === DIFF_VIEW)?.report,
    run: (command, args) => agent.callAny('ui.command.run', { id: `command:quirky.git/${command}`, ...(args === undefined ? {} : { args }) }),
    problems: () => [
      ...errors.filter((message) => !message.startsWith(UNMOUNT_WARNING) && !message.startsWith('[quirkyd]')),
      ...Object.entries(win.host.getState().slots).flatMap(([id, slot]) => (slot.status === 'error' ? [`${id}: ${slot.message}`] : []))
    ],
    async cleanup() {
      try {
        await win.stop()
      } finally {
        elementPrototype.getBoundingClientRect = originalRect
        canvasPrototype.getContext = originalContext
        await harness.cleanup()
      }
    }
  }
  current = world
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: feat.id } })
  if (options.noPanel) {
    await agent.callAny('ui.panel.close', {})
    await win.waitFor(() => document.querySelector('[data-git-panel]') === null)
  } else {
    await agent.callAny('ui.panel.open', { id: PANEL })
    await win.waitFor(() => document.querySelector('[data-git-panel]'))
    await win.waitFor(async () => (await world.report())?.branch)
  }
  return world
}

/** Installs an executable hook in the project's shared hooks directory. */
export function installHook(w: World, name: string, script: string): void {
  const common = w.git('rev-parse', '--git-common-dir')
  const dir = join(common.startsWith('/') ? common : join(w.dir, common), 'hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
}

export type { Repo }

/** SC-1's changes in feat: README.md staged, math.ts unstaged, old.ts renamed to new.ts (staged), notes.txt untracked. */
export function sc1(w: World): void {
  w.write('README.md', 'one\ntwo\nthree\nfour\n')
  w.git('add', 'README.md')
  w.write('math.ts', 'a\nB\nc\nd\ne\nf1\nf2\nf3\nf4\n')
  w.git('mv', 'old.ts', 'new.ts')
  w.write('notes.txt', 'x\ny\nz\n')
}

type TerminalViewTab = { id: string; kind: 'view'; viewId: string; input?: Record<string, unknown> }
type TerminalTab = { id: string; kind?: never }
type WorkspaceTab = TerminalViewTab | TerminalTab
type WorkspaceGroup = { kind: 'group'; id: string; tabs: WorkspaceTab[]; activeTab: string | null }
type WorkspaceNode = WorkspaceGroup | { kind: 'split'; first: WorkspaceNode; second: WorkspaceNode }
type TerminalWorkspace = { root: WorkspaceNode; activeGroup: string }

function groupsIn(node: WorkspaceNode): WorkspaceGroup[] {
  return node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)]
}

/** All hosted view tabs with `viewId` in this worktree, including tabs in split groups. */
export async function viewTabs(w: World, viewId: string): Promise<TerminalViewTab[]> {
  const { workspace } = await w.agent.callAny('quirky.terminal/workspace', { workspace: w.feat.id }) as { workspace: TerminalWorkspace }
  return groupsIn(workspace.root).flatMap((group) =>
    group.tabs.filter((tab): tab is TerminalViewTab => tab.kind === 'view' && tab.viewId === viewId)
  )
}

/** The selected top-level view, or its settled active hosted tab when the terminal owns it. */
export async function openView(w: World): Promise<{ id: string; input?: Record<string, unknown> } | null> {
  const root = (await w.state()).layout.view
  if (!root) return null
  const input = typeof root.input === 'object' && root.input !== null && !Array.isArray(root.input)
    ? root.input as Record<string, unknown>
    : undefined
  const shown = { id: root.id, ...(input === undefined ? {} : { input }) }
  if (root.id !== SESSION_VIEW || typeof input?.worktree !== 'string') return shown
  const { workspace } = await w.agent.callAny('quirky.terminal/workspace', { workspace: input.worktree }) as { workspace: TerminalWorkspace }
  const group = groupsIn(workspace.root).find((candidate) => candidate.id === workspace.activeGroup)
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTab)
  if (tab?.kind !== 'view') return shown
  if (tab.viewId === DIFF_VIEW && tab.input?.tabId !== tab.id) return null
  return { id: tab.viewId, ...(tab.input === undefined ? {} : { input: tab.input }) }
}

const GITHUB_FIXTURE_ENV = [
  'HOME', 'QUIRKY_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED',
  'QUIRKY_TEST_GH_STATE', 'QUIRKY_TEST_SCOPE'
]

const GH_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.QUIRKY_TEST_GH_STATE, 'utf8'))
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1) }
const endpoint = args.find((value) => value.startsWith('repos/')) ?? ''
const currentHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim()
const lookupFor = (branch) => state.lookups?.[branch] ?? { kind: 'none' }
const restPull = (branch, lookup) => {
  const merged = lookup.state === 'MERGED'
  const url = 'https://github.com/test-owner/test-repo/pull/' + lookup.number
  return {
    number: lookup.number,
    html_url: url,
    state: merged || lookup.state === 'CLOSED' ? 'closed' : 'open',
    merged_at: merged ? '2026-10-28T00:00:00Z' : null,
    draft: lookup.state === 'DRAFT',
    head: { ref: branch, sha: currentHead(), repo: { name: 'test-repo', owner: { login: 'test-owner' } } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { name: 'test-repo', owner: { login: 'test-owner' } } }
  }
}
if (args[0] === '--version') emit('gh version 2.70.0\n')
else if (args[0] === 'auth' && args[1] === 'status') emit('Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org\n')
else if (args[0] === 'auth' && args[1] === 'token') emit('fixture-token\n')
else if (args[0] === 'repo' && args[1] === 'view') emit({ defaultBranchRef: { name: 'main' } })
else if (args[0] === 'api' && args.includes('rate_limit')) emit({ resources: { core: { limit: 5000, remaining: 4500, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4500, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
else if (args[0] === 'api' && args.includes('user')) emit({ login: 'fixture-user' })
else if (args[0] === 'api' && args.includes('graphql')) {
  const request = input.length === 0 ? {} : JSON.parse(input)
  const variables = request.variables ?? {}
  emit({ data: { repository: {
    id: 'REPO_' + (variables.owner ?? 'test-owner') + '_' + (variables.name ?? 'test-repo'),
    viewerDefaultMergeMethod: 'SQUASH',
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
    squashMergeAllowed: true,
    autoMergeAllowed: true,
    defaultBranchRef: { name: 'main' },
    mergeQueue: null,
    ref: { rules: { nodes: [] } }
  } } })
}
else if (args[0] === 'api' && endpoint.includes('/pulls?')) {
  const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
  const branch = (query.get('head') ?? '').split(':').at(-1) ?? ''
  const lookup = lookupFor(branch)
  if (lookup.kind === 'unavailable') fail('HTTP 503: fixture lookup unavailable')
  if (lookup.kind !== 'found') emit([])
  else emit([restPull(branch, lookup)])
}
else if (args[0] === 'api' && /\/pulls\/\d+$/.test(endpoint)) {
  const number = Number(endpoint.match(/\/pulls\/(\d+)$/)?.[1])
  const match = Object.entries(state.lookups ?? {}).find(([, lookup]) => lookup.number === number)
  if (!match) fail('HTTP 404: Not Found')
  emit(restPull(match[0], match[1]))
}
else fail('Unexpected fixture GitHub command: ' + args.join(' '))
`

export type GitHubLookup = { kind: 'none' } | { kind: 'unavailable' } | { kind: 'found'; number: number; state?: 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED' }

/** A fake `gh` on PATH, and a `git` wrapper that sends pushes for the fake GitHub remote to a local bare repo. */
export type GitHubFixture = {
  setLookup(branch: string, lookup: GitHubLookup): void
  /** Points pushes to https://github.com/test-owner/test-repo.git at `bare`. */
  installTransport(bare: string): void
  /** Puts the environment back and removes the scope the fixture made. */
  restore(): Promise<void>
}

/**
 * Installs the fake GitHub in this process's environment, so a daemon started afterwards spawns it.
 * Call `restore` after `shutdown`; the lookup for every branch starts as "no pull request".
 */
export function startGitHubFixture(root: string): GitHubFixture {
  const bin = join(root, 'bin')
  const statePath = join(root, 'state.json')
  const scope = createProcessScope()
  const home = scope.home
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(home, '.config'), { recursive: true })
  const ghPath = join(bin, 'gh')
  writeFileSync(ghPath, `#!/usr/bin/env bun\n${GH_SCRIPT}\n`, { mode: 0o755 })
  chmodSync(ghPath, 0o755)
  writeFileSync(statePath, JSON.stringify({ lookups: {} }))

  const saved = new Map(GITHUB_FIXTURE_ENV.map((key) => [key, process.env[key]]))
  process.env.HOME = home
  process.env.QUIRKY_HOME = scope.home
  process.env.QUIRKY_TEST_SCOPE = scope.env.QUIRKY_TEST_SCOPE
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GH_CONFIG_DIR = join(home, '.config', 'gh')
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  process.env.QUIRKY_TEST_GH_STATE = statePath
  process.env.GH_PROMPT_DISABLED = '1'
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO']) delete process.env[key]

  const writeState = (state: unknown) => {
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, statePath)
  }
  return {
    setLookup(branch, lookup) {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { lookups: Record<string, GitHubLookup> }
      state.lookups[branch] = lookup
      writeState(state)
    },
    installTransport(bare) {
      const realGit = Bun.which('git')
      if (!realGit) throw new Error('the test Git executable is unavailable')
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      const wrapper = [
        '#!/bin/sh',
        'if [ "$1" = "push" ]; then',
        '  shift',
        '  export GIT_ALLOW_PROTOCOL=file',
        `  exec ${quote(realGit)} -c ${quote(`url.${bare}.insteadOf=https://github.com/test-owner/test-repo.git`)} push "$@"`,
        'fi',
        `exec ${quote(realGit)} "$@"`
      ].join('\n') + '\n'
      writeFileSync(join(bin, 'git'), wrapper, { mode: 0o755 })
    },
    async restore() {
      try {
        await scope.cleanup()
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  }
}
