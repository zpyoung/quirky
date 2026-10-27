import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
const savePr = (item) => {
  const index = prs.findIndex((entry) => entry.number === item.number)
  if (index < 0) prs.push(item)
  else prs[index] = item
  state.prs = prs
  saveState(state)
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
        out({ data: { repository: {
          id: 'REPO_' + owner + '_' + name,
          viewerDefaultMergeMethod: 'SQUASH',
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
          autoMergeAllowed: true,
          defaultBranchRef: { name: state.defaultBranch ?? 'main' },
          mergeQueue: state.mergeQueueRequired ? { id: 'QUEUE_test' } : null,
          ref: { rules: { nodes: Array.isArray(state.rules) ? state.rules : [] } }
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
      const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
      const head = query.get('head') ?? ''
      const branch = head.split(':').at(-1) ?? ''
      const base = query.get('base') ?? ''
      out(prs.filter((item) => item.headRefName === branch && (!base || item.baseRefName === base) && belongsTo(item, apiOwnerRepo)))
    } else if (/\/pulls\/\d+\/merge-async(?:\/|$)/.test(endpoint)) {
      const mergeNumber = Number(endpoint.match(/\/pulls\/(\d+)\/merge-async/)?.[1])
      const item = byNumber(mergeNumber)
      if (!item || !belongsTo(item, apiOwnerRepo)) fail('HTTP 404: Not Found')
      if (method === 'PUT') {
        if (state.mergeAsyncFailure) fail('HTTP 404: merge-async not supported')
        if (inputFields.sha !== item.headRefOid) fail('HTTP 422: head sha does not match')
        const mergeAction = inputFields.merge_action
        if (mergeAction !== 'direct_merge' && mergeAction !== 'merge_queue') fail('Invalid merge action')
        if (!['squash', 'merge', 'rebase'].includes(inputFields.merge_method)) fail('Invalid merge method')
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
        out({ status: outcome, id: operationId })
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
        out({ status: outcome, id: operationId })
      }
    } else if (/\/pulls\/\d+$/.test(endpoint)) {
      const item = byNumber(apiNumber)
      if (!item || !belongsTo(item, apiOwnerRepo)) fail('HTTP 404: Not Found')
      if (method === 'PATCH') {
        for (const [key, value] of Object.entries(inputFields)) item[key] = value
        if (option('--title') !== undefined) item.title = option('--title')
        savePr(item)
      }
      out(item)
    } else if (endpoint.includes('/stacks?')) {
      const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
      const pullRequest = query.get('pull_request') ?? ''
      const stacks = state.stacks && typeof state.stacks === 'object' ? state.stacks : {}
      out(stacks[pullRequest] ?? [])
    } else if (endpoint.endsWith('/stacks') && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      const stackId = 'stack-1'
      const pullRequests = Array.isArray(inputFields.pull_requests) ? inputFields.pull_requests : []
      const stack = { id: stackId, pullRequests }
      state.stacks = state.stacks ?? {}
      state.stacks[String(pullRequests[0] ?? '')] = [stack]
      const child = byNumber(pullRequests.at(-1))
      if (child) child.stack = stack
      saveState(state)
      out(stack)
    } else if (/\/stacks\/[^/]+\/add$/.test(endpoint) && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      const stackId = endpoint.split('/').at(-2)
      const pullRequests = Array.isArray(inputFields.pull_requests) ? inputFields.pull_requests : []
      const stackCollections = Object.values(state.stacks ?? {}).flat()
      const stack = stackCollections.find((item) => item.id === stackId) ?? { id: stackId, pullRequests: [] }
      stack.pullRequests = [...(stack.pullRequests ?? []), ...pullRequests]
      state.stackAdds = [...(state.stackAdds ?? []), { stackId, pullRequests }]
      const child = byNumber(pullRequests.at(-1))
      if (child) child.stack = stack
      saveState(state)
      out({ id: stackId, added: true })
    } else {
      out({})
    }
  }
} else if (command === 'repo' && args[1] === 'view') {
  out({ nameWithOwner: repo.owner + '/' + repo.repo, isFork: false, parent: null, defaultBranchRef: { name: state.defaultBranch ?? 'main' } })
} else if (command === 'pr' && args[1] === 'list') {
  if (state.listFailure) fail(state.listFailure === true ? 'HTTP 503: temporarily unavailable' : String(state.listFailure))
  const head = option('--head', '')
  const branch = head.split(':').at(-1) ?? ''
  const base = option('--base', '')
  const stateFilter = option('--state', 'open')
  out(prs.filter((item) => item.headRefName === branch && (!base || item.baseRefName === base) && belongsTo(item, repo) && (stateFilter === 'all' || item.state === 'OPEN' || item.state === 'DRAFT')))
} else if (command === 'pr' && args[1] === 'view') {
  if (state.invalidPrView === true) {
    out({})
  } else {
    const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
    const item = number ? byNumber(number) : undefined
    if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
    if (state.pauseNextView === true) {
      const snapshot = JSON.stringify(item)
      const watcher = watch(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', { persistent: false })
      state.pauseNextView = false
      state.lookupStarted = true
      saveState(state)
      for await (const _ of watcher) {
        if (readState().releaseLookup === true) break
      }
      out(snapshot)
    } else {
      out(item)
    }
  }
} else if (command === 'pr' && args[1] === 'create') {
  if (state.createWrites !== false) {
    const title = option('--title', 'Untitled')
    const base = option('--base', 'main')
    const headParts = option('--head', 'test-owner:feature').split(':')
    const headOwner = headParts.length > 1 ? headParts[0] : repo.owner
    const head = headParts.at(-1)
    const bodyPath = option('--body-file')
    const body = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : ''
    const nextNumber = Math.max(0, ...prs.map((item) => item.number)) + 1
    const created = {
      ...{
        number: nextNumber, id: 'PR_test_' + nextNumber, title, body, state: 'OPEN', isDraft: args.includes('--draft'),
        url: 'https://github.com/' + repo.owner + '/' + repo.repo + '/pull/' + nextNumber,
        baseRefName: base, baseRefOid: 'b'.repeat(40), headRefName: head, headRefOid: 'c'.repeat(40),
        headRepositoryOwner: { login: headOwner }, headRepository: { name: repo.repo, owner: { login: headOwner } },
        baseRepositoryOwner: { login: repo.owner }, baseRepository: { name: repo.repo, owner: { login: repo.owner } },
        mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [], autoMergeRequest: null, stack: null
      }
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


async function rejection(promise: Promise<unknown>): Promise<{ message: string; data?: unknown }> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof Error)) throw new Error('expected an Error rejection')
    const record = isRecord(error) ? error : undefined
    return { message: error.message, ...(record?.data !== undefined ? { data: record.data } : {}) }
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
  const existingStackValue = { id: 'stack-1', pullRequests: [20] }
  const parent = pr({
    number: 20,
    title: 'Parent',
    headRefName: 'parent',
    headRefOid: 'f'.repeat(40),
    url: 'https://github.com/test-owner/test-repo/pull/20',
    stack: appendExisting ? existingStackValue : null
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
    expect(testHost.readState()).toMatchObject({ stackAdds: [{ stackId: 'stack-1', pullRequests: [21] }] })
  } else {
    expect(testHost.readState()).toMatchObject({ stacks: { '20': [{ id: 'stack-1', pullRequests: [20, 21] }] } })
  }
  expect(await testHost.call('review', { worktree: testHost.worktree, number: 21 })).toMatchObject({
    kind: 'found', review: { number: 21, state: 'open', stack: { id: 'stack-1', pullRequests: [20, 21] } }
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
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(2)
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
    expect(calls.slice(createIndex + 1).filter((entry) => entry.args[0] === 'pr' && entry.args[1] === 'list')).toHaveLength(1)
  }, 20_000)

  test('GH15 rejects ambiguous create output when multiple matching reviews are found', async () => {
    const testHost = await host(fixtureState({ createResponse: 'malformed', createTwoMatches: true }))
    pushFeature(testHost)
  
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Ambiguous' }))
    expect(reasonOf(error)).toBe('unknown_completion')
    const calls = testHost.invocations()
    const createIndex = calls.findIndex((entry) => entry.args[0] === 'pr' && entry.args[1] === 'create')
    expect(calls.slice(createIndex + 1).filter((entry) => entry.args[0] === 'pr' && entry.args[1] === 'list')).toHaveLength(1)
  }, 20_000)
  test('GH15 preserves a typed body-too-long rejection without probing for a PR', async () => {
    const testHost = await host(fixtureState({
      createWrites: false,
      createFailure: 'GitHub rejected the request because its body is too long.'
    }))
    pushFeature(testHost)
    const listsBefore = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list').length
    const error = await rejection(testHost.call('create', { worktree: testHost.worktree, base: 'main', title: 'Large body' }))
    expect(reasonOf(error)).toBe('body_too_long')
    expect(error.message).toBe('GitHub rejected the request because its body is too long.')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1)
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(listsBefore + 1)
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
    const listsBeforeRefresh = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list').length
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'no-review' })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(listsBeforeRefresh + 1)
    expect(testHost.readState()).toMatchObject({ prs: [] })
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed' && isRecord(event.data) && event.data.confirmed === true)).toBe(false)
  }, 20_000)

  test('GH07 an ambiguous merge timeout is never replayed or reported as merged', async () => {
    const testHost = await host(fixtureState({ prs: [pr()], mergeFailure: 'request timed out' }))
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'found', review: { state: 'open' } })
    const listsBeforeTimeout = invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list').length
  
    const error = await rejection(testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true
    }))
    expect(reasonOf(error)).toBe('unknown_completion')
    expect(error.message).not.toContain('timed out')
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(1)
    expect(testHost.readState()).toMatchObject({ prs: [{ state: 'OPEN' }] })
    expect(events.some((event) => isRecord(event) && event.type === 'quirky.hosting/changed' && isRecord(event.data) && event.data.confirmed === true)).toBe(false)
    expect(await testHost.call('forBranch', { worktree: testHost.worktree, branch: 'feature' })).toMatchObject({ kind: 'found', review: { state: 'open' } })
    expect(invocationsFor(testHost, (args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(listsBeforeTimeout + 1)
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
    expect(error.message).toContain('21')
    expect(error.message).toContain('Completed steps: create')
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

  test('GH22 a client cannot merge without destructive confirmation and GH24 queue/stack stay explicitly enqueued', async () => {
    const guarded = await host(fixtureState({ prs: [pr()] }))
    const notConfirmed = await rejection(guarded.call('merge', {
      worktree: guarded.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct'
    }))
    expect(notConfirmed.message.toLowerCase()).toContain('confirm')
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

  test('GH24 stacks use the async merge route and preserve a truthful merged result', async () => {
    const stacked = pr({ stack: { id: 'stack-1', pullRequests: [7, 8] } })
    const testHost = await host(fixtureState({ prs: [stacked], mergeAsyncStart: 'merged' }))
    const result = recordOf(await testHost.call('merge', {
      worktree: testHost.worktree, number: 7, expectedHead: 'a'.repeat(40), method: 'rebase', action: 'direct', yes: true
    }))
    expect(result).toMatchObject({ state: 'merged', number: 7, head: 'a'.repeat(40) })
    const asyncCall = invocationsFor(testHost, (args) => args.some((arg) => arg.includes('/merge-async')))
    expect(asyncCall).toHaveLength(1)
    expect(requestBody(asyncCall[0]!).merge_action).toBe('direct_merge')
    expect(requestBody(asyncCall[0]!).merge_method).toBe('rebase')
    expect(requestBody(asyncCall[0]!).sha).toBe('a'.repeat(40))
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
  
    const stackedHost = await host(fixtureState({ prs: [pr({ stack: { id: 'stack-1' } })] }))
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
