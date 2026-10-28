import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

const ghSource = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof root !== 'string') throw new Error('missing fixture root')
const statePath = join(root, 'state.json')
const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
const state = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}
const args = process.argv.slice(2)
const command = args.join(' ')
const endpoint = args.find((value) => value.startsWith('search/issues?')) ?? ''
const methodIndex = args.findIndex((value) => value === '--method' || value === '-X')
const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
const calls = Array.isArray(state.calls) ? state.calls : (state.calls = [])
const save = () => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, statePath)
}
const emit = (value) => {
  save()
  process.stdout.write(JSON.stringify(value))
  process.exit(0)
}
calls.push({ args, command, endpoint, method })
save()

if (args.includes('auth') && args.includes('status')) {
  process.stdout.write('Logged in to github.com account page-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
  process.exit(0)
}
if (endpoint.length > 0 && method === 'GET') {
  const parsed = new URL('https://api.github.com/' + endpoint)
  const page = parsed.searchParams.get('page') ?? '1'
  const itemsByPage = state.itemsByPage && typeof state.itemsByPage === 'object' && !Array.isArray(state.itemsByPage) ? state.itemsByPage : {}
  const items = Array.isArray(itemsByPage[page]) ? itemsByPage[page] : []
  emit({
    total_count: state.totalCount ?? items.length,
    incomplete_results: state.incompleteResults === true,
    items
  })
}
emit({})
`

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as RecordValue
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function searchCalls(host: HostingTest): RecordValue[] {
  return host.invocations().flatMap((invocation) => {
    const endpoint = invocation.args.find((argument) => argument.startsWith('search/issues?'))
    return endpoint ? [{ endpoint, args: invocation.args }] : []
  })
}
function issueItem(number: number) {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    state: 'open',
    html_url: `https://github.com/test-owner/test-repo/issues/${number}`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    user: { login: 'page-fixture' },
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'alice' }]
  }
}
function pullRequestItem(number: number) {
  return {
    ...issueItem(number),
    html_url: `https://github.com/test-owner/test-repo/pull/${number}`,
    pull_request: { url: `https://api.github.com/repos/test-owner/test-repo/pulls/${number}` },
    additions: 3,
    deletions: 1,
    changed_files: 2
  }
}

test('workItemPage requests only the numbered issue page and preserves incomplete search results', async () => {
  const host = await bootHosting(ghSource)
  hosts.push(host)
  host.writeState({
    totalCount: 120,
    incompleteResults: true,
    itemsByPage: { '10': [issueItem(91), issueItem(92)] }
  })

  const page = object(await host.call('workItemPage', {
    kind: 'issue',
    page: 10,
    limit: 5,
    query: 'repo:test-owner/test-repo free words'
  }))
  expect(page).toMatchObject({ page: 10, limit: 5, totalCount: 120, hasNextPage: true, truncated: true, partial: true })
  expect(array(page.items).map((value) => object(value).number)).toEqual([91, 92])
  expect(object(page.sources).issues).toBe('origin')

  const calls = searchCalls(host)
  expect(calls).toHaveLength(1)
  const endpoint = new URL(`https://api.github.com/${String(calls[0]?.endpoint)}`)
  expect(endpoint.searchParams.get('page')).toBe('10')
  expect(endpoint.searchParams.get('per_page')).toBe('5')
  expect(endpoint.searchParams.get('q')).toBe('repo:test-owner/test-repo is:issue free words sort:updated-desc')
}, 30_000)

test('workItemPage applies the PR qualifier and one direct requested REST page', async () => {
  const host = await bootHosting(ghSource)
  hosts.push(host)
  host.writeState({ totalCount: 32, itemsByPage: { '3': [pullRequestItem(14)] } })

  const page = object(await host.call('workItemPage', { kind: 'pullRequest', page: 3, limit: 7, query: 'author:@me' }))
  expect(page).toMatchObject({ page: 3, limit: 7, totalCount: 32, hasNextPage: true, truncated: false, partial: false })
  expect(object(array(page.items)[0])).toMatchObject({ kind: 'pullRequest', number: 14, title: 'issue 14' })
  expect(object(page.sources).prs).toBe('origin')

  const calls = searchCalls(host)
  expect(calls).toHaveLength(1)
  const endpoint = new URL(`https://api.github.com/${String(calls[0]?.endpoint)}`)
  expect(endpoint.searchParams.get('page')).toBe('3')
  expect(endpoint.searchParams.get('per_page')).toBe('7')
  expect(endpoint.searchParams.get('q')).toBe('repo:test-owner/test-repo is:pr author:@me sort:updated-desc')
}, 30_000)

test('workItemPage rejects invalid limits, out-of-window pages, oversized queries and foreign repo filters before search', async () => {
  const host = await bootHosting(ghSource)
  hosts.push(host)
  const invalid = [
    { kind: 'issue', page: 0, limit: 10 },
    { kind: 'issue', page: 1, limit: 101 },
    { kind: 'issue', page: 11, limit: 100 },
    { kind: 'issue', page: 1, limit: 10, query: 'x'.repeat(8193) },
    { kind: 'issue', page: 1, limit: 10, query: 'repo:somebody/else is:open' }
  ]
  for (const params of invalid) await expect(host.call('workItemPage', params)).rejects.toBeDefined()
  expect(searchCalls(host)).toHaveLength(0)
}, 30_000)
