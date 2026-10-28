import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'
import { PROJECT_ISSUE_TYPES_FIXTURE } from './project-issue-types-fixture'

type IssueTypeFixtureState = {
  projectId: string
  itemId: string
  issueNumber: number
  repository: string
  projectOwner: { __typename: 'Organization' | 'User'; login: string }
  repositoryOwner: { __typename: 'Organization' | 'User'; login: string }
  organizationIssueTypes: Record<string, { id: string; name: string; description?: string | null; isEnabled?: boolean }[]>
  issueType: { id: string; name: string } | null
  issueTypePages?: Record<string, { issueId?: string; connection?: unknown }>
  graphqlCalls: { query: string; variables: Record<string, unknown> }[]
}

const runs: HostingTest[] = []
afterEach(async () => { for (const run of runs.splice(0).reverse()) await run.cleanup() })

async function hosting(state: Omit<IssueTypeFixtureState, 'graphqlCalls'>): Promise<HostingTest> {
  const run = await bootHosting(PROJECT_ISSUE_TYPES_FIXTURE)
  runs.push(run)
  run.writeState({ ...state, graphqlCalls: [] })
  return run
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function calls(run: HostingTest): IssueTypeFixtureState['graphqlCalls'] {
  const state = object(run.readState()) as unknown as IssueTypeFixtureState
  return state.graphqlCalls
}

function mutationCount(run: HostingTest): number {
  return calls(run).filter(({ query }) => query.includes('SetIssueType')).length
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeDefined()
  expect(object(object(caught).data).reason).toBe(reason)
}

test('a user-owned Project discovers and changes types from its organization-owned Issue repository', async () => {
  const run = await hosting({
    projectId: 'PVT_USER',
    itemId: 'PVTI_ISSUE',
    issueNumber: 31,
    repository: 'tool',
    projectOwner: { __typename: 'User', login: 'pat' },
    repositoryOwner: { __typename: 'Organization', login: 'acme' },
    organizationIssueTypes: {
      acme: [
        { id: 'TYPE_TASK', name: 'Task', description: 'Work item', isEnabled: true },
        { id: 'TYPE_BUG', name: 'Bug', isEnabled: true },
        { id: 'TYPE_DISABLED', name: 'Disabled', isEnabled: false }
      ]
    },
    issueType: { id: 'TYPE_TASK', name: 'Task' }
  })
  const target = { projectId: 'PVT_USER', itemId: 'PVTI_ISSUE', action: 'updateIssueType' }
  const discovered = object(await run.call('projectItemMutation', target))
  expect(discovered.changed).toBe(false)
  expect((discovered.issueTypes as { name: string }[]).map((type) => type.name)).toEqual(['Task', 'Bug', 'Disabled'])
  const typeQuery = calls(run).find(({ query }) => query.includes('issueTypes'))
  expect(typeQuery?.variables.repoOwner).toBe('acme')
  expect(typeQuery?.variables.repo).toBe('tool')

  const updated = object(await run.call('projectItemMutation', { ...target, issueTypeId: 'TYPE_BUG' }))
  expect(updated.changed).toBe(true)
  expect(updated.issueType).toMatchObject({ id: 'TYPE_BUG', name: 'Bug' })
  expect(object(run.readState()).issueType).toMatchObject({ id: 'TYPE_BUG', name: 'Bug' })
  expect(mutationCount(run)).toBe(1)

  await expectReason(run.call('projectItemMutation', { ...target, issueTypeId: 'TYPE_DISABLED' }), 'not_found')
  await expectReason(run.call('projectItemMutation', { ...target, issueTypeName: 'No such type' }), 'not_found')
  expect(mutationCount(run)).toBe(1)
}, 20_000)

test('an organization Project cannot lend its types to a personal-repository Issue', async () => {
  const run = await hosting({
    projectId: 'PVT_ORG',
    itemId: 'PVTI_PERSONAL_ISSUE',
    issueNumber: 32,
    repository: 'notes',
    projectOwner: { __typename: 'Organization', login: 'acme' },
    repositoryOwner: { __typename: 'User', login: 'pat' },
    organizationIssueTypes: {
      acme: [{ id: 'TYPE_BUG', name: 'Bug', isEnabled: true }]
    },
    issueType: null
  })
  const target = { projectId: 'PVT_ORG', itemId: 'PVTI_PERSONAL_ISSUE', action: 'updateIssueType' }
  const discovered = object(await run.call('projectItemMutation', target))
  expect(discovered.changed).toBe(false)
  expect(discovered.issueTypes).toEqual([])
  const typeQuery = calls(run).find(({ query }) => query.includes('issueTypes'))
  expect(typeQuery?.variables.repoOwner).toBe('pat')
  expect(typeQuery?.variables.repo).toBe('notes')

  await expectReason(run.call('projectItemMutation', { ...target, issueTypeId: 'TYPE_BUG' }), 'not_found')
  expect(mutationCount(run)).toBe(0)
  expect(object(run.readState()).issueType).toBeNull()
}, 20_000)
test('organization issue-type pagination rejects malformed connections and unstable page identity', async () => {
  const run = await hosting({
    projectId: 'PVT_USER',
    itemId: 'PVTI_ISSUE',
    issueNumber: 33,
    repository: 'tool',
    projectOwner: { __typename: 'User', login: 'pat' },
    repositoryOwner: { __typename: 'Organization', login: 'acme' },
    organizationIssueTypes: { acme: [{ id: 'TYPE_TASK', name: 'Task', isEnabled: true }] },
    issueType: null
  })
  const initial = object(run.readState()) as unknown as IssueTypeFixtureState
  const scenarios: { name: string; pages: NonNullable<IssueTypeFixtureState['issueTypePages']> }[] = [
    { name: 'missing nodes', pages: { start: { connection: { pageInfo: { endCursor: null, hasNextPage: false } } } } },
    { name: 'missing hasNextPage', pages: { start: { connection: { nodes: [], pageInfo: { endCursor: null } } } } },
    { name: 'missing continuation cursor', pages: { start: { connection: { nodes: [], pageInfo: { endCursor: null, hasNextPage: true } } } } },
    {
      name: 'repeated continuation cursor',
      pages: {
        start: { connection: { nodes: [], pageInfo: { endCursor: 'cursor-1', hasNextPage: true } } },
        'cursor-1': { connection: { nodes: [], pageInfo: { endCursor: 'cursor-1', hasNextPage: true } } }
      }
    },
    {
      name: 'changed issue identity',
      pages: {
        start: { connection: { nodes: [], pageInfo: { endCursor: 'cursor-1', hasNextPage: true } } },
        'cursor-1': { issueId: 'OTHER_ISSUE', connection: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } }
      }
    }
  ]

  for (const scenario of scenarios) {
    run.writeState({ ...initial, graphqlCalls: [], issueTypePages: scenario.pages })
    await expectReason(run.call('projectItemMutation', {
      projectId: 'PVT_USER', itemId: 'PVTI_ISSUE', action: 'updateIssueType'
    }), 'schema_drift')
  }
}, 20_000)
