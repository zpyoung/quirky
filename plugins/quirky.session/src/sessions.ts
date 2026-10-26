import {
  RpcErrorCode,
  type AgentKind,
  type PluginCaller,
  type PluginContext,
  type PtySessionInfo,
  type Session,
  type SessionStatus,
  type Worktree
} from '@quirky/protocol'
import { AGENT_TITLES, agentCommand } from './agents'
import type { SessionRecords } from './records'

const isNotFound = (error: unknown) => (error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound
const isRpcError = (error: unknown) => typeof (error as { code?: unknown } | null)?.code === 'number'
const isUnknownSession = (error: unknown) => error instanceof Error && /^unknown session\b/.test(error.message)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The caller's cwd and worktree, which selectors such as `current` resolve against. */
function identityOf(caller: PluginCaller): { cwd?: string; worktreeId?: string } {
  if (caller.role === 'plugin') return {}
  return {
    ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
    ...(caller.worktreeId === undefined ? {} : { worktreeId: caller.worktreeId })
  }
}

/** Session lifecycle: records, launch, close, status and reconciliation with the PTY host. */
export class SessionService {
  constructor(
    private readonly context: PluginContext,
    private readonly records: SessionRecords
  ) {}

  list = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session[]> => {
    if (params.worktree === undefined) return this.records.list()
    return this.records.list(await this.worktreeIdFor(params.worktree as string, caller))
  }

  get = (params: Record<string, unknown>): Session => this.require(params.session as string)

  /**
   * Starts a terminal session. The record exists (as `starting`) while launch hooks run, so a
   * close during that window wins: the terminal is never spawned and the call fails.
   */
  create = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const worktree = await this.resolveWorktree(params.worktree, caller)
    const agent = params.agent as AgentKind
    const prompt = params.prompt as string | undefined
    const session = this.newRecord(worktree, 'terminal', agent, AGENT_TITLES[agent])
    this.records.insert(session, worktree.repoId)
    const closedWhileStarting = () =>
      this.context.error('conflict', `session ${session.id} was closed before its terminal started`)
    try {
      const additions = await this.context.launch.hooks({
        sessionId: session.id,
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        cwd: worktree.path,
        agent,
        ...(prompt === undefined ? {} : { prompt })
      })
      if (!this.records.get(session.id)) throw closedWhileStarting()
      await this.context.pty.spawn(session.id, {
        argv:
          agent === 'shell'
            ? this.context.launch.shellArgv()
            : this.context.launch.commandArgv(agentCommand(agent, prompt, additions.args)),
        cwd: worktree.path,
        // a null in the patch removes the name; launch.env applies it though its type says string
        env: this.context.launch.env({
          sessionId: session.id,
          worktreeId: worktree.id,
          agent,
          envPatch: additions.env as Record<string, string>
        }),
        cols: (params.cols as number | undefined) ?? 80,
        rows: (params.rows as number | undefined) ?? 24
      })
      if (!this.records.get(session.id)) {
        await this.context.pty.forget(session.id).catch(() => {})
        throw closedWhileStarting()
      }
    } catch (error) {
      this.records.delete(session.id)
      if (isRpcError(error)) throw error
      throw new Error(`could not start ${agent}: ${messageOf(error)}`)
    }
    return this.publish(this.records.update(session.id, { status: 'running' }) as Session)
  }

  /** Records a session that runs without a terminal; its owner reports progress through `setStatus`. */
  register = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const worktree = await this.resolveWorktree(params.worktree, caller)
    const session = this.newRecord(worktree, 'structured', params.agent as AgentKind, params.title as string)
    this.records.insert(session, worktree.repoId)
    return this.publish(session)
  }

  /**
   * Stops a session and deletes its record. A terminal session is only deleted once the PTY host
   * has forgotten it or reports it unknown; any other failure leaves the record in place, since
   * the process may still be running.
   */
  close = async (params: Record<string, unknown>): Promise<{ ok: true }> => {
    const session = this.require(params.session as string)
    if (session.kind === 'terminal') {
      try {
        await this.context.pty.forget(session.id)
      } catch (error) {
        if (!isUnknownSession(error)) throw new Error(`could not close session ${session.id}: ${messageOf(error)}`)
      }
    }
    this.records.delete(session.id)
    this.context.emit('removed', { sessionId: session.id })
    return { ok: true }
  }

  setStatus = (params: Record<string, unknown>): Session => {
    const before = this.require(params.session as string)
    const status = params.status as SessionStatus
    if (status === 'exited') return this.finish(before.id, (params.exitCode as number | undefined) ?? null) ?? before
    const updated = this.records.update(before.id, {
      status,
      lastActivityAt: Date.now(),
      ...(params.exitCode === undefined ? {} : { exitCode: params.exitCode as number })
    }) as Session
    if (before.status !== status) this.context.emit('changed', { session: updated })
    return updated
  }

  /** Marks a live session exited; null for one that is unknown or already exited. */
  finish(sessionId: string, exitCode: number | null): Session | null {
    const session = this.records.get(sessionId)
    if (!session || session.status === 'exited') return null
    return this.publish(this.records.update(sessionId, { status: 'exited', exitCode, lastActivityAt: Date.now() }) as Session)
  }

  /**
   * Marks records the PTY host no longer has (or reports dead) as exited. At startup a structured
   * session has no runner left, so it is finished too.
   */
  async reconcile(options: { startup: boolean }): Promise<void> {
    if (options.startup) {
      for (const session of this.records.list()) if (session.kind === 'structured') this.finish(session.id, null)
    }
    let live: Map<string, PtySessionInfo>
    try {
      live = new Map((await this.context.pty.list()).map((info) => [info.sessionId, info]))
    } catch (error) {
      this.context.log(`could not list PTY sessions: ${messageOf(error)}`)
      return
    }
    for (const session of this.records.list()) {
      if (session.kind !== 'terminal' || session.status === 'exited') continue
      const info = live.get(session.id)
      if (!info) this.finish(session.id, null)
      else if (!info.alive) this.finish(session.id, info.exitCode)
    }
  }

  private require(sessionId: string): Session {
    const session = this.records.get(sessionId)
    if (!session) throw this.context.error('not-found', `no such session: ${sessionId}`)
    return session
  }

  private publish(session: Session): Session {
    this.context.emit('changed', { session })
    return session
  }

  private newRecord(worktree: Worktree, kind: Session['kind'], agent: AgentKind, baseTitle: string): Session {
    const now = Date.now()
    return {
      id: `s_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      kind,
      agent,
      worktreeId: worktree.id,
      cwd: worktree.path,
      title: this.titleFor(worktree.id, baseTitle),
      status: 'starting',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null
    }
  }

  private titleFor(worktreeId: string, base: string): string {
    const taken = new Set(this.records.list(worktreeId).map((session) => session.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? base : `${base} ${n}`
      if (!taken.has(title)) return title
    }
  }

  private async resolveWorktree(selector: unknown, caller: PluginCaller): Promise<Worktree> {
    return (await this.context.call('quirky.worktree/resolve', {
      selector: selector ?? 'current',
      ...identityOf(caller)
    })) as Worktree
  }

  /** A listing may name a worktree that git no longer reports, as long as sessions still point at it. */
  private async worktreeIdFor(selector: string, caller: PluginCaller): Promise<string> {
    try {
      return (await this.resolveWorktree(selector, caller)).id
    } catch (error) {
      const id = selector.replace(/^id:/, '')
      if (isNotFound(error) && this.records.hasWorktree(id)) return id
      throw error
    }
  }
}
