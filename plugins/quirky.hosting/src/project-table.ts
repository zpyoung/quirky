import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  array,
  boundedText,
  positiveCount,
  nonEmptyString,
  positiveInteger,
  positiveParam,
  record,
  ensureOutputBound,
  utf8Length,
  type WorkItemKind
} from './item-data'
import { projectError } from './project-errors'
import { loadProjectViews } from './project-methods'
import { projectGraphql, resolveProjectHost, type ProjectOwnerType } from './project-ref'

const PROJECT_ITEMS_QUERY_WITH_PARENT = `query ProjectItems($owner: String!, $number: Int!, $after: String, $query: String) {
  organization(login: $owner) { projectV2(number: $number) { id number title items(first: 100, after: $after, query: $query, orderBy: { field: POSITION, direction: ASC }) { totalCount pageInfo { endCursor hasNextPage } nodes { id type content { __typename ... on Issue { number title body state url parent { number title url } } ... on PullRequest { number title body state url isDraft headRefName baseRefName } ... on DraftIssue { title body } } fieldValues(first: 50) { nodes { __typename ... on ProjectV2ItemFieldTextValue { text field { id name } } ... on ProjectV2ItemFieldNumberValue { number field { id name } } ... on ProjectV2ItemFieldDateValue { date field { id name } } ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { id name } } ... on ProjectV2ItemFieldIterationValue { title startDate duration field { id name } } } } } } } }
  user(login: $owner) { projectV2(number: $number) { id number title items(first: 100, after: $after, query: $query, orderBy: { field: POSITION, direction: ASC }) { totalCount pageInfo { endCursor hasNextPage } nodes { id type content { __typename ... on Issue { number title body state url parent { number title url } } ... on PullRequest { number title body state url isDraft headRefName baseRefName } ... on DraftIssue { title body } } fieldValues(first: 50) { nodes { __typename ... on ProjectV2ItemFieldTextValue { text field { id name } } ... on ProjectV2ItemFieldNumberValue { number field { id name } } ... on ProjectV2ItemFieldDateValue { date field { id name } } ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { id name } } ... on ProjectV2ItemFieldIterationValue { title startDate duration field { id name } } } } } } } }
}`
const PROJECT_ITEMS_QUERY_WITHOUT_PARENT = PROJECT_ITEMS_QUERY_WITH_PARENT.replaceAll(' parent { number title url }', '')
type ProjectCaller = Parameters<Handler>[1]
const parentUnsupportedHosts = new Set<string>()
type ProjectItemConnection = { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number | null }

function ownerKind(env: HostingEnv, value: unknown): ProjectOwnerType {
  if (value === 'organization' || value === 'user') return value
  throw env.invalid('validation_error', 'ownerType must be organization or user.')
}

function ownerLogin(env: HostingEnv, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/.test(value)) throw env.invalid('validation_error', 'owner must be a valid GitHub login.')
  return value
}

function normalizeFieldValue(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  if (!raw) return null
  const field = record(raw.field)
  const fieldId = nonEmptyString(field?.id)
  if (fieldId === null) return null
  let contentValue: unknown = null
  for (const key of ['text', 'number', 'date', 'name', 'title', 'startDate', 'duration'] as const) {
    if (raw[key] !== undefined) {
      contentValue = raw[key]
      break
    }
  }
  if (raw.optionId !== undefined) contentValue = raw.optionId
  return {
    fieldId,
    fieldName: nonEmptyString(field?.name) ?? '',
    type: nonEmptyString(raw.__typename) ?? 'unknown',
    value: contentValue
  }
}

function normalizeContent(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  if (!raw) return null
  const typename = nonEmptyString(raw.__typename) ?? 'Unknown'
  let kind: WorkItemKind | 'draft' | 'unknown' = 'unknown'
  if (typename === 'Issue') kind = 'issue'
  else if (typename === 'PullRequest') kind = 'pullRequest'
  else if (typename === 'DraftIssue') kind = 'draft'
  const number = positiveInteger(raw.number)
  const parent = record(raw.parent)
  const result: Record<string, unknown> = {
    kind,
    number,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    state: typeof raw.state === 'string' ? raw.state.toLowerCase() : 'unknown',
    url: nonEmptyString(raw.url),
    isDraft: raw.isDraft === true,
    headRefName: nonEmptyString(raw.headRefName),
    baseRefName: nonEmptyString(raw.baseRefName)
  }
  if (parent) result.parent = {
    number: positiveInteger(parent.number),
    title: typeof parent.title === 'string' ? parent.title : '',
    url: nonEmptyString(parent.url)
  }
  return result
}

function normalizeProjectItem(env: HostingEnv, value: unknown): Record<string, unknown> {
  const raw = record(value)
  const id = nonEmptyString(raw?.id)
  const fieldConnection = record(raw?.fieldValues)
  if (!raw || id === null || !fieldConnection || !Array.isArray(fieldConnection.nodes)) {
    throw projectError(env, 'schema_drift', 'GitHub returned an invalid project item.')
  }
  const fieldValues: Record<string, unknown>[] = []
  for (const value of array(fieldConnection.nodes)) {
    const field = normalizeFieldValue(value)
    if (!field) throw projectError(env, 'schema_drift', 'GitHub returned an invalid project field value.')
    fieldValues.push(field)
  }
  return {
    id,
    type: nonEmptyString(raw.type) ?? 'REDACTED',
    content: normalizeContent(raw.content),
    fieldValues
  }
}

function projectConnection(result: unknown, kind: ProjectOwnerType): { project: Record<string, unknown> | null; items: ProjectItemConnection | null } {
  const root = record(result)
  const data = record(root?.data) ?? root
  const owner = record(data?.[kind])
  const project = record(owner?.projectV2)
  const rawItems = record(project?.items)
  const pageInfo = record(rawItems?.pageInfo)
  const rawCount = rawItems?.totalCount
  const totalCount = rawCount === undefined || rawCount === null ? null : positiveCount(rawCount)
  if (!rawItems || !Array.isArray(rawItems.nodes) || !pageInfo || (rawCount !== undefined && rawCount !== null && totalCount === null)) {
    return { project, items: null }
  }
  return { project, items: { nodes: array(rawItems.nodes), pageInfo, totalCount } }
}

async function fetchItems(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  owner: string,
  kind: ProjectOwnerType,
  number: number,
  query: string,
  includeParent: boolean
): Promise<{ project: Record<string, unknown> | null; items: Record<string, unknown>[]; totalCount: number | null; truncated: boolean }> {
  const queryText = includeParent ? PROJECT_ITEMS_QUERY_WITH_PARENT : PROJECT_ITEMS_QUERY_WITHOUT_PARENT
  const resultItems: Record<string, unknown>[] = []
  let totalCount: number | null = null
  let cursor: string | null = null
  let hasNext = true
  let pages = 0
  let project: Record<string, unknown> | null = null
  while (hasNext && pages < 5) {
    let response: unknown
    try {
      response = await projectGraphql(env, scope, identity, queryText, { owner, number, after: cursor, query: query.length === 0 ? null : query }, true)
    } catch (error: unknown) {
      if (includeParent && safeErrorReason(error) === 'schema_drift') {
        parentUnsupportedHosts.add(identity.host.toLowerCase())
        return fetchItems(env, scope, identity, owner, kind, number, query, false)
      }
      throw error
    }
    const page = projectConnection(response, kind)
    if (!page.project) throw projectError(env, 'not_found', 'The requested GitHub project was not found.')
    if (!page.items) throw projectError(env, 'schema_drift', 'GitHub returned an invalid project item connection.')
    project = page.project
    if (totalCount === null) totalCount = page.items.totalCount
    if (totalCount !== null && totalCount > 500) {
      throw projectError(env, 'too_large', 'The project view contains more than 500 items.', { totalCount })
    }
    resultItems.push(...page.items.nodes.flatMap((value) => {
      const item = normalizeProjectItem(env, value)
      return [item]
    }))
    cursor = nonEmptyString(page.items.pageInfo.endCursor)
    hasNext = page.items.pageInfo.hasNextPage === true && cursor !== null
    pages += 1
    if (resultItems.length >= 500 && hasNext) {
      throw projectError(env, 'too_large', 'The project view contains more than 500 items.', { totalCount: totalCount ?? resultItems.length })
    }
  }
  if (hasNext) throw projectError(env, 'too_large', 'The project view contains more than 500 items.', { totalCount: totalCount ?? resultItems.length })
  return { project, items: resultItems.slice(0, 500), totalCount, truncated: false }
}

function fieldValueFor(item: Record<string, unknown>, fieldId: string): unknown {
  const values = array(item.fieldValues)
  const value = values.find((entry) => record(entry)?.fieldId === fieldId)
  return record(value)?.value ?? null
}

function boardColumns(items: Record<string, unknown>[], groupFields: unknown[]): Record<string, unknown>[] {
  const fields = groupFields.flatMap((value) => {
    const field = record(value)
    const id = nonEmptyString(field?.id)
    return field && id !== null ? [{ id, name: nonEmptyString(field.name) ?? '' }] : []
  })
  return fields.map((field) => {
    const columns = new Map<string, { value: unknown; items: Record<string, unknown>[] }>()
    for (const item of items) {
      const value = fieldValueFor(item, field.id)
      const key = value === null ? '__no_value__' : JSON.stringify(value) ?? String(value)
      const group = columns.get(key) ?? { value, items: [] }
      group.items.push(item)
      columns.set(key, group)
    }
    return {
      fieldId: field.id,
      fieldName: field.name,
      columns: [...columns.values()].map((group) => ({ value: group.value, items: group.items }))
    }
  })
}

function dateFields(view: Record<string, unknown>): Record<string, unknown>[] {
  return array(view.fields).flatMap((value) => {
    const field = record(value)
    return field && typeof field.dataType === 'string' && field.dataType.toLowerCase() === 'date' ? [field] : []
  })
}

function chooseView(env: HostingEnv, params: Record<string, unknown>, views: Record<string, unknown>[]): Record<string, unknown> {
  const viewId = params.viewId
  if (viewId !== undefined && (typeof viewId !== 'string' || viewId.trim().length === 0 || viewId.length > 256)) throw env.invalid('validation_error', 'viewId must be a non-empty ID.')
  const viewNumber = positiveParam(env, params, 'viewNumber', false)
  const viewNameValue = params.viewName
  if (viewNameValue !== undefined && (typeof viewNameValue !== 'string' || viewNameValue.trim().length === 0 || new TextEncoder().encode(viewNameValue).byteLength > 256)) {
    throw env.invalid('validation_error', 'viewName must be a non-empty name no longer than 256 bytes.')
  }
  let selected: Record<string, unknown> | undefined
  if (typeof viewId === 'string') selected = views.find((view) => view.id === viewId.trim())
  else if (viewNumber !== undefined) selected = views.find((view) => view.number === viewNumber)
  else if (typeof viewNameValue === 'string') selected = views.find((view) => typeof view.name === 'string' && view.name.toLowerCase() === viewNameValue.trim().toLowerCase())
  else selected = views.find((view) => view.layout === 'TABLE') ?? views.find((view) => view.layout === 'ROADMAP') ?? views.find((view) => view.layout === 'BOARD')
  if (!selected) throw projectError(env, 'not_found', 'The requested project view was not found.', { viewCount: views.length })
  const layout = typeof selected.layout === 'string' ? selected.layout.toUpperCase() : 'UNKNOWN'
  if (layout !== 'TABLE' && layout !== 'BOARD' && layout !== 'ROADMAP') {
    throw projectError(env, 'unsupported_layout', 'The selected project view layout is not supported.', { layout, viewCount: views.length })
  }
  return selected
}

async function getProjectTable(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const owner = ownerLogin(env, params.owner)
  const kind = ownerKind(env, params.ownerType)
  const projectNumber = positiveParam(env, params, 'projectNumber') ?? 0
  const queryOverride = boundedText(env, params, 'queryOverride', { maxBytes: 8192 }) ?? ''
  const scope = await env.resolve(params, caller)
  const { host, identity } = resolveProjectHost(env, scope, params.host)
  const cacheKey = env.cacheKey(scope, `project-views:${host}:${kind}:${owner.toLowerCase()}:${projectNumber}`)
  const viewResult = await env.cache(cacheKey, 60_000, () => loadProjectViews(env, scope, identity, owner, kind, projectNumber))
  const selectedView = chooseView(env, params, viewResult.views)
  const layout = typeof selectedView.layout === 'string' ? selectedView.layout.toUpperCase() : 'UNKNOWN'
  if (utf8Length(filter) > 8192) throw projectError(env, 'too_large', 'The project view filter exceeds the 8192-byte limit.')
  const itemsCacheKey = env.cacheKey(scope, `project-items:${host}:${kind}:${owner.toLowerCase()}:${projectNumber}:${String(selectedView.id)}:${filter}`)
  const itemResult = await env.cache(itemsCacheKey, 60_000, () => fetchItems(
    env,
    scope,
    identity,
    owner,
    kind,
    projectNumber,
    filter,
    !parentUnsupportedHosts.has(host.toLowerCase())
  ))
  const viewsFields = array(selectedView.fields)
  const common: Record<string, unknown> = {
    project: { owner, ownerType: kind, number: projectNumber, id: nonEmptyString(itemResult.project?.id), host },
    view: selectedView,
    layout,
    items: itemResult.items,
    fields: viewsFields,
    totalCount: itemResult.totalCount,
    truncated: itemResult.truncated,
    parentFieldDropped: parentUnsupportedHosts.has(host.toLowerCase())
  }
  if (layout === 'BOARD') common.boardColumns = boardColumns(itemResult.items, array(selectedView.groupByFields))
  if (layout === 'ROADMAP') common.roadmap = { dateFields: dateFields(selectedView), groupByFields: array(selectedView.verticalGroupByFields), items: itemResult.items }
  ensureOutputBound(env, common, 'Project table')
  return common
}

export function projectTableMethods(env: HostingEnv): Record<string, Handler> {
  return { projectTable: (params, caller) => getProjectTable(env, params, caller) }
}
