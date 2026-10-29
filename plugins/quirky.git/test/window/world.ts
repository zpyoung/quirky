import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QuirkyClient, Repo, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { spawnCli } from '../../../../packages/cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../../packages/daemon/test/plugins/fixtures'
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
  /** The diff view's last report. */
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
    await win.waitFor(async () => (await world.report())?.primary)
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

/** The accessible Source Control badge, or null when the panel has no uncommitted changes. */
export function badge(): { count: string; title: string } | null {
  const span = document.querySelector<HTMLElement>('[role="img"][aria-label^="Source Control —"]')
  return span ? { count: span.textContent ?? '', title: span.getAttribute('aria-label') ?? '' } : null
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

/** The active hosted view in this worktree's terminal workspace, or null. */
export async function openView(w: World): Promise<{ id: string; input?: Record<string, unknown> } | null> {
  const { workspace } = await w.agent.callAny('quirky.terminal/workspace', { workspace: w.feat.id }) as { workspace: TerminalWorkspace }
  const group = groupsIn(workspace.root).find((candidate) => candidate.id === workspace.activeGroup)
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTab)
  return tab?.kind === 'view' ? { id: tab.viewId, ...(tab.input === undefined ? {} : { input: tab.input }) } : null
}
