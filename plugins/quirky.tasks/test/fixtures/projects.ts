export type ProjectFixtureState = Record<string, unknown>

const projectUrl = 'https://github.com/orgs/test-owner/projects/4'
const fieldStatus = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'PVTF_STATUS',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'OPT_TODO', name: 'Todo' }, { id: 'OPT_DONE', name: 'Done' }]
}
const fieldStart = { __typename: 'ProjectV2Field', id: 'PVTF_START', name: 'Start date', dataType: 'DATE' }
const fieldTarget = { __typename: 'ProjectV2Field', id: 'PVTF_TARGET', name: 'Target date', dataType: 'DATE' }
const fieldEstimate = { __typename: 'ProjectV2Field', id: 'PVTF_ESTIMATE', name: 'Estimate', dataType: 'NUMBER' }
const fieldNotes = { __typename: 'ProjectV2Field', id: 'PVTF_NOTES', name: 'Notes', dataType: 'TEXT' }
const fields = [fieldStatus, fieldStart, fieldTarget, fieldEstimate, fieldNotes]
const tableView = {
  id: 'VIEW_TABLE', number: 1, name: 'Table', layout: 'TABLE', filter: '',
  fields: { nodes: [{ __typename: 'ProjectV2Field', id: 'TITLE', name: 'Title', dataType: 'TITLE' }, ...fields] },
  groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: [] }, sortByFields: { nodes: [] }
}
const boardView = {
  id: 'VIEW_BOARD', number: 2, name: 'Board', layout: 'BOARD', filter: '',
  fields: { nodes: [{ __typename: 'ProjectV2Field', id: 'TITLE', name: 'Title', dataType: 'TITLE' }, ...fields] },
  groupByFields: { nodes: [fieldStatus] }, verticalGroupByFields: { nodes: [fieldStatus] }, sortByFields: { nodes: [] }
}
const roadmapView = {
  id: 'VIEW_ROADMAP', number: 3, name: 'Roadmap', layout: 'ROADMAP', filter: '',
  fields: { nodes: [{ __typename: 'ProjectV2Field', id: 'TITLE', name: 'Title', dataType: 'TITLE' }, ...fields] },
  groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: [] }, sortByFields: { nodes: [] }
}

function baseProjectFixture(): ProjectFixtureState {
  return {
    authStatus: 'Logged in to github.com account project-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n',
    authTokens: { 'project-fixture': 'fixture-project-token' },
    viewerLogin: 'project-fixture',
    organizations: [{ login: 'test-owner', name: 'Test owner' }],
    calls: [],
    resources: {
      projectId: 'PVT_4',
      projectViews: {
        'organization/test-owner/4': {
          projectId: 'PVT_4', owner: 'test-owner', ownerType: 'Organization', number: 4,
          title: 'Fixture project', url: projectUrl,
          views: [tableView, boardView, roadmapView]
        }
      },
      projectItems: {
        'PVT_4/PVTI_7': {
          id: 'PVTI_7', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization',
          kind: 'issue', number: 7, title: 'Improve project table', body: 'Project issue context', state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/7', repository: 'test-owner/test-repo',
          fieldValues: { PVTF_STATUS: { singleSelectOptionId: 'OPT_TODO' }, PVTF_START: { date: '2026-01-01' }, PVTF_TARGET: { date: '2026-01-14' }, PVTF_ESTIMATE: { number: 3 }, PVTF_NOTES: { text: 'seed' } }
        },
        'PVT_4/PVTI_8': {
          id: 'PVTI_8', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization',
          kind: 'pullRequest', number: 8, title: 'Update project view', body: '', state: 'open',
          url: 'https://github.com/test-owner/test-repo/pull/8', repository: 'test-owner/test-repo',
          assignees: [{ login: 'ada', avatarUrl: 'https://avatars.example/ada.png' }],
          fieldValues: { PVTF_STATUS: { singleSelectOptionId: 'OPT_DONE' }, PVTF_START: { date: '2026-01-08' } }
        },
        'PVT_4/PVTI_9': {
          id: 'PVTI_9', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization',
          kind: 'issue', number: 9, title: 'Undated project issue', body: '', state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/9', repository: 'test-owner/test-repo', fieldValues: {}
        }
      },
      projectFields: {},
      issues: {
        'test-owner/test-repo/7': { nodeId: 'ISSUE_NODE_7', number: 7, title: 'Improve project table', body: 'Project issue context', state: 'open', html_url: 'https://github.com/test-owner/test-repo/issues/7', user: { login: 'project-fixture' }, labels: [], assignees: [] },
        'test-owner/test-repo/9': { nodeId: 'ISSUE_NODE_9', number: 9, title: 'Undated project issue', body: '', state: 'open', html_url: 'https://github.com/test-owner/test-repo/issues/9', user: { login: 'project-fixture' }, labels: [], assignees: [] }
      },
      issueTypes: { 'test-owner': [{ id: 'TYPE_BUG', name: 'Bug', isEnabled: true }, { id: 'TYPE_TASK', name: 'Task', isEnabled: true }] }
    }
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (isRecord(current) && isRecord(value)) target[key] = deepMerge({ ...current }, value)
    else target[key] = clone(value)
  }
  return target
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build an isolated, JSON-safe state seed for the reusable `gh` fixture. */
export function seedProjectsState(overrides: Record<string, unknown> = {}): ProjectFixtureState {
  return deepMerge(baseProjectFixture(), overrides)
}

/** Mutate a seed to model a host response, auth failure, item edit, or project layout change. */
export function setProjectScenario(state: ProjectFixtureState, change: Record<string, unknown>): ProjectFixtureState {
  return deepMerge(state, change)
}

/** A stateful fake `gh` source; it has no `bun:test` or daemon dependency and can be reused by CLI smoke. */
export const PROJECTS_GH_FIXTURE = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof fixtureDir !== 'string') throw new Error('missing isolated fixture directory')
const statePath = join(fixtureDir, 'state.json')
const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
const state = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}
const args = process.argv.slice(2)
const methodIndex = args.findIndex((part) => part === '--method' || part === '-X')
const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
const inputText = process.env.QUIRKY_TEST_GH_INPUT ?? ''
let requestBody = null
try { requestBody = inputText.length > 0 ? JSON.parse(inputText) : null } catch { requestBody = null }
const body = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody) ? requestBody : {}
function parseValue(value) { try { return JSON.parse(value) } catch { return value } }
const variables = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? { ...body.variables } : {}
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  const field = arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field' ? args[index + 1] : arg
  if (typeof field !== 'string') continue
  const separator = field.indexOf('=')
  if (separator > 0) variables[field.slice(0, separator)] = parseValue(field.slice(separator + 1))
}
const queryArg = args.find((part) => typeof part === 'string' && part.startsWith('query='))
const query = typeof body.query === 'string' ? body.query : queryArg ? queryArg.slice(6) : ''
const endpoint = args.find((part) => typeof part === 'string' && (part === 'graphql' || part.startsWith('repos/'))) ?? ''
const call = { args, method, query, variables, input: requestBody, endpoint }
const calls = Array.isArray(state.calls) ? state.calls : (state.calls = [])
calls.push(call)
const save = () => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, statePath)
}
const emit = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0) }
const fail = (message) => { save(); process.stderr.write(message); process.exit(1) }
save()
if (args.includes('auth') && args.includes('status')) {
  process.stdout.write(typeof state.authStatus === 'string' ? state.authStatus : 'Logged in to github.com account project-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
  process.exit(0)
}
if (args.includes('auth') && args.includes('token')) {
  if (args.includes('--help')) { process.stdout.write('gh auth token [--user USER] [--hostname HOST]'); process.exit(0) }
  const userIndex = args.indexOf('--user')
  const user = userIndex >= 0 ? args[userIndex + 1] : 'project-fixture'
  const token = state.authTokens && state.authTokens[user]
  if (typeof token !== 'string') fail('not logged in')
  process.stdout.write(token)
  process.exit(0)
}
const resources = state.resources && typeof state.resources === 'object' ? state.resources : (state.resources = {})
const projectViews = resources.projectViews && typeof resources.projectViews === 'object' ? resources.projectViews : {}
const projectItems = resources.projectItems && typeof resources.projectItems === 'object' ? resources.projectItems : {}
const projectFields = resources.projectFields && typeof resources.projectFields === 'object' ? resources.projectFields : (resources.projectFields = {})
const issues = resources.issues && typeof resources.issues === 'object' ? resources.issues : (resources.issues = {})
const issueTypes = resources.issueTypes && typeof resources.issueTypes === 'object' ? resources.issueTypes : {}
const variable = (name) => variables[name]
const ownerKindFromQuery = (source) => source.includes('organization(login:') ? 'organization' : 'user'
const projectKey = (kind, owner, number) => kind + '/' + owner + '/' + number
function getProject(kind, owner, number) {
  return projectViews[projectKey(kind, owner, number)] ?? projectViews[owner + '/' + number] ?? null
}
function projectNode(project, kind, owner, number) {
  const host = typeof project.host === 'string' ? project.host : 'github.com'
  return { id: project.projectId ?? project.id ?? 'PVT_4', number: Number(project.number ?? number), title: project.title ?? 'Fixture project', url: project.url ?? 'https://' + host + '/' + (kind === 'organization' ? 'orgs/' : 'users/') + owner + '/projects/' + number, closed: project.closed === true, shortDescription: project.shortDescription ?? '', public: project.public ?? true }
}
function allProjects() { return Object.values(projectViews).filter((candidate) => candidate && typeof candidate === 'object') }
function projectFieldValue(item, fieldId) {
  const stored = projectFields[item.projectId + '/' + item.id + '/' + fieldId]
  if (stored && typeof stored === 'object') {
    if (stored.cleared === true) return null
    if (Object.hasOwn(stored, 'value')) return stored.value
  }
  const initial = item.fieldValues && item.fieldValues[fieldId]
  return initial ?? null
}
function fieldConfig(project, fieldId) {
  for (const view of project.views ?? []) {
    const viewFields = view.fields && Array.isArray(view.fields.nodes) ? view.fields.nodes : Array.isArray(view.fields) ? view.fields : []
    const field = viewFields.find((candidate) => candidate && candidate.id === fieldId)
    if (field) return field
  }
  return null
}
function itemGraphNode(item) {
  const kind = item.kind === 'pullRequest' ? 'PullRequest' : item.kind === 'draft' ? 'DraftIssue' : 'Issue'
  const content = {
    __typename: kind,
    ...(kind === 'DraftIssue' ? {} : { number: Number(item.number), [kind === 'PullRequest' ? 'pullRequestState' : 'issueState']: String(item.state ?? 'open').toUpperCase(), isDraft: item.isDraft === true }),
    title: item.title ?? '', body: item.body ?? '', url: item.url ?? null,
    repository: { nameWithOwner: item.repository ?? null },
    labels: { nodes: (item.labels ?? []).map((entry) => typeof entry === 'string' ? { name: entry, color: '' } : entry) },
    assignees: { nodes: (item.assignees ?? []).map((entry) => typeof entry === 'string' ? { login: entry, name: null, avatarUrl: null } : entry) },
    ...(kind === 'Issue' ? { stateReason: item.stateReason ?? null, issueType: item.issueType ?? null, ...(item.parent ? { parent: item.parent } : {}) } : {}),
    ...(kind === 'PullRequest' ? { headRefName: item.headRefName ?? null, baseRefName: item.baseRefName ?? null } : {})
  }
  const parent = projectViews[projectKey(item.ownerType === 'User' ? 'user' : 'organization', item.owner, item.projectNumber)]
  const fields = []
  for (const fieldId of new Set([...(Object.keys(item.fieldValues ?? {})), ...Object.keys(projectFields).flatMap((key) => key.startsWith(item.projectId + '/' + item.id + '/') ? [key.slice((item.projectId + '/' + item.id + '/').length)] : [])])) {
    const value = projectFieldValue(item, fieldId)
    if (value === null) continue
    const field = fieldConfig(parent ?? { views: [] }, fieldId) ?? { id: fieldId, name: fieldId, dataType: 'TEXT' }
    const type = String(field.dataType ?? '').toUpperCase()
    const fieldRef = { __typename: field.__typename ?? 'ProjectV2Field', id: fieldId, name: field.name ?? fieldId }
    if (type === 'SINGLE_SELECT') {
      const optionId = value.singleSelectOptionId ?? value.optionId
      const option = (field.options ?? []).find((entry) => entry.id === optionId)
      fields.push({ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: fieldRef, optionId, name: option?.name ?? null })
    } else if (type === 'MULTI_SELECT') {
      fields.push({ __typename: 'ProjectV2ItemFieldMultiSelectValue', field: fieldRef, options: (value.multiSelectOptionIds ?? []).map((id) => (field.multiSelectOptions ?? []).find((entry) => entry.id === id)).filter(Boolean) })
    } else if (type === 'NUMBER') fields.push({ __typename: 'ProjectV2ItemFieldNumberValue', field: fieldRef, number: value.number })
    else if (type === 'DATE') fields.push({ __typename: 'ProjectV2ItemFieldDateValue', field: fieldRef, date: value.date })
    else fields.push({ __typename: 'ProjectV2ItemFieldTextValue', field: fieldRef, text: value.text })
  }
  fields.push({ __typename: 'ProjectV2ItemFieldLabelValue', field: { __typename: 'ProjectV2Field', id: 'FIELD_LABELS', name: 'Labels' }, labels: { nodes: (item.labels ?? []).map((name) => typeof name === 'string' ? { name, color: '' } : name) } })
  fields.push({ __typename: 'ProjectV2ItemFieldUserValue', field: { __typename: 'ProjectV2Field', id: 'FIELD_ASSIGNEES', name: 'Assignees' }, users: { nodes: (item.assignees ?? []).map((login) => typeof login === 'string' ? { login, name: null, avatarUrl: null } : login) } })
  return { id: item.id, type: kind === 'Issue' ? 'ISSUE' : kind === 'PullRequest' ? 'PULL_REQUEST' : 'DRAFT_ISSUE', content, fieldValues: { nodes: fields } }
}
function matchingItems(owner, number) {
  return Object.values(projectItems).filter((item) => item && item.owner === owner && Number(item.projectNumber ?? number) === Number(number))
}
function failureForProjectQuery() {
  const failure = state.projectFailure
  if (!failure || typeof failure !== 'object') return null
  const queryNeedle = typeof failure.query === 'string' ? failure.query : ''
  if (queryNeedle && !query.includes(queryNeedle)) return null
  const reason = failure.reason
  if (reason === 'auth_required') return failure.message ?? 'HTTP 401: Bad credentials'
  if (reason === 'scope_missing') return failure.message ?? 'HTTP 403: Resource not accessible by integration'
  return typeof failure.message === 'string' ? failure.message : null
}
const failure = failureForProjectQuery()
if (failure) fail(failure)
if (query.includes('query ProjectDiscovery')) {
  const userProjects = allProjects().filter((candidate) => candidate.ownerType === 'User' || candidate.ownerType === 'user').map((candidate) => projectNode(candidate, 'user', candidate.owner ?? 'project-fixture', candidate.number ?? 1))
  const organizationLogins = new Set([...(state.organizations ?? []).map((entry) => entry.login), ...allProjects().filter((candidate) => candidate.ownerType !== 'User' && candidate.ownerType !== 'user').map((candidate) => candidate.owner)])
  const organizations = [...organizationLogins].filter((login) => typeof login === 'string' && login.length > 0).map((login) => ({ login, name: login }))
  emit({ data: { viewer: { login: state.viewerLogin ?? 'project-fixture', projectsV2: { nodes: userProjects.slice(0, 20), pageInfo: { endCursor: null, hasNextPage: false }, totalCount: userProjects.length }, organizations: { nodes: organizations.slice(0, 20), pageInfo: { endCursor: null, hasNextPage: false } } } } })
}
if (query.includes('query ViewerProjectPage')) emit({ data: { viewer: { projectsV2: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 } } } })
if (query.includes('query OrganizationProjects')) {
  const owner = variable('login')
  const nodes = allProjects().filter((candidate) => candidate.owner === owner && candidate.ownerType !== 'User' && candidate.ownerType !== 'user').map((candidate) => projectNode(candidate, 'organization', owner, candidate.number ?? 1))
  emit({ data: { organization: { login: owner, projectsV2: { nodes, pageInfo: { endCursor: null, hasNextPage: false }, totalCount: nodes.length } } } })
}
if (query.includes('query ProjectOwner')) {
  const owner = variable('owner')
  const number = Number(variable('number'))
  const organization = getProject('organization', owner, number)
  const user = getProject('user', owner, number)
  emit({ data: { organization: { login: owner, projectV2: organization ? projectNode(organization, 'organization', owner, number) : null }, user: { login: owner, projectV2: user ? projectNode(user, 'user', owner, number) : null } } })
}
if (query.includes('query ProjectViews')) {
  const owner = variable('owner')
  const number = Number(variable('number'))
  const kind = ownerKindFromQuery(query)
  const project = getProject(kind, owner, number)
  if (!project) fail('HTTP 404: Project not found')
  const views = (project.views ?? []).map((view) => ({
    ...view,
    fields: Array.isArray(view.fields) ? { nodes: view.fields } : view.fields ?? { nodes: [] },
    groupByFields: Array.isArray(view.groupByFields) ? { nodes: view.groupByFields } : view.groupByFields ?? { nodes: [] },
    verticalGroupByFields: Array.isArray(view.verticalGroupByFields) ? { nodes: view.verticalGroupByFields } : view.verticalGroupByFields ?? { nodes: [] },
    sortByFields: Array.isArray(view.sortByFields) ? { nodes: view.sortByFields } : view.sortByFields ?? { nodes: [] }
  }))
  emit({ data: { [kind]: { projectV2: { id: project.projectId ?? project.id ?? 'PVT_4', number, views: { nodes: views, pageInfo: { endCursor: null, hasNextPage: false } } } } } })
}
if (query.includes('query ProjectItems')) {
  const owner = variable('owner')
  const number = Number(variable('number'))
  const kind = ownerKindFromQuery(query)
  const project = getProject(kind, owner, number)
  if (!project) fail('HTTP 404: Project not found')
  const items = matchingItems(owner, number).map(itemGraphNode)
  const rows = query.includes('queryOverride') && typeof variable('query') === 'string' && variable('query').includes('is:closed') ? items.filter((item) => item.content.issueState === 'CLOSED' || item.content.pullRequestState === 'CLOSED') : items
  const projectId = project.projectId ?? project.id ?? 'PVT_4'
  emit({ data: { [kind]: { projectV2: { id: projectId, number, title: project.title ?? 'Fixture project', items: { nodes: rows, pageInfo: { endCursor: null, hasNextPage: false }, totalCount: rows.length } } } } })
}
if (query.includes('query WorkItemDetails')) {
  const owner = variable('owner')
  const repo = variable('repo')
  const number = Number(variable('number'))
  const key = owner + '/' + repo + '/' + number
  const projectItem = Object.values(projectItems).find((item) => item && item.owner === owner && Number(item.number) === number && typeof item.url === 'string' && item.url.includes('/' + owner + '/' + repo + '/'))
  const isPull = projectItem?.kind === 'pullRequest' || Boolean(resources.pulls && resources.pulls[key])
  const resource = (isPull ? resources.pulls && resources.pulls[key] : issues[key]) ?? projectItem
  if (!resource) fail('HTTP 404: Work item not found')
  const labels = (resource.labels ?? []).map((entry) => typeof entry === 'string' ? { name: entry, color: '' } : entry)
  const assignees = (resource.assignees ?? []).map((entry) => typeof entry === 'string' ? { login: entry, name: null, avatarUrl: null } : entry)
  const commentRows = resources.comments && Array.isArray(resources.comments[key]) ? resources.comments[key] : []
  const authorLogin = typeof resource.user?.login === 'string' ? resource.user.login : typeof resource.author === 'string' ? resource.author : 'project-fixture'
  const participants = [...new Set([authorLogin, ...commentRows.map((comment) => comment.user?.login).filter((login) => typeof login === 'string')])].map((login) => ({ login }))
  const common = {
    number,
    title: resource.title ?? projectItem?.title ?? '',
    body: resource.body ?? projectItem?.body ?? '',
    state: String(resource.state ?? projectItem?.state ?? 'open').toUpperCase(),
    url: resource.html_url ?? resource.url ?? projectItem?.url ?? null,
    createdAt: resource.created_at ?? '2026-10-01T00:00:00Z',
    updatedAt: resource.updated_at ?? '2026-10-01T00:00:00Z',
    author: { login: authorLogin },
    labels: { nodes: labels },
    assignees: { nodes: assignees, pageInfo: { hasNextPage: false } },
    participants: { nodes: participants, pageInfo: { hasNextPage: false } }
  }
  const issue = isPull ? null : {
    __typename: 'Issue',
    ...common,
    stateReason: resource.stateReason ?? null,
    issueType: resource.issueType ?? null,
    comments: { nodes: commentRows.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url, author: comment.user, authorAssociation: 'CONTRIBUTOR' })), pageInfo: { hasNextPage: false } }
  }
  const pullRequest = isPull ? {
    __typename: 'PullRequest',
    ...common,
    isDraft: resource.isDraft === true || projectItem?.isDraft === true,
    reviews: { nodes: resources.reviews && Array.isArray(resources.reviews[key]) ? resources.reviews[key] : [], pageInfo: { hasNextPage: false } }
  } : null
  emit({ data: { repository: { issue, pullRequest } } })
}
if (query.includes('query ProjectItemContext')) {
  const projectId = variable('projectId')
  const itemId = variable('itemId')
  const item = projectItems[projectId + '/' + itemId] ?? projectItems[itemId]
  if (!item) fail('HTTP 404: Project item not found')
  emit({ data: { project: { id: projectId, owner: { __typename: item.ownerType ?? 'Organization', login: item.owner ?? 'test-owner' } }, item: { id: itemId, project: { id: projectId }, type: item.kind === 'pullRequest' ? 'PULL_REQUEST' : item.kind === 'draft' ? 'DRAFT_ISSUE' : 'ISSUE', content: { __typename: item.kind === 'pullRequest' ? 'PullRequest' : item.kind === 'draft' ? 'DraftIssue' : 'Issue', number: item.number, url: item.url } } } })
}
if (query.includes('query OrganizationIssueTypes')) {
  const owner = variable('owner')
  const repoOwner = variable('repoOwner')
  const repo = variable('repo')
  const number = Number(variable('number'))
  const issue = issues[repoOwner + '/' + repo + '/' + number]
  if (!issue) fail('HTTP 404: Issue not found')
  emit({ data: { repository: { issue: { id: issue.nodeId ?? 'ISSUE_NODE_' + number } }, organization: { issueTypes: { nodes: issueTypes[owner] ?? [], pageInfo: { hasNextPage: false } } } } })
}
if (query.includes('mutation SetProjectField') || query.includes('mutation ClearProjectField')) {
  const input = variables.input ?? variables
  const key = input.projectId + '/' + input.itemId + '/' + input.fieldId
  const clear = query.includes('mutation ClearProjectField')
  if (clear) projectFields[key] = { cleared: true }
  else projectFields[key] = { value: input.value }
  save()
  emit({ data: { [clear ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue']: { projectV2Item: { id: input.itemId } } } })
}
if (query.includes('mutation SetIssueType')) {
  const input = variables.input ?? variables
  const typeId = input.issueTypeId
  for (const issue of Object.values(issues)) {
    if (!issue || issue.nodeId !== input.issueId) continue
    const owner = issue.owner ?? 'test-owner'
    const issueType = (issueTypes[owner] ?? []).find((candidate) => candidate.id === typeId) ?? null
    issue.issueType = issueType
    save()
    emit({ data: { updateIssueIssueType: { issue: { id: input.issueId, issueType } } } })
  }
}
if (endpoint.startsWith('repos/') && method === 'GET') {
  const commentMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/comments(?:\?.*)?$/.exec(endpoint)
  const timelineMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/timeline(?:\?.*)?$/.exec(endpoint)
  const reviewMatch = /^repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)\/reviews(?:\?.*)?$/.exec(endpoint)
  const fileMatch = /^repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)\/files(?:\?.*)?$/.exec(endpoint)
  const match = commentMatch ?? timelineMatch ?? reviewMatch ?? fileMatch
  if (match) {
    const key = match[1] + '/' + match[2] + '/' + match[3]
    if (commentMatch) emit(resources.comments && Array.isArray(resources.comments[key]) ? resources.comments[key] : [])
    if (timelineMatch) emit(resources.timeline && Array.isArray(resources.timeline[key]) ? resources.timeline[key] : [])
    if (reviewMatch) emit(resources.reviews && Array.isArray(resources.reviews[key]) ? resources.reviews[key] : [])
    if (fileMatch) emit(resources.pullFiles && Array.isArray(resources.pullFiles[key]) ? resources.pullFiles[key] : [])
  }
}
if (endpoint.startsWith('repos/') && method === 'PATCH') {
  const match = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/([1-9][0-9]*)$/.exec(endpoint)
  if (match) {
    const key = match[1] + '/' + match[2] + '/' + match[4]
    const store = match[3] === 'issues' ? issues : resources.pulls ?? (resources.pulls = {})
    const current = store[key] ?? (store[key] = { number: Number(match[4]), state: 'open', labels: [], assignees: [] })
    Object.assign(current, body)
    save()
    emit(current)
  }
}
if (endpoint.startsWith('repos/') && (method === 'POST' || method === 'DELETE')) {
  const labelsMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/labels(?:\/([^/?]+))?/.exec(endpoint)
  const assigneesMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/assignees/.exec(endpoint)
  const match = labelsMatch ?? assigneesMatch
  if (match) {
    const key = match[1] + '/' + match[2] + '/' + match[3]
    const issue = issues[key] ?? (issues[key] = { number: Number(match[3]), labels: [], assignees: [] })
    const prop = labelsMatch ? 'labels' : 'assignees'
    const current = new Set((issue[prop] ?? []).map((entry) => typeof entry === 'string' ? entry : entry.name ?? entry.login))
    if (method === 'POST') for (const entry of body[prop] ?? body.labels ?? body.assignees ?? []) current.add(typeof entry === 'string' ? entry : entry.name ?? entry.login)
    if (method === 'DELETE') {
      if (labelsMatch && match[4]) current.delete(decodeURIComponent(match[4]))
      for (const entry of body[prop] ?? body.labels ?? body.assignees ?? []) current.delete(typeof entry === 'string' ? entry : entry.name ?? entry.login)
    }
    issue[prop] = [...current]
    save()
    emit(issue[prop])
  }
}
if (endpoint === 'graphql') fail('fixture did not recognize GraphQL request: ' + query.slice(0, 80))
emit({})
`
