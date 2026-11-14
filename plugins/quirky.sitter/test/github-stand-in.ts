export interface StandInState {
  prs: {
    number: number
    id: string
    title: string
    body: string
    state: 'OPEN' | 'CLOSED' | 'MERGED'
    url: string
    isDraft: boolean
    baseRefName: string
    baseRefOid: string
    headRefName: string
    headRefOid: string
    headRepositoryOwner: { login: string }
    headRepository: { name: string; owner: { login: string } }
    baseRepositoryOwner: { login: string }
    baseRepository: { name: string; owner: { login: string } }
    mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
    mergeStateStatus: string
    reviewDecision: string
    autoMergeRequest: null
    stack: null
  }[]
  checkRuns: {
    __typename: 'CheckRun'
    databaseId: number
    name: string
    status: string
    conclusion: string | null
    detailsUrl: string
    workflowRunId: number
  }[]
  defaultBranch: string
  updatedHead: string
  mergeQueueRequired: boolean
  mergeVisible: boolean
}

export function standInState(overrides: Partial<StandInState> = {}): StandInState {
  return {
    prs: [{
      number: 7,
      id: 'PR_test_7',
      title: 'Review title',
      body: 'Review body',
      state: 'OPEN',
      url: 'https://github.com/test-owner/test-repo/pull/7',
      isDraft: false,
      baseRefName: 'main',
      baseRefOid: 'b'.repeat(40),
      headRefName: 'feature',
      headRefOid: '1'.repeat(40),
      headRepositoryOwner: { login: 'test-owner' },
      headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
      baseRepositoryOwner: { login: 'test-owner' },
      baseRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'APPROVED',
      autoMergeRequest: null,
      stack: null
    }],
    checkRuns: [{
      __typename: 'CheckRun',
      databaseId: 9001,
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/test-owner/test-repo/actions/runs/41/job/9001',
      workflowRunId: 41
    }],
    defaultBranch: 'main',
    updatedHead: '2'.repeat(40),
    mergeQueueRequired: false,
    mergeVisible: true,
    ...overrides
  }
}

export const GITHUB_STAND_IN = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const saveState = (state) => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, statePath)
}
const args = process.argv.slice(2)
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => {
  process.stderr.write(message + '\n')
  process.exit(1)
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
let inputFields = {}
try {
  inputFields = input.length === 0 ? {} : JSON.parse(input)
} catch {
  fail('GitHub request body is not valid JSON')
}
if (!isRecord(inputFields)) fail('GitHub request body must be a JSON object')
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const state = readState()
const prs = Array.isArray(state.prs) ? state.prs : []
const ownerRepo = (value) => {
  const parts = String(value ?? '').split('/')
  return { owner: parts.length > 1 ? parts.at(-2) : '', repo: parts.at(-1) ?? '' }
}
const repo = ownerRepo(option('--repo', option('-R', 'github.com/test-owner/test-repo')))
const byNumber = (value) => prs.find((item) => item.number === Number(value))
const belongsTo = (item, identity) => {
  const owner = item.baseRepositoryOwner?.login ?? item.baseRepository?.owner?.login
  const name = item.baseRepository?.name
  return owner === identity.owner && name === identity.repo
}
const projectPr = (item) => {
  item = { ...item, state: item.state === 'MERGED' && !state.mergeVisible ? 'OPEN' : item.state, statusCheckRollup: state.checkRuns }
  const fields = option('--json')
  if (typeof fields !== 'string') return item
  const projected = {}
  for (const field of fields.split(',')) {
    if (Object.hasOwn(item, field)) projected[field] = item[field]
  }
  return projected
}
const restPull = (item) => {
  const baseOwner = item.baseRepositoryOwner?.login ?? item.baseRepository?.owner?.login ?? repo.owner
  const baseRepo = item.baseRepository?.name ?? repo.repo
  const headOwner = item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login ?? repo.owner
  const headRepo = item.headRepository === null ? null : item.headRepository?.name ?? repo.repo
  const merged = item.state === 'MERGED' && state.mergeVisible
  return {
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
    base: { ref: item.baseRefName, sha: item.baseRefOid, repo: { name: baseRepo, owner: { login: baseOwner } } },
    head: { ref: item.headRefName, sha: item.headRefOid, repo: headRepo === null ? null : { name: headRepo, owner: { login: headOwner } }, user: { login: headOwner } },
  }
}
const command = args[0]
if (command === 'version' && args.length === 1) {
  out('gh version 2.70.0\n')
} else if (command === 'auth' && args[1] === 'status' && args.slice(2).every((value, index, rest) => value === '--hostname' && rest[index + 1] === 'github.com' || index > 0 && rest[index - 1] === '--hostname')) {
  out('Logged in to github.com account test-user (keyring)\n')
} else if (command === 'auth' && args[1] === 'token' && args.slice(2).every((value, index, rest) => value === '--hostname' && rest[index + 1] === 'github.com' || index > 0 && rest[index - 1] === '--hostname')) {
  out('isolated-test-token\n')
} else if (command === 'repo' && args[1] === 'view' && repo.owner === 'test-owner' && repo.repo === 'test-repo') {
  out({ nameWithOwner: 'test-owner/test-repo', isFork: false, parent: null, defaultBranchRef: { name: state.defaultBranch ?? 'main' } })
} else if (command === 'pr' && args[1] === 'view' && repo.owner === 'test-owner' && repo.repo === 'test-repo') {
  const number = args[2]
  const item = byNumber(number)
  if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
  out(projectPr(item))
} else if (command === 'pr' && args[1] === 'merge' && repo.owner === 'test-owner' && repo.repo === 'test-repo') {
  const item = byNumber(args[2])
  if (!item || !belongsTo(item, repo)) fail('HTTP 404: Not Found')
  const expectedArgs = ['pr', 'merge', String(item.number), '--squash', '--match-head-commit', item.headRefOid, '--repo', 'github.com/test-owner/test-repo']
  if (JSON.stringify(args) !== JSON.stringify(expectedArgs)) fail('Unsupported pull request merge invocation')
  item.state = 'MERGED'
  saveState(state)
  out('Merged pull request #' + item.number + '\n')
} else if (command === 'api') {
  const hostnameIndex = args.indexOf('--hostname')
  if (hostnameIndex < 0 || args[hostnameIndex + 1] !== 'github.com') fail('GitHub API requests must be pinned to github.com')
  const endpoint = args.find((value) => value === 'graphql' || value === 'rate_limit' || value === 'user' || value.startsWith('repos/'))
  if (!endpoint) fail('Unsupported GitHub API endpoint')
  const methodIndex = args.findIndex((value) => value === '-X' || value === '--method')
  const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]?.toUpperCase()
  const parts = endpoint.match(/^repos\/([^/]+)\/([^/]+)(?:\/|$)/)
  const apiRepo = parts ? { owner: parts[1], repo: parts[2] } : null
  if (endpoint === 'rate_limit' && method === 'GET') {
    out({ resources: { core: { limit: 5000, remaining: 4000, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
  } else if (endpoint === 'user' && method === 'GET') {
    out({ login: 'test-user' })
  } else if (endpoint === 'graphql' && method === 'POST') {
    const query = typeof inputFields.query === 'string' ? inputFields.query : ''
    const variables = isRecord(inputFields.variables) ? inputFields.variables : {}
    if (query.includes('viewerDefaultMergeMethod')) {
      if (variables.owner !== 'test-owner' || variables.name !== 'test-repo') fail('Merge metadata query did not name the stand-in repository')
      out({ data: { repository: {
        viewerDefaultMergeMethod: 'SQUASH',
        mergeCommitAllowed: true,
        rebaseMergeAllowed: true,
        squashMergeAllowed: true,
        autoMergeAllowed: true,
        defaultBranchRef: { name: state.defaultBranch ?? 'main' },
        mergeQueue: state.mergeQueueRequired === true ? { id: 'QUEUE_test' } : null,
        ref: { rules: { nodes: [] } },
      } } })
    } else if (query.includes('HostingChecksRollup')) {
      const item = byNumber(variables.number)
      if (!item || variables.owner !== 'test-owner' || variables.name !== 'test-repo') {
        out({ data: { repository: { pullRequest: null } } })
      } else {
        out({ data: { repository: { pullRequest: {
          headRefOid: item.headRefOid,
          commits: { nodes: [{ commit: {
            statusCheckRollup: { contexts: { nodes: state.checkRuns ?? [], pageInfo: { hasNextPage: false } } },
            checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
          } }] },
        } } } })
      }
    } else {
      fail('Unsupported GitHub GraphQL fixture query')
    }
  } else if (apiRepo && apiRepo.owner === 'test-owner' && apiRepo.repo === 'test-repo' && endpoint.includes('/pulls?') && method === 'GET') {
    const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
    const head = query.get('head') ?? ''
    const separator = head.indexOf(':')
    const headOwner = separator < 0 ? '' : head.slice(0, separator)
    const branch = separator < 0 ? head : head.slice(separator + 1)
    const stateFilter = query.get('state') ?? 'open'
    const matches = prs.filter((item) => {
      const owner = item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login ?? ''
      const itemState = item.state === 'MERGED' || item.state === 'CLOSED' ? 'closed' : 'open'
      return item.headRefName === branch && (!headOwner || owner.toLowerCase() === headOwner.toLowerCase()) &&
        belongsTo(item, apiRepo) && (stateFilter === 'all' || stateFilter === itemState)
    })
    out(matches.map(restPull))
  } else if (apiRepo && apiRepo.owner === 'test-owner' && apiRepo.repo === 'test-repo' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/update-branch$/.test(endpoint)) {
    const number = endpoint.match(/\/pulls\/(\d+)\/update-branch$/)?.[1]
    const item = byNumber(number)
    if (method !== 'PUT') fail('The update-branch endpoint requires PUT')
    if (!item || !belongsTo(item, apiRepo)) fail('HTTP 404: Not Found')
    if (item.state !== 'OPEN') fail('HTTP 422: pull request is not open')
    if (inputFields.expected_head_sha !== item.headRefOid) fail("HTTP 422: expected head sha didn't match current head ref")
    if (typeof state.updatedHead !== 'string' || !/^[0-9a-f]{40}$/.test(state.updatedHead)) fail('The fixture has no valid updated head')
    item.headRefOid = state.updatedHead
    item.mergeStateStatus = 'CLEAN'
    saveState(state)
    out({ message: 'Branch was successfully updated' })
  } else if (apiRepo && apiRepo.owner === 'test-owner' && apiRepo.repo === 'test-repo' && /^repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(endpoint)) {
    const item = prs.find((candidate) => belongsTo(candidate, apiRepo))
    if (method !== 'POST' || input.length !== 0) fail('Rerunning failed jobs requires an empty-body POST')
    if (!item || item.state !== 'OPEN') fail('HTTP 404: Not Found')
    const workflowId = Number(endpoint.match(/\/runs\/(\d+)\//)?.[1])
    let nextId = Math.max(...state.checkRuns.map((check) => check.databaseId)) + 1
    state.checkRuns = state.checkRuns.map((check) => {
      if (check.workflowRunId !== workflowId || check.status !== 'COMPLETED' ||
        !['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR', 'CANCELLED'].includes(check.conclusion)) return check
      const id = nextId++
      return {
        ...check, databaseId: id, status: 'QUEUED', conclusion: null,
        detailsUrl: check.detailsUrl.replace(/\/job\/\d+$/, '/job/' + id)
      }
    })
    saveState(state)
    out({})
  } else if (apiRepo && apiRepo.owner === 'test-owner' && apiRepo.repo === 'test-repo' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(endpoint) && method === 'GET') {
    const number = endpoint.match(/\/pulls\/(\d+)$/)?.[1]
    const item = byNumber(number)
    if (!item || !belongsTo(item, apiRepo)) fail('HTTP 404: Not Found')
    out(restPull(item))
  } else {
    fail('Unsupported GitHub invocation: ' + args.join(' '))
  }
} else {
  fail('Unsupported GitHub invocation: ' + args.join(' '))
}
`
