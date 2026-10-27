import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  array,
  ensureOutputBound,
  positiveCount,
  nonEmptyString,
  positiveInteger,
  positiveParam,
  record,
  safeErrorReason,
} from './item-data'
import { projectError } from './project-errors'
import { parseProjectReference, projectGraphql, resolveProjectHost, type ProjectOwnerType } from './project-ref'

const DISCOVERY_QUERY = `query ProjectDiscovery($cursor: String, $orgCursor: String) {
  viewer { login projectsV2(first: 20, after: $cursor) { nodes { id number title url closed shortDescription public } pageInfo { endCursor hasNextPage } totalCount } organizations(first: 20, after: $orgCursor) { nodes { login name url } pageInfo { endCursor hasNextPage } } }
}`
const OWNER_PROJECT_QUERY = `query ProjectOwner($owner: String!, $number: Int!) {
  organization(login: $owner) { login projectV2(number: $number) { id number title url closed shortDescription public } }
  user(login: $owner) { login projectV2(number: $number) { id number title url closed shortDescription public } }
}`
const ORG_PROJECT_QUERY = `query OrganizationProjects($login: String!) {
  organization(login: $login) { login projectsV2(first: 20) { nodes { id number title url closed shortDescription public } pageInfo { hasNextPage } totalCount } }
}`
const VIEWER_PROJECT_PAGE_QUERY = `query ViewerProjectPage($cursor: String) {
  viewer { projectsV2(first: 20, after: $cursor) { nodes { id number title url closed shortDescription public } pageInfo { endCursor hasNextPage } totalCount } }
}`
const VIEW_QUERY_WITH_VERTICAL = `query ProjectViews($owner: String!, $number: Int!, $cursor: String) {
  organization(login: $owner) { projectV2(number: $number) { views(first: 20, after: $cursor) { nodes { id number name layout filter fields(first: 50) { nodes { id name dataType options { id name } } } groupByFields(first: 10) { nodes { id name } } verticalGroupByFields(first: 10) { nodes { id name } } sortByFields(first: 10) { nodes { id name } } } pageInfo { endCursor hasNextPage } } } }
  user(login: $owner) { projectV2(number: $number) { views(first: 20, after: $cursor) { nodes { id number name layout filter fields(first: 50) { nodes { id name dataType options { id name } } } groupByFields(first: 10) { nodes { id name } } verticalGroupByFields(first: 10) { nodes { id name } } sortByFields(first: 10) { nodes { id name } } } pageInfo { endCursor hasNextPage } } } }
}`
const VIEW_QUERY_WITHOUT_VERTICAL = `query ProjectViews($owner: String!, $number: Int!, $cursor: String) {
  organization(login: $owner) { projectV2(number: $number) { views(first: 20, after: $cursor) { nodes { id number name layout filter fields(first: 50) { nodes { id name dataType options { id name } } } groupByFields(first: 10) { nodes { id name } } sortByFields(first: 10) { nodes { id name } } } pageInfo { endCursor hasNextPage } } } }
  user(login: $owner) { projectV2(number: $number) { views(first: 20, after: $cursor) { nodes { id number name layout filter fields(first: 50) { nodes { id name dataType options { id name } } } groupByFields(first: 10) { nodes { id name } } sortByFields(first: 10) { nodes { id name } } } pageInfo { endCursor hasNextPage } } } }
}`

type ProjectCaller = Parameters<Handler>[1]
const verticalUnsupportedHosts = new Set<string>()

function optionalOwnerType(env: HostingEnv, value: unknown): ProjectOwnerType | undefined {
  if (value === undefined) return undefined
  if (value === 'organization' || value === 'user') return value
  throw env.invalid('validation_error', 'ownerType must be organization or user.')
}

function projectNode(value: unknown, host: string, owner: string, ownerTypeValue: ProjectOwnerType): Record<string, unknown> | null {
  const raw = record(value)
  const id = nonEmptyString(raw?.id)
  const number = positiveInteger(raw?.number)
  if (!raw || id === null || number === null) return null
  return {
    id,
    number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: nonEmptyString(raw.url) ?? `https://${host}/${ownerTypeValue === 'organization' ? 'orgs' : 'users'}/${owner}/projects/${number}`,
    owner,
    ownerType: ownerTypeValue,
    host,
    closed: raw.closed === true,
    shortDescription: typeof raw.shortDescription === 'string' ? raw.shortDescription : null,
    public: typeof raw.public === 'boolean' ? raw.public : null
  }
}
type ProjectConnection = { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number | null }

function requiredConnection(env: HostingEnv, value: unknown, label: string): ProjectConnection {
  const raw = record(value)
  const pageInfo = record(raw?.pageInfo)
  const rawCount = raw?.totalCount
  const totalCount = rawCount === undefined || rawCount === null ? null : positiveCount(rawCount)
  if (!raw || !Array.isArray(raw.nodes) || !pageInfo || (rawCount !== undefined && rawCount !== null && totalCount === null)) {
    throw projectError(env, 'schema_drift', `GitHub returned an invalid ${label} connection.`)
  }
  return { nodes: array(raw.nodes), pageInfo, totalCount }
}

function ownerProject(data: Record<string, unknown> | null, kind: ProjectOwnerType): { project: unknown } {
  return { project: record(data?.[kind])?.projectV2 }
}

function isProjectErrorReason(value: string): boolean {
  switch (value) {
    case 'auth_required':
    case 'scope_missing':
    case 'rate_limited':
    case 'network_error':
    case 'not_found':
    case 'validation_error':
    case 'schema_drift':
    case 'body_too_long':
    case 'already_exists':
    case 'too_large':
    case 'unsupported_layout':
    case 'unknown':
      return true
    default:
      return false
  }
}

function safePartialFailure(error: unknown, host: string, owner: string): Record<string, unknown> {
  const classified = safeErrorReason(error)
  const reason = isProjectErrorReason(classified) ? classified : 'unknown'
  const messages: Record<string, string> = {
    auth_required: `GitHub CLI is not authenticated to ${host}.`,
    scope_missing: 'GitHub Projects requires project, read:org, and repo scopes.',
    rate_limited: 'GitHub rate limit is currently exhausted.',
    network_error: 'GitHub is unreachable right now.',
    not_found: 'The organization project was not found.',
    validation_error: 'GitHub rejected the project request.',
    schema_drift: 'This GitHub host returned an unsupported Projects schema.',
    body_too_long: 'GitHub rejected the requested body because it is too long.',
    already_exists: 'The requested GitHub object already exists.',
    too_large: 'The organization project list exceeded the supported size.',
    unsupported_layout: 'The organization project uses an unsupported layout.',
    unknown: 'This organization could not be listed.'
  }
  return { owner, reason, message: messages[reason] ?? messages.unknown }
}

async function projectDiscovery(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const scope = await env.resolve(params, caller)
  const { host, identity } = await resolveProjectHost(env, scope, params.host)
  const key = env.cacheKey(scope, `projects:discovery:${host}`)
  return env.cache(key, 60_000, async () => {
    const first = await projectGraphql(env, scope, identity, DISCOVERY_QUERY, { cursor: null, orgCursor: null }, true)
    const firstData = record(record(first)?.data) ?? record(first)
    const viewer = record(firstData?.viewer)
    if (!viewer) throw projectError(env, 'schema_drift', 'GitHub returned an invalid project discovery response.')
    const viewerProjects = requiredConnection(env, viewer.projectsV2, 'viewer projects')
    const orgConnection = requiredConnection(env, viewer.organizations, 'viewer organizations')
    const projects: Record<string, unknown>[] = []
    const partialFailures: Record<string, unknown>[] = []
    let truncated = false
    const viewerLogin = nonEmptyString(viewer?.login) ?? ''
    if (viewerLogin.length === 0) throw projectError(env, 'schema_drift', 'GitHub returned a viewer without a login.')
    for (const node of viewerProjects.nodes) {
      const project = projectNode(node, host, viewerLogin, 'user')
      if (project) projects.push(project)
    }
    let cursor = nonEmptyString(viewerProjects.pageInfo.endCursor)
    let hasNext = viewerProjects.pageInfo.hasNextPage === true
    while (hasNext && projects.length < 40) {
      const next = await projectGraphql(env, scope, identity, VIEWER_PROJECT_PAGE_QUERY, { cursor }, true)
      const data = record(record(next)?.data) ?? record(next)
      const page = requiredConnection(env, record(data?.viewer)?.projectsV2, 'viewer projects')
      for (const node of page.nodes) {
        const project = projectNode(node, host, viewerLogin, 'user')
        if (project) projects.push(project)
        if (projects.length >= 40) break
      }
      cursor = nonEmptyString(page.pageInfo.endCursor)
      hasNext = page.pageInfo.hasNextPage === true && cursor !== null
    }
    if (hasNext || (viewerProjects.totalCount !== null && viewerProjects.totalCount > 40) || orgConnection.pageInfo.hasNextPage === true) truncated = true

    const orgs = orgConnection.nodes.slice(0, 20)
    for (const rawOrg of orgs) {
      const org = record(rawOrg)
      const login = nonEmptyString(org?.login)
      if (login === null) continue
      try {
        const result = await projectGraphql(env, scope, identity, ORG_PROJECT_QUERY, { login }, true)
        const data = record(record(result)?.data) ?? record(result)
        const orgData = record(data?.organization)
        const connection = requiredConnection(env, orgData?.projectsV2, 'organization projects')
        for (const node of connection.nodes) {
          const project = projectNode(node, host, login, 'organization')
          if (project) projects.push(project)
        }
        if (connection.pageInfo.hasNextPage === true || (connection.totalCount !== null && connection.totalCount > 20)) truncated = true
      } catch (error: unknown) {
        partialFailures.push(safePartialFailure(error, host, login))
      }
    }

    const unique = new Map<string, Record<string, unknown>>()
    for (const project of projects) unique.set(`${host}\u0000${project.ownerType}\u0000${project.owner}\u0000${project.number}`, project)
    const result = { projects: [...unique.values()], partialFailures, truncated }
    ensureOutputBound(env, result, 'Projects discovery')
    return result
  })
}

async function resolveProject(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const scope = await env.resolve(params, caller)
  const reference = await parseProjectReference(env, scope, params.input, params.host)
  const { identity } = await resolveProjectHost(env, scope, reference.host)
  const key = env.cacheKey(scope, `project-ref:${reference.host}:${reference.owner.toLowerCase()}:${reference.number}:${reference.ownerType ?? 'auto'}:${reference.view ?? ''}`)
  return env.cache(key, 300_000, async () => {
    const query = OWNER_PROJECT_QUERY
    const project = await projectGraphql(env, scope, identity, query, { owner: reference.owner, number: reference.number }, true)
    const data = record(record(project)?.data) ?? record(project)
    const preferredType = reference.ownerType
    const preferred = ownerProject(data, preferredType ?? 'organization')
    let selected = preferred
    let selectedType = preferredType ?? 'organization'
    if (preferred.project === null || preferred.project === undefined) {
      if (preferredType !== undefined) throw projectError(env, 'not_found', 'The requested GitHub project was not found.')
      selected = ownerProject(data, 'user')
      selectedType = 'user'
    }
    const mapped = projectNode(selected.project, reference.host, reference.owner, selectedType)
    if (mapped === null) throw projectError(env, 'not_found', 'The requested GitHub project was not found.')
    return { ...mapped, ...(reference.view === undefined ? {} : { view: reference.view }) }
  })
}

function normalizeView(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  const id = nonEmptyString(raw?.id)
  const name = nonEmptyString(raw?.name)
  const number = positiveInteger(raw?.number)
  if (!raw || id === null || name === null) return null
  return {
    id,
    number,
    name,
    layout: typeof raw.layout === 'string' ? raw.layout.toUpperCase() : 'UNKNOWN',
    filter: typeof raw.filter === 'string' ? raw.filter : '',
    fields: array(record(raw.fields)?.nodes).flatMap((item) => {
      const field = record(item)
      const fieldId = nonEmptyString(field?.id)
      if (!field || fieldId === null) return []
      return [{ id: fieldId, name: nonEmptyString(field.name) ?? '', dataType: nonEmptyString(field.dataType), options: array(record(field.options)?.nodes).flatMap((option) => {
        const choice = record(option)
        const choiceId = nonEmptyString(choice?.id)
        return !choice || choiceId === null ? [] : [{ id: choiceId, name: nonEmptyString(choice.name) ?? '' }]
      }) }]
    }),
    groupByFields: array(record(raw.groupByFields)?.nodes).flatMap((field) => {
      const entry = record(field)
      return !entry || nonEmptyString(entry.id) === null ? [] : [{ id: nonEmptyString(entry.id), name: nonEmptyString(entry.name) ?? '' }]
    }),
    verticalGroupByFields: array(record(raw.verticalGroupByFields)?.nodes).flatMap((field) => {
      const entry = record(field)
      return !entry || nonEmptyString(entry.id) === null ? [] : [{ id: nonEmptyString(entry.id), name: nonEmptyString(entry.name) ?? '' }]
    }),
    sortByFields: array(record(raw.sortByFields)?.nodes).flatMap((field) => {
      const entry = record(field)
      return !entry || nonEmptyString(entry.id) === null ? [] : [{ id: nonEmptyString(entry.id), name: nonEmptyString(entry.name) ?? '' }]
    })
  }
}

export async function loadProjectViews(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  owner: string,
  kind: ProjectOwnerType,
  projectNumber: number
): Promise<{ views: Record<string, unknown>[]; truncated: boolean; parentFieldDropped: boolean }> {
  const query = verticalUnsupportedHosts.has(identity.host.toLowerCase()) ? VIEW_QUERY_WITHOUT_VERTICAL : VIEW_QUERY_WITH_VERTICAL
  let cursor: string | null = null
  const views: Record<string, unknown>[] = []
  let hasNextPage = true
  let page = 0
  while (hasNextPage && page < 5) {
    let result: unknown
    try {
      result = await projectGraphql(env, scope, identity, query, { owner, number: projectNumber, cursor }, true)
    } catch (error: unknown) {
      if (query === VIEW_QUERY_WITH_VERTICAL && record(record(error)?.data)?.schemaField === 'verticalGroupByFields') {
        verticalUnsupportedHosts.add(identity.host.toLowerCase())
        return loadProjectViews(env, scope, identity, owner, kind, projectNumber)
      }
      throw error
    }
    const data = record(record(result)?.data) ?? record(result)
    const ownerData = record(data?.[kind])
    const project = record(ownerData?.projectV2)
    if (!project) throw projectError(env, 'not_found', 'The requested GitHub project was not found.')
    const connection = requiredConnection(env, project.views, 'project views')
    for (const value of connection.nodes) {
      const view = normalizeView(value)
      if (view) views.push(view)
    }
    cursor = nonEmptyString(connection.pageInfo.endCursor)
    hasNextPage = connection.pageInfo.hasNextPage === true && cursor !== null
    page += 1
  }
  return { views, truncated: hasNextPage, parentFieldDropped: false }
}

async function projectViews(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const ownerValue = params.owner
  if (typeof ownerValue !== 'string' || !/^[A-Za-z0-9-]+$/.test(ownerValue)) throw env.invalid('validation_error', 'owner must be a valid GitHub login.')
  const kind = optionalOwnerType(env, params.ownerType)
  if (!kind) throw env.invalid('validation_error', 'ownerType must be organization or user.')
  const projectNumber = positiveParam(env, params, 'projectNumber') ?? 0
  const scope = await env.resolve(params, caller)
  const { host, identity } = await resolveProjectHost(env, scope, params.host)
  const key = env.cacheKey(scope, `project-views:${host}:${kind}:${ownerValue.toLowerCase()}:${projectNumber}`)
  const result = await env.cache(key, 60_000, () => loadProjectViews(env, scope, identity, ownerValue, kind, projectNumber))
  const output = { views: result.views, truncated: result.truncated, parentFieldDropped: result.parentFieldDropped }
  ensureOutputBound(env, output, 'Project views')
  return output
}

export function projectMethods(env: HostingEnv): Record<string, Handler> {
  return {
    projects: (params, caller) => projectDiscovery(env, params, caller),
    projectRef: (params, caller) => resolveProject(env, params, caller),
    projectViews: (params, caller) => projectViews(env, params, caller)
  }
}
