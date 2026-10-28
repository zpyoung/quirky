export type DetailFixtureOverrides = {
  responses?: Record<string, unknown>
  graphqlResponses?: Record<string, unknown>
  failures?: Record<string, string>
  transitions?: Record<string, unknown>
  [key: string]: unknown
}

const pullRequest = {
  number: 12,
  title: 'Fixture pull request',
  body: 'Fixture description',
  state: 'open',
  html_url: 'https://github.com/source-owner/source-repo/pull/12',
  url: 'https://api.github.com/repos/source-owner/source-repo/pulls/12',
  created_at: '2026-10-27T00:00:00Z',
  updated_at: '2026-10-27T00:00:00Z',
  user: { login: 'fixture-author', type: 'User' },
  head: { ref: 'feature', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'source-owner:feature' },
  base: { ref: 'main', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'source-owner:main' },
  headRefName: 'feature',
  baseRefName: 'main',
  headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  mergeable: true,
  mergeable_state: 'clean',
  mergeStateStatus: 'CLEAN',
  draft: false,
  requested_reviewers: [],
  assignees: [],
}

export function detailSeedState(overrides: DetailFixtureOverrides = {}): Record<string, unknown> {
  const responses = {
    'GET repos/source-owner/source-repo/pulls/12': pullRequest,
    'GET repos/source-owner/source-repo/issues/12/comments': [],
    'GET repos/source-owner/source-repo/pulls/12/reviews': [],
    'GET repos/source-owner/source-repo/pulls/12/files': [],
    'GET repos/source-owner/source-repo/rate_limit': {
      resources: {
        core: { limit: 5000, remaining: 5000, reset: 2000000000 },
        search: { limit: 30, remaining: 30, reset: 2000000000 },
        graphql: { limit: 5000, remaining: 5000, reset: 2000000000 },
      },
    },
    ...(overrides.responses ?? {}),
  }
  const graphqlResponses = {
    HostingPRMergeMetadata: {
      data: {
        repository: {
          viewerDefaultMergeMethod: 'SQUASH',
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
          autoMergeAllowed: true,
          defaultBranchRef: { name: 'main' },
          mergeQueue: null,
          ref: { rules: { nodes: [] } },
        },
      },
    },
    HostingComments: {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_fixture_12',
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
    HostingChecksRollup: {
      data: {
        repository: {
          pullRequest: {
            headRefOid: pullRequest.headRefOid,
            commits: { nodes: [] },
            statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        },
      },
    },
    HostingFileViews: {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_fixture_12',
            files: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
    WorkItemDetails: {
      data: {
        repository: {
          issue: null,
          pullRequest: {
            __typename: 'PullRequest',
            number: 12,
            title: pullRequest.title,
            body: pullRequest.body,
            state: 'OPEN',
            url: pullRequest.html_url,
            createdAt: pullRequest.created_at,
            updatedAt: pullRequest.updated_at,
            isDraft: false,
            author: { login: 'fixture-author' },
            participants: { nodes: [], pageInfo: { hasNextPage: false } },
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
    ...(overrides.graphqlResponses ?? {}),
  }
  return {
    ...overrides,
    counts: overrides.counts ?? {},
    responses,
    graphqlResponses,
    failures: overrides.failures ?? {},
    transitions: overrides.transitions ?? {},
  }
}

export const detailGhSource = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const stateFile = path.join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'state.json')
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
if (!state.counts) state.counts = {}
function persist() {
  const temp = stateFile + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(state))
  fs.renameSync(temp, stateFile)
}
function respond(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
}
async function take(key, value) {
  const index = Number(state.counts[key] || 0)
  state.counts[key] = index + 1
  persist()
  if (value && typeof value === 'object' && Array.isArray(value.__sequence)) {
    const sequence = value.__sequence
    const selected = sequence[Math.min(index, sequence.length - 1)]
    if (selected && typeof selected === 'object' && typeof selected.__delayMs === 'number') {
      const delay = selected.__delayMs
      const result = { ...selected }
      delete result.__delayMs
      await Bun.sleep(delay)
      return result
    }
    return selected
  }
  return value
}
function fail(key) {
  const message = state.failures && state.failures[key]
  if (!message) return false
  process.stderr.write(String(message))
  process.exitCode = 1
  return true
}
function applyTransition(key) {
  const transition = state.transitions && state.transitions[key]
  if (!transition || typeof transition !== 'object') return
  if (transition.responses && typeof transition.responses === 'object') Object.assign(state.responses || (state.responses = {}), transition.responses)
  if (transition.graphqlResponses && typeof transition.graphqlResponses === 'object') Object.assign(state.graphqlResponses || (state.graphqlResponses = {}), transition.graphqlResponses)
  persist()
}
async function main() {
  if (args[0] === 'auth' && args[1] === 'status') {
    respond(['Logged in to github.com account fixture-user (keyring)', 'Active account: true'].join(String.fromCharCode(10)) + String.fromCharCode(10))
    return
  }
  if (args[0] === 'auth' && args[1] === 'token') {
    respond('fixture-token')
    return
  }
  if (args[0] === 'repo' && args[1] === 'view') {
    respond({ nameWithOwner: 'source-owner/source-repo', url: 'https://github.com/source-owner/source-repo' })
    return
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const number = Number(args[2])
    const repoAt = args.findIndex((arg) => arg === '--repo' || arg === '-R')
    const repository = repoAt >= 0 ? String(args[repoAt + 1] || '').split('/').slice(-2).join('/') : 'source-owner/source-repo'
    const route = 'GET repos/' + repository + '/pulls/' + number
    const pull = state.pullRequest || (state.responses || {})[route] || (repository === 'source-owner/source-repo' && number === 12 ? ${JSON.stringify(pullRequest)} : null)
    if (!pull) { respond(null); return }
    const value = {
      ...pull,
      state: String(pull.state || 'open').toUpperCase(),
      url: pull.html_url || pull.url,
      author: pull.author || pull.user,
      isDraft: pull.isDraft === true || pull.draft === true,
      headRefName: pull.headRefName || pull.head?.ref,
      baseRefName: pull.baseRefName || pull.base?.ref,
      headRefOid: pull.headRefOid || pull.head?.sha,
      baseRefOid: pull.baseRefOid || pull.base?.sha,
    }
    const jsonAt = args.indexOf('--json')
    const fields = jsonAt >= 0 ? String(args[jsonAt + 1] || '').split(',') : Object.keys(value)
    respond(Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, value[field]])))
    return
  }
  if (args[0] === 'pr' && args[1] === 'checks') {
    respond(state.porcelainChecks || [])
    return
  }
  if (args[0] === 'api' && args.indexOf('graphql') > 0) {
    let input = {}
    try { input = JSON.parse(process.env.QUIRKY_TEST_GH_INPUT || '{}') } catch {}
    let query = typeof input.query === 'string' ? input.query : ''
    if (!query) {
      const queryArg = args.find((arg) => arg.startsWith('query='))
      if (queryArg) query = queryArg.slice('query='.length)
    }
    const operation = (query.match(/(?:query|mutation) +([A-Za-z_][A-Za-z0-9_]*)/) || [])[1] || 'anonymous'
    const key = 'graphql ' + operation
    const mutation = query.startsWith('mutation ')
    const variables = input.variables || {}
    const repository = String(variables.owner || '') + '/' + String(variables.repo || variables.name || '')
    const table = { ...(state.graphqlResponses || {}), ...((state.graphqlResponsesByRepo || {})[repository] || {}) }
    const configured = Object.prototype.hasOwnProperty.call(table, operation)
    if (!fail(key)) {
      if (mutation && !configured) {
        process.stderr.write('Unexpected fixture GraphQL mutation: ' + operation + String.fromCharCode(10))
        process.exitCode = 1
      } else {
        const result = configured ? await take(key, table[operation]) : { data: { repository: { pullRequest: null }, node: null } }
        respond(result)
        if (mutation) applyTransition('GRAPHQL ' + operation)
      }
    }
    return
  }
  if (args[0] === 'api') {
    const route = args.find((arg) => arg.startsWith('repos/') || arg === 'rate_limit' || arg === 'user') || ''
    const verbIndex = args.findIndex((arg) => arg === '-X' || arg === '--method')
    const method = verbIndex >= 0 ? String(args[verbIndex + 1] || 'GET').toUpperCase() : 'GET'
    const key = method + ' ' + route
    const routeKey = method + ' ' + route.split('?')[0]
    const responses = state.responses || {}
    const hasExact = Object.prototype.hasOwnProperty.call(responses, key)
    const hasRoute = Object.prototype.hasOwnProperty.call(responses, routeKey)
    if (!fail(key) && !fail(routeKey)) {
      if (hasExact || hasRoute) {
        const result = await take(hasExact ? key : routeKey, responses[hasExact ? key : routeKey])
        respond(result)
        if (method !== 'GET') applyTransition(key)
      } else if (method !== 'GET') {
        process.stderr.write('Unexpected fixture write: ' + key + String.fromCharCode(10))
        process.exitCode = 1
      } else if (route.endsWith('/rate_limit') || route === 'rate_limit') {
        respond({ resources: { core: { limit: 5000, remaining: 5000, reset: 2000000000 }, search: { limit: 30, remaining: 30, reset: 2000000000 }, graphql: { limit: 5000, remaining: 5000, reset: 2000000000 } } })
      } else if (route.includes('/pulls/12')) {
        respond(state.pullRequest || ${JSON.stringify(pullRequest)})
      } else {
        respond(null)
      }
    }
    return
  }
  respond(null)
}
await main()
`
