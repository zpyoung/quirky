import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  RpcErrorCode,
  type AgentKind,
  type AgentStatusSummary,
  type ExitCause,
  type LaunchSettings,
  type PluginCaller,
  type PluginContext,
  type PromptDeliveryState,
  type PtySessionInfo,
  type Session,
  type SessionLaunch,
  type SessionProviderSession,
  type SessionStatus
} from '@quirky/protocol'
import type { SessionRecords } from './records'

/** The workspace id of the synthetic worktree for sessions that belong to no repository. */
const FLOATING = 'floating'

/** What a session belongs to and starts in: a git worktree, or the synthetic floating one (no repository). */
type SessionTarget = { id: string; name: string; path: string; repoId: string | null }

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
    agentStatus: null,
    exitCode: details.exitCode,
    exitSignal: details.exitSignal ?? null,
    exitCause: details.exitCause ?? 'exited',
    restorable: details.restorable ?? false,
    lastActivityAt: Date.now()
  }
}

const NAME_PATTERN = /^(?!s_)[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_NAME = 64

/** The rule a session name breaks, or null when its lowercase form is a valid name. */
export function nameProblem(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower === '') return "session name can't be empty"
  if (lower.length > MAX_NAME) return `session name can't be longer than ${MAX_NAME} characters`
  if (/[^a-z0-9._-]/.test(lower)) return "session name can only contain letters, digits, '.', '_' and '-'"
  if (!/^[a-z0-9]/.test(lower)) return 'session name must start with a letter or digit'
  if (lower.startsWith('s_')) return "session name can't start with 's_'"
  return NAME_PATTERN.test(lower) ? null : 'session name is not valid'
}

const MAX_PROVIDER_SESSION_ID = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const UNREAD_REASONS = ['agent', 'bell', 'notification']

/** The rule an agent CLI's session ID breaks, or null when it is fine to store and pass back. */
export function providerSessionIdProblem(id: string): string | null {
  if (id === '') return "provider session id can't be empty"
  if (id.length > MAX_PROVIDER_SESSION_ID) return `provider session id can't be longer than ${MAX_PROVIDER_SESSION_ID} characters`
  if (id.startsWith('-')) return "provider session id can't start with '-'"
  if (CONTROL_CHARACTERS.test(id)) return "provider session id can't contain control characters"
  return null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks a caller-supplied `launchSettings` against the `LaunchSettings` shape and returns a copy
 * built from the checked fields; the string is the first thing found wrong.
 */
export function checkLaunchSettings(value: unknown): { settings: LaunchSettings } | string {
  if (!isPlainObject(value)) return 'must be an object'
  const extra = Object.keys(value).find((key) => !['agent', 'options', 'args', 'summary'].includes(key))
  if (extra !== undefined) return `unknown key "${extra}"`
  if (typeof value.agent !== 'string' || value.agent === '') return 'agent must be a non-empty string'
  if (typeof value.summary !== 'string') return 'summary must be a string'
  if (!isPlainObject(value.options)) return 'options must be an object'

  const options: LaunchSettings['options'] = {}
  for (const [key, use] of Object.entries(value.options)) {
    if (!isPlainObject(use)) return `option "${key}" must be an object`
    if (use.source !== 'explicit' && use.source !== 'extra-args') return `option "${key}" source must be 'explicit' or 'extra-args'`
    if (use.value !== undefined && typeof use.value !== 'string' && typeof use.value !== 'boolean') {
      return `option "${key}" value must be a string or boolean`
    }
    Object.defineProperty(options, key, {
      value: { ...(use.value === undefined ? {} : { value: use.value }), source: use.source },
      enumerable: true,
      writable: true,
      configurable: true
    })
  }

  const settings: LaunchSettings = { agent: value.agent, options, summary: value.summary }
  if (value.args !== undefined) {
    const args = value.args
    if (!isPlainObject(args)) return 'args must be an object'
    if (typeof args.value !== 'string') return 'args.value must be a string'
    if (args.source !== 'explicit' && args.source !== 'inherited') return "args.source must be 'explicit' or 'inherited'"
    settings.args = { value: args.value, source: args.source }
  }
  return { settings }
}

/** What `quirky.agents/prepareLaunch` returns (see plugins/quirky.agents/src/core/types.ts). */
type LaunchPlan = {
  command: string
  env: Record<string, string | null>
  record: SessionLaunch
  promptDelivery: 'command-line' | 'pending' | null
  paste: { text: string; submit: boolean } | null
  launchSettings?: LaunchSettings | null
}

/** What `quirky.agents/get` returns that sessions use. */
type AgentInfo = { label: string; resumable: boolean; canFork: boolean }

/** How a spawned process is started: the shell, or a command from `quirky.agents`. */
type LaunchSpec = {
  argv: string[]
  envPatch: Record<string, string | null>
  launch: SessionLaunch | null
  launchSettings: LaunchSettings | null
  promptDelivery: PromptDeliveryState | null
  paste: LaunchPlan['paste']
  providerSession: SessionProviderSession | null
}

/** The launch-time picks a caller gave, with only the ones present. */
function picksOf(params: Record<string, unknown>): { model?: string; options?: Record<string, string | boolean>; extraArgs?: string } {
  return {
    ...(params.model === undefined ? {} : { model: params.model as string }),
    ...(params.options === undefined ? {} : { options: params.options as Record<string, string | boolean> }),
    ...(params.extraArgs === undefined ? {} : { extraArgs: params.extraArgs as string })
  }
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
   * `model`, `options` and `extraArgs` go to `quirky.agents/prepareLaunch`; a shell takes none of them.
   * `cwd` is where the session starts instead of the worktree's path; it must be an existing absolute directory.
   */
  create = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const name = params.name === undefined || params.name === null ? null : this.validName(params.name)
    const cwd = this.startCwd(params.cwd)
    const resolved = await this.resolveWorktree(params.worktree, caller, cwd)
    const worktree = cwd === undefined ? resolved : { ...resolved, path: cwd }
    const agent = (params.agent as string | undefined) ?? (await this.pickAgent())
    const prompt = params.prompt as string | undefined
    const submitPrompt = (params.submitPrompt as boolean | undefined) ?? true
    const picks = picksOf(params)
    if (agent === 'shell' && Object.keys(picks).length > 0) {
      throw this.context.error('invalid-params', 'Agent shell does not support launch-time model selection.')
    }
    const command = params.command as string | undefined
    if (command !== undefined && agent !== 'shell') {
      throw this.context.error('invalid-params', 'command is only allowed with agent shell')
    }
    const title = (params.title as string | undefined) ?? (agent === 'shell' ? 'Shell' : (await this.agentInfo(agent)).label)
    const session = { ...this.newRecord(worktree, 'terminal', agent, title), name }
    const launched = await this.start(session, worktree.repoId, params, prompt, async (additions) => {
      if (agent === 'shell') {
        return {
          argv: command === undefined ? this.context.launch.shellArgv() : this.context.launch.commandArgv(command),
          envPatch: additions.env,
          launch: null,
          launchSettings: null,
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
        ...picks,
        hookArgs: additions.args,
        hookEnv: additions.env
      })) as LaunchPlan
      return {
        argv: this.context.launch.commandArgv(plan.command),
        envPatch: plan.env,
        launch: plan.record,
        launchSettings: plan.launchSettings ?? null,
        promptDelivery: plan.promptDelivery,
        paste: plan.paste,
        providerSession: null
      }
    })
    return this.deliverAfterLaunch(launched, params.waitForPrompt === true)
  }

  /**
   * Starts a new terminal session that resumes an agent session in the old session's folder,
   * replaying the old launch record, whose launch settings carry over. The old record is untouched.
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
      launchSettings: old.launchSettings ?? null,
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
        launchSettings: old.launchSettings ?? null,
        promptDelivery: null,
        paste: null,
        providerSession: fork ? null : providerSession
      }
    })
    return this.deliverAfterLaunch(launched, false)
  }

  /**
   * Gives a session a name, or clears it with null. The name is stored lowercase and is unique among
   * sessions that have not exited: a running holder refuses it with `name-taken`, an exited holder
   * loses it to this session.
   */
  setName = (params: Record<string, unknown>): Session => {
    const session = this.require(params.session as string)
    const name = params.name === null ? null : this.validName(params.name)
    if (name === session.name) return session
    const { updated, released } = this.records.transaction(() => {
      const released = name === null ? [] : this.releaseName(name, session.id)
      return { updated: this.records.update(session.id, { name }) as Session, released }
    })
    released.forEach((holder) => this.publish(holder))
    return this.publish(updated)
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

  /**
   * Records a session that runs without a terminal; its owner reports progress through `setStatus`
   * and may pass the `launchSettings` its launch applied.
   */
  register = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const checked = params.launchSettings === undefined || params.launchSettings === null ? null : checkLaunchSettings(params.launchSettings)
    if (typeof checked === 'string') throw this.context.error('invalid-params', `launchSettings is malformed: ${checked}`)
    const worktree = await this.resolveWorktree(params.worktree, caller)
    const session = {
      ...this.newRecord(worktree, 'structured', params.agent as AgentKind, params.title as string),
      launchSettings: checked?.settings ?? null
    }
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
    const agentStatus = params.agentStatus
    if (agentStatus !== undefined && agentStatus !== null && !isPlainObject(agentStatus)) {
      throw this.context.error('invalid-params', 'agentStatus must be an object or null')
    }
    if (status === 'exited') return this.finish(before.id, { exitCode: (params.exitCode as number | undefined) ?? null }) ?? before
    const updated = this.records.update(before.id, {
      status,
      lastActivityAt: Date.now(),
      ...(params.exitCode === undefined ? {} : { exitCode: params.exitCode as number }),
      ...(agentStatus === undefined ? {} : { agentStatus: agentStatus as AgentStatusSummary | null })
    }) as Session
    const summaryChanged = agentStatus !== undefined && !isDeepStrictEqual(before.agentStatus ?? null, updated.agentStatus ?? null)
    if (before.status !== status || summaryChanged) this.context.emit('changed', { session: updated })
    return updated
  }

  /** Sets or clears a session's unread reason; `changed` goes out only when the stored value differs. */
  setUnread = (params: Record<string, unknown>): Session => {
    const before = this.require(params.session as string)
    const unread = params.unread
    if (unread !== null && !UNREAD_REASONS.includes(unread as never)) {
      throw this.context.error('invalid-params', 'unread must be agent, bell, notification or null')
    }
    if ((before.unread ?? null) === unread) return before
    return this.publish(this.records.update(before.id, { unread: unread as Session['unread'] }) as Session)
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
          ? { ...exitFields(earlyExit), agent: 'shell', launch: null, launchSettings: null }
          : {
              status: 'running',
              agent: 'shell',
              launch: null,
              launchSettings: null,
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

  /** The session stored under `ref` as an ID, else the one that name picks: a running holder, else the newest. */
  private require(ref: string): Session {
    const session = this.records.get(ref) ?? this.byName(ref)
    if (!session) throw this.context.error('not-found', `no such session: ${ref}`)
    return session
  }

  private byName(name: unknown): Session | null {
    if (typeof name !== 'string') return null
    const holders = this.records.byName(name.toLowerCase())
    const running = holders.filter((holder) => holder.status !== 'exited')
    return (running.length > 0 ? running : holders).at(-1) ?? null
  }

  private validName(value: unknown): string {
    if (typeof value !== 'string') throw this.context.error('invalid-params', 'name must be a string')
    const problem = nameProblem(value)
    if (problem) throw this.context.error('invalid-params', problem)
    return value.toLowerCase()
  }

  /**
   * Frees `name` for the session `forId` (null for one not stored yet): refuses when another session
   * that has not exited holds it, otherwise clears it from exited holders and returns them. Call inside
   * a transaction.
   */
  private releaseName(name: string, forId: string | null): Session[] {
    const holders = this.records.byName(name).filter((holder) => holder.id !== forId)
    const running = holders.find((holder) => holder.status !== 'exited')
    if (running) {
      throw Object.assign(this.context.error('conflict', `name ${name} is held by session ${running.id}`), {
        data: { reason: 'name-taken' }
      })
    }
    return holders.map((holder) => this.records.update(holder.id, { name: null }) as Session)
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
      launchSettings: null,
      providerSession: null,
      promptDelivery: null,
      resumedFrom: null,
      agentStatus: null,
      name: null,
      unread: null
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
   * it and records what it launched with. Any failure removes the record again. A name the session
   * carries is taken from exited holders in the insert's own transaction, and given back to them when
   * the launch fails.
   */
  private async start(
    session: Session,
    repoId: string | null,
    params: Record<string, unknown>,
    prompt: string | undefined,
    build: (additions: { env: Record<string, string | null>; args: string[] }) => Promise<LaunchSpec>
  ): Promise<{ session: Session; paste: LaunchSpec['paste'] }> {
    const name = session.name ?? null
    const released = this.records.transaction(() => {
      const holders = name === null ? [] : this.releaseName(name, null)
      this.records.insert(session, repoId)
      return holders
    })
    released.forEach((holder) => this.publish(holder))
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
      const restored = this.records.transaction(() => {
        this.records.delete(session.id)
        return released.flatMap((holder) => this.records.update(holder.id, { name }) ?? [])
      })
      restored.forEach((holder) => this.publish(holder))
      if (isRpcError(error)) throw error
      throw new Error(`could not start ${session.agent}: ${messageOf(error)}`)
    }
    const current = this.records.get(session.id) as Session
    // a provider session saved during spawn is newer than the one the launch started with
    const keepsSaved = current.providerSession !== null || spec.providerSession === null
    const stored = {
      launch: spec.launch,
      launchSettings: spec.launchSettings,
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

  /**
   * The worktree a selector names, or the synthetic floating one for selector `floating` and for
   * `current` (or none) from a floating caller; floating starts in `cwd`, else `$HOME`, and never
   * asks `quirky.worktree`.
   */
  private async resolveWorktree(selector: unknown, caller: PluginCaller, cwd?: string): Promise<SessionTarget> {
    const floatingCaller = identityOf(caller).worktreeId === FLOATING
    if (selector === FLOATING || (floatingCaller && (selector === undefined || selector === 'current'))) {
      return { id: FLOATING, name: 'Floating', path: cwd ?? this.floatingHome(), repoId: null }
    }
    return (await this.context.call('quirky.worktree/resolve', {
      selector: selector ?? 'current',
      ...identityOf(caller)
    })) as SessionTarget
  }

  private floatingHome(): string {
    const home = process.env.HOME
    if (!home) throw this.context.error('invalid-params', 'HOME is not set; pass cwd for a floating session')
    return home
  }

  /** The caller's start folder, or undefined when none was given; anything but an existing absolute directory is refused. */
  private startCwd(value: unknown): string | undefined {
    if (value === undefined) return undefined
    const isDirectory = typeof value === 'string' && isAbsolute(value) && existsSync(value) && statSync(value).isDirectory()
    if (!isDirectory) throw this.context.error('invalid-params', 'cwd must be an existing directory')
    return value
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
