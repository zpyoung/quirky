export const searchBatchFixture = String.raw`
import { appendFileSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

const fixtureRoot = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof fixtureRoot !== 'string') throw new Error('missing fixture directory')
const statePath = join(fixtureRoot, 'state.json')
const readState = () => {
  const value = JSON.parse(readFileSync(statePath, 'utf8'))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
const state = readState()
const args = process.argv.slice(2)
const command = args.join(' ')
const inputText = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const input = inputText.length > 0 ? JSON.parse(inputText) : null
const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
const methodIndex = args.findIndex((part) => part === '--method' || part === '-X')
const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET').toUpperCase() : 'GET'
const endpoint = args.find((part) => part === 'rate_limit' || part.startsWith('repos/') || part.startsWith('search/')) ?? ''
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const emit = (value) => {
  process.stdout.write(JSON.stringify(value))
  process.exit(0)
}

if (args.includes('auth') && args.includes('status')) {
  process.stdout.write('Logged in to github.com account search-batch-fixture (keyring)\nActive account: true\nToken scopes: repo, read:org\n')
  process.exit(0)
}
if (args.includes('auth') && args.includes('token')) {
  process.stdout.write('fixture-search-batch-token')
  process.exit(0)
}
if (endpoint === 'rate_limit') {
  const reset = Math.ceil(Date.now() / 1000) + 3_600
  emit({ resources: {
    core: { limit: 5_000, remaining: 5_000, reset },
    search: { limit: 30, remaining: 30, reset },
    graphql: { limit: 5_000, remaining: 5_000, reset }
  } })
}

function argumentValue(argumentsText, name, variables) {
  const raw = new RegExp('(?:^|,)\\s*' + name + '\\s*:\\s*(\\$[_A-Za-z][_0-9A-Za-z]*|"(?:\\\\.|[^"\\\\])*"|null|-?[0-9]+)').exec(argumentsText)?.[1]
  if (raw === undefined) return undefined
  if (raw.startsWith('$')) return variables[raw.slice(1)]
  if (raw.startsWith('"')) return JSON.parse(raw)
  if (raw === 'null') return null
  return Number(raw)
}
function searchFields(query, variables) {
  const fields = []
  const pattern = /(?:(?<alias>[_A-Za-z][_0-9A-Za-z]*)\s*:\s*)?search\s*\((?<args>[^)]*)\)/g
  for (const match of query.matchAll(pattern)) {
    const argumentsText = match.groups?.args ?? ''
    const search = argumentValue(argumentsText, 'query', variables)
    if (typeof search !== 'string') continue
    fields.push({
      alias: match.groups?.alias ?? 'search',
      search,
      first: argumentValue(argumentsText, 'first', variables),
      after: argumentValue(argumentsText, 'after', variables)
    })
  }
  return fields
}
async function awaitRelease(search) {
  appendFileSync(join(fixtureRoot, 'held-searches.jsonl'), search + '\n')
  const released = () => readState().releaseHeldSearches === true
  const { promise, resolve } = Promise.withResolvers()
  const watcher = watch(fixtureRoot, () => {
    if (released()) resolve()
  })
  if (released()) resolve()
  try {
    await promise
  } finally {
    watcher.close()
  }
}

if (args[0] === 'api' && args.includes('graphql')) {
  const query = typeof body.query === 'string' ? body.query : ''
  const variables = isObject(body.variables) ? body.variables : {}
  const configuredSearches = isObject(state.searches) ? state.searches : {}
  const data = {}
  const errors = []
  for (const field of searchFields(query, variables)) {
    const configured = configuredSearches[field.search]
    if (isObject(configured) && typeof configured.error === 'string') {
      errors.push({ message: configured.error, path: [field.alias] })
      continue
    }
    let result = isObject(configured) ? configured : {}
    if (isObject(result.pages)) {
      const pageKey = field.after === null || field.after === undefined ? 'first' : String(field.after)
      const selected = result.pages[pageKey]
      if (isObject(selected)) result = selected
    }
    const issueCount = Number.isSafeInteger(result.issueCount) && result.issueCount >= 0
      ? result.issueCount
      : (Array.isArray(result.nodes) ? result.nodes.length : 0)
    const pageInfo = isObject(result.pageInfo) ? result.pageInfo : { endCursor: null, hasNextPage: false }
    const connection = {
      issueCount,
      pageInfo: { endCursor: pageInfo.endCursor ?? null, hasNextPage: pageInfo.hasNextPage === true },
      nodes: Array.isArray(result.nodes) ? result.nodes : []
    }
    data[field.alias] = connection
    const holdSearches = Array.isArray(state.holdSearches) ? state.holdSearches : []
    if (holdSearches.includes(field.search)) await awaitRelease(field.search)
  }
  data.rateLimit = { cost: 1 }
  emit(errors.length > 0 ? { data, errors } : { data })
}

if (endpoint.startsWith('search/issues?')) {
  const response = isObject(state.restSearch) ? state.restSearch : { total_count: 0, items: [] }
  emit({ total_count: response.total_count ?? response.totalCount ?? 0, items: Array.isArray(response.items) ? response.items : [] })
}

const issuePath = /^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(endpoint)
if (issuePath && (method === 'GET' || method === 'PATCH')) {
  const [, owner, repo, rawNumber] = issuePath
  const number = Number(rawNumber)
  emit({ number, title: 'Fixture issue', state: 'open', html_url: 'https://github.com/' + owner + '/' + repo + '/issues/' + number })
}
if (command.includes('pr list')) emit([])
if (method !== 'GET' && endpoint.length > 0) emit({ number: 101, title: 'Fixture issue', state: 'open' })
emit({})
`
