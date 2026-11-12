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

export type TasksFixture = {
  owner: string
  repo: string
  originUrl: string
  issue: FixtureItem
  pullRequest: FixtureItem
  sshCommand: string
}

const GH_WRAPPER_SOURCE = String.raw`
const args = process.argv.slice(2)
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
const source = process.env.QUIRKY_TEST_GH_SOURCE
if (typeof source !== 'string' || source.length === 0) throw new Error('missing isolated fixture source')
// The list-fixture module is materialized in the isolated home, so this executable cannot import it statically.
await import(source)
`

const SSH_DENY_SOURCE = String.raw`
process.stderr.write('GitHub transport is disabled for the UI review fixture\n')
process.exit(1)
`

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
  writeFileSync(ghPath, `#!${process.execPath}\n${GH_WRAPPER_SOURCE}\n`, { mode: 0o700 })
  writeFileSync(sshPath, `#!${process.execPath}\n${SSH_DENY_SOURCE}\n`, { mode: 0o700 })
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
