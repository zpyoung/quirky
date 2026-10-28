import type { ProjectPreferences, ProjectTarget, TaskMethodTable, TasksEnv, TasksState } from '../contracts'

type Params = Record<string, unknown>
type ProjectIdentity = { owner: string; ownerType: ProjectTarget['ownerType']; number: number; host?: string; url?: string }
type ProjectEditAction = 'field' | 'issue' | 'issueType'
type ViewSelector = { viewId?: string; viewNumber?: number; viewName?: string }
type DiscoveryEntry = { cachedAt: number; result: Params }
type ProjectViewOwnership = {
  beginSelection(): number
  isCurrentSelection(request: number): boolean
  beginQuery(requestKey: string): number
  claimQuery(requestKey: string, viewKey: string, request: number): boolean
}

const DISCOVERY_TTL_MS = 5 * 60_000
const DISCOVERY_CACHE_CAPACITY = 32
const MAX_PROJECTS = 50
const MAX_RECENT_PROJECTS = 10
const MAX_PREFERENCE_PROJECTS = 100
const MAX_PREFERENCE_COLUMNS = 100
const MAX_PROJECT_ID_LENGTH = 256
const MAX_QUERY_BYTES = 8192
const PROJECT_EDIT_PARAMS: Record<ProjectEditAction, readonly string[]> = {
  field: ['action', 'worktree', 'host', 'projectId', 'itemId', 'fieldId', 'value', 'clear'],
  issue: ['action', 'worktree', 'host', 'projectId', 'itemId', 'number', 'kind', 'title', 'body', 'state', 'stateReason', 'labels', 'assignees', 'addLabels', 'removeLabels', 'addAssignees', 'removeAssignees'],
  issueType: ['action', 'worktree', 'host', 'projectId', 'itemId', 'number', 'kind', 'issueTypeId', 'issueTypeName']
}

function record(value: unknown): Params | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Params : null
}

function fail(message: string): never {
  throw new Error(message)
}


function utf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function boundedString(value: unknown, name: string, maxBytes: number, options: { allowEmpty?: boolean; trim?: boolean } = {}): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0) || utf8Length(value) > maxBytes || (options.trim !== false && value.trim() !== value)) {
    return fail(`${name} must be a ${options.allowEmpty ? 'string' : 'non-empty string'} no longer than ${maxBytes} UTF-8 bytes.`)
  }
  return value
}

function positiveInteger(value: unknown, name: string, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return fail(`${name} must be a positive integer no greater than ${maximum}.`)
  }
  return value
}

function validHost(value: unknown): string {
  const host = boundedString(value, 'host', 255)
  if (/[\s/@?#]/.test(host)) return fail('host must be a valid GitHub hostname.')
  try {
    const url = new URL(`https://${host}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.host.toLowerCase() !== host.toLowerCase()) {
      return fail('host must be a valid GitHub hostname.')
    }
  } catch {
    return fail('host must be a valid GitHub hostname.')
  }
  return host
}

function optionalHost(params: Params): string | undefined {
  if (params.host === undefined) return undefined
  return validHost(params.host)
}

function optionalBoolean(params: Params, key: string, defaultValue = false): boolean {
  const value = params[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') return fail(`${key} must be a boolean.`)
  return value
}


async function registeredWorktree(env: TasksEnv, value: unknown): Promise<string> {
  const repositories = await env.repositories()
  const gitRepositories = repositories.filter((repo) => repo.kind === 'git' && typeof repo.worktree === 'string' && repo.worktree.length > 0)
  if (value !== undefined) {
    const worktree = boundedString(value, 'worktree', 4096)
    const matches = gitRepositories.filter((repo) => repo.worktree === worktree)
    if (matches.length !== 1) return fail('worktree must identify one registered local Git repository.')
    return matches[0]!.worktree
  }

  const selectedIds = env.read().navigation.repoIds
  if (selectedIds !== null && selectedIds.length > 0) {
    const selected = gitRepositories.filter((repo) => selectedIds.includes(repo.id))
    if (selected.length === 1) return selected[0]!.worktree
    if (selected.length > 1) return fail('worktree is required when more than one Git repository is selected.')
    return fail('The selected repository is not a registered local Git repository.')
  }
  if (gitRepositories.length === 1) return gitRepositories[0]!.worktree
  if (gitRepositories.length === 0) return fail('A registered local Git repository is required; pass worktree explicitly.')
  return fail('worktree is required when multiple local Git repositories are available.')
}

function hostArgs(host: string | undefined): Params {
  return host === undefined ? {} : { host }
}

async function callHosting(env: TasksEnv, method: string, params: Params): Promise<unknown> {
  return env.context.call(`quirky.hosting/${method}`, params)
}

function validateProjectUrl(value: unknown, host?: string): string {
  const urlValue = boundedString(value, 'project.url', 2048)
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return fail('project.url must be an HTTPS URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (host !== undefined && url.host.toLowerCase() !== host.toLowerCase())) {
    return fail('project.url must be a credential-free HTTPS project URL matching its host.')
  }
  return urlValue
}

function validateProjectTarget(value: unknown): ProjectTarget {
  const raw = record(value)
  if (!raw) return fail('project must be an object containing a resolved project target.')
  const id = boundedString(raw.id, 'project.id', MAX_PROJECT_ID_LENGTH)
  if (/[\u0000-\u0020]/.test(id)) return fail('project.id must not contain whitespace.')
  const owner = boundedString(raw.owner, 'project.owner', 256)
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return fail('project.owner must be a valid GitHub login.')
  if (raw.ownerType !== 'user' && raw.ownerType !== 'organization') return fail('project.ownerType must be user or organization.')
  const number = positiveInteger(raw.number, 'project.number')
  const configuredHost = raw.host === undefined ? undefined : validHost(raw.host)
  const url = validateProjectUrl(raw.url, configuredHost)
  const host = configuredHost ?? new URL(url).host
  const title = raw.title === undefined ? undefined : boundedString(raw.title, 'project.title', 4096, { allowEmpty: true, trim: false })
  const viewId = raw.viewId === undefined ? undefined : boundedString(raw.viewId, 'project.viewId', MAX_PROJECT_ID_LENGTH)
  const viewNumber = raw.viewNumber === undefined ? undefined : positiveInteger(raw.viewNumber, 'project.viewNumber')
  return {
    id,
    owner,
    ownerType: raw.ownerType,
    number,
    url,
    host,
    ...(title === undefined ? {} : { title }),
    ...(viewId === undefined ? {} : { viewId }),
    ...(viewNumber === undefined ? {} : { viewNumber })
  }
}

function projectIdentity(project: ProjectIdentity): string {
  const host = project.host ?? (project.url === undefined ? '' : new URL(project.url).host)
  return JSON.stringify([
    host.toLowerCase(),
    project.ownerType,
    project.owner.trim().toLowerCase(),
    project.number
  ])
}

function sameProject(left: ProjectTarget, right: ProjectTarget): boolean {
  return projectIdentity(left) === projectIdentity(right)
}

function mergeTargetView(target: ProjectTarget, previous: ProjectTarget | undefined): ProjectTarget {
  if (!previous) return target
  return {
    ...target,
    ...(target.title === undefined && previous.title !== undefined ? { title: previous.title } : {}),
    ...(target.viewId === undefined && previous.viewId !== undefined ? { viewId: previous.viewId } : {}),
    ...(target.viewNumber === undefined && previous.viewNumber !== undefined ? { viewNumber: previous.viewNumber } : {})
  }
}

function rememberedProject(target: ProjectTarget, state: TasksState): ProjectTarget {
  const previous = [state.navigation.project, ...state.projects.recent, ...state.projects.pinned]
    .find((candidate): candidate is ProjectTarget => candidate !== null && sameProject(candidate, target))
  return mergeTargetView(target, previous)
}

function upsertTarget(values: ProjectTarget[], target: ProjectTarget, maximum: number): ProjectTarget[] {
  const previous = values.find((value) => sameProject(value, target))
  const merged = mergeTargetView(target, previous)
  return [merged, ...values.filter((value) => !sameProject(value, target))].slice(0, maximum)
}

function setBoundedValue<T>(values: Record<string, T>, key: string, value: T, maximum: number): Record<string, T> {
  const next = { ...values, [key]: value }
  const keys = Object.keys(next)
  if (keys.length > maximum) {
    const oldest = keys.find((candidate) => candidate !== key)
    if (oldest !== undefined) delete next[oldest]
  }
  return next
}

function projectsResult(value: unknown): Params {
  const result = record(value)
  if (!result || !Array.isArray(result.projects) || !Array.isArray(result.partialFailures) || typeof result.truncated !== 'boolean') {
    return fail('quirky.hosting/projects returned an invalid discovery result.')
  }
  return result
}

async function discoverProjects(env: TasksEnv, params: Params, discoveryCache: Map<string, DiscoveryEntry>): Promise<unknown> {
  const host = optionalHost(params)
  const worktree = await registeredWorktree(env, params.worktree)
  const refresh = optionalBoolean(params, 'refresh')
  const cacheKey = JSON.stringify([worktree, host?.toLowerCase() ?? null])
  const now = Date.now()
  for (const [key, entry] of discoveryCache) {
    if (now - entry.cachedAt >= DISCOVERY_TTL_MS) discoveryCache.delete(key)
  }
  if (!refresh) {
    const cached = discoveryCache.get(cacheKey)
    if (cached) {
      discoveryCache.delete(cacheKey)
      discoveryCache.set(cacheKey, cached)
      const ageMs = Math.max(0, now - cached.cachedAt)
      return {
        ...cached.result,
        cache: { hit: true, refreshed: false, ageMs, ttlMs: DISCOVERY_TTL_MS, entryCount: discoveryCache.size, capacity: DISCOVERY_CACHE_CAPACITY }
      }
    }
  }

  const response = projectsResult(await callHosting(env, 'projects', { worktree, ...hostArgs(host) }))
  const cachedAt = Date.now()
  discoveryCache.delete(cacheKey)
  discoveryCache.set(cacheKey, { cachedAt, result: response })
  while (discoveryCache.size > DISCOVERY_CACHE_CAPACITY) {
    const oldest = discoveryCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    discoveryCache.delete(oldest)
  }
  return {
    ...response,
    cache: { hit: false, refreshed: refresh, ageMs: 0, ttlMs: DISCOVERY_TTL_MS, entryCount: discoveryCache.size, capacity: DISCOVERY_CACHE_CAPACITY }
  }
}

function optionalViewNumber(params: Params): number | undefined {
  return params.viewNumber === undefined ? undefined : positiveInteger(params.viewNumber, 'viewNumber')
}

function projectFromReference(value: unknown, hostFallback?: string, viewNumber?: number): ProjectTarget {
  const raw = record(value)
  if (!raw) return fail('quirky.hosting/projectRef returned an invalid project reference.')
  const project = validateProjectTarget({
    ...raw,
    host: raw.host ?? hostFallback,
    ...(viewNumber === undefined ? {} : { viewNumber })
  })
  const view = raw.view
  if (typeof view !== 'string' || view.length === 0) return project
  const viewNumberFromUrl = /^[1-9][0-9]*$/.test(view) ? Number(view) : NaN
  if (Number.isSafeInteger(viewNumberFromUrl) && viewNumberFromUrl <= 2_147_483_647) {
    return viewNumber === undefined ? { ...project, viewNumber: viewNumberFromUrl } : project
  }
  return { ...project, viewId: boundedString(view, 'project view ID', MAX_PROJECT_ID_LENGTH) }
}

async function resolveProjectTarget(
  env: TasksEnv,
  params: Params,
  worktree: string,
  allowOwnerNumber: boolean
): Promise<{ project: ProjectTarget; resolved?: unknown }> {
  const host = optionalHost(params)
  const viewNumber = optionalViewNumber(params)
  let expectedOwnerType: ProjectTarget['ownerType'] | undefined
  if (params.ownerType !== undefined) {
    if (params.ownerType !== 'user' && params.ownerType !== 'organization') return fail('ownerType must be user or organization.')
    expectedOwnerType = params.ownerType
  }
  if (params.project !== undefined) {
    if (params.input !== undefined || params.owner !== undefined || params.projectNumber !== undefined) {
      return fail('provide either project or a project reference, not both.')
    }
    let project = validateProjectTarget(params.project)
    if (expectedOwnerType !== undefined && project.ownerType !== expectedOwnerType) return fail(`The project is not owned by a ${expectedOwnerType}.`)
    if (host !== undefined && project.host !== undefined && host.toLowerCase() !== project.host.toLowerCase()) {
      return fail('host must match project.host.')
    }
    if (viewNumber !== undefined) project = { ...project, viewNumber }
    return { project }
  }

  let input = params.input
  if (input !== undefined && (params.owner !== undefined || params.projectNumber !== undefined)) {
    return fail('provide input or owner/projectNumber, not both.')
  }
  if (input === undefined && allowOwnerNumber && params.owner !== undefined && params.projectNumber !== undefined) {
    const owner = boundedString(params.owner, 'owner', 256)
    if (!/^[A-Za-z0-9-]+$/.test(owner)) return fail('owner must be a valid GitHub login.')
    const number = positiveInteger(params.projectNumber, 'projectNumber')
    input = `${owner}/${number}`
  }
  const reference = boundedString(input, 'input', 2048)
  const resolved = await callHosting(env, 'projectRef', { worktree, input: reference, ...hostArgs(host) })
  const project = projectFromReference(resolved, host, viewNumber)
  if (expectedOwnerType !== undefined && project.ownerType !== expectedOwnerType) return fail(`The resolved project is not owned by a ${expectedOwnerType}.`)
  return { project, resolved }
}

function action(params: Params, values: readonly string[], name = 'action'): string {
  const value = params[name]
  if (typeof value !== 'string' || !values.includes(value)) return fail(`${name} must be one of ${values.join(', ')}.`)
  return value
}

async function selectProject(env: TasksEnv, params: Params): Promise<unknown> {
  const selectedAction = action(params, ['resolve', 'add', 'select', 'clear', 'pin', 'unpin'])
  if (selectedAction === 'clear') {
    await env.navigate({ mode: 'projects', project: null })
    return { action: selectedAction, project: null, selected: true }
  }

  let resolved: unknown
  let target: ProjectTarget
  if (params.project === undefined || params.input !== undefined || params.owner !== undefined) {
    const worktree = await registeredWorktree(env, params.worktree)
    const result = await resolveProjectTarget(env, params, worktree, true)
    target = result.project
    resolved = result.resolved
  } else {
    const result = await resolveProjectTarget(env, params, '', false)
    target = result.project
    resolved = result.resolved
  }
  const current = env.read()
  target = rememberedProject(target, current)

  if (selectedAction === 'resolve') {
    return { action: selectedAction, project: target, ...(resolved === undefined ? {} : { resolved }) }
  }
  if (selectedAction === 'add') {
    const updated = env.update((state) => {
      state.projects = { ...state.projects, recent: upsertTarget(state.projects.recent, target, MAX_RECENT_PROJECTS) }
    })
    await env.navigate({ mode: 'projects', project: target })
    return { action: selectedAction, project: target, added: true, selected: true, preferences: updated.projects, ...(resolved === undefined ? {} : { resolved }) }
  }
  if (selectedAction === 'pin' || selectedAction === 'unpin') {
    const updated = env.update((state) => {
      const pinned = selectedAction === 'pin'
        ? upsertTarget(state.projects.pinned, target, MAX_PROJECTS)
        : state.projects.pinned.filter((project) => !sameProject(project, target))
      state.projects = { ...state.projects, pinned }
    })
    return { action: selectedAction, project: target, pinned: selectedAction === 'pin', preferences: updated.projects }
  }

  const updated = env.update((state) => {
    state.projects = { ...state.projects, recent: upsertTarget(state.projects.recent, target, MAX_RECENT_PROJECTS) }
  })
  await env.navigate({ mode: 'projects', project: target })
  return { action: selectedAction, project: target, selected: true, preferences: updated.projects, ...(resolved === undefined ? {} : { resolved }) }
}

function projectViewsResult(value: unknown): Params {
  const result = record(value)
  if (!result || !Array.isArray(result.views) || typeof result.truncated !== 'boolean') {
    return fail('quirky.hosting/projectViews returned an invalid view result.')
  }
  return result
}

function returnedViews(result: Params): Params[] {
  if (!Array.isArray(result.views)) return fail('quirky.hosting/projectViews returned an invalid view result.')
  return result.views.map((view: unknown) => {
    const item = record(view)
    if (!item) return fail('quirky.hosting/projectViews returned an invalid view.')
    return item
  })
}

function parseViewSelector(params: Params): ViewSelector {
  const viewId = params.viewId === undefined ? undefined : boundedString(params.viewId, 'viewId', MAX_PROJECT_ID_LENGTH)
  const viewNumber = optionalViewNumber(params)
  const viewName = params.viewName === undefined ? undefined : boundedString(params.viewName, 'viewName', 256)
  const count = Number(viewId !== undefined) + Number(viewNumber !== undefined) + Number(viewName !== undefined)
  if (count > 1) return fail('provide only one of viewId, viewNumber, or viewName.')
  return {
    ...(viewId === undefined ? {} : { viewId }),
    ...(viewNumber === undefined ? {} : { viewNumber }),
    ...(viewName === undefined ? {} : { viewName })
  }
}

function selectView(views: Params[], selector: ViewSelector, fallbackId?: string): Params | undefined {
  if (selector.viewId !== undefined) return views.find((view) => view.id === selector.viewId)
  if (selector.viewNumber !== undefined) return views.find((view) => view.number === selector.viewNumber)
  if (selector.viewName !== undefined) return views.find((view) => typeof view.name === 'string' && view.name.toLowerCase() === selector.viewName!.toLowerCase())
  if (fallbackId !== undefined) return views.find((view) => view.id === fallbackId)
  return undefined
}

function defaultView(views: Params[]): Params | undefined {
  return views.find((view) => view.layout === 'TABLE') ?? views.find((view) => view.layout === 'ROADMAP') ?? views.find((view) => view.layout === 'BOARD')
}

function validViewId(view: Params | undefined): string | undefined {
  if (!view || view.id === undefined) return undefined
  return boundedString(view.id, 'view.id', MAX_PROJECT_ID_LENGTH)
}

function queryViewIdentity(project: ProjectTarget, viewId: string): string {
  return JSON.stringify([projectIdentity(project), viewId])
}

function viewQueryKey(view: Params | undefined, selector: ViewSelector): string | undefined {
  const id = validViewId(view)
  if (id !== undefined) return id
  if (selector.viewId !== undefined) return selector.viewId
  if (selector.viewNumber !== undefined) return `number:${selector.viewNumber}`
  if (selector.viewName !== undefined) return `name:${selector.viewName.toLowerCase()}`
  return undefined
}
function projectViewRequestKey(
  env: TasksEnv,
  params: Params,
  hasTarget: boolean,
  navigationProject: ProjectTarget | null,
  selector: ViewSelector
): string {
  const target = params.project === undefined ? hasTarget ? null : navigationProject : validateProjectTarget(params.project)
  const targetKey = target
    ? projectIdentity(target)
    : JSON.stringify([
        'reference',
        typeof params.host === 'string' ? params.host.toLowerCase() : '',
        params.input !== undefined ? String(params.input) : [params.owner ?? '', params.projectNumber ?? '', params.ownerType ?? '']
      ])
  let viewKey = 'default'
  if (selector.viewId !== undefined) viewKey = selector.viewId
  else if (selector.viewNumber !== undefined) viewKey = `number:${selector.viewNumber}`
  else if (selector.viewName !== undefined) viewKey = `name:${selector.viewName.toLowerCase()}`
  else if (target?.viewId !== undefined) viewKey = target.viewId
  else if (target?.viewNumber !== undefined) viewKey = `number:${target.viewNumber}`
  else if (target) viewKey = env.read().projects.lastViewByProject[targetKey] ?? viewKey
  return JSON.stringify([targetKey, viewKey])
}

async function projectView(env: TasksEnv, params: Params, ownership: ProjectViewOwnership): Promise<unknown> {
  const selectedAction = action(params, ['list', 'select', 'load', 'refresh'])
  const hasTarget = params.project !== undefined || params.input !== undefined || params.owner !== undefined || params.projectNumber !== undefined
  const navigationProject = hasTarget ? null : env.read().navigation.project
  const explicitSelector = selectedAction === 'list' ? {} : parseViewSelector(params)
  const tableAction = selectedAction === 'load' || selectedAction === 'refresh'
  const clearQueryOverride = tableAction ? optionalBoolean(params, 'clearQueryOverride') : false
  const hasQueryOverride = tableAction && params.query !== undefined
  if (hasQueryOverride && clearQueryOverride) return fail('query cannot be combined with clearQueryOverride.')
  const queryOverride = hasQueryOverride ? boundedString(params.query, 'query', MAX_QUERY_BYTES, { allowEmpty: true, trim: false }) : undefined
  const selectionRequest = selectedAction === 'select' ? ownership.beginSelection() : undefined
  const queryWriteRequested = hasQueryOverride || clearQueryOverride
  const queryRequestKey = queryWriteRequested
    ? projectViewRequestKey(env, params, hasTarget, navigationProject, explicitSelector)
    : undefined
  const queryRequest = queryRequestKey === undefined ? undefined : ownership.beginQuery(queryRequestKey)
  const worktree = await registeredWorktree(env, params.worktree)
  if (!hasTarget && navigationProject === null) return fail('A project or selected project is required.')
  const targetParams = hasTarget ? params : { ...params, project: navigationProject }
  const { project, resolved } = await resolveProjectTarget(env, targetParams, worktree, true)
  const viewsPayload = projectViewsResult(await callHosting(env, 'projectViews', {
    worktree,
    owner: project.owner,
    ownerType: project.ownerType,
    projectNumber: project.number,
    ...hostArgs(project.host)
  }))
  if (selectedAction === 'list') {
    return { action: selectedAction, project, result: viewsPayload, ...(resolved === undefined ? {} : { resolved }) }
  }

  const views = returnedViews(viewsPayload)
  const projectSelector: ViewSelector = explicitSelector.viewId !== undefined || explicitSelector.viewNumber !== undefined || explicitSelector.viewName !== undefined
    ? explicitSelector
    : {
        ...(project.viewId === undefined ? {} : { viewId: project.viewId }),
        ...(project.viewId === undefined && project.viewNumber !== undefined ? { viewNumber: project.viewNumber } : {})
      }
  const key = projectIdentity(project)
  const rememberedView = env.read().projects.lastViewByProject[key]
  let selectedView = selectView(views, projectSelector, rememberedView)
  let tableSelector: ViewSelector = projectSelector
  if (selectedAction === 'select') {
    if (!projectSelector.viewId && !projectSelector.viewNumber && !projectSelector.viewName) {
      return fail('select requires viewId, viewNumber, viewName, or a project with a selected view.')
    }
    if (!selectedView) return fail('The requested project view was not returned by quirky.hosting/projectViews.')
  } else if (!projectSelector.viewId && !projectSelector.viewNumber && !projectSelector.viewName) {
    if (rememberedView !== undefined) {
      tableSelector = { viewId: rememberedView }
    } else {
      selectedView = defaultView(views)
      const selectedViewId = validViewId(selectedView)
      tableSelector = selectedViewId === undefined ? {} : { viewId: selectedViewId }
    }
  }

  if (selectedAction === 'select') {
    const viewId = validViewId(selectedView)
    if (viewId === undefined) return fail('The selected project view has no stable ID.')
    const viewNumber = selectedView?.number === undefined ? project.viewNumber : positiveInteger(selectedView.number, 'view.number')
    const selectedProject: ProjectTarget = {
      ...project,
      viewId,
      ...(viewNumber === undefined ? {} : { viewNumber })
    }
    if (selectionRequest === undefined || !ownership.isCurrentSelection(selectionRequest)) {
      return { action: selectedAction, project: selectedProject, view: selectedView, result: viewsPayload, preferences: env.read().projects }
    }
    const updated = env.update((state) => {
      state.projects = {
        ...state.projects,
        recent: upsertTarget(state.projects.recent, selectedProject, MAX_RECENT_PROJECTS),
        lastViewByProject: setBoundedValue(state.projects.lastViewByProject, key, viewId, MAX_PREFERENCE_PROJECTS)
      }
    })
    await env.navigate({ mode: 'projects', project: selectedProject })
    const selectedPreferences = ownership.isCurrentSelection(selectionRequest) ? updated.projects : env.read().projects
    return { action: selectedAction, project: selectedProject, view: selectedView, result: viewsPayload, preferences: selectedPreferences }
  }

  const selectorKey = viewQueryKey(selectedView, tableSelector)
  const queryKey = selectorKey === undefined ? undefined : queryViewIdentity(project, selectorKey)
  const preferences = env.read().projects
  const storedQuery = queryKey === undefined ? undefined : preferences.queryByView[queryKey]
  const querySource = hasQueryOverride ? 'explicit' : clearQueryOverride ? 'view-filter' : storedQuery !== undefined ? 'stored' : 'view-filter'
  const effectiveQuery = hasQueryOverride ? queryOverride : clearQueryOverride ? undefined : storedQuery
  if (queryKey !== undefined && queryRequestKey !== undefined && queryRequest !== undefined) {
    ownership.claimQuery(queryRequestKey, queryKey, queryRequest)
  }
  const tableParams: Params = {
    worktree,
    owner: project.owner,
    ownerType: project.ownerType,
    projectNumber: project.number,
    ...tableSelector,
    ...(effectiveQuery === undefined ? {} : { queryOverride: effectiveQuery }),
    ...hostArgs(project.host),
    ...(selectedAction === 'refresh' ? { noCache: true } : {})
  }
  const table = await callHosting(env, 'projectTable', tableParams)
  if (queryKey !== undefined && (hasQueryOverride || clearQueryOverride) && queryRequestKey !== undefined && queryRequest !== undefined &&
    ownership.claimQuery(queryRequestKey, queryKey, queryRequest)) {
    env.update((state) => {
      const queryByView = { ...state.projects.queryByView }
      if (clearQueryOverride) delete queryByView[queryKey]
      else queryByView[queryKey] = queryOverride!
      const keys = Object.keys(queryByView)
      if (keys.length > MAX_PREFERENCE_PROJECTS) {
        const oldest = keys.find((candidate) => candidate !== queryKey)
        if (oldest !== undefined) delete queryByView[oldest]
      }
      state.projects = { ...state.projects, queryByView }
    })
  }
  return {
    action: selectedAction,
    project,
    ...(selectedView === undefined ? {} : { view: selectedView }),
    query: { source: querySource, ...(effectiveQuery === undefined ? {} : { override: effectiveQuery }), ...(queryKey === undefined ? {} : { preferenceKey: queryKey }) },
    result: table,
    ...(resolved === undefined ? {} : { resolved })
  }
}

function projectFieldValue(value: unknown): Params {
  const raw = record(value)
  if (!raw || Object.keys(raw).length !== 1) return fail('value must contain exactly one supported project field value.')
  const [key] = Object.keys(raw)
  if (key === 'text') return { text: boundedString(raw.text, 'text field value', MAX_QUERY_BYTES, { allowEmpty: true, trim: false }) }
  if (key === 'number') {
    if (typeof raw.number !== 'number' || !Number.isFinite(raw.number)) return fail('number field values must be finite numbers.')
    return { number: raw.number }
  }
  if (key === 'date') {
    if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return fail('date field values must use YYYY-MM-DD.')
    return { date: raw.date }
  }
  if (key === 'singleSelectOptionId' || key === 'iterationId') {
    return { [key]: boundedString(raw[key], key, MAX_PROJECT_ID_LENGTH) }
  }
  if (key === 'multiSelectOptionIds') {
    if (!Array.isArray(raw.multiSelectOptionIds) || raw.multiSelectOptionIds.length > 100) return fail('multiSelectOptionIds must contain up to 100 non-empty identifiers.')
    return { multiSelectOptionIds: raw.multiSelectOptionIds.map((item, index) => boundedString(item, `multiSelectOptionIds[${index}]`, MAX_PROJECT_ID_LENGTH)) }
  }
  return fail('value must contain exactly one supported project field value.')
}

function projectMutationId(params: Params, key: string): string {
  const value = boundedString(params[key], key, MAX_PROJECT_ID_LENGTH)
  if (/[\u0000-\u0020]/.test(value)) return fail(`${key} must not contain whitespace.`)
  return value
}

function boundedTextList(params: Params, key: string): string[] | undefined {
  if (params[key] === undefined) return undefined
  const value = params[key]
  if (!Array.isArray(value) || value.length > 100) return fail(`${key} must contain up to 100 strings.`)
  return value.map((item, index) => boundedString(item, `${key}[${index}]`, 256))
}

async function editProject(env: TasksEnv, params: Params): Promise<unknown> {
  const selectedAction = action(params, ['field', 'issue', 'issueType']) as ProjectEditAction
  if (Object.keys(params).some((key) => !PROJECT_EDIT_PARAMS[selectedAction].includes(key))) {
    return fail(`projectEdit received fields that are not valid for action ${selectedAction}.`)
  }
  const worktree = await registeredWorktree(env, params.worktree)
  const host = optionalHost(params)
  const projectId = projectMutationId(params, 'projectId')
  const itemId = projectMutationId(params, 'itemId')
  if (selectedAction === 'field') {
    const fieldId = projectMutationId(params, 'fieldId')
    const clear = optionalBoolean(params, 'clear')
    if (clear && params.value !== undefined) return fail('value cannot be combined with clear:true.')
    if (!clear && params.value === undefined) return fail('value is required unless clear is true.')
    const result = await callHosting(env, 'projectField', {
      worktree,
      projectId,
      itemId,
      fieldId,
      clear,
      ...(clear ? {} : { value: projectFieldValue(params.value) }),
      ...hostArgs(host)
    })
    return { action: selectedAction, result }
  }

  const number = positiveInteger(params.number, 'number')
  if (params.kind !== 'issue' && params.kind !== 'pullRequest') return fail('kind must be issue or pullRequest.')
  const kind = params.kind
  if (selectedAction === 'issueType' && kind !== 'issue') return fail('issueType requires kind issue.')
  const hostingAction = selectedAction === 'issue' ? kind === 'issue' ? 'editIssue' : 'editReview' : 'updateIssueType'
  const apiParams: Params = { worktree, action: hostingAction, projectId, itemId, number, kind, ...hostArgs(host) }
  if (selectedAction === 'issue') {
    for (const key of ['title', 'body'] as const) {
      if (params[key] !== undefined) apiParams[key] = boundedString(params[key], key, key === 'title' ? 256 : 65_536, { allowEmpty: key === 'body', trim: false })
    }
    if (params.state !== undefined) {
      if (params.state !== 'open' && params.state !== 'closed') return fail('state must be open or closed.')
      apiParams.state = params.state
    }
    if (params.stateReason !== undefined) {
      if (params.stateReason !== 'completed' && params.stateReason !== 'not_planned') return fail('stateReason must be completed or not_planned.')
      apiParams.stateReason = params.stateReason
    }
    if (kind === 'issue') {
      for (const key of ['labels', 'assignees', 'addLabels', 'removeLabels', 'addAssignees', 'removeAssignees'] as const) {
        const values = boundedTextList(params, key)
        if (values !== undefined) apiParams[key] = values
      }
    } else if (['labels', 'assignees', 'addLabels', 'removeLabels', 'addAssignees', 'removeAssignees'].some((key) => params[key] !== undefined)) {
      return fail('labels and assignees are only supported for issue edits.')
    }
  } else {
    const issueTypeId = params.issueTypeId === undefined ? undefined : boundedString(params.issueTypeId, 'issueTypeId', MAX_PROJECT_ID_LENGTH)
    const issueTypeName = params.issueTypeName === undefined ? undefined : boundedString(params.issueTypeName, 'issueTypeName', 256)
    if (issueTypeId !== undefined && issueTypeName !== undefined) return fail('issueType accepts at most one of issueTypeId or issueTypeName.')
    if (issueTypeId !== undefined) apiParams.issueTypeId = issueTypeId
    if (issueTypeName !== undefined) apiParams.issueTypeName = issueTypeName
    // With neither selector, the public hosting method returns the available issue types without a write.
  }
  const result = await callHosting(env, 'projectItemMutation', apiParams)
  return { action: selectedAction, result }
}

function uniqueStrings(value: unknown, label: string, maximum: number, itemBytes = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(`${label} must be an array of at most ${maximum} strings.`)
  const values = value.map((item, index) => boundedString(item, `${label}[${index}]`, itemBytes))
  if (new Set(values).size !== values.length) return fail(`${label} must not contain duplicates.`)
  return values
}

function safePreferenceKey(value: string, name: string, maxBytes = 2048): string {
  const key = boundedString(value, name, maxBytes)
  if (['__proto__', 'constructor', 'prototype'].includes(key)) return fail(`${name} is not a valid preference key.`)
  return key
}

function parseProjectTargets(value: unknown, name: string, maximum: number): ProjectTarget[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(`${name} must contain at most ${maximum} projects.`)
  const targets = value.map((item) => validateProjectTarget(item))
  const identities = targets.map(projectIdentity)
  if (new Set(identities).size !== identities.length) return fail(`${name} must not contain duplicate project identities.`)
  return targets
}

function parseLastViews(value: unknown): Record<string, string> {
  const raw = record(value)
  if (!raw) return fail('lastViewByProject must be an object.')
  const entries = Object.entries(raw)
  if (entries.length > MAX_PREFERENCE_PROJECTS) return fail(`lastViewByProject may contain at most ${MAX_PREFERENCE_PROJECTS} projects.`)
  const result: Record<string, string> = {}
  for (const [key, viewId] of entries) result[safePreferenceKey(key, 'lastViewByProject key')] = boundedString(viewId, 'lastViewByProject view ID', MAX_PROJECT_ID_LENGTH)
  return result
}

function parseQueries(value: unknown): Record<string, string> {
  const raw = record(value)
  if (!raw) return fail('queryByView must be an object.')
  const entries = Object.entries(raw)
  if (entries.length > MAX_PREFERENCE_PROJECTS) return fail(`queryByView may contain at most ${MAX_PREFERENCE_PROJECTS} views.`)
  const result: Record<string, string> = {}
  for (const [key, query] of entries) result[safePreferenceKey(key, 'queryByView key')] = boundedString(query, 'queryByView value', MAX_QUERY_BYTES, { allowEmpty: true, trim: false })
  return result
}

function parseHiddenColumns(value: unknown): Record<string, string[]> {
  const raw = record(value)
  if (!raw) return fail('hiddenColumns must be an object.')
  const entries = Object.entries(raw)
  if (entries.length > MAX_PREFERENCE_PROJECTS) return fail(`hiddenColumns may contain at most ${MAX_PREFERENCE_PROJECTS} projects.`)
  const result: Record<string, string[]> = {}
  for (const [key, columns] of entries) result[safePreferenceKey(key, 'hiddenColumns key')] = uniqueStrings(columns, 'hiddenColumns values', MAX_PREFERENCE_COLUMNS)
  return result
}

function parseColumnWidths(value: unknown): Record<string, Record<string, number>> {
  const raw = record(value)
  if (!raw) return fail('columnWidths must be an object.')
  const entries = Object.entries(raw)
  if (entries.length > MAX_PREFERENCE_PROJECTS) return fail(`columnWidths may contain at most ${MAX_PREFERENCE_PROJECTS} projects.`)
  const result: Record<string, Record<string, number>> = {}
  for (const [projectKey, columnsValue] of entries) {
    const columns = record(columnsValue)
    if (!columns) return fail(`columnWidths.${projectKey} must be an object.`)
    const columnEntries = Object.entries(columns)
    if (columnEntries.length > MAX_PREFERENCE_COLUMNS) return fail(`columnWidths.${projectKey} may contain at most ${MAX_PREFERENCE_COLUMNS} columns.`)
    const widths: Record<string, number> = {}
    for (const [column, width] of columnEntries) {
      safePreferenceKey(column, 'columnWidths column', 256)
      if (typeof width !== 'number' || !Number.isInteger(width) || width < 60 || width > 1200) return fail('columnWidths values must be integers from 60 to 1200.')
      widths[column] = width
    }
    result[safePreferenceKey(projectKey, 'columnWidths key')] = widths
  }
  return result
}

function preferenceChanges(value: unknown): Partial<ProjectPreferences> {
  const raw = record(value)
  if (!raw) return fail('changes must be an object of project preference fields.')
  const keys = Object.keys(raw)
  if (keys.length === 0) return fail('changes must include at least one project preference field.')
  const allowed = new Set(['pinned', 'recent', 'lastViewByProject', 'queryByView', 'hiddenColumns', 'columnWidths', 'roadmapZoom'])
  if (keys.some((key) => !allowed.has(key))) return fail('changes contains an unsupported project preference field.')
  const changes: Partial<ProjectPreferences> = {}
  for (const key of keys) {
    switch (key) {
      case 'pinned': changes.pinned = parseProjectTargets(raw.pinned, 'pinned', MAX_PROJECTS); break
      case 'recent': changes.recent = parseProjectTargets(raw.recent, 'recent', MAX_RECENT_PROJECTS); break
      case 'lastViewByProject': changes.lastViewByProject = parseLastViews(raw.lastViewByProject); break
      case 'queryByView': changes.queryByView = parseQueries(raw.queryByView); break
      case 'hiddenColumns': changes.hiddenColumns = parseHiddenColumns(raw.hiddenColumns); break
      case 'columnWidths': changes.columnWidths = parseColumnWidths(raw.columnWidths); break
      case 'roadmapZoom':
        if (raw.roadmapZoom !== 'month' && raw.roadmapZoom !== 'quarter' && raw.roadmapZoom !== 'year') return fail('roadmapZoom must be month, quarter, or year.')
        changes.roadmapZoom = raw.roadmapZoom
        break
    }
  }
  return changes
}

async function projectPreferences(env: TasksEnv, params: Params): Promise<unknown> {
  if (params.patch === undefined) {
    if (params.action !== undefined) action(params, ['read'])
    return { action: 'read', preferences: env.read().projects }
  }
  if (params.action !== undefined) action(params, ['update'])
  const changes = preferenceChanges(params.patch)
  const updated = env.update((state) => {
    state.projects = { ...state.projects, ...changes }
  })
  return { action: 'update', updated: true, preferences: updated.projects }
}

export function projectMethods(env: TasksEnv): TaskMethodTable {
  const discoveryCache = new Map<string, DiscoveryEntry>()
  const queryGenerations = new Map<string, number>()
  let selectionGeneration = 0
  let queryGeneration = 0
  const trimQueryGenerations = (first: string, second?: string) => {
    if (queryGenerations.size <= MAX_PREFERENCE_PROJECTS * 2) return
    for (const key of queryGenerations.keys()) {
      if (key !== first && key !== second) {
        queryGenerations.delete(key)
        return
      }
    }
  }
  const ownership: ProjectViewOwnership = {
    beginSelection: () => ++selectionGeneration,
    isCurrentSelection: (request) => request === selectionGeneration,
    beginQuery(requestKey) {
      const request = ++queryGeneration
      queryGenerations.delete(requestKey)
      queryGenerations.set(requestKey, request)
      trimQueryGenerations(requestKey)
      return request
    },
    claimQuery(requestKey, viewKey, request) {
      if (queryGenerations.get(requestKey) !== request) return false
      const currentViewRequest = queryGenerations.get(viewKey)
      if (currentViewRequest !== undefined && currentViewRequest > request) return false
      queryGenerations.delete(viewKey)
      queryGenerations.set(viewKey, request)
      trimQueryGenerations(requestKey, viewKey)
      return true
    }
  }
  return {
    projects: (params) => discoverProjects(env, params, discoveryCache),
    projectSelect: (params) => selectProject(env, params),
    projectView: (params) => projectView(env, params, ownership),
    projectEdit: (params) => editProject(env, params),
    projectPreferences: (params) => projectPreferences(env, params)
  }
}
