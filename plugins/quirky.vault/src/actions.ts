import { lstatSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute } from 'node:path'
import { RpcErrorCode, type ContributionInfo, type OwnerSessionHostRef, type OwnerSessionWorkspaceRef, type PluginCaller, type PluginContext, type Session, type SessionLaunch } from '@quirky/protocol'
import { callVaultHost, decodePublicId, discoverVaultHosts, hostedLocal, hostedRemote, ownerLocalId, redactReason } from './hosts'
import type { VaultHost } from './hosts'
import type { DeleteTarget, HostedSession, OwnerResumeResult, RemoteResumeResult, VaultSession } from './types'
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

  get = async (params: Record<string, unknown>, caller: PluginCaller): Promise<HostedSession | null> => {
    const source = decodePublicId(this.requiredId(params))
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId === 'local') {
      const session = await this.request<VaultSession | null>('get', { id: source.sourceId })
      return session ? hostedLocal(session) : null
    }
    this.assertOwnerCaller(caller)
    const host = await this.ownerHost(source.hostId)
    const session = await this.ownerSession(host, source.sourceId)
    return session ? hostedRemote(session, host.id) : null
  }

  firstPrompt = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ prompt: string | null }> => {
    const id = this.requiredId(params)
    const source = decodePublicId(id)
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId === 'local') {
      const session = await this.source(id)
      return { prompt: await this.request<string | null>('firstPrompt', { id: session.id }) }
    }
    this.assertOwnerCaller(caller)
    const host = await this.ownerHost(source.hostId)
    const result = await this.ownerCall(host, 'firstPrompt', { id: ownerLocalId(source.sourceId) })
    const response = recordOf(result)
    if (!response || (response.prompt !== null && typeof response.prompt !== 'string')) {
      throw this.context.error('conflict', 'owner Vault returned an invalid first-prompt response')
    }
    return { prompt: response.prompt as string | null }
  }

  subagents = async (params: Record<string, unknown>, caller: PluginCaller): Promise<HostedSession[]> => {
    const id = this.requiredId(params)
    const source = decodePublicId(id)
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId === 'local') {
      const session = await this.source(id)
      const children = await this.request<VaultSession[]>('subagents', { id: session.id })
      return children.map(hostedLocal)
    }
    this.assertOwnerCaller(caller)
    const host = await this.ownerHost(source.hostId)
    const raw = await this.ownerCall(host, 'subagents', { id: ownerLocalId(source.sourceId) })
    if (!Array.isArray(raw)) throw this.context.error('conflict', 'owner Vault returned an invalid subagent list')
    return raw.map((value) => hostedRemote(this.ownerHostedSession(value), host.id))
  }

  prepareResume = async (params: Record<string, unknown>): Promise<ResumePlan> => {
    const session = await this.resumableSource(params)
    const plan = await this.plan(session, params.fork === true)
    if (!session.cwd) throw this.context.error('conflict', 'source working directory is unavailable')
    return { ...plan, command: this.copyCommand(session.cwd, plan) }
  }

  resume = async (params: Record<string, unknown>, caller: PluginCaller): Promise<Session | RemoteResumeResult> => {
    const id = this.requiredId(params)
    const source = decodePublicId(id)
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId !== 'local') {
      this.assertOwnerCaller(caller)
      return this.resumeRemote(params, source.hostId, source.sourceId)
    }
    if (params.remote !== undefined) throw this.context.error('invalid-params', 'remote is only valid for a registered remote source')

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
    return caller.role === 'mobile' ? { ...resumed, launch: undefined } : resumed
  }
  ownerResume = async (params: Record<string, unknown>, caller: PluginCaller): Promise<OwnerResumeResult> => {
    if (caller.role !== 'cli' || typeof caller.ownerGrantId !== 'string' || caller.ownerGrantId === '') {
      throw this.context.error('conflict', 'owner-cli authentication is required')
    }
    if (Object.keys(params).some((key) => !['id', 'worktree', 'expectedInstanceId', 'fork'].includes(key))) {
      throw this.context.error('invalid-params', 'ownerResume accepts only id, worktree, expectedInstanceId and fork')
    }
    const id = this.requiredId(params)
    if (typeof params.worktree !== 'string' || params.worktree === '') throw this.context.error('invalid-params', 'worktree is required')
    if (typeof params.expectedInstanceId !== 'string' || params.expectedInstanceId === '') {
      throw this.context.error('invalid-params', 'expectedInstanceId is required')
    }
    if (params.fork !== undefined && typeof params.fork !== 'boolean') throw this.context.error('invalid-params', 'fork must be a boolean')
    const fork = params.fork === true
    try {
      const session = await this.ownerResumeSource(id, fork)
      const target = await this.ownerWorktree(params.worktree, params.expectedInstanceId)
      const plan = await this.plan({ ...session, cwd: target.path }, fork)
      const record = this.recordWithPlannerEnvironment(plan)
      const currentTarget = await this.ownerWorktree(params.worktree, params.expectedInstanceId)
      if (currentTarget.path !== target.path) throw this.context.error('conflict', 'owner workspace identity changed before resume')
      const resumed = (await this.context.call('quirky.session/resumeExternal', {
        agent: session.agent,
        cwd: currentTarget.path,
        providerSession: { id: session.sessionId, transcriptPath: session.filePath },
        worktree: currentTarget.id,
        record,
        fork
      })) as Session
      return {
        id: resumed.id,
        kind: resumed.kind,
        agent: resumed.agent,
        worktreeId: resumed.worktreeId,
        status: resumed.status,
        createdAt: resumed.createdAt
      }
    } catch (error) {
      const kind = errorCode(error) === RpcErrorCode.NotFound ? 'not-found' : 'conflict'
      throw this.context.error(kind, ownerFailureReason(error))
    }
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

  handoff = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ available: boolean; reason?: string; result?: unknown }> => {
    const id = this.requiredId(params)
    const source = decodePublicId(id)
    if (!source) throw this.context.error('invalid-params', 'id is not a valid vault session ID')
    if (source.hostId === 'local') return this.openHandoff(await this.source(id))

    this.assertOwnerCaller(caller)
    try {
      const host = await this.ownerHost(source.hostId)
      const session = await this.ownerSession(host, source.sourceId)
      if (!session || session.presence !== 'present' || !host.owner) {
        return { available: false, reason: 'remote source is missing or unverifiable' }
      }
      return this.openHandoff(session, {
        owner: host.owner,
        vaultId: ownerLocalId(source.sourceId)
      })
    } catch (error) {
      return { available: false, reason: `handoff is unavailable: ${ownerFailureReason(error)}` }
    }
  }

  private async openHandoff(
    source: VaultSession,
    remote?: { owner: OwnerSessionHostRef; vaultId: string }
  ): Promise<{ available: boolean; reason?: string; result?: unknown }> {
    let raw: unknown
    try {
      raw = await this.context.call('plugin.contributions', { kind: 'handoff' })
    } catch (error) {
      return { available: false, reason: `handoff is unavailable: ${remote ? ownerFailureReason(error) : redactReason(messageOf(error))}` }
    }
    const handoffOwner = Array.isArray(raw)
      ? raw.find((value): value is ContributionInfo => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
          const contribution = value as ContributionInfo
          return contribution.status === 'effective' &&
            contribution.data.supportsArchivedSource === true &&
            typeof contribution.data.method === 'string'
        })
      : undefined
    const method = handoffOwner?.data.method
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
      const archived = remote
        ? {
            agent: source.agent,
            providerSessionId: source.sessionId,
            title: source.title,
            ...(prompt === undefined || prompt === '' ? {} : { prompt }),
            ...(lastMessage === undefined ? {} : { lastMessage }),
            owner: remote.owner,
            vaultId: remote.vaultId
          }
        : {
            agent: source.agent,
            providerSessionId: source.sessionId,
            transcriptPath: source.filePath,
            title: source.title,
            ...(source.cwd === null ? {} : { cwd: source.cwd }),
            ...(prompt === undefined || prompt === '' ? {} : { prompt }),
            ...(lastMessage === undefined ? {} : { lastMessage })
          }
      const result = await this.context.call(method, { source: { archived } })
      const opened = recordOf(result)?.opened
      if (opened !== true) return { available: false, reason: 'handoff owner did not open its archived-source dialog' }
      return { available: true, result }
    } catch (error) {
      return { available: false, reason: `handoff is unavailable: ${remote ? ownerFailureReason(error) : redactReason(messageOf(error))}` }
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

  private async resumeRemote(params: Record<string, unknown>, hostId: string, sourceId: string): Promise<RemoteResumeResult> {
    if (Object.keys(params).some((key) => !['id', 'remote', 'fork'].includes(key))) {
      throw this.context.error('invalid-params', 'remote resume accepts only id, remote and fork')
    }
    if (params.fork !== undefined && typeof params.fork !== 'boolean') throw this.context.error('invalid-params', 'fork must be a boolean')
    const remote = ownerWorkspaceRef(params.remote)
    if (!remote) throw this.context.error('invalid-params', 'remote must be an exact registered workspace reference')
    const host = await this.ownerHost(hostId)
    if (!host.owner || remote.owner.hostId !== hostId || !sameOwnerRef(remote.owner, host.owner)) {
      throw this.context.error('conflict', 'resume workspace must belong to the registered source owner')
    }
    await this.validateWorkspace(host, remote)
    const result = await this.ownerCall(host, 'ownerResume', {
      id: sourceId,
      worktree: remote.worktreeId,
      expectedInstanceId: remote.instanceId,
      ...(params.fork === true ? { fork: true } : {})
    })
    const session = ownerResumeResult(result)
    if (!session) throw this.context.error('conflict', 'owner Vault returned an invalid resume result')
    if (session.worktreeId !== remote.worktreeId) {
      throw this.context.error('conflict', 'owner resumed the source in a different workspace')
    }
    return { ...session, hostId: host.id }
  }

  private async ownerHost(hostId: string): Promise<VaultHost> {
    const registry = await discoverVaultHosts(this.context)
    const host = registry.hosts.find((candidate) => candidate.id === hostId && candidate.owner !== undefined)
    if (!host) throw this.context.error('conflict', 'the selected owner host is no longer registered')
    return host
  }
  private async ownerCall(host: VaultHost, method: 'get' | 'firstPrompt' | 'subagents' | 'ownerResume', params: Record<string, unknown>): Promise<unknown> {
    try {
      return await callVaultHost(this.context, host, method, params)
    } catch (error) {
      const kind = errorCode(error) === RpcErrorCode.NotFound ? 'not-found' : 'conflict'
      throw this.context.error(kind, ownerFailureReason(error))
    }
  }
  private assertOwnerCaller(caller: PluginCaller): void {
    if (caller.role === 'mobile') throw this.context.error('conflict', 'registered owner Vault access is unavailable to mobile callers')
  }

  private async validateWorkspace(host: VaultHost, reference: OwnerSessionWorkspaceRef): Promise<void> {
    let raw: unknown
    try {
      raw = await this.context.call('quirky.worktree/remoteList', { host: host.id })
    } catch {
      throw this.context.error('conflict', 'the selected owner workspace is unavailable')
    }
    const response = recordOf(raw)
    if (!response || !Array.isArray(response.workspaces)) {
      throw this.context.error('conflict', 'the selected owner workspace list is invalid')
    }
    const matches = response.workspaces.filter((value) => recordOf(value)?.id === reference.mirrorId)
    if (matches.length !== 1) throw this.context.error('conflict', 'the selected owner workspace mirror is stale')
    const mirror = recordOf(matches[0])
    const identity = recordOf(mirror?.identity)
    const worktree = recordOf(mirror?.worktree)
    if (
      mirror?.connected !== true ||
      mirror.hostId !== host.id ||
      !host.owner ||
      identity?.hostId !== host.owner.identity.hostId ||
      identity.generation !== host.owner.identity.generation ||
      mirror.fingerprint !== reference.fingerprint ||
      worktree?.id !== reference.worktreeId ||
      worktree.instanceId !== reference.instanceId
    ) {
      throw this.context.error('conflict', 'the selected owner workspace identity changed')
    }
  }

  private async ownerSession(host: VaultHost, sourceId: string): Promise<VaultSession | null> {
    const ownerId = ownerLocalId(sourceId)
    const raw = await this.ownerCall(host, 'get', { id: ownerId })
    return raw === null ? null : this.ownerHostedSession(raw, ownerId, sourceId)
  }

  private ownerHostedSession(value: unknown, expectedId?: string, expectedSourceId?: string): VaultSession {
    const row = recordOf(value)
    const source = recordOf(row?.source)
    const decoded = typeof row?.id === 'string' ? decodePublicId(row.id) : null
    const sourceId = typeof row?.sourceId === 'string' ? row.sourceId : undefined
    const presence = source?.presence
    if (
      !row ||
      !source ||
      row.hostId !== 'local' ||
      !decoded ||
      decoded.hostId !== 'local' ||
      typeof sourceId !== 'string' ||
      decoded.sourceId !== sourceId ||
      (expectedId !== undefined && row.id !== expectedId) ||
      (expectedSourceId !== undefined && sourceId !== expectedSourceId) ||
      (presence !== 'present' && presence !== 'missing' && presence !== 'unverifiable') ||
      row.presence !== presence ||
      typeof row.agent !== 'string' ||
      typeof row.sessionId !== 'string' ||
      typeof row.title !== 'string' ||
      (row.cwd !== null && typeof row.cwd !== 'string') ||
      (row.branch !== null && typeof row.branch !== 'string') ||
      (row.model !== null && typeof row.model !== 'string') ||
      typeof row.createdAt !== 'number' ||
      typeof row.updatedAt !== 'number' ||
      typeof row.modifiedAt !== 'number' ||
      typeof row.messageCount !== 'number' ||
      (row.totalTokens !== null && typeof row.totalTokens !== 'number') ||
      typeof row.queuedMessageCount !== 'number' ||
      typeof row.subagentTranscriptCount !== 'number' ||
      !Array.isArray(row.previewMessages)
    ) {
      throw this.context.error('conflict', 'owner Vault returned invalid source metadata')
    }
    const previewMessages = row.previewMessages.map((value) => {
      const message = recordOf(value)
      if (
        !message ||
        (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool' && message.role !== 'system') ||
        typeof message.text !== 'string' ||
        (message.timestamp !== null && typeof message.timestamp !== 'number')
      ) throw this.context.error('conflict', 'owner Vault returned invalid source messages')
      return { role: message.role, text: message.text, timestamp: message.timestamp } as VaultSession['previewMessages'][number]
    })
    if (source.filePath !== undefined && typeof source.filePath !== 'string') {
      throw this.context.error('conflict', 'owner Vault returned invalid source metadata')
    }
    if (source.codexHome !== undefined && typeof source.codexHome !== 'string') {
      throw this.context.error('conflict', 'owner Vault returned invalid source metadata')
    }
    return {
      id: sourceId,
      agent: row.agent,
      sessionId: row.sessionId,
      title: row.title,
      cwd: row.cwd as string | null,
      branch: row.branch as string | null,
      model: row.model as string | null,
      filePath: typeof source.filePath === 'string' ? source.filePath : '',
      codexHome: typeof source.codexHome === 'string' ? source.codexHome : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      modifiedAt: row.modifiedAt,
      messageCount: row.messageCount,
      totalTokens: row.totalTokens as number | null,
      previewMessages,
      ...(typeof row.firstUserPrompt === 'string' ? { firstUserPrompt: row.firstUserPrompt } : {}),
      ...(typeof row.lastUserPrompt === 'string' ? { lastUserPrompt: row.lastUserPrompt } : {}),
      queuedMessageCount: row.queuedMessageCount,
      subagentTranscriptCount: row.subagentTranscriptCount,
      ...(typeof row.subagent === 'boolean' ? { subagent: row.subagent } : {}),
      presence
    }
  }

  private async ownerResumeSource(id: string, fork: boolean): Promise<VaultSession> {
    const session = await this.request<VaultSession | null>('get', { id })
    if (!session || session.presence !== 'present' || !isAbsolute(session.filePath)) {
      throw this.context.error('conflict', 'owner source is missing or unverifiable')
    }
    try {
      const file = lstatSync(session.filePath)
      if (file.isSymbolicLink() || !file.isFile()) throw this.context.error('conflict', 'owner source is missing or unverifiable')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'owner source is missing or unverifiable')
      throw error
    }
    const resumableContent = session.messageCount > 0 || session.previewMessages.some((message) => message.role === 'user' || message.role === 'assistant')
    if (!resumableContent) throw this.context.error('conflict', 'source has no resumable conversation content')
    const agent = (await this.context.call('quirky.agents/get', { agent: session.agent })) as AgentInfo
    if (!agent.enabled || !agent.resumable) throw this.context.error('conflict', `${session.agent} cannot resume sessions`)
    if (fork && !agent.canFork) throw this.context.error('conflict', `${session.agent} cannot fork sessions`)
    return session
  }

  private async ownerWorktree(id: string, expectedInstanceId: string): Promise<{ id: string; path: string; instanceId: string }> {
    const rows = await this.context.call('quirky.worktree/list', {}) as unknown
    if (!Array.isArray(rows)) throw this.context.error('conflict', 'owner workspace list is unavailable')
    const matches = rows.filter((value) => recordOf(value)?.id === id)
    if (matches.length !== 1) throw this.context.error('conflict', 'owner workspace is missing or ambiguous')
    const worktree = recordOf(matches[0])
    if (
      !worktree ||
      worktree.id !== id ||
      worktree.instanceId !== expectedInstanceId ||
      typeof worktree.path !== 'string' ||
      !isAbsolute(worktree.path)
    ) {
      throw this.context.error('conflict', 'owner workspace instance changed')
    }
    try {
      if (!statSync(worktree.path).isDirectory()) throw this.context.error('conflict', 'owner workspace is unavailable')
    } catch (error) {
      if (isMissing(error)) throw this.context.error('conflict', 'owner workspace is unavailable')
      throw error
    }
    return { id, path: worktree.path, instanceId: expectedInstanceId }
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
function ownerFailureReason(error: unknown): string {
  const message = messageOf(error)
  if (
    /[\\/]/.test(message) ||
    /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)[A-Z0-9_]*\s*=/i.test(message) ||
    /\b(?:token|secret|credential|password|command|launch)\b/i.test(message)
  ) return 'registered owner operation failed (filesystem and launch details redacted)'
  return redactReason(message)
}
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function ownerSessionHostRef(value: unknown): OwnerSessionHostRef | null {
  const owner = recordOf(value)
  const identity = recordOf(owner?.identity)
  const runtime = recordOf(owner?.runtime)
  if (
    !owner || !identity || !runtime ||
    !hasExactKeys(owner, ['hostId', 'identity', 'runtime']) ||
    !hasExactKeys(identity, ['hostId', 'generation']) ||
    !hasExactKeys(runtime, ['id', 'endpoint', 'grantId']) ||
    typeof owner.hostId !== 'string' ||
    typeof identity.hostId !== 'string' ||
    typeof identity.generation !== 'string' ||
    typeof runtime.id !== 'string' ||
    typeof runtime.endpoint !== 'string' ||
    typeof runtime.grantId !== 'string' ||
    owner.hostId !== identity.hostId
  ) return null
  return {
    hostId: owner.hostId,
    identity: { hostId: identity.hostId, generation: identity.generation },
    runtime: { id: runtime.id, endpoint: runtime.endpoint, grantId: runtime.grantId }
  }
}

function ownerWorkspaceRef(value: unknown): OwnerSessionWorkspaceRef | null {
  const reference = recordOf(value)
  const owner = ownerSessionHostRef(reference?.owner)
  if (
    !reference || !owner ||
    !hasExactKeys(reference, ['owner', 'mirrorId', 'worktreeId', 'instanceId', 'fingerprint']) ||
    typeof reference.mirrorId !== 'string' ||
    typeof reference.worktreeId !== 'string' ||
    typeof reference.instanceId !== 'string' ||
    typeof reference.fingerprint !== 'string'
  ) return null
  return {
    owner,
    mirrorId: reference.mirrorId,
    worktreeId: reference.worktreeId,
    instanceId: reference.instanceId,
    fingerprint: reference.fingerprint
  }
}

function sameOwnerRef(left: OwnerSessionHostRef, right: OwnerSessionHostRef): boolean {
  return left.hostId === right.hostId &&
    left.identity.hostId === right.identity.hostId &&
    left.identity.generation === right.identity.generation &&
    left.runtime.id === right.runtime.id &&
    left.runtime.endpoint === right.runtime.endpoint &&
    left.runtime.grantId === right.runtime.grantId
}

function ownerResumeResult(value: unknown): OwnerResumeResult | null {
  const result = recordOf(value)
  if (
    !result ||
    !hasExactKeys(result, ['id', 'kind', 'agent', 'worktreeId', 'status', 'createdAt']) ||
    typeof result.id !== 'string' ||
    (result.kind !== 'terminal' && result.kind !== 'structured') ||
    typeof result.agent !== 'string' ||
    typeof result.worktreeId !== 'string' ||
    !['starting', 'running', 'working', 'waiting', 'done', 'exited'].includes(String(result.status)) ||
    typeof result.createdAt !== 'number' ||
    !Number.isFinite(result.createdAt)
  ) return null
  return result as OwnerResumeResult
}
