import { existsSync } from 'node:fs'
import {
  RpcErrorCode,
  type AgentKind,
  type ExitCause,
  type PluginCaller,
  type PluginContext,
  type PromptDeliveryState,
  type PtySessionInfo,
  type Session,
  type SessionLaunch,
  type SessionProviderSession,
  type SessionStatus,
  type Worktree
} from '@quirky/protocol'
import type { SessionRecords } from './records'

const isNotFound = (error: unknown) => (error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound
const isRpcError = (error: unknown) => typeof (error as { code?: unknown } | null)?.code === 'number'
const isUnknownSession = (error: unknown) => error instanceof Error && /^unknown session\b/.test(error.message)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** How a session ended; `finish` fills in what is left out (no signal, cause `exited`, not restorable). */
export type SessionExit = {
  exitCode: number | null
  exitSignal?: string | null
  exitCause?: ExitCause | null
  restorable?: boolean
}

function exitFields(details: SessionExit) {
  return {
    status: 'exited' as const,
    exitCode: details.exitCode,
    exitSignal: details.exitSignal ?? null,
    exitCause: details.exitCause ?? 'exited',
    restorable: details.restorable ?? false,
    lastActivityAt: Date.now()
  }
}

const MAX_PROVIDER_SESSION_ID = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

/** The rule an agent CLI's session ID breaks, or null when it is fine to store and pass back. */
export function providerSessionIdProblem(id: string): string | null {
  if (id === '') return "provider session id can't be empty"
  if (id.length > MAX_PROVIDER_SESSION_ID) return `provider session id can't be longer than ${MAX_PROVIDER_SESSION_ID} characters`
  if (id.startsWith('-')) return "provider session id can't start with '-'"
  if (CONTROL_CHARACTERS.test(id)) return "provider session id can't contain control characters"
  return null
}

/** What `quirky.agents/prepareLaunch` returns (see plugins/quirky.agents/src/core/types.ts). */
type LaunchPlan = {
  command: string
  env: Record<string, string | null>
  record: SessionLaunch
  promptDelivery: 'command-line' | 'pending' | null
  paste: { text: string; submit: boolean } | null
}

/** What `quirky.agents/get` returns that sessions use. */
type AgentInfo = { label: string; resumable: boolean; canFork: boolean }

/** How a spawned process is started: the shell, or a command from `quirky.agents`. */
type LaunchSpec = {
  argv: string[]
  envPatch: Record<string, string | null>
  launch: SessionLaunch | null
  promptDelivery: PromptDeliveryState | null
  paste: LaunchPlan['paste']
  providerSession: SessionProviderSession | null
}

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

  private readonly restoring = new Map<string, Promise<Session>>()
  /** Exit details that arrived while a restore was spawning; a key is present for the whole spawn. */
  private readonly restoreExits = new Map<string, SessionExit | null>()

  list = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session[]> => {
    if (params.worktree === undefined) return this.records.list()
    return this.records.list(await this.worktreeIdFor(params.worktree as string, caller))
  }

  get = (params: Record<string, unknown>): Session => this.require(params.session as string)

  /**
   * Starts a terminal session. The record exists (as `starting`) while launch hooks run, so a
   * close during that window wins: the terminal is never spawned and the call fails. A process
   * that exits before the spawn call returns leaves the session exited, not running. A prompt
   * the agent takes by paste is delivered after the call returns, unless `waitForPrompt` is set.
   */
  create = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const worktree = await this.resolveWorktree(params.worktree, caller)
    const agent = (params.agent as string | undefined) ?? (await this.pickAgent())
    const prompt = params.prompt as string | undefined
    const submitPrompt = (params.submitPrompt as boolean | undefined) ?? true
    const title = agent === 'shell' ? 'Shell' : (await this.agentInfo(agent)).label
    const session = this.newRecord(worktree, 'terminal', agent, title)
    const launched = await this.start(session, worktree.repoId, params, prompt, async (additions) => {
      if (agent === 'shell') {
        return {
          argv: this.context.launch.shellArgv(),
          envPatch: additions.env,
          launch: null,
          promptDelivery: null,
          paste: null,
          providerSession: null
        }
      }
      const plan = (await this.context.call('quirky.agents/prepareLaunch', {
        agent,
        cwd: worktree.path,
        ...(prompt === undefined ? {} : { prompt }),
        submitPrompt,
        hookArgs: additions.args,
        hookEnv: additions.env
      })) as LaunchPlan
      return {
        argv: this.context.launch.commandArgv(plan.command),
        envPatch: plan.env,
        launch: plan.record,
        promptDelivery: plan.promptDelivery,
        paste: plan.paste,
        providerSession: null
      }
    })
    return this.deliverAfterLaunch(launched, params.waitForPrompt === true)
  }

  /**
   * Starts a new terminal session that resumes an agent session in the old session's folder,
   * replaying the old launch record. The old record is untouched.
   */
  resume = async (params: Record<string, unknown>): Promise<Session> => {
    const old = this.require(params.session as string)
    if (old.kind !== 'terminal') throw this.context.error('conflict', `session ${old.id} is not a terminal session`)
    if (old.agent === 'shell') throw this.context.error('conflict', `session ${old.id} is a shell, not an agent`)
    const info = await this.agentInfo(old.agent)
    if (!info.resumable) throw this.context.error('conflict', `${old.agent} can't resume sessions`)
    const fork = params.fork === true
    if (fork && !info.canFork) throw this.context.error('conflict', `${old.agent} can't fork from Quirky yet`)
    const given = params.providerSession as string | undefined
    const id = given ?? old.providerSession?.id
    if (id === undefined) {
      throw this.context.error('conflict', `session ${old.id} has no provider session; pass --provider-session`)
    }
    if (!existsSync(old.cwd)) throw this.context.error('conflict', `the session's folder ${old.cwd} no longer exists`)
    const problem = providerSessionIdProblem(id)
    if (problem) throw this.context.error('invalid-params', problem)
    const transcriptPath =
      (params.transcriptPath as string | undefined) ?? (given === undefined ? (old.providerSession?.transcriptPath ?? null) : null)
    const providerSession = { id, transcriptPath }

    const session = {
      ...this.newRecord({ id: old.worktreeId, path: old.cwd }, 'terminal', old.agent, info.label),
      resumedFrom: old.id
    }
    const launched = await this.start(session, this.records.repoIdOf(old.id), params, undefined, async (additions) => {
      const resumed = (await this.context.call('quirky.agents/prepareResume', {
        agent: old.agent,
        cwd: old.cwd,
        record: old.launch ?? null,
        providerSession,
        fork,
        hookArgs: additions.args,
        hookEnv: additions.env
      })) as { command: string; env: Record<string, string | null>; record: SessionLaunch }
      return {
        argv: this.context.launch.commandArgv(resumed.command),
        envPatch: resumed.env,
        launch: resumed.record,
        promptDelivery: null,
        paste: null,
        providerSession: fork ? null : providerSession
      }
    })
    return this.deliverAfterLaunch(launched, false)
  }

  /** Stores the agent CLI's own session ID (and transcript path) so a later resume can pass it back. */
  setProviderSession = (params: Record<string, unknown>): Session => {
    const session = this.require(params.session as string)
    const id = params.id as string
    const problem = providerSessionIdProblem(id)
    if (problem) throw this.context.error('invalid-params', problem)
    const updated = this.records.update(session.id, {
      providerSession: { id, transcriptPath: (params.transcriptPath as string | undefined) ?? null }
    }) as Session
    return this.publish(updated)
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
    if (status === 'exited') return this.finish(before.id, { exitCode: (params.exitCode as number | undefined) ?? null }) ?? before
    const updated = this.records.update(before.id, {
      status,
      lastActivityAt: Date.now(),
      ...(params.exitCode === undefined ? {} : { exitCode: params.exitCode as number })
    }) as Session
    if (before.status !== status) this.context.emit('changed', { session: updated })
    return updated
  }

  /**
   * Marks a live session exited; null for one that is unknown or already exited. An exit that
   * arrives while the session's restore is spawning is held and applied when the spawn returns.
   */
  finish(sessionId: string, exit: SessionExit | number | null): Session | null {
    const session = this.records.get(sessionId)
    if (!session) return null
    const details = typeof exit === 'object' && exit !== null ? exit : { exitCode: exit }
    if (session.status === 'exited') {
      if (this.restoreExits.get(sessionId) === null) this.restoreExits.set(sessionId, details)
      return null
    }
    return this.publish(this.records.update(sessionId, exitFields(details)) as Session)
  }

  /**
   * Brings the records in line with the PTY host's listing. A session the host lost or stored is
   * exited, and restorable when the host still holds its history. At startup a structured session
   * has no runner left, so it is finished too.
   */
  async reconcile(options: { startup: boolean }): Promise<void> {
    if (options.startup) {
      for (const id of this.records.sweepPendingDeliveries()) this.publish(this.require(id))
      for (const session of this.records.list()) if (session.kind === 'structured') this.finish(session.id, { exitCode: null })
    }
    let live: Map<string, PtySessionInfo>
    try {
      live = new Map((await this.context.pty.list()).map((info) => [info.sessionId, info]))
    } catch (error) {
      this.context.log(`could not list PTY sessions: ${messageOf(error)}`)
      return
    }
    for (const session of this.records.list()) {
      if (session.kind !== 'terminal') continue
      const info = live.get(session.id)
      if (session.status === 'exited') {
        // the exit event was lost while the host restarted
        if (info?.state === 'restorable' && info.exitCause === 'host-restart' && !session.restorable) {
          this.publish(this.records.update(session.id, { exitCause: 'host-restart', restorable: true }) as Session)
        }
        continue
      }
      if (!info) this.finish(session.id, { exitCode: null, exitCause: 'host-lost' })
      else if (info.state === 'exited') {
        this.finish(session.id, { exitCode: info.exitCode, exitSignal: info.exitSignal, exitCause: info.exitCause })
      } else if (info.state === 'restorable') {
        this.finish(session.id, { exitCode: null, exitCause: info.exitCause, restorable: true })
      }
    }
  }

  /**
   * Starts a shell in a session that ended with the PTY host and still has its history stored. The
   * session keeps its ID and becomes a `shell`. A running session is returned as it is; one that
   * ended on its own or was killed is a conflict. Concurrent calls for one session share one spawn.
   */
  restore = async (params: Record<string, unknown>): Promise<Session> => {
    const session = this.require(params.session as string)
    if (session.status !== 'exited') return session
    if (!session.restorable) {
      const why = session.exitCause === 'killed' ? 'was killed' : 'ended normally'
      throw this.context.error('conflict', `session ${session.id} ${why} and can't be restored`)
    }
    const pending = this.restoring.get(session.id)
    if (pending) return pending
    const restoring = this.startRestore(session).finally(() => this.restoring.delete(session.id))
    this.restoring.set(session.id, restoring)
    return restoring
  }

  private async startRestore(session: Session): Promise<Session> {
    this.restoreExits.set(session.id, null)
    try {
      const additions = await this.context.launch.hooks({
        sessionId: session.id,
        worktreeId: session.worktreeId,
        repoId: this.records.repoIdOf(session.id) ?? '',
        cwd: session.cwd,
        agent: 'shell'
      })
      await this.context.pty.spawn(session.id, {
        argv: this.context.launch.shellArgv(),
        cwd: session.cwd,
        env: this.context.launch.env({
          sessionId: session.id,
          worktreeId: session.worktreeId,
          agent: 'shell',
          envPatch: additions.env as Record<string, string>
        }),
        cols: 80,
        rows: 24,
        shellReady: this.context.launch.shellReady(),
        restore: true
      })
      const earlyExit = this.restoreExits.get(session.id)
      const restored = this.records.update(
        session.id,
        earlyExit
          ? { ...exitFields(earlyExit), agent: 'shell', launch: null }
          : {
              status: 'running',
              agent: 'shell',
              launch: null,
              exitCode: null,
              exitSignal: null,
              exitCause: null,
              restorable: false,
              lastActivityAt: Date.now()
            }
      )
      if (!restored) {
        await this.context.pty.forget(session.id).catch(() => {})
        throw this.context.error('conflict', `session ${session.id} was closed while it was restoring`)
      }
      return this.publish(restored)
    } finally {
      this.restoreExits.delete(session.id)
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

  private newRecord(target: { id: string; path: string }, kind: Session['kind'], agent: AgentKind, baseTitle: string): Session {
    const now = Date.now()
    return {
      id: `s_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      kind,
      agent,
      worktreeId: target.id,
      cwd: target.path,
      title: this.titleFor(target.id, baseTitle),
      status: 'starting',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false,
      launch: null,
      providerSession: null,
      promptDelivery: null,
      resumedFrom: null
    }
  }

  private titleFor(worktreeId: string, base: string): string {
    const taken = new Set(this.records.list(worktreeId).map((session) => session.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? base : `${base} ${n}`
      if (!taken.has(title)) return title
    }
  }

  private async pickAgent(): Promise<string> {
    return ((await this.context.call('quirky.agents/pick', {})) as { agent: string }).agent
  }

  private async agentInfo(agent: string): Promise<AgentInfo> {
    return (await this.context.call('quirky.agents/get', { agent })) as AgentInfo
  }

  /**
   * Inserts `session` as `starting`, runs the launch hooks, builds the launch with `build`, spawns
   * it and records what it launched with. Any failure removes the record again.
   */
  private async start(
    session: Session,
    repoId: string | null,
    params: Record<string, unknown>,
    prompt: string | undefined,
    build: (additions: { env: Record<string, string | null>; args: string[] }) => Promise<LaunchSpec>
  ): Promise<{ session: Session; paste: LaunchSpec['paste'] }> {
    this.records.insert(session, repoId)
    const closedWhileStarting = () =>
      this.context.error('conflict', `session ${session.id} was closed before its terminal started`)
    let spec!: LaunchSpec
    try {
      const additions = await this.context.launch.hooks({
        sessionId: session.id,
        worktreeId: session.worktreeId,
        repoId: repoId ?? '',
        cwd: session.cwd,
        agent: session.agent,
        ...(prompt === undefined ? {} : { prompt })
      })
      if (!this.records.get(session.id)) throw closedWhileStarting()
      spec = await build(additions)
      if (!this.records.get(session.id)) throw closedWhileStarting()
      await this.context.pty.spawn(session.id, {
        argv: spec.argv,
        cwd: session.cwd,
        // a null in the patch removes the name; launch.env applies it though its type says string
        env: this.context.launch.env({
          sessionId: session.id,
          worktreeId: session.worktreeId,
          agent: session.agent,
          envPatch: spec.envPatch as Record<string, string>
        }),
        cols: (params.cols as number | undefined) ?? 80,
        rows: (params.rows as number | undefined) ?? 24,
        shellReady: session.agent === 'shell' && this.context.launch.shellReady()
      })
      if (!this.records.get(session.id)) {
        await this.context.pty.forget(session.id).catch(() => {})
        throw closedWhileStarting()
      }
    } catch (error) {
      this.records.delete(session.id)
      if (isRpcError(error)) throw error
      throw new Error(`could not start ${session.agent}: ${messageOf(error)}`)
    }
    const current = this.records.get(session.id) as Session
    // a provider session saved during spawn is newer than the one the launch started with
    const keepsSaved = current.providerSession !== null || spec.providerSession === null
    const stored = {
      launch: spec.launch,
      promptDelivery: spec.promptDelivery,
      ...(keepsSaved ? {} : { providerSession: spec.providerSession })
    }
    if (current.status === 'exited') {
      const promptDelivery = spec.promptDelivery === 'pending' ? 'not-delivered' : spec.promptDelivery
      return { session: this.records.update(session.id, { ...stored, promptDelivery }) as Session, paste: null }
    }
    if (current.status !== 'starting') return { session: this.records.update(session.id, stored) as Session, paste: spec.paste }
    const running = this.records.update(session.id, { ...stored, status: 'running' }) as Session
    return { session: this.publish(running), paste: spec.paste }
  }

  /** Starts the paste of a launch's prompt; with `wait`, returns the session once that settles. */
  private async deliverAfterLaunch(launched: { session: Session; paste: LaunchSpec['paste'] }, wait: boolean): Promise<Session> {
    if (!launched.paste) return launched.session
    const settled = this.deliver(launched.session, launched.paste)
    if (!wait) return launched.session
    return (await settled) ?? launched.session
  }

  /** Asks `quirky.agents` to paste the prompt, then records the outcome; never rejects. */
  private async deliver(session: Session, paste: NonNullable<LaunchSpec['paste']>): Promise<Session | null> {
    let outcome: PromptDeliveryState
    try {
      const result = (await this.context.call('quirky.agents/deliver', {
        sessionId: session.id,
        agent: session.agent,
        text: paste.text,
        submit: paste.submit
      })) as { delivery: PromptDeliveryState }
      outcome = result.delivery
    } catch (error) {
      this.context.log(`prompt delivery to ${session.agent} session ${session.id} failed: ${messageOf(error)}`)
      outcome = 'not-delivered'
    }
    if (!this.records.get(session.id)) return null
    return this.publish(this.records.update(session.id, { promptDelivery: outcome }) as Session)
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
