import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../src/pr-data'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const number = overrides.number ?? 7
  return {
    number,
    id: `PR_test_${number}`,
    title: 'Review title',
    body: 'Review body',
    state: 'OPEN',
    url: `https://github.com/test-owner/test-repo/pull/${number}`,
    isDraft: false,
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRefName: 'feature',
    headRefOid: 'a'.repeat(40),
    headRepositoryOwner: { login: 'test-owner' },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    baseRepositoryOwner: { login: 'test-owner' },
    baseRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: 'SUCCESS', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    autoMergeRequest: null,
    stack: null,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    ...overrides
  }
}

function fixtureState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prs: [],
    authenticated: true,
    defaultBranch: 'main',
    mergeQueueRequired: false,
    mergeMetadataAvailable: true,
    mergeAsyncStart: 'merged',
    mergeAsyncPoll: 'merged',
    stackRegistrationFails: false,
    createResponse: 'url',
    createWrites: true,
    ...overrides
  }
}

// This is an upstream-only executable. The daemon, plugin dispatch, worktree lookup and CLI remain real.
const ghFixture = String.raw`
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { join } from 'node:path'
const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const saveState = (state) => {
  const temporaryStatePath = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporaryStatePath, JSON.stringify(state))
  renameSync(temporaryStatePath, statePath)
}
const args = process.argv.slice(2)
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message); process.exit(1) }
const inputFields = input.length === 0 ? {} : JSON.parse(input)
if (inputFields === null || typeof inputFields !== 'object' || Array.isArray(inputFields)) fail('GitHub request body must be a JSON object')
const graphqlVariables = inputFields.variables && typeof inputFields.variables === 'object' && !Array.isArray(inputFields.variables) ? inputFields.variables : {}
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const state = readState()
const prs = Array.isArray(state.prs) ? state.prs : []
const numberFrom = (value) => Number(value)
const byNumber = (value) => prs.find((item) => item.number === numberFrom(value))
const ownerRepo = (value) => {
  const parts = String(value ?? '').split('/')
  return { owner: parts.length > 1 ? parts.at(-2) : '', repo: parts.at(-1) ?? '' }
}
const repoArg = option('--repo', option('-R', 'test-owner/test-repo'))
const repo = ownerRepo(repoArg)
const apiRepository = (endpoint) => {
  const match = /^repos\/([^/?]+)\/([^/?]+)/.exec(endpoint)
  if (!match) fail('Invalid GitHub API endpoint')
  return { owner: match[1], repo: match[2] }
}
const belongsTo = (item, identity) => {
  const owner = item.baseRepositoryOwner?.login ?? item.repositoryOwner?.login ?? item.base?.repo?.owner?.login
  const name = item.baseRepository?.name ?? item.repository?.name ?? item.base?.repo?.name
  return (owner === undefined || owner === identity.owner) && (name === undefined || name === identity.repo)
}
const projectPr = (item) => {
  const fields = option('--json')
  if (typeof fields !== 'string') return item
  const projected = {}
  for (const field of fields.split(',')) {
    if (Object.hasOwn(item, field)) projected[field] = item[field]
  }
  return projected
}
const savePr = (item) => {
  const index = prs.findIndex((entry) => entry.number === item.number)
  if (index < 0) prs.push(item)
  else prs[index] = item
  state.prs = prs
  saveState(state)
}
const restPull = (item) => {
  const baseOwner = item.baseRepositoryOwner?.login ?? item.baseRepository?.owner?.login ?? repo.owner
  const baseRepo = item.baseRepository?.name ?? repo.repo
  const headOwner = item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login ?? repo.owner
  const headRepo = item.headRepository === null ? null : item.headRepository?.name ?? repo.repo
  const merged = item.state === 'MERGED'
  const response = {
    number: item.number,
    id: item.number,
    url: 'https://api.github.com/repos/' + baseOwner + '/' + baseRepo + '/pulls/' + item.number,
    html_url: 'https://github.com/' + baseOwner + '/' + baseRepo + '/pull/' + item.number,
    title: item.title,
    body: item.body,
    state: merged || item.state === 'CLOSED' ? 'closed' : 'open',
    draft: item.isDraft === true,
    merged_at: merged ? new Date(0).toISOString() : null,
    mergeable: item.mergeable === 'MERGEABLE' ? true : item.mergeable === 'CONFLICTING' ? false : null,
    mergeable_state: typeof item.mergeStateStatus === 'string' ? item.mergeStateStatus.toLowerCase() : null,
    base: { ref: item.baseRefName, sha: item.baseRefOid, repo: { name: baseRepo, owner: { login: baseOwner }, html_url: 'https://github.com/' + baseOwner + '/' + baseRepo } },
    head: { ref: item.headRefName, sha: item.headRefOid, repo: headRepo === null ? null : { name: headRepo, owner: { login: headOwner }, html_url: 'https://github.com/' + headOwner + '/' + headRepo }, user: { login: headOwner } },
    maintainer_can_modify: item.maintainerCanModify === true
  }
  const restStacks = state.restStacks && typeof state.restStacks === 'object' ? state.restStacks : {}
  if (Object.hasOwn(restStacks, String(item.number))) {
    response.stack = restStacks[String(item.number)]
  } else {
    const registeredStacks = Object.values(state.stacks ?? {}).flat()
    const registered = registeredStacks.find((value) =>
      value && typeof value === 'object' && Array.isArray(value.pullRequests) && value.pullRequests.includes(item.number))
    if (registered) {
      const members = registered.pullRequests
      const root = byNumber(members[0])
      response.stack = {
        number: registered.number,
        position: members.indexOf(item.number) + 1,
        size: members.length,
        base: { ref: root?.baseRefName ?? item.baseRefName ?? 'main', sha: root?.baseRefOid ?? item.baseRefOid }
      }
    }
  }
  return response
}
const command = args[0]
if (command === 'auth' && args[1] === 'status') {
  if (state.authenticated === false) fail('You are not logged into any GitHub hosts. Run gh auth login.')
  if (state.logoutAfterAuthStatus === true) {
    state.authenticated = false
    state.logoutAfterAuthStatus = false
    saveState(state)
  }
  out('Logged in to github.com account test-user (keyring)\n')
} else if (command === 'auth' && args[1] === 'token') {
  out('isolated-test-token\n')
} else if (command === 'api') {
  if (args.includes('rate_limit')) {
    out({ resources: { core: { limit: 5000, remaining: 4000, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
  } else if (args.includes('user')) {
    out({ login: 'test-user' })
  } else if (args.includes('graphql')) {
    const query = typeof inputFields.query === 'string' ? inputFields.query : ''
    if (query.includes('enablePullRequestAutoMerge')) {
      const target = prs.find((item) => item.id === graphqlVariables.pullRequestId)
      if (!target) {
        out({ data: { enablePullRequestAutoMerge: { pullRequest: null } } })
      } else if (target.headRefOid !== graphqlVariables.expectedHeadOid) {
        out({ errors: [{ message: 'The pull request head SHA does not match.' }] })
      } else {
        target.autoMergeRequest = { enabledAt: new Date(0).toISOString(), mergeMethod: graphqlVariables.mergeMethod }
        savePr(target)
        out({ data: { enablePullRequestAutoMerge: { pullRequest: { id: target.id, autoMergeRequest: { enabledAt: target.autoMergeRequest.enabledAt } } } } })
      }
    } else if (query.includes('disablePullRequestAutoMerge')) {
      const target = prs.find((item) => item.id === graphqlVariables.pullRequestId)
      if (target) { target.autoMergeRequest = null; savePr(target) }
      out({ data: { disablePullRequestAutoMerge: { pullRequest: target ? { id: target.id } : null } } })
    } else if (query.includes('viewerDefaultMergeMethod')) {
      const owner = graphqlVariables.owner
      const name = graphqlVariables.name
      if (typeof owner !== 'string' || typeof name !== 'string' || typeof graphqlVariables.branch !== 'string') {
        fail('GitHub GraphQL metadata query omitted repository or branch variables')
      }
      if (state.mergeMetadataAvailable === false) {
        out({ data: { repository: null } })
      } else {
        const rules = Array.isArray(state.rules) ? state.rules.map((rule) => {
          if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return rule
          const projected = { type: rule.type }
          if (query.includes('parameters') && Object.hasOwn(rule, 'parameters')) projected.parameters = rule.parameters
          return projected
        }) : []
        out({ data: { repository: {
          id: 'REPO_' + owner + '_' + name,
          viewerDefaultMergeMethod: 'SQUASH',
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
          autoMergeAllowed: state.autoMergeAllowed !== false,
          defaultBranchRef: { name: state.defaultBranch ?? 'main' },
          mergeQueue: state.mergeQueueRequired ? { id: 'QUEUE_test' } : null,
          ref: { rules: { nodes: rules } }
        } } })
      }
    } else {
      fail('Unsupported GitHub GraphQL fixture query')
    }
  } else {
    const endpoint = args.find((value) => value.startsWith('repos/'))
    if (!endpoint) fail('Invalid GitHub API endpoint')
    const method = option('--method', option('-X', 'GET')).toUpperCase()
    const apiOwnerRepo = apiRepository(endpoint)
    const apiNumber = endpoint.match(/\/pulls\/(\d+)/)?.[1]
    if (endpoint.includes('/commits/') && endpoint.includes('/pulls?')) {
      out([])
    } else if (endpoint.includes('/pulls?')) {
      if (state.listFailure) fail(state.listFailure === true ? 'HTTP 503: temporarily unavailable' : String(state.listFailure))
      const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
      const head = query.get('head') ?? ''
      const separator = head.indexOf(':')
      const headOwner = separator < 0 ? '' : head.slice(0, separator)
      const branch = separator < 0 ? head : head.slice(separator + 1)
      const base = query.get('base') ?? ''
      const stateFilter = query.get('state') ?? 'open'
      const matches = prs.filter((item) => {
        const actualHeadOwner = item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login ?? ''
        const itemState = item.state === 'MERGED' || item.state === 'CLOSED' ? 'closed' : 'open'
        return item.headRefName === branch && (!headOwner || actualHeadOwner.toLowerCase() === headOwner.toLowerCase()) &&
          (!base || item.baseRefName === base) && belongsTo(item, apiOwnerRepo) &&
          (stateFilter === 'all' || stateFilter === itemState)
      })
      out(matches.map(restPull))
    } else if (/\/pulls\/\d+\/merge-async(?:\/|$)/.test(endpoint)) {
      const mergeNumber = Number(endpoint.match(/\/pulls\/(\d+)\/merge-async/)?.[1])
      const item = byNumber(mergeNumber)
      if (!item || !belongsTo(item, apiOwnerRepo)) fail('HTTP 404: Not Found')
      if (method === 'PUT') {
        if (state.mergeAsyncFailure) fail('HTTP 404: merge-async not supported')
        if (inputFields.sha !== item.headRefOid) fail('HTTP 422: head sha does not match')
        const mergeAction = inputFields.merge_action
        if (mergeAction !== 'direct_merge' && mergeAction !== 'merge_queue') fail('Invalid merge action')
        if (mergeAction === 'direct_merge' && !['squash', 'merge', 'rebase'].includes(inputFields.merge_method)) fail('Invalid merge method')
        if (mergeAction === 'merge_queue' && Object.hasOwn(inputFields, 'merge_method')) fail('merge_method is only valid for direct_merge')
        const outcome = state.mergeAsyncStart ?? 'merged'
        const operationId = outcome === 'enqueued' ? 'op-queue' : 'op-stack'
        const operations = state.mergeOperations && typeof state.mergeOperations === 'object' ? state.mergeOperations : {}
        operations[operationId] = { number: mergeNumber, mergeAction, sha: inputFields.sha }
        state.mergeOperations = operations
        if (outcome === 'merged') item.state = 'MERGED'
        if (outcome === 'enqueued') {
          if (mergeAction !== 'merge_queue') fail('Only merge queue operations can be enqueued')
          state.mergeQueueEntries = [...(state.mergeQueueEntries ?? []), mergeNumber]
        }
        savePr(item)
        out({ status: outcome, details: { uuid: operationId } })
      } else {
        const operationId = endpoint.split('/').at(-1)
        const operation = state.mergeOperations?.[operationId]
        if (!operation || operation.number !== mergeNumber) fail('HTTP 404: Not Found')
        const outcome = state.mergeAsyncPoll ?? 'merged'
        if (outcome === 'merged') {
          item.state = 'MERGED'
          savePr(item)
        }
        if (outcome === 'enqueued') {
          if (operation.mergeAction !== 'merge_queue') fail('Only merge queue operations can be enqueued')
          state.mergeQueueEntries = [...(state.mergeQueueEntries ?? []), mergeNumber]
          saveState(state)
        }
        out({ status: outcome, details: { uuid: operationId } })
      }
    } else if (/\/pulls\/\d+$/.test(endpoint)) {
      const item = byNumber(apiNumber)
      if (!item || !belongsTo(item, apiOwnerRepo)) fail('HTTP 404: Not Found')
      if (method === 'GET' && state.restPullFailure === true) fail('HTTP 503: pull request metadata unavailable')
      if (method === 'PATCH') {
        for (const [key, value] of Object.entries(inputFields)) item[key] = value
        if (option('--title') !== undefined) item.title = option('--title')
        savePr(item)
      }
      out(restPull(item))
    } else if (/\/pulls$/.test(endpoint) && method === 'POST') {
      let created
      if (state.createWrites !== false) {
        const requestedHeadRepo = typeof inputFields.head_repo === 'string' ? inputFields.head_repo : apiOwnerRepo.repo
        const headRepoParts = requestedHeadRepo.split('/')
        const headRepo = headRepoParts.at(-1)
        const headRepositoryOwner = headRepoParts.length > 1 ? headRepoParts.at(-2) : undefined
        const requestedHead = typeof inputFields.head === 'string' ? inputFields.head : ''
        const separator = requestedHead.indexOf(':')
        const headOwner = separator < 0 ? apiOwnerRepo.owner : requestedHead.slice(0, separator)
        const headName = separator < 0 ? requestedHead : requestedHead.slice(separator + 1)
        const expectedHeadRepositoryOwner = headRepositoryOwner ?? (typeof inputFields.head_repo === 'string' ? headOwner : apiOwnerRepo.owner)
        if (!headName || !headRepo || headOwner.toLowerCase() !== expectedHeadRepositoryOwner.toLowerCase()) fail('REST head and head_repo ownership do not match')
        const nextNumber = Math.max(0, ...prs.map((item) => item.number)) + 1
        created = {
          number: nextNumber,
          id: 'PR_test_' + nextNumber,
          title: typeof inputFields.title === 'string' ? inputFields.title : 'Untitled',
          body: typeof inputFields.body === 'string' ? inputFields.body : '',
          state: 'OPEN',
          isDraft: inputFields.draft === true,
          url: 'https://github.com/' + apiOwnerRepo.owner + '/' + apiOwnerRepo.repo + '/pull/' + nextNumber,
          baseRefName: String(inputFields.base ?? 'main'),
          baseRefOid: 'b'.repeat(40),
          headRefName: headName,
          headRefOid: 'c'.repeat(40),
          headRepositoryOwner: { login: headOwner },
          headRepository: { name: headRepo, owner: { login: headOwner } },
          baseRepositoryOwner: { login: apiOwnerRepo.owner },
          baseRepository: { name: apiOwnerRepo.repo, owner: { login: apiOwnerRepo.owner } },
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [],
          autoMergeRequest: null
        }
        prs.push(created)
        state.prs = prs
        saveState(state)
      }
      if (state.createFailure) fail(String(state.createFailure))
      if (state.createResponse === 'malformed') out('creation response could not be parsed')
      else if (state.createResponse === 'empty') out('')
      else if (created) out(restPull(created))
      else out({})
    } else if (endpoint.includes('/stacks?')) {
      const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
      const pullRequest = query.get('pull_request') ?? ''
      const stacks = state.stacks && typeof state.stacks === 'object' ? state.stacks : {}
      out(stacks[pullRequest] ?? [])
    } else if (endpoint.endsWith('/stacks') && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      const pullRequests = Array.isArray(inputFields.pull_requests) ? inputFields.pull_requests : []
      const stackNumber = Number(pullRequests[0] ?? 0)
      if (!Number.isSafeInteger(stackNumber) || stackNumber <= 0) fail('Invalid stack number')
      const stack = { number: stackNumber, pullRequests }
      state.stacks = state.stacks ?? {}
      state.stacks[String(stackNumber)] = [stack]
      saveState(state)
      out({ number: stackNumber })
    } else if (/\/stacks\/\d+\/add$/.test(endpoint) && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      const stackNumber = Number(endpoint.match(/\/stacks\/(\d+)\/add$/)?.[1])
      const pullRequests = Array.isArray(inputFields.pull_requests) ? inputFields.pull_requests : []
      const stackCollections = Object.values(state.stacks ?? {}).flat()
      const existing = stackCollections.find((item) => item.number === stackNumber)
      const stack = existing ?? { number: stackNumber, pullRequests: [] }
      stack.pullRequests = [...(stack.pullRequests ?? []), ...pullRequests]
      state.stacks = state.stacks ?? {}
      if (!existing) state.stacks[String(stackNumber)] = [stack]
      state.stackAdds = [...(state.stackAdds ?? []), { stackNumber, pullRequests }]
      saveState(state)
      out({ number: stackNumber })
    } else {
      out({})
    }
  }
} else if (command === 'repo' && args[1] === 'view') {
  out({ nameWithOwner: repo.owner + '/' + repo.repo, isFork: false, parent: null, defaultBranchRef: { name: state.defaultBranch ?? 'main' } })
} else if (command === 'pr' && args[1] === 'list') {
  const head = option('--head', '')
  if (head.includes(':')) fail('gh pr list --head does not support owner:branch')
  if (state.listFailure) fail(state.listFailure === true ? 'HTTP 503: temporarily unavailable' : String(state.listFailure))
  const base = option('--base', '')
  const stateFilter = option('--state', 'open')
  out(prs.filter((item) => item.headRefName === head && (!base || item.baseRefName === base) && belongsTo(item, repo) &&
    (stateFilter === 'all' || item.state === 'OPEN' || item.state === 'DRAFT')).map(projectPr))
} else if (command === 'pr' && args[1] === 'view') {
  if (state.invalidPrView === true) {
    out({})
  } else {
    const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
    const item = number ? byNumber(number) : undefined
    if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
    if (state.pauseNextView === true) {
      const snapshot = JSON.stringify(projectPr(item))
      const watcher = watch(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', { persistent: false })
      state.pauseNextView = false
      state.lookupStarted = true
      saveState(state)
      for await (const _ of watcher) {
        if (readState().releaseLookup === true) break
      }
      out(snapshot)
    } else {
      out(projectPr(item))
    }
  }
} else if (command === 'pr' && args[1] === 'create') {
  if (state.createWrites !== false) {
    const title = option('--title', 'Untitled')
    const base = option('--base', 'main')
    const requestedHead = option('--head', 'feature')
    const headParts = requestedHead.split(':')
    const headOwner = headParts.length > 1 ? headParts[0] : repo.owner
    const head = headParts.at(-1)
    if (headParts.length > 1 && Array.isArray(state.organizationOwners) && state.organizationOwners.includes(headOwner)) {
      fail('gh pr create --head does not support organization:branch')
    }
    const bodyPath = option('--body-file')
    const body = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : ''
    const nextNumber = Math.max(0, ...prs.map((item) => item.number)) + 1
    const created = {
      number: nextNumber, id: 'PR_test_' + nextNumber, title, body, state: 'OPEN', isDraft: args.includes('--draft'),
      url: 'https://github.com/' + repo.owner + '/' + repo.repo + '/pull/' + nextNumber,
      baseRefName: base, baseRefOid: 'b'.repeat(40), headRefName: head, headRefOid: 'c'.repeat(40),
      headRepositoryOwner: { login: headOwner }, headRepository: { name: repo.repo, owner: { login: headOwner } },
      baseRepositoryOwner: { login: repo.owner }, baseRepository: { name: repo.repo, owner: { login: repo.owner } },
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [], autoMergeRequest: null
    }
    prs.push(created)
    if (state.createTwoMatches === true) {
      const duplicateNumber = nextNumber + 1
      prs.push({
        ...created,
        number: duplicateNumber,
        id: 'PR_test_' + duplicateNumber,
        url: 'https://github.com/' + repo.owner + '/' + repo.repo + '/pull/' + duplicateNumber
      })
    }
    state.prs = prs
    saveState(state)
  }
  if (state.createFailure) fail(String(state.createFailure))
  if (state.createResponse === 'malformed') out('creation response could not be parsed')
  else if (state.createResponse === 'empty') out('')
  else out('https://github.com/' + repo.owner + '/' + repo.repo + '/pull/' + Math.max(1, ...prs.map((item) => item.number)))
} else if (command === 'pr' && args[1] === 'edit') {
  const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
  const item = byNumber(number)
  if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
  if (option('--title') !== undefined) item.title = option('--title')
  if (option('--body') !== undefined) item.body = option('--body')
  if (option('--add-reviewer') !== undefined) item.reviewers = [...(item.reviewers ?? []), ...option('--add-reviewer').split(',')]
  if (option('--remove-reviewer') !== undefined) item.reviewers = (item.reviewers ?? []).filter((value) => !option('--remove-reviewer').split(',').includes(value))
  savePr(item)
  out('')
} else if (command === 'pr' && ['close', 'reopen', 'ready'].includes(args[1])) {
  const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
  const item = byNumber(number)
  if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
  if (args[1] === 'close') item.state = 'CLOSED'
  if (args[1] === 'reopen') item.state = 'OPEN'
  if (args[1] === 'ready') item.isDraft = false
  savePr(item)
  out('')
} else if (command === 'pr' && args[1] === 'merge') {
  if (state.mergeFailure) fail(String(state.mergeFailure))
  const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
  const item = byNumber(number)
  if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
  if (args.includes('--match-head-commit') && option('--match-head-commit') !== item.headRefOid) {
    fail('HTTP 422: head sha does not match')
  }
  if (args.includes('--disable-auto')) item.autoMergeRequest = null
  else if (args.includes('--auto')) item.autoMergeRequest = { enabledAt: new Date(0).toISOString() }
  else item.state = 'MERGED'
  savePr(item)
  out('Merged pull request #' + number)
} else {
  out('')
}
`


async function rejection(promise: Promise<unknown>): Promise<{ code?: unknown; message: string; data?: unknown }> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof Error)) throw new Error('expected an Error rejection')
    const record = isRecord(error) ? error : undefined
    return { message: error.message, ...(record?.code !== undefined ? { code: record.code } : {}), ...(record?.data !== undefined ? { data: record.data } : {}) }
  }
  throw new Error('expected the call to reject')
}

function reasonOf(error: { data?: unknown }): unknown {
  return isRecord(error.data) ? error.data.reason : undefined
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object result')
  return value
}

async function host(state: Record<string, unknown> = fixtureState(), options?: { remote?: string; upstream?: string; branch?: string; tracked?: boolean }): Promise<HostingTest> {
  const result = await bootHosting(ghFixture, options)
  hosts.push(result)
  result.writeState(state)
  return result
}

function gitOutput(testHost: HostingTest, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: testHost.repoPath, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

function git(testHost: HostingTest, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: testHost.repoPath, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

function commitFeature(testHost: HostingTest): void {
  writeFileSync(join(testHost.repoPath, 'feature.txt'), 'feature\n')
  git(testHost, ['add', 'feature.txt'])
  git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit', '-m', 'feature'])
}

function pushFeature(testHost: HostingTest): void {
  commitFeature(testHost)
  git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
}

function advanceTrackingBranch(testHost: HostingTest): void {
  const tree = gitOutput(testHost, ['rev-parse', 'HEAD^{tree}'])
  const remoteCommit = gitOutput(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'remote advance'])
  git(testHost, ['update-ref', 'refs/remotes/origin/feature', remoteCommit])
}

function invocationsFor(testHost: HostingTest, predicate: (args: string[]) => boolean): Array<{ args: string[]; input: string; env: Record<string, string> }> {
  return testHost.invocations().filter((entry) => predicate(entry.args))
}
function restPullListCalls(testHost: HostingTest): Array<{ args: string[]; input: string; env: Record<string, string> }> {
  return invocationsFor(testHost, (args) => args[0] === 'api' && args.some((argument) => argument.includes('/pulls?')))
}

function pullListQuery(invocation: { args: string[] }): URLSearchParams {
  const endpoint = invocation.args.find((argument) => argument.includes('/pulls?'))
  if (!endpoint) throw new Error('expected a REST pulls list request')
  return new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1))
}
function requestBody(invocation: { input: string }): Record<string, unknown> {
  const value: unknown = JSON.parse(invocation.input)
  if (!isRecord(value)) throw new Error('expected GitHub JSON request body')
  return value
}

function graphqlQuery(invocation: { input: string }): string {
  const query = requestBody(invocation).query
  if (typeof query !== 'string') throw new Error('expected GraphQL query in GitHub request body')
  return query
}

async function waitForState(testHost: HostingTest, key: string): Promise<void> {
  const ready = (): boolean => {
    const value = testHost.readState()
    return isRecord(value) && value[key] === true
  }
  if (ready()) return
  const watcher = watch(testHost.root, { persistent: false })
  try {
    if (ready()) return
    for await (const _ of watcher) {
      if (ready()) return
    }
  } finally {
    await watcher.return?.()
  }
}

function installLocalGitTransport(testHost: HostingTest, pushBare: string, log: string, fetchBare?: string): void {
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('the test Git executable is unavailable')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const wrapper = [
    '#!/bin/sh',
    ...(fetchBare === undefined ? [] : [
      'if [ "$1" = "fetch" ]; then',
      '  if [ "$2" != "--no-tags" ] || [ "$3" != "--no-write-fetch-head" ] || [ "$4" != "--" ] || [ "$5" != "origin" ]; then',
      '    printf "%s\\n" "unexpected Git fetch target" >&2',
      '    exit 97',
      '  fi',
      '  shift 5',
      `  exec ${quote(realGit)} fetch --no-tags --no-write-fetch-head -- ${quote(fetchBare)} "$@"`,
      'fi'
    ]),
    'if [ "$1" = "push" ]; then',
    `  printf '%s\\n' "$*" >> ${quote(log)}`,
    '  shift',
    '  shift',
    `  exec ${quote(realGit)} push ${quote(pushBare)} "$@"`,
    'fi',
    `exec ${quote(realGit)} "$@"`
  ].join(String.fromCharCode(10)) + String.fromCharCode(10)
  writeFileSync(join(testHost.root, 'fakebin', 'git'), wrapper, { mode: 0o755 })
}


describe('quirky.hosting PR reads', () => {
  test('GH09 resolves a fork head against upstream, honors a linked number, and returns review metadata', async () => {
    const upstreamPr = pr({
      number: 11,
      url: 'https://github.com/upstream/project/pull/11',
      baseRepositoryOwner: { login: 'upstream' },
      baseRepository: { name: 'project', owner: { login: 'upstream' } },
      headRepositoryOwner: { login: 'fork' },
      headRepository: { name: 'project', owner: { login: 'fork' } },
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ state: 'SUCCESS', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    })
    const linkedPr = { ...upstreamPr, number: 12, title: 'Linked review', url: 'https://github.com/upstream/project/pull/12' }
    const testHost = await host(fixtureState({ prs: [upstreamPr, linkedPr] }), {
      remote: 'https://github.com/fork/project.git',
      upstream: 'https://github.com/upstream/project.git'
    })
  
    const branchLookup = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' }))
    expect(branchLookup.kind).toBe('found')
    expect(branchLookup.review).toMatchObject({
      provider: 'github', number: 11, state: 'open', headRefName: 'feature', baseRefName: 'main',
      headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN', checksStatus: 'success'
    })
  
    const linkedLookup = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature', number: 12 }))
    expect(linkedLookup).toMatchObject({ kind: 'found', review: { number: 12, title: 'Linked review' } })
    const exact = recordOf(await testHost.call('review', {
      worktree: testHost.worktree,
      number: 11,
      prRepo: { host: 'github.com', owner: 'upstream', repo: 'project' }
    }))
    expect(exact).toMatchObject({ kind: 'found', review: { number: 11, headRepositoryOwner: { login: 'fork' } } })
  
    expect(await testHost.call('review', {
      worktree: testHost.worktree,
      number: 99,
      prRepo: { host: 'github.com', owner: 'upstream', repo: 'project' }
    })).toMatchObject({ kind: 'no-review' })
  
    const before = testHost.invocations().length
    const foreign = await rejection(testHost.call('review', {
      worktree: testHost.worktree,
      number: 11,
      prRepo: { host: 'evil.example', owner: 'other', repo: 'repo' }
    }))
    expect(reasonOf(foreign)).toBe('repository_mismatch')
    expect(testHost.invocations().slice(before)).toHaveLength(0)
  }, 20_000)

  test('fresh branch lookup bypasses cached absence and refuses ambiguous current links', async () => {
    const testHost = await host(fixtureState())
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'no-review' })
    testHost.writeState(fixtureState({ prs: [pr({ headRefOid: gitOutput(testHost, ['rev-parse', 'HEAD']) })] }))
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature', fresh: true })).toMatchObject({
      kind: 'found',
      review: { number: 7, headRefName: 'feature', headRepositoryOwner: { login: 'test-owner' }, headRepository: { name: 'test-repo' } }
    })

    testHost.writeState(fixtureState({ prs: [
      pr({ headRefOid: gitOutput(testHost, ['rev-parse', 'HEAD']) }),
      pr({ number: 8, headRefOid: gitOutput(testHost, ['rev-parse', 'HEAD']), url: 'https://github.com/test-owner/test-repo/pull/8' })
    ] }))
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature', fresh: true })).toMatchObject({
      kind: 'unavailable',
      reason: 'ambiguous_head'
    })
    expect(restPullListCalls(testHost)).toHaveLength(3)
  }, 20_000)

  test('review push selects the fork head rather than base origin and pushes only to that exact configured remote', async () => {
    const testHost = await bootHosting(ghFixture, { extraBuiltins: ['quirky.git'] })
    hosts.push(testHost)
    const remoteHead = gitOutput(testHost, ['rev-parse', 'HEAD'])
    const baseBare = join(testHost.root, 'base.git')
    const forkBare = join(testHost.root, 'fork-push.git')
    const pushLog = join(testHost.root, 'pushes.log')
    writeFileSync(pushLog, '')
    git(testHost, ['init', '--bare', baseBare])
    git(testHost, ['init', '--bare', forkBare])
    git(testHost, ['push', baseBare, 'refs/heads/main:refs/heads/main'])
    commitFeature(testHost)
    const pullHead = gitOutput(testHost, ['rev-parse', 'HEAD'])
    git(testHost, ['push', forkBare, 'HEAD:refs/heads/feature'])
    git(testHost, ['push', baseBare, 'HEAD:refs/pull/7/head'])
    git(testHost, ['checkout', 'main'])
    git(testHost, ['remote', 'add', 'fork', 'https://github.com/test-owner/fork-repo.git'])
    testHost.writeState(fixtureState({
      prs: [pr({
        headRefOid: pullHead,
        baseRefOid: remoteHead,
        headRepositoryOwner: { login: 'test-owner' },
        headRepository: { name: 'fork-repo', owner: { login: 'test-owner' } }
      })]
    }))
    installLocalGitTransport(testHost, forkBare, pushLog, baseBare)

    const worktrees = await testHost.client.callAny('quirky.worktree/list', {})
    if (!Array.isArray(worktrees)) throw new Error('expected registered worktrees')
    const initial = worktrees.find((value) => isRecord(value) && value.id === testHost.worktree)
    if (!isRecord(initial) || typeof initial.repoId !== 'string') throw new Error('expected registered repository identity')
    const repoId = initial.repoId
    const created = recordOf(await testHost.client.callAny('quirky.worktree/create', {
      repo: repoId,
      github: 'https://github.com/test-owner/test-repo/pull/7'
    }))
    const forkWorktree = recordOf(created.worktree)
    if (typeof forkWorktree.id !== 'string' || typeof forkWorktree.path !== 'string') {
      throw new Error('expected a created pull-request worktree')
    }
    const forkWorktreeId = forkWorktree.id
    const forkWorktreePath = forkWorktree.path
    expect(forkWorktree).toMatchObject({
      branch: 'feature',
      linkedPR: {
        provider: 'github',
        kind: 'pullRequest',
        number: 7,
        repository: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
      },
      pushTarget: { remoteName: 'fork', branchName: 'feature' }
    })

    writeFileSync(join(forkWorktreePath, 'pushed.txt'), 'fork feature\n')
    git(testHost, ['-C', forkWorktreePath, 'add', 'pushed.txt'])
    git(testHost, ['-C', forkWorktreePath, '-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit', '-m', 'feature'])
    const localHead = gitOutput(testHost, ['-C', forkWorktreePath, 'rev-parse', 'HEAD'])

    const target = recordOf(await testHost.client.callAny('quirky.git/pushTarget', {
      worktree: forkWorktreeId,
      purpose: 'review'
    }))
    expect(target).toMatchObject({
      ready: true,
      remote: 'fork',
      branch: 'feature',
      localBranch: 'feature',
      localHead,
      headOid: pullHead,
      number: 7,
      fork: true,
      repository: { host: 'github.com', owner: 'test-owner', repo: 'fork-repo' }
    })

    expect(await testHost.client.callAny('quirky.git/push', { worktree: forkWorktreeId, purpose: 'review' })).toMatchObject({
      remote: 'fork',
      branch: 'feature',
      upstream: 'fork/feature'
    })
    const expectedPush = `push https://github.com/test-owner/fork-repo.git ${localHead}:refs/heads/feature`
    expect(gitOutput(testHost, ['--git-dir', forkBare, 'rev-parse', 'refs/heads/feature'])).toBe(localHead)
    expect(gitOutput(testHost, ['--git-dir', baseBare, 'rev-parse', 'refs/heads/main'])).toBe(remoteHead)
    expect(gitOutput(testHost, ['--git-dir', baseBare, 'rev-parse', 'refs/pull/7/head'])).toBe(pullHead)
    expect(gitOutput(testHost, ['--git-dir', baseBare, 'branch', '--list', 'feature'])).toBe('')
    expect(readFileSync(pushLog, 'utf8').trim()).toBe(expectedPush)
    expect(gitOutput(testHost, ['remote'])).toBe('fork\norigin')
    expect(gitOutput(testHost, ['remote', 'get-url', 'origin'])).toBe('https://github.com/test-owner/test-repo.git')
    expect(gitOutput(testHost, ['remote', 'get-url', '--push', 'fork'])).toBe('https://github.com/test-owner/fork-repo.git')

    testHost.writeState(fixtureState({
      prs: [pr({
        headRefName: 'moved-feature',
        headRefOid: pullHead,
        baseRefOid: remoteHead,
        headRepositoryOwner: { login: 'test-owner' },
        headRepository: { name: 'fork-repo', owner: { login: 'test-owner' } }
      })]
    }))
    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', {
      worktree: forkWorktreeId,
      purpose: 'review'
    }))).toMatchObject({ ready: false, reason: 'stale_worktree_target' })
    expect(reasonOf(await rejection(testHost.client.callAny('quirky.git/push', {
      worktree: forkWorktreeId,
      purpose: 'review'
    })))).toBe('stale_worktree_target')
    expect(readFileSync(pushLog, 'utf8').trim()).toBe(expectedPush)
    expect(gitOutput(testHost, ['--git-dir', forkBare, 'rev-parse', 'refs/heads/feature'])).toBe(localHead)
  }, 20_000)

  test('pushRepository resolves a later named remote among multiple remotes', async () => {
    const testHost = await host()
    git(testHost, ['remote', 'add', 'fork', 'https://github.com/test-owner/fork-repo.git'])

    expect(await testHost.call('pushRepository', { remote: 'fork' })).toMatchObject({
      ready: true,
      repository: { host: 'github.com', owner: 'test-owner', repo: 'fork-repo' }
    })
  }, 20_000)

  test('pushRepository refuses multiple push URLs with the exact ambiguity reason', async () => {
    const testHost = await host(fixtureState(), { remote: 'https://github.com/test-owner/fork-repo.git' })
    git(testHost, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/test-owner/fork-repo.git'])
    git(testHost, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/test-owner/other-fork.git'])

    expect(await testHost.call('pushRepository', { remote: 'origin' })).toMatchObject({
      ready: false,
      reason: 'ambiguous_push_url'
    })
  }, 20_000)

  test('review push revalidates each target and refuses unsafe, stale, closed, ambiguous or detached destinations before any push', async () => {
    const testHost = await bootHosting(ghFixture, { extraBuiltins: ['quirky.git'] })
    hosts.push(testHost)
    const remoteHead = gitOutput(testHost, ['rev-parse', 'HEAD'])
    const bare = join(testHost.root, 'push.git')
    const pushLog = join(testHost.root, 'pushes.log')
    writeFileSync(pushLog, '')
    git(testHost, ['init', '--bare', bare])
    git(testHost, ['push', bare, 'HEAD:refs/heads/feature'])
    commitFeature(testHost)
    installLocalGitTransport(testHost, bare, pushLog)
    const params = { worktree: testHost.worktree, purpose: 'review' }
    const linked = pr({ headRefOid: remoteHead })
    testHost.writeState(fixtureState({ prs: [linked] }))

    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params)).ready).toBe(true)
    testHost.writeState(fixtureState({ prs: [pr({ ...linked, state: 'CLOSED' })] }))
    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params))).toMatchObject({ ready: false })
    expect(reasonOf(await rejection(testHost.client.callAny('quirky.git/push', params)))).toBeTruthy()

    for (const prs of [
      [pr({ ...linked, state: 'MERGED' })],
      [pr({ ...linked, headRepository: { name: 'other-repo', owner: { login: 'test-owner' } } })],
      [pr({ ...linked, headRepository: null })],
      [
        linked,
        pr({ ...linked, number: 8, url: 'https://github.com/test-owner/test-repo/pull/8' })
      ]
    ]) {
      testHost.writeState(fixtureState({ prs }))
      expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params)).ready).toBe(false)
      await rejection(testHost.client.callAny('quirky.git/push', params))
    }

    testHost.writeState(fixtureState({ prs: [linked] }))
    git(testHost, ['remote', 'set-url', '--push', 'origin', `file://${bare}`])
    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params)).ready).toBe(false)
    await rejection(testHost.client.callAny('quirky.git/push', params))

    git(testHost, ['remote', 'set-url', '--push', 'origin', 'https://github.com/test-owner/test-repo.git'])
    git(testHost, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/test-owner/other.git'])
    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params)).ready).toBe(false)
    await rejection(testHost.client.callAny('quirky.git/push', params))

    git(testHost, ['config', '--unset-all', 'remote.origin.pushurl'])
    git(testHost, ['checkout', '--detach', 'HEAD'])
    expect(recordOf(await testHost.client.callAny('quirky.git/pushTarget', params))).toMatchObject({ ready: false })
    await rejection(testHost.client.callAny('quirky.git/push', params))

    expect(readFileSync(pushLog, 'utf8')).toBe('')
    expect(gitOutput(testHost, ['remote'])).toBe('origin')
    expect(gitOutput(testHost, ['--git-dir', bare, 'rev-parse', 'refs/heads/feature'])).toBe(remoteHead)
  }, 20_000)

  test('GH09 treats an absent PR from REST fallback as absence', async () => {
    const testHost = await host(fixtureState({ invalidPrView: true }))
    const result = recordOf(await testHost.call('review', { worktree: testHost.worktree, number: 99 }))
    expect(result).toMatchObject({ kind: 'no-review' })
    const fallback = invocationsFor(testHost, (args) =>
      args[0] === 'api' && args.includes('repos/test-owner/test-repo/pulls/99'))
    expect(fallback).toHaveLength(1)
    expect(fallback[0]!.args).toContain('--hostname')
    expect(fallback[0]!.args[fallback[0]!.args.indexOf('--hostname') + 1]).toBe('github.com')
  }, 20_000)

  test('GH09 follows a validated tracked-upstream branch when it differs from the local name', async () => {
    const testHost = await host(fixtureState({ prs: [pr({ headRefName: 'release', headRepositoryOwner: { login: 'test-owner' } })] }), {
      upstream: 'https://github.com/test-owner/test-repo.git'
    })
    git(testHost, ['update-ref', 'refs/remotes/upstream/release', 'HEAD'])
    git(testHost, ['branch', '--set-upstream-to=upstream/release', 'feature'])
  
    const result = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' }))
    expect(result).toMatchObject({ kind: 'found', review: { number: 7, headRefName: 'release' } })
  }, 20_000)
  test('GH09 finds an organization-owned branch review through the REST head filter', async () => {
    const organizationPr = pr({
      number: 31,
      url: 'https://github.com/acme/service/pull/31',
      headRepositoryOwner: { login: 'acme' },
      headRepository: { name: 'service', owner: { login: 'acme' } },
      baseRepositoryOwner: { login: 'acme' },
      baseRepository: { name: 'service', owner: { login: 'acme' } }
    })
    const testHost = await host(fixtureState({ prs: [organizationPr] }), {
      remote: 'https://github.com/acme/service.git'
    })

    const result = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' }))
    expect(result).toMatchObject({ kind: 'found', review: { number: 31, headRefName: 'feature' } })
    const pullLists = restPullListCalls(testHost)
    const pullList = pullLists[0]
    if (!pullList) throw new Error('expected a REST pulls list request')
    const headFilter = pullListQuery(pullList).get('head')
    expect(pullLists).toHaveLength(1)
    expect(headFilter).toBe('acme:feature')
  }, 20_000)

  test('GH10 distinguishes empty absence, hides stale merged/default-branch matches, and preserves explicit links', async () => {
    const merged = pr({ state: 'MERGED', headRefOid: 'd'.repeat(40) })
    const closedDefault = pr({ number: 8, headRefName: 'main', state: 'CLOSED', baseRefName: 'develop' })
    const testHost = await host(fixtureState({ prs: [merged, closedDefault] }))
  
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: '' })).toMatchObject({ kind: 'no-review' })
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature', headOid: 'e'.repeat(40) })).toMatchObject({ kind: 'no-review' })
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'main' })).toMatchObject({ kind: 'no-review' })
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'main', number: 8 })).toMatchObject({ kind: 'found', review: { number: 8, state: 'closed' } })
  
    const unavailableHost = await host(fixtureState({ listFailure: 'HTTP 503: unavailable' }))
    const unavailable = recordOf(await unavailableHost.call('forBranch', { worktree: unavailableHost.worktree, branch: 'feature' }))
    expect(unavailable).toMatchObject({ kind: 'unavailable' })
  }, 20_000)
})

async function assertStackedRegistration(appendExisting: boolean): Promise<void> {
  const existingStackValue = { number: 20, pullRequests: [20] }
  const parent = pr({
    number: 20,
    title: 'Parent',
    headRefName: 'parent',
    headRefOid: 'f'.repeat(40),
    url: 'https://github.com/test-owner/test-repo/pull/20',
  })
  const testHost = await host(fixtureState({
    prs: [parent],
    ...(appendExisting ? { stacks: { '20': [existingStackValue] } } : {})
  }))
  git(testHost, ['update-ref', 'refs/remotes/origin/parent', 'HEAD'])
  pushFeature(testHost)

  const result = recordOf(await testHost.call('createStacked', {
    worktree: testHost.worktree,
    parentNumber: 20,
    title: appendExisting ? 'Append child' : 'New child',
    body: 'Stack body'
  }))
  expect(result).toMatchObject({ number: 21, stacked: true })
  if (appendExisting) {
    expect(testHost.readState()).toMatchObject({ stackAdds: [{ stackNumber: 20, pullRequests: [21] }] })
  } else {
    expect(testHost.readState()).toMatchObject({ stacks: { '20': [{ number: 20, pullRequests: [20, 21] }] } })
  }
  const readback = recordOf(await testHost.call('review', { worktree: testHost.worktree, number: 21 }))
  expect(readback).toMatchObject({
    kind: 'found',
    review: {
      number: 21,
      state: 'open',
      stack: { number: 20, position: 2, size: 2, base: { ref: 'main', sha: 'b'.repeat(40) } }
    }
  })
}

describe('quirky.hosting PR creation', () => {
  test('GH11 invalidates a delayed in-flight lookup after an edit and publishes the change', async () => {
    const testHost = await host(fixtureState({ prs: [pr()], pauseNextView: true }))
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
  
    const lookupStarted = waitForState(testHost, 'lookupStarted')
    const stalePromise = testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })
    try {
      await lookupStarted
      await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'edit', title: 'Fresh title' })
    } finally {
      const current = testHost.readState()
      if (isRecord(current)) testHost.writeState({ ...current, releaseLookup: true })
      await stalePromise
    }
  
    const next = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' }))
    expect(next).toMatchObject({ kind: 'found', review: { title: 'Fresh title' } })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'view').length).toBeGreaterThanOrEqual(2)
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed')).toBe(true)
  }, 20_000)

  test('GH11 discards an in-flight refresh superseded by a review edit', async () => {
    const testHost = await host(fixtureState({ prs: [pr({ title: 'Old title' })], pauseNextView: true }))
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})

    const lookupStarted = waitForState(testHost, 'lookupStarted')
    const stalePromise = testHost.call('refresh', {
      candidate: { worktree: testHost.worktree, branch: 'feature' },
      reason: 'manual'
    })
    let staleResult: unknown
    try {
      await lookupStarted
      await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'edit', title: 'Fresh title' })
    } finally {
      const current = testHost.readState()
      if (isRecord(current)) testHost.writeState({ ...current, releaseLookup: true })
      staleResult = await stalePromise
    }

    expect(staleResult).toMatchObject({ kind: 'unavailable', reason: 'superseded' })
    expect(JSON.stringify(staleResult)).not.toContain('Old title')
    const refreshPayloads = events
      .filter((event) => isRecord(event) && event.type === 'quirky.hosting/refresh')
      .map((event) => isRecord(event) && isRecord(event.data) ? event.data : {})
    expect(refreshPayloads.some((payload) => JSON.stringify(payload).includes('Old title'))).toBe(false)
    expect(refreshPayloads.filter((payload) => payload.reason === 'manual' && 'outcome' in payload)).toHaveLength(0)
    expect(refreshPayloads.some((payload) => payload.status === 'skipped' && payload.skippedReason === 'superseded')).toBe(true)

    const next = recordOf(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' }))
    expect(next).toMatchObject({ kind: 'found', review: { title: 'Fresh title' } })
  }, 20_000)


  test('GH13 creation blockers are ordered and a failed lookup never becomes absence', async () => {
    const testHost = await host(fixtureState({ prs: [pr()] }))
    writeFileSync(join(testHost.repoPath, 'dirty.txt'), 'uncommitted\n')
    const existing = recordOf(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' }))
    expect(existing).toMatchObject({ eligible: false, reason: 'existing_review', nextAction: 'open_existing_review' })
  
    testHost.writeState(fixtureState({ listFailure: 'HTTP 503: unavailable' }))
    const unavailable = recordOf(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' }))
    expect(unavailable).toMatchObject({ eligible: false, reason: 'lookup_unavailable', nextAction: 'retry_lookup' })
  
    git(testHost, ['checkout', '--detach', 'HEAD'])
    const detached = recordOf(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' }))
    expect(detached).toMatchObject({ eligible: false, reason: 'detached_head', nextAction: 'checkout_branch' })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(0)
  }, 20_000)

  test('GH13 blocks dirty, missing-upstream, behind, unauthenticated, ahead, and missing-base branches before create', async () => {
    const testHost = await host(fixtureState())
    writeFileSync(join(testHost.repoPath, 'dirty.txt'), 'dirty\n')
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'dirty_tree' })
    await Bun.file(join(testHost.repoPath, 'dirty.txt')).delete()
  
    git(testHost, ['branch', '--unset-upstream', 'feature'])
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'no_upstream' })
    git(testHost, ['branch', '--set-upstream-to=origin/feature', 'feature'])
  
    advanceTrackingBranch(testHost)
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'branch_behind' })
    git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
  
    testHost.writeState(fixtureState({ authenticated: false }))
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'authentication_required' })
  
    testHost.writeState(fixtureState({ authenticated: true }))
    commitFeature(testHost)
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'branch_ahead' })
    git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
    git(testHost, ['update-ref', '-d', 'refs/remotes/origin/main'])
    expect(await testHost.call('creationEligibility', { worktree: testHost.worktree, base: 'main', title: 'new' })).toMatchObject({ eligible: false, reason: 'missing_remote_base' })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(0)
  }, 20_000)
  test('GH13 create rechecks authentication immediately before the mutation', async () => {
    const testHost = await host(fixtureState({ logoutAfterAuthStatus: true }))
    pushFeature(testHost)
  
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Must stay blocked' }))
    expect(reasonOf(error)).toBe('authentication_required')
    expect(testHost.readState()).toMatchObject({ authenticated: false })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(0)
  }, 20_000)
  test('GH13 create checks fresh branch state after a cached no-review lookup', async () => {
    const testHost = await host(fixtureState())
    await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })
    testHost.writeState(fixtureState({ prs: [pr()] }))
  
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, title: 'Must stay blocked' }))
    expect(reasonOf(error)).toBe('existing_review')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(0)
    expect(restPullListCalls(testHost)).toHaveLength(2)
  }, 20_000)
  test('GH13 blocks the default branch and unsupported providers before create', async () => {
    const defaultHost = await host(fixtureState(), { branch: 'main' })
    expect(await defaultHost.call('creationEligibility', { worktree: defaultHost.worktree, title: 'Default' })).toMatchObject({
      eligible: false, reason: 'default_branch', nextAction: 'create_new_branch'
    })
  
    const unsupportedHost = await host(fixtureState(), { remote: 'https://gitlab.com/test-owner/test-repo.git' })
    expect(await unsupportedHost.call('creationEligibility', { worktree: unsupportedHost.worktree, title: 'Unsupported' })).toMatchObject({
      eligible: false, reason: 'unsupported_provider', nextAction: 'select_github_repo'
    })
    expect(invocationsFor(unsupportedHost, (args) => args[0] === 'pr')).toHaveLength(0)
  }, 20_000)

  test('GH14 creates once with the detected D20 base, committed template body, draft flag, and temp-file cleanup', async () => {
    const testHost = await host(fixtureState())
    mkdirSync(join(testHost.repoPath, '.github'), { recursive: true })
    writeFileSync(join(testHost.repoPath, '.github', 'pull_request_template.md'), 'Template body\n')
    git(testHost, ['add', '.github/pull_request_template.md'])
    git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit', '-m', 'add pull request template'])
    git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
    const result = recordOf(await testHost.call('create', {
      worktree: testHost.worktree,
      title: 'Feature title',
      useTemplate: true,
      draft: true
    }))
    expect(result).toMatchObject({ number: 1, url: 'https://github.com/test-owner/test-repo/pull/1' })
    const createCalls = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')
    expect(createCalls).toHaveLength(1)
    const args = createCalls[0]!.args
    expect(args).toContain('--base')
    expect(args[args.indexOf('--base') + 1]).toBe('main')
    expect(args).toContain('--draft')
    const bodyFile = args[args.indexOf('--body-file') + 1]
    expect(bodyFile).toBeTruthy()
    expect(existsSync(bodyFile!)).toBe(false)
    expect(testHost.readState()).toMatchObject({ prs: [{ title: 'Feature title', body: 'Template body\n', isDraft: true }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 1 })).toMatchObject({
      kind: 'found', review: { title: 'Feature title', body: 'Template body\n', state: 'draft' }
    })
  }, 20_000)
  test('GH14 creates an organization-owned same-repository PR with a bare head, body template, draft, and readback', async () => {
    const testHost = await host(fixtureState({ organizationOwners: ['engineering'] }), {
      remote: 'https://github.com/engineering/widget.git'
    })
    mkdirSync(join(testHost.repoPath, '.github'), { recursive: true })
    writeFileSync(join(testHost.repoPath, '.github', 'pull_request_template.md'), 'Engineering template\n')
    git(testHost, ['add', '.github/pull_request_template.md'])
    git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit', '-m', 'add organization PR template'])
    git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])

    const result = recordOf(await testHost.call('create', {
      worktree: testHost.worktree, title: 'Organization feature', useTemplate: true, draft: true
    }))
    expect(result).toMatchObject({ number: 1, url: 'https://github.com/engineering/widget/pull/1' })
    const createCalls = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')
    const createCall = createCalls[0]
    if (!createCall) throw new Error('expected gh pr create invocation')
    const args = createCall.args
    const headIndex = args.indexOf('--head')
    const bodyFileIndex = args.indexOf('--body-file')
    const cliHead = args[headIndex + 1]
    const baseIndex = args.indexOf('--base')
    const cliBase = args[baseIndex + 1]
    const hasDraftFlag = args.includes('--draft')
    const hasBodyFileFlag = bodyFileIndex >= 0
    const bodyFile = args[bodyFileIndex + 1]
    const state = testHost.readState()
    if (!isRecord(state) || !Array.isArray(state.prs) || !isRecord(state.prs[0])) throw new Error('expected created pull request')
    const createdPr = state.prs[0]
    const createdCount = state.prs.length
    const createdBody = createdPr.body
    const createdDraft = createdPr.isDraft
    const headOwner = recordOf(createdPr.headRepositoryOwner).login
    const baseOwner = recordOf(createdPr.baseRepositoryOwner).login
    const headRepository = recordOf(createdPr.headRepository)
    const baseRepository = recordOf(createdPr.baseRepository)
    const headRepositoryOwner = recordOf(headRepository.owner).login
    const baseRepositoryOwner = recordOf(baseRepository.owner).login
    expect(createCalls).toHaveLength(1)
    expect(headIndex).toBeGreaterThanOrEqual(0)
    expect(cliHead).toBe('feature')
    expect(cliBase).toBe('main')
    expect(hasDraftFlag).toBe(true)
    expect(hasBodyFileFlag).toBe(true)
    expect(bodyFile).toBeTruthy()
    expect(existsSync(bodyFile!)).toBe(false)
    expect(invocationsFor(testHost, (callArgs) => callArgs[0] === 'api' && callArgs.some((argument) => argument === 'repos/engineering/widget/pulls'))).toHaveLength(0)
    expect(createdCount).toBe(1)
    expect(createdBody).toBe('Engineering template\n')
    expect(createdDraft).toBe(true)
    expect(headOwner).toBe('engineering')
    expect(headRepository.name).toBe('widget')
    expect(headRepositoryOwner).toBe('engineering')
    expect(baseRepository.name).toBe('widget')
    expect(baseRepositoryOwner).toBe('engineering')
    expect(baseOwner).toBe('engineering')
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 1 })).toMatchObject({
      kind: 'found',
      review: {
        number: 1, title: 'Organization feature', body: 'Engineering template\n', state: 'draft',
        headRefName: 'feature', baseRefName: 'main',
        headRepositoryOwner: { login: 'engineering' }, headRepository: { name: 'widget', owner: { login: 'engineering' } }
      }
    })
  }, 20_000)

  test('GH14 creates an organization-owned fork once through REST with head_repo, supplied body, draft, and readback', async () => {
    const testHost = await host(fixtureState({ organizationOwners: ['acme'] }), {
      remote: 'https://github.com/acme/feature-fork.git',
      upstream: 'https://github.com/acme/base-project.git'
    })
    mkdirSync(join(testHost.repoPath, '.github'), { recursive: true })
    writeFileSync(join(testHost.repoPath, '.github', 'pull_request_template.md'), 'Fork template\n')
    git(testHost, ['add', '.github/pull_request_template.md'])
    git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.invalid', 'commit', '-m', 'add fork PR template'])
    git(testHost, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])

    const result = recordOf(await testHost.call('create', {
      worktree: testHost.worktree, title: 'Organization fork', body: 'Supplied fork body', useTemplate: true, draft: true
    }))
    expect(result).toMatchObject({ number: 1, url: 'https://github.com/acme/base-project/pull/1' })
    const createCalls = invocationsFor(testHost, (args) => args[0] === 'api' && args.some((argument) => argument === 'repos/acme/base-project/pulls'))
    const createCall = createCalls[0]
    if (!createCall) throw new Error('expected REST pull request creation')
    const request = requestBody(createCall)
    const methodIndex = createCall.args.indexOf('-X')
    const methodValue = createCall.args[methodIndex + 1]
    const hasMethodFlag = methodIndex >= 0
    const cliCreateCalls = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')
    const state = testHost.readState()
    if (!isRecord(state) || !Array.isArray(state.prs) || !isRecord(state.prs[0])) throw new Error('expected created pull request')
    const createdPr = state.prs[0]
    const createdCount = state.prs.length
    const headOwner = recordOf(createdPr.headRepositoryOwner).login
    const headRepository = recordOf(createdPr.headRepository)
    const baseOwner = recordOf(createdPr.baseRepositoryOwner).login
    const baseRepository = recordOf(createdPr.baseRepository)
    expect(createCalls).toHaveLength(1)
    expect(hasMethodFlag).toBe(true)
    expect(methodValue).toBe('POST')
    expect(request).toMatchObject({
      title: 'Organization fork', head: 'acme:feature', head_repo: 'feature-fork',
      base: 'main', body: 'Supplied fork body', draft: true
    })
    expect(cliCreateCalls).toHaveLength(0)
    expect(createdCount).toBe(1)
    expect(headOwner).toBe('acme')
    expect(headRepository.name).toBe('feature-fork')
    expect(recordOf(headRepository.owner).login).toBe('acme')
    expect(baseOwner).toBe('acme')
    expect(baseRepository.name).toBe('base-project')
    expect(recordOf(baseRepository.owner).login).toBe('acme')
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 1 })).toMatchObject({
      kind: 'found',
      review: {
        number: 1, title: 'Organization fork', body: 'Supplied fork body', state: 'draft',
        headRefName: 'feature', baseRefName: 'main',
        headRepositoryOwner: { login: 'acme' }, headRepository: { name: 'feature-fork', owner: { login: 'acme' } }
      }
    })
  }, 20_000)

  test('D20 creates with detected, project, worktree, then explicit base precedence', async () => {
    const testHost = await host(fixtureState())
    pushFeature(testHost)
    for (const base of ['project-base', 'worktree-base', 'explicit-base']) {
      git(testHost, ['update-ref', `refs/remotes/origin/${base}`, 'HEAD'])
    }
  
    const createForBase = async (title: string, expected: string, base?: string) => {
      const before = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create').length
      await testHost.call('create', { title, ...(base ? { base } : {}) })
      const calls = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')
      expect(calls).toHaveLength(before + 1)
      const args = calls.at(-1)!.args
      expect(args[args.indexOf('--base') + 1]).toBe(expected)
    }
  
    await createForBase('Detected base', 'main')
    git(testHost, ['checkout', '-b', 'project-precedence'])
    git(testHost, ['update-ref', 'refs/remotes/origin/project-precedence', 'HEAD'])
    git(testHost, ['config', 'branch.project-precedence.remote', 'origin'])
    git(testHost, ['config', 'branch.project-precedence.merge', 'refs/heads/project-precedence'])
    await testHost.client.callAny('quirky.repo/set', { repo: `path:${testHost.repoPath}`, defaultBase: 'origin/project-base' })
    await createForBase('Project base', 'project-base')
  
    git(testHost, ['checkout', '-b', 'worktree-precedence'])
    git(testHost, ['update-ref', 'refs/remotes/origin/worktree-precedence', 'HEAD'])
    git(testHost, ['config', 'branch.worktree-precedence.remote', 'origin'])
    git(testHost, ['config', 'branch.worktree-precedence.merge', 'refs/heads/worktree-precedence'])
    await testHost.client.callAny('quirky.worktree/set', { worktree: testHost.worktree, baseRef: 'origin/worktree-base' })
    await createForBase('Worktree base', 'worktree-base')
  
    git(testHost, ['checkout', '-b', 'explicit-precedence'])
    git(testHost, ['update-ref', 'refs/remotes/origin/explicit-precedence', 'HEAD'])
    git(testHost, ['config', 'branch.explicit-precedence.remote', 'origin'])
    git(testHost, ['config', 'branch.explicit-precedence.merge', 'refs/heads/explicit-precedence'])
    await createForBase('Explicit base', 'explicit-base', 'origin/explicit-base')
  }, 20_000)

  test('GH15 probes malformed create output once and accepts exactly one matching review', async () => {
    const testHost = await host(fixtureState({ createResponse: 'malformed' }))
    pushFeature(testHost)
  
    const result = recordOf(await testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Created' }))
    expect(result).toMatchObject({ number: 1, url: 'https://github.com/test-owner/test-repo/pull/1' })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 1 })).toMatchObject({
      kind: 'found', review: { number: 1, title: 'Created', state: 'open' }
    })
    const calls = testHost.invocations()
    const createIndex = calls.findIndex((entry) => entry.args[0] === 'pr' && entry.args[1] === 'create')
    expect(createIndex).toBeGreaterThanOrEqual(0)
    const recoveryCalls = calls.slice(createIndex + 1).filter((entry) =>
      entry.args[0] === 'api' && entry.args.some((argument) => argument.includes('/pulls?')))
    const recoveryCall = recoveryCalls[0]
    if (!recoveryCall) throw new Error('expected one REST recovery probe')
    const recoveryQuery = pullListQuery(recoveryCall)
    const headFilter = recoveryQuery.get('head')
    const baseFilter = recoveryQuery.get('base')
    expect(recoveryCalls).toHaveLength(1)
    expect(headFilter).toBe('test-owner:feature')
    expect(baseFilter).toBe('main')
  }, 20_000)

  test('GH15 rejects ambiguous create output when multiple matching reviews are found', async () => {
    const testHost = await host(fixtureState({ createResponse: 'malformed', createTwoMatches: true }))
    pushFeature(testHost)
  
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Ambiguous' }))
    expect(reasonOf(error)).toBe('unknown_completion')
    const calls = testHost.invocations()
    const createIndex = calls.findIndex((entry) => entry.args[0] === 'pr' && entry.args[1] === 'create')
    const recoveryCalls = calls.slice(createIndex + 1).filter((entry) =>
      entry.args[0] === 'api' && entry.args.some((argument) => argument.includes('/pulls?')))
    const recoveryCall = recoveryCalls[0]
    if (!recoveryCall) throw new Error('expected one REST recovery probe')
    const recoveryQuery = pullListQuery(recoveryCall)
    const headFilter = recoveryQuery.get('head')
    const baseFilter = recoveryQuery.get('base')
    expect(recoveryCalls).toHaveLength(1)
    expect(headFilter).toBe('test-owner:feature')
    expect(baseFilter).toBe('main')
  }, 20_000)
  test('GH15 preserves a typed body-too-long rejection without probing for a PR', async () => {
    const testHost = await host(fixtureState({
      createWrites: false,
      createFailure: 'GitHub rejected the request because its body is too long.'
    }))
    pushFeature(testHost)
    const listsBefore = restPullListCalls(testHost).length
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Large body' }))
    expect(reasonOf(error)).toBe('body_too_long')
    expect(error.message).toBe('GitHub rejected the request because its body is too long.')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1)
    expect(restPullListCalls(testHost)).toHaveLength(listsBefore + 1)
    expect(testHost.readState()).toMatchObject({ prs: [] })
  }, 20_000)

  test('GH07 an ambiguous create timeout is called once and reports unknown completion without a confirmed change', async () => {
    const testHost = await host(fixtureState({ createWrites: false, createFailure: 'request timed out' }))
    pushFeature(testHost)
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
  
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Timeout' }))
    expect(reasonOf(error)).toBe('unknown_completion')
    expect(error.message).not.toContain('timed out')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1)
    const listsBeforeRefresh = restPullListCalls(testHost).length
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'no-review' })
    expect(restPullListCalls(testHost)).toHaveLength(listsBeforeRefresh + 1)
    expect(testHost.readState()).toMatchObject({ prs: [] })
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed' && isRecord(event.data) && event.data.confirmed === true)).toBe(false)
  }, 20_000)

  test('GH07 an ambiguous merge timeout is never replayed or reported as merged', async () => {
    const testHost = await host(fixtureState({ prs: [pr()], mergeFailure: 'request timed out' }))
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'found', review: { state: 'open' } })
    const listsBeforeTimeout = restPullListCalls(testHost).length
  
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('unknown_completion')
    expect(error.message).not.toContain('timed out')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(1)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed' && isRecord(event.data) && event.data.confirmed === true)).toBe(false)
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'found', review: { state: 'open' } })
    expect(restPullListCalls(testHost)).toHaveLength(listsBeforeTimeout + 1)
  }, 20_000)


  test('GH16 stacked creation reports confirmed PR creation and invalidates on registration failure', async () => {
    const parent = pr({
      number: 20,
      title: 'Parent',
      headRefName: 'parent',
      headRefOid: 'f'.repeat(40),
      url: 'https://github.com/test-owner/test-repo/pull/20'
    })
    const testHost = await host(fixtureState({ prs: [parent], stackRegistrationFails: true }))
    git(testHost, ['update-ref', 'refs/remotes/origin/parent', 'HEAD'])
    pushFeature(testHost)
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
  
    const error = await rejection(testHost.call('createStacked', {
      worktree: testHost.worktree,
      parentNumber: 20,
      title: 'Child',
      body: 'Body'
    }))
    expect(reasonOf(error)).toBe('partial_change')
    expect(error.data).toMatchObject({
      reason: 'partial_change', partial: true, completedSteps: ['create'],
      createdReview: { number: 21, url: 'https://github.com/test-owner/test-repo/pull/21' }
    })
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed' && isRecord(event.data) && event.data.partial === true)).toBe(true)
    expect(testHost.readState()).toMatchObject({ prs: [{ number: 20 }, { number: 21, title: 'Child' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 21 })).toMatchObject({
      kind: 'found', review: { number: 21, title: 'Child', state: 'open', baseRefName: 'parent' }
    })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1)
  }, 20_000)
  test('GH16 registers a newly created child pull request', async () => {
    await assertStackedRegistration(false)
  }, 20_000)

  test('GH16 appends an existing child pull request to its stack', async () => {
    await assertStackedRegistration(true)
  }, 20_000)
})

describe('quirky.hosting PR mutations', () => {
  test('GH22 all direct merge methods carry the expected-head guard and never delete or bypass protections', async () => {
    const testHost = await host(fixtureState({ prs: [pr()] }))
    for (const method of ['squash', 'merge', 'rebase']) {
      const current = testHost.readState()
      if (!isRecord(current) || !Array.isArray(current.prs)) throw new Error('expected pull request fixture')
      const currentPr = current.prs[0]
      if (!isRecord(currentPr)) throw new Error('expected pull request fixture')
      testHost.writeState({ ...current, prs: [{ ...currentPr, state: 'OPEN' }] })
      const result = recordOf(await testHost.call('merge', {
        worktree: testHost.worktree,
        number: 7,
        expectedHead: 'a'.repeat(40),
        method,
        action: 'direct',
        yes: true
      }))
      expect(result).toMatchObject({ state: 'merged', number: 7, head: 'a'.repeat(40) })
    }
    const calls = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge')
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.args).toContain('--match-head-commit')
      expect(call.args[call.args.indexOf('--match-head-commit') + 1]).toBe('a'.repeat(40))
      expect(call.args).not.toContain('--admin')
      expect(call.args).not.toContain('--delete-branch')
    }
    expect(invocationsFor(testHost, (args) => args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'MERGED' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({
      kind: 'found', review: { number: 7, state: 'merged' }
    })
  }, 20_000)

  test('GH22 and GH23 changed heads, review protection, conflicts, and unknown metadata refuse before mutation', async () => {
    const testHost = await host(fixtureState({ prs: [pr()] }))
    const tryMerge = (expectedHead: string) => testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead, method: 'squash', action: 'direct', yes: true
    })
    expect(String(reasonOf(await rejection(tryMerge('c'.repeat(40)))))).toContain('head')
  
    for (const changes of [
      { reviewDecision: 'REVIEW_REQUIRED' },
      { reviewDecision: 'CHANGES_REQUESTED' },
      { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
    ]) {
      const state = testHost.readState()
      if (!isRecord(state) || !Array.isArray(state.prs) || !isRecord(state.prs[0])) throw new Error('expected pull request fixture')
      testHost.writeState({ ...state, prs: [{ ...state.prs[0], ...changes }] })
      await rejection(tryMerge('a'.repeat(40)))
    }
  
    testHost.writeState(fixtureState({ prs: [pr()], mergeMetadataAvailable: false }))
    const metadataFailure = await rejection(tryMerge('a'.repeat(40)))
    expect(reasonOf(metadataFailure)).toBe('unknown_safety_metadata')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
  }, 20_000)
  test('GH23 merges ordinary PRs when the successful REST response omits stack or sets it null', async () => {
    const restStackResponses: Record<string, unknown>[] = [{}, { '7': null }]
    for (const restStacks of restStackResponses) {
      const testHost = await host(fixtureState({ prs: [pr()], restStacks }))
      const result = recordOf(await testHost.call('merge', {
        worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
      }))
      expect(result).toMatchObject({ state: 'merged', number: 7, head: 'a'.repeat(40) })
      expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(1)
      expect(invocationsFor(testHost, (args) => args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
      expect(testHost.readState()).toMatchObject({ prs: [{ state: 'MERGED' }] })
    }
  }, 20_000)

  test('GH23 refuses merging when the REST stack metadata probe fails', async () => {
    const testHost = await host(fixtureState({ prs: [pr()], restPullFailure: true }))
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('unknown_safety_metadata')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
  }, 20_000)

  test('GH23 refuses a malformed non-null REST stack summary', async () => {
    const testHost = await host(fixtureState({
      prs: [pr()],
      restStacks: { '7': { number: 7, position: 2, size: 1, base: { ref: 'main', sha: 'b'.repeat(40) } } }
    }))
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('unknown_safety_metadata')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
  }, 20_000)

  test('GH23 maps null and empty review decisions to NONE when a rule requires zero approvals', async () => {
    for (const reviewDecision of [null, '']) {
      const testHost = await host(fixtureState({
        prs: [pr({ reviewDecision })],
        rules: [{ type: 'PULL_REQUEST', parameters: { required_approving_review_count: 0 } }]
      }))
      const lookup = recordOf(await testHost.call('review', { worktree: testHost.worktree, number: 7 }))
      expect(recordOf(lookup.review).reviewDecision).toBe('NONE')
      const result = recordOf(await testHost.call('merge', {
        worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
      }))
      expect(result).toMatchObject({ state: 'merged', number: 7 })
    }
  }, 20_000)

  test('GH23 still requires approval when a PULL_REQUEST rule requires a positive approval count', async () => {
    const testHost = await host(fixtureState({
      prs: [pr({ reviewDecision: null })],
      rules: [{ type: 'PULL_REQUEST', parameters: { required_approving_review_count: 1 } }]
    }))
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('review_required')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
  }, 20_000)

  test('GH23 denies a missing reviewDecision instead of treating it as NONE', async () => {
    const missingDecision = pr()
    delete missingDecision.reviewDecision
    const testHost = await host(fixtureState({ prs: [missingDecision] }))
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('unknown_safety_metadata')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
  }, 20_000)


  test('GH22 a client cannot merge without destructive confirmation and GH24 queue/stack stay explicitly enqueued', async () => {
    const guarded = await host(fixtureState({ prs: [pr()] }))
    const notConfirmed = await rejection(guarded.call('merge', {
      worktree: guarded.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct'
    }))
    expect(notConfirmed.code).toBe(-32009)
    expect(invocationsFor(guarded, (args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(0)
  
    const queued = await host(fixtureState({ prs: [pr()], mergeQueueRequired: true, mergeAsyncStart: 'enqueued' }))
    const directError = await rejection(queued.call('merge', {
      worktree: queued.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(directError)).toBe('queue_required')
    const enqueued = recordOf(await queued.call('merge', {
      worktree: queued.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'queue', yes: true
    }))
    expect(enqueued).toMatchObject({ state: 'enqueued', number: 7, head: 'a'.repeat(40), operationId: 'op-queue' })
    expect(invocationsFor(queued, (args) => args.some((arg) => arg.includes('/merge-async')))).toHaveLength(1)
    expect(queued.readState()).toMatchObject({ mergeQueueEntries: [7], prs: [{ state: 'OPEN' }] })
  }, 20_000)

  test('GH24 recognizes an actual REST stack summary and merges by PR number through the async endpoint', async () => {
    const stack = { number: 7, position: 2, size: 2, base: { ref: 'main', sha: 'b'.repeat(40) } }
    const testHost = await host(fixtureState({
      prs: [pr()], restStacks: { '7': stack }, mergeAsyncStart: 'merged'
    }))
    const result = recordOf(await testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'rebase', action: 'direct', yes: true
    }))
    expect(result).toMatchObject({ state: 'merged', number: 7, head: 'a'.repeat(40) })
    const asyncCall = invocationsFor(testHost, (args) => args.some((arg) => arg.includes('/merge-async')))
    const asyncInvocation = asyncCall[0]
    if (!asyncInvocation) throw new Error('expected asynchronous merge request')
    const asyncEndpoint = asyncInvocation.args.find((arg) => arg.includes('/merge-async'))
    const mergeRequest = requestBody(asyncInvocation)
    expect(asyncCall).toHaveLength(1)
    expect(asyncEndpoint).toBe('repos/test-owner/test-repo/pulls/7/merge-async')
    expect(mergeRequest.merge_action).toBe('direct_merge')
    expect(mergeRequest.merge_method).toBe('rebase')
    expect(mergeRequest.sha).toBe('a'.repeat(40))
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(0)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'MERGED' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({
      kind: 'found', review: { number: 7, state: 'merged' }
    })
  }, 20_000)
  test('GH24 polls a pending async merge and returns enqueued instead of claiming it merged', async () => {
    const testHost = await host(fixtureState({ prs: [pr()], mergeQueueRequired: true, mergeAsyncStart: 'pending', mergeAsyncPoll: 'enqueued' }))
    // The daemon runs in another process, so its real one-second provider poll cannot use this test process's fake clock.
    const result = recordOf(await testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'queue', yes: true
    }))
    expect(result).toMatchObject({ state: 'enqueued', number: 7, head: 'a'.repeat(40), operationId: 'op-stack' })
    expect(invocationsFor(testHost, (args) => args.some((arg) => arg.includes('/merge-async/op-stack')))).toHaveLength(1)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
  }, 20_000)

  test('GH24 stops on a terminal async poll response without inventing a pending result or resubmitting', async () => {
    const stack = { number: 7, position: 2, size: 2, base: { ref: 'main', sha: 'b'.repeat(40) } }
    const testHost = await host(fixtureState({
      prs: [pr()], restStacks: { '7': stack }, mergeAsyncStart: 'pending', mergeAsyncPoll: 'failed'
    }))
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(recordOf(error.data).reason).toBe('unknown_completion')
    expect(invocationsFor(testHost, (args) => args.some((arg) => arg.endsWith('/merge-async')) && args.includes('PUT'))).toHaveLength(1)
    expect(invocationsFor(testHost, (args) => args.some((arg) => arg.endsWith('/merge-async/op-stack')))).toHaveLength(1)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
  }, 20_000)


  test('GH25 auto-merge on/off is host-pinned, head-checked, and rejects stacks', async () => {
    const testHost = await host(fixtureState({ prs: [pr()] }))
    await testHost.call('autoMerge', {
      worktree: testHost.worktree, number: 7, action: 'enable', expectedHead: 'a'.repeat(40), method: 'squash'
    })
    expect(testHost.invocations().filter((entry) => entry.args[0] === 'api' && entry.args.includes('graphql') &&
      graphqlQuery(entry).includes('enablePullRequestAutoMerge'))).toHaveLength(1)
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({
      kind: 'found', review: { autoMergeRequest: { enabledAt: '1970-01-01T00:00:00.000Z' } }
    })
    await testHost.call('autoMerge', { worktree: testHost.worktree, number: 7, action: 'disable' })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({
      kind: 'found', review: { autoMergeRequest: null }
    })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto'))).toHaveLength(1)
  
    const stackedHost = await host(fixtureState({
      prs: [pr()], restStacks: { '7': { number: 7, position: 1, size: 1, base: { ref: 'main', sha: 'b'.repeat(40) } } }
    }))
    const error = await rejection(stackedHost.call('autoMerge', {
      worktree: stackedHost.worktree, number: 7, action: 'enable', expectedHead: 'a'.repeat(40), method: 'squash'
    }))
    expect(reasonOf(error)).toBe('stacked_auto_merge_unsupported')
    expect(stackedHost.invocations().filter((entry) => entry.args[0] === 'api' && entry.args.includes('graphql') &&
      graphqlQuery(entry).includes('enablePullRequestAutoMerge'))).toHaveLength(0)
  }, 20_000)

  test('GH26 edits, closes, reopens, marks ready, and changes reviewers while rejecting empty values', async () => {
    const testHost = await host(fixtureState({ prs: [pr({ isDraft: true })] }))
    await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'edit', title: 'Edited title', body: 'Edited body' })
    expect(testHost.readState()).toMatchObject({ prs: [{ title: 'Edited title', body: 'Edited body' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({
      kind: 'found', review: { title: 'Edited title', body: 'Edited body' }
    })
    await testHost.call('reviewers', { worktree: testHost.worktree, number: 7, action: 'add', logins: ['alice', 'bob'] })
    await testHost.call('reviewers', { worktree: testHost.worktree, number: 7, action: 'remove', logins: ['alice'] })
    await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'close' })
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'CLOSED' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({ kind: 'found', review: { state: 'closed' } })
    await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'reopen' })
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({ kind: 'found', review: { state: 'draft' } })
    await testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'ready' })
    expect(testHost.readState()).toMatchObject({ prs: [{ isDraft: false }] })
    expect(await testHost.call('review', { worktree: testHost.worktree, number: 7 })).toMatchObject({ kind: 'found', review: { state: 'open' } })
    expect(testHost.readState()).toMatchObject({ prs: [{ reviewers: ['bob'], isDraft: false }] })
  
    const before = testHost.invocations().length
    await rejection(testHost.call('updateReview', { worktree: testHost.worktree, number: 7, action: 'edit', title: '' }))
    await rejection(testHost.call('reviewers', { worktree: testHost.worktree, number: 7, action: 'add', logins: [] }))
    expect(testHost.invocations().slice(before)).toHaveLength(0)
  }, 20_000)

  test('GH22 a plugin caller reaches the same destructive merge gate without changing upstream state', async () => {
    const testHost = await host(fixtureState({ prs: [pr()] }))
    const outcome = await testHost.pluginCall('quirky.hosting/merge', {
      worktree: testHost.worktree,
      number: 7,
      expectedHead: 'a'.repeat(40),
      method: 'squash',
      action: 'direct'
    })
    expect(outcome).toMatchObject({ rejected: true })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge' || args.some((arg) => arg.includes('/merge-async')))).toHaveLength(0)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
  }, 20_000)
})

test('Tasks review metadata exposes queue and auto-merge capabilities and refuses a disabled enable before mutation', async () => {
  const instance = await host(fixtureState({ prs: [pr({ updatedAt: '2026-10-27T18:00:00Z', additions: 3, deletions: 1, changedFiles: 2, reviewRequests: [{ login: 'waiting-reviewer' }], reviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }], assignees: [{ login: 'owner' }] })], mergeQueueRequired: true, autoMergeAllowed: false }))
  const lookup = recordOf(await instance.call('review', { number: 7 }))
  const review = recordOf(lookup.review)
  expect(review.updatedAt).toBe('2026-10-27T18:00:00Z')
  expect(review.mergeMetadataKnown).toBe(true)
  expect(review.mergeQueueRequired).toBe(true)
  expect(review.autoMergeAllowed).toBe(false)
  expect([review.additions, review.deletions, review.changedFiles]).toEqual([3, 1, 2])
  expect(review.requestedReviewers).toEqual(['waiting-reviewer'])
  expect(review.reviews).toEqual([{ author: 'reviewer', state: 'CHANGES_REQUESTED' }])
  expect(review.assignees).toEqual(['owner'])
  const before = instance.invocations().length
  const failure = await rejection(instance.call('autoMerge', { number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'enable' }))
  expect(recordOf(failure.data).reason).toBe('auto_merge_disabled')
  expect(instance.invocations().slice(before).some(entry => entry.args.some(arg => arg.includes('EnableHostingPullRequestAutoMerge')) || entry.args.includes('--auto'))).toBe(false)
}, 20_000)

test('unavailable review capability reads remain unknown instead of advertising direct merge or auto-merge', async () => {
  const instance = await host(fixtureState({ prs: [pr()], mergeMetadataAvailable: false }))
  const lookup = recordOf(await instance.call('review', { number: 7 }))
  const review = recordOf(lookup.review)
  expect(review.updatedAt).toBeNull()
  expect(review.mergeMetadataKnown).toBe(false)
  expect(review.mergeQueueRequired).toBeNull()
  expect(review.autoMergeAllowed).toBeNull()
}, 20_000)

test('work-item state keeps closed precedence over the draft flag', async () => {
  const instance = await host(fixtureState({ prs: [pr({ number: 9, state: 'CLOSED', isDraft: true })] }))
  const item = recordOf(await instance.call('workItem', { kind: 'pullRequest', number: 9 }))
  expect(item.state).toBe('closed')
  expect(item.isDraft).toBe(true)
}, 20_000)

test('PR detail exposes existing requested reviewers and reviewed state without an empty fallback', async () => {
  const instance = await host(fixtureState({ prs: [pr({ reviewRequests: [{ login: 'alice' }], reviews: [{ author: { login: 'bob' }, state: 'APPROVED' }], assignees: [{ login: 'maintainer' }] })] }))
  const detail = recordOf(await instance.call('workItemDetails', { kind: 'pullRequest', number: 7 }))
  expect(detail.requestedReviewers).toEqual(['alice'])
  expect(detail.reviews).toEqual([{ author: 'bob', state: 'APPROVED' }])
  expect(detail.assignees).toEqual(['maintainer'])
  expect(detail.participantsTruncated).toBe(false)
}, 20_000)
