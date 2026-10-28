import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { E2eHarness, waitFor, type E2eOptions } from '../e2e-support'
import type { FloatingState, GroupNode, PaneLeaf, PaneNode, Tab, Workspace } from '../../src/layout/types'

export { E2eHarness, cleanupAll, descendantsOf, isAlive, plain, waitFor } from '../e2e-support'
export type { FloatingState, GroupNode, PaneLeaf, PaneNode, Tab, Workspace }

type Group = Extract<GroupNode, { kind: 'group' }>
type EnvPatchable = { daemonEnv(): Record<string, string> }

const extraEnvOf = new WeakMap<object, Record<string, string>>()
let pendingEnv: Record<string, string> | undefined
let patched = false

/** Scenario tests start real processes, so they get more than Bun's 5 s default. */
export const SCENARIO_MS = 90_000

/**
 * The harness keeps its daemon environment private and fixed. This hook adds per-harness variables
 * to it: the first start reads the pending set, and a restart of the same harness reuses it.
 */
function patchDaemonEnv(): void {
  if (patched) return
  patched = true
  const proto = E2eHarness.prototype as unknown as EnvPatchable
  const original = proto.daemonEnv
  proto.daemonEnv = function (this: object) {
    if (pendingEnv && !extraEnvOf.has(this)) extraEnvOf.set(this, pendingEnv)
    return { ...original.call(this), ...extraEnvOf.get(this) }
  }
}

export type StartOptions = E2eOptions & {
  /** Extra variables for the daemon (and so the plugin), kept across restarts of it. */
  env?: Record<string, string>
}

/** A fresh daemon, PTY host and git repo `api` with worktree `main`. */
export async function startE2e(options: StartOptions = {}): Promise<E2eHarness> {
  patchDaemonEnv()
  const { env, ...harnessOptions } = options
  pendingEnv = env
  try {
    return await E2eHarness.start(harnessOptions)
  } finally {
    pendingEnv = undefined
  }
}

/** Stops the daemon (the PTY host and its sessions keep running) and starts a new one. */
export async function restartDaemon(h: E2eHarness, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  await h.stopDaemon(signal)
  await h.startDaemon()
}

export function groupsOf(ws: Workspace): Group[] {
  const out: Group[] = []
  const walk = (node: GroupNode) => {
    if (node.kind === 'group') out.push(node)
    else {
      walk(node.first)
      walk(node.second)
    }
  }
  walk(ws.root)
  return out
}

export const tabsOf = (ws: Workspace): Tab[] => groupsOf(ws).flatMap((group) => group.tabs)

export const leavesOf = (node: PaneNode): PaneLeaf[] => (node.kind === 'pane' ? [node] : [...leavesOf(node.first), ...leavesOf(node.second)])

export const panesOf = (ws: Workspace): PaneLeaf[] => tabsOf(ws).flatMap((tab) => leavesOf(tab.root))

/** A tab's panes as nested arrays: a pane is its ID, a split is `[direction, ratio, first, second]`. */
export function paneShape(node: PaneNode): unknown {
  return node.kind === 'pane' ? node.id : [node.direction, node.ratio, paneShape(node.first), paneShape(node.second)]
}

/** The group tree as nested arrays: a group is its tab titles, a split is `[direction, ratio, first, second]`. */
export function groupShape(node: GroupNode): unknown {
  return node.kind === 'group' ? node.tabs.map(tabTitle) : [node.direction, node.ratio, groupShape(node.first), groupShape(node.second)]
}

/** What a tab's label reads: custom title, else the shell's live title, else the default. */
export const tabTitle = (tab: Tab): string => tab.customTitle || tab.liveTitle || tab.defaultTitle

export function findTab(ws: Workspace, id: string): Tab {
  const found = tabsOf(ws).find((tab) => tab.id === id)
  if (!found) throw new Error(`no tab ${id} in ${JSON.stringify(tabsOf(ws).map((tab) => tab.id))}`)
  return found
}

export function groupOf(ws: Workspace, tabId: string): Group {
  const found = groupsOf(ws).find((group) => group.tabs.some((tab) => tab.id === tabId))
  if (!found) throw new Error(`no group holds ${tabId}`)
  return found
}

/** The workspace of worktree `main` (or `selector`, e.g. `floating`) as `quirky terminal layout --json` prints it. */
export function layoutOf(h: E2eHarness, selector = 'main'): Promise<Workspace> {
  return h.json<Workspace>(['terminal', 'layout', '--worktree', selector])
}

/** Waits until the layout satisfies `check`, so a test never races the daemon's reconciliation. */
export function waitForLayout(h: E2eHarness, what: string, check: (ws: Workspace) => boolean, selector = 'main', timeoutMs = 30_000): Promise<Workspace> {
  return waitFor(
    `the layout of ${selector} to have ${what}`,
    async () => {
      const ws = await layoutOf(h, selector)
      return check(ws) ? ws : undefined
    },
    timeoutMs
  )
}

/** The workspace after making sure it has its first tab, as the window does when it opens. */
export async function ensureWorkspace(h: E2eHarness, selector = 'main'): Promise<Workspace> {
  const { workspace } = await h.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: selector, ensure: true })
  return workspace
}

/** Waits for a shell-ready marker, or a real command round-trip in clean-shell mode. */
export async function waitReady(h: E2eHarness, session: string): Promise<void> {
  if (h.cleanShell) {
    await h.run(session, ':')
    return
  }
  await waitFor(`a ready shell for ${session}`, async () => (await h.hostRow(session))?.shellState === 'ready')
}

export type Opened = { tab: Tab; pane: PaneLeaf; session: string; workspace: Workspace }

/**
 * Opens a tab with `quirky terminal tab new` (extra words after `new`) and returns it once its
 * shell is at the prompt, unless `ready` is false.
 */
export async function openTab(h: E2eHarness, extra: string[] = [], options: { ready?: boolean; selector?: string } = {}): Promise<Opened> {
  const selector = options.selector ?? (extra.includes('floating') ? 'floating' : 'main')
  const before = new Set(tabsOf(await layoutOf(h, selector)).map((tab) => tab.id))
  const { workspace } = await h.json<{ workspace: Workspace }>(['terminal', 'tab', 'new', ...extra])
  const tab = tabsOf(workspace).find((candidate) => !before.has(candidate.id))!
  const pane = leavesOf(tab.root)[0]!
  if (options.ready !== false) await waitReady(h, pane.session)
  return { tab, pane, session: pane.session, workspace }
}

/** Splits `pane` with the CLI and returns the new pane once its shell is at the prompt. */
export async function splitPane(h: E2eHarness, pane: string, direction: 'right' | 'down'): Promise<{ pane: PaneLeaf; workspace: Workspace }> {
  const known = new Set(panesOf(await layoutOf(h, 'main')).map((candidate) => candidate.id))
  const { workspace } = await h.json<{ workspace: Workspace }>(['terminal', 'pane', 'split', pane, '--direction', direction])
  const created = panesOf(workspace).find((candidate) => !known.has(candidate.id))!
  await waitReady(h, created.session)
  return { pane: created, workspace }
}

/** `quirky terminal <words>` that must succeed, parsed from `--json`. */
export function terminal<T = { workspace: Workspace }>(h: E2eHarness, ...words: string[]): Promise<T> {
  return h.json<T>(['terminal', ...words])
}

/** A CLI call that must fail: its exit code and stderr. */
export async function fails(h: E2eHarness, args: string[]): Promise<{ code: number; stderr: string }> {
  const result = await h.cli(args)
  if (result.code === 0) throw new Error(`quirky ${args.join(' ')} should have failed but printed ${result.stdout}`)
  return { code: result.code, stderr: result.stderr }
}

/** The rejection of a daemon call that must fail. */
export async function rejection(promise: Promise<unknown>): Promise<{ code: string | number | undefined; message: string }> {
  try {
    await promise
  } catch (error) {
    const { code, message } = error as { code?: string | number; message: string }
    return { code, message }
  }
  throw new Error('the call should have been refused')
}

export { RpcErrorCode }

/** The plugin store opened while the daemon is stopped; the caller closes it. */
export function openStore(h: E2eHarness): Database {
  return new Database(join(h.home, 'plugin-data', 'quirky.terminal', 'store.db'))
}

/** The daemon's log, which carries the plugin's `log` lines. */
export function daemonLog(h: E2eHarness): string {
  return (h as unknown as { daemonLog(): string }).daemonLog()
}

/** The working directory of a session's shell, read from its own `$PWD`. */
export async function pwdOf(h: E2eHarness, session: string): Promise<string> {
  const rows = await h.run(session, 'echo "cwd=$PWD"')
  return rows.filter((row) => row.startsWith('cwd=/')).at(-1)!.slice('cwd='.length)
}

/** Types into a session as a person would: through `write`, which counts as driving input. */
export async function typeAsPerson(h: E2eHarness, session: string, text: string): Promise<void> {
  await h.call('quirky.terminal/write', { session, data: `${text}\r` })
}

export type PendingAsk = {
  /** The CLI process, still waiting for the answer. */
  proc: ReturnType<E2eHarness['spawnCli']>
  askId: string
  /** What the CLI has written to stderr so far. */
  stderr(): string
  /** Answers the confirmation and returns the CLI's exit code. */
  answer(yes: boolean): Promise<number>
}

/** Runs a CLI command that is expected to open a confirmation, and waits for its ask id. */
export async function startAsking(h: E2eHarness, args: string[]): Promise<PendingAsk> {
  const proc = h.spawnCli(args)
  const decoder = new TextDecoder()
  let text = ''
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      text += decoder.decode(value, { stream: true })
    }
  })()
  const found = await waitFor('the confirmation prompt', () => /\(ask (ask_\w+)\)/.exec(text), 15_000).catch((error: Error) => {
    proc.kill()
    throw new Error(`${error.message}; stderr so far: ${text}`)
  })
  const askId = found[1]!
  return {
    proc,
    askId,
    stderr: () => text,
    async answer(yes) {
      await h.ok(['ask', 'answer', '--ask-id', askId, '--answers', JSON.stringify({ confirm: { value: yes, source: 'input' } })])
      return proc.exited
    }
  }
}

/** Registers a second git repo next to `api` and returns its path. */
export async function addRepo(h: E2eHarness, name: string): Promise<string> {
  const path = join(dirname(h.repo), name)
  mkdirSync(path)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@quirky.test', '-c', 'user.name=e2e', ...args], { cwd: path, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(path, 'README.md'), `${name}\n`)
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  await h.ok(['repo', 'add', path])
  return path
}
