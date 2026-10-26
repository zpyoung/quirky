import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  base64ToBytes,
  encodeTerminalOutput,
  type AgentKind,
  type LaunchHookInput,
  type QuirkyEvent,
  type Repo,
  type Session,
  type SessionStatus,
  type Settings,
  type Worktree
} from '@quirky/protocol'
import { AskService, randomId } from './asks'
import { DaemonError, conflict, internal, invalidParams, notFound } from './errors'
import { BranchCheckedOutError, GitError, NoSuchDirectoryError } from './git'
import type { GitApi } from './git-api'
import { isClaudeIdleNotification, statusForHook } from './hooks'
import {
  AGENT_TITLES,
  buildArgv,
  buildSessionEnv,
  installIntegrationFiles
} from './launch'
import type { Notifier } from './notify'
import type { PtyClient } from './pty-client'
import { expandHome, type Store } from './store'
import type {
  NewStructuredMessage,
  StructuredContext,
  StructuredRunner,
  StructuredRunnerFactory
} from './structured/runner'
import type { ClientConn } from './types'

const WORKTREE_NAME = /^[A-Za-z0-9_./-]+$/

export type CoreOptions = {
  home: string
  store: Store
  git: GitApi
  pty: PtyClient
  notifier: Notifier
  runnerFactory: StructuredRunnerFactory
  resolveClaudePath: () => Promise<string>
  shell: string
  cliEntry: string
  enterDelayMs: number
  daemonVersion: string
  startedAt: number
  hookToken: string
  hookUrl: () => string
  /** True when the daemon runs in safe mode; reported by `status`. */
  safeMode?: boolean
  /** The unix socket path the daemon listens on, or null; reported by `status`. */
  socketPath?: string | null
  /** Called after a client connection is removed. */
  onRemoveClient?: (conn: ClientConn) => void
  /** Called at the end of `broadcast` with every event. */
  onEvent?: (event: QuirkyEvent) => void
  /**
   * Called for each terminal session after its row exists and before the PTY is asked to start it.
   * Must not reject; the result adds environment changes and agent arguments to the launch.
   */
  prepareLaunch?: (
    input: Omit<LaunchHookInput, 'env' | 'args'>
  ) => Promise<{ env: Record<string, string | null>; args: string[] }>
}

type Stream = { conn: ClientConn; streamId: number }

/**
 * `path` with symlinks resolved. The deepest existing ancestor is resolved and the rest appended,
 * so a path that doesn't exist yet gets the same prefix git will report once it does.
 */
export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(resolveRealPath(parent), basename(path))
  }
}

function isUnknownSessionError(error: unknown): boolean {
  return error instanceof Error && /^unknown session\b/.test(error.message)
}

export function worktreeIdForPath(path: string): string {
  return `wt_${createHash('sha1').update(resolveRealPath(path)).digest('hex').slice(0, 12)}`
}

/** The daemon's domain logic: repos, worktrees, sessions, terminals, hooks, asks and events. */
export class Core {
  readonly asks: AskService
  private readonly runner: StructuredRunner
  private readonly clients = new Set<ClientConn>()
  private readonly streamsBySession = new Map<string, Set<Stream>>()
  private readonly attachesInFlight = new Map<string, number>()
  private readonly receivedOffsets = new Map<string, number>()

  constructor(private readonly options: CoreOptions) {
    const { store, pty } = options
    this.asks = new AskService(store, {
      emit: (event) => this.broadcast(event),
      notify: (title, body, ids) => this.notify(title, body, ids),
      worktreeIdForSession: (sessionId) => store.getSession(sessionId)?.worktreeId ?? null
    })
    const context: StructuredContext = {
      appendMessage: (msg) => this.appendStructuredMessage(msg),
      setStatus: (sessionId, status) => {
        void this.setSessionStatus(sessionId, status)
      },
      createAsk: (spec, sessionId) => this.asks.createAndWait(spec, sessionId),
      resolveClaudePath: options.resolveClaudePath
    }
    this.runner = options.runnerFactory(context)
    pty.onData((sessionId, bytes) => this.handlePtyData(sessionId, bytes))
    pty.onExit((sessionId, exitCode) => this.handlePtyExit(sessionId, exitCode))
    pty.onReconnect(() => void this.handlePtyReconnect())
  }

  get home(): string {
    return this.options.home
  }

  get hookToken(): string {
    return this.options.hookToken
  }

  get pty(): PtyClient {
    return this.options.pty
  }

  addClient(conn: ClientConn): void {
    this.clients.add(conn)
  }

  removeClient(conn: ClientConn): void {
    conn.closed = true
    this.clients.delete(conn)
    for (const streamId of [...conn.streams.keys()]) this.removeStream(conn, streamId)
    this.options.onRemoveClient?.(conn)
  }

  /** Sends one event to one connection, whether or not it subscribed. */
  sendTo(conn: ClientConn, event: QuirkyEvent): void {
    if (conn.closed) return
    conn.sendText(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }))
  }

  broadcast(event: QuirkyEvent): void {
    const text = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event })
    for (const conn of this.clients) {
      if (conn.subscribed) conn.sendText(text)
    }
    this.options.onEvent?.(event)
  }

  status() {
    return {
      daemonVersion: this.options.daemonVersion,
      pid: process.pid,
      startedAt: this.options.startedAt,
      home: this.options.home,
      ptyHost: { pid: this.options.pty.hostPid, alive: this.options.pty.connected },
      clients: [...this.clients]
        .filter((conn) => conn.role !== null)
        .map((conn) => ({ role: conn.role!, ...(conn.name ? { name: conn.name } : {}) })),
      safeMode: this.options.safeMode ?? false,
      socket: this.options.socketPath ?? null
    }
  }

  getSettings(): Settings {
    return this.options.store.getSettings()
  }

  setSettings(values: Partial<Settings>): Settings {
    const next: Partial<Settings> = {}
    if (values.worktreesRoot !== undefined) {
      if (typeof values.worktreesRoot !== 'string' || values.worktreesRoot.trim() === '') {
        throw invalidParams('worktreesRoot must be a non-empty string')
      }
      next.worktreesRoot = expandHome(values.worktreesRoot.trim())
    }
    if (values.terminalScrollback !== undefined) {
      const lines = values.terminalScrollback
      if (!Number.isInteger(lines) || lines < 0 || lines > 1_000_000) {
        throw invalidParams('terminalScrollback must be a non-negative integer')
      }
      next.terminalScrollback = lines
    }
    if (values.notifications !== undefined) {
      if (typeof values.notifications !== 'boolean') throw invalidParams('notifications must be a boolean')
      next.notifications = values.notifications
    }
    return this.options.store.setSettings(next)
  }

  listRepos(): Repo[] {
    return this.options.store.listRepos()
  }

  async addRepo(path: string): Promise<Repo> {
    const expanded = expandHome(path)
    let root: string
    try {
      root = resolveRealPath(await this.options.git.resolveRepoRoot(expanded))
    } catch (error) {
      if (error instanceof NoSuchDirectoryError) throw invalidParams(`no such directory: ${expanded}`)
      throw invalidParams(`not a git repository: ${expanded}`)
    }
    const existing = this.options.store.getRepoByPath(root)
    if (existing) return existing
    const repo: Repo = { id: `repo_${randomId()}`, name: basename(root), path: root, addedAt: Date.now() }
    this.options.store.insertRepo(repo)
    this.broadcast({ type: 'repo.changed' })
    return repo
  }

  /**
   * Forgets a repo and closes every session that belongs to it. Ownership is recorded data: the
   * repo id stored with each session, and for rows that predate it the worktree ids recorded
   * whenever worktrees were listed or created. If any close fails the repo stays, so removal can
   * be retried.
   */
  async removeRepo(repoId: string): Promise<void> {
    const repo = this.requireRepo(repoId)
    await this.repoWorktrees(repo).catch(() => [])
    const owned = this.options.store.listSessionsForRepo(repo.id, [worktreeIdForPath(repo.path)])
    for (const session of owned) await this.closeSession(session.id)
    this.options.store.deleteRepo(repoId)
    this.broadcast({ type: 'repo.changed' })
  }

  async listWorktrees(repoId?: string): Promise<Worktree[]> {
    const repos = repoId ? [this.requireRepo(repoId)] : this.options.store.listRepos()
    const lists = await Promise.all(
      repos.map(async (repo) => {
        try {
          return await this.repoWorktrees(repo)
        } catch (error) {
          if (repoId) throw internal(gitMessage(error))
          return []
        }
      })
    )
    return lists.flat()
  }

  async createWorktree(repoId: string, name: string, baseRef?: string): Promise<Worktree> {
    const repo = this.requireRepo(repoId)
    if (!WORKTREE_NAME.test(name) || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.includes('..')) {
      throw invalidParams(
        'name may contain letters, digits, - _ . and /, cannot start with - or /, and cannot contain ..'
      )
    }
    const root = resolveRealPath(this.getSettings().worktreesRoot)
    const path = join(root, this.worktreeDirName(repo), name.replaceAll('/', '-'))
    try {
      await this.options.git.addWorktree(repo.path, path, name, baseRef)
    } catch (error) {
      if (error instanceof BranchCheckedOutError) throw conflict(error.message)
      throw internal(gitMessage(error))
    }
    const created = (await this.repoWorktrees(repo).catch(() => [])).find((w) => w.path === path)
    const worktree: Worktree = created ?? {
      id: worktreeIdForPath(path),
      repoId: repo.id,
      path,
      branch: name,
      head: '',
      isMain: false,
      name
    }
    this.options.store.recordWorktrees(repo.id, [worktree.id])
    this.broadcast({ type: 'worktree.changed', repoId: repo.id })
    return worktree
  }

  /**
   * Removes a worktree. Without `force`, git decides first and a refusal (dirty or untracked
   * files) is a Conflict that leaves the worktree's sessions running; with `force` the sessions
   * are closed before the forced removal.
   */
  async removeWorktree(worktreeId: string, force: boolean): Promise<void> {
    const { repo, worktree } = await this.requireWorktree(worktreeId)
    if (worktree.isMain) throw conflict('the main worktree cannot be removed')
    if (force) await this.closeWorktreeSessions(worktreeId)
    try {
      await this.options.git.removeWorktree(repo.path, worktree.path, force)
    } catch (error) {
      if (error instanceof GitError && error.exitCode > 0) {
        throw conflict(`could not remove ${worktree.name}: ${gitMessage(error)}`)
      }
      throw internal(gitMessage(error))
    }
    if (!force) await this.closeWorktreeSessions(worktreeId)
    this.broadcast({ type: 'worktree.changed', repoId: repo.id })
  }

  listSessions(worktreeId?: string): Session[] {
    return this.options.store.listSessions(worktreeId)
  }

  async createSession(params: {
    worktreeId: string
    agent: AgentKind
    prompt?: string
    cols?: number
    rows?: number
  }): Promise<Session> {
    const { repo, worktree } = await this.requireWorktree(params.worktreeId)
    const { home, store, pty } = this.options
    installIntegrationFiles(home, this.options.cliEntry)
    const now = Date.now()
    const session: Session = {
      id: `s_${randomId()}`,
      kind: 'terminal',
      agent: params.agent,
      worktreeId: worktree.id,
      cwd: worktree.path,
      title: this.sessionTitle(worktree.id, AGENT_TITLES[params.agent]),
      status: 'starting',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null
    }
    store.insertSession(session, repo.id)
    const closedWhileStarting = () =>
      conflict(`session ${session.id} was closed before its terminal started`)
    try {
      const additions = (await this.options.prepareLaunch?.({
        sessionId: session.id,
        worktreeId: worktree.id,
        repoId: repo.id,
        cwd: worktree.path,
        agent: params.agent,
        ...(params.prompt === undefined ? {} : { prompt: params.prompt })
      })) ?? { env: {}, args: [] }
      if (!store.getSession(session.id)) throw closedWhileStarting()
      await pty.request('create', {
        sessionId: session.id,
        cwd: worktree.path,
        argv: buildArgv({
          agent: params.agent,
          prompt: params.prompt,
          home,
          shell: this.options.shell,
          extraArgs: additions.args
        }),
        env: buildSessionEnv({
          home,
          sessionId: session.id,
          worktreeId: worktree.id,
          hookUrl: this.options.hookUrl(),
          hookToken: this.options.hookToken,
          shell: this.options.shell,
          agent: params.agent,
          envPatch: additions.env
        }),
        cols: params.cols ?? 80,
        rows: params.rows ?? 24
      })
      if (!store.getSession(session.id)) {
        await pty.request('forget', { sessionId: session.id }).catch(() => {})
        throw closedWhileStarting()
      }
    } catch (error) {
      store.deleteSession(session.id)
      if (error instanceof DaemonError) throw error
      throw internal(`could not start ${params.agent}: ${(error as Error).message}`)
    }
    const running = store.updateSession(session.id, { status: 'running' }) as Session
    this.broadcast({ type: 'session.changed', session: running })
    return running
  }

  async createStructuredSession(params: { worktreeId: string; agent: AgentKind; prompt: string }): Promise<Session> {
    if (params.agent !== 'claude') throw invalidParams('structured sessions support only the claude agent')
    const { repo, worktree } = await this.requireWorktree(params.worktreeId)
    const now = Date.now()
    const session: Session = {
      id: `s_${randomId()}`,
      kind: 'structured',
      agent: 'claude',
      worktreeId: worktree.id,
      cwd: worktree.path,
      title: this.sessionTitle(worktree.id, AGENT_TITLES.claude),
      status: 'starting',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null
    }
    this.options.store.insertSession(session, repo.id)
    this.broadcast({ type: 'session.changed', session })
    this.runner.start(session, params.prompt).catch((error: Error) => {
      this.appendStructuredMessage({ sessionId: session.id, role: 'system', text: `could not start: ${error.message}` })
      this.finishSession(session.id, null)
    })
    return session
  }

  /**
   * Stops a session and deletes its record. A terminal session is only deleted once the PTY host
   * has forgotten it or reports it unknown; any other failure leaves the record and streams intact
   * and surfaces as an internal error, since the process may still be running.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.kind === 'structured') {
      await this.runner.stop(sessionId).catch(() => {})
    } else {
      try {
        await this.options.pty.request('forget', { sessionId })
      } catch (error) {
        if (!isUnknownSessionError(error)) {
          throw internal(`could not close session ${sessionId}: ${(error as Error).message}`)
        }
      }
    }
    const streams = this.streamsBySession.get(sessionId)
    for (const stream of streams ?? []) stream.conn.streams.delete(stream.streamId)
    this.streamsBySession.delete(sessionId)
    this.receivedOffsets.delete(sessionId)
    this.options.store.deleteSession(sessionId)
    this.broadcast({ type: 'session.removed', sessionId })
  }

  async attach(
    conn: ClientConn,
    params: { sessionId: string; cols: number; rows: number }
  ): Promise<{ streamId: number; replay: string; offset: number }> {
    const session = this.requireTerminalSession(params.sessionId)
    const { pty } = this.options
    const streamId = conn.nextStreamId++
    this.attachesInFlight.set(session.id, (this.attachesInFlight.get(session.id) ?? 0) + 1)
    try {
      await pty.request('resize', { sessionId: session.id, cols: params.cols, rows: params.rows }).catch(() => {})
      const result = await pty.request(
        'subscribe',
        { sessionId: session.id },
        {
          onResult: (response) => {
            this.receivedOffsets.set(session.id, response.offset)
            if (conn.closed) return
            conn.streams.set(streamId, session.id)
            const set = this.streamsBySession.get(session.id) ?? new Set()
            set.add({ conn, streamId })
            this.streamsBySession.set(session.id, set)
          }
        }
      )
      return { streamId, replay: result.replay, offset: result.offset }
    } catch (error) {
      throw internal((error as Error).message)
    } finally {
      const left = (this.attachesInFlight.get(session.id) ?? 1) - 1
      if (left > 0) this.attachesInFlight.set(session.id, left)
      else this.attachesInFlight.delete(session.id)
      if (conn.closed) this.removeStream(conn, streamId)
      else if (!conn.streams.has(streamId)) this.releaseSessionIfIdle(session.id)
    }
  }

  detach(conn: ClientConn, streamId: number): void {
    if (!conn.streams.has(streamId)) throw notFound(`no such stream: ${streamId}`)
    this.removeStream(conn, streamId)
  }

  writeTerminal(sessionId: string, data: string): void {
    this.requireTerminalSession(sessionId)
    this.sendInput(sessionId, new TextEncoder().encode(data))
  }

  async resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    this.requireTerminalSession(sessionId)
    await this.options.pty.request('resize', { sessionId, cols, rows }).catch((error) => {
      throw internal((error as Error).message)
    })
  }

  async sendToTerminal(sessionId: string, text: string, enter: boolean): Promise<void> {
    const session = this.requireTerminalSession(sessionId)
    if (session.agent === 'shell') {
      this.sendInput(sessionId, new TextEncoder().encode(enter ? `${text}\r` : text))
      return
    }
    this.sendInput(sessionId, new TextEncoder().encode(`\x1b[200~${text}\x1b[201~`))
    if (!enter) return
    await Bun.sleep(this.options.enterDelayMs)
    this.sendInput(sessionId, new TextEncoder().encode('\r'))
  }

  async readTerminal(sessionId: string, lines: number) {
    this.requireTerminalSession(sessionId)
    try {
      return await this.options.pty.request('read', { sessionId, lines })
    } catch (error) {
      throw internal((error as Error).message)
    }
  }

  async gitStatus(worktreeId: string) {
    return this.git(worktreeId, (git, path) => git.status(path))
  }

  async gitDiff(worktreeId: string, path: string, staged: boolean) {
    return this.git(worktreeId, (git, cwd) => git.diff(cwd, path, staged))
  }

  async gitStage(worktreeId: string, paths: string[]) {
    await this.git(worktreeId, (git, cwd) => git.stage(cwd, paths))
    this.broadcast({ type: 'git.changed', worktreeId })
  }

  async gitUnstage(worktreeId: string, paths: string[]) {
    await this.git(worktreeId, (git, cwd) => git.unstage(cwd, paths))
    this.broadcast({ type: 'git.changed', worktreeId })
  }

  async gitCommit(worktreeId: string, message: string): Promise<{ sha: string }> {
    const sha = await this.git(worktreeId, (git, cwd) => git.commit(cwd, message))
    this.broadcast({ type: 'git.changed', worktreeId })
    return { sha }
  }

  structuredMessages(sessionId: string, afterSeq?: number) {
    this.requireStructuredSession(sessionId)
    return this.options.store.listMessages(sessionId, afterSeq ?? 0)
  }

  async sendStructured(sessionId: string, text: string): Promise<void> {
    this.requireStructuredSession(sessionId)
    try {
      await this.runner.send(sessionId, text)
    } catch (error) {
      throw internal((error as Error).message)
    }
  }

  /**
   * Applies an agent hook to a session's status. Returns false when the session is unknown;
   * hooks for exited sessions or payloads without a status meaning are ignored.
   */
  async handleHook(agent: string, sessionId: string, payload: unknown): Promise<boolean> {
    const session = this.options.store.getSession(sessionId)
    if (!session) return false
    if (session.status === 'exited' || session.kind !== 'terminal') return true
    if (session.status === 'done' && isClaudeIdleNotification(agent, payload)) return true
    const status = statusForHook(agent, payload)
    if (status) await this.setSessionStatus(sessionId, status)
    return true
  }

  /** Marks stored sessions the PTY host no longer has (or reports dead) as exited. */
  async reconcile(options: { startup: boolean }): Promise<void> {
    const { store, pty } = this.options
    const live = new Map((await pty.request('list', {})).map((info) => [info.sessionId, info]))
    for (const session of store.listSessions()) {
      if (session.status === 'exited') continue
      if (session.kind === 'structured') {
        if (options.startup) this.finishSession(session.id, null)
        continue
      }
      const info = live.get(session.id)
      if (!info) this.finishSession(session.id, null)
      else if (!info.alive) this.finishSession(session.id, info.exitCode)
    }
  }

  private async git<T>(worktreeId: string, run: (git: GitApi, path: string) => Promise<T>): Promise<T> {
    const { worktree } = await this.requireWorktree(worktreeId)
    try {
      return await run(this.options.git, worktree.path)
    } catch (error) {
      throw internal(gitMessage(error))
    }
  }

  private sessionTitle(worktreeId: string, base: string): string {
    const taken = new Set(this.options.store.listSessions(worktreeId).map((session) => session.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? base : `${base} ${n}`
      if (!taken.has(title)) return title
    }
  }

  private async closeWorktreeSessions(worktreeId: string): Promise<void> {
    for (const session of this.options.store.listSessions(worktreeId)) await this.closeSession(session.id)
  }

  private async setSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const { store } = this.options
    const before = store.getSession(sessionId)
    if (!before) return
    const updated = store.updateSession(sessionId, { status, lastActivityAt: Date.now() }) as Session
    if (before.status === status) return
    this.broadcast({ type: 'session.changed', session: updated })
    if (status !== 'done' && status !== 'waiting') return
    const worktree = await this.findWorktree(updated.worktreeId)
    const title = worktree?.worktree.name ?? updated.title
    const body = status === 'done' ? `${updated.title} finished` : `${updated.title} needs input`
    this.notify(title, body, { sessionId, worktreeId: updated.worktreeId })
  }

  private finishSession(sessionId: string, exitCode: number | null): void {
    const session = this.options.store.getSession(sessionId)
    if (!session || session.status === 'exited') return
    const updated = this.options.store.updateSession(sessionId, {
      status: 'exited',
      exitCode,
      lastActivityAt: Date.now()
    }) as Session
    this.broadcast({ type: 'session.changed', session: updated })
  }

  private notify(title: string, body: string, ids: { sessionId?: string; worktreeId?: string }): void {
    this.broadcast({ type: 'notify', title, body, ...ids })
    const hasDesktop = [...this.clients].some((conn) => conn.role === 'desktop')
    if (!hasDesktop && this.getSettings().notifications) {
      try {
        this.options.notifier(title, body)
      } catch {
        return
      }
    }
  }

  private appendStructuredMessage(msg: NewStructuredMessage) {
    const message = this.options.store.appendMessage({ ...msg, at: msg.at ?? Date.now() })
    this.broadcast({ type: 'structured.message', message })
    return message
  }

  private handlePtyData(sessionId: string, bytes: Uint8Array): void {
    const streams = this.streamsBySession.get(sessionId)
    if (!streams || streams.size === 0) return
    this.receivedOffsets.set(sessionId, (this.receivedOffsets.get(sessionId) ?? 0) + bytes.length)
    const frame = (streamId: number) => encodeTerminalOutput(streamId, bytes)
    for (const stream of streams) stream.conn.sendBinary(frame(stream.streamId))
  }

  private handlePtyExit(sessionId: string, exitCode: number | null): void {
    this.finishSession(sessionId, exitCode)
  }

  private async handlePtyReconnect(): Promise<void> {
    await this.reconcile({ startup: false }).catch(() => {})
    for (const [sessionId, streams] of this.streamsBySession) {
      if (streams.size === 0) continue
      const had = this.receivedOffsets.get(sessionId) ?? 0
      await this.options.pty
        .request(
          'subscribe',
          { sessionId },
          {
            onResult: (response) => {
              const missed = response.offset - had
              this.receivedOffsets.set(sessionId, response.offset)
              if (missed <= 0) return
              const replay = base64ToBytes(response.replay)
              if (missed > replay.length) return
              const tail = replay.subarray(replay.length - missed)
              for (const stream of streams) stream.conn.sendBinary(encodeTerminalOutput(stream.streamId, tail))
            }
          }
        )
        .catch(() => {})
    }
  }

  private sendInput(sessionId: string, bytes: Uint8Array): void {
    try {
      this.options.pty.sendData(sessionId, bytes)
    } catch (error) {
      throw internal((error as Error).message)
    }
  }

  private removeStream(conn: ClientConn, streamId: number): void {
    const sessionId = conn.streams.get(streamId)
    conn.streams.delete(streamId)
    if (sessionId === undefined) return
    const set = this.streamsBySession.get(sessionId)
    if (set) {
      for (const stream of set) {
        if (stream.conn === conn && stream.streamId === streamId) set.delete(stream)
      }
    }
    this.releaseSessionIfIdle(sessionId)
  }

  private releaseSessionIfIdle(sessionId: string): void {
    const set = this.streamsBySession.get(sessionId)
    if (set && set.size > 0) return
    if ((this.attachesInFlight.get(sessionId) ?? 0) > 0) return
    this.streamsBySession.delete(sessionId)
    this.receivedOffsets.delete(sessionId)
    if (this.options.store.getSession(sessionId)) {
      this.options.pty.request('unsubscribe', { sessionId }).catch(() => {})
    }
  }

  private requireRepo(repoId: string): Repo {
    const repo = this.options.store.getRepo(repoId)
    if (!repo) throw notFound(`no such repo: ${repoId}`)
    return repo
  }

  private requireSession(sessionId: string): Session {
    const session = this.options.store.getSession(sessionId)
    if (!session) throw notFound(`no such session: ${sessionId}`)
    return session
  }

  private requireTerminalSession(sessionId: string): Session {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'terminal') throw invalidParams(`session ${sessionId} has no terminal`)
    return session
  }

  private requireStructuredSession(sessionId: string): Session {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'structured') throw invalidParams(`session ${sessionId} is not a structured session`)
    return session
  }

  private async repoWorktrees(repo: Repo): Promise<Worktree[]> {
    const infos = await this.options.git.listWorktrees(repo.path)
    const worktrees = infos.map((info) => ({
      id: worktreeIdForPath(info.path),
      repoId: repo.id,
      path: resolveRealPath(info.path),
      branch: info.branch,
      head: info.head,
      isMain: info.isMain,
      name: info.branch ?? basename(info.path)
    }))
    this.options.store.recordWorktrees(
      repo.id,
      worktrees.map((worktree) => worktree.id)
    )
    return worktrees
  }

  /** The directory under the worktrees root for a repo's worktrees; unique even for repos sharing a name. */
  private worktreeDirName(repo: Repo): string {
    const shareName = this.options.store.listRepos().some((other) => other.id !== repo.id && other.name === repo.name)
    return shareName ? `${repo.name}-${repo.id.replace(/^repo_/, '').slice(0, 6)}` : repo.name
  }

  private async findWorktree(worktreeId: string): Promise<{ repo: Repo; worktree: Worktree } | null> {
    for (const repo of this.options.store.listRepos()) {
      const worktree = (await this.repoWorktrees(repo).catch(() => [])).find((w) => w.id === worktreeId)
      if (worktree) return { repo, worktree }
    }
    return null
  }

  private async requireWorktree(worktreeId: string): Promise<{ repo: Repo; worktree: Worktree }> {
    const found = await this.findWorktree(worktreeId)
    if (!found) throw notFound(`no such worktree: ${worktreeId}`)
    return found
  }
}

function gitMessage(error: unknown): string {
  if (error instanceof DaemonError) return error.message
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}
