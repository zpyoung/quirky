import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { MethodHandler, PluginCaller } from '@quirky/protocol'
import { buildAutomationRrule, isValidAutomationSchedule } from '../../schedule'
import type { AutomationDefinition, SchedulePreset } from '../../types'
import type { AutomationOwner } from '../../dispatch-contract'
import type {
  AutomationDraft,
  AutomationEditorData,
  AutomationMethods,
  AutomationUiEnv,
  AutomationUiState
} from '../ui-contracts'

type ObjectValue = Record<string, unknown>
type Project = { id: string; name: string; path: string; kind: string }
type Workspace = { id: string; repoId: string; name: string; path: string; isMain: boolean }
type Agent = { id: AutomationDraft['agentId']; label: string; enabled: boolean; installed: boolean; isDefault: boolean }
type AgentCatalog = { agents: Agent[]; defaultAgent: string | null }
type EditorCatalog = { data: AutomationEditorData; agents: AgentCatalog }
type RepoDetails = { repo: Project; defaultBase: string | null }
type TargetResolution =
  | { available: true; target: { owner: AutomationOwner } }
  | { available: false; status: string; error: string }

const GRACE_VALUES = new Set([0, 30, 60, 180, 720, 1440, 2880])
const PRECHECK_TIMEOUTS = new Set([30, 60, 120, 300, 600])
const DRAFT_KEYS: Record<string, true> = {
  name: true, prompt: true, agentId: true, projectId: true, workspaceMode: true, workspaceId: true, baseBranch: true,
  setupDecision: true, reuseSession: true, timezone: true, rrule: true, missedRunGraceMinutes: true, precheck: true,
  launchOverrides: true, runContext: true, sourceContext: true
}

const TEMPLATES = {
  'repo-health-weekday': {
    name: 'Weekday repo audit',
    prompt: 'Review the repository health. Check dependency updates, failing tests, lint/typecheck status, and risky open changes. Summarize findings and suggest the next action.',
    preset: 'weekdays' as const,
    hour: 9,
    minute: 0,
    grace: 720
  },
  'release-prep-weekly': {
    name: 'Release readiness review',
    prompt: 'Prepare a release readiness summary. Look for blockers, unmerged risky changes, missing validation, and documentation gaps. End with a concise release/no-release recommendation.',
    preset: 'weekly' as const,
    hour: 14,
    minute: 0,
    day: 4,
    grace: 1440
  },
  'recurring-review-daily': {
    name: 'Daily change review',
    prompt: 'Review recent changes in this workspace. Focus on correctness risks, UX regressions, missing tests, and follow-up tasks. Keep the report short and actionable.',
    preset: 'daily' as const,
    hour: 16,
    minute: 30,
    grace: 180
  },
  'maintenance-hourly': {
    name: 'Hourly maintenance check',
    prompt: 'Check for stuck work, stale generated files, failing validation, and anything that needs human attention. Report only actionable issues.',
    preset: 'hourly' as const,
    hour: 0,
    minute: 15,
    grace: 30
  }
} satisfies Record<string, {
  name: string
  prompt: string
  preset: SchedulePreset
  hour: number
  minute: number
  day?: number
  grace: number
}>

type TemplateId = keyof typeof TEMPLATES

function isObject(value: unknown): value is ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(env: AutomationUiEnv, kind: 'invalid-params' | 'not-found' | 'conflict', message: string): never {
  throw env.context.error(kind, message)
}

function expectParams(env: AutomationUiEnv, params: unknown, method: string, allowed: readonly string[]): ObjectValue {
  if (!isObject(params)) return fail(env, 'invalid-params', `${method} params must be an object.`)
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) fail(env, 'invalid-params', `${method}.${key} is not allowed.`)
  }
  return params
}

function expectEmpty(env: AutomationUiEnv, params: unknown, method: string): void {
  expectParams(env, params, method, [])
}

async function publicCall(env: AutomationUiEnv, method: string, params: ObjectValue, label: string): Promise<unknown> {
  try {
    return await env.context.call(method, params)
  } catch (error) {
    return fail(env, 'conflict', `${label}: ${errorMessage(error)}`)
  }
}

function stringField(value: unknown): value is string {
  return typeof value === 'string'
}

function parseProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) throw new Error('Project list returned an invalid response.')
  const projects: Project[] = []
  for (const item of value) {
    if (!isObject(item) || !stringField(item.id) || !stringField(item.path) || !stringField(item.kind)) {
      throw new Error('Project list returned an invalid response.')
    }
    const name = stringField(item.displayName) && item.displayName.trim() ? item.displayName : item.name
    if (!stringField(name)) throw new Error('Project list returned an invalid response.')
    projects.push({ id: item.id, name, path: item.path, kind: item.kind })
  }
  return projects
}

function parseWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) throw new Error('Workspace list returned an invalid response.')
  const workspaces: Workspace[] = []
  for (const item of value) {
    if (!isObject(item) || !stringField(item.id) || !stringField(item.repoId) || !stringField(item.name) ||
      !stringField(item.path) || typeof item.isMain !== 'boolean') {
      throw new Error('Workspace list returned an invalid response.')
    }
    workspaces.push({ id: item.id, repoId: item.repoId, name: item.name, path: item.path, isMain: item.isMain })
  }
  return workspaces
}

function parseAgents(value: unknown): AgentCatalog {
  if (!isObject(value) || !Array.isArray(value.agents)) throw new Error('Agent catalog returned an invalid response.')
  const agents: Agent[] = []
  for (const item of value.agents) {
    if (!isObject(item) || !stringField(item.id) || !stringField(item.label) || typeof item.enabled !== 'boolean' ||
      typeof item.installed !== 'boolean' || typeof item.isDefault !== 'boolean') {
      throw new Error('Agent catalog returned an invalid response.')
    }
    if (item.id === 'claude' || item.id === 'codex') {
      agents.push({ id: item.id, label: item.label, enabled: item.enabled, installed: item.installed, isDefault: item.isDefault })
    }
  }
  const defaultAgent = stringField(value.defaultAgent)
    ? value.defaultAgent
    : agents.find((agent) => agent.isDefault)?.id ?? null
  return { agents, defaultAgent }
}

async function settled<T>(
  promise: Promise<unknown>,
  label: string,
  parse: (value: unknown) => T,
  errors: string[]
): Promise<T | null> {
  try {
    return parse(await promise)
  } catch (error) {
    errors.push(`${label}: ${errorMessage(error)}`)
    return null
  }
}

async function editorCatalog(env: AutomationUiEnv): Promise<EditorCatalog> {
  const errors: string[] = []
  const [projects, workspaces, catalog] = await Promise.all([
    settled(Promise.resolve().then(() => env.context.call('quirky.repo/list')), 'Projects could not be loaded', parseProjects, errors),
    settled(Promise.resolve().then(() => env.context.call('quirky.worktree/list')), 'Workspaces could not be loaded', parseWorkspaces, errors),
    settled(Promise.resolve().then(() => env.context.call('quirky.agents/list')), 'Agent catalog could not be loaded', parseAgents, errors)
  ])
  const agents = catalog ?? { agents: [], defaultAgent: null }
  return {
    data: {
      hosts: [{ id: 'local', label: 'Local', available: true }],
      projects: (projects ?? []).map((project) => ({ ...project, hostId: 'local' })),
      workspaces: workspaces ?? [],
      agents: agents.agents,
      errors
    },
    agents
  }
}

function callerWorktreeId(caller: PluginCaller): string | null {
  return 'worktreeId' in caller && stringField(caller.worktreeId) ? caller.worktreeId : null
}

function callerCwd(caller: PluginCaller): string | null {
  return 'cwd' in caller && stringField(caller.cwd) ? caller.cwd : null
}

function containsPath(parentPath: string, childPath: string): boolean {
  const child = relative(resolve(parentPath), resolve(childPath))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function activeWorkspace(caller: PluginCaller, workspaces: Workspace[], projects: Project[]): Workspace | null {
  const projectIds = new Set(projects.map((project) => project.id))
  const worktreeId = callerWorktreeId(caller)
  const byId = worktreeId === null ? undefined : workspaces.find((workspace) => workspace.id === worktreeId)
  if (byId && projectIds.has(byId.repoId)) return byId
  const cwd = callerCwd(caller)
  if (!cwd) return null
  return workspaces
    .filter((workspace) => projectIds.has(workspace.repoId) && containsPath(workspace.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null
}

function defaultWorkspace(projectId: string, workspaces: Workspace[], preferred?: Workspace | null): Workspace | null {
  if (preferred?.repoId === projectId) return preferred
  return workspaces.find((workspace) => workspace.repoId === projectId && workspace.isMain) ?? null
}

function selectedAgent(catalog: AgentCatalog): AutomationDraft['agentId'] {
  const selectable = catalog.agents.filter((agent) => agent.enabled && agent.installed)
  return selectable.find((agent) => agent.id === catalog.defaultAgent)?.id ??
    selectable.find((agent) => agent.isDefault)?.id ?? selectable[0]?.id ?? 'claude'
}

function timezoneDefault(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function applyTemplate(draft: AutomationDraft, id: string, env: AutomationUiEnv): AutomationDraft {
  if (!Object.hasOwn(TEMPLATES, id)) fail(env, 'invalid-params', `Unknown automation template ${id}.`)
  const template = TEMPLATES[id as TemplateId]
  const rrule = buildAutomationRrule({
    preset: template.preset,
    hour: template.hour,
    minute: template.minute,
    ...('day' in template ? { day: template.day } : {})
  })
  return {
    ...draft,
    name: template.name,
    prompt: template.prompt,
    rrule,
    missedRunGraceMinutes: template.grace,
    launchOverrides: null
  }
}

function draftFromDefinition(definition: AutomationDefinition): AutomationDraft {
  return {
    name: definition.name,
    prompt: definition.prompt,
    agentId: definition.agentId,
    projectId: definition.projectId,
    workspaceMode: definition.workspaceMode,
    workspaceId: definition.workspaceId,
    baseBranch: definition.baseBranch,
    setupDecision: definition.setupDecision ?? 'skip',
    reuseSession: definition.reuseSession,
    timezone: definition.timezone,
    rrule: definition.rrule,
    missedRunGraceMinutes: definition.missedRunGraceMinutes,
    precheck: definition.precheck ?? null,
    launchOverrides: definition.launchOverrides ?? null,
    runContext: definition.runContext ?? null,
    sourceContext: definition.sourceContext ?? null
  }
}

function newDraft(caller: PluginCaller, catalog: EditorCatalog): AutomationDraft {
  const { data } = catalog
  const active = activeWorkspace(caller, data.workspaces, data.projects)
  const projectId = (active && data.projects.some((project) => project.id === active.repoId) ? active.repoId : null) ??
    data.projects[0]?.id ?? ''
  const workspace = defaultWorkspace(projectId, data.workspaces, active)
  return {
    name: '',
    prompt: '',
    agentId: selectedAgent(catalog.agents),
    projectId,
    workspaceMode: 'existing',
    workspaceId: workspace?.id ?? null,
    baseBranch: null,
    setupDecision: 'skip',
    reuseSession: false,
    timezone: timezoneDefault(),
    rrule: buildAutomationRrule({ preset: 'weekdays', hour: 9, minute: 0 }),
    missedRunGraceMinutes: 720,
    precheck: null,
    launchOverrides: null,
    runContext: null,
    sourceContext: null
  }
}

function validateLaunchOverrides(value: unknown, env: AutomationUiEnv): AutomationDraft['launchOverrides'] {
  if (value === null) return null
  if (!isObject(value)) fail(env, 'invalid-params', 'Launch overrides must be an object or null.')
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'optionValues') fail(env, 'invalid-params', `launchOverrides.${key} is not allowed.`)
  }
  if (value.model !== undefined && !stringField(value.model)) fail(env, 'invalid-params', 'launchOverrides.model must be a string.')
  let optionValues: Record<string, string | boolean> | undefined
  if (value.optionValues !== undefined) {
    if (!isObject(value.optionValues)) fail(env, 'invalid-params', 'launchOverrides.optionValues must be an object.')
    optionValues = {}
    for (const [key, item] of Object.entries(value.optionValues)) {
      if (!stringField(item) && typeof item !== 'boolean') {
        fail(env, 'invalid-params', `launchOverrides.optionValues.${key} must be a string or boolean.`)
      }
      optionValues[key] = item
    }
  }
  return {
    ...(value.model === undefined ? {} : { model: value.model as string }),
    ...(optionValues === undefined ? {} : { optionValues })
  }
}

function validatePrecheck(value: unknown, env: AutomationUiEnv): AutomationDraft['precheck'] {
  if (value === null) return null
  if (!isObject(value)) fail(env, 'invalid-params', 'precheck must be an object or null.')
  for (const key of Object.keys(value)) {
    if (key !== 'command' && key !== 'timeoutSeconds') fail(env, 'invalid-params', `precheck.${key} is not allowed.`)
  }
  if (!stringField(value.command)) fail(env, 'invalid-params', 'precheck.command must be a string.')
  if (typeof value.timeoutSeconds !== 'number' || !PRECHECK_TIMEOUTS.has(value.timeoutSeconds)) {
    fail(env, 'invalid-params', 'Choose a supported precheck timeout before saving.')
  }
  return { command: value.command, timeoutSeconds: value.timeoutSeconds }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function validateDraftPatch(value: unknown, current: AutomationDraft, env: AutomationUiEnv): Partial<AutomationDraft> {
  if (!isObject(value)) fail(env, 'invalid-params', 'patchDraft.patch must be an object.')
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DRAFT_KEYS, key)) fail(env, 'invalid-params', `patchDraft.patch.${key} is not allowed.`)
  }
  const result: Partial<AutomationDraft> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    switch (key) {
      case 'name':
        if (!stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.name must be a string.')
        if (item.length > 256) fail(env, 'invalid-params', 'Automation name must be at most 256 characters.')
        result.name = item
        break
      case 'prompt':
        if (!stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.prompt must be a string.')
        result.prompt = item
        break
      case 'projectId':
        if (!stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.projectId must be a string.')
        result.projectId = item
        break
      case 'timezone':
        if (!stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.timezone must be a string.')
        result.timezone = item
        break
      case 'rrule':
        if (!stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.rrule must be a string.')
        if (item.length > 2048) fail(env, 'invalid-params', 'Schedule expression must be at most 2048 characters.')
        result.rrule = item
        break
      case 'agentId':
        if (item !== 'claude' && item !== 'codex') fail(env, 'invalid-params', 'Choose Claude or Codex as the structured agent.')
        result.agentId = item
        break
      case 'workspaceMode':
        if (item !== 'existing' && item !== 'new_per_run') fail(env, 'invalid-params', 'workspaceMode must be existing or new_per_run.')
        result.workspaceMode = item
        break
      case 'workspaceId':
        if (item !== null && !stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.workspaceId must be a string or null.')
        result.workspaceId = item
        break
      case 'baseBranch':
        if (item !== null && !stringField(item)) fail(env, 'invalid-params', 'patchDraft.patch.baseBranch must be a string or null.')
        result.baseBranch = item
        break
      case 'setupDecision':
        if (item !== 'run' && item !== 'skip') fail(env, 'invalid-params', 'setupDecision must be run or skip.')
        result.setupDecision = item
        break
      case 'reuseSession':
        if (typeof item !== 'boolean') fail(env, 'invalid-params', 'reuseSession must be a boolean.')
        result.reuseSession = item
        break
      case 'missedRunGraceMinutes':
        if (typeof item !== 'number' || !GRACE_VALUES.has(item)) fail(env, 'invalid-params', 'Choose a supported missed-run grace period.')
        result.missedRunGraceMinutes = item
        break
      case 'precheck':
        result.precheck = validatePrecheck(item, env)
        break
      case 'launchOverrides':
        result.launchOverrides = validateLaunchOverrides(item, env)
        break
      case 'runContext':
      case 'sourceContext': {
        if (item !== null && !isObject(item)) fail(env, 'invalid-params', `${key} must be an object or null.`)
        const currentValue = key === 'runContext' ? current.runContext : current.sourceContext
        if (!jsonEqual(item, currentValue)) fail(env, 'invalid-params', `${key} is not editable.`)
        if (key === 'runContext') result.runContext = current.runContext
        else result.sourceContext = current.sourceContext
        break
      }
    }
  }
  return result
}

function parseDetails(value: unknown, expectedId: string): RepoDetails {
  if (!isObject(value) || !isObject(value.repo) || value.repo.id !== expectedId || !stringField(value.repo.path) ||
    !stringField(value.repo.kind) || !isObject(value.settings) ||
    !(value.settings.defaultBase === null || stringField(value.settings.defaultBase))) {
    throw new Error('Project details returned an invalid response.')
  }
  const name = stringField(value.repo.displayName) && value.repo.displayName.trim() ? value.repo.displayName : value.repo.name
  if (!stringField(name)) throw new Error('Project details returned an invalid response.')
  return {
    repo: { id: expectedId, name, path: value.repo.path, kind: value.repo.kind },
    defaultBase: value.settings.defaultBase
  }
}


function sameOwner(left: AutomationOwner, right: AutomationOwner): boolean {
  return left.kind === right.kind && left.repoId === right.repoId && left.repoPath === right.repoPath &&
    left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath &&
    left.workspaceInstanceId === right.workspaceInstanceId
}

function parseTarget(value: unknown): TargetResolution {
  if (!isObject(value) || typeof value.available !== 'boolean') throw new Error('Automation target returned an invalid response.')
  if (!value.available) {
    if (!stringField(value.status) || !stringField(value.error)) throw new Error('Automation target returned an invalid response.')
    return { available: false, status: value.status, error: value.error }
  }
  const target = value.target
  if (!isObject(target) || !stringField(target.repoId) || !stringField(target.repoPath) || !stringField(target.cwd) ||
    !(target.workspaceId === null || stringField(target.workspaceId)) ||
    !(target.workspaceDisplayName === null || stringField(target.workspaceDisplayName)) ||
    !isObject(target.owner) || target.owner.kind !== 'local' || !stringField(target.owner.repoId) ||
    !stringField(target.owner.repoPath) ||
    !(target.owner.workspaceId === null || stringField(target.owner.workspaceId)) ||
    !(target.owner.workspacePath === null || stringField(target.owner.workspacePath)) ||
    !(target.owner.workspaceInstanceId === null || stringField(target.owner.workspaceInstanceId))) {
    throw new Error('Automation target returned an invalid local-owner response.')
  }
  const owner: AutomationOwner = {
    kind: 'local',
    repoId: target.owner.repoId,
    repoPath: target.owner.repoPath,
    workspaceId: target.owner.workspaceId,
    workspacePath: target.owner.workspacePath,
    workspaceInstanceId: target.owner.workspaceInstanceId
  }
  return { available: true, target: { owner } }
}

async function validateTargetOwner(env: AutomationUiEnv, editor: NonNullable<AutomationUiState['editor']>, draft: AutomationDraft): Promise<void> {
  if (!editor.id || !editor.original) return
  let resolution: TargetResolution
  try {
    resolution = parseTarget(await env.context.call('quirky.automations/target', { id: editor.id }))
  } catch (error) {
    fail(env, 'conflict', `The saved automation target could not be checked: ${errorMessage(error)}`)
  }
  const capturedOwner = editor.original.owner
  if (resolution.available) {
    if (capturedOwner && !sameOwner(capturedOwner, resolution.target.owner)) {
      fail(env, 'conflict', 'The automation target changed while it was being edited. Reload the editor before saving.')
    }
    return
  }
  const selectorsChanged = draft.projectId !== editor.original.projectId || draft.workspaceMode !== editor.original.workspaceMode ||
    draft.workspaceId !== editor.original.workspaceId || draft.baseBranch !== editor.original.baseBranch
  if (!selectorsChanged) fail(env, 'conflict', resolution.error)
}

async function readWorkspaceRows(env: AutomationUiEnv, projectId: string, label: string): Promise<ObjectValue[]> {
  const value = await publicCall(env, 'quirky.worktree/list', { repo: projectId }, label)
  if (!Array.isArray(value)) fail(env, 'conflict', 'Workspace list returned an invalid response.')
  const workspaces: ObjectValue[] = []
  for (const item of value) {
    if (!isObject(item) || !stringField(item.id) || !stringField(item.repoId) || !stringField(item.path) ||
      !stringField(item.name) || typeof item.isMain !== 'boolean') {
      fail(env, 'conflict', 'Workspace list returned an invalid response.')
    }
    workspaces.push(item)
  }
  return workspaces
}

async function validateSelectedTarget(env: AutomationUiEnv, draft: AutomationDraft): Promise<{ details: RepoDetails; workspaces: ObjectValue[] }> {
  if (!draft.projectId.trim()) fail(env, 'invalid-params', 'Choose a run location and enter a prompt before saving.')
  let projects: Project[]
  try {
    projects = parseProjects(await env.context.call('quirky.repo/list'))
  } catch (error) {
    fail(env, 'conflict', `Projects could not be loaded: ${errorMessage(error)}`)
  }
  if (!projects.some((project) => project.id === draft.projectId)) {
    fail(env, 'invalid-params', 'The selected project is unavailable on Local. Remote automation targets are not supported by this editor.')
  }
  let details: RepoDetails
  try {
    details = parseDetails(await env.context.call('quirky.repo/show', { repo: draft.projectId }), draft.projectId)
  } catch (error) {
    fail(env, 'conflict', `The selected project is unavailable on Local: ${errorMessage(error)}`)
  }
  const workspaces = await readWorkspaceRows(env, draft.projectId, 'Workspaces could not be loaded')
  if (draft.workspaceMode === 'existing') {
    const workspace = workspaces.find((item) => item.id === draft.workspaceId && item.repoId === draft.projectId)
    if (!workspace) fail(env, 'invalid-params', 'Choose an available workspace before saving.')
    return { details, workspaces }
  }
  if (details.repo.kind !== 'git') fail(env, 'invalid-params', 'New run workspaces require a Git project.')
  if (draft.baseBranch) {
    const mainWorkspace = workspaces.find((workspace) => workspace.repoId === draft.projectId && workspace.isMain === true)
    if (!mainWorkspace || !stringField(mainWorkspace.id)) fail(env, 'invalid-params', 'Choose an available base branch before saving.')
    let branches: unknown
    try {
      branches = await env.context.call('quirky.git/branches', { worktree: mainWorkspace.id, query: draft.baseBranch })
    } catch (error) {
      fail(env, 'conflict', `Branches could not be loaded: ${errorMessage(error)}`)
    }
    if (!isObject(branches) || !Array.isArray(branches.refs) ||
      !branches.refs.some((ref) => isObject(ref) && ref.name === draft.baseBranch)) {
      fail(env, 'invalid-params', 'Choose an available base branch before saving.')
    }
  }
  return { details, workspaces }
}

async function setupDecisionForSave(
  env: AutomationUiEnv,
  draft: AutomationDraft,
  trustSetup: boolean | undefined,
  workspaces: ObjectValue[],
  details: RepoDetails
): Promise<'run' | 'skip'> {
  if (draft.workspaceMode !== 'new_per_run' || draft.setupDecision !== 'run') return 'skip'
  if (trustSetup === false) return 'skip'
  const branch = draft.baseBranch ?? details.defaultBase
  const workspace = branch
    ? workspaces.find((item) => item.repoId === draft.projectId && item.branch === branch)
    : workspaces.find((item) => item.repoId === draft.projectId && item.isMain === true)
  const setupRef = workspace && stringField(workspace.head) ? workspace.head : null
  if (!setupRef) return 'skip'
  try {
    const raw = await env.context.call('quirky.repo/hooks', { repo: draft.projectId, ref: setupRef })
    if (!isObject(raw) || !('setup' in raw) || !isObject(raw.setup) || !stringField(raw.setup.text) ||
      !raw.setup.text.trim() || !('shared' in raw.setup)) return 'skip'
    if (raw.setup.shared !== null) {
      if (!isObject(raw.setup.shared) || typeof raw.setup.shared.trusted !== 'boolean' || typeof raw.setup.shared.changed !== 'boolean') return 'skip'
      if (!raw.setup.shared.trusted || raw.setup.shared.changed) return 'skip'
    }
    return 'run'
  } catch {
    return 'skip'
  }
}


function changedEditFields(draft: AutomationDraft, original: AutomationDefinition): ObjectValue {
  const fields: ObjectValue = {}
  const scalarFields = [
    'name', 'prompt', 'agentId', 'projectId', 'workspaceMode', 'workspaceId', 'baseBranch', 'reuseSession',
    'timezone', 'rrule', 'missedRunGraceMinutes', 'precheck', 'launchOverrides'
  ] as const
  for (const field of scalarFields) {
    const draftValue = draft[field]
    const originalValue = field === 'precheck' || field === 'launchOverrides'
      ? original[field] ?? null
      : original[field]
    if (!jsonEqual(draftValue, originalValue)) fields[field] = draftValue
  }
  return fields
}

async function openEditor(env: AutomationUiEnv, params: unknown, caller: PluginCaller): Promise<AutomationUiState> {
  const input = expectParams(env, params, 'openEditor', ['id', 'template'])
  const id = input.id
  const template = input.template
  if (id !== undefined && (!stringField(id) || !id.trim())) fail(env, 'invalid-params', 'openEditor.id must be a non-blank string.')
  if (template !== undefined && !stringField(template)) fail(env, 'invalid-params', 'openEditor.template must be a string.')
  if (id !== undefined && template !== undefined) fail(env, 'invalid-params', 'Choose an existing automation or a template, not both.')
  const catalog = await editorCatalog(env)
  const original = id === undefined ? null : env.service.show({ id })
  let draft = original ? draftFromDefinition(original) : newDraft(caller, catalog)
  if (template !== undefined) draft = applyTemplate(draft, template, env)
  const creationKey = randomUUID()
  env.update((state) => {
    state.editor = { id: original?.id ?? null, original, draft, creationKey }
  })
  return env.navigate({})
}

async function patchDraft(env: AutomationUiEnv, params: unknown): Promise<AutomationUiState> {
  const input = expectParams(env, params, 'patchDraft', ['patch', 'template'])
  if (!('patch' in input)) fail(env, 'invalid-params', 'patchDraft.patch is required.')
  const template = input.template
  if (template !== undefined && !stringField(template)) fail(env, 'invalid-params', 'patchDraft.template must be a string.')
  const editor = env.read().editor
  if (!editor) fail(env, 'conflict', 'No automation editor is open.')
  const changes = validateDraftPatch(input.patch, editor.draft, env)
  let draft = template === undefined ? { ...editor.draft } : applyTemplate(editor.draft, template, env)
  draft = { ...draft, ...changes }
  if (template !== undefined) draft.launchOverrides = null
  if (changes.agentId !== undefined && changes.agentId !== editor.draft.agentId) draft.launchOverrides = null

  const projectChanged = changes.projectId !== undefined && changes.projectId !== editor.draft.projectId
  const requestedNewRun = changes.workspaceMode === 'new_per_run'
  const requestedReuse = changes.reuseSession === true && !requestedNewRun
  if (requestedReuse) draft.workspaceMode = 'existing'
  if (requestedNewRun) draft.reuseSession = false
  const modeChanged = draft.workspaceMode !== editor.draft.workspaceMode
  const needsWorkspaceDefault = projectChanged || (modeChanged && draft.workspaceMode === 'existing') ||
    (requestedReuse && !draft.workspaceId)
  if (draft.workspaceMode === 'new_per_run') {
    draft.workspaceId = null
    draft.reuseSession = false
    if ((projectChanged || editor.draft.workspaceMode !== 'new_per_run') && changes.setupDecision === undefined) draft.setupDecision = 'skip'
  } else {
    draft.baseBranch = null
    if (needsWorkspaceDefault && changes.workspaceId === undefined) {
      try {
        const rows = await readWorkspaceRows(env, draft.projectId, 'Workspaces could not be loaded')
        const chosen = rows.find((item) => item.repoId === draft.projectId && item.isMain === true)
        draft.workspaceId = chosen && stringField(chosen.id) ? chosen.id : null
      } catch {
        draft.workspaceId = null
      }
    }
    if (projectChanged && changes.setupDecision === undefined) draft.setupDecision = 'skip'
  }
  if (projectChanged && changes.baseBranch === undefined) draft.baseBranch = null
  return env.update((state) => {
    if (!state.editor || state.editor.creationKey !== editor.creationKey) fail(env, 'conflict', 'The automation editor changed before the draft update completed.')
    state.editor = { ...state.editor, draft }
  })
}

async function saveEditor(env: AutomationUiEnv, params: unknown): Promise<AutomationDefinition> {
  const input = expectParams(env, params, 'saveEditor', ['trustSetup'])
  if (input.trustSetup !== undefined && typeof input.trustSetup !== 'boolean') {
    fail(env, 'invalid-params', 'saveEditor.trustSetup must be a boolean.')
  }
  const editor = env.read().editor
  if (!editor) fail(env, 'conflict', 'No automation editor is open.')
  const draft = editor.draft
  if (!draft.prompt.trim()) fail(env, 'invalid-params', 'Choose a run location and enter a prompt before saving.')
  if (!draft.timezone.trim() || !isValidAutomationSchedule(draft.rrule, draft.timezone)) {
    if (!draft.timezone.trim() || !timezoneIsValid(draft.timezone)) fail(env, 'invalid-params', 'Choose a valid IANA time zone before saving.')
    const message = draft.rrule.includes('=')
      ? 'Pick a supported schedule before saving.'
      : 'Enter a valid advanced schedule before saving.'
    fail(env, 'invalid-params', message)
  }
  if (!GRACE_VALUES.has(draft.missedRunGraceMinutes)) fail(env, 'invalid-params', 'Choose a supported missed-run grace period.')

  let agentCatalog: AgentCatalog
  try {
    agentCatalog = parseAgents(await env.context.call('quirky.agents/list'))
  } catch (error) {
    fail(env, 'conflict', `Agent catalog could not be loaded: ${errorMessage(error)}`)
  }
  const selectedAgent = agentCatalog.agents.find((agent) => agent.id === draft.agentId)
  const agentChanged = editor.original === null || draft.agentId !== editor.original.agentId
  if (agentChanged && (!selectedAgent?.enabled || !selectedAgent.installed)) {
    fail(env, 'invalid-params', 'Choose an enabled agent before saving.')
  }

  const { details, workspaces } = await validateSelectedTarget(env, draft)
  await validateTargetOwner(env, editor, draft)
  const trustSetup = typeof input.trustSetup === 'boolean' ? input.trustSetup : undefined
  const setupDecision = await setupDecisionForSave(env, draft, trustSetup, workspaces, details)
  const precheck = draft.precheck === null || !draft.precheck.command.trim()
    ? null
    : { command: draft.precheck.command, timeoutSeconds: draft.precheck.timeoutSeconds }

  let saved: AutomationDefinition
  if (!editor.original) {
    saved = await env.service.create({
      creationKey: editor.creationKey,
      name: draft.name,
      prompt: draft.prompt,
      agentId: draft.agentId,
      projectId: draft.projectId,
      workspaceMode: draft.workspaceMode,
      workspaceId: draft.workspaceMode === 'existing' ? draft.workspaceId : null,
      baseBranch: draft.workspaceMode === 'new_per_run' ? draft.baseBranch : null,
      ...(draft.workspaceMode === 'new_per_run' ? { setupDecision } : {}),
      reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
      runContext: draft.runContext,
      sourceContext: draft.sourceContext,
      launchOverrides: draft.launchOverrides,
      precheck,
      timezone: draft.timezone,
      rrule: draft.rrule,
      enabled: true,
      missedRunGraceMinutes: draft.missedRunGraceMinutes
    })
  } else {
    const patch = changedEditFields(draft, editor.original)
    const desiredSetup = draft.workspaceMode === 'new_per_run' ? setupDecision : 'skip'
    if (draft.workspaceMode === 'new_per_run' && desiredSetup !== (editor.original.setupDecision ?? 'skip')) patch.setupDecision = desiredSetup
    if (Object.keys(patch).length === 0) {
      saved = editor.original
    } else {
      saved = await env.service.edit({
        id: editor.original.id,
        ...patch,
        ...(editor.original.owner === undefined ? {} : { expectedOwner: editor.original.owner })
      })
    }
  }
  env.update((state) => {
    if (state.editor?.creationKey === editor.creationKey) state.editor = null
  })
  return saved
}

function timezoneIsValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

function cancelEditor(env: AutomationUiEnv, params: unknown): AutomationUiState {
  expectEmpty(env, params, 'cancelEditor')
  return env.update((state) => { state.editor = null })
}

export function editorMethods(env: AutomationUiEnv): AutomationMethods {
  const methods: Record<string, MethodHandler> = {
    editorData: async (params) => {
      expectEmpty(env, params, 'editorData')
      return (await editorCatalog(env)).data
    },
    openEditor: (params, caller) => openEditor(env, params, caller),
    patchDraft: (params) => patchDraft(env, params),
    saveEditor: (params) => saveEditor(env, params),
    cancelEditor: (params) => cancelEditor(env, params)
  }
  return methods
}
