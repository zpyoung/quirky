export type FixtureCheck = { name: string; status: string; conclusion?: string | null; url?: string | null }
export type FixtureItem = {
  kind: 'issue' | 'pullRequest'
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  updatedAt: string
  author: string
  labels: string[]
  assignees: string[]
  headRefName?: string
  headRefOid?: string
  duplicateOf?: number
  stateReason?: string
  checks?: FixtureCheck[]
  participants?: string[]
  additions?: number
  deletions?: number
  changedFiles?: number
  reviewDecision?: string
  requestedReviewers?: string[] | null
  reviews?: { author: string | null; state: string }[] | null
  reviewAssignees?: string[] | null
  autoMergeRequest?: { enabledAt: string } | null
}

export type ListFixtureState = {
  items: Record<string, FixtureItem[]>
  failCounts?: boolean
  failList?: string
  auth?: boolean
  unknownCount?: boolean
  mergeQueueRequired?: boolean | null
  autoMergeAllowed?: boolean | null
  asyncMergeOutcome?: 'merged' | 'enqueued' | 'pending'
  failIssueUpdate?: boolean
  failPRReviewerEdit?: boolean
  lagSearch?: { repository: string; remaining: number; items: FixtureItem[] }
}

/** A stateful fake `gh` executable that serves the public Hosting API's GitHub requests. */
export const listFixtureSource = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof fixtureDir !== 'string') throw new Error('missing isolated fixture directory')
const statePath = join(fixtureDir, 'state.json')
const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
const state = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}
const args = process.argv.slice(2)
const inputIndex = args.indexOf('--input')
const inputText = process.env.QUIRKY_TEST_GH_INPUT ??
  (inputIndex >= 0 && args[inputIndex + 1] === '-' ? readFileSync(0, 'utf8') : '')
const request = inputText ? JSON.parse(inputText) : null
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const requestObject = isObject(request) ? request : {}
const variables = isObject(requestObject.variables) ? { ...requestObject.variables } : {}
function parseValue(value) {
  try { return JSON.parse(value) } catch { return value }
}
for (let index = 0; index < args.length; index += 1) {
  const part = args[index]
  const fieldValue = ['-f', '-F', '--field', '--raw-field'].includes(part) ? args[index + 1] : part
  if (typeof fieldValue !== 'string') continue
  const separator = fieldValue.indexOf('=')
  if (separator > 0) variables[fieldValue.slice(0, separator)] = parseValue(fieldValue.slice(separator + 1))
}
const graphqlVariables = isObject(variables.variables) ? { ...variables.variables, ...variables } : variables
if (typeof requestObject.query === 'string') graphqlVariables.query = requestObject.query
const calls = Array.isArray(state.calls) ? state.calls : []
calls.push({ args, variables: graphqlVariables, input: request })
state.calls = calls
const save = () => {
  const temporaryPath = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporaryPath, JSON.stringify(state))
  renameSync(temporaryPath, statePath)
}
const emit = (value) => { save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0) }
const fail = (message) => { save(); process.stderr.write(message); process.exit(1) }
function repoArgument() {
  const index = args.findIndex((part) => part === '--repo' || part === '-R')
  return String(args[index + 1] ?? 'test-owner/test-repo').split('/').slice(-2).join('/')
}
save()
if (args[0] === 'auth' && args[1] === 'status') {
  emit(state.auth === false ? 'No authentication configured for github.com\n' : 'Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
}
if (args[0] === 'issue' && ['close', 'reopen', 'edit'].includes(args[1])) {
  const number = Number(args[2])
  const repo = repoArgument()
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const item = items.find((entry) => entry.kind === 'issue' && entry.number === number)
  if (!item) fail('issue not found')
  if (args[1] === 'edit' && state.failIssueUpdate === true) fail('fixture issue update failure')
  if (args[1] === 'close') {
    item.state = 'closed'
    const reasonIndex = args.indexOf('--reason')
    if (reasonIndex >= 0) item.stateReason = args[reasonIndex + 1] === 'not planned' ? 'not_planned' : 'completed'
    const duplicateIndex = args.indexOf('--duplicate-of')
    if (duplicateIndex >= 0) item.duplicateOf = Number(args[duplicateIndex + 1])
  }
  if (args[1] === 'reopen') { item.state = 'open'; delete item.stateReason; delete item.duplicateOf }
  if (args[1] === 'edit') {
    for (let index = 3; index < args.length; index += 1) {
      const option = args[index]
      const value = args[index + 1]
      if (option === '--add-assignee' && value && !item.assignees.includes(value)) item.assignees.push(value)
      if (option === '--remove-assignee' && value) item.assignees = item.assignees.filter((login) => login !== value)
      if (option === '--add-label' && value && !item.labels.includes(value)) item.labels.push(value)
      if (option === '--remove-label' && value) item.labels = item.labels.filter((label) => label !== value)
      if (option?.startsWith('--')) index += 1
    }
  }
  save()
  emit('')
}
if (args[0] === 'pr' && args[1] === 'edit') {
  const number = Number(args[2])
  const repo = repoArgument()
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const item = items.find((entry) => entry.kind === 'pullRequest' && entry.number === number)
  if (!item) fail('pull request not found')
  if (state.failPRReviewerEdit === true) fail('fixture reviewer update failure')
  for (const option of ['--add-reviewer', '--remove-reviewer']) {
    const index = args.indexOf(option)
    if (index < 0) continue
    const logins = String(args[index + 1] ?? '').split(',').filter(Boolean)
    if (option === '--add-reviewer') item.requestedReviewers = [...new Set([...(item.requestedReviewers ?? []), ...logins])]
    else item.requestedReviewers = (item.requestedReviewers ?? []).filter((login) => !logins.includes(login))
  }
  save()
  emit('')
}
if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
  const number = Number(args[2])
  const repo = repoArgument()
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const item = items.find((entry) => entry.kind === 'pullRequest' && entry.number === number)
  if (!item) fail('pull request not found')
  item.autoMergeRequest = null
  save()
  emit('')
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const number = Number(args[2])
  const repo = repoArgument()
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const item = items.find((entry) => entry.kind === 'pullRequest' && entry.number === number)
  if (!item) fail('pull request not found')
  const expectedHeadIndex = args.indexOf('--match-head-commit')
  const expectedHead = expectedHeadIndex >= 0 ? args[expectedHeadIndex + 1] : null
  if (typeof expectedHead !== 'string' || expectedHead !== (item.headRefOid ?? 'a'.repeat(40))) fail('The pull request head changed')
  item.state = 'merged'
  save()
  emit('')
}
if (args[0] === 'pr' && args[1] === 'list') {
  const repo = repoArgument()
  const search = args.includes('--search') ? args[args.indexOf('--search') + 1] : ''
  if (state.failList === repo) fail('fixture list failure')
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const selected = items.filter((item) => item.kind === 'pullRequest' && matches(item, search))
  const limit = Number(args[args.indexOf('--limit') + 1] ?? selected.length)
  emit(selected.slice(0, limit).map(toPullRequest))
}
if (args[0] === 'pr' && args[1] === 'view') {
  const number = Number(args[2])
  const repo = repoArgument()
  const items = Array.isArray(state.items?.[repo]) ? state.items[repo] : []
  const item = items.find((entry) => entry.kind === 'pullRequest' && entry.number === number)
  if (!item) fail('pull request not found')
  emit(toPullRequest(item))
}
if (args[0] === 'api') {
  const endpoint = args.find((part) => typeof part === 'string' && (part.startsWith('repos/') || part.startsWith('search/'))) ?? ''
  const methodIndex = args.findIndex((part) => part === '--method' || part === '-X')
  const method = methodIndex >= 0 ? String(args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
  if (args.includes('graphql')) {
    const query = typeof graphqlVariables.query === 'string' ? graphqlVariables.query : ''
    const search = typeof graphqlVariables.search === 'string' ? graphqlVariables.search : ''
    const first = Number(graphqlVariables.first ?? 100)
    const after = typeof graphqlVariables.after === 'string' ? Number(graphqlVariables.after) : 0
    if (search.length > 0) {
      const repoMatch = /(?:^|\s)repo:([^/\s]+)\/([^\s]+)/i.exec(search)
      const key = repoMatch ? repoMatch[1] + '/' + repoMatch[2] : 'test-owner/test-repo'
      if (state.failCounts === true && first === 1) fail('fixture count failure')
      if (state.failList === key && first !== 1) fail('fixture list failure')
      const stored = Array.isArray(state.items?.[key]) ? state.items[key] : []
      let filtered = stored.filter((item) => matches(item, search))
      const lagSearch = isObject(state.lagSearch) ? state.lagSearch : null
      if (first !== 1 && lagSearch?.repository === key && Number(lagSearch.remaining) > 0 && Array.isArray(lagSearch.items)) {
        lagSearch.remaining = Number(lagSearch.remaining) - 1
        filtered = lagSearch.items.filter((item) => matches(item, search))
      }
      const nodes = filtered.slice(after, after + first).map(toGraphqlNode)
      const next = after + nodes.length < filtered.length
      emit({ data: { search: { issueCount: filtered.length, nodes, pageInfo: { endCursor: next ? String(after + nodes.length) : null, hasNextPage: next } }, rateLimit: { cost: 1 } } })
    }
    if (query.includes('HostingPRMergeMetadata')) {
      const queueRequired = state.mergeQueueRequired === undefined ? false : state.mergeQueueRequired
      const repository = { viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true, rebaseMergeAllowed: true, squashMergeAllowed: true, defaultBranchRef: { name: 'main' }, mergeQueue: queueRequired === null ? 'unknown' : queueRequired ? { id: 'fixture-queue' } : null, ref: { rules: { nodes: [] } } }
      if (typeof state.autoMergeAllowed === 'boolean') repository.autoMergeAllowed = state.autoMergeAllowed
      else if (state.autoMergeAllowed === undefined) repository.autoMergeAllowed = true
      emit({ data: { repository } })
    }
    if (query.includes('EnableHostingPullRequestAutoMerge')) {
      const id = String(graphqlVariables.pullRequestId ?? '')
      const item = Object.values(state.items ?? {}).flat().find((entry) => entry.kind === 'pullRequest' && pullRequestId(entry) === id)
      if (!item) fail('pull request was not found for auto-merge')
      item.autoMergeRequest = { enabledAt: '2026-10-01T00:00:00Z' }
      emit({ data: { enablePullRequestAutoMerge: { pullRequest: { id, autoMergeRequest: item.autoMergeRequest } } } })
    }
    if (query.includes('HostingChecksRollup')) {
      const owner = String(graphqlVariables.owner ?? 'test-owner')
      const repo = String(graphqlVariables.name ?? 'test-repo')
      const number = Number(graphqlVariables.number)
      const item = (state.items?.[owner + '/' + repo] ?? []).find((entry) => entry.kind === 'pullRequest' && entry.number === number)
      const contexts = (item?.checks ?? []).map((check, index) => ({ __typename: 'CheckRun', databaseId: index + 1, name: check.name, status: check.status, conclusion: check.conclusion ?? null, detailsUrl: check.url ?? null }))
      emit({ data: { repository: { pullRequest: { headRefOid: item?.headRefOid ?? 'a'.repeat(40), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts, pageInfo: { hasNextPage: false } } }, checkSuites: { nodes: [], pageInfo: { hasNextPage: false } } } }] } } } } })
    }
    if (query.includes('HostingComments')) {
      const owner = String(graphqlVariables.owner ?? 'test-owner')
      const repo = String(graphqlVariables.name ?? 'test-repo')
      const number = Number(graphqlVariables.number)
      const item = (state.items?.[owner + '/' + repo] ?? []).find((entry) => entry.kind === 'pullRequest' && entry.number === number)
      const empty = { nodes: [], pageInfo: { hasNextPage: false } }
      emit({ data: { repository: { pullRequest: item ? { id: pullRequestId(item), comments: empty, reviews: empty, reviewThreads: empty } : null } } })
    }
    if (query.includes('HostingFileViews')) {
      const owner = String(graphqlVariables.owner ?? 'test-owner')
      const repo = String(graphqlVariables.name ?? 'test-repo')
      const number = Number(graphqlVariables.number)
      const item = (state.items?.[owner + '/' + repo] ?? []).find((entry) => entry.kind === 'pullRequest' && entry.number === number)
      const files = { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      emit({ data: { repository: { pullRequest: item ? { id: pullRequestId(item), files } : null } } })
    }
    if (query.includes('WorkItemDetails')) {
      const owner = String(graphqlVariables.owner ?? 'test-owner')
      const repo = String(graphqlVariables.repo ?? 'test-repo')
      const number = Number(graphqlVariables.number)
      const item = (state.items?.[owner + '/' + repo] ?? []).find((entry) => entry.number === number)
      const node = item ? toGraphqlNode(item) : null
      const participants = { nodes: (item?.participants ?? []).map((login) => ({ login })), pageInfo: { hasNextPage: false } }
      const emptyComments = { nodes: [], pageInfo: { hasNextPage: false } }
      emit({ data: { repository: {
        issue: item?.kind === 'issue' ? { ...node, participants, comments: emptyComments } : null,
        pullRequest: item?.kind === 'pullRequest' ? { ...node, participants, reviews: emptyComments } : null
      } } })
    }
  }
  const labelRoute = /^repos\/([^/]+)\/([^/]+)\/(labels|assignees)(?:\?.*)?/.exec(endpoint)
  if (labelRoute) {
    const [, , , kind] = labelRoute
    emit(kind === 'labels' ? [{ name: 'bug' }, { name: 'needs triage' }] : [{ login: 'fixture-user', avatar_url: null }])
  }
  const asyncMergeRoute = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge-async(?:\/([^/]+))?$/.exec(endpoint)
  if (asyncMergeRoute) {
    const status = state.asyncMergeOutcome ?? 'enqueued'
    emit({ status })
  }
  const pullCommentsRoute = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments(?:\?.*)?$/.exec(endpoint)
  if (pullCommentsRoute) emit([])
  const pullReviewsRoute = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews(?:\?.*)?$/.exec(endpoint)
  if (pullReviewsRoute) emit([])
  const pullFilesRoute = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files(?:\?.*)?$/.exec(endpoint)
  if (pullFilesRoute) emit([])
  const pullRoute = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\?.*)?/.exec(endpoint)
  if (pullRoute) {
    const [, owner, repo, number] = pullRoute
    const item = (state.items?.[owner + '/' + repo] ?? []).find((entry) => entry.kind === 'pullRequest' && entry.number === Number(number))
    if (!item) fail('pull request not found')
    emit(toRestPull(item))
  }
  const issueRoute = /^repos\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?/.exec(endpoint)
  if (issueRoute) {
    const [, owner, name, number] = issueRoute
    const key = owner + '/' + name
    const issues = (state.items?.[key] ?? []).filter((item) => item.kind === 'issue')
    const found = issues.find((item) => item.number === Number(number))
    if (method === 'GET') emit(number ? toRestIssue(found) : issues.map(toRestIssue))
    if (method === 'PATCH') {
      if (state.failIssueUpdate === true) fail('fixture issue update failure')
      if (!found) fail('issue not found')
      const body = isObject(request) ? request : {}
      Object.assign(found, body)
      save()
      emit(toRestIssue(found))
    }
  }
  if (endpoint.startsWith('search/issues')) {
    const parameters = new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1))
    const query = parameters.get('q') ?? ''
    const repoMatch = /(?:^|\s)repo:([^/\s]+)\/([^\s]+)/i.exec(query)
    const key = repoMatch ? repoMatch[1] + '/' + repoMatch[2] : 'test-owner/test-repo'
    if (state.failList === key) fail('fixture list failure')
    const stored = Array.isArray(state.items?.[key]) ? state.items[key] : []
    let filtered = stored.filter((item) => matches(item, query))
    const page = Number(parameters.get('page') ?? 1)
    const perPage = Number(parameters.get('per_page') ?? 30)
    const lagSearch = isObject(state.lagSearch) ? state.lagSearch : null
    if (perPage !== 1 && lagSearch?.repository === key && Number(lagSearch.remaining) > 0 && Array.isArray(lagSearch.items)) {
      lagSearch.remaining = Number(lagSearch.remaining) - 1
      filtered = lagSearch.items.filter((item) => matches(item, query))
    }
    const items = filtered.slice((page - 1) * perPage, page * perPage).map((item) => item.kind === 'issue' ? toRestIssue(item) : toRestPull(item))
    emit({ ...(state.unknownCount === true ? {} : { total_count: filtered.length }), items })
  }
}
function matches(item, query) {
  const text = String(query ?? '')
  if (/(?:^|\s)is:issue(?:\s|$)/.test(text) && item.kind !== 'issue') return false
  if (/(?:^|\s)is:pr(?:\s|$)/.test(text) && item.kind !== 'pullRequest') return false
  if (/(?:^|\s)is:open(?:\s|$)/.test(text) && item.state !== 'open' && item.state !== 'draft') return false
  if (/(?:^|\s)is:closed(?:\s|$)/.test(text) && item.state !== 'closed') return false
  if (/(?:^|\s)is:merged(?:\s|$)/.test(text) && item.state !== 'merged') return false
  const label = /(?:^|\s)label:(?:"([^"]+)"|([^\s]+))/i.exec(text)
  if (label && !(item.labels ?? []).includes(label[1] ?? label[2])) return false
  const assignee = /(?:^|\s)assignee:([^\s]+)/i.exec(text)
  if (assignee && assignee[1] === '@me' && !(item.assignees ?? []).includes('fixture-user')) return false
  const author = /(?:^|\s)author:([^\s]+)/i.exec(text)
  if (author && author[1] === '@me' && item.author !== 'fixture-user') return false
  return true
}
function pullRequestId(item) {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(String(item.url ?? ''))
  return match ? 'PR_' + match[1] + '_' + match[2] + '_' + match[3] : 'PR_fixture_' + item.number
}
function toGraphqlNode(item) {
  return {
    __typename: item.kind === 'issue' ? 'Issue' : 'PullRequest',
    ...(item.kind === 'pullRequest' ? { id: pullRequestId(item) } : {}),
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    ...(item.kind === 'issue' ? { issueState: String(item.state).toUpperCase(), stateReason: item.stateReason, duplicateOf: item.duplicateOf } : { pullRequestState: String(item.state).toUpperCase(), isDraft: item.state === 'draft', headRefName: item.headRefName ?? 'feature', baseRefName: 'main', headRefOid: item.headRefOid ?? 'a'.repeat(40), baseRefOid: 'b'.repeat(40), reviewDecision: 'NONE', mergeStateStatus: 'CLEAN' }),
    url: item.url,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: item.updatedAt,
    author: { login: item.author },
    labels: { nodes: (item.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (item.assignees ?? []).map((login) => ({ login })) },
    ...(item.kind === 'pullRequest' && typeof item.additions === 'number' ? { additions: item.additions } : {}),
    ...(item.kind === 'pullRequest' && typeof item.deletions === 'number' ? { deletions: item.deletions } : {}),
    ...(item.kind === 'pullRequest' && typeof item.changedFiles === 'number' ? { changedFiles: item.changedFiles } : {}),
    ...(item.kind === 'pullRequest' && typeof item.reviewDecision === 'string' ? { reviewDecision: item.reviewDecision } : {}),
    ...(item.kind === 'pullRequest' && Array.isArray(item.requestedReviewers) ? { requestedReviewers: item.requestedReviewers.map((login) => ({ login })) } : {})
  }
}
function toPullRequest(item) {
  return {
    ...toGraphqlNode(item),
    state: String(item.state).toUpperCase(),
    isDraft: item.state === 'draft',
    html_url: item.url,
    mergeable: true,
    autoMergeRequest: item.autoMergeRequest ?? null,
    reviewRequests: item.requestedReviewers === null ? null : (item.requestedReviewers ?? []).map((login) => ({ login })),
    reviews: item.reviews === null ? null : (item.reviews ?? []).map((review) => ({ author: review.author ? { login: review.author } : null, state: review.state })),
    assignees: item.reviewAssignees === null ? null : (item.reviewAssignees ?? item.assignees ?? []).map((login) => ({ login })),
  }
}
function toRestPull(item) {
  const node = toPullRequest(item)
  return { ...node, state: item.state === 'merged' ? 'closed' : item.state, merged: item.state === 'merged', draft: item.state === 'draft', head: { ref: item.headRefName ?? 'feature', sha: item.headRefOid ?? 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) }, html_url: item.url, mergeable: true, mergeable_state: 'clean' }
}
function toRestIssue(item) {
  if (!item) return null
  return { number: item.number, title: item.title, body: item.body ?? '', state: item.state === 'open' ? 'OPEN' : 'CLOSED', state_reason: item.stateReason, duplicate_of: item.duplicateOf, html_url: item.url, created_at: '2026-10-01T00:00:00Z', updated_at: item.updatedAt, user: { login: item.author }, labels: (item.labels ?? []).map((name) => ({ name })), assignees: (item.assignees ?? []).map((login) => ({ login })) }
}
fail('unsupported fixture command: ' + args.join(' '))
`

export function fixtureIssue(owner: string, repo: string, number: number, updatedAt: string): FixtureItem {
  return {
    kind: 'issue',
    number,
    title: `Issue ${number}`,
    body: 'fixture body',
    state: 'open',
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    updatedAt,
    author: 'fixture-user',
    labels: ['bug'],
    assignees: ['fixture-user']
  }
}

export function fixturePullRequest(owner: string, repo: string, number: number, updatedAt: string, checks: FixtureCheck[] = []): FixtureItem {
  return {
    kind: 'pullRequest',
    number,
    title: `Pull request ${number}`,
    body: 'fixture pull-request body',
    state: 'open',
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    updatedAt,
    author: 'fixture-user',
    labels: [],
    assignees: [],
    headRefName: `feature-${number}`,
    headRefOid: 'a'.repeat(40),
    checks,
    participants: ['reviewer-one', 'reviewer-two']
  }
}

export function seedListFixture(items: Record<string, FixtureItem[]>, options: Omit<ListFixtureState, 'items'> = {}): ListFixtureState {
  return { items, ...options }
}
