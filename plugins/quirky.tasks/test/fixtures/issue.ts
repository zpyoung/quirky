export type IssueFixtureSeed = {
  owner?: string
  repo?: string
  number?: number
  title?: string
  body?: string
  state?: 'open' | 'closed'
  labels?: string[]
  assignees?: string[]
  comments?: Record<string, unknown>[]
  timeline?: Record<string, unknown>[]
  viewerCanUpdate?: boolean
}

export const issueFixtureSource = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof root !== 'string') throw new Error('missing fixture root')
const statePath = join(root, 'state.json')
const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
const state = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}
const resources = state.resources && typeof state.resources === 'object' && !Array.isArray(state.resources) ? state.resources : (state.resources = {})
const issues = resources.issues && typeof resources.issues === 'object' && !Array.isArray(resources.issues) ? resources.issues : (resources.issues = {})
const comments = resources.comments && typeof resources.comments === 'object' && !Array.isArray(resources.comments) ? resources.comments : (resources.comments = {})
const timelines = resources.timeline && typeof resources.timeline === 'object' && !Array.isArray(resources.timeline) ? resources.timeline : (resources.timeline = {})
const args = process.argv.slice(2)
const command = args.join(' ')
const inputText = process.env.QUIRKY_TEST_GH_INPUT ?? ''
let input = null
try { input = inputText.length > 0 ? JSON.parse(inputText) : null } catch { input = null }
const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
const endpoint = args.find((part) => typeof part === 'string' && (part.startsWith('repos/') || part === 'rate_limit')) ?? ''
const methodIndex = args.findIndex((part) => part === '--method' || part === '-X')
const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
const calls = Array.isArray(state.calls) ? state.calls : (state.calls = [])
const call = { args, command, endpoint, method, input }
calls.push(call)
const save = () => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, statePath)
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
  process.stdout.write('Logged in to github.com account issue-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
  process.exit(0)
}
if (endpoint === 'rate_limit') emit({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 }, search: { limit: 30, remaining: 29, reset: 0 }, graphql: { limit: 5000, remaining: 4999, reset: 0 } } })

function routeIssue(path) { return /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(path) }
function routeIssueChild(path) { return /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/(comments|timeline)(?:\?.*)?$/.exec(path) }
function routeIssueCollection(path) { return /^repos\/([^/]+)\/([^/]+)\/issues(?:\?.*)?$/.exec(path) }
function key(owner, repo, number) { return owner + '/' + repo + '/' + number }
function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function names(values, keyName) {
  return Array.isArray(values) ? values.map((value) => typeof value === 'string' ? value : isObject(value) ? value[keyName] : null).filter((value) => typeof value === 'string') : []
}
function routeMatches(entry) {
  const when = typeof entry.when === 'string' ? entry.when : ''
  const prefix = /^(GET|POST|PATCH|PUT|DELETE)\s+/.exec(when)
  const expected = entry.method ?? prefix?.[1]
  const needle = prefix ? when.slice(prefix[0].length) : when
  if (expected !== undefined && expected !== method) return false
  return needle.length > 0 && (needle.includes('/') ? endpoint.includes(needle) : command.includes(needle))
}
const responses = Array.isArray(state.responses) ? state.responses : []
const response = responses.find((entry) => {
  if (!entry || !routeMatches(entry)) return false
  if (entry.nth === undefined) return true
  return calls.filter((candidate) => {
    if (candidate.method !== method) return false
    const needle = typeof entry.when === 'string' ? entry.when.replace(/^(GET|POST|PATCH|PUT|DELETE)\s+/, '') : ''
    return needle.includes('/') ? candidate.endpoint.includes(needle) : candidate.command.includes(needle)
  }).length === entry.nth
})
if (response && typeof response.error === 'string') fail(response.error)

if (args.includes('graphql')) {
  const query = typeof body.query === 'string' ? body.query : ''
  const variables = isObject(body.variables) ? body.variables : {}
  if (query.includes('WorkItemDetails')) {
    const owner = variables.owner
    const repo = variables.repo
    const number = Number(variables.number)
    const issue = issues[key(owner, repo, number)]
    if (isObject(issue)) {
      const issueKey = key(owner, repo, number)
      let issueComments = Array.isArray(comments[issueKey]) ? comments[issueKey] : []
      if (Number(state.laggingCommentReads) > 0) {
        state.laggingCommentReads = Number(state.laggingCommentReads) - 1
        issueComments = issueComments.slice(0, -1)
      }
      const assignees = names(issue.assignees, 'login').map((login) => ({ login }))
      const labels = names(issue.labels, 'name').map((name) => ({ name }))
      const participants = [...new Set([issue.user?.login, ...issueComments.map((comment) => comment.user?.login)].filter((login) => typeof login === 'string'))].map((login) => ({ login }))
      emit({ data: { repository: { issue: {
        ...issue,
        __typename: 'Issue',
        labels: { nodes: labels },
        assignees: { nodes: assignees, pageInfo: { hasNextPage: false } },
        participants: { nodes: participants, pageInfo: { hasNextPage: false } },
        comments: { nodes: issueComments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, url: comment.html_url, author: comment.user, authorAssociation: 'CONTRIBUTOR' })), pageInfo: { hasNextPage: false } }
      } } } })
    }
    emit({ data: { repository: { issue: null } } })
  }
  emit({ data: {} })
}

const collection = routeIssueCollection(endpoint)
if (collection && method === 'POST') {
  const owner = collection[1]
  const repo = collection[2]
  let number = Number(state.nextIssueNumber ?? 101)
  while (Object.hasOwn(issues, key(owner, repo, number))) number += 1
  state.nextIssueNumber = number + 1
  const created = { ...body, number, state: 'open', url: 'https://github.com/' + owner + '/' + repo + '/issues/' + number, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', user: { login: 'issue-fixture' } }
  issues[key(owner, repo, number)] = created
  emit(created)
}
const child = routeIssueChild(endpoint)
if (child) {
  const issueKey = key(child[1], child[2], child[3])
  if (child[4] === 'timeline') emit(timelines[issueKey] ?? [])
  const list = Array.isArray(comments[issueKey]) ? comments[issueKey] : (comments[issueKey] = [])
  if (method === 'GET') emit(list)
  if (method === 'POST') {
    const id = Number(state.nextCommentId ?? 500)
    state.nextCommentId = id + 1
    const created = { id, body: typeof body.body === 'string' ? body.body : '', issue_url: 'https://api.github.com/repos/' + child[1] + '/' + child[2] + '/issues/' + child[3], html_url: 'https://github.com/' + child[1] + '/' + child[2] + '/issues/' + child[3] + '#issuecomment-' + id, created_at: '2026-10-01T00:00:00Z', user: { login: 'issue-fixture' } }
    list.push(created)
    emit(created)
  }
}
const issueMatch = routeIssue(endpoint)
if (issueMatch) {
  const issueKey = key(issueMatch[1], issueMatch[2], issueMatch[3])
  if (!Object.hasOwn(issues, issueKey)) fail('HTTP 404: issue not found')
  if (method === 'GET') emit(issues[issueKey])
  if (method === 'PATCH') {
    const update = isObject(body) ? { ...body } : {}
    if (Array.isArray(update.labels)) update.labels = update.labels.map((name) => ({ name }))
    if (Array.isArray(update.assignees)) update.assignees = update.assignees.map((login) => ({ login }))
    issues[issueKey] = { ...issues[issueKey], ...update, updated_at: '2026-10-02T00:00:00Z' }
    emit(issues[issueKey])
  }
}
if (args.includes('issue')) {
  const issueIndex = args.indexOf('issue')
  const action = args[issueIndex + 1]
  const number = args[issueIndex + 2]
  const repoIndex = args.indexOf('--repo')
  const selected = repoIndex >= 0 ? args[repoIndex + 1] : 'test-owner/test-repo'
  const parts = typeof selected === 'string' ? selected.split('/') : []
  const issueKey = key(parts.at(-2), parts.at(-1), number)
  const issue = issues[issueKey]
  if (isObject(issue) && (action === 'close' || action === 'reopen' || action === 'edit')) {
    if (action === 'close') {
      issue.state = 'closed'
      const reasonIndex = args.indexOf('--reason')
      if (reasonIndex >= 0) issue.state_reason = args.slice(reasonIndex + 1).join(' ')
      const duplicateIndex = args.indexOf('--duplicate-of')
      if (duplicateIndex >= 0) issue.duplicate_of = Number(args[duplicateIndex + 1])
    } else if (action === 'reopen') issue.state = 'open'
    else {
      for (let index = issueIndex + 3; index < args.length; index += 1) {
        const flag = args[index]
        const value = args[index + 1]
        if (flag === '--title') issue.title = value
        if (flag === '--add-label') issue.labels = [...names(issue.labels, 'name'), value].map((name) => ({ name }))
        if (flag === '--remove-label') issue.labels = names(issue.labels, 'name').filter((name) => name !== value).map((name) => ({ name }))
        if (flag === '--add-assignee') issue.assignees = [...names(issue.assignees, 'login'), value].map((login) => ({ login }))
        if (flag === '--remove-assignee') issue.assignees = names(issue.assignees, 'login').filter((login) => login !== value).map((login) => ({ login }))
      }
    }
    emit({})
  }
}
emit({})
`

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function seedIssueFixture(stateValue: unknown, options: IssueFixtureSeed = {}): Record<string, unknown> {
  const owner = options.owner ?? 'test-owner'
  const repo = options.repo ?? 'test-repo'
  const number = options.number ?? 22
  const key = `${owner}/${repo}/${number}`
  const state = fixtureRecord(stateValue)
  const resources = fixtureRecord(state.resources)
  const issue = {
    number,
    title: options.title ?? 'reported',
    body: options.body ?? 'original body',
    state: options.state ?? 'open',
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    labels: (options.labels ?? ['bug']).map((name) => ({ name })),
    assignees: (options.assignees ?? ['alice']).map((login) => ({ login })),
    viewerCanUpdate: options.viewerCanUpdate ?? true,
    user: { login: 'reporter' }
  }
  return {
    ...state,
    resources: {
      ...resources,
      issues: { ...fixtureRecord(resources.issues), [key]: issue },
      comments: { ...fixtureRecord(resources.comments), [key]: options.comments ?? [] },
      timeline: { ...fixtureRecord(resources.timeline), [key]: options.timeline ?? [{ event: 'assigned', actor: { login: 'reporter' }, created_at: '2026-10-01T01:00:00Z' }] }
    }
  }
}

export function issueFixtureRecord(stateValue: unknown, owner: string, repo: string, number: number): Record<string, unknown> {
  const resources = fixtureRecord(fixtureRecord(stateValue).resources)
  return fixtureRecord(fixtureRecord(resources.issues)[`${owner}/${repo}/${number}`])
}
