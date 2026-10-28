import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { bootHosting, type HostingTest } from './helpers'
import { searchBatchFixture } from './search-batch-fixture'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

type RecordValue = Record<string, unknown>
type SearchField = { alias: string; search: string; after: unknown }
type GraphqlCall = { input: string; args: string[] }

function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as RecordValue
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array result')
  return value
}

function searchExpression(query: string, kind: 'issue' | 'pullRequest'): string {
  return `repo:test-owner/test-repo ${kind === 'issue' ? 'is:issue' : 'is:pr'} ${query.trim()} sort:updated-desc`.replace(/  /g, ' ')
}

function page(issueCount: number, nodes: unknown[] = [], pageInfo: RecordValue = { endCursor: null, hasNextPage: false }): RecordValue {
  return { issueCount, pageInfo, nodes }
}

function issue(number: number, updatedAt = '2026-10-02T00:00:00Z'): RecordValue {
  return {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    issueState: 'OPEN',
    url: `https://github.com/test-owner/test-repo/issues/${number}`,
    createdAt: updatedAt,
    updatedAt
  }
}

function graphqlCalls(host: HostingTest): GraphqlCall[] {
  return host.invocations()
    .filter((invocation) => invocation.args.includes('graphql'))
    .map(({ input, args }) => ({ input, args }))
}

function searchFields(call: GraphqlCall): SearchField[] {
  const input = object(JSON.parse(call.input))
  const query = typeof input.query === 'string' ? input.query : ''
  const variables = object(input.variables ?? {})
  const fields: SearchField[] = []
  const expression = /(?:(?<alias>[_A-Za-z][_0-9A-Za-z]*)\s*:\s*)?search\s*\((?<args>[^)]*)\)/g
  for (const match of query.matchAll(expression)) {
    const args = match.groups?.args ?? ''
    const argument = (name: string): unknown => {
      const raw = new RegExp(`(?:^|,)\\s*${name}\\s*:\\s*(\\$[_A-Za-z][_0-9A-Za-z]*|"(?:\\\\.|[^"\\\\])*"|null|-?[0-9]+)`).exec(args)?.[1]
      if (raw === undefined) return undefined
      if (raw.startsWith('$')) return variables[raw.slice(1)]
      if (raw.startsWith('"')) return JSON.parse(raw)
      if (raw === 'null') return null
      return Number(raw)
    }
    const search = argument('query')
    if (typeof search === 'string') fields.push({ alias: match.groups?.alias ?? 'search', search, after: argument('after') })
  }
  return fields
}

async function waitFor(path: string, ready: () => boolean): Promise<void> {
  if (ready()) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const watcher = watch(dirname(path), () => {
    if (ready()) resolve()
  })
  try {
    if (ready()) resolve()
    await promise
  } finally {
    watcher.close()
  }
}

function waitForHeldSearch(host: HostingTest, search: string): Promise<void> {
  const marker = join(host.root, 'held-searches.jsonl')
  return waitFor(marker, () => existsSync(marker) && readFileSync(marker, 'utf8').includes(search))
}

function waitForAdditionalGraphqlCall(host: HostingTest, priorCount: number): Promise<void> {
  const log = join(host.root, 'invocations.jsonl')
  return waitFor(log, () => graphqlCalls(host).length > priorCount)
}

function waitForSearches(host: HostingTest, expected: string[]): Promise<void> {
  const log = join(host.root, 'invocations.jsonl')
  return waitFor(log, () => {
    const seen = new Set(graphqlCalls(host).flatMap(searchFields).map((field) => field.search))
    return expected.every((search) => seen.has(search))
  })
}

const globalGraphqlFailureFixture = String.raw`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof fixtureDir !== 'string') throw new Error('missing fixture directory')
const stateValue = JSON.parse(readFileSync(join(fixtureDir, 'state.json'), 'utf8'))
const state = stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue) ? stateValue : {}
const args = process.argv.slice(2)
const command = args.join(' ')
const endpoint = args.find((part) => part === 'rate_limit' || part.startsWith('search/')) ?? ''
const emit = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
const fail = (message) => { process.stderr.write(message); process.exit(1) }
if (args.includes('auth') && args.includes('status')) {
  process.stdout.write('Logged in to github.com account global-failure-fixture (keyring)\nActive account: true\nToken scopes: repo, read:org\n')
  process.exit(0)
}
if (args.includes('auth') && args.includes('token')) {
  process.stdout.write('fixture-global-failure-token')
  process.exit(0)
}
if (endpoint === 'rate_limit') {
  const reset = Math.ceil(Date.now() / 1000) + 3600
  emit({ resources: { core: { limit: 5000, remaining: 5000, reset }, search: { limit: 30, remaining: 30, reset }, graphql: { limit: 5000, remaining: 5000, reset } } })
}
if (args.includes('graphql')) fail('HTTP 502: fixture GraphQL unavailable')
if (endpoint.startsWith('search/issues?')) {
  if (state.restFailure === true) fail('HTTP 503: fixture REST search unavailable')
  const query = new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1)).get('q') ?? ''
  emit({ total_count: /\bis:pr\b/.test(query) ? 11 : 7, items: [] })
}
if (command.includes('pr list')) emit([])
emit({})
`

test('nonadvancing and missing cursors never return duplicate or falsely complete pages', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'repeated-cursor'
  const issueSearch = searchExpression(query, 'issue')
  const pullRequestSearch = searchExpression(query, 'pullRequest')
  const repeatedNodes = Array.from({ length: 100 }, (_, index) => issue(300 - index))
  const endQuery = 'end-of-results'
  const endSearch = searchExpression(endQuery, 'issue')
  const missingQuery = 'missing-cursor'
  const missingSearch = searchExpression(missingQuery, 'issue')
  host.writeState({
    searches: {
      [issueSearch]: {
        pages: {
          first: page(250, repeatedNodes, { endCursor: 'cursor-stalled', hasNextPage: true }),
          'cursor-stalled': page(250, repeatedNodes, { endCursor: 'cursor-stalled', hasNextPage: true })
        }
      },
      [pullRequestSearch]: page(0),
      [endSearch]: page(3, [issue(3), issue(2), issue(1)]),
      [searchExpression(endQuery, 'pullRequest')]: page(0),
      [missingSearch]: page(250, repeatedNodes, { endCursor: null, hasNextPage: true }),
      [searchExpression(missingQuery, 'pullRequest')]: page(0)
    },
    restSearch: { total_count: 0, items: [] }
  })

  const repeated = object(await host.call('listWorkItems', { query, page: 2, limit: 100 }))
  const repeatedNumbers = list(repeated.items).map((item) => object(item).number)
  expect(new Set(repeatedNumbers).size).toBe(repeatedNumbers.length)
  expect(repeated.partial === true || repeated.totalCount === 0).toBe(true)

  const ended = object(await host.call('listWorkItems', { query: endQuery, page: 1, limit: 100 }))
  expect(list(ended.items).map((item) => object(item).number)).toEqual([3, 2, 1])
  expect(ended.hasNextPage).toBe(false)

  const missing = object(await host.call('listWorkItems', { query: missingQuery, page: 2, limit: 100 }))
  const missingItems = list(missing.items)
  const missingNumbers = missingItems.map((item) => object(item).number)
  const safelyReturned = missing.partial === true
    || (missingItems.length === 100 && new Set(missingNumbers).size === 100)
    || (missing.totalCount === 0 && missingItems.length === 0)
  expect(safelyReturned).toBe(true)
}, 30_000)

test('whole-call GraphQL failures fall back to REST or remain explicit partial failures', async () => {
  const host = await bootHosting(globalGraphqlFailureFixture)
  hosts.push(host)
  host.writeState({})

  const fallback = object(await host.call('countWorkItems', { query: 'global-fallback' }))
  expect(fallback.count).toBe(18)
  expect(fallback.partial).toBe(false)
  expect(fallback.partialFailures).toEqual([])

  host.writeState({ restFailure: true })
  const unavailable = object(await host.call('countWorkItems', { query: 'global-unavailable' }))
  expect(unavailable.count).toBe(0)
  expect(unavailable.partial).toBe(true)
  expect(list(unavailable.partialFailures).map((failure) => object(failure).source).sort()).toEqual(['issues', 'prs'])
  const invocations = host.invocations()
  expect(invocations.some((invocation) => invocation.args.includes('graphql'))).toBe(true)
  expect(invocations.some((invocation) => invocation.args.some((arg) => arg.startsWith('search/issues?')))).toBe(true)
}, 30_000)

test('ambient and explicitly bound accounts do not share an in-flight search batch', async () => {
  const accountSelectionFixture = searchBatchFixture.replace(
    "if (args.includes('auth') && args.includes('token')) {\n  process.stdout.write('fixture-search-batch-token')\n  process.exit(0)\n}",
    "if (args.includes('auth') && args.includes('token')) {\n  process.stdout.write(args.includes('--help') ? 'gh auth token --user USER' : 'fixture-search-batch-token')\n  process.exit(0)\n}"
  )
  const host = await bootHosting(accountSelectionFixture)
  hosts.push(host)
  const query = 'account-scope-isolation'
  const issueSearch = searchExpression(query, 'issue')
  const pullRequestSearch = searchExpression(query, 'pullRequest')
  host.writeState({
    holdSearches: [issueSearch],
    searches: { [issueSearch]: page(13), [pullRequestSearch]: page(29) }
  })

  const ambientPromise = host.call('countWorkItems', { query })
  try {
    await waitForHeldSearch(host, issueSearch)
    await waitForSearches(host, [issueSearch, pullRequestSearch])
    await host.call('configure', { account: { host: 'github.com', user: 'search-batch-fixture' } })

    const state = object(host.readState())
    state.holdSearches = []
    host.writeState(state)
    const priorGraphqlCalls = graphqlCalls(host).length
    const boundPromise = host.call('countWorkItems', { query })
    await waitForAdditionalGraphqlCall(host, priorGraphqlCalls)
    const bound = object(await boundPromise)
    expect(bound.count).toBe(42)

    const released = object(host.readState())
    released.releaseHeldSearches = true
    host.writeState(released)
    const ambient = object(await ambientPromise)
    expect(ambient.count).toBe(42)
  } finally {
    try {
      const released = object(host.readState())
      released.releaseHeldSearches = true
      host.writeState(released)
    } finally {
      await ambientPromise.catch(() => undefined)
    }
  }
}, 30_000)
