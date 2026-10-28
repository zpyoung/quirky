export const checksReview = (number = 12, headRefName = 'feature') => ({
  number,
  id: `PR_test_${number}`,
  title: `Review ${number}`,
  body: 'Review body',
  state: 'OPEN',
  url: `https://github.com/test-owner/test-repo/pull/${number}`,
  isDraft: false,
  updatedAt: '2026-10-27T00:00:00Z',
  baseRefName: 'main',
  baseRefOid: 'b'.repeat(40),
  headRefName,
  headRefOid: 'a'.repeat(40),
  headRepositoryOwner: { login: 'test-owner' },
  headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
  baseRepositoryOwner: { login: 'test-owner' },
  baseRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ __typename: 'CheckRun', databaseId: 31, name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/test-owner/test-repo/actions/runs/41', checkRunId: 31, workflowRunId: 41 }],
  autoMergeRequest: null,
  stack: null,
  mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] }
})

export function checksFixtureState(prs: unknown[] = [], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prs, authenticated: true, defaultBranch: 'main', threads: [], resolvedThreads: [], ...overrides }
}

// The daemon, public hosting policy, repository resolution, and git remain real; only gh is local and stateful.
export const checksGhSource = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const request = input ? JSON.parse(input) : {}
const vars = request.variables && typeof request.variables === 'object' ? request.variables : {}
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = message => { process.stderr.write(message); process.exit(1) }
const save = () => { const tmp = statePath + '.' + process.pid + '.tmp'; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, statePath) }
const prs = Array.isArray(state.prs) ? state.prs : []
const pr = number => prs.find(item => item.number === Number(number))
const operation = typeof request.query === 'string' ? (request.query.match(/(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/) ?? [])[1] : ''
const restPull = item => ({ number: item.number, id: item.number, html_url: item.url, title: item.title, body: item.body, state: item.state === 'MERGED' ? 'closed' : item.state.toLowerCase(), draft: item.isDraft === true, merged_at: item.state === 'MERGED' ? new Date(0).toISOString() : null, mergeable: item.mergeable === 'MERGEABLE' ? true : item.mergeable === 'CONFLICTING' ? false : null, mergeable_state: String(item.mergeStateStatus ?? 'UNKNOWN').toLowerCase(), base: { ref: item.baseRefName, sha: item.baseRefOid, repo: { name: 'test-repo', owner: { login: 'test-owner' } } }, head: { ref: item.headRefName, sha: item.headRefOid, repo: { name: 'test-repo', owner: { login: 'test-owner' } } } })
if (args[0] === 'auth' && args[1] === 'status') {
  if (state.authenticated === false) fail('You are not logged into any GitHub hosts. Run gh auth login.')
  output('Logged in to github.com account fixture-user (keyring)\n')
} else if (args[0] === 'auth' && args[1] === 'token') {
  output('fixture-token\n')
} else if (args[0] === 'pr' && args[1] === 'view') {
  const item = pr(args[2])
  if (!item) fail('HTTP 404: Not Found')
  if (Number(state.delayPullNumber) === Number(args[2]) && Number(state.delayMs) > 0) {
    await new Promise(resolve => setTimeout(resolve, Number(state.delayMs)))
  }
  output(item)
} else if (args[0] === 'api' && args.includes('graphql')) {
  if (state.failures?.[operation]) fail(String(state.failures[operation]))
  if (operation === 'HostingPRMergeMetadata') {
    output({ data: { repository: { viewerDefaultMergeMethod: 'SQUASH', squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, defaultBranchRef: { name: 'main' }, mergeQueue: null, ref: { rules: { nodes: [] } } } } })
  } else if (operation === 'HostingChecksRollup') {
    const item = pr(vars.number)
    output({ data: { repository: { pullRequest: item ? { headRefOid: item.headRefOid, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: item.statusCheckRollup ?? [], pageInfo: { hasNextPage: false } } }, checkSuites: { nodes: [], pageInfo: { hasNextPage: false } } } }] } } : null } } })
  } else if (operation === 'HostingComments') {
    const threads = (state.threads ?? []).map(thread => ({ id: thread.id, isResolved: state.resolvedThreads?.includes(thread.id) === true, path: 'src/main.ts', line: 8, originalLine: 8, startLine: null, originalStartLine: null, comments: { nodes: [{ id: `PRRT_comment_${thread.id}`, databaseId: thread.commentId, body: thread.body, createdAt: '2026-10-27T00:00:00Z', url: `https://github.com/test-owner/test-repo/pull/12#discussion_${thread.id}`, path: 'src/main.ts', line: 8, originalLine: 8, startLine: null, originalStartLine: null, author: { login: 'reviewer' }, reactionGroups: [] }], pageInfo: { hasNextPage: false } } }))
    output({ data: { repository: { pullRequest: { comments: { nodes: [], pageInfo: { hasNextPage: false } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false } } } } } })
  } else if (typeof request.query === 'string' && request.query.includes('resolveReviewThread')) {
    state.resolvedThreads = [...(state.resolvedThreads ?? []), vars.threadId]
    save()
    output({ data: { resolveReviewThread: { thread: { id: vars.threadId, isResolved: true } } } })
  } else {
    output({ data: { repository: { pullRequest: null }, node: null } })
  }
} else if (args[0] === 'api') {
  const endpoint = args.find(value => value.startsWith('repos/')) ?? ''
  if (endpoint === 'rate_limit' || endpoint.endsWith('/rate_limit')) {
    output({ resources: { core: { limit: 5000, remaining: 4500, reset: 2000000000 }, search: { limit: 30, remaining: 30, reset: 2000000000 }, graphql: { limit: 5000, remaining: 4500, reset: 2000000000 } } })
  } else if (/\/pulls\?/.test(endpoint)) {
    const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
    const head = query.get('head') ?? ''
    const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head
    output(prs.filter(item => item.headRefName === branch && (query.get('state') === 'all' || item.state === 'OPEN')).map(restPull))
  } else if (/\/pulls\/\d+$/.test(endpoint)) {
    const item = pr(endpoint.match(/\/pulls\/(\d+)/)?.[1])
    if (!item) fail('HTTP 404: Not Found')
    output(restPull(item))
  } else if (/\/(issues|pulls)\/\d+\/(comments|reviews)(?:\?|$)/.test(endpoint)) {
    output([])
  } else {
    output(null)
  }
} else {
  output(null)
}
`
