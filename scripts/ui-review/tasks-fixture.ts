import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  fixtureIssue,
  fixturePullRequest,
  listFixtureSource,
  seedListFixture,
  type FixtureItem
} from '../../plugins/quirky.tasks/test/fixtures/list'

export const TASKS_FIXTURE_OWNER = 'fixture-owner'
export const TASKS_FIXTURE_TOKEN = 'ui-review-capture-fixture-token'
export const CHECKS_FIXTURE_BRANCH = 'ui-review-notes'

export type TasksFixture = {
  owner: string
  repo: string
  originUrl: string
  issue: FixtureItem
  pullRequest: FixtureItem
  sshCommand: string
}

function ghWrapperSource(repo: string, repoPath: string): string {
  return String.raw`
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const inputIndex = args.indexOf('--input')
const inputText = inputIndex >= 0 && args[inputIndex + 1] === '-' ? readFileSync(0, 'utf8') : ''
const request = inputText ? JSON.parse(inputText) : null
const apiArgs = []
if (args[0] === 'api') {
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--hostname') {
      index++
      continue
    }
    if (args[index].startsWith('--hostname=')) continue
    apiArgs.push(args[index])
  }
}
const apiEndpoint = apiArgs.find((argument) => argument === 'rate_limit' || argument === 'graphql' || argument.startsWith('repos/'))
const fixtureOwner = ${JSON.stringify(TASKS_FIXTURE_OWNER)}
const fixtureRepo = ${JSON.stringify(repo)}
const checksBranch = ${JSON.stringify(CHECKS_FIXTURE_BRANCH)}
const checksNumber = 33
const fixtureRepoPath = ${JSON.stringify(repoPath)}
const readChecksRef = (ref) => {
  const result = Bun.spawnSync(['git', '-C', fixtureRepoPath, 'rev-parse', '--verify', ref], { stdin: 'ignore' })
  if (result.exitCode !== 0) throw new Error('missing local Reviews fixture ref ' + ref)
  return result.stdout.toString().trim()
}
const checksHeadSha = () => readChecksRef('refs/heads/' + checksBranch)
const checksBaseSha = () => readChecksRef('refs/remotes/origin/main')
const checkRows = [
  { name: 'CI / unit', state: 'SUCCESS', link: 'https://github.com/' + fixtureOwner + '/' + fixtureRepo + '/actions/runs/33' },
  { name: 'CI / lint', state: 'FAILURE', link: 'https://github.com/' + fixtureOwner + '/' + fixtureRepo + '/actions/runs/34' }
]
const statusCheckRollup = checkRows.map((check) => ({
  name: check.name, context: check.name, status: 'COMPLETED', conclusion: check.state, detailsUrl: check.link
}))
const graphChecks = checkRows.map((check, index) => ({
  __typename: 'CheckRun', databaseId: 3300 + index, name: check.name, status: 'COMPLETED',
  conclusion: check.state, detailsUrl: check.link
}))
const pullView = () => ({
  number: checksNumber,
  title: 'Review the UI fixture changes',
  body: 'A local fixture pull request with mixed checks.',
  state: 'OPEN',
  url: 'https://github.com/' + fixtureOwner + '/' + fixtureRepo + '/pull/' + checksNumber,
  isDraft: false,
  updatedAt: '2026-11-10T12:00:00Z',
  baseRefName: 'main',
  baseRefOid: checksBaseSha(),
  headRefName: checksBranch,
  headRefOid: checksHeadSha(),
  headRepositoryOwner: { login: fixtureOwner },
  headRepository: { name: fixtureRepo, owner: { login: fixtureOwner } },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  autoMergeRequest: null,
  statusCheckRollup,
  additions: 8,
  deletions: 2,
  changedFiles: 2,
  reviewRequests: [],
  reviews: [],
  assignees: []
})
const pullRest = () => ({
  number: checksNumber,
  state: 'open',
  title: 'Review the UI fixture changes',
  body: 'A local fixture pull request with mixed checks.',
  html_url: 'https://github.com/' + fixtureOwner + '/' + fixtureRepo + '/pull/' + checksNumber,
  updated_at: '2026-11-10T12:00:00Z',
  head: { ref: checksBranch, sha: checksHeadSha(), repo: { name: fixtureRepo, owner: { login: fixtureOwner } } },
  base: { ref: 'main', sha: checksBaseSha(), repo: { name: fixtureRepo, owner: { login: fixtureOwner } } }
})
const answer = (value) => {
  console.log(JSON.stringify(value))
  process.exit(0)
}
if (args[0] === '--version') {
  process.stdout.write('gh version 2.80.0 (fixture)\n')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write(args.includes('--help')
    ? 'gh auth token [--hostname HOST] [--user USER]\n'
    : ${JSON.stringify(TASKS_FIXTURE_TOKEN)})
  process.exit(0)
}
if (apiEndpoint === 'rate_limit') {
  answer({ resources: {
    core: { limit: 5000, remaining: 4200, reset: 1999999999 },
    search: { limit: 30, remaining: 28, reset: 1999999999 },
    graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }
  } })
}
if (typeof apiEndpoint === 'string' && apiEndpoint.startsWith('repos/' + fixtureOwner + '/' + fixtureRepo + '/pulls?')) {
  const pullListUrl = new URL('https://api.github.com/' + apiEndpoint)
  const head = pullListUrl.searchParams.get('head')
  if (head === fixtureOwner + ':ui-review-ready' || head === fixtureOwner + ':main') answer([])
  if (head === fixtureOwner + ':' + checksBranch) {
    answer([{
      number: checksNumber,
      state: 'open',
      head: { ref: checksBranch, sha: checksHeadSha(), repo: { name: fixtureRepo, owner: { login: fixtureOwner } } },
      base: { ref: 'main', sha: checksBaseSha(), repo: { name: fixtureRepo, owner: { login: fixtureOwner } } }
    }])
  }
  if (head === fixtureOwner + ':feature/capture-fixture-tasks') {
    answer([{
      number: 32,
      state: 'open',
      head: {
        ref: 'feature/capture-fixture-tasks',
        repo: { name: fixtureRepo, owner: { login: fixtureOwner } }
      }
    }])
  }
}
if (apiEndpoint === 'repos/' + fixtureOwner + '/' + fixtureRepo + '/pulls/' + checksNumber) answer(pullRest())
if (apiEndpoint === 'graphql' && typeof request?.query === 'string' &&
  request.query.includes('HostingChecksRollup') && Number(request.variables?.number) === checksNumber) {
  answer({ data: { repository: { pullRequest: {
    headRefOid: checksHeadSha(),
    commits: { nodes: [{ commit: {
      statusCheckRollup: { contexts: { nodes: graphChecks, pageInfo: { hasNextPage: false } } },
      checkSuites: { nodes: [], pageInfo: { hasNextPage: false } }
    } }] }
  } } } })
}
if (args[0] === 'pr' && args[1] === 'view' && Number(args[2]) === checksNumber) answer(pullView())
if (args[0] === 'pr' && args[1] === 'checks' && Number(args[2]) === checksNumber) answer(checkRows)
if (args[0] === 'repo' && args[1] === 'view') {
  answer({ defaultBranchRef: { name: 'main' } })
}
if (inputText) process.env.QUIRKY_TEST_GH_INPUT = inputText
const source = process.env.QUIRKY_TEST_GH_SOURCE
if (typeof source !== 'string' || source.length === 0) throw new Error('missing isolated fixture source')
// The list-fixture module is materialized in the isolated home, so this executable cannot import it statically.
await import(source)
`
}

function sshFixtureSource(repo: string, origin: string): string {
  return String.raw`
const args = process.argv.slice(2)
const service = new Map([
  [${JSON.stringify(`git-upload-pack '${TASKS_FIXTURE_OWNER}/${repo}.git'`)}, 'upload-pack'],
  [${JSON.stringify(`git-receive-pack '${TASKS_FIXTURE_OWNER}/${repo}.git'`)}, 'receive-pack']
]).get(args.at(-1))
if (args.at(-2) !== 'git@github.com' || !service) {
  process.stderr.write('GitHub transport is disabled outside the local UI review fixture\n')
  process.exit(1)
}
const child = Bun.spawn(['git', service, ${JSON.stringify(origin)}], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
})
process.exit(await child.exited)
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Installs an isolated gh executable and deterministic Tasks rows under the disposable capture home. */
export function prepareTasksFixture(home: string, repo: string, env: Record<string, string>): TasksFixture {
  const fixtureDir = join(home, 'tasks-fixture')
  const fakebin = join(home, 'fakebin')
  const sourcePath = join(fixtureDir, 'list-fixture.mjs')
  const ghPath = join(fakebin, 'gh')
  const sshPath = join(fakebin, 'ssh-deny')
  mkdirSync(fixtureDir, { recursive: true, mode: 0o700 })
  mkdirSync(fakebin, { recursive: true, mode: 0o700 })

  const issue = fixtureIssue(TASKS_FIXTURE_OWNER, repo, 31, '2026-11-01T12:00:00Z')
  issue.title = 'Review the capture fixture issue'
  issue.labels = ['bug', 'needs review']
  const pullRequest = fixturePullRequest(TASKS_FIXTURE_OWNER, repo, 32, '2026-11-02T12:00:00Z', [
    { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', url: `https://github.com/${TASKS_FIXTURE_OWNER}/${repo}/actions/runs/32` }
  ])
  pullRequest.title = 'Add capture fixture Tasks data'
  pullRequest.headRefName = 'feature/capture-fixture-tasks'
  pullRequest.reviewDecision = 'REVIEW_REQUIRED'
  pullRequest.requestedReviewers = ['reviewer-one']
  pullRequest.reviews = [{ author: 'reviewer-two', state: 'APPROVED' }]
  pullRequest.additions = 84
  pullRequest.deletions = 12
  pullRequest.changedFiles = 5

  const state = seedListFixture({ [`${TASKS_FIXTURE_OWNER}/${repo}`]: [issue, pullRequest] }, { auth: true })
  writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state), { mode: 0o600 })
  writeFileSync(sourcePath, listFixtureSource, { mode: 0o600 })
  writeFileSync(ghPath, `#!${process.execPath}\n${ghWrapperSource(repo, join(home, 'projects', repo))}\n`, { mode: 0o700 })
  writeFileSync(sshPath, `#!${process.execPath}\n${sshFixtureSource(repo, join(home, 'origin.git'))}\n`, { mode: 0o700 })
  chmodSync(ghPath, 0o700)
  chmodSync(sshPath, 0o700)

  env.PATH = `${fakebin}${delimiter}${env.PATH}`
  env.QUIRKY_TEST_FIXTURE_DIR = fixtureDir
  env.QUIRKY_TEST_GH_SOURCE = sourcePath

  return {
    owner: TASKS_FIXTURE_OWNER,
    repo,
    originUrl: `git@github.com:${TASKS_FIXTURE_OWNER}/${repo}.git`,
    issue,
    pullRequest,
    sshCommand: shellQuote(sshPath)
  }
}
