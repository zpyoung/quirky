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
type SearchField = { alias: string; search: string; first: unknown; after: unknown }

function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as RecordValue
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array result')
  return value
}

function searchExpression(query: string, kind: 'issue' | 'pullRequest', owner = 'test-owner', repo = 'test-repo'): string {
  return `repo:${owner}/${repo} ${kind === 'issue' ? 'is:issue' : 'is:pr'} ${query.trim()} sort:updated-desc`.replace(/  /g, ' ')
}

function page(issueCount: number, nodes: unknown[] = [], pageInfo: RecordValue = { endCursor: null, hasNextPage: false }): RecordValue {
  return { issueCount, pageInfo, nodes }
}

function issue(number: number, title: string, updatedAt: string): RecordValue {
  return {
    __typename: 'Issue',
    number,
    title,
    issueState: 'OPEN',
    url: `https://github.com/test-owner/test-repo/issues/${number}`,
    createdAt: updatedAt,
    updatedAt
  }
}

function graphqlCalls(host: HostingTest): RecordValue[] {
  return host.invocations()
    .filter((invocation) => invocation.args.includes('graphql'))
    .map((invocation) => ({ input: invocation.input, args: invocation.args }))
}

function graphSearchFields(call: RecordValue): SearchField[] {
  const input = object(JSON.parse(String(call.input)))
  const query = typeof input.query === 'string' ? input.query : ''
  const variables = object(input.variables ?? {})
  const fields: SearchField[] = []
  const expression = /(?:(?<alias>[_A-Za-z][_0-9A-Za-z]*)\s*:\s*)?search\s*\((?<args>[^)]*)\)/g
  for (const match of query.matchAll(expression)) {
    const args = match.groups?.args ?? ''
    const value = (name: string): unknown => {
      const argument = new RegExp(`(?:^|,)\\s*${name}\\s*:\\s*(\\$[_A-Za-z][_0-9A-Za-z]*|"(?:\\\\.|[^"\\\\])*"|null|-?[0-9]+)`).exec(args)?.[1]
      if (argument === undefined) return undefined
      if (argument.startsWith('$')) return variables[argument.slice(1)]
      if (argument.startsWith('"')) return JSON.parse(argument)
      if (argument === 'null') return null
      return Number(argument)
    }
    const search = value('query')
    if (typeof search !== 'string') continue
    fields.push({ alias: match.groups?.alias ?? 'search', search, first: value('first'), after: value('after') })
  }
  return fields
}

async function waitForMarker(path: string, content: string): Promise<void> {
  const ready = () => existsSync(path) && readFileSync(path, 'utf8').includes(content)
  if (ready()) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const watcher = watch(dirname(path), () => {
    if (ready()) resolve()
  })
  if (ready()) resolve()
  try {
    await promise
  } finally {
    watcher.close()
  }
}

test('same-turn count searches batch into at most ten aliases and retain each provider count', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const uniqueQueries = Array.from({ length: 6 }, (_, index) => `batch-${index}`)
  const queries = [...uniqueQueries, uniqueQueries[0]!]
  const searches: Record<string, unknown> = {}
  const expectedByQuery = new Map<string, number>()
  for (const [index, query] of uniqueQueries.entries()) {
    const issueCount = index + 2
    const pullRequestCount = index + 20
    searches[searchExpression(query, 'issue')] = page(issueCount)
    searches[searchExpression(query, 'pullRequest')] = page(pullRequestCount)
    expectedByQuery.set(query, issueCount + pullRequestCount)
  }
  const expected = queries.map((query) => expectedByQuery.get(query) ?? 0)
  host.writeState({ searches })

  const results = await Promise.all(queries.map((query) => host.call('countWorkItems', { query })))

  expect(results.map((result) => object(result).count)).toEqual(expected)
  const cached = object(await host.call('countWorkItems', { query: uniqueQueries[0] }))
  expect(cached.count).toBe(expected[0])
  const calls = graphqlCalls(host)
  expect(calls.length).toBe(2)
  const fields = calls.flatMap(graphSearchFields)
  expect(fields).toHaveLength(12)
  expect(calls.every((call) => graphSearchFields(call).length <= 10)).toBe(true)
  expect(new Set(fields.map((field) => field.search)).size).toBe(12)
}, 30_000)

test('long searches preserve individual counts within the provider query limit', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const queries = Array.from({ length: 5 }, (_, index) => `${String.fromCharCode(97 + index)}${'x'.repeat(2_700)}`)
  const searches: Record<string, unknown> = {}
  const expected = queries.map((query, index) => {
    searches[searchExpression(query, 'issue')] = page(index + 3)
    searches[searchExpression(query, 'pullRequest')] = page(index + 30)
    return index * 2 + 33
  })
  host.writeState({ searches })

  const results = await Promise.all(queries.map((query) => host.call('countWorkItems', { query })))

  expect(results.map((result) => object(result).count)).toEqual(expected)
  const calls = graphqlCalls(host)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.length).toBeLessThan(10)
  expect(calls.flatMap(graphSearchFields)).toHaveLength(10)
  for (const call of calls) {
    const fields = graphSearchFields(call)
    expect(fields.length).toBeLessThanOrEqual(10)
    const input = object(JSON.parse(String(call.input)))
    expect(typeof input.query).toBe('string')
    expect(String(input.query).length).toBeLessThanOrEqual(12_000)
  }
}, 30_000)

test('different repository scopes never share one batch even under the same worktree', async () => {
  const host = await bootHosting(searchBatchFixture, { upstream: 'https://github.com/upstream-owner/upstream-repo.git' })
  hosts.push(host)
  const query = 'scope-isolation'
  host.writeState({
    searches: {
      [searchExpression(query, 'issue')]: page(13),
      [searchExpression(query, 'pullRequest', 'upstream-owner', 'upstream-repo')]: page(29)
    }
  })
  await host.call('configure', { issueSourcePreference: 'origin' })

  const result = object(await host.call('countWorkItems', { query }))

  expect(result.count).toBe(42)
  const calls = graphqlCalls(host)
  expect(calls).toHaveLength(2)
  const fields = calls.map((call) => graphSearchFields(call))
  expect(fields.every((group) => group.length === 1)).toBe(true)
  expect(new Set(fields.flat().map((field) => field.search))).toEqual(new Set([
    searchExpression(query, 'issue'),
    searchExpression(query, 'pullRequest', 'upstream-owner', 'upstream-repo')
  ]))
}, 30_000)

test('an issue alias error falls back without losing its batched pull-request count', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'alias-error'
  const issueExpression = searchExpression(query, 'issue')
  const pullRequestExpression = searchExpression(query, 'pullRequest')
  host.writeState({
    searches: {
      [issueExpression]: { error: 'Resource not accessible by integration' },
      [pullRequestExpression]: page(17)
    },
    restSearch: { total_count: 5, items: [] }
  })

  const result = object(await host.call('countWorkItems', { query }))

  expect(result.count).toBe(22)
  expect(result.partial).toBe(false)
  expect(result.partialFailures).toEqual([])
  const mixedRequest = graphqlCalls(host).find((call) => {
    const searches = graphSearchFields(call).map((field) => field.search)
    return searches.includes(issueExpression) && searches.includes(pullRequestExpression)
  })
  expect(mixedRequest).toBeDefined()
  if (!mixedRequest) throw new Error('the issue and pull-request aliases were not batched together')
  const fields = graphSearchFields(mixedRequest)
  const issueAlias = fields.find((field) => field.search === issueExpression)
  const pullRequestAlias = fields.find((field) => field.search === pullRequestExpression)
  expect(issueAlias).toBeDefined()
  expect(pullRequestAlias).toBeDefined()
  expect(issueAlias?.alias).not.toBe(pullRequestAlias?.alias)
}, 30_000)

test('a later list page reuses its first cursor block and continues from that cursor', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'cursor-walk'
  const expression = searchExpression(query, 'issue')
  const firstNodes = Array.from({ length: 100 }, (_, index) => issue(200 - index, `First page ${200 - index}`, '2026-10-02T00:00:00Z'))
  const secondNodes = Array.from({ length: 100 }, (_, index) => issue(100 - index, `Second page ${100 - index}`, '2026-10-01T00:00:00Z'))
  host.writeState({
    searches: {
      [expression]: {
        pages: {
          first: page(200, firstNodes, { endCursor: 'cursor-alpha-1', hasNextPage: true }),
          'cursor-alpha-1': page(200, secondNodes, { endCursor: 'cursor-alpha-2', hasNextPage: false })
        }
      },
      [searchExpression(query, 'pullRequest')]: page(0)
    }
  })

  const first = object(await host.call('listWorkItems', { query, page: 1, limit: 100 }))
  const second = object(await host.call('listWorkItems', { query, page: 2, limit: 100 }))

  expect(list(first.items).map((value) => object(value).number)).toEqual(Array.from({ length: 100 }, (_, index) => 200 - index))
  expect(list(second.items).map((value) => object(value).number)).toEqual(Array.from({ length: 100 }, (_, index) => 100 - index))
  const fields = graphqlCalls(host).flatMap(graphSearchFields).filter((field) => field.search === expression)
  expect(fields.map((field) => field.after)).toEqual([null, 'cursor-alpha-1'])
}, 30_000)

test('noCache refreshes a cached search and replaces the prior page result', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'forced-refresh'
  const expression = searchExpression(query, 'issue')
  host.writeState({
    searches: {
      [expression]: page(1, [issue(91, 'Before force refresh', '2026-10-01T00:00:00Z')]),
      [searchExpression(query, 'pullRequest')]: page(0)
    }
  })
  const before = object(await host.call('listWorkItems', { query, limit: 10 }))
  const state = object(host.readState())
  const searches = object(state.searches)
  searches[expression] = page(1, [issue(92, 'After force refresh', '2026-10-03T00:00:00Z')])
  host.writeState(state)

  const forced = object(await host.call('listWorkItems', { query, limit: 10, noCache: true }))
  const next = object(await host.call('listWorkItems', { query, limit: 10 }))

  expect(list(before.items).map((value) => object(value).title)).toContain('Before force refresh')
  expect(list(forced.items).map((value) => object(value).title)).toContain('After force refresh')
  expect(list(next.items).map((value) => object(value).title)).toContain('After force refresh')
  expect(graphqlCalls(host).flatMap(graphSearchFields).filter((field) => field.search === expression)).toHaveLength(2)
}, 30_000)

test('issue mutations invalidate settled search pages', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'mutation-refresh'
  const expression = searchExpression(query, 'issue')
  host.writeState({
    searches: {
      [expression]: page(1, [issue(101, 'Before mutation', '2026-10-01T00:00:00Z')]),
      [searchExpression(query, 'pullRequest')]: page(0)
    }
  })
  const before = object(await host.call('listWorkItems', { query, limit: 10 }))
  const state = object(host.readState())
  const searches = object(state.searches)
  searches[expression] = page(1, [issue(101, 'After mutation', '2026-10-03T00:00:00Z')])
  host.writeState(state)

  await host.call('updateIssue', { number: 101, title: 'Updated by the API' })
  const after = object(await host.call('listWorkItems', { query, limit: 10 }))

  expect(list(before.items).map((value) => object(value).title)).toContain('Before mutation')
  expect(list(after.items).map((value) => object(value).title)).toContain('After mutation')
  expect(graphqlCalls(host).flatMap(graphSearchFields).filter((field) => field.search === expression)).toHaveLength(2)
}, 30_000)

test('an invalidated in-flight response cannot take ownership of the refreshed cursor cache', async () => {
  const host = await bootHosting(searchBatchFixture)
  hosts.push(host)
  const query = 'stale-owner'
  const expression = searchExpression(query, 'issue')
  host.writeState({
    holdSearches: [expression],
    searches: {
      [expression]: page(1, [issue(111, 'Stale in-flight result', '2026-10-01T00:00:00Z')]),
      [searchExpression(query, 'pullRequest')]: page(0)
    }
  })
  const inFlight = host.call('listWorkItems', { query, limit: 10 })
  const marker = join(host.root, 'held-searches.jsonl')
  await waitForMarker(marker, expression)

  const state = object(host.readState())
  const searches = object(state.searches)
  searches[expression] = page(1, [issue(112, 'Fresh post-mutation result', '2026-10-03T00:00:00Z')])
  host.writeState(state)
  await host.call('updateIssue', { number: 111, title: 'Advance hosting generation' })
  const released = object(host.readState())
  released.releaseHeldSearches = true
  host.writeState(released)

  const oldResult = object(await inFlight)
  const refreshed = object(await host.call('listWorkItems', { query, limit: 10 }))

  expect(list(oldResult.items).map((value) => object(value).title)).toContain('Stale in-flight result')
  expect(list(refreshed.items).map((value) => object(value).title)).toContain('Fresh post-mutation result')
  expect(graphqlCalls(host).flatMap(graphSearchFields).filter((field) => field.search === expression)).toHaveLength(2)
}, 30_000)
