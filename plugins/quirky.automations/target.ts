import { isAbsolute, resolve as resolvePath } from 'node:path'
import { statSync } from 'node:fs'
import { RpcErrorCode } from '@quirky/protocol'
import type { AutomationDispatchContext, AutomationOwner, AutomationTarget, AutomationTargetResolution, AutomationTargetResolver } from './dispatch-contract'
import type { AutomationDefinition } from './types'


type RepoIdentity = { id: string; path: string }
type WorkspaceIdentity = {
  id: string
  repoId: string
  path: string
  instanceId: string
  name: string
  removing: boolean
  available: boolean
}
type ErrorKind = 'invalid-params' | 'conflict'

const OWNER_KEYS = [
  'kind', 'repoId', 'repoPath', 'workspaceId', 'workspacePath', 'workspaceInstanceId'
] as const

class TargetLookupError extends Error {
  constructor(readonly kind: ErrorKind, readonly reason: string) {
    super(reason)
  }
}

function directoryAvailable(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownData(value: unknown, key: string): { present: boolean; valid: boolean; value?: unknown } {
  if (!isObject(value)) return { present: false, valid: false }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { present: false, valid: true }
    if (!Object.hasOwn(descriptor, 'value')) return { present: true, valid: false }
    return { present: true, valid: true, value: descriptor.value }
  } catch {
    return { present: true, valid: false }
  }
}

function ownKeys(value: unknown): PropertyKey[] | null {
  if (!isPlainRecord(value)) return null
  try {
    return Reflect.ownKeys(value)
  } catch {
    return null
  }
}

function stringField(value: unknown, key: string): string | null {
  const field = ownData(value, key)
  return field.present && field.valid && typeof field.value === 'string' && field.value.length > 0
    ? field.value
    : null
}

function normalizedAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return null
  return resolvePath(value)
}

function parseOwner(value: unknown): AutomationOwner | null {
  const keys = ownKeys(value)
  if (!keys || keys.length !== OWNER_KEYS.length || keys.some((key) => typeof key !== 'string' || !OWNER_KEYS.includes(key as typeof OWNER_KEYS[number]))) {
    return null
  }
  const fields = new Map<string, unknown>()
  for (const key of OWNER_KEYS) {
    const field = ownData(value, key)
    if (!field.present || !field.valid) return null
    fields.set(key, field.value)
  }

  const kind = fields.get('kind')
  const repoId = fields.get('repoId')
  const repoPath = fields.get('repoPath')
  const workspaceId = fields.get('workspaceId')
  const workspacePath = fields.get('workspacePath')
  const workspaceInstanceId = fields.get('workspaceInstanceId')
  if (
    kind !== 'local' || typeof repoId !== 'string' || repoId.length === 0 ||
    typeof repoPath !== 'string' || !isAbsolute(repoPath)
  ) return null

  const hasWorkspace = typeof workspaceId === 'string' && workspaceId.length > 0 &&
    typeof workspacePath === 'string' && isAbsolute(workspacePath) &&
    typeof workspaceInstanceId === 'string' && workspaceInstanceId.length > 0
  const noWorkspace = workspaceId === null && workspacePath === null && workspaceInstanceId === null
  if (!hasWorkspace && !noWorkspace) return null

  return {
    kind,
    repoId,
    repoPath,
    workspaceId: workspaceId as string | null,
    workspacePath: workspacePath as string | null,
    workspaceInstanceId: workspaceInstanceId as string | null
  }
}

function localContextRefusal(value: unknown): string | null {
  if (value === null) return null
  const keys = ownKeys(value)
  if (!keys) return 'automation_remote_target_unsupported'
  for (const key of keys) {
    if (typeof key !== 'string') return 'automation_remote_target_unsupported'
    const field = ownData(value, key)
    if (!field.valid) return 'automation_remote_target_unsupported'
    if (key === 'context') return 'automation_remote_target_unsupported'
    if (key === 'kind' && field.value !== 'workspace-run') return 'automation_remote_target_unsupported'
    if (key === 'type' && field.value !== 'local' && field.value !== 'workspace-run') return 'automation_remote_target_unsupported'
    if ((key === 'hostId' || key === 'host' || key === 'hostType') && field.value !== 'local') {
      return 'automation_remote_target_unsupported'
    }
    if (key === 'remote' && field.value !== false && field.value !== undefined) return 'automation_remote_target_unsupported'
  }
  return null
}

function ownerRefusal(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const kind = ownData(value, 'kind')
  if (!kind.valid || kind.value !== 'local') return 'automation_remote_target_unsupported'
  return parseOwner(value) ? null : 'automation_owner_invalid'
}

function unsupportedContext(definition: AutomationDefinition): string | null {
  return ownerRefusal(definition.owner) ?? localContextRefusal(definition.runContext)
}

function parseRepo(value: unknown): RepoIdentity | null {
  const id = stringField(value, 'id')
  const path = normalizedAbsolutePath(ownData(value, 'path').value)
  return id && path ? { id, path } : null
}

function parseWorkspace(value: unknown): WorkspaceIdentity | null {
  const id = stringField(value, 'id')
  const repoId = stringField(value, 'repoId')
  const path = normalizedAbsolutePath(ownData(value, 'path').value)
  const instanceId = stringField(value, 'instanceId')
  const name = stringField(value, 'name')
  const removing = ownData(value, 'removing')
  const availableField = ownData(value, 'available')
  const existsField = ownData(value, 'exists')
  if (!id || !repoId || !path || !instanceId || !name || !removing.valid || !availableField.valid || !existsField.valid) return null
  return {
    id,
    repoId,
    path,
    instanceId,
    name,
    removing: removing.value === true,
    available: availableField.value !== false && existsField.value !== false
  }
}

function errorCode(error: unknown): number | null {
  const code = ownData(error, 'code')
  return code.valid && typeof code.value === 'number' ? code.value : null
}

function apiLookupError(error: unknown, kind: 'project' | 'workspace'): TargetLookupError {
  const label = kind === 'project' ? 'automation_project' : 'automation_workspace'
  if (errorCode(error) === RpcErrorCode.Conflict) {
    return new TargetLookupError('conflict', `${label}_ambiguous`)
  }
  return new TargetLookupError('invalid-params', `${label}_unavailable`)
}

function ownerOf(repo: RepoIdentity, workspace: WorkspaceIdentity | null): AutomationOwner {
  return {
    kind: 'local',
    repoId: repo.id,
    repoPath: repo.path,
    workspaceId: workspace?.id ?? null,
    workspacePath: workspace?.path ?? null,
    workspaceInstanceId: workspace?.instanceId ?? null
  }
}

function contextOf(repo: RepoIdentity, workspace: WorkspaceIdentity | null): Record<string, unknown> {
  return {
    kind: 'workspace-run',
    hostId: 'local',
    repoId: repo.id,
    projectId: repo.id,
    path: workspace?.path ?? repo.path
  }
}

function unavailable(error: string): AutomationTargetResolution {
  return { available: false, status: 'skipped_unavailable', error }
}

function ownerChanged(field: string): string {
  return `automation_owner_changed:${field}`
}

function equalOwner(left: AutomationOwner, right: AutomationOwner): boolean {
  return OWNER_KEYS.every((key) => left[key] === right[key])
}

export function createAutomationTargetResolver(context: AutomationDispatchContext): AutomationTargetResolver {
  async function resolveRepo(selector: string): Promise<RepoIdentity> {
    let result: unknown
    try {
      result = await context.call('quirky.repo/resolve', { selector })
    } catch (error) {
      throw apiLookupError(error, 'project')
    }
    const repo = parseRepo(result)
    if (!repo) throw new TargetLookupError('conflict', 'automation_project_identity_invalid')
    return repo
  }

  async function resolveWorkspace(selector: string): Promise<WorkspaceIdentity> {
    let result: unknown
    try {
      result = await context.call('quirky.worktree/resolve', { selector })
    } catch (error) {
      throw apiLookupError(error, 'workspace')
    }
    const workspace = parseWorkspace(result)
    if (!workspace) throw new TargetLookupError('conflict', 'automation_workspace_identity_invalid')
    if (!workspace.available) throw new TargetLookupError('conflict', 'automation_workspace_unavailable')
    if (workspace.removing) throw new TargetLookupError('conflict', 'automation_workspace_removing')
    return workspace
  }

  async function capture(definition: AutomationDefinition): Promise<AutomationDefinition> {
    const refusal = unsupportedContext(definition)
    if (refusal) throw context.error('conflict', refusal)
    if (definition.workspaceMode !== 'existing' && definition.workspaceMode !== 'new_per_run') {
      throw context.error('invalid-params', 'workspaceMode must be existing or new_per_run.')
    }
    if (typeof definition.projectId !== 'string' || definition.projectId.trim() === '') {
      throw context.error('invalid-params', 'projectId must select a registered project.')
    }

    let repo: RepoIdentity
    try {
      repo = await resolveRepo(definition.projectId)
    } catch (error) {
      if (error instanceof TargetLookupError) throw context.error(error.kind, error.reason)
      throw error
    }
    if (!directoryAvailable(repo.path)) throw context.error('invalid-params', 'automation_project_unavailable')

    let workspace: WorkspaceIdentity | null = null
    if (definition.workspaceMode === 'existing') {
      if (typeof definition.workspaceId !== 'string' || definition.workspaceId.length === 0) {
        throw context.error('invalid-params', 'workspaceMode existing requires workspaceId.')
      }
      try {
        workspace = await resolveWorkspace(`id:${definition.workspaceId}`)
      } catch (error) {
        if (error instanceof TargetLookupError) throw context.error(error.kind, error.reason)
        throw error
      }
      if (workspace.repoId !== repo.id) throw context.error('conflict', 'automation_workspace_project_mismatch')
      if (workspace.id !== definition.workspaceId) throw context.error('conflict', 'automation_workspace_identity_mismatch')
      if (!directoryAvailable(workspace.path)) throw context.error('invalid-params', 'automation_workspace_unavailable')
    }

    const owner = ownerOf(repo, workspace)
    return {
      ...definition,
      projectId: repo.id,
      workspaceId: workspace?.id ?? null,
      runContext: contextOf(repo, workspace),
      owner
    }
  }

  async function resolve(definition: AutomationDefinition): Promise<AutomationTargetResolution> {
    const refusal = unsupportedContext(definition)
    if (refusal) return unavailable(refusal)
    if (definition.workspaceMode !== 'existing' && definition.workspaceMode !== 'new_per_run') {
      return unavailable('automation_target_mode_invalid')
    }

    const owner = definition.owner === undefined || definition.owner === null ? null : parseOwner(definition.owner)
    if (definition.owner !== undefined && definition.owner !== null && !owner) {
      return unavailable('automation_owner_invalid')
    }
    if (owner && definition.projectId !== owner.repoId) return unavailable(ownerChanged('project_id'))
    if (owner && definition.workspaceMode === 'existing' && owner.workspaceId === null) {
      return unavailable(ownerChanged('workspace_id'))
    }
    if (owner && definition.workspaceMode === 'new_per_run' && owner.workspaceId !== null) {
      return unavailable(ownerChanged('workspace_id'))
    }
    if (owner && definition.workspaceMode === 'existing' && definition.workspaceId !== owner.workspaceId) {
      return unavailable(ownerChanged('workspace_id'))
    }
    if (owner && definition.workspaceMode === 'new_per_run' && definition.workspaceId !== null) {
      return unavailable(ownerChanged('workspace_id'))
    }
    if (typeof definition.projectId !== 'string' || definition.projectId.trim() === '') {
      return unavailable('automation_project_unavailable')
    }

    let repo: RepoIdentity
    try {
      repo = await resolveRepo(owner ? `id:${owner.repoId}` : definition.projectId)
    } catch (error) {
      return unavailable(error instanceof TargetLookupError ? error.reason : 'automation_project_unavailable')
    }
    if (owner) {
      if (repo.id !== owner.repoId) return unavailable(ownerChanged('repo_id'))
      if (repo.path !== owner.repoPath) return unavailable(ownerChanged('repo_path'))
    }
    if (!directoryAvailable(repo.path)) return unavailable('automation_project_unavailable')

    let workspace: WorkspaceIdentity | null = null
    if (definition.workspaceMode === 'existing') {
      const workspaceId = owner?.workspaceId ?? definition.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        return unavailable('automation_workspace_unavailable')
      }
      try {
        workspace = await resolveWorkspace(`id:${workspaceId}`)
      } catch (error) {
        return unavailable(error instanceof TargetLookupError ? error.reason : 'automation_workspace_unavailable')
      }
      if (owner) {
        if (workspace.id !== owner.workspaceId) return unavailable(ownerChanged('workspace_id'))
        if (workspace.repoId !== owner.repoId) return unavailable(ownerChanged('workspace_repo_id'))
        if (workspace.path !== owner.workspacePath) return unavailable(ownerChanged('workspace_path'))
        if (workspace.instanceId !== owner.workspaceInstanceId) return unavailable(ownerChanged('workspace_instance_id'))
      } else if (workspace.repoId !== repo.id) {
        return unavailable('automation_workspace_project_mismatch')
      }
      if (!directoryAvailable(workspace.path)) return unavailable('automation_workspace_unavailable')
    }

    const targetOwner = owner ?? ownerOf(repo, workspace)
    const target: AutomationTarget = {
      repoId: repo.id,
      repoPath: repo.path,
      cwd: workspace?.path ?? repo.path,
      workspaceId: workspace?.id ?? null,
      workspaceDisplayName: workspace?.name ?? null,
      owner: targetOwner
    }
    return { available: true, target }
  }

  function assertExpectedOwner(definition: AutomationDefinition, expectedOwner: unknown): void {
    if (expectedOwner === undefined) return
    const saved = parseOwner(definition.owner)
    const expected = parseOwner(expectedOwner)
    if (!saved || !expected || !equalOwner(saved, expected)) {
      throw context.error('conflict', 'automation_owner_changed: expected owner does not match the saved owner.')
    }
  }

  return { capture, resolve, assertExpectedOwner }
}
