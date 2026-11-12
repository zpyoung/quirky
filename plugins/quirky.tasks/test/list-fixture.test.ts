import { afterEach, expect, test } from 'bun:test'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { fixtureIssue, fixturePullRequest, listFixtureSource, seedListFixture, type FixtureItem, type ListFixtureState } from './fixtures/list'

const fixtureDirectories: string[] = []
afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type FixtureFiles = { directory: string; sourcePath: string; statePath: string; initialText: string }
function writeStateText(state: ListFixtureState): string {
  return JSON.stringify(state, null, 2) + '\n'
}
function makeFixture(state: ListFixtureState): FixtureFiles {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-list-fixture-'))
  fixtureDirectories.push(directory)
  const sourcePath = join(directory, 'list-fixture.mjs')
  const statePath = join(directory, 'state.json')
  const initialText = writeStateText(state)
  writeFileSync(sourcePath, listFixtureSource)
  writeFileSync(statePath, initialText)
  return { directory, sourcePath, statePath, initialText }
}
function runFixture(directory: string, args: string[], inputText = ''): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(directory, 'list-fixture.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      QUIRKY_TEST_FIXTURE_DIR: directory,
      QUIRKY_TEST_GH_INPUT: inputText
    }
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}
function graphQLRequest(query: string, variables: Record<string, unknown>): string {
  return JSON.stringify({ query, variables })
}
function searchRequest(first: number): string {
  return graphQLRequest('query Search { search }', {
    search: 'repo:test-owner/test-repo is:issue is:open',
    first
  })
}
function fixtureSeed(): ListFixtureState {
  return seedListFixture({
    'test-owner/test-repo': [
      fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z'),
      fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
    ]
  })
}

const readOnlyCommands = [
  { name: 'auth status', args: ['auth', 'status'] },
  { name: 'pr list', args: ['pr', 'list', '--repo', 'test-owner/test-repo', '--limit', '30'] },
  { name: 'pr view', args: ['pr', 'view', '12', '--repo', 'test-owner/test-repo'] },
  {
    name: 'a GraphQL search',
    args: ['api', 'graphql', '--input', '-'],
    request: searchRequest(20)
  },
  {
    name: 'a GraphQL count',
    args: ['api', 'graphql', '--input', '-'],
    request: searchRequest(1)
  },
  {
    name: 'merge metadata',
    args: ['api', 'graphql', '--input', '-'],
    request: graphQLRequest('query HostingPRMergeMetadata { repository }', { owner: 'test-owner', name: 'test-repo' })
  },
  {
    name: 'work item details',
    args: ['api', 'graphql', '--input', '-'],
    request: graphQLRequest('query WorkItemDetails { repository }', { owner: 'test-owner', repo: 'test-repo', number: 12 })
  },
  { name: 'a REST issue read', args: ['api', 'repos/test-owner/test-repo/issues/7'] },
  { name: 'a REST pull read', args: ['api', 'repos/test-owner/test-repo/pulls/12'] },
  { name: 'a REST label read', args: ['api', 'repos/test-owner/test-repo/labels'] },
  {
    name: 'a REST search',
    args: ['api', `search/issues?q=${encodeURIComponent('repo:test-owner/test-repo is:issue')}&per_page=30&page=1`]
  }
]

for (const scenario of readOnlyCommands) {
  test(`${scenario.name} leaves state.json untouched`, () => {
    const files = makeFixture(fixtureSeed())
    const result = runFixture(files.directory, scenario.args, scenario.request ?? '')
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(files.statePath, 'utf8')).toBe(files.initialText)
  })
}

const failedCommands: { name: string; args: string[]; options?: Omit<ListFixtureState, 'items'>; stderr: string }[] = [
  { name: 'an unsupported command', args: ['frobnicate'], stderr: 'unsupported fixture command: frobnicate' },
  { name: 'a missing issue', args: ['issue', 'close', '99', '--repo', 'test-owner/test-repo'], stderr: 'issue not found' },
  {
    name: 'a refused issue edit',
    args: ['issue', 'edit', '7', '--repo', 'test-owner/test-repo', '--add-label', 'later'],
    options: { failIssueUpdate: true },
    stderr: 'fixture issue update failure'
  },
  {
    name: 'a refused reviewer edit',
    args: ['pr', 'edit', '12', '--repo', 'test-owner/test-repo', '--add-reviewer', 'sam'],
    options: { failPRReviewerEdit: true },
    stderr: 'fixture reviewer update failure'
  },
  {
    name: 'a merge on a stale head',
    args: ['pr', 'merge', '12', '--repo', 'test-owner/test-repo', '--match-head-commit', 'c'.repeat(40)],
    stderr: 'The pull request head changed'
  },
  {
    name: 'a failing list',
    args: ['pr', 'list', '--repo', 'test-owner/test-repo'],
    options: { failList: 'test-owner/test-repo' },
    stderr: 'fixture list failure'
  }
]

for (const scenario of failedCommands) {
  test(`${scenario.name} fails and leaves state.json untouched`, () => {
    const base = fixtureSeed()
    const files = makeFixture(seedListFixture(base.items, scenario.options))
    const result = runFixture(files.directory, scenario.args)
    expect(result).toEqual({ code: 1, stdout: '', stderr: scenario.stderr })
    expect(readFileSync(files.statePath, 'utf8')).toBe(files.initialText)
  })
}

test('issue close and pull merge write only the item changes', () => {
  const issue = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
  const options = { mergeQueueRequired: false }
  const files = makeFixture(seedListFixture({ 'test-owner/test-repo': [issue, pull] }, options))

  const close = runFixture(files.directory, ['issue', 'close', '7', '--repo', 'test-owner/test-repo', '--reason', 'completed'])
  expect(close).toEqual({ code: 0, stdout: '', stderr: '' })
  const closedIssue = { ...issue, state: 'closed' as const, stateReason: 'completed' }
  const afterClose = seedListFixture({ 'test-owner/test-repo': [closedIssue, pull] }, options)
  expect(JSON.parse(readFileSync(files.statePath, 'utf8'))).toEqual(afterClose)

  const merge = runFixture(files.directory, ['pr', 'merge', '12', '--repo', 'test-owner/test-repo', '--squash', '--match-head-commit', 'a'.repeat(40)])
  expect(merge).toEqual({ code: 0, stdout: '', stderr: '' })
  const mergedPull = { ...pull, state: 'merged' as const }
  expect(JSON.parse(readFileSync(files.statePath, 'utf8'))).toEqual(seedListFixture({ 'test-owner/test-repo': [closedIssue, mergedPull] }, options))
})

test('enabling auto-merge stores the request', () => {
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
  const files = makeFixture(seedListFixture({ 'test-owner/test-repo': [pull] }))
  const result = runFixture(
    files.directory,
    ['api', 'graphql', '--input', '-'],
    graphQLRequest('mutation EnableHostingPullRequestAutoMerge { enablePullRequestAutoMerge }', { pullRequestId: 'PR_test-owner_test-repo_12' })
  )
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(readFileSync(files.statePath, 'utf8'))).toEqual(seedListFixture({
    'test-owner/test-repo': [{ ...pull, autoMergeRequest: { enabledAt: '2026-10-01T00:00:00Z' } }]
  }))
})

function lagSearchFixture(): { state: ListFixtureState; openIssue: FixtureItem } {
  const closedIssue = { ...fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z'), state: 'closed' as const }
  const openIssue = { ...closedIssue, state: 'open' as const }
  return {
    state: seedListFixture({ 'test-owner/test-repo': [closedIssue] }, {
      lagSearch: { repository: 'test-owner/test-repo', remaining: 1, items: [openIssue] }
    }),
    openIssue
  }
}

for (const mode of ['GraphQL', 'REST'] as const) {
  test(`${mode} lagging search is served once and counted down, without using it for count reads`, () => {
    const { state, openIssue } = lagSearchFixture()
    const files = makeFixture(state)
    const invoke = (size: number) => mode === 'GraphQL'
      ? runFixture(files.directory, ['api', 'graphql', '--input', '-'], searchRequest(size))
      : runFixture(files.directory, ['api', `search/issues?q=${encodeURIComponent('repo:test-owner/test-repo is:issue is:open')}&per_page=${size}&page=1`])
    const searchRows = (stdout: string): { count: number; numbers: number[] } => {
      const response = JSON.parse(stdout) as Record<string, unknown>
      if (mode === 'GraphQL') {
        const data = response.data as Record<string, unknown>
        const search = data.search as { issueCount: number; nodes: { number: number }[] }
        return { count: search.issueCount, numbers: search.nodes.map((node) => node.number) }
      }
      const rest = response as { total_count: number; items: { number: number }[] }
      return { count: rest.total_count, numbers: rest.items.map((item) => item.number) }
    }

    const countRead = invoke(1)
    expect(countRead.code).toBe(0)
    expect(countRead.stderr).toBe('')
    expect(searchRows(countRead.stdout)).toEqual({ count: 0, numbers: [] })
    expect(readFileSync(files.statePath, 'utf8')).toBe(files.initialText)

    const laggedRead = invoke(20)
    expect(laggedRead.code).toBe(0)
    expect(laggedRead.stderr).toBe('')
    expect(searchRows(laggedRead.stdout)).toEqual({ count: 1, numbers: [7] })
    const countedDown = seedListFixture(state.items, {
      lagSearch: { repository: 'test-owner/test-repo', remaining: 0, items: [openIssue] }
    })
    expect(JSON.parse(readFileSync(files.statePath, 'utf8'))).toEqual(countedDown)
    const afterCountDown = readFileSync(files.statePath, 'utf8')

    const currentRead = invoke(20)
    expect(currentRead.code).toBe(0)
    expect(currentRead.stderr).toBe('')
    expect(searchRows(currentRead.stdout)).toEqual({ count: 0, numbers: [] })
    expect(readFileSync(files.statePath, 'utf8')).toBe(afterCountDown)
  })
}

test('a read waiting for its request serves the state written meanwhile without restoring old state', async () => {
  const beforeIssue = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  beforeIssue.title = 'Title before the test wrote'
  const files = makeFixture(seedListFixture({ 'test-owner/test-repo': [beforeIssue] }))
  const child = spawn(process.execPath, [files.sourcePath, 'api', 'graphql', '--input', '-'], {
    env: { PATH: process.env.PATH ?? '', QUIRKY_TEST_FIXTURE_DIR: files.directory },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const resultPromise = once(child, 'close')

  // Give the old fixture time to read state before stdin; fake timers cannot synchronize an external process.
  await sleep(300)
  const afterIssue = { ...beforeIssue, title: 'Title after the test wrote' }
  const afterState = seedListFixture({ 'test-owner/test-repo': [afterIssue] })
  const afterText = writeStateText(afterState)
  writeFileSync(files.statePath, afterText)
  child.stdin.end(searchRequest(20))

  const [code] = await resultPromise
  const result = { code: code ?? -1, stdout, stderr }
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  const response = JSON.parse(result.stdout) as { data: { search: { nodes: { title: string }[] } } }
  expect(response.data.search.nodes.map((node) => node.title)).toEqual(['Title after the test wrote'])
  expect(readFileSync(files.statePath, 'utf8')).toBe(afterText)
})
