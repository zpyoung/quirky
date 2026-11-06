import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HOOK_TOKEN_HEADER, PLUGIN_API_VERSION, type PluginStore, type QuirkyClient, type ToolGateDecision } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from '../../../../packages/daemon/test/helpers'
import type { HandoffInput, Level } from '../../src/contracts'
import { claudeGateSettings, markerDir } from '../../src/hooks/install'
import { createAvatarStore } from '../../src/store'

export const PLUGIN_DIR = resolve(import.meta.dir, '../..')

const LOOSE = { type: 'object', additionalProperties: true }
const DEPENDENCIES = ['quirky.session', 'quirky.agents', 'quirky.ask', 'quirky.checks', 'quirky.git', 'quirky.hosting', 'quirky.notifications']
const BRAIN_READY_REPLY = '```json\n[{"type":"noop","reason":"ready"}]\n```'

export type StubWorktree = { id: string; name: string; repoId: string; path: string; branch: string; head: string; isMain: boolean; kind: 'git' | 'folder' }
export type StubSession = { id: string; kind: 'terminal'; agent: string; worktreeId: string; status: 'running'; createdAt: number; lastActivityAt: number; launch: { args: string[]; env: Record<string, string> } }

/**
 * How the stand-in for `quirky.structured` behaves. `fail` refuses every message to the brain session, so
 * the brain never becomes ready. `ready` answers the brain's first prompt and every event batch with
 * a no-op, and never answers a judgment prompt, so a judgment request waits until the test hands the
 * worktree back.
 */
export type BrainMode = 'fail' | 'ready'

/** What the stand-in plugins answer with and record; one per started daemon, shared by object reference. */
export type StubState = {
  worktrees: StubWorktree[]
  sessions: StubSession[]
  sent: { session: string; text: string }[]
  /** Sessions the avatar has read through `quirky.session/get`, which is the first step of its gate check. */
  inspected: string[]
  brain: { mode: BrainMode; sends: { session: string; text: string }[]; created: number }
}

declare global {
  // eslint-disable-next-line no-var
  var __avatarE2E: Record<string, StubState> | undefined
}

const STUBS: Record<string, { methods: string[]; events?: string[]; source: string }> = {
  'quirky.worktree': {
    methods: ['list'],
    source: `export function activate(context) {
  const state = () => globalThis.__avatarE2E[context.home]
  context.provide('method:quirky.worktree/list', () => state().worktrees)
}`
  },
  'quirky.repo': {
    methods: ['list', 'groupList'],
    source: `export function activate(context) {
  context.provide('method:quirky.repo/list', () => [{ id: 'repo-1', name: 'quirky', displayName: null, groupId: null }])
  context.provide('method:quirky.repo/groupList', () => [])
}`
  },
  'quirky.heimdall': {
    methods: ['inspect'],
    source: `export function activate(context) {
  context.provide('method:quirky.heimdall/inspect', () => [])
}`
  },
  'quirky.agent-status': {
    methods: ['send'],
    source: `export function activate(context) {
  const state = () => globalThis.__avatarE2E[context.home]
  context.provide('method:quirky.agent-status/send', (params) => {
    state().sent.push({ session: params.session, text: params.text })
    return { session: params.session, state: 'working', sentAt: Date.now(), startedAt: Date.now() }
  })
}`
  },
  'quirky.session': {
    methods: ['list', 'get'],
    source: `export function activate(context) {
  const state = () => globalThis.__avatarE2E[context.home]
  context.provide('method:quirky.session/list', () => state().sessions)
  context.provide('method:quirky.session/get', (params) => {
    const found = state().sessions.find((session) => session.id === params.session)
    if (!found) throw new Error('unknown session')
    state().inspected.push(found.id)
    return found
  })
}`
  },
  'quirky.structured': {
    methods: ['create', 'send', 'stop'],
    events: ['message', 'settled'],
    source: `export function activate(context) {
  const state = () => globalThis.__avatarE2E[context.home]
  context.provide('method:quirky.structured/create', () => {
    const brain = state().brain
    brain.created += 1
    return { id: 'brain-' + brain.created }
  })
  context.provide('method:quirky.structured/stop', () => ({ ok: true }))
  context.provide('method:quirky.structured/send', (params) => {
    const brain = state().brain
    if (brain.mode === 'fail') return { ok: false, reason: 'no structured runner in this test' }
    brain.sends.push({ session: params.session, text: params.text })
    if (brain.sends.length === 1 || String(params.text).startsWith('New events since')) {
      setTimeout(() => {
        const at = Date.now()
        context.emit('message', { message: { sessionId: params.session, seq: 1, role: 'assistant', text: ${JSON.stringify(BRAIN_READY_REPLY)}, at } })
        context.emit('settled', { sessionId: params.session, worktreeId: 'brain', agent: 'claude', state: 'done', lastAssistantMessage: null, at })
      }, 10)
    }
    return { ok: true }
  })
}`
  }
}

function writeStub(root: string, id: string, stub: (typeof STUBS)[string]): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    apiVersion: PLUGIN_API_VERSION,
    name: id,
    version: '0.1.0',
    activation: 'lazy',
    main: 'main.ts',
    contributes: {
      method: stub.methods.map((method) => ({ id: method, params: LOOSE })),
      ...(stub.events === undefined ? {} : { event: stub.events.map((event) => ({ id: event, data: LOOSE })) })
    }
  }
  writeFileSync(join(dir, 'quirky-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'main.ts'), stub.source)
}

function writeEmptyStub(root: string, id: string): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'quirky-plugin.json'), JSON.stringify({ id, apiVersion: '1.0.0', name: id, version: '0.1.0', activation: 'lazy' }))
}

export type Avatar = {
  harness: Harness
  client: QuirkyClient
  state: StubState
  /** The three worktrees: `alpha` and `beta` can be handed off, `gamma` is a folder and cannot. */
  alpha: StubWorktree
  beta: StubWorktree
  gamma: StubWorktree
  /** A directory that no handed-off worktree owns. */
  outside: string
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** POSTs one tool call to `/gate/<agent>` the way the shim does, as `session`. */
  gate(session: string, payload: Record<string, unknown>, options?: { agent?: string; event?: string; deadlineMs?: number }): Promise<ToolGateDecision>
  /** Runs the real `quirky-gate` shim for `session` and returns what it printed and exited with. */
  shim(session: string, payload: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number }>
  /** The avatar's own store file, opened for reading and checking. */
  store(): ReturnType<typeof createAvatarStore>
  /**
   * Lets every gate check that is still waiting finish, by having each such worker make one read
   * the gate sees. A check still running when the daemon stops would journal into a closed store.
   */
  settle(): Promise<void>
  hasMarker(session: string): boolean
  /** Hands off the given worktrees with a goal each and returns the route's per-item results once each gate check has started. */
  handoff(items: { worktree: StubWorktree; level: Level; goal?: string }[]): Promise<{ worktreeId: string; ok: boolean; error?: string }[]>
}

const started = new Set<Harness>()
const avatars = new Set<Avatar>()
const databases: Database[] = []
const directories: string[] = []
const restoreSpawn: (() => void)[] = []

/** Stops every daemon started through `startAvatar` and removes what it created; call from `afterEach`. */
export async function cleanupAll(): Promise<void> {
  for (const avatar of [...avatars]) await avatar.settle().catch(() => undefined)
  avatars.clear()
  for (const db of databases.splice(0)) db.close()
  for (const harness of [...started]) await harness.cleanup()
  started.clear()
  for (const restore of restoreSpawn.splice(0)) restore()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function fileStore(path: string): PluginStore {
  const db = new Database(path)
  databases.push(db)
  return {
    version: 0,
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
}

/**
 * Makes every `Bun.spawn(['claude', ...])` run a stand-in that reports a new-enough version, so no
 * test depends on the installed one. Changing `process.env.PATH` does not do it: Bun finds the
 * command on the PATH it started with, so an installed Claude that is too old (or missing) wins.
 */
function fakeClaudeSpawn(): void {
  const bin = mkdtempSync(join(tmpdir(), 'qav-e2e-bin-'))
  directories.push(bin)
  const fake = join(bin, 'claude')
  writeFileSync(fake, '#!/bin/sh\necho "2.1.300 (Claude Code)"\n')
  chmodSync(fake, 0o755)
  const original = Bun.spawn
  const redirect = (command: string): string => (command === 'claude' ? fake : command)
  const patched = ((first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first)) return (original as (...args: unknown[]) => unknown)([redirect(first[0] as string), ...first.slice(1)], ...rest)
    const options = first as { cmd?: string[] }
    if (options?.cmd !== undefined) return (original as (...args: unknown[]) => unknown)({ ...options, cmd: [redirect(options.cmd[0]!), ...options.cmd.slice(1)] }, ...rest)
    return (original as (...args: unknown[]) => unknown)(first, ...rest)
  }) as typeof Bun.spawn
  Bun.spawn = patched
  restoreSpawn.push(() => {
    Bun.spawn = original
  })
}

/**
 * Starts a real daemon with the real `quirky.avatar` plugin loaded. Its neighbours are small
 * stand-ins that answer the calls the avatar makes (worktrees, sessions, sends) and record what it
 * sends, so the hand-off, gate, report and take-back paths run end to end without agents or git.
 */
export async function startAvatar(options: { brain?: BrainMode } = {}): Promise<Avatar> {
  if (restoreSpawn.length === 0) fakeClaudeSpawn()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qav-e2e-')))
  directories.push(root)
  const pluginsDir = join(root, 'builtin')
  mkdirSync(pluginsDir)
  symlinkSync(PLUGIN_DIR, join(pluginsDir, 'quirky.avatar'))
  for (const [id, stub] of Object.entries(STUBS)) writeStub(pluginsDir, id, stub)
  for (const id of DEPENDENCIES) if (!(id in STUBS)) writeEmptyStub(pluginsDir, id)

  const makeWorktree = (name: string, kind: 'git' | 'folder'): StubWorktree => {
    const path = join(root, name)
    mkdirSync(join(path, 'src'), { recursive: true })
    return { id: `wt-${name}`, name, repoId: 'repo-1', path, branch: 'feature', head: 'abc123', isMain: false, kind }
  }
  const alpha = makeWorktree('alpha', 'git')
  const beta = makeWorktree('beta', 'git')
  const gamma = makeWorktree('gamma', 'folder')
  const outside = join(root, 'outside')
  mkdirSync(outside)

  const session = (id: string, worktree: StubWorktree): StubSession => ({
    id,
    kind: 'terminal',
    agent: 'claude',
    worktreeId: worktree.id,
    status: 'running',
    createdAt: 1,
    lastActivityAt: 2,
    launch: { args: ['--settings', JSON.stringify(claudeGateSettings(undefined, 30))], env: {} }
  })

  const home = makeTempHome('qav-e2e-home-')
  const state: StubState = {
    worktrees: [alpha, beta, gamma],
    sessions: [session('sess-alpha', alpha), session('sess-beta', beta)],
    sent: [],
    inspected: [],
    brain: { mode: options.brain ?? 'fail', sends: [], created: 0 }
  }
  globalThis.__avatarE2E = { ...globalThis.__avatarE2E, [home]: state }

  const harness = await startHarness({ home, builtinPluginsDir: pluginsDir })
  started.add(harness)
  const client = await harness.connect('cli', 'avatar-e2e')
  const base = `http://127.0.0.1:${harness.runtime.port}`
  let store: ReturnType<typeof createAvatarStore> | null = null

  const avatar: Avatar = {
    harness,
    client,
    state,
    alpha,
    beta,
    gamma,
    outside,
    call: (method, params = {}) => client.callAny(method, params) as Promise<never>,
    async gate(sessionId, payload, { agent = 'claude', event = 'PreToolUse', deadlineMs = 5_000 } = {}) {
      const response = await fetch(`${base}/gate/${agent}?session=${sessionId}&event=${event}&deadline=${deadlineMs}`, {
        method: 'POST',
        headers: { [HOOK_TOKEN_HEADER]: harness.runtime.hookToken },
        body: JSON.stringify({ hook_event_name: event, ...payload })
      })
      if (response.status !== 200) throw new Error(`gate answered ${response.status}`)
      return (await response.json()) as ToolGateDecision
    },
    async shim(sessionId, payload) {
      const proc = Bun.spawn(['sh', join(harness.home, 'bin', 'quirky-gate'), 'claude', '5000'], {
        env: { PATH: process.env.PATH ?? '', QUIRKY_HOME: harness.home, QUIRKY_SESSION_ID: sessionId, QUIRKY_HOOK_TOKEN: harness.runtime.hookToken },
        stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', ...payload })),
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { stdout, stderr, code }
    },
    store() {
      store ??= createAvatarStore(fileStore(join(harness.home, 'plugin-data', 'quirky.avatar', 'store.db')))
      return store
    },
    async settle() {
      const { handoffs } = await avatar.call<{ handoffs: { worktreeId: string; state: string }[] }>('quirky.avatar/status')
      const checking = handoffs.filter((row) => row.state === 'checking')
      for (const row of checking) {
        const worktree = state.worktrees.find((entry) => entry.id === row.worktreeId)
        const session = state.sessions.find((entry) => entry.worktreeId === row.worktreeId)
        if (worktree !== undefined && session !== undefined) await avatar.gate(session.id, read(worktree))
      }
      await waitFor(() => checking.every((row) => avatar.store().handoffs.get(row.worktreeId)?.state !== 'checking'))
    },
    hasMarker: (sessionId) => existsSync(join(markerDir(harness.home), sessionId)),
    async handoff(items) {
      const inputs: HandoffInput[] = items.map(({ worktree, level, goal }) => ({
        worktreeId: worktree.id,
        goal: goal ?? `Finish ${worktree.name}`,
        doneWhen: 'the tests pass',
        doneWhenKind: 'prose',
        guidelines: [],
        level,
        switches: { messaging: false, historyRewrite: false, deploys: false },
        agent: null,
        notes: '',
        allowSplit: false
      }))
      const { results } = await avatar.call<{ results: { worktreeId: string; ok: boolean; error?: string }[] }>('quirky.avatar/handoff', { items: inputs })
      const expected = results.flatMap((result) => (result.ok ? state.sessions.filter((session) => session.worktreeId === result.worktreeId).map((session) => session.id) : []))
      await waitFor(() => expected.every((id) => state.inspected.includes(id)))
      return results
    }
  }
  avatars.add(avatar)
  return avatar
}

/** A Bash tool call run from `worktree`, as Claude's hook payload carries it. */
export const bash = (worktree: StubWorktree, command: string): Record<string, unknown> => ({ cwd: worktree.path, tool_name: 'Bash', tool_input: { command } })

/** A Read of a file inside `worktree`. */
export const read = (worktree: StubWorktree): Record<string, unknown> => ({ cwd: worktree.path, tool_name: 'Read', tool_input: { file_path: join(worktree.path, 'src', 'a.ts') } })

/** A Write to `file` by an agent working in `worktree`. */
export const writeTo = (worktree: StubWorktree, file: string): Record<string, unknown> => ({ cwd: worktree.path, tool_name: 'Write', tool_input: { file_path: file, content: 'x' } })
