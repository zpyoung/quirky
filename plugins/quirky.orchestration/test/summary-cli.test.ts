import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import type { CliArgs, CliContext } from '@quirky/protocol'
import { commands } from '../cli'
import type { SummaryResult } from '../src/summary-contracts'


type ManifestSchema = {
  type?: string
  description?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
  properties?: Record<string, ManifestSchema>
  required?: string[]
  items?: ManifestSchema
  additionalProperties?: boolean
}

type Manifest = {
  contributes: {
    method: { id: string; readOnly?: boolean; params: ManifestSchema; result: ManifestSchema }[]
    'cli-command': { id: string; words: string; flags: Record<string, { type: string }>; methods: string[] }[]
  }
}

const SESSION_STATUSES = ['starting', 'running', 'working', 'waiting', 'done', 'exited']
const DISPLAY_STATES = ['working', 'monitoring', 'waiting', 'permission', 'blocked', 'failed', 'interrupted', 'done', 'unverifiable', 'idle', 'unconfirmed']
const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']
const DISPATCH_STATUSES = ['pending', 'dispatched', 'completed', 'failed', 'circuit_broken']
const WORKER_STATES = ['starting', 'ready', 'start_unknown', 'failed', 'succeeded', 'stopping', 'stop_unknown', 'stopped', 'abandoned']
const TERMINAL_STATES = ['active', 'reclaimable', 'retained', 'release_pending', 'release_unknown', 'released']

function summaryResponse(): SummaryResult {
  return {
    scope: 'local',
    rows: [{
      worktree: { id: 'wt_a', name: 'Alpha', path: '/fixture/a', repoId: 'repo_a' },
      sessions: [
        { id: 's_a', agent: 'claude', kind: 'structured', status: 'working', display: 'working', live: true },
        { id: 's_shell', agent: 'shell', kind: 'terminal', status: 'exited', display: null, live: false }
      ],
      runIds: ['run_a'],
      dispatches: [{
        id: 'ctx_a',
        runId: 'run_a',
        task: { id: 'task_a', title: 'Build summary', status: 'dispatched' },
        status: 'dispatched',
        creatorSessionId: 's_creator',
        assigneeSessionId: 's_a',
        workerSessionId: 's_worker',
        currentAssignment: true,
        workerState: 'ready',
        terminalState: 'active'
      }]
    }],
    total: 1,
    limit: 100,
    truncated: false,
    unavailable: []
  }
}

function cliArgs(flags: Record<string, unknown> = {}): CliArgs {
  return { positionals: [], flags }
}

function recordingContext(response: unknown, json = false) {
  const calls: { method: string; params: Record<string, unknown> | undefined; options: unknown }[] = []
  const results: { value: unknown; text: string }[] = []
  const tables: { headers: string[]; rows: string[][] }[] = []
  const context: CliContext = {
    requestBase: 'must-not-be-forwarded',
    call: async (method, params, options) => {
      calls.push({ method, params, options })
      return response
    },
    out: {
      json,
      result: (value, text) => results.push({ value, text: text() }),
      line: () => undefined,
      jsonLine: () => undefined
    },
    format: {
      table: (headers, rows) => {
        tables.push({ headers, rows })
        return [headers.join(' | '), ...rows.map((row) => row.join(' | '))].join('\n')
      },
      record: () => ''
    },
    env: {},
    cwd: '/fixture',
    readFile: async () => '',
    sleep: async () => undefined,
    now: () => 0,
    usage: (message) => new Error(message),
    fail: (message) => new Error(message),
    reconnect: async () => undefined
  }
  return { context, calls, results, tables }
}

function expectObjectSchema(schema: ManifestSchema, properties: string[], required = properties): Record<string, ManifestSchema> {
  expect(schema.type).toBe('object')
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...properties].sort())
  if (required.length > 0) expect(schema.required).toEqual(required)
  return schema.properties ?? {}
}

function expectNullable(schema: ManifestSchema): void {
  expect(schema.type).toBeUndefined()
  expect(schema.description?.toLowerCase()).toContain('null')
}

test('ps calls the local summary once and emits the complete response as JSON data', async () => {
  const response = summaryResponse()
  const { context, calls, results } = recordingContext(response, true)

  await commands.ps(cliArgs({ limit: 2, from: 'caller-alias', terminal: 'caller-alias' }), context)

  expect(calls).toEqual([{ method: 'quirky.orchestration/summary', params: { limit: 2 }, options: undefined }])
  expect(results).toHaveLength(1)
  expect(results[0]?.value).toBe(response)
  expect(results[0]?.value).toEqual({
    scope: 'local',
    rows: [{
      worktree: { id: 'wt_a', name: 'Alpha', path: '/fixture/a', repoId: 'repo_a' },
      sessions: [
        { id: 's_a', agent: 'claude', kind: 'structured', status: 'working', display: 'working', live: true },
        { id: 's_shell', agent: 'shell', kind: 'terminal', status: 'exited', display: null, live: false }
      ],
      runIds: ['run_a'],
      dispatches: [{
        id: 'ctx_a', runId: 'run_a',
        task: { id: 'task_a', title: 'Build summary', status: 'dispatched' },
        status: 'dispatched', creatorSessionId: 's_creator', assigneeSessionId: 's_a', workerSessionId: 's_worker',
        currentAssignment: true, workerState: 'ready', terminalState: 'active'
      }]
    }],
    total: 1,
    limit: 100,
    truncated: false,
    unavailable: []
  })
})

test('ps validates bounds before RPC and uses the documented usage message', async () => {
  for (const limit of [0, -1, 101, Number.MAX_SAFE_INTEGER + 1]) {
    const { context, calls } = recordingContext(summaryResponse())
    await expect(commands.ps(cliArgs({ limit }), context)).rejects.toThrow('--limit must be between 1 and 100')
    expect(calls).toEqual([])
  }
  for (const limit of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
    const { context, calls } = recordingContext(summaryResponse())
    await expect(commands.ps(cliArgs({ limit }), context)).rejects.toThrow(/--limit must (?:be between 1 and 100|be an integer)/)
    expect(calls).toEqual([])
  }
})

test('ps refuses malformed nested results, including nullable enum values outside their unions', async () => {
  const valid = summaryResponse()
  const row = valid.rows[0]!
  const session = row.sessions[0]!
  const dispatch = row.dispatches[0]!
  const malformed: unknown[] = [
    { ...valid, scope: 'remote' },
    { ...valid, rows: [{ ...row, worktree: { ...row.worktree, id: 3 } }] },
    { ...valid, rows: [{ ...row, sessions: [{ ...session, kind: 'unknown' }] }] },
    { ...valid, rows: [{ ...row, sessions: [{ ...session, status: 'sleeping' }] }] },
    { ...valid, rows: [{ ...row, sessions: [{ ...session, display: 'unknown' }] }] },
    { ...valid, rows: [{ ...row, sessions: [{ ...session, live: 'yes' }] }] },
    { ...valid, rows: [{ ...row, runIds: [4] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, task: { ...dispatch.task, status: 'unknown' } }] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, status: 'unknown' }] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, creatorSessionId: 2 }] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, currentAssignment: 'yes' }] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, workerState: 'unknown' }] }] },
    { ...valid, rows: [{ ...row, dispatches: [{ ...dispatch, terminalState: 'unknown' }] }] },
    { ...valid, unavailable: [false] }
  ]

  for (const response of malformed) {
    const { context, results } = recordingContext(response)
    await expect(commands.ps(cliArgs(), context)).rejects.toThrow(
      'The runtime returned a response that does not match quirky.orchestration/summary.'
    )
    expect(results).toEqual([])
  }
})

test('ps renders complete worktree, session, dispatch and scope details through the table formatter', async () => {
  const response = summaryResponse()
  response.unavailable = ['agent-status-unavailable']
  const { context, calls, results, tables } = recordingContext(response)

  await commands.ps(cliArgs(), context)

  expect(calls).toEqual([{ method: 'quirky.orchestration/summary', params: { limit: 100 }, options: undefined }])
  expect(tables).toHaveLength(1)
  expect(tables[0]?.headers).toEqual(['Worktree', 'Path', 'Repo', 'Sessions', 'Orchestration'])
  expect(tables[0]?.rows).toHaveLength(1)
  const cells = tables[0]?.rows[0] ?? []
  expect(cells[0]).toContain('wt_a')
  expect(cells[0]).toContain('Alpha')
  expect(cells[1]).toBe('/fixture/a')
  expect(cells[2]).toBe('repo_a')
  expect(cells[3]).toContain('s_a')
  expect(cells[3]).toContain('claude')
  expect(cells[3]).toContain('working')
  expect(cells[3]).toContain('live')
  expect(cells[3]).toContain('s_shell')
  expect(cells[3]).toContain('unknown')
  expect(cells[3]).toContain('exited')
  expect(cells[4]).toContain('run_a')
  expect(cells[4]).toContain('task_a')
  expect(cells[4]).toContain('Build summary')
  expect(cells[4]).toContain('dispatched')
  expect(cells[4]).toContain('ctx_a')
  expect(cells[4]).toContain('ready')
  expect(cells[4]).toContain('active')
  expect(cells[4]).toContain('s_creator')
  expect(cells[4]).toContain('s_a')
  expect(cells[4]).toContain('s_worker')
  expect(results[0]?.text).toContain('scope: local; showing 1 of 1 worktrees; unavailable: agent-status-unavailable')
})

test('ps retains coordinator-only Run IDs and labels unsupervised dispatches', async () => {
  const response = summaryResponse()
  response.rows[0]!.sessions = []
  response.rows[0]!.runIds = ['run_coordinator']
  response.rows[0]!.dispatches = []
  response.rows.push({
    ...response.rows[0]!,
    worktree: { id: 'wt_b', name: 'Beta', path: '/fixture/b', repoId: 'repo_b' },
    runIds: ['run_b'],
    dispatches: [{
      ...summaryResponse().rows[0]!.dispatches[0]!,
      id: 'ctx_unsupervised', runId: 'run_b', creatorSessionId: null, assigneeSessionId: 's_b',
      workerSessionId: null, currentAssignment: false, workerState: null, terminalState: 'released'
    }]
  })
  response.total = 2
  const { context, tables, results } = recordingContext(response)

  await commands.ps(cliArgs(), context)

  expect(tables[0]?.rows).toHaveLength(2)
  expect(tables[0]?.rows[0]?.[4]).toContain('run_coordinator')
  expect(tables[0]?.rows[1]?.[4]).toContain('run_b')
  expect(tables[0]?.rows[1]?.[4]).toContain('ctx_unsupervised')
  expect(tables[0]?.rows[1]?.[4]).toContain('unsupervised')
  expect(tables[0]?.rows[1]?.[4]).toContain('released')
  expect(results[0]?.text.endsWith('scope: local; showing 2 of 2 worktrees')).toBe(true)
})

test('ps escapes user-controlled table text and an empty result starts with the local-activity message', async () => {
  const response = summaryResponse()
  response.rows[0]!.worktree.name = 'Alpha "quoted"\tname\nnext\rreset\u001b[31m'
  response.rows[0]!.worktree.path = '/fixture/\tpath\nnext\rreset\u001b[31m'
  response.rows[0]!.dispatches[0]!.task.title = 'Task "quoted"\ttitle\nnext\rreset\u001b[31m'
  const { context, tables, results } = recordingContext(response)

  await commands.ps(cliArgs(), context)

  const cells = tables[0]?.rows[0] ?? []
  expect(cells[0]).toContain('Alpha "quoted"\\tname\\nnext\\rreset\\x1B[31m')
  expect(cells[1]).toContain('/fixture/\\tpath\\nnext\\rreset\\x1B[31m')
  expect(cells[4]).toContain('Task "quoted"\\ttitle\\nnext\\rreset\\x1B[31m')
  expect(cells.join('')).not.toMatch(/[\t\n\r\u001b]/)
  expect(results[0]?.text.endsWith('scope: local; showing 1 of 1 worktrees')).toBe(true)

  const empty: SummaryResult = { scope: 'local', rows: [], total: 0, limit: 100, truncated: false, unavailable: [] }
  const emptyContext = recordingContext(empty)
  await commands.ps(cliArgs(), emptyContext.context)
  expect(emptyContext.tables[0]?.headers).toEqual(['Worktree', 'Path', 'Repo', 'Sessions', 'Orchestration'])
  expect(emptyContext.tables[0]?.rows).toEqual([])
  expect(emptyContext.results[0]?.text.startsWith('No local worktree activity.')).toBe(true)
  expect(emptyContext.results[0]?.text.endsWith('scope: local; showing 0 of 0 worktrees')).toBe(true)
})

test('manifest declares the complete read-only summary schema and binds orchestration ps --limit', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as Manifest
  const method = manifest.contributes.method.find((entry) => entry.id === 'summary')
  expect(method).toBeDefined()
  expect(method?.readOnly).toBe(true)
  expect(method?.params.type).toBe('object')
  expect(Object.keys(method?.params.properties ?? {})).toEqual(['limit'])
  expect(method?.params.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 100 })
  expect(method?.params.additionalProperties).toBe(false)

  const result = method?.result
  expect(result?.type).toBe('object')
  const resultProperties = expectObjectSchema(result!, ['scope', 'rows', 'total', 'limit', 'truncated', 'unavailable'])
  expect(resultProperties.scope).toMatchObject({ type: 'string', enum: ['local'] })
  expect(resultProperties.total?.type).toBe('integer')
  expect(resultProperties.limit?.type).toBe('integer')
  expect(resultProperties.truncated?.type).toBe('boolean')
  expect(resultProperties.unavailable).toMatchObject({ type: 'array', items: { type: 'string' } })

  const row = resultProperties.rows?.items
  const rowProperties = expectObjectSchema(row!, ['worktree', 'sessions', 'runIds', 'dispatches'])
  const worktreeProperties = expectObjectSchema(rowProperties.worktree!, ['id', 'name', 'path', 'repoId'])
  for (const field of Object.values(worktreeProperties)) expect(field.type).toBe('string')
  expect(rowProperties.sessions).toMatchObject({ type: 'array' })
  expect(rowProperties.runIds).toMatchObject({ type: 'array', items: { type: 'string' } })
  expect(rowProperties.dispatches).toMatchObject({ type: 'array' })

  const sessionProperties = expectObjectSchema(rowProperties.sessions!.items!, ['id', 'agent', 'kind', 'status', 'display', 'live'])
  expect(sessionProperties.id?.type).toBe('string')
  expect(sessionProperties.agent?.type).toBe('string')
  expect(sessionProperties.kind?.enum).toEqual(['terminal', 'structured'])
  expect(sessionProperties.status?.enum).toEqual(SESSION_STATUSES)
  expectNullable(sessionProperties.display!)
  for (const display of DISPLAY_STATES) expect(sessionProperties.display?.description).toContain(display)
  expect(sessionProperties.live?.type).toBe('boolean')

  const dispatchProperties = expectObjectSchema(rowProperties.dispatches!.items!, [
    'id', 'runId', 'task', 'status', 'creatorSessionId', 'assigneeSessionId', 'workerSessionId',
    'currentAssignment', 'workerState', 'terminalState'
  ])
  expect(dispatchProperties.id?.type).toBe('string')
  expect(dispatchProperties.runId?.type).toBe('string')
  const taskProperties = expectObjectSchema(dispatchProperties.task!, ['id', 'title', 'status'])
  expect(taskProperties.id?.type).toBe('string')
  expect(taskProperties.title?.type).toBe('string')
  expect(taskProperties.status?.enum).toEqual(TASK_STATUSES)
  expect(dispatchProperties.status?.enum).toEqual(DISPATCH_STATUSES)
  expectNullable(dispatchProperties.creatorSessionId!)
  expectNullable(dispatchProperties.assigneeSessionId!)
  expectNullable(dispatchProperties.workerSessionId!)
  expect(dispatchProperties.currentAssignment?.type).toBe('boolean')
  expectNullable(dispatchProperties.workerState!)
  for (const state of WORKER_STATES) expect(dispatchProperties.workerState?.description).toContain(state)
  expect(dispatchProperties.terminalState?.enum).toEqual(TERMINAL_STATES)

  const command = manifest.contributes['cli-command'].find((entry) => entry.id === 'ps')
  expect(command).toBeDefined()
  expect(command?.words).toBe('ps')
  expect(command?.flags).toEqual({ limit: expect.objectContaining({ type: 'integer' }) })
  expect(command?.methods).toEqual(['quirky.orchestration/summary'])
  expect(typeof commands.ps).toBe('function')
  expect(method?.params).not.toHaveProperty('required')
  expect(command).not.toHaveProperty('positionals')
  expect(command?.flags.limit).not.toHaveProperty('required', true)
})
