import { lstatSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute } from 'node:path'
import { RpcErrorCode, type ContributionInfo, type PluginCaller, type PluginContext, type Session, type SessionLaunch } from '@quirky/protocol'
import { decodePublicId, hostedLocal } from './hosts'
import type { DeleteTarget, HostedSession, VaultSession } from './types'
import { WorkerRequestError, type VaultWorkerClient } from './worker-client'

const TRASH_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const file = $.NSURL.fileURLWithPath($(argv[0]));
  const result = Ref();
  const error = Ref();
  const moved = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(file, result, error);
  if (!ObjC.unwrap(moved)) {
    const detail = error[0] ? ObjC.unwrap(error[0].localizedDescription) : 'Foundation refused to move the item to Trash';
    throw new Error(detail);
  }
  return 'trashed';
}`

type AgentInfo = {
  command: string
  args: string
  env: Record<string, string>
  enabled: boolean
  resumable: boolean
  canFork: boolean
}
type ResumePlan = { command: string; env: Record<string, string | null>; record: SessionLaunch }
type ResumeTarget = { worktree: string; group?: string }

export class VaultActions {
  constructor(
    private readonly context: PluginContext,
    private readonly dataDir: string,
    private readonly worker: VaultWorkerClient
  ) {}

  get = async (params: Record<string, unknown>): Promise<HostedSession | null> => {
    const source = decodePublicId(this.requiredId(params))
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId !== 'local') throw this.context.error('conflict', 'remote session inspection is not available through the local vault API')
    const session = await this.request<VaultSession | null>('get', { id: source.sourceId })
    return session ? hostedLocal(session) : null
  }

  firstPrompt = async (params: Record<string, unknown>): Promise<{ prompt: string | null }> => {
    const session = await this.source(this.requiredId(params))
    return { prompt: await this.request<string | null>('firstPrompt', { id: session.id }) }
  }

  subagents = async (params: Record<string, unknown>) => {
    const session = await this.source(this.requiredId(params))
    const children = await this.request<VaultSession[]>('subagents', { id: session.id })
    return children.map(hostedLocal)
  }

  prepareResume = async (params: Record<string, unknown>): Promise<ResumePlan> => {
    const session = await this.resumableSource(params)
    const plan = await this.plan(session, params.fork === true)
    if (!session.cwd) throw this.context.error('conflict', 'source working directory is unavailable')
    return { ...plan, command: this.copyCommand(session.cwd, plan) }
  }

  resume = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session> => {
    const session = await this.resumableSource(params)
    const fork = params.fork === true
    const target = await this.resumeTarget(params, session, caller)
    const plan = await this.plan(session, fork)
    const record = this.recordWithPlannerEnvironment(plan)
    const resumed = (await this.context.call('quirky.session/resumeExternal', {
      agent: session.agent,
      cwd: session.cwd,
      providerSession: { id: session.sessionId, transcriptPath: session.filePath },
      worktree: target.worktree,
      record,
      fork
    })) as Session
    if (target.group !== undefined) {
      try {
        await this.context.call('quirky.terminal/adoptSession', { session: resumed.id, group: target.group })
      } catch (error) {
        throw this.context.error(
          'conflict',
          `session ${resumed.id} started but could not be adopted into group ${target.group}: ${messageOf(error)}`
        )
      }
    }
    return resumed
  }

  deleteSession = async (params: Record<string, unknown>): Promise<{
    deleted: boolean
    trashed: number
    alreadyMissing: boolean
    reason?: string
  }> => {
    const source = decodePublicId(this.requiredId(params))
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId !== 'local') throw this.context.error('conflict', 'only local agent transcripts can be moved to Trash')

    const session = await this.request<VaultSession | null>('get', { id: source.sourceId })
    const targets = await this.request<DeleteTarget[]>('deleteTargets', { id: source.sourceId })
    if (session?.presence === 'unverifiable') {
      return { deleted: false, trashed: 0, alreadyMissing: false, reason: 'source availability could not be verified' }
    }
    if (!session || session.presence === 'missing') {
      for (const target of targets) {
        if (!isAbsolute(target.path)) throw this.context.error('conflict', 'scanner returned a non-absolute Trash target')
        try {
          lstatSync(target.path)
          return { deleted: false, trashed: 0, alreadyMissing: false, reason: 'source path is present but no longer resolves to the selected session' }
        } catch (error) {
          if (!isMissing(error)) return { deleted: false, trashed: 0, alreadyMissing: false, reason: messageOf(error) }
        }
      }
      await this.invalidate(source.sourceId)
      return { deleted: true, trashed: 0, alreadyMissing: true }
    }
    if (targets.length === 0) {
      await this.invalidate(source.sourceId)
      return { deleted: true, trashed: 0, alreadyMissing: true }
    }
    if (process.platform !== 'darwin') {
      return { deleted: false, trashed: 0, alreadyMissing: false, reason: 'OS Trash is supported only on macOS' }
    }

    let trashed = 0
    let alreadyMissing = false
    for (const target of targets) {
      if (!isAbsolute(target.path)) throw this.context.error('conflict', 'scanner returned a non-absolute Trash target')
      let metadata: Stats
      try {
        metadata = lstatSync(target.path)
      } catch (error) {
        if (isMissing(error)) {
          alreadyMissing = true
          continue
        }
        return { deleted: false, trashed, alreadyMissing: false, reason: messageOf(error) }
      }
      if (metadata.isSymbolicLink() || (target.kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
        return { deleted: false, trashed, alreadyMissing: false, reason: 'scanner returned a symlink or wrong-kind Trash target' }
      }
      try {
        await trashWithFoundation(target.path)
        trashed++
      } catch (error) {
        if (trashed > 0 || alreadyMissing) await this.invalidate(source.sourceId)
        return { deleted: false, trashed, alreadyMissing: false, reason: messageOf(error) }
      }
    }
    await this.invalidate(source.sourceId)
    return { deleted: true, trashed, alreadyMissing: trashed === 0 && alreadyMissing }
  }

  openSource = async (params: Record<string, unknown>) => {
    const session = await this.source(this.requiredId(params))
    const mode = params.mode ?? 'open'
    if (mode !== 'view' && mode !== 'open' && mode !== 'reveal') {
      throw this.context.error('invalid-params', 'mode must be view, open or reveal')
    }
    if (!isAbsolute(session.filePath)) throw this.context.error('conflict', 'source path is not absolute')
    try {
      if (!lstatSync(session.filePath).isFile()) throw this.context.error('conflict', 'source file is no longer available')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'source file is no longer available')
      throw error
    }
    return this.openExternal(session.filePath, mode === 'reveal')
  }

  openWorkingDirectory = async (params: Record<string, unknown>) => {
    const session = await this.source(this.requiredId(params))
    if (!session.cwd || !isAbsolute(session.cwd)) throw this.context.error('conflict', 'source working directory is unavailable')
    try {
      if (!statSync(session.cwd).isDirectory()) throw this.context.error('conflict', 'source working directory is unavailable')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'source working directory is unavailable')
      throw error
    }
    return this.openExternal(session.cwd, false)
  }

  jump = async (params: Record<string, unknown>): Promise<{ available: boolean; reason?: string; workspace?: string }> => {
    const source = await this.source(this.requiredId(params))
    const target = params.target
    if (target !== 'pane' && target !== 'worktree' && target !== 'folder') {
      throw this.context.error('invalid-params', 'target must be pane, worktree or folder')
    }
    const sessions = (await this.context.call('quirky.session/list', {})) as Session[]
    const matches = sessions.filter((session) =>
      session.agent === source.agent && session.providerSession?.id === source.sessionId && session.cwd === source.cwd
    )
    if (matches.length !== 1) {
      return { available: false, reason: matches.length === 0 ? 'no live session owns this source identity' : 'source identity matches multiple live sessions' }
    }
    const live = matches[0]!
    if (target !== 'pane') {
      try {
        const owner = (await this.context.call('quirky.worktree/resolve', { selector: `path:${source.cwd}` })) as { id: string }
        if (owner.id !== live.worktreeId) return { available: false, reason: `live session belongs to ${live.worktreeId}, not the source ${target}` }
      } catch (error) {
        return { available: false, reason: `source ${target} identity is unavailable: ${messageOf(error)}` }
      }
    }
    try {
      const focused = (await this.context.call('quirky.terminal/focusPane', { session: live.id })) as { workspace: { id?: string } }
      return { available: true, ...(typeof focused.workspace?.id === 'string' ? { workspace: focused.workspace.id } : {}) }
    } catch (error) {
      return { available: false, reason: `could not focus the live session: ${messageOf(error)}` }
    }
  }

  handoff = async (params: Record<string, unknown>): Promise<{ available: boolean; reason?: string; result?: unknown }> => {
    const source = await this.source(this.requiredId(params))
    let raw: unknown
    try {
      raw = await this.context.call('plugin.contributions', { kind: 'handoff' })
    } catch (error) {
      return { available: false, reason: `handoff is unavailable: ${messageOf(error)}` }
    }
    const owner = Array.isArray(raw)
      ? raw.find((value): value is ContributionInfo => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
          const contribution = value as ContributionInfo
          return contribution.status === 'effective' &&
            contribution.data.supportsArchivedSource === true &&
            typeof contribution.data.method === 'string'
        })
      : undefined
    const method = owner?.data.method
    if (typeof method !== 'string') return { available: false, reason: 'no archived-source handoff owner is installed' }

    try {
      let prompt = source.lastUserPrompt
      let lastMessage: string | undefined
      for (let index = source.previewMessages.length - 1; index >= 0; index--) {
        const message = source.previewMessages[index]!
        if (lastMessage === undefined && message.role === 'assistant') lastMessage = message.text
        if ((prompt === undefined || prompt === '') && message.role === 'user') prompt = message.text
        if (prompt !== undefined && lastMessage !== undefined) break
      }
      const archived = {
        agent: source.agent,
        providerSessionId: source.sessionId,
        transcriptPath: source.filePath,
        title: source.title,
        ...(source.cwd === null ? {} : { cwd: source.cwd }),
        ...(prompt === undefined || prompt === '' ? {} : { prompt }),
        ...(lastMessage === undefined ? {} : { lastMessage })
      }
      const result = await this.context.call(method, { source: { archived } })
      const opened = typeof result === 'object' && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>).opened
        : undefined
      if (opened !== true) return { available: false, reason: 'handoff owner did not open its archived-source dialog' }
      return { available: true, result }
    } catch (error) {
      return { available: false, reason: `handoff is unavailable: ${messageOf(error)}` }
    }
  }

  private requiredId(params: Record<string, unknown>): string {
    if (typeof params.id !== 'string' || params.id === '') throw this.context.error('invalid-params', 'id is required')
    return params.id
  }

  private async source(id: string): Promise<VaultSession> {
    const decoded = decodePublicId(id)
    if (!decoded) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (decoded.hostId !== 'local') throw this.context.error('conflict', 'this action is unavailable for remote sessions')
    const session = await this.request<VaultSession | null>('get', { id: decoded.sourceId })
    if (!session || session.presence !== 'present') throw this.context.error('conflict', 'source is missing or unverifiable')
    if (!isAbsolute(session.filePath)) throw this.context.error('conflict', 'source path is not absolute')
    try {
      const file = lstatSync(session.filePath)
      if (file.isSymbolicLink() || !file.isFile()) throw this.context.error('conflict', 'source file is missing or unverifiable')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'source is missing or unverifiable')
      throw error
    }
    return session
  }

  private async resumableSource(params: Record<string, unknown>): Promise<VaultSession> {
    if (params.fork !== undefined && typeof params.fork !== 'boolean') throw this.context.error('invalid-params', 'fork must be a boolean')
    const session = await this.source(this.requiredId(params))
    const resumableContent = session.messageCount > 0 || session.previewMessages.some((message) => message.role === 'user' || message.role === 'assistant')
    if (!resumableContent) throw this.context.error('conflict', 'source has no resumable conversation content')
    if (!session.cwd || !isAbsolute(session.cwd)) throw this.context.error('conflict', 'source working directory is unavailable')
    try {
      if (!statSync(session.cwd).isDirectory()) throw this.context.error('conflict', 'source working directory is unavailable')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'source working directory is unavailable')
      throw error
    }
    const agent = (await this.context.call('quirky.agents/get', { agent: session.agent })) as AgentInfo
    if (!agent.enabled || !agent.resumable) throw this.context.error('conflict', `${session.agent} cannot resume sessions`)
    if (params.fork === true && !agent.canFork) throw this.context.error('conflict', `${session.agent} cannot fork sessions`)
    return session
  }

  private async plan(session: VaultSession, fork: boolean): Promise<ResumePlan> {
    const agent = (await this.context.call('quirky.agents/get', { agent: session.agent })) as AgentInfo
    if (!agent.enabled) throw this.context.error('conflict', `${session.agent} is disabled`)
    const env = { ...agent.env }
    const hookEnv: Record<string, string> = {}
    if (session.agent === 'codex' && session.codexHome) {
      env.CODEX_HOME = session.codexHome
      hookEnv.CODEX_HOME = session.codexHome
    }
    const record: SessionLaunch = { command: agent.command, args: agent.args, env }
    return (await this.context.call('quirky.agents/prepareResume', {
      agent: session.agent,
      cwd: session.cwd,
      record,
      providerSession: { id: session.sessionId, transcriptPath: session.filePath },
      fork,
      hookArgs: [],
      hookEnv
    })) as ResumePlan
  }
  private copyCommand(cwd: string, plan: ResumePlan): string {
    if (plan.command.trim() === '') throw this.context.error('conflict', 'resume planner returned an empty command')
    const unset: string[] = []
    const assign: string[] = []
    for (const [name, value] of Object.entries(plan.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw this.context.error('conflict', 'resume planner returned an invalid environment name')
      if (value === null) unset.push(name)
      else assign.push(`${name}=${quotePosix(value)}`)
    }
    const steps = [`cd ${quotePosix(cwd)}`]
    if (unset.length > 0) steps.push(`unset ${unset.join(' ')}`)
    steps.push(`${assign.length > 0 ? `${assign.join(' ')} ` : ''}${plan.command}`)
    return steps.join(' && ')
  }

  private recordWithPlannerEnvironment(plan: ResumePlan): SessionLaunch {
    const env = { ...plan.record.env }
    for (const [name, value] of Object.entries(plan.env)) if (value !== null) env[name] = value
    return { command: plan.record.command, args: plan.record.args, env }
  }

  private async resumeTarget(params: Record<string, unknown>, session: VaultSession, caller: PluginCaller): Promise<ResumeTarget> {
    if (params.group !== undefined && typeof params.group !== 'string') throw this.context.error('invalid-params', 'group must be a string')
    if (params.worktree !== undefined && typeof params.worktree !== 'string') throw this.context.error('invalid-params', 'worktree must be a string')
    const group = params.group as string | undefined
    const worktree = params.worktree as string | undefined
    if (group !== undefined) {
      const owner = (await this.context.call('quirky.terminal/groupInfo', { group })) as { workspace: string }
      if (worktree !== undefined && worktree !== owner.workspace) {
        throw this.context.error('conflict', `group ${group} belongs to ${owner.workspace}, not ${worktree}`)
      }
      return { worktree: owner.workspace, group }
    }
    if (worktree !== undefined) return { worktree: await this.resolveWorktree(worktree, caller) }
    try {
      return { worktree: await this.resolveWorktree(`path:${session.cwd}`, caller) }
    } catch (error) {
      if (errorCode(error) === RpcErrorCode.NotFound) return { worktree: 'floating' }
      throw error
    }
  }

  private async resolveWorktree(selector: string, caller: PluginCaller): Promise<string> {
    if (selector === 'floating') return 'floating'
    const worktree = (await this.context.call('quirky.worktree/resolve', {
      selector,
      ...(caller.role === 'plugin' ? {} : {
        ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
        ...(caller.worktreeId === undefined ? {} : { worktreeId: caller.worktreeId })
      })
    })) as { id: string }
    return worktree.id
  }

  private async openExternal(target: string, reveal: boolean) {
    const result = (await this.context.call('quirky.terminal/openExternal', { target, reveal })) as { ok: boolean }
    if (result.ok !== true) throw this.context.error('conflict', 'terminal did not open the selected target')
    return result
  }

  private async invalidate(id: string): Promise<void> {
    await this.request('invalidate', { id })
  }

  private request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    return this.worker.request<T>(op, { dataDir: this.dataDir, ...args }).catch((error: unknown) => {
      if (error instanceof WorkerRequestError) {
        const kind = error.kind === 'invalid-params' || error.kind === 'not-found' || error.kind === 'conflict'
          ? error.kind
          : 'conflict'
        throw this.context.error(kind, error.message)
      }
      throw error
    })
  }
}

async function trashWithFoundation(target: string): Promise<void> {
  const child = Bun.spawn(['/usr/bin/osascript', '-l', 'JavaScript', '-e', TRASH_SCRIPT, target], {
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr.trim() || `macOS Foundation Trash failed with exit ${exitCode}`)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
