import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  HOOK_TOKEN_HEADER,
  RpcError,
  type GitStatus,
  type GitStatusEntry,
  type PtyHistoryPage,
  type QuirkyClient,
  type QuirkyEvent,
  type Repo,
  type Session,
  type Worktree,
  type WorktreeCreateResult
} from '@quirky/protocol'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import { makeTempHome, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs, writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { addFakeRepo, fakeRegistrations } from '../../quirky.worktree/test/fixtures/fake-git'

const PLUGINS_ROOT = resolve(import.meta.dir, '../..')
const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'QUIRKY_TEST_AGENT_TIME_SCALE'] as const
const AGENTS = ['claude', 'codex', 'gemini']
const BUILTIN_OWNERS = [
  'quirky.accounts', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.cli',
  'quirky.git', 'quirky.handoff', 'quirky.repo', 'quirky.session', 'quirky.structured',
  'quirky.terminal', 'quirky.vault', 'quirky.worktree'
]
const DEFAULT_TIME_SCALE = 0.05
export const PASTE_ON = '\x1b[?2004h'
export const CURSOR_ON = '\x1b[?25h'
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

/** Agents the rig installs for delivery tests: one with a ready signal that waits, and one that pastes blind. */
const STRICT_AGENT = {
  id: 'strict-bot',
  label: 'Strict Bot',
  detect: 'strict-bot',
  prompt: 'stdin-after-start',
  readySignal: 'render-cursor-after-bracketed-paste',
  readyTimeoutMs: 8000,
  blindPaste: false
}
const BLIND_AGENT = { ...STRICT_AGENT, id: 'blind-bot', label: 'Blind Bot', detect: 'blind-bot', blindPaste: true }

/**
 * A plugin that stands in for the editor: `quirky.editor/state` returns buffers and open-tab
 * mappings, including one tab outside the requested worktree for root-filter coverage.
 */
export function fakeEditor(documents: string[]): { manifest: object; files: Record<string, string> } {
  return {
    manifest: {
      id: 'quirky.editor',
      name: 'Editor',
      version: '1.0.0',
      main: 'main.ts',
      activation: 'startup',
      contributes: {
        method: [
          {
            id: 'state',
            description: 'The documents open in a worktree.',
            readOnly: true,
            params: { type: 'object', properties: { worktree: { type: 'string' } } },
            result: { type: 'object' }
          }
        ]
      }
    },
    files: {
      'main.ts': `import { isAbsolute, join, relative } from 'node:path'
export function activate(context) {
  context.provide('method:quirky.editor/state', async (params) => {
    const worktree = await context.call('quirky.worktree/show', { worktree: params.worktree })
    const buffers = ${JSON.stringify(documents)}.map((requestedPath, index) => {
      const path = isAbsolute(requestedPath) ? requestedPath : join(worktree.path, requestedPath)
      return { id: \`fake-buffer-\${index}\`, path, relativePath: relative(worktree.path, path) }
    })
    const outsidePath = '/outside/the/worktree.ts'
    buffers.push({
      id: 'fake-outside-buffer',
      path: outsidePath,
      relativePath: relative(worktree.path, outsidePath)
    })
    const tabs = buffers.map((buffer, index) => ({
      tabId: \`fake-tab-\${index}\`,
      bufferId: buffer.id,
      mode: 'edit'
    }))
    return { buffers, tabs }
  })
}
`
    }
  }
}

export function gitStatus(entries: GitStatusEntry[], extra: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feature',
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    head: 'a'.repeat(40),
    detached: false,
    unborn: false,
    entries,
    operation: 'none',
    capped: false,
    upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null },
    busy: null,
    ...extra
  }
}

export type RigOptions = {
  editor?: string[]
  realEditor?: boolean
  agentsInstalled?: string[]
  /** Multiplies the agents' delivery waits and the handoff's watch window; defaults to 0.05. */
  timeScale?: number
}

/**
 * A daemon with the real dependency and context owners over a fake git and PTY host, a temporary
 * HOME holding transcript roots, fake agent programs on a private PATH, and a repo `quirky`.
 */
export class HandoffRig {
  worktrees: Record<string, Worktree> = {}
  repo!: Repo
  root = ''
  userHome = ''
  events: QuirkyEvent[] = []
  logs: string[] = []
  private readonly saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  private constructor(
    readonly h: Harness,
    readonly client: QuirkyClient,
    readonly git: FakeGit
  ) {}

  static async start(options: RigOptions = {}): Promise<HandoffRig> {
    const git = createFakeGit()
    useTestGit(git)
    fakeRegistrations(git)
    const saved: HandoffRig['saved'] = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]

    const home = makeTempHome('qho-')
    const userHome = realpathSync(makeTempDir('qho-user-'))
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of options.agentsInstalled ?? [...AGENTS, STRICT_AGENT.detect, BLIND_AGENT.detect]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(bin, name), 0o755)
    }
    const shell = join(home, 'login-shell')
    writeFileSync(shell, `#!/bin/sh\necho ${bin}\n`)
    chmodSync(shell, 0o755)
    process.env.HOME = userHome
    process.env.QUIRKY_AGENT_SEARCH_DIRS = ''
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CODEX_HOME
    process.env.QUIRKY_TEST_AGENT_TIME_SCALE = String(options.timeScale ?? DEFAULT_TIME_SCALE)

    const builtin = join(home, 'builtin')
    mkdirSync(builtin)
    for (const name of BUILTIN_OWNERS) symlinkSync(join(PLUGINS_ROOT, name), join(builtin, name))
    if (options.editor) {
      const editor = fakeEditor(options.editor)
      const dir = writePlugin(join(home, 'editor-src'), editor.manifest, editor.files)
      symlinkSync(dir, join(builtin, 'quirky.editor'))
    } else if (options.realEditor) {
      symlinkSync(join(PLUGINS_ROOT, 'quirky.editor'), join(builtin, 'quirky.editor'))
    }

    const bots = writePlugin(join(home, 'bots-src'), { id: 'acme.bots', name: 'Bots', version: '1.0.0', contributes: { agent: [STRICT_AGENT, BLIND_AGENT] } })
    symlinkSync(bots, join(builtin, 'acme.bots'))

    const logs: string[] = []
    const h = await startHarness({ home, shell, builtinPluginsDir: builtin, log: (line) => logs.push(line) })
    const { client, events } = await h.connectWithEvents('cli')
    const rig = new HandoffRig(h, client, git)
    Object.assign(rig.saved, saved)
    rig.events = events
    rig.logs = logs
    rig.userHome = userHome
    rig.root = realpathSync(makeTempDir('qho-root-'))
    await client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: rig.root })
    await client.callAny('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
    const dir = addFakeRepo(git, 'quirky')
    rig.repo = (await client.callAny('quirky.repo/add', { path: dir })) as Repo
    const main = ((await client.callAny('quirky.worktree/list', {})) as Worktree[]).find((worktree) => worktree.isMain)!
    rig.worktrees.main = main
    return rig
  }

  async cleanup(): Promise<void> {
    useTestGit(null)
    await this.h.cleanup()
    removeTempDirs()
    for (const key of ENV_KEYS) {
      if (this.saved[key] === undefined) delete process.env[key]
      else process.env[key] = this.saved[key]
    }
  }

  call = (method: string, params: Record<string, unknown> = {}) => this.client.callAny(method, params)

  async failure(method: string, params: Record<string, unknown> = {}): Promise<RpcError> {
    try {
      await this.client.callAny(method, params)
    } catch (error) {
      return error as RpcError
    }
    throw new Error(`${method} should have failed`)
  }

  async worktree(name: string, repo: Repo = this.repo): Promise<Worktree> {
    const key = repo === this.repo ? name : `${repo.id}:${name}`
    const existing = this.worktrees[key]
    if (existing) return existing
    const created = (await this.call('quirky.worktree/create', { repo: repo.id, name })) as WorktreeCreateResult
    this.worktrees[key] = created.worktree
    return created.worktree
  }

  async session(worktree: string, agent = 'claude'): Promise<Session> {
    return (await this.call('quirky.session/create', { worktree: (await this.worktree(worktree)).id, agent })) as Session
  }

  /** A second repository with its own main worktree. */
  async otherRepo(name: string): Promise<{ repo: Repo; main: Worktree }> {
    const repo = (await this.call('quirky.repo/add', { path: addFakeRepo(this.git, name) })) as Repo
    const main = ((await this.call('quirky.worktree/list', { repo: repo.id })) as Worktree[]).find((worktree) => worktree.isMain)!
    return { repo, main }
  }

  /** A folder project that is not a git repository, at `path` or a fresh directory. */
  async folder(name: string, path?: string): Promise<{ repo: Repo; workspace: Worktree }> {
    const dir = path ?? join(realpathSync(makeTempDir('qho-folder-')), name)
    mkdirSync(dir, { recursive: true })
    const repo = (await this.call('quirky.repo/add', { path: dir, folder: true })) as Repo
    const workspace = ((await this.call('quirky.worktree/list', { repo: repo.id })) as Worktree[])[0]!
    return { repo, workspace }
  }

  async hook(agent: string, session: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.h.runtime.port}/hook/${agent}?${new URLSearchParams({ session })}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: this.h.runtime.hookToken },
      body: JSON.stringify(payload)
    })
    if (response.status !== 200) throw new Error(`hook answered ${response.status}`)
  }

  /** A Claude turn from the prompt to Stop, leaving the row done with the given last message. */
  async turn(session: string, prompt: string, message?: string): Promise<void> {
    await this.hook('claude', session, { hook_event_name: 'UserPromptSubmit', prompt })
    await this.hook('claude', session, { hook_event_name: 'Stop', ...(message === undefined ? {} : { last_assistant_message: message }) })
  }

  /** Starts a Claude turn and leaves it running. */
  startTurn(session: string, prompt: string): Promise<void> {
    return this.hook('claude', session, { hook_event_name: 'UserPromptSubmit', prompt })
  }

  stop(session: string, message?: string): Promise<void> {
    return this.hook('claude', session, { hook_event_name: 'Stop', ...(message === undefined ? {} : { last_assistant_message: message }) })
  }

  /** Records what the agent reported as its own session, as the status hooks do. */
  async reportTranscript(session: string, providerId: string, transcriptPath?: string): Promise<void> {
    await this.call('quirky.session/setProviderSession', {
      session,
      id: providerId,
      ...(transcriptPath === undefined ? {} : { transcriptPath })
    })
    await this.settle()
  }

  /** Makes `quirky.git/status` answer with these entries, on branch `feature` unless `extra` says otherwise. */
  status(entries: GitStatusEntry[], extra: Partial<GitStatus> = {}): void {
    this.git.statusV2 = async () => gitStatus(entries, extra)
  }

  setHistory(lines: string[], cursor: string | null = null): void {
    const page: PtyHistoryPage = { lines, cursor }
    this.h.pty.setHistoryResult(page)
  }

  /** Writes a transcript file under the temp HOME's Claude root; returns its real path. */
  claudeTranscript(project: string, id: string, mtime?: Date): string {
    const path = join(this.userHome, '.claude', 'projects', project, `${id}.jsonl`)
    return this.writeFile(path, mtime)
  }

  codexTranscript(id: string): string {
    return this.writeFile(join(this.userHome, '.codex', 'sessions', '2026', '10', '27', `rollout-2026-10-27T10-00-00-${id}.jsonl`))
  }

  writeFile(path: string, mtime?: Date): string {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
    if (mtime) utimesSync(path, mtime, mtime)
    return realpathSync(path)
  }

  /** Writes a row straight into the plugin's store while the daemon runs, as a stand-in for part 2's writes. */
  seedKv(key: string, value: unknown): void {
    const db = new Database(join(this.h.home, 'plugin-data', 'quirky.handoff', 'store.db'))
    try {
      db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    } finally {
      db.close()
    }
  }

  /** Calls `handler` once for every PTY session that appears from now on; returns the stopper. */
  onSpawn(handler: (sessionId: string) => void): () => void {
    const seen = new Set(this.h.pty.sessions.keys())
    const timer = setInterval(() => {
      for (const id of this.h.pty.sessions.keys()) {
        if (seen.has(id)) continue
        seen.add(id)
        handler(id)
      }
    }, 5)
    return () => clearInterval(timer)
  }

  /** Runs `action` until it stops throwing, for a session whose record is still being written. */
  async eventually(action: () => Promise<unknown>, attempts = 40): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await action()
        return
      } catch (error) {
        if (attempt >= attempts) throw error
        await Bun.sleep(15)
      }
    }
  }

  /** Makes every agent that starts from now on show a ready composer. */
  autoReady(): () => void {
    return this.onSpawn((id) => this.h.pty.emit(id, PASTE_ON + CURSOR_ON))
  }

  /** The workspace of a worktree, giving it its first tab (adopting its sessions) when it has none. */
  async layout(worktreeId: string): Promise<{ id: string; activeGroup: string; root: any }> {
    return ((await this.call('quirky.terminal/workspace', { workspace: worktreeId, ensure: true })) as { workspace: any }).workspace
  }

  notifications(): Extract<QuirkyEvent, { type: 'notify' }>[] {
    return this.events.filter((event): event is Extract<QuirkyEvent, { type: 'notify' }> => event.type === 'notify')
  }

  private withStore(run: (db: Database) => void): void {
    const db = new Database(join(this.h.home, 'plugin-data', 'quirky.handoff', 'store.db'))
    try {
      run(db)
    } finally {
      db.close()
    }
  }

  /** Makes every later lineage insert fail inside the store. */
  refuseLineageWrites(): void {
    this.withStore((db) => db.exec("CREATE TRIGGER refuse_lineage BEFORE INSERT ON lineage BEGIN SELECT RAISE(ABORT, 'refused'); END"))
  }

  /** Writes raw lineage rows into the store; `record` is stored as given when it is a string. */
  seedLineage(rows: { id: string; createdAt: number; record: unknown }[]): void {
    this.withStore((db) => {
      const insert = db.query('INSERT INTO lineage (id, created_at, record) VALUES (?, ?, ?)')
      for (const row of rows) insert.run(row.id, row.createdAt, typeof row.record === 'string' ? row.record : JSON.stringify(row.record))
    })
  }

  lineageRows(): { id: string; created_at: number }[] {
    let rows: { id: string; created_at: number }[] = []
    this.withStore((db) => {
      rows = db.query('SELECT id, created_at FROM lineage ORDER BY created_at').all() as typeof rows
    })
    return rows
  }

  pluginEvents(name: string): Record<string, unknown>[] {
    return this.events
      .filter((event) => event.type === `quirky.handoff/${name}`)
      .map((event) => (event as { data: Record<string, unknown> }).data)
  }

  waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
    return waitFor(check, timeoutMs)
  }

  async settle(ms = 80): Promise<void> {
    await Bun.sleep(ms)
  }
}
