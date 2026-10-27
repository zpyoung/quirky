import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const hosting of hosts.splice(0).reverse()) await hosting.cleanup()
})

const ghFixture = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof fixtureDir !== 'string') throw new Error('missing isolated fixture directory')
const statePath = join(fixtureDir, 'state.json')
const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
const state = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}
const args = process.argv.slice(2)
const command = args.join(' ')
const methodIndex = args.findIndex((part) => part === '--method' || part === '-X')
const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
const endpoint = args.find((part) => typeof part === 'string' && (part.startsWith('repos/') || part.startsWith('search/'))) ?? ''
const inputText = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const requestBody = inputText.length > 0 ? JSON.parse(inputText) : null
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const bodyObject = isObject(requestBody) ? requestBody : {}
const queryArg = args.find((part) => part.startsWith('query='))
const query = queryArg ? queryArg.slice('query='.length) : (typeof bodyObject.query === 'string' ? bodyObject.query : '')
const variables = isObject(bodyObject.variables) ? { ...bodyObject.variables } : {}
function parseValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
for (let index = 0; index < args.length; index += 1) {
  const part = args[index]
  const fieldValue = part === '-f' || part === '-F' || part === '--field' || part === '--raw-field'
    ? args[index + 1]
    : part
  if (typeof fieldValue !== 'string') continue
  const separator = fieldValue.indexOf('=')
  if (separator <= 0) continue
  variables[fieldValue.slice(0, separator)] = parseValue(fieldValue.slice(separator + 1))
}

const calls = Array.isArray(state.calls) ? state.calls : []
const call = { args, method, query, variables, input: requestBody, endpoint }
calls.push(call)
state.calls = calls
const save = () => {
  const temporaryStatePath = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporaryStatePath, JSON.stringify(state))
  renameSync(temporaryStatePath, statePath)
}
const emit = (value) => {
  save()
  process.stdout.write(JSON.stringify(value))
  process.exit(0)
}
const fail = (message) => {
  save()
  process.stderr.write(message)
  process.exit(1)
}
save()

if (args.includes('auth') && args.includes('status')) {
  process.stdout.write(typeof state.authStatus === 'string'
    ? state.authStatus
    : 'Logged in to github.com account hosting-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
  process.exit(0)
}

if (args.includes('auth') && args.includes('token')) {
  if (args.includes('--help')) {
    process.stdout.write('gh auth token [--user USER] [--hostname HOST]')
    process.exit(0)
  }
  const userIndex = args.indexOf('--user')
  const user = userIndex >= 0 ? args[userIndex + 1] : ''
  const token = isObject(state.authTokens) ? state.authTokens[user] : undefined
  if (typeof token !== 'string') fail('not logged in')
  process.stdout.write(token)
  process.exit(0)
}

const resources = isObject(state.resources) ? state.resources : {}
state.resources = resources
const issueStore = isObject(resources.issues) ? resources.issues : null
const pullStore = isObject(resources.pulls) ? resources.pulls : null
const commentStore = isObject(resources.comments) ? resources.comments : null
const projectItemStore = isObject(resources.projectItems) ? resources.projectItems : null
const projectFieldStore = isObject(resources.projectFields) ? resources.projectFields : null
const issueTypeStore = isObject(resources.issueTypes) ? resources.issueTypes : null

function routeDescription(entry) {
  const when = typeof entry.when === 'string' ? entry.when : ''
  const prefix = /^(GET|POST|PATCH|PUT|DELETE)\s+/.exec(when)
  return { expectedMethod: entry.method ?? prefix?.[1], needle: prefix ? when.slice(prefix[0].length) : when }
}
function matchesRoute(entry, candidate) {
  const description = routeDescription(entry)
  if (description.expectedMethod !== undefined && description.expectedMethod !== candidate.method) return false
  if (description.needle.length === 0) return false
  const pathLike = description.needle.includes('/') && !description.needle.includes(' ')
  return pathLike
    ? String(candidate.endpoint ?? '').includes(description.needle)
    : Array.isArray(candidate.args) && candidate.args.join(' ').includes(description.needle)
}
function matchesGraphqlField(source, field) {
  const withoutComments = source.replace(/#[^\n\r]*/g, '')
  const withoutStrings = withoutComments.replace(/"(?:\\.|[^"\\])*"/g, '""')
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(field)) return false
  return new RegExp('(?:^|[\\s{])(?:[A-Za-z_][A-Za-z0-9_]*\\s*:\\s*)?' + field + '\\s*(?=[({])').test(withoutStrings)
}
const responses = Array.isArray(state.responses) ? state.responses : []
const rule = responses.find((entry) => {
  if (!entry || !matchesRoute(entry, call)) return false
  if (entry.nth === undefined) return true
  return calls.filter((candidate) => matchesRoute(entry, candidate)).length === entry.nth
})
if (rule && typeof rule.error === 'string') fail(rule.error)

function issueKey(owner, repo, number) {
  return owner + '/' + repo + '/' + number
}
function pullKey(owner, repo, number) {
  return owner + '/' + repo + '/' + number
}
function hasOwn(value, key) {
  return isObject(value) && Object.hasOwn(value, key)
}
function apiRepo(path) {
  const parts = path.split('/')
  return parts.length >= 3 ? { owner: parts[1], repo: parts[2] } : { owner: 'test-owner', repo: 'test-repo' }
}
function routeIssueParts(path) {
  return /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(path)
}
function routeIssueChild(path) {
  return /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/(comments|timeline)(?:\?.*)?$/.exec(path)
}
function routeIssueCollectionMutation(path) {
  return /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/(labels|assignees)(?:\/([^/?]+))?$/.exec(path)
}
function routeIssueCollection(path) {
  return /^repos\/([^/]+)\/([^/]+)\/issues(?:\?.*)?$/.exec(path)
}
function routeGlobalComment(path) {
  return /^repos\/([^/]+)\/([^/]+)\/issues\/comments\/([0-9]+)$/.exec(path)
}
function routePull(path) {
  return /^repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)(?:\/(files|reviews))?(?:\?.*)?$/.exec(path)
}
function asNames(values, key) {
  if (!Array.isArray(values)) return []
  return values.map((value) => typeof value === 'string' ? value : (isObject(value) ? value[key] : null)).filter((value) => typeof value === 'string')
}
function repoFromCommand() {
  const index = args.indexOf('--repo')
  const value = index >= 0 ? args[index + 1] : 'test-owner/test-repo'
  const parts = typeof value === 'string' ? value.split('/') : []
  return parts.length >= 2 ? { owner: parts[parts.length - 2], repo: parts[parts.length - 1] } : { owner: 'test-owner', repo: 'test-repo' }
}

function dynamicRest() {
  if (!endpoint) return { handled: false }
  const collection = routeIssueCollection(endpoint)
  if (collection && method === 'POST' && isObject(resources.issues)) {
    const { owner, repo } = { owner: collection[1], repo: collection[2] }
    let number = Number(state.nextIssueNumber ?? 101)
    while (hasOwn(resources.issues, issueKey(owner, repo, number))) number += 1
    state.nextIssueNumber = number + 1
    const created = {
      ...(isObject(requestBody) ? requestBody : {}),
      number,
      state: 'open',
      url: 'https://github.com/' + owner + '/' + repo + '/issues/' + number,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z'
    }
    resources.issues[issueKey(owner, repo, number)] = created
    return { handled: true, value: created }
  }

  const child = routeIssueChild(endpoint)
  if (child && issueStore) {
    const key = issueKey(child[1], child[2], child[3])
    const kind = child[4]
    if (kind === 'timeline') return { handled: true, value: (resources.timeline && resources.timeline[key]) ?? [] }
    const comments = isObject(resources.comments) ? resources.comments : (resources.comments = {})
    const current = Array.isArray(comments[key]) ? comments[key] : (comments[key] = [])
    if (method === 'GET') return { handled: true, value: current }
    if (method === 'POST') {
      const id = Number(state.nextCommentId ?? 500)
      state.nextCommentId = id + 1
      const created = {
        id,
        body: typeof requestBody?.body === 'string' ? requestBody.body : '',
        issue_url: 'https://api.github.com/repos/' + child[1] + '/' + child[2] + '/issues/' + child[3],
        html_url: 'https://github.com/' + child[1] + '/' + child[2] + '/issues/' + child[3] + '#issuecomment-' + id,
        created_at: '2026-10-01T00:00:00Z',
        user: { login: 'hosting-fixture' }
      }
      current.push(created)
      return { handled: true, value: created }
    }
  }
  const collectionMutation = routeIssueCollectionMutation(endpoint)
  if (collectionMutation && issueStore) {
    const key = issueKey(collectionMutation[1], collectionMutation[2], collectionMutation[3])
    const issue = issueStore[key]
    const collectionName = collectionMutation[4]
    if (isObject(issue) && collectionName === 'labels' && method === 'POST') {
      const requested = Array.isArray(requestBody?.labels) ? requestBody.labels : []
      const names = asNames(issue.labels, 'name')
      for (const name of requested) {
        if (typeof name === 'string' && !names.includes(name)) names.push(name)
      }
      issue.labels = names.map((name) => {
        const existing = Array.isArray(issueStore[key].labels)
          ? issueStore[key].labels.find((label) => isObject(label) && label.name === name)
          : null
        return isObject(existing) ? existing : { name, color: 'd73a4a' }
      })
      return { handled: true, value: issue.labels }
    }
    if (isObject(issue) && collectionName === 'labels' && method === 'DELETE' && collectionMutation[5] !== undefined) {
      const labelName = decodeURIComponent(collectionMutation[5])
      const current = Array.isArray(issue.labels) ? issue.labels : []
      if (!current.some((label) => (isObject(label) ? label.name : label) === labelName)) fail('HTTP 404: label not found')
      issue.labels = current.filter((label) => (isObject(label) ? label.name : label) !== labelName)
      return { handled: true, value: null }
    }
    if (isObject(issue) && collectionName === 'assignees' && (method === 'POST' || method === 'DELETE')) {
      const requested = Array.isArray(requestBody?.assignees) ? requestBody.assignees : []
      const names = asNames(issue.assignees, 'login')
      const next = method === 'POST'
        ? [...names, ...requested.filter((login) => typeof login === 'string' && !names.includes(login))]
        : names.filter((login) => !requested.includes(login))
      issue.assignees = next.map((login) => {
        const existing = Array.isArray(issueStore[key].assignees)
          ? issueStore[key].assignees.find((assignee) => isObject(assignee) && assignee.login === login)
          : null
        return isObject(existing) ? existing : { login, name: login, avatar_url: 'https://avatars.example/' + login }
      })
      return { handled: true, value: issue }
    }
  }


  const globalComment = routeGlobalComment(endpoint)
  if (globalComment && commentStore) {
    const id = Number(globalComment[3])
    for (const [key, comments] of Object.entries(commentStore)) {
      if (!Array.isArray(comments)) continue
      const index = comments.findIndex((comment) => isObject(comment) && Number(comment.id) === id)
      if (index < 0) continue
      if (method === 'GET') return { handled: true, value: comments[index] }
      if (method === 'PATCH') {
        comments[index] = { ...comments[index], ...(isObject(requestBody) ? requestBody : {}) }
        return { handled: true, value: comments[index] }
      }
      if (method === 'DELETE') {
        comments.splice(index, 1)
        return { handled: true, value: null }
      }
    }
  }

  const issue = routeIssueParts(endpoint)
  if (issue && issueStore) {
    const key = issueKey(issue[1], issue[2], issue[3])
    if (hasOwn(issueStore, key)) {
      if (method === 'GET') return { handled: true, value: issueStore[key] }
      if (method === 'PATCH') {
        const requested = isObject(requestBody) ? requestBody : {}
        const patch = { ...requested }
        if (Array.isArray(requested.labels)) {
          patch.labels = requested.labels.map((name) => {
            const existing = Array.isArray(issueStore[key].labels)
              ? issueStore[key].labels.find((label) => isObject(label) && label.name === name)
              : null
            return isObject(existing) ? existing : { name, color: 'd73a4a' }
          })
        }
        if (Array.isArray(requested.assignees)) {
          patch.assignees = requested.assignees.map((login) => {
            const existing = Array.isArray(issueStore[key].assignees)
              ? issueStore[key].assignees.find((assignee) => isObject(assignee) && assignee.login === login)
              : null
            return isObject(existing) ? existing : { login, name: login, avatar_url: 'https://avatars.example/' + login }
          })
        }
        issueStore[key] = { ...issueStore[key], ...patch, updated_at: '2026-10-02T00:00:00Z' }
        return { handled: true, value: issueStore[key] }
      }
    }
  }

  const pull = routePull(endpoint)
  if (pull && pullStore) {
    const key = pullKey(pull[1], pull[2], pull[3])
    if (hasOwn(pullStore, key)) {
      if (pull[4] === 'files') return { handled: true, value: (resources.files && resources.files[key]) ?? [] }
      if (pull[4] === 'reviews') return { handled: true, value: (resources.reviews && resources.reviews[key]) ?? [] }
      if (method === 'GET') return { handled: true, value: pullStore[key] }
      if (method === 'PATCH') {
        pullStore[key] = { ...pullStore[key], ...(isObject(requestBody) ? requestBody : {}), updated_at: '2026-10-02T00:00:00Z' }
        return { handled: true, value: pullStore[key] }
      }
    }
  }
  return { handled: false }
}

const statefulRest = dynamicRest()
if (statefulRest.handled) emit(statefulRest.value)

if (rule && Object.hasOwn(rule, 'body')) {
  process.stdout.write(typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body))
  process.exit(0)
}

function resourceIdentityFromArgs() {
  const path = endpoint.startsWith('repos/') ? endpoint : ''
  if (path) return apiRepo(path)
  return repoFromCommand()
}
function updateCliIssue() {
  const issueIndex = args.indexOf('issue')
  if (issueIndex < 0 || !isObject(resources.issues)) return false
  const action = args[issueIndex + 1]
  if (action !== 'close' && action !== 'reopen' && action !== 'edit') return false
  const number = args[issueIndex + 2]
  const { owner, repo } = resourceIdentityFromArgs()
  const key = issueKey(owner, repo, number)
  if (!hasOwn(resources.issues, key)) return false
  const current = resources.issues[key]
  if (action === 'close') {
    current.state = 'closed'
    const reasonIndex = args.indexOf('--reason')
    if (reasonIndex >= 0) current.state_reason = args[reasonIndex + 1]
    const duplicateIndex = args.indexOf('--duplicate-of')
    if (duplicateIndex >= 0) current.duplicate_of = Number(args[duplicateIndex + 1])
  } else if (action === 'reopen') {
    current.state = 'open'
  } else {
    for (let index = issueIndex + 3; index < args.length; index += 1) {
      const flag = args[index]
      const value = args[index + 1]
      if (flag === '--title') current.title = value
      if (flag === '--add-label') current.labels = [...asNames(current.labels, 'name'), value].map((name) => ({ name }))
      if (flag === '--remove-label') current.labels = asNames(current.labels, 'name').filter((name) => name !== value).map((name) => ({ name }))
      if (flag === '--add-assignee') current.assignees = [...asNames(current.assignees, 'login'), value].map((login) => ({ login }))
      if (flag === '--remove-assignee') current.assignees = asNames(current.assignees, 'login').filter((login) => login !== value).map((login) => ({ login }))
    }
  }
  return true
}

if (updateCliIssue()) emit({})

if (args.includes('pr') && args.includes('view')) {
  const viewIndex = args.indexOf('view')
  const number = args[viewIndex + 1]
  const { owner, repo } = repoFromCommand()
  const key = pullKey(owner, repo, number)
  if (pullStore && hasOwn(pullStore, key)) emit(pullStore[key])
}

function variable(name) {
  if (variables[name] !== undefined) return variables[name]
  const direct = args.find((part) => part.startsWith(name + '='))
  return direct ? parseValue(direct.slice(name.length + 1)) : undefined
}
function projectItem(projectId, itemId) {
  if (!projectItemStore) return null
  return projectItemStore[projectId + '/' + itemId] ?? projectItemStore[itemId] ?? null
}
function projectFieldConfiguration(projectId, fieldId) {
  for (const project of Object.values(resources.projectViews ?? {})) {
    if (!isObject(project) || (project.projectId ?? 'PVT_4') !== projectId) continue
    for (const view of Array.isArray(project.views) ? project.views : []) {
      const fields = isObject(view) && isObject(view.fields) && Array.isArray(view.fields.nodes)
        ? view.fields.nodes
        : (isObject(view) && Array.isArray(view.fields) ? view.fields : [])
      const configuration = fields.find((field) => isObject(field) && field.id === fieldId)
      if (configuration) return configuration
    }
  }
  return null
}
function itemResource(item) {
  const url = typeof item.url === 'string' ? item.url : ''
  const match = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/(issues|pull)\/([0-9]+)\/?$/.exec(url)
  if (!match) return { owner: null, repo: null, resource: null }
  const key = issueKey(match[1], match[2], match[4])
  const store = match[3] === 'issues' ? issueStore : pullStore
  return { owner: match[1], repo: match[2], resource: isObject(store) && isObject(store[key]) ? store[key] : null }
}
function itemGraphNode(item) {
  const kind = item.kind === 'pullRequest' ? 'PullRequest' : 'Issue'
  const source = itemResource(item)
  const resource = source.resource ?? {}
  const labels = (Array.isArray(resource.labels) ? resource.labels : []).flatMap((label) => {
    const entry = isObject(label) ? label : { name: label }
    return typeof entry.name === 'string' ? [{ name: entry.name, color: typeof entry.color === 'string' ? entry.color : '' }] : []
  })
  const assignees = (Array.isArray(resource.assignees) ? resource.assignees : []).flatMap((assignee) => {
    const entry = isObject(assignee) ? assignee : { login: assignee }
    return typeof entry.login === 'string' ? [{
      login: entry.login,
      name: typeof entry.name === 'string' ? entry.name : null,
      avatarUrl: typeof entry.avatarUrl === 'string' ? entry.avatarUrl : typeof entry.avatar_url === 'string' ? entry.avatar_url : null
    }] : []
  })
  const fieldValues = Object.entries(projectFieldStore ?? {})
    .filter(([key]) => key.startsWith(item.projectId + '/' + item.id + '/'))
    .map(([key, value]) => {
      const fieldId = key.split('/').at(-1)
      const fieldValue = isObject(value) && isObject(value.value) ? value.value : {}
      const configuration = projectFieldConfiguration(item.projectId, fieldId)
      const field = {
        __typename: isObject(configuration) && typeof configuration.__typename === 'string' ? configuration.__typename : 'ProjectV2Field',
        id: fieldId,
        name: isObject(configuration) && typeof configuration.name === 'string' ? configuration.name : fieldId
      }
      if (Array.isArray(fieldValue.multiSelectOptionIds)) {
        const configuredOptions = isObject(configuration) && Array.isArray(configuration.multiSelectOptions) ? configuration.multiSelectOptions : []
        return {
          __typename: 'ProjectV2ItemFieldMultiSelectValue',
          field,
          options: fieldValue.multiSelectOptionIds.flatMap((optionId) => {
            const option = configuredOptions.find((entry) => isObject(entry) && entry.id === optionId)
            return !isObject(option) || typeof option.name !== 'string' ? [] : [{ id: option.id, name: option.name }]
          })
        }
      }
      return { __typename: 'ProjectV2ItemFieldTextValue', field, ...fieldValue }
    })
  const builtInFieldValues = source.resource === null ? [] : [
    { __typename: 'ProjectV2ItemFieldLabelValue', field: { __typename: 'ProjectV2Field', id: 'FIELD_LABELS', name: 'Labels' }, labels: { nodes: labels } },
    { __typename: 'ProjectV2ItemFieldUserValue', field: { __typename: 'ProjectV2Field', id: 'FIELD_ASSIGNEES', name: 'Assignees' }, users: { nodes: assignees } }
  ]
  const state = String(resource.state ?? item.state ?? 'OPEN').toUpperCase()
  const stateReason = typeof resource.state_reason === 'string'
    ? resource.state_reason.toUpperCase()
    : typeof resource.stateReason === 'string'
      ? resource.stateReason.toUpperCase()
      : null
  return {
    id: item.id,
    type: kind === 'PullRequest' ? 'PULL_REQUEST' : 'ISSUE',
    content: {
      __typename: kind,
      number: item.number,
      title: resource.title ?? item.title ?? '',
      body: resource.body ?? item.body ?? '',
      ...(kind === 'PullRequest'
        ? { pullRequestState: state, isDraft: resource.isDraft === true || item.isDraft === true, stateReason: null }
        : { issueState: state, stateReason, issueType: resource.issueType ?? null }),
      url: resource.html_url ?? item.url,
      repository: { nameWithOwner: source.owner !== null && source.repo !== null ? source.owner + '/' + source.repo : null },
      labels: { nodes: labels },
      assignees: { nodes: assignees },
      ...(item.parent === undefined ? {} : { parent: item.parent })
    },
    fieldValues: { nodes: [...fieldValues, ...builtInFieldValues] }
  }
}

function dynamicGraphql() {
  if (query.includes('ProjectItemContext') && projectItemStore) {
    const projectId = variable('projectId')
    const itemId = variable('itemId')
    const item = projectItem(projectId, itemId)
    if (!item) return { handled: false }
    return {
      handled: true,
      value: {
        data: {
          project: { id: projectId, owner: { __typename: item.ownerType ?? 'Organization', login: item.owner ?? 'test-owner' } },
          item: {
            id: item.id ?? itemId,
            project: { id: projectId },
            content: {
              __typename: item.kind === 'pullRequest' ? 'PullRequest' : 'Issue',
              number: item.number,
              url: item.url
            }
          }
        }
      }
    }
  }

  if (query.includes('ProjectViews') && isObject(resources.projectViews)) {
    const owner = variable('owner')
    const number = Number(variable('number'))
    const kind = query.includes('organization(login:') ? 'organization' : 'user'
    const view = resources.projectViews[kind + '/' + owner + '/' + number]
    if (view) return { handled: true, value: { data: { [kind]: { projectV2: { id: view.projectId ?? 'PVT_4', number, views: { nodes: view.views ?? [], pageInfo: { hasNextPage: false } } } } } } }
  }

  if (query.includes('ProjectItems') && projectItemStore) {
    const owner = variable('owner')
    const number = Number(variable('number'))
    const entries = Object.values(projectItemStore).filter((item) => isObject(item) && item.owner === owner && Number(item.projectNumber ?? number) === number)
    const projectId = entries[0]?.projectId ?? resources.projectId ?? 'PVT_4'
    const nodes = entries.map(itemGraphNode)
    return { handled: true, value: { data: { organization: { projectV2: { id: projectId, number, items: { nodes, pageInfo: { endCursor: null, hasNextPage: false }, totalCount: nodes.length } } } } } }
  }

  if (query.includes('WorkItemDetails') && issueStore) {
    const owner = variable('owner')
    const repo = variable('repo')
    const number = Number(variable('number'))
    const key = issueKey(owner, repo, number)
    const issue = issueStore[key]
    if (issue) {
      const comments = commentStore && Array.isArray(commentStore[key]) ? commentStore[key] : []
      const assignees = asNames(issue.assignees, 'login').map((login) => ({ login }))
      const labels = asNames(issue.labels, 'name').map((name) => ({ name }))
      const participants = [...new Set([issue.user?.login, ...comments.map((comment) => comment.user?.login)].filter((name) => typeof name === 'string'))].map((login) => ({ login }))
      return {
        handled: true,
        value: {
          data: {
            repository: {
              issue: {
                ...issue,
                __typename: 'Issue',
                labels: { nodes: labels },
                assignees: { nodes: assignees, pageInfo: { hasNextPage: false } },
                participants: { nodes: participants, pageInfo: { hasNextPage: false } },
                comments: { nodes: comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, url: comment.html_url, author: comment.user, authorAssociation: 'CONTRIBUTOR' })), pageInfo: { hasNextPage: false } }
              }
            }
          }
        }
      }
    }
  }

  if (query.includes('OrganizationIssueTypes') && issueStore && issueTypeStore) {
    const owner = variable('owner')
    const repoOwner = variable('repoOwner')
    const repo = variable('repo')
    const number = Number(variable('number'))
    const issue = issueStore[issueKey(repoOwner, repo, number)]
    if (issue) return { handled: true, value: { data: { repository: { issue: { id: issue.nodeId ?? 'ISSUE_NODE_' + number } }, organization: { issueTypes: { nodes: issueTypeStore[owner] ?? [], pageInfo: { hasNextPage: false } } } } } }
  }

  if (query.includes('mutation SetProjectField') || query.includes('mutation ClearProjectField')) {
    if (projectFieldStore) {
      const inputValue = isObject(variables.input) ? variables.input : variables
      const key = inputValue.projectId + '/' + inputValue.itemId + '/' + inputValue.fieldId
      if (query.includes('mutation ClearProjectField')) delete projectFieldStore[key]
      else projectFieldStore[key] = { value: inputValue.value }
      save()
      const fieldName = query.includes('mutation ClearProjectField') ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue'
      return { handled: true, value: { data: { [fieldName]: { projectV2Item: { id: inputValue.itemId } } } } }
    }
  }

  if (query.includes('mutation SetIssueType') && issueStore) {
    const inputValue = isObject(variables.input) ? variables.input : variables
    for (const issue of Object.values(issueStore)) {
      if (isObject(issue) && (issue.nodeId ?? '') === inputValue.issueId) {
        const types = issueTypeStore?.[issue.owner ?? 'test-owner'] ?? []
        const selected = types.find((entry) => isObject(entry) && entry.id === inputValue.issueTypeId)
        if (selected) issue.issueType = selected
        save()
        return { handled: true, value: { data: { updateIssueIssueType: { issue: { id: inputValue.issueId, issueType: selected ?? null } } } } }
      }
    }
  }
  return { handled: false }
}

if (command.includes('api') && command.includes('graphql')) {
  const dynamic = dynamicGraphql()
  if (dynamic.handled) emit(dynamic.value)
  const tokenRules = isObject(state.graphqlByToken) ? state.graphqlByToken[process.env.GH_TOKEN ?? ''] : undefined
  const graphRules = Array.isArray(tokenRules) ? tokenRules : Array.isArray(state.graphql) ? state.graphql : []
  const sameQueryCalls = calls.filter((entry) => entry && entry.query === query).length
  const variableText = JSON.stringify(variables)
  const graphRule = graphRules.find((entry) =>
    entry && typeof entry.when === 'string' &&
    (entry.when.startsWith('field:')
      ? matchesGraphqlField(query, entry.when.slice('field:'.length))
      : query.includes(entry.when)) &&
    (entry.whenArgs === undefined || command.includes(entry.whenArgs) || variableText.includes(entry.whenArgs) || query.includes(entry.whenArgs)) &&
    (entry.nth === undefined || entry.nth === sameQueryCalls)
  )
  if (graphRule && typeof graphRule.error === 'string') fail(graphRule.error)
  emit(graphRule?.body ?? { data: {} })
}



if (method !== 'GET') emit({ number: 101, id: 9001, url: 'https://github.com/test-owner/test-repo/issues/101', state: 'open' })
emit({})
`

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object result')
  }
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array result')
  return value
}

async function hosting(state: unknown = {}, options?: Parameters<typeof bootHosting>[1]): Promise<HostingTest> {
  const instance = await bootHosting(ghFixture, options)
  instance.writeState(state)
  hosts.push(instance)
  return instance
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (caught: unknown) {
    error = caught
  }
  expect(error).toBeDefined()
  const details = object(error)
  expect(object(details.data).reason).toBe(reason)
}

async function expectConfirmationRequired(promise: Promise<unknown>): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (caught: unknown) {
    error = caught
  }
  expect(error).toBeDefined()
  expect(object(error).code).toBe(-32009)
}

test('GH27: a removed upstream resolves to origin and marks the issue source fallback', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'search(type: ISSUE',
        whenArgs: 'test-owner/test-repo is:issue',
        body: {
          data: {
            search: {
              issueCount: 8,
              pageInfo: { endCursor: 'issue-cursor-1', hasNextPage: false },
              nodes: [
                { __typename: 'Issue', number: 12, title: 'issue two', issueState: 'OPEN', url: 'https://github.com/test-owner/test-repo/issues/12', updatedAt: '2026-10-01T00:00:00Z' },
                { __typename: 'Issue', number: 13, title: 'issue three', issueState: 'OPEN', url: 'https://github.com/test-owner/test-repo/issues/13', updatedAt: '2026-09-30T00:00:00Z' },
                { __typename: 'Issue', number: 14, title: 'issue four', issueState: 'OPEN', url: 'https://github.com/test-owner/test-repo/issues/14', updatedAt: '2026-09-28T00:00:00Z' },
                { __typename: 'Issue', number: 15, title: 'issue five', issueState: 'OPEN', url: 'https://github.com/test-owner/test-repo/issues/15', updatedAt: '2026-09-27T00:00:00Z' }
              ]
            },
            rateLimit: { cost: 1 }
          }
        }
      },
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:pr', body: { data: { search: { issueCount: 4, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
    ],
    responses: [{
      when: 'pr list',
      body: [
        { number: 41, title: 'review two', state: 'OPEN', url: 'https://github.com/test-owner/test-repo/pull/41', isDraft: false, updatedAt: '2026-10-02T00:00:00Z' },
        { number: 42, title: 'review three', state: 'CLOSED', url: 'https://github.com/test-owner/test-repo/pull/42', isDraft: true, updatedAt: '2026-09-29T00:00:00Z' },
        { number: 43, title: 'review four', state: 'OPEN', url: 'https://github.com/test-owner/test-repo/pull/43', isDraft: false, updatedAt: '2026-09-26T00:00:00Z' },
        { number: 44, title: 'review five', state: 'OPEN', url: 'https://github.com/test-owner/test-repo/pull/44', isDraft: false, updatedAt: '2026-09-25T00:00:00Z' }
      ]
    }]
  }, { upstream: 'https://github.com/upstream-owner/upstream-repo.git' })

  const removed = Bun.spawnSync(['git', 'remote', 'remove', 'upstream'], { cwd: h.repoPath })
  expect(removed.exitCode).toBe(0)
  await h.call('configure', { issueSourcePreference: 'upstream' })
  const result = object(await h.call('listWorkItems', { query: 'is:open', page: 2, limit: 2 }))

  expect(list(result.items).map((item) => [object(item).kind, object(item).number])).toEqual([['issue', 13], ['pullRequest', 42]])
  expect(list(result.items).map((item) => object(item).state)).toEqual(['open', 'draft'])
  expect(result.page).toBe(2)
  expect(result.limit).toBe(2)
  expect(result.totalCount).toBe(12)
  expect(result.hasNextPage).toBe(true)
  expect(result.issueSourceFellBack).toBe(true)
  expect(object(result.sources).issues).toBe('origin')
  expect(object(result.sources).prs).toBe('origin')
}, 20_000)
test('GH27: upstream issue read failures remain partial and never switch repositories', async () => {
  const h = await hosting({
    graphql: [
      { when: 'search(type: ISSUE', whenArgs: 'upstream-owner/upstream-repo is:issue', error: 'HTTP 503: upstream unavailable' },
      { when: 'search(type: ISSUE', whenArgs: 'upstream-owner/upstream-repo is:pr', body: { data: { search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
    ],
    responses: [
      { when: 'search/issues?q=', method: 'GET', error: 'HTTP 503: upstream search unavailable' },
      { when: 'pr list', body: [{ number: 21, title: 'upstream PR', state: 'OPEN', url: 'https://github.com/upstream-owner/upstream-repo/pull/21', updatedAt: '2026-10-02T00:00:00Z' }] }
    ]
  }, { upstream: 'https://github.com/upstream-owner/upstream-repo.git' })

  await h.call('configure', { issueSourcePreference: 'upstream' })
  const result = object(await h.call('listWorkItems', { query: 'is:open', page: 1, limit: 10 }))
  const items = list(result.items).map(object)
  expect(items.map((item) => item.number)).toEqual([21])
  expect(result.partial).toBe(true)
  expect(object(result.errors).issues).toBeDefined()
  expect(result.issueSourceFellBack).toBe(false)
  expect(object(result.sources).issues).toBeNull()
  const calls = list(object(h.readState()).calls).map(object)
  const restSearches = calls.filter((call) => typeof call.endpoint === 'string' && call.endpoint.startsWith('search/issues?'))
  expect(restSearches.length).toBeGreaterThan(0)
  expect(restSearches.every((call) => String(call.endpoint).includes('upstream-owner'))).toBe(true)
  const graphSearches = calls.filter((call) => typeof call.query === 'string' && call.query.includes('WorkItemSearch'))
  expect(graphSearches.length).toBeGreaterThanOrEqual(2)
  expect(graphSearches.every((call) => JSON.stringify(call.variables).includes('upstream-owner/upstream-repo'))).toBe(true)
}, 20_000)

test('GH27: failed GitHub.com GraphQL search falls back to REST search on the same repository', async () => {
  const h = await hosting({
    graphql: [
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:issue', error: 'HTTP 500: GraphQL unavailable' },
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:pr', body: { data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
    ],
    responses: [
      { when: 'search/issues?q=', method: 'GET', body: { total_count: 1, items: [{ number: 9, title: 'REST result', state: 'open', html_url: 'https://github.com/test-owner/test-repo/issues/9', updated_at: '2026-10-01T00:00:00Z' }] } },
      { when: 'pr list', body: [] }
    ]
  })

  const result = object(await h.call('listWorkItems', { query: 'is:open', page: 1, limit: 10 }))
  const items = list(result.items).map(object)
  expect(items.map((item) => item.number)).toEqual([9])
  expect(result.partial).toBe(false)
  expect(object(result.sources).issues).toBe('origin')
}, 20_000)

test('GH27: malformed GraphQL search response falls back to same-repository REST search', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'search(type: ISSUE',
        whenArgs: 'test-owner/test-repo is:issue',
        body: { data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }
      },
      {
        when: 'search(type: ISSUE',
        whenArgs: 'test-owner/test-repo is:pr',
        body: { data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } }
      }
    ],
    responses: [
      {
        when: 'search/issues?q=',
        method: 'GET',
        body: {
          total_count: 1,
          items: [{ number: 11, title: 'REST result', state: 'open', html_url: 'https://github.com/test-owner/test-repo/issues/11' }]
        }
      },
      { when: 'pr list', body: [] }
    ]
  })

  const result = object(await h.call('listWorkItems', { query: 'is:open', page: 1, limit: 10 }))
  expect(list(result.items).map((item) => object(item).number)).toEqual([11])
  expect(object(result.sources).issues).toBe('origin')
  expect(result.partial).toBe(false)
}, 20_000)
test('GH27: malformed REST search JSON remains unavailable rather than becoming an empty result', async () => {
  const h = await hosting({
    graphql: [
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:issue', error: 'HTTP 500: GraphQL unavailable' },
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:pr', body: { data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
    ],
    responses: [
      { when: 'search/issues?q=', method: 'GET', body: {} },
      { when: 'pr list', body: [] }
    ]
  })

  const result = object(await h.call('listWorkItems', { query: 'is:open', page: 1, limit: 10 }))
  expect(result.partial).toBe(true)
  expect(object(result.errors).issues).toBeDefined()
  expect(object(result.sources).issues).toBeNull()
  expect(list(result.items)).toEqual([])
}, 20_000)
test('GH27: origin preference affects issues while pull requests still prefer upstream', async () => {
  const h = await hosting({
    graphql: [
      { when: 'search(type: ISSUE', whenArgs: 'test-owner/test-repo is:issue', body: { data: { search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'Issue', number: 20, title: 'origin issue', issueState: 'OPEN', updatedAt: '2026-10-01T00:00:00Z' }] }, rateLimit: { cost: 1 } } } },
      { when: 'search(type: ISSUE', whenArgs: 'upstream-owner/upstream-repo is:pr', body: { data: { search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
    ],
    responses: [{
      when: 'pr list',
      body: [{ number: 21, title: 'upstream review', state: 'OPEN', updatedAt: '2026-10-02T00:00:00Z', url: 'https://github.com/upstream-owner/upstream-repo/pull/21' }]
    }]
  }, { upstream: 'https://github.com/upstream-owner/upstream-repo.git' })

  await h.call('configure', { issueSourcePreference: 'origin' })
  const result = object(await h.call('listWorkItems', { query: 'is:open', limit: 10, page: 1 }))
  expect(object(result.sources).issues).toBe('origin')
  expect(object(result.sources).prs).toBe('upstream')
  expect(result.issueSourceFellBack).toBe(false)
  expect(list(result.items).map((item) => object(item).number)).toContain(20)
}, 20_000)

test('GH27: search offset cap rejects before an upstream request and count exposes a numeric total', async () => {
  const h = await hosting({ graphql: [
    { when: 'search(type: ISSUE', whenArgs: 'repo:test-owner/test-repo is:issue is:issue sort:updated-desc', body: { data: { search: { issueCount: 23, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } },
    { when: 'search(type: ISSUE', whenArgs: 'repo:test-owner/test-repo is:pr is:issue sort:updated-desc', body: { data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, rateLimit: { cost: 1 } } } }
  ] })
  const before = h.invocations().length

  await expectReason(h.call('listWorkItems', { query: 'is:issue', page: 11, limit: 100 }), 'too_large')
  expect(h.invocations()).toHaveLength(before)
  expect(object(await h.call('countWorkItems', { query: 'is:issue' })).count).toBe(23)
}, 20_000)

test('GH27: a failed source remains partial while the successful source is returned', async () => {
  const h = await hosting({
    graphql: [{
      when: 'search(type: ISSUE',
      body: {
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [{ __typename: 'Issue', number: 5, title: 'available', issueState: 'OPEN' }]
          },
          rateLimit: { cost: 1 }
        }
      }
    }],
    responses: [{ when: 'pr list', error: 'HTTP 503: server error' }]
  })

  const result = object(await h.call('listWorkItems', { query: 'needs:review', page: 1, limit: 5 }))
  expect(list(result.items).map((item) => object(item).number)).toContain(5)
  expect(object(result.errors).prs).toBeDefined()
  expect(result.partial).toBe(true)
}, 20_000)

test('GH28: an issue endpoint response marked as a PR is hydrated as a PR, not an issue', async () => {
  const h = await hosting({
    responses: [
      { when: 'repos/test-owner/test-repo/issues/17', body: { number: 17, title: 'a pull request', state: 'open', pull_request: { url: 'https://api.github.com/repos/test-owner/test-repo/pulls/17' } } },
      { when: 'pr view 17', body: { number: 17, title: 'a pull request', state: 'OPEN', url: 'https://github.com/test-owner/test-repo/pull/17', isDraft: false, headRefName: 'topic', baseRefName: 'main', headRefOid: 'a'.repeat(40) } }
    ]
  })

  const item = object(await h.call('workItem', { number: 17 }))
  expect(item.kind).toBe('pullRequest')
  expect(item.number).toBe(17)
}, 20_000)

test('GH29: configured work-item references resolve and foreign pasted references fail closed', async () => {
  const h = await hosting({ responses: [{ when: 'repos/test-owner/test-repo/issues/9', body: { number: 9, title: 'configured', state: 'open', url: 'https://api.github.com/repos/test-owner/test-repo/issues/9', html_url: 'https://github.com/test-owner/test-repo/issues/9' } }] })

  expect(object(await h.call('workItem', { reference: 'https://github.com/test-owner/test-repo/issues/9' })).url).toBe('https://github.com/test-owner/test-repo/issues/9')
  const before = h.invocations().length
  await expectReason(h.call('workItem', { reference: 'https://evil.example/other/repo/issues/9' }), 'validation_error')
  expect(h.invocations()).toHaveLength(before)
}, 20_000)

test('GH29: issue details include participants and timeline pages, with explicit partial availability', async () => {
  const h = await hosting({
    graphql: [{
      when: 'issue(number:',
      body: {
        data: {
          repository: {
            issue: {
              number: 9,
              body: 'description',
              participants: {
                nodes: [{ login: 'author' }, { login: 'commenter' }],
                pageInfo: { hasNextPage: false }
              },
              assignees: { nodes: [{ login: 'assignee' }] },
              comments: {
                nodes: [{ id: 'c1', body: 'comment' }],
                pageInfo: { hasNextPage: false }
              }
            }
          }
        }
      }
    }],
    responses: [
      { when: 'issues/9/timeline', body: [{ event: 'closed', created_at: '2026-10-01T00:00:00Z' }] },
      { when: 'repos/test-owner/test-repo/issues/9', body: { number: 9, title: 'details', state: 'open', body: 'description' } }
    ]
  })

  const details = object(await h.call('workItemDetails', { number: 9, kind: 'issue' }))
  expect(list(details.participants).map((participant) => object(participant).login)).toContain('commenter')
  expect(list(details.timeline)).toHaveLength(1)
  expect(details.partialFailures).toEqual([])
  expect(details.truncated).toBe(false)
}, 20_000)
test('GH29: failed detail sources return partial availability instead of empty success', async () => {
  const h = await hosting({
    graphql: [{ when: 'issue(number:', error: 'HTTP 503: server error' }],
    responses: [
      { when: 'issues/10/timeline', error: 'HTTP 500: timeline unavailable' },
      { when: 'issues/10/comments', error: 'HTTP 403: Resource not accessible by integration' },
      { when: 'repos/test-owner/test-repo/issues/10', method: 'GET', body: { number: 10, title: 'partial', state: 'open', body: 'description' } }
    ]
  })

  const details = object(await h.call('workItemDetails', { number: 10, kind: 'issue' }))
  expect(list(details.partialFailures).length).toBeGreaterThanOrEqual(2)
  expect(details.timeline).toEqual([])
  expect(details.truncated).toBe(false)
}, 20_000)

test('GH28: an oversized issue body falls back to an empty body and exposes the confirmed partial create', async () => {
  const h = await hosting({
    resources: { issues: {} },
    responses: [
      { when: 'POST repos/test-owner/test-repo/issues', method: 'POST', nth: 1, error: 'HTTP 422: body is too long' },
      { when: 'PATCH repos/test-owner/test-repo/issues/101', method: 'PATCH', error: 'HTTP 500: unable to save description' }
    ]
  })

  const result = object(await h.call('createIssue', { title: 'long body', body: 'a body larger than the provider accepts', labels: ['bug'], assignees: ['fixture'] }))
  const persisted = object(await h.call('workItem', { number: 101, kind: 'issue' }))
  expect(result.number).toBe(101)
  expect(result.bodySaveWarning).toBeDefined()
  expect(result.partial).toBe(true)
  expect(persisted.title).toBe('long body')
  expect(persisted.body).toBe('')
  expect(persisted.labels).toEqual(['bug'])
  expect(persisted.assignees).toEqual(['fixture'])
}, 20_000)

test('GH28: issue update and comment writes are visible in subsequent work-item reads', async () => {
  const h = await hosting({
    resources: {
      issues: {
        'test-owner/test-repo/22': {
          number: 22,
          title: 'reported',
          body: 'original body',
          state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/22',
          labels: [{ name: 'question' }],
          assignees: [{ login: 'reporter' }],
          user: { login: 'reporter' }
        }
      },
      comments: { 'test-owner/test-repo/22': [] }
    }
  })

  await h.call('updateIssue', {
    number: 22,
    state: 'closed',
    stateReason: 'not_planned',
    duplicateOf: 7,
    title: 'triaged',
    body: 'details',
    addLabels: ['bug'],
    removeLabels: ['question'],
    addAssignees: ['maintainer'],
    removeAssignees: ['reporter']
  })
  await h.call('issueComment', { number: 22, body: 'Acknowledged' })

  const item = object(await h.call('workItem', { number: 22, kind: 'issue' }))
  const details = object(await h.call('workItemDetails', { number: 22, kind: 'issue' }))
  expect(item.title).toBe('triaged')
  expect(item.body).toBe('details')
  expect(item.state).toBe('closed')
  expect(item.stateReason).toBe('not_planned')
  expect(item.duplicateOf).toBe(7)
  expect(item.labels).toEqual(['bug'])
  expect(item.assignees).toEqual(['maintainer'])
  expect(list(details.comments).map((comment) => object(comment).body)).toEqual(['Acknowledged'])
}, 20_000)
test('GH28: updateIssue reports confirmed state changes when a later content edit fails', async () => {
  const h = await hosting({
    resources: {
      issues: { 'test-owner/test-repo/22': { number: 22, title: 'old', body: 'old body', state: 'open', url: 'https://github.com/test-owner/test-repo/issues/22' } }
    },
    responses: [{ when: 'PATCH repos/test-owner/test-repo/issues/22', method: 'PATCH', error: 'HTTP 500: server error' }]
  })
  let failure: unknown
  try {
    await h.call('updateIssue', { number: 22, state: 'closed', title: 'new title' })
  } catch (error: unknown) {
    failure = error
  }
  const data = object(object(failure).data)
  const item = object(await h.call('workItem', { number: 22, kind: 'issue' }))
  expect(data.partial).toBe(true)
  expect(data.completedSteps).toEqual(['state'])
  expect(item.state).toBe('closed')
  expect(item.title).toBe('old')
}, 20_000)
test('GH28: labels and assignable users paginate from the configured issue repository', async () => {
  const firstLabels = Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` }))
  const h = await hosting({
    responses: [
      { when: 'labels?per_page=100&page=1', method: 'GET', body: firstLabels },
      { when: 'labels?per_page=100&page=2', method: 'GET', body: [{ name: 'bug' }] },
      { when: 'assignees?per_page=100&page=1', method: 'GET', body: [{ login: 'maintainer', avatar_url: 'https://avatars.example/1' }, { login: 'other' }] }
    ]
  })

  const labels = object(await h.call('labels', { query: 'bug' }))
  const assignees = object(await h.call('assignees', { query: 'main' }))
  expect(labels.labels).toEqual(['bug'])
  expect(list(assignees.assignees).map((user) => object(user).login)).toEqual(['maintainer'])
}, 20_000)

test('GH30: project discovery paginates the viewer and keeps good organizations when one organization fails', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'viewer { login projectsV2',
        body: {
          data: {
            viewer: {
              login: 'fixture',
              projectsV2: {
                nodes: [{ id: 'p1', number: 1, title: 'Mine' }],
                pageInfo: { endCursor: 'v1', hasNextPage: true },
                totalCount: 21
              },
              organizations: {
                nodes: [{ login: 'broken' }, { login: 'good' }],
                pageInfo: { endCursor: 'o1', hasNextPage: false }
              }
            }
          }
        }
      },
      {
        when: 'projectsV2(first: 20, after: $cursor)',
        body: {
          data: {
            viewer: {
              projectsV2: {
                nodes: [{ id: 'p2', number: 2, title: 'Mine two' }],
                pageInfo: { endCursor: null, hasNextPage: false },
                totalCount: 2
              }
            }
          }
        }
      },
      {
        when: 'organization(login: $login)',
        nth: 1,
        error: 'HTTP 403: Resource not accessible by integration'
      },
      {
        when: 'organization(login: $login)',
        nth: 2,
        body: {
          data: {
            organization: {
              login: 'good',
              projectsV2: {
                nodes: [{ id: 'pg', number: 3, title: 'Org project' }],
                pageInfo: { hasNextPage: false },
                totalCount: 1
              }
            }
          }
        }
      }
    ]
  })

  const projects = object(await h.call('projects', {}))
  expect(list(projects.projects).map((project) => object(project).number)).toEqual([1, 2, 3])
  expect(list(projects.partialFailures)).toHaveLength(1)
  expect(projects.truncated).toBe(false)
}, 20_000)

test('GH30: project references accept only a configured, exact GitHub project URL or owner/number', async () => {
  const h = await hosting({
    graphql: [{ when: 'organization(login: $owner)', body: { data: { organization: { login: 'test-owner', projectV2: { id: 'PVT_1', number: 4, title: 'Board' } } } } }]
  })

  const project = object(await h.call('projectRef', { input: 'https://github.com/orgs/test-owner/projects/4/views/2' }))
  expect(project.number).toBe(4)
  const shorthand = object(await h.call('projectRef', { input: 'test-owner/4' }))
  expect(shorthand.number).toBe(4)
  const before = h.invocations().length
  await expectReason(h.call('projectRef', { input: 'https://attacker@evil.example/orgs/test-owner/projects/4' }), 'validation_error')
  expect(h.invocations()).toHaveLength(before)
}, 20_000)

test('GH30: project views retry optional schema fields and preserve supported layouts', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'verticalGroupByFields',
        error: 'Field verticalGroupByFields not found on ProjectV2View'
      },
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                views: {
                  nodes: [
                    {
                      id: 'view-table',
                      number: 1,
                      name: 'Table',
                      layout: 'TABLE',
                      fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'field-status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'opt-ready', name: 'Ready' }] }] },
                      groupByFields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'field-status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'opt-ready', name: 'Ready' }] }] },
                      sortByFields: { nodes: [{ direction: 'DESC', field: { __typename: 'ProjectV2SingleSelectField', id: 'field-status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'opt-ready', name: 'Ready' }] } }] }
                    },
                    { id: 'view-roadmap', number: 2, name: 'Roadmap', layout: 'ROADMAP' }
                  ],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      }
    ]
  })

  const result = object(await h.call('projectViews', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  expect(list(result.views).map((view) => object(view).layout)).toEqual(['TABLE', 'ROADMAP'])
  const tableView = object(list(result.views)[0])
  expect(object(list(tableView.fields)[0]).options).toEqual([{ id: 'opt-ready', name: 'Ready' }])
  expect(object(list(tableView.sortByFields)[0]).direction).toBe('DESC')
  expect(object(object(list(tableView.sortByFields)[0]).field).id).toBe('field-status')
  const viewQueries = list(object(h.readState()).calls).map(object).filter((call) =>
    typeof call.query === 'string' && call.query.includes('ProjectViews')
  )
  expect(viewQueries).toHaveLength(2)
  expect(viewQueries[0].query).toContain('verticalGroupByFields')
  expect(viewQueries[1].query).not.toContain('verticalGroupByFields')
  expect(viewQueries[1].query).toContain('multiSelectOptions { id name }')
  expect(result.parentFieldDropped).toBe(false)
}, 20_000)

test('GH30: project table follows item cursors and returns typed rows', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                number: 4,
                views: {
                  nodes: [{
                    id: 'v-table',
                    number: 1,
                    name: 'Table',
                    layout: 'TABLE',
                    fields: { nodes: [] }
                  }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        nth: 1,
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                number: 4,
                items: {
                  nodes: [{
                    id: 'item-1',
                    fieldValues: { nodes: [] },
                    content: { __typename: 'Issue', number: 31, title: 'Row one', issueState: 'OPEN' }
                  }],
                  pageInfo: { endCursor: 'item-cursor', hasNextPage: true },
                  totalCount: 2
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        nth: 2,
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                number: 4,
                items: {
                  nodes: [{
                    id: 'item-2',
                    fieldValues: { nodes: [] },
                    content: { __typename: 'PullRequest', number: 32, title: 'Row two', pullRequestState: 'MERGED', isDraft: false }
                  }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                  totalCount: 2
                }
              }
            }
          }
        }
      }
    ]
  })

  const table = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const rows = list(table.items).map(object)
  expect(rows).toHaveLength(2)
  expect(object(rows[0].content).kind).toBe('issue')
  expect(object(rows[1].content).kind).toBe('pullRequest')
  expect(object(rows[0].content).state).toBe('open')
  expect(object(rows[1].content).state).toBe('merged')
  expect(table.layout).toBe('TABLE')
  expect(table.truncated).toBe(false)
}, 20_000)

test('GH30: project table uses its saved filter unless queryOverride is supplied', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                number: 4,
                views: {
                  nodes: [{ id: 'v-table', number: 1, name: 'Filtered', layout: 'TABLE', filter: 'is:open', fields: { nodes: [] } }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                number: 4,
                items: { nodes: [], pageInfo: { hasNextPage: false }, totalCount: 0 }
              }
            }
          }
        }
      }
    ]
  })

  await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 })
  await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4, queryOverride: 'is:closed' })
  const itemCalls = list(object(h.readState()).calls).map(object).filter((call) =>
    typeof call.query === 'string' && call.query.includes('ProjectItems')
  )
  expect(itemCalls.map((call) => object(call.variables).query)).toEqual(['is:open', 'is:closed'])
}, 20_000)
test('GH30: project table retries once without the optional issue parent field', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                views: {
                  nodes: [{ id: 'v-table', number: 1, name: 'Table', layout: 'TABLE' }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        whenArgs: 'parent { number title url }',
        error: 'Field parent not found on Issue'
      },
      {
        when: 'items(first: 100',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                items: {
                  nodes: [{
                    id: 'item-1',
                    fieldValues: { nodes: [] },
                    content: { __typename: 'Issue', number: 31, title: 'Row one', issueState: 'OPEN' }
                  }],
                  pageInfo: { hasNextPage: false },
                  totalCount: 1
                }
              }
            }
          }
        }
      }
    ]
  })

  const table = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  expect(list(table.items)).toHaveLength(1)
  expect(object(object(list(table.items)[0]).content).state).toBe('open')
  expect(table.parentFieldDropped).toBe(true)
}, 20_000)
test('GH30: board and roadmap views render and unknown layouts fail explicitly', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                views: {
                  nodes: [
                    {
                      id: 'v-board',
                      number: 1,
                      name: 'Board',
                      layout: 'BOARD',
                      groupByFields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'ready', name: 'Ready' }] }] },
                      sortByFields: { nodes: [{ direction: 'ASC', field: { __typename: 'ProjectV2SingleSelectField', id: 'status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'ready', name: 'Ready' }] } }] },
                      fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'ready', name: 'Ready' }] }] }
                    },
                    {
                      id: 'v-roadmap',
                      number: 2,
                      name: 'Roadmap',
                      layout: 'ROADMAP',
                      verticalGroupByFields: { nodes: [{ __typename: 'ProjectV2MultiSelectField', id: 'team', name: 'Team', dataType: 'MULTI_SELECT', multiSelectOptions: [{ id: 'team-a', name: 'Team A' }] }] },
                      sortByFields: { nodes: [{ direction: 'DESC', field: { __typename: 'ProjectV2Field', id: 'date-field', name: 'Start', dataType: 'DATE' } }] },
                      fields: { nodes: [{ __typename: 'ProjectV2Field', id: 'date-field', name: 'Start', dataType: 'DATE' }] }
                    },
                    { id: 'v-unknown', number: 3, name: 'Custom', layout: 'CUSTOM', fields: { nodes: [] } }
                  ],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                items: {
                  nodes: [],
                  pageInfo: { hasNextPage: false },
                  totalCount: 0
                }
              }
            }
          }
        }
      }
    ]
  })

  const board = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4, viewId: 'v-board' }))
  const roadmap = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4, viewNumber: 2 }))
  expect(board.layout).toBe('BOARD')
  expect(Array.isArray(board.boardColumns)).toBe(true)
  expect(roadmap.layout).toBe('ROADMAP')
  expect(list(object(roadmap.roadmap).dateFields)).toHaveLength(1)
  expect(object(list(board.fields)[0]).dataType).toBe('SINGLE_SELECT')
  expect(object(list(object(board.view).sortByFields)[0]).direction).toBe('ASC')
  expect(object(object(list(object(board.view).sortByFields)[0]).field).name).toBe('Status')
  expect(object(object(list(object(board.view).sortByFields)[0]).field).options).toEqual([{ id: 'ready', name: 'Ready' }])
  expect(object(list(object(roadmap.roadmap).groupByFields)[0]).dataType).toBe('MULTI_SELECT')
  expect(object(list(object(roadmap.roadmap).groupByFields)[0]).multiSelectOptions).toEqual([{ id: 'team-a', name: 'Team A' }])
  await expectReason(h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4, viewName: 'Custom' }), 'unsupported_layout')
}, 20_000)

test('GH31: project fields set and clear are visible in a subsequent project table read', async () => {
  const h = await hosting({
    resources: {
      projectItems: {
        'PVT_4/PVTI_7': {
          id: 'PVTI_7',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 31,
          title: 'Row',
          state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/31'
        }
      },
      projectViews: {
        'organization/test-owner/4': {
          projectId: 'PVT_4',
          views: [{
            id: 'VIEW_1',
            number: 1,
            name: 'Table',
            layout: 'TABLE',
            fields: { nodes: [{
              __typename: 'ProjectV2MultiSelectField',
              id: 'PVTF_3',
              name: 'Tags',
              dataType: 'MULTI_SELECT',
              multiSelectOptions: [{ id: 'OPT_1', name: 'Doing' }, { id: 'OPT_2', name: 'Blocked' }]
            }] }
          }]
        }
      },
      projectFields: {}
    }
  })

  await h.call('projectField', { projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_2', value: { text: 'Doing' } })
  const afterSet = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const setValues = list(object(list(afterSet.items)[0]).fieldValues).map(object)
  const storedValue = setValues.find((value) => value.fieldId === 'PVTF_2')
  expect(storedValue).toBeDefined()
  expect(object(storedValue).value).toBe('Doing')

  await h.call('projectField', {
    projectId: 'PVT_4',
    itemId: 'PVTI_7',
    fieldId: 'PVTF_3',
    value: { multiSelectOptionIds: ['OPT_1', 'OPT_2'] }
  })
  const afterMultiSet = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const multiValues = list(object(list(afterMultiSet.items)[0]).fieldValues).map(object)
  const storedMultiValue = multiValues.find((value) => value.fieldId === 'PVTF_3')
  expect(storedMultiValue).toBeDefined()
  expect(object(storedMultiValue).type).toBe('ProjectV2ItemFieldMultiSelectValue')
  expect(object(storedMultiValue).value).toEqual([{ id: 'OPT_1', name: 'Doing' }, { id: 'OPT_2', name: 'Blocked' }])
  expect(object(list(afterMultiSet.fields)[0]).multiSelectOptions).toEqual([{ id: 'OPT_1', name: 'Doing' }, { id: 'OPT_2', name: 'Blocked' }])

  const apiRequestsBeforeInvalidValue = list(object(h.readState()).calls).map(object).filter((call) =>
    (typeof call.query === 'string' && call.query.length > 0) ||
    (typeof call.endpoint === 'string' && call.endpoint.length > 0)
  ).length
  await expectReason(h.call('projectField', {
    projectId: 'PVT_4',
    itemId: 'PVTI_7',
    fieldId: 'PVTF_3',
    value: { userIds: ['user-1'] }
  }), 'validation_error')
  expect(list(object(h.readState()).calls).map(object).filter((call) =>
    (typeof call.query === 'string' && call.query.length > 0) ||
    (typeof call.endpoint === 'string' && call.endpoint.length > 0)
  )).toHaveLength(apiRequestsBeforeInvalidValue)
  const afterRejectedValue = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const preservedValues = list(object(list(afterRejectedValue.items)[0]).fieldValues).map(object)
  expect(object(preservedValues.find((value) => value.fieldId === 'PVTF_3')).value).toEqual([
    { id: 'OPT_1', name: 'Doing' },
    { id: 'OPT_2', name: 'Blocked' }
  ])

  await h.call('projectField', { projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_2', clear: true })
  const afterTextClear = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const remainingValues = list(object(list(afterTextClear.items)[0]).fieldValues).map(object)
  expect(remainingValues.map((value) => value.fieldId)).toEqual(['PVTF_3'])
  await h.call('projectField', { projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_3', clear: true })
  const afterClear = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  expect(list(object(list(afterClear.items)[0]).fieldValues)).toEqual([])
}, 20_000)

test('GH31: project item actions allow reversible edits and require consent to delete a comment', async () => {
  const issueKey = 'test-owner/test-repo/31'
  const comments = [{
    id: 88,
    body: 'comment body',
    issue_url: 'https://api.github.com/repos/test-owner/test-repo/issues/31',
    html_url: 'https://github.com/test-owner/test-repo/issues/31#issuecomment-88',
    created_at: '2026-10-01T00:00:00Z',
    user: { login: 'reporter' }
  }]
  const h = await hosting({
    resources: {
      issues: {
        [issueKey]: {
          number: 31,
          nodeId: 'ISSUE_NODE_31',
          owner: 'test-owner',
          title: 'original issue',
          body: 'original issue body',
          state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/31',
          labels: [],
          assignees: [],
          user: { login: 'reporter' }
        }
      },
      pulls: {
        'test-owner/test-repo/32': {
          number: 32,
          title: 'original review',
          body: 'original review body',
          state: 'open',
          url: 'https://github.com/test-owner/test-repo/pull/32',
          isDraft: false,
          labels: [],
          assignees: [],
          author: { login: 'reviewer' }
        }
      },
      comments: { [issueKey]: comments },
      projectItems: {
        'PVT_4/PVTI_ISSUE': { id: 'PVTI_ISSUE', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization', kind: 'issue', number: 31, title: 'original issue', url: 'https://github.com/test-owner/test-repo/issues/31' },
        'PVT_4/PVTI_PR': { id: 'PVTI_PR', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization', kind: 'pullRequest', number: 32, title: 'original review', url: 'https://github.com/test-owner/test-repo/pull/32' }
      },
      issueTypes: { 'test-owner': [{ id: 'IT_1', name: 'Bug', isEnabled: true }] }
    }
  })
  const issue = { projectId: 'PVT_4', itemId: 'PVTI_ISSUE', number: 31, kind: 'issue' }
  const review = { projectId: 'PVT_4', itemId: 'PVTI_PR', number: 32, kind: 'pullRequest' }

  await h.call('projectItemMutation', { ...issue, action: 'editIssue', title: 'triaged issue', body: 'edited issue body', state: 'closed', stateReason: 'completed', labels: ['triaged'], assignees: ['fixer'] })
  await h.call('projectItemMutation', { ...review, action: 'editReview', title: 'updated review', body: 'edited review body', state: 'open' })
  const updatedIssue = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  const updatedReview = object(await h.call('workItem', { number: 32, kind: 'pullRequest' }))
  expect([updatedIssue.title, updatedIssue.body, updatedIssue.state]).toEqual(['triaged issue', 'edited issue body', 'closed'])
  expect(updatedIssue.labels).toEqual(['triaged'])
  expect(updatedIssue.assignees).toEqual(['fixer'])
  expect([updatedReview.title, updatedReview.body, updatedReview.state]).toEqual(['updated review', 'edited review body', 'open'])

  await h.call('projectItemMutation', { ...issue, action: 'addComment', body: 'new comment' })
  const afterAdd = object(await h.call('workItemDetails', { number: 31, kind: 'issue' }))
  expect(list(afterAdd.comments).map((comment) => object(comment).body)).toContain('new comment')
  await h.call('projectItemMutation', { ...issue, action: 'updateComment', commentId: 88, body: 'updated comment' })
  const afterUpdate = object(await h.call('workItemDetails', { number: 31, kind: 'issue' }))
  expect(list(afterUpdate.comments).map((comment) => object(comment).body)).toContain('updated comment')
  await expectConfirmationRequired(h.call('projectItemMutation', { ...issue, action: 'deleteComment', commentId: 88 }))
  const afterDeniedDelete = object(await h.call('workItemDetails', { number: 31, kind: 'issue' }))
  const deniedComments = list(afterDeniedDelete.comments).map((comment) => object(comment).body)
  expect(deniedComments).toContain('updated comment')
  expect(deniedComments).toContain('new comment')

  await h.call('projectItemMutation', { ...issue, action: 'deleteComment', commentId: 88, yes: true })
  const afterDelete = object(await h.call('workItemDetails', { number: 31, kind: 'issue' }))
  expect(list(afterDelete.comments).map((comment) => object(comment).body)).toEqual(['new comment'])

  const types = object(await h.call('projectItemMutation', { ...issue, action: 'updateIssueType' }))
  expect(list(types.issueTypes).map((type) => object(type).name)).toEqual(['Bug'])
  await h.call('projectItemMutation', { ...issue, action: 'updateIssueType', issueTypeName: 'Bug' })
  const typedDetails = object(await h.call('workItemDetails', { number: 31, kind: 'issue' }))
  expect(object(object(typedDetails.item).issueType).name).toBe('Bug')
}, 20_000)

test('GH33: project issue collections support replacement, increments, and empty clears', async () => {
  const issueKey = 'test-owner/test-repo/31'
  const url = 'https://github.com/test-owner/test-repo/issues/31'
  const h = await hosting({
    resources: {
      issues: {
        [issueKey]: {
          number: 31,
          title: 'original issue',
          body: 'original body',
          state: 'open',
          url,
          labels: [{ name: 'legacy', color: 'cccccc' }],
          assignees: [{ login: 'former', name: 'Former Assignee', avatar_url: 'https://avatars.example/former' }]
        }
      },
      projectItems: {
        'PVT_4/PVTI_ISSUE': {
          id: 'PVTI_ISSUE',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 31,
          title: 'original issue',
          url
        }
      }
    }
  })
  const issue = { projectId: 'PVT_4', itemId: 'PVTI_ISSUE', number: 31, kind: 'issue' }

  await h.call('projectItemMutation', { ...issue, action: 'editIssue', labels: ['triaged'], assignees: ['fixer'] })
  const replaced = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  expect(replaced.labels).toEqual(['triaged'])
  expect(replaced.assignees).toEqual(['fixer'])

  await h.call('projectItemMutation', {
    ...issue,
    action: 'editIssue',
    addLabels: ['bug'],
    removeLabels: ['triaged'],
    addAssignees: ['maintainer'],
    removeAssignees: ['fixer']
  })
  const incremented = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  expect(incremented.labels).toEqual(['bug'])
  expect(incremented.assignees).toEqual(['maintainer'])

  await h.call('projectItemMutation', { ...issue, action: 'editIssue', labels: [], assignees: [] })
  const cleared = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  expect(cleared.labels).toEqual([])
  expect(cleared.assignees).toEqual([])

  const allCalls = list(object(h.readState()).calls).map(object)
  const replacementPatches = allCalls.filter((call) =>
    call.method === 'PATCH' && call.endpoint === 'repos/test-owner/test-repo/issues/31'
  )
  expect(replacementPatches).toHaveLength(2)
  expect(object(replacementPatches[0].input)).toEqual({ labels: ['triaged'], assignees: ['fixer'] })
  expect(object(replacementPatches[1].input)).toEqual({ labels: [], assignees: [] })
  const collectionCalls = allCalls.filter((call) =>
    typeof call.endpoint === 'string' && /\/issues\/31\/(labels|assignees)(\/|$)/.test(call.endpoint)
  )
  expect(collectionCalls.some((call) => call.method === 'POST' && String(call.endpoint).endsWith('/labels'))).toBe(true)
  expect(collectionCalls.some((call) => call.method === 'DELETE' && String(call.endpoint).endsWith('/labels/triaged'))).toBe(true)
  expect(collectionCalls.some((call) => call.method === 'POST' && String(call.endpoint).endsWith('/assignees'))).toBe(true)
  expect(collectionCalls.some((call) => call.method === 'DELETE' && String(call.endpoint).endsWith('/assignees'))).toBe(true)
}, 20_000)

test('GH33: project issue collection validation rejects forbidden and malformed inputs before provider access', async () => {
  const h = await hosting({
    resources: {
      projectItems: {
        'PVT_4/PVTI_ISSUE': {
          id: 'PVTI_ISSUE',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 31,
          url: 'https://github.com/test-owner/test-repo/issues/31'
        }
      }
    }
  })
  const issue = { projectId: 'PVT_4', itemId: 'PVTI_ISSUE', action: 'editIssue' }
  const providerCalls = () => h.invocations().filter(({ args }) => args[0] === 'api')
  const beforeInvalid = providerCalls().length

  await expectReason(h.call('projectItemMutation', { ...issue, labels: ['triaged'], addLabels: ['bug'] }), 'validation_error')
  await expectReason(h.call('projectItemMutation', { ...issue, action: 'editReview', addAssignees: [] }), 'validation_error')
  await expectReason(h.call('projectItemMutation', { ...issue, assignees: ['fixer'], removeAssignees: ['former'] }), 'validation_error')
  await expectReason(h.call('projectItemMutation', { ...issue, labels: [''] }), 'validation_error')
  await expectReason(h.call('projectItemMutation', { ...issue, assignees: [''] }), 'validation_error')
  expect(providerCalls()).toHaveLength(beforeInvalid)
  const beforePreview = providerCalls().length
  expect(await h.call('projectItemMutationConfirmation', { ...issue, labels: [], assignees: [] })).toBeNull()
  expect(providerCalls()).toHaveLength(beforePreview)
}, 20_000)

test('GH33: project issue mutations publish earlier writes when a later provider step fails', async () => {
  const issueKey = 'test-owner/test-repo/31'
  const h = await hosting({
    resources: {
      issues: {
        [issueKey]: {
          number: 31,
          title: 'original issue',
          body: 'original body',
          state: 'open',
          url: 'https://github.com/test-owner/test-repo/issues/31',
          labels: [],
          assignees: [{ login: 'former' }]
        }
      },
      projectItems: {
        'PVT_4/PVTI_ISSUE': {
          id: 'PVTI_ISSUE',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 31,
          title: 'original issue',
          url: 'https://github.com/test-owner/test-repo/issues/31'
        }
      }
    },
    responses: [{
      when: 'repos/test-owner/test-repo/issues/31/assignees',
      method: 'POST',
      error: 'HTTP 500: server error'
    }]
  })
  const issue = { projectId: 'PVT_4', itemId: 'PVTI_ISSUE', number: 31, kind: 'issue' }
  const before = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  expect(before.title).toBe('original issue')

  let failure: unknown
  try {
    await h.call('projectItemMutation', {
      ...issue,
      action: 'editIssue',
      title: 'partially updated',
      addLabels: ['triaged'],
      addAssignees: ['fixer']
    })
  } catch (error: unknown) {
    failure = error
  }
  const errorData = object(object(failure).data)
  const updated = object(await h.call('workItem', { number: 31, kind: 'issue' }))
  expect(errorData.partial).toBe(true)
  expect(errorData.completedSteps).toEqual(['content', 'labels-added'])
  expect(updated.title).toBe('partially updated')
  expect(updated.labels).toEqual(['triaged'])
  expect(updated.assignees).toEqual(['former'])
}, 20_000)


test('GH31: project item mutations target unconfigured repositories on the trusted host', async () => {
  const issueKey = 'remote-owner/remote-repo/41'
  const url = 'https://github.com/remote-owner/remote-repo/issues/41'
  const comments = [{
    id: 91,
    body: 'original comment',
    issue_url: 'https://api.github.com/repos/remote-owner/remote-repo/issues/41',
    html_url: 'https://github.com/remote-owner/remote-repo/issues/41#issuecomment-91',
    created_at: '2026-10-01T00:00:00Z',
    user: { login: 'reporter' }
  }]
  const h = await hosting({
    resources: {
      issues: {
        [issueKey]: {
          number: 41,
          nodeId: 'REMOTE_ISSUE_41',
          owner: 'remote-owner',
          title: 'original issue',
          body: 'original issue body',
          state: 'open',
          url,
          labels: [{ name: 'legacy', color: 'cccccc' }],
          assignees: [{ login: 'former', name: 'Former Assignee', avatar_url: 'https://avatars.example/former' }],
          user: { login: 'reporter' }
        }
      },
      pulls: {
        'remote-owner/remote-repo/42': {
          number: 42,
          title: 'remote pull request',
          body: 'pull request body',
          state: 'open',
          url: 'https://github.com/remote-owner/remote-repo/pull/42',
          isDraft: false,
          labels: [{ name: 'review', color: '0e8a16' }],
          assignees: [{ login: 'reviewer', name: 'Review Person', avatar_url: 'https://avatars.example/reviewer' }]
        }
      },
      comments: { [issueKey]: comments },
      projectItems: {
        'PVT_4/PVTI_REMOTE_ISSUE': {
          id: 'PVTI_REMOTE_ISSUE',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 41,
          title: 'original issue',
          url
        },
        'PVT_4/PVTI_REMOTE_PR': {
          id: 'PVTI_REMOTE_PR',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'pullRequest',
          number: 42,
          title: 'remote pull request',
          url: 'https://github.com/remote-owner/remote-repo/pull/42'
        }
      },
      projectViews: {
        'organization/test-owner/4': {
          projectId: 'PVT_4',
          views: [{ id: 'VIEW_REMOTE', number: 1, name: 'Table', layout: 'TABLE', fields: { nodes: [] } }]
        }
      },
      issueTypes: { 'remote-owner': [{ id: 'IT_REMOTE', name: 'Enhancement', color: 'ORANGE', description: 'Improvement', isEnabled: true }] }
    }
  })
  const issue = { projectId: 'PVT_4', itemId: 'PVTI_REMOTE_ISSUE', number: 41, kind: 'issue' }

  await h.call('projectItemMutation', { ...issue, action: 'editIssue', title: 'triaged remote issue', body: 'updated body', state: 'closed', stateReason: 'completed', labels: ['triaged'], assignees: ['fixer'] })
  await h.call('projectItemMutation', { ...issue, action: 'addComment', body: 'new remote comment' })
  await h.call('projectItemMutation', { ...issue, action: 'updateComment', commentId: 91, body: 'updated remote comment' })
  await h.call('projectItemMutation', { ...issue, action: 'updateIssueType', issueTypeName: 'Enhancement' })

  const resources = object(h.readState()).resources
  const updatedIssue = object(object(resources).issues)
  const storedIssue = object(updatedIssue[issueKey])
  expect([storedIssue.title, storedIssue.body, storedIssue.state]).toEqual(['triaged remote issue', 'updated body', 'closed'])
  expect(object(storedIssue.issueType).name).toBe('Enhancement')

  const table = object(await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }))
  const rows = list(table.items).map(object)
  const issueRow = rows.find((row) => object(row.content).number === 41)
  const pullRow = rows.find((row) => object(row.content).number === 42)
  expect(issueRow).toBeDefined()
  expect(pullRow).toBeDefined()
  const issueContent = object(issueRow?.content)
  const pullContent = object(pullRow?.content)
  expect(issueContent.repository).toBe('remote-owner/remote-repo')
  expect(issueContent.labels).toEqual([{ name: 'triaged', color: 'd73a4a' }])
  expect(issueContent.assignees).toEqual([{ login: 'fixer', name: 'fixer', avatarUrl: 'https://avatars.example/fixer' }])
  expect(issueContent.stateReason).toBe('COMPLETED')
  expect(issueContent.issueType).toEqual({ id: 'IT_REMOTE', name: 'Enhancement', color: 'ORANGE', description: 'Improvement' })
  expect(pullContent.repository).toBe('remote-owner/remote-repo')
  expect(pullContent.labels).toEqual([{ name: 'review', color: '0e8a16' }])
  expect(pullContent.assignees).toEqual([{ login: 'reviewer', name: 'Review Person', avatarUrl: 'https://avatars.example/reviewer' }])
  expect(pullContent.stateReason).toBeNull()
  expect(pullContent.issueType).toBeNull()
  const issueFieldValues = list(issueRow?.fieldValues).map(object)
  const issueLabelValue = issueFieldValues.find((value) => value.fieldId === 'FIELD_LABELS')
  const issueUserValue = issueFieldValues.find((value) => value.fieldId === 'FIELD_ASSIGNEES')
  expect(issueLabelValue).toBeDefined()
  expect(issueUserValue).toBeDefined()
  expect(object(issueLabelValue).value).toEqual([{ name: 'triaged', color: 'd73a4a' }])
  expect(object(issueUserValue).value).toEqual([{ login: 'fixer', name: 'fixer', avatarUrl: 'https://avatars.example/fixer' }])
  const pullFieldValues = list(pullRow?.fieldValues).map(object)
  const pullLabelValue = pullFieldValues.find((value) => value.fieldId === 'FIELD_LABELS')
  const pullUserValue = pullFieldValues.find((value) => value.fieldId === 'FIELD_ASSIGNEES')
  expect(pullLabelValue).toBeDefined()
  expect(pullUserValue).toBeDefined()
  expect(object(pullLabelValue).value).toEqual([{ name: 'review', color: '0e8a16' }])
  expect(object(pullUserValue).value).toEqual([
    { login: 'reviewer', name: 'Review Person', avatarUrl: 'https://avatars.example/reviewer' }
  ])
  const storedComments = object(object(resources).comments)
  expect(list(storedComments[issueKey]).map((comment) => object(comment).body)).toEqual(['updated remote comment', 'new remote comment'])
  const restCalls = list(object(h.readState()).calls).map(object).filter((call) =>
    typeof call.endpoint === 'string' && call.endpoint.startsWith('repos/')
  )
  expect(restCalls.length).toBeGreaterThan(0)
  expect(restCalls.every((call) => String(call.endpoint).includes('remote-owner/remote-repo'))).toBe(true)
}, 20_000)

test('GH31: project item mutation rejects a foreign-host content URL before REST access', async () => {
  const h = await hosting({
    resources: {
      projectItems: {
        'PVT_4/PVTI_FOREIGN_ISSUE': {
          id: 'PVTI_FOREIGN_ISSUE',
          projectId: 'PVT_4',
          projectNumber: 4,
          owner: 'test-owner',
          ownerType: 'Organization',
          kind: 'issue',
          number: 41,
          title: 'foreign issue',
          url: 'https://foreign.example/remote-owner/remote-repo/issues/41'
        }
      }
    }
  })

  await expectReason(h.call('projectItemMutation', {
    projectId: 'PVT_4',
    itemId: 'PVTI_FOREIGN_ISSUE',
    action: 'editIssue',
    title: 'must not be sent'
  }), 'validation_error')
  const restCalls = list(object(h.readState()).calls).map(object).filter((call) =>
    typeof call.endpoint === 'string' && call.endpoint.startsWith('repos/')
  )
  expect(restCalls).toEqual([])
}, 20_000)

test('GH31: project discovery uses an authenticated GHES host without requiring its repository remote', async () => {
  const h = await hosting({
    authStatus: 'Logged in to github.com account hosting-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\nLogged in to enterprise.example account enterprise-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n',
    graphql: [{
      when: 'ProjectDiscovery',
      body: {
        data: {
          viewer: {
            login: 'enterprise-fixture',
            projectsV2: { nodes: [], pageInfo: { hasNextPage: false }, totalCount: 0 },
            organizations: { nodes: [], pageInfo: { hasNextPage: false } }
          }
        }
      }
    }]
  })

  const result = object(await h.call('projects', { host: 'enterprise.example' }))
  expect(result.projects).toEqual([])
  const calls = h.invocations()
  expect(calls.some(({ args }) => {
    const hostnameIndex = args.indexOf('--hostname')
    return args.includes('graphql') && hostnameIndex >= 0 && args[hostnameIndex + 1] === 'enterprise.example'
  })).toBe(true)
  expect(calls.filter(({ args }) => args.includes('auth') && args.includes('status'))
    .every(({ args }) => !args.includes('enterprise.example'))).toBe(true)
}, 20_000)

test('GH31: project discovery rejects an untrusted GHES host before API access', async () => {
  const h = await hosting()

  await expectReason(h.call('projects', { host: 'untrusted.example' }), 'auth_required')
  const calls = h.invocations()
  expect(calls.some(({ args }) => args.includes('graphql'))).toBe(false)
  expect(calls.some(({ args }) => {
    const hostnameIndex = args.indexOf('--hostname')
    return hostnameIndex >= 0 && args[hostnameIndex + 1] === 'untrusted.example'
  })).toBe(false)
}, 20_000)

test('GH31: Projects ignore a configured repository account binding and use ambient project data', async () => {
  const h = await hosting({
    authStatus: 'Logged in to github.com account ambient-fixture (GH_TOKEN)\nActive account: true\nToken scopes: repo, project, read:org\nLogged in to github.com account bound-fixture (keyring)\nActive account: false\nToken scopes: repo, project, read:org\n',
    authTokens: { 'bound-fixture': 'bound-user-token' },
    graphqlByToken: {
      'fixture-ambient-token': [{
        when: 'ProjectDiscovery',
        body: {
          data: {
            viewer: {
              login: 'ambient-fixture',
              projectsV2: {
                nodes: [{ id: 'AMBIENT_PVT', number: 17, title: 'Ambient board' }],
                pageInfo: { hasNextPage: false },
                totalCount: 1
              },
              organizations: { nodes: [], pageInfo: { hasNextPage: false } }
            }
          }
        }
      }],
      'bound-user-token': [{
        when: 'ProjectDiscovery',
        body: {
          data: {
            viewer: {
              login: 'bound-fixture',
              projectsV2: {
                nodes: [{ id: 'BOUND_PVT', number: 18, title: 'Bound board' }],
                pageInfo: { hasNextPage: false },
                totalCount: 1
              },
              organizations: { nodes: [], pageInfo: { hasNextPage: false } }
            }
          }
        }
      }]
    }
  })

  await h.call('configure', { account: { host: 'github.com', user: 'bound-fixture' } })
  const result = object(await h.call('projects', {}))
  expect(list(result.projects).map((project) => object(project).title)).toEqual(['Ambient board'])

  const invocations = h.invocations()
  expect(invocations.some(({ args }) =>
    args[0] === 'auth' && args[1] === 'token' && args.includes('--user') && args[args.indexOf('--user') + 1] === 'bound-fixture'
  )).toBe(true)
  const graphCall = invocations.find(({ args }) => args.includes('graphql'))
  expect(graphCall?.env.GH_TOKEN).toBe('fixture-ambient-token')
  expect(graphCall?.env.GH_TOKEN).not.toBe('bound-user-token')
}, 20_000)

test('GH31: project auth, scope, and schema errors remain distinct', async () => {
  const h = await hosting({
    graphql: [
      { when: 'viewer { login projectsV2', nth: 1, error: 'HTTP 401: authentication required' },
      { when: 'viewer { login projectsV2', nth: 2, error: 'HTTP 403: Resource not accessible by integration; missing project scope' },
      { when: 'verticalGroupByFields', error: 'Field verticalGroupByFields not found' },
      { when: 'field:views', error: 'Field views not found on ProjectV2' }
    ]
  })

  await expectReason(h.call('projects', { host: 'enterprise.example' }), 'auth_required')
  await expectReason(h.call('projects', {}), 'auth_required')
  await expectReason(h.call('projects', {}), 'scope_missing')
  await expectReason(h.call('projectViews', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }), 'schema_drift')
}, 20_000)

test('GH31: project table refuses a collection beyond its 500-item bound with the total count', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                views: {
                  nodes: [{ id: 'v-table', number: 1, name: 'Table', layout: 'TABLE' }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4',
                items: {
                  nodes: [],
                  pageInfo: { hasNextPage: true },
                  totalCount: 501
                }
              }
            }
          }
        }
      }
    ]
  })

  try {
    await h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 })
    throw new Error('Expected a too-large result.')
  } catch (error: unknown) {
    const details = object(error)
    expect(object(details.data).reason).toBe('too_large')
    expect(object(details.data).totalCount).toBe(501)
  }
}, 20_000)
test('GH30: a malformed Projects item connection is not treated as an empty table', async () => {
  const h = await hosting({
    graphql: [
      {
        when: 'field:views',
        body: {
          data: {
            organization: {
              projectV2: {
                views: {
                  nodes: [{ id: 'v-table', number: 1, name: 'Table', layout: 'TABLE' }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        }
      },
      {
        when: 'items(first: 100',
        body: {
          data: {
            organization: {
              projectV2: {
                id: 'PVT_4'
              }
            }
          }
        }
      }
    ]
  })

  await expectReason(h.call('projectTable', { owner: 'test-owner', ownerType: 'organization', projectNumber: 4 }), 'schema_drift')
}, 20_000)

test('GH31: user-owned project issue-type actions report their unsupported boundary', async () => {
  const h = await hosting({ resources: { projectItems: {
    'PVT_USER/PVTI_USER': {
      id: 'PVTI_USER', projectId: 'PVT_USER', owner: 'test-owner', ownerType: 'User',
      kind: 'issue', number: 31, url: 'https://github.com/test-owner/test-repo/issues/31'
    }
  } } })
  await expectReason(h.call('projectItemMutation', {
    projectId: 'PVT_USER', itemId: 'PVTI_USER', action: 'updateIssueType', issueTypeName: 'Bug'
  }), 'unsupported_operation')
}, 20_000)
