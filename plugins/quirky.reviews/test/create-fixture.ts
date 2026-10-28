export function reviewFixture(number: number, head: string, base = 'main'): Record<string, unknown> {
  return {
    number,
    id: `PR_test_${number}`,
    title: `Review ${number}`,
    body: 'Review body',
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/test-owner/test-repo/pull/${number}`,
    baseRefName: base,
    baseRefOid: 'b'.repeat(40),
    headRefName: head,
    headRefOid: 'a'.repeat(40),
    headRepositoryOwner: { login: 'test-owner' },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    baseRepositoryOwner: { login: 'test-owner' },
    baseRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [],
    autoMergeRequest: null,
    stack: null,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] }
  }
}

export function createReviewsState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultBranch: 'main',
    prs: [],
    createNumber: 14,
    createMode: 'url',
    stackRegistrationFails: false,
    ...overrides
  }
}

/** The daemon, hosting plugin and git plugin remain real; only the upstream `gh` executable is isolated. */
export const createReviewsGhSource = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const saveState = (state) => {
  const temp = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temp, JSON.stringify(state))
  renameSync(temp, statePath)
}
const args = process.argv.slice(2)
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const fields = input.length === 0 ? {} : JSON.parse(input)
const state = readState()
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message); process.exit(1) }
const option = (name, fallback = undefined) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1] }
const records = () => Array.isArray(state.prs) ? state.prs : []
const owner = 'test-owner'
const repo = 'test-repo'
const htmlUrl = (number) => 'https://github.com/' + owner + '/' + repo + '/pull/' + number
const restPull = (item) => ({
  number: item.number,
  id: item.id,
  html_url: htmlUrl(item.number),
  title: item.title,
  body: item.body,
  state: item.state === 'MERGED' || item.state === 'CLOSED' ? 'closed' : 'open',
  draft: item.isDraft === true,
  merged_at: item.state === 'MERGED' ? new Date(0).toISOString() : null,
  mergeable: true,
  mergeable_state: 'clean',
  base: { ref: item.baseRefName, sha: item.baseRefOid, repo: { name: repo, owner: { login: owner } } },
  head: { ref: item.headRefName, sha: item.headRefOid, repo: { name: repo, owner: { login: owner } }, user: { login: owner } },
  stack: item.stack ?? null
})
const command = args[0]
if (command === 'auth' && args[1] === 'status') {
  out('Logged in to github.com account test-user (keyring)\nToken scopes: repo\nActive account: true\n')
} else if (command === 'repo' && args[1] === 'view') {
  out({ nameWithOwner: owner + '/' + repo, isFork: false, parent: null, defaultBranchRef: { name: state.defaultBranch ?? 'main' } })
} else if (command === 'pr' && args[1] === 'list') {
  const head = option('--head', '')
  const base = option('--base', '')
  out(records().filter((item) => item.headRefName === head && (!base || item.baseRefName === base) && (item.state === 'OPEN' || item.state === 'DRAFT')))
} else if (command === 'pr' && args[1] === 'view') {
  const number = Number(args.find((value, index) => index > 1 && /^\d+$/.test(value)))
  const item = records().find((candidate) => candidate.number === number)
  if (!item) fail('HTTP 404: Not Found')
  out(item)
} else if (command === 'pr' && args[1] === 'create') {
  if (state.createMode === 'already_exists') {
    if (!records().some((item) => item.headRefName === 'feature' && item.baseRefName === option('--base', 'main'))) {
      const number = state.createNumber ?? Math.max(0, ...records().map((item) => item.number)) + 1
      state.prs = [...records(), { ...${JSON.stringify(reviewFixture(0, 'feature'))}, number, id: 'PR_test_' + number, title: option('--title', 'Existing pull request'), headRefName: option('--head', 'feature'), baseRefName: option('--base', 'main') }]
      saveState(state)
    }
    fail('A pull request already exists for this branch')
  }
  const number = state.createNumber ?? 14
  state.prs = [...records(), { ...${JSON.stringify(reviewFixture(0, 'feature'))}, number, id: 'PR_test_' + number, title: option('--title', 'New pull request'), body: option('--body', ''), isDraft: args.includes('--draft'), headRefName: option('--head', 'feature'), baseRefName: option('--base', 'main') }]
  saveState(state)
  out(htmlUrl(number) + '\n')
} else if (command === 'api') {
  if (args.includes('rate_limit')) {
    if (state.rateLimitFailure) fail(typeof state.rateLimitFailure === 'string' ? state.rateLimitFailure : 'fixture rate-limit unavailable')
    out({ resources: { core: { limit: 5000, remaining: 4200, reset: 1999999999 }, search: { limit: 30, remaining: 28, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4000, reset: 1999999999 } } })
  } else if (args.includes('graphql')) {
    out({ data: { repository: { id: 'REPO_test', defaultBranchRef: { name: 'main' }, viewerDefaultMergeMethod: 'SQUASH', squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, mergeQueue: null, ref: { rules: { nodes: [] } } } } })
  } else {
    const endpoint = args.find((value) => value.startsWith('repos/')) ?? ''
    const method = option('--method', option('-X', 'GET')).toUpperCase()
    const listMatch = endpoint.match(/^repos\/[^/]+\/[^/]+\/pulls\?(.*)$/)
    const itemMatch = endpoint.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/)
    if (listMatch) {
      const query = new URLSearchParams(listMatch[1])
      const head = (query.get('head') ?? '').split(':').at(-1)
      const base = query.get('base')
      out(records().filter((item) => item.headRefName === head && (!base || item.baseRefName === base)).map(restPull))
    } else if (itemMatch && method === 'GET') {
      const item = records().find((candidate) => candidate.number === Number(itemMatch[1]))
      if (!item) fail('HTTP 404: Not Found')
      out(restPull(item))
    } else if (endpoint.endsWith('/stacks') && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      const pullRequests = Array.isArray(fields.pull_requests) ? fields.pull_requests : []
      out({ number: pullRequests[0] })
    } else if (/\/stacks\/\d+\/add$/.test(endpoint) && method === 'POST') {
      if (state.stackRegistrationFails) fail('HTTP 404: stacked pull requests are not available')
      out({ number: Number(endpoint.match(/\/stacks\/(\d+)\/add$/)?.[1]) })
    } else {
      fail('unsupported isolated GitHub request: ' + endpoint)
    }
  }
} else {
  fail('unsupported isolated GitHub command: ' + args.join(' '))
}
`
