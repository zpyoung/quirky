import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import type { QuirkyEvent } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage } from '../types'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createAutomationStore, migrations } from '../store'

const fixtures: PluginHarness[] = []
const temporaryHomes: string[] = []

async function start(home?: string) {
  const fixture = await startPluginHarness({
    plugins: ['quirky.automations'],
    fakeSession: false,
    ...(home === undefined ? {} : { home })
  })
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})


const createParams = (overrides: Record<string, unknown> = {}) => ({
  name: 'Weekday audit',
  prompt: 'Review risky changes.',
  agentId: 'codex',
  projectId: 'repo-1',
  timezone: 'America/New_York',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  ...overrides
})

const call = (fixture: PluginHarness, method: string, params: Record<string, unknown> = {}) =>
  fixture.client.callAny(method, params)
const DAY_MS = 86_400_000

function storedDefinition(id: string, now: number, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id,
    name: id,
    prompt: 'Run the automation.',
    agentId: 'codex',
    projectId: `project-${id}`,
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    runContext: null,
    sourceContext: null,
    launchOverrides: null,
    precheck: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: now - 10 * DAY_MS,
    enabled: false,
    nextRunAt: now - 7 * DAY_MS,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 2880,
    createdAt: now - DAY_MS,
    updatedAt: now - DAY_MS,
    ...overrides
  }
}

function latestNineUtc(now: number): number {
  const today = new Date(now)
  today.setUTCHours(9, 0, 0, 0)
  const occurrence = today.getTime()
  return occurrence <= now ? occurrence : occurrence - DAY_MS
}

function seedDefinitions(home: string, definitions: AutomationDefinition[]): void {
  const opened = openPluginStore({ home, pluginId: 'quirky.automations', migrations, isActive: () => true })
  try {
    const store = createAutomationStore(opened.store)
    for (const definition of definitions) store.insert(definition)
  } finally {
    opened.close()
  }
}

describe('automations API', () => {
  test('creates, lists and shows durable definitions and honors creationKey idempotency', async () => {
    const fixture = await start()
    const blankName = await call(fixture, 'quirky.automations/create', createParams({ name: '  ', projectId: 'repo-0' })) as AutomationDefinition
    const created = await call(fixture, 'quirky.automations/create', createParams({ creationKey: 'request-1' })) as AutomationDefinition
    const repeated = await call(fixture, 'quirky.automations/create', createParams({ creationKey: 'request-1', name: 'Must not replace' })) as AutomationDefinition
    const listed = await call(fixture, 'quirky.automations/list') as AutomationDefinition[]
    const shown = await call(fixture, 'quirky.automations/show', { id: created.id }) as AutomationDefinition

    expect(created).toMatchObject({
      name: 'Weekday audit', prompt: 'Review risky changes.', agentId: 'codex', projectId: 'repo-1',
      timezone: 'America/New_York', enabled: true, workspaceMode: 'new_per_run', workspaceId: null,
      missedRunPolicy: 'run_once_within_grace', missedRunGraceMinutes: 720
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.nextRunAt).toBeGreaterThan(Date.now() - 1_000)
    expect(blankName.name).toBe('Untitled automation')
    expect(repeated).toEqual(created)
    expect(listed).toEqual([blankName, created])
    expect(shown).toEqual(created)
  })

  test('rejects invalid providers, schedules, zones and unknown fields without creating rows', async () => {
    const fixture = await start()
    await expect(call(fixture, 'quirky.automations/create', createParams({ agentId: 'opencode' }))).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(call(fixture, 'quirky.automations/create', createParams({ rrule: 'not a schedule' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', createParams({ timezone: 'Mars/Olympus' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', createParams({ prompt: '   ' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', { ...createParams(), nextRunAt: 1 })).rejects.toThrow()
    expect(await call(fixture, 'quirky.automations/list')).toEqual([])
  })

  test('publishes a changed event only after the definition is readable', async () => {
    const fixture = await start()
    const { client: observer } = await fixture.h.connectWithEvents()
    const { promise: changed, resolve } = Promise.withResolvers<QuirkyEvent>()
    const unsubscribe = observer.onEvent((event) => {
      if (event.type === 'quirky.automations/changed') resolve(event)
    })
    const created = await call(fixture, 'quirky.automations/create', createParams()) as AutomationDefinition
    const event = await changed
    unsubscribe()
    if (!('data' in event)) throw new Error('Automation event is missing its committed mutation data')
    expect(event.data).toMatchObject({ reason: 'definition', automationId: created.id })
    expect(await call(fixture, 'quirky.automations/show', { id: created.id })).toEqual(created)
  })

  test('pause preserves the schedule cursor and still allows a manual run', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams({ enabled: false, precheck: { command: 'false', timeoutSeconds: 5 } })) as AutomationDefinition
    const edited = await call(fixture, 'quirky.automations/edit', {
      id: created.id, name: '  Renamed  ', prompt: 'A new prompt', enabled: true
    }) as AutomationDefinition
    const paused = await call(fixture, 'quirky.automations/edit', { id: created.id, enabled: false }) as AutomationDefinition
    const rescheduled = await call(fixture, 'quirky.automations/edit', {
      id: created.id, rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=30'
    }) as AutomationDefinition
    const run = await call(fixture, 'quirky.automations/run', { id: created.id }) as AutomationRun

    expect(edited.name).toBe('Renamed')
    expect(edited.nextRunAt).toBe(created.nextRunAt)
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBe(edited.nextRunAt)
    expect(rescheduled.enabled).toBe(false)
    expect(rescheduled.dtstart).toBeGreaterThan(created.dtstart)
    expect(rescheduled.nextRunAt).toBeGreaterThan(Date.now() - 10_000)
    expect(run).toMatchObject({ automationId: created.id, trigger: 'manual', status: 'pending', sessionKind: 'structured' })
    expect(run.title).toBe(`${paused.name} run 1`)
    expect(run.scheduledFor).toBeGreaterThanOrEqual(Date.now() - 10_000)
    expect((await call(fixture, 'quirky.automations/show', { id: created.id }) as AutomationDefinition).nextRunAt).toBe(rescheduled.nextRunAt)
  })
  test('normalizes workspace modes and clears nullable definition fields', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams({
      workspaceMode: 'existing', workspaceId: 'workspace-1', baseBranch: 'ignored', setupDecision: 'run', reuseSession: true,
      runContext: { kind: 'workspace-run', projectId: 'repo-1' }, sourceContext: { source: 'task' },
      launchOverrides: { model: 'opus', optionValues: { effort: 'high' } }, precheck: { command: 'npm test', timeoutSeconds: 99 }
    })) as AutomationDefinition
    expect(created).toMatchObject({ workspaceMode: 'existing', workspaceId: 'workspace-1', baseBranch: null, reuseSession: true })
    expect(created).not.toHaveProperty('setupDecision')

    const newWorkspace = await call(fixture, 'quirky.automations/edit', {
      id: created.id, workspaceMode: 'new_per_run', workspaceId: 'ignored', reuseSession: true, baseBranch: 'release', setupDecision: 'skip',
      runContext: null, sourceContext: null, launchOverrides: null, precheck: null
    }) as AutomationDefinition
    expect(newWorkspace).toMatchObject({
      workspaceMode: 'new_per_run', workspaceId: null, reuseSession: false, baseBranch: 'release', setupDecision: 'skip',
      runContext: null, sourceContext: null, launchOverrides: null, precheck: null
    })

    const existingWorkspace = await call(fixture, 'quirky.automations/edit', {
      id: created.id, workspaceMode: 'existing', workspaceId: 'workspace-2', baseBranch: 'ignored', setupDecision: 'run'
    }) as AutomationDefinition
    expect(existingWorkspace).toMatchObject({ workspaceMode: 'existing', workspaceId: 'workspace-2', baseBranch: null })
    expect(existingWorkspace).not.toHaveProperty('setupDecision')
  })

  test('claims and records a structured result once with bounded output and terminal statuses', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams({ enabled: false })) as AutomationDefinition
    const run = await call(fixture, 'quirky.automations/run', { id: definition.id }) as AutomationRun
    const claimed = await call(fixture, 'quirky.automations/claim', { runId: run.id }) as AutomationRun
    expect(claimed.status).toBe('dispatching')
    expect(claimed.startedAt).toBeDefined()
    await expect(call(fixture, 'quirky.automations/claim', { runId: run.id })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })

    const dispatched = await call(fixture, 'quirky.automations/updateRun', {
      runId: run.id,
      patch: { status: 'dispatched', outputSnapshot: { format: 'plain_text', content: `${'é'.repeat(131_071)}🙂tail`, capturedAt: Date.now(), truncated: false } }
    }) as AutomationRun
    expect(dispatched.status).toBe('dispatched')
    expect(dispatched.dispatchedAt).toBeDefined()
    expect(new TextEncoder().encode(dispatched.outputSnapshot?.content ?? '').byteLength).toBeLessThanOrEqual(262_144)
    expect(dispatched.outputSnapshot?.truncated).toBe(true)
    expect(dispatched.outputSnapshot?.content).toBe('é'.repeat(131_071))

    const completed = await call(fixture, 'quirky.automations/updateRun', { runId: run.id, patch: { status: 'completed' } }) as AutomationRun
    expect(completed.completedAt).toBeDefined()
    await expect(call(fixture, 'quirky.automations/updateRun', { runId: run.id, patch: { status: 'pending' } })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    const page = await call(fixture, 'quirky.automations/runs', { automationId: definition.id, limit: 0 }) as AutomationRunsPage
    expect(page.runs).toEqual([completed])
  })

  test('real CLI create, edit, run and runs flags operate through the API', async () => {
    const fixture = await start()
    const cli = (args: string[]) => runCli(args, { home: fixture.h.home, cwd: fixture.h.home })
    const createReply = await cli([
      'automations', 'create', '--name', 'CLI audit', '--prompt', 'Review changes.', '--provider', 'codex',
      '--project', 'repo-cli', '--trigger', 'daily', '--timezone', 'UTC', '--missed-run-grace-minutes', '0',
      '--model', 'gpt-5-codex', '--effort', 'high', '--disabled', '--json'
    ])
    expect(createReply.code).toBe(0)
    const created = JSON.parse(createReply.stdout) as AutomationDefinition
    expect(created).toMatchObject({
      name: 'CLI audit', agentId: 'codex', projectId: 'repo-cli', enabled: false, missedRunGraceMinutes: 0,
      launchOverrides: { model: 'gpt-5-codex', optionValues: { effort: 'high' } }
    })

    const editReply = await cli([
      'automations', 'edit', created.id, '--name', 'CLI audit edited', '--enabled',
      '--model', 'inherit', '--effort', 'inherit', '--json'
    ])
    expect(editReply.code).toBe(0)
    const edited = JSON.parse(editReply.stdout) as AutomationDefinition
    expect(edited).toMatchObject({ id: created.id, name: 'CLI audit edited', enabled: true, launchOverrides: null })
    expect(edited.nextRunAt).toBe(created.nextRunAt)

    const runReply = await cli(['automations', 'run', created.id, '--json'])
    expect(runReply.code).toBe(0)
    const queued = JSON.parse(runReply.stdout) as AutomationRun
    expect(queued).toMatchObject({ automationId: created.id, trigger: 'manual', status: 'pending' })

    const runsReply = await cli(['automations', 'runs', created.id, '--limit', '1', '--json'])
    expect(runsReply.code).toBe(0)
    const history = JSON.parse(runsReply.stdout) as AutomationRunsPage
    expect(history.runs.map((run) => run.id)).toContain(queued.id)
    expect(await call(fixture, 'quirky.automations/show', { id: created.id })).toMatchObject({ name: edited.name, nextRunAt: edited.nextRunAt })
  })

  test('public tick catches up the latest due occurrence and isolates a malformed neighbor', async () => {
    const home = makeTempHome('qa-automation-tick-')
    temporaryHomes.push(home)
    const seedNow = Date.now()
    const latest = latestNineUtc(seedNow)
    const healthyId = randomUUID()
    const brokenId = randomUUID()
    const brokenCursor = seedNow - 7 * DAY_MS
    seedDefinitions(home, [
      storedDefinition(healthyId, seedNow, {
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: latest - 10 * DAY_MS,
        nextRunAt: latest - 7 * DAY_MS,
        missedRunGraceMinutes: 2880
      }),
      storedDefinition(brokenId, seedNow, {
        rrule: 'malformed stored schedule',
        dtstart: seedNow - 10 * DAY_MS,
        nextRunAt: brokenCursor
      })
    ])
    const fixture = await start(home)
    await call(fixture, 'quirky.automations/edit', { id: healthyId, enabled: true })
    await call(fixture, 'quirky.automations/edit', { id: brokenId, enabled: true })

    const tick = await call(fixture, 'quirky.automations/tick') as { now: number; evaluated: number }
    const scheduledFor = latestNineUtc(tick.now)
    expect(tick.evaluated).toBe(2)
    const healthyRuns = await call(fixture, 'quirky.automations/runs', { automationId: healthyId, limit: 100 }) as AutomationRunsPage
    expect(healthyRuns.runs).toHaveLength(1)
    expect(healthyRuns.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'pending', scheduledFor })
    const healthyAfter = await call(fixture, 'quirky.automations/show', { id: healthyId }) as AutomationDefinition
    expect(healthyAfter.nextRunAt).toBeGreaterThan(tick.now)

    const brokenRuns = await call(fixture, 'quirky.automations/runs', { automationId: brokenId, limit: 100 }) as AutomationRunsPage
    expect(brokenRuns.runs).toMatchObject([{ status: 'skipped_unavailable' }])
    expect((await call(fixture, 'quirky.automations/show', { id: brokenId }) as AutomationDefinition).nextRunAt).toBe(brokenCursor)
    await call(fixture, 'quirky.automations/tick')
    expect((await call(fixture, 'quirky.automations/runs', { automationId: healthyId, limit: 100 }) as AutomationRunsPage).runs).toHaveLength(1)
    expect((await call(fixture, 'quirky.automations/runs', { automationId: brokenId, limit: 100 }) as AutomationRunsPage).runs).toHaveLength(1)
  })

  test('schedule inspector reports both fold instants in the saved timezone', async () => {
    const fixture = await start()
    const result = await call(fixture, 'quirky.automations/schedule', {
      rrule: '30 1 * * *', timezone: 'America/New_York',
      dtstart: Date.parse('2026-10-31T00:00:00.000Z'),
      after: Date.parse('2026-11-01T05:31:00.000Z'),
      now: Date.parse('2026-11-01T06:30:00.000Z')
    }) as { valid: boolean; runnable: boolean; description: { kind: string }; next: number; latest: number | null }
    expect(result).toMatchObject({ valid: true, runnable: true, description: { kind: 'daily' } })
    expect(result.next).toBe(Date.parse('2026-11-01T06:30:00.000Z'))
    expect(result.latest).toBe(Date.parse('2026-11-01T06:30:00.000Z'))
  })

  test('schedule inspector preserves cron step, day-OR and legacy input semantics', async () => {
    const fixture = await start()
    const inspect = (rrule: string, after: string) => call(fixture, 'quirky.automations/schedule', {
      rrule, timezone: 'UTC', dtstart: Date.parse('2026-10-01T00:00:00Z'),
      after: Date.parse(after), now: Date.parse(after)
    }) as Promise<{ valid: boolean; runnable: boolean; next: number | null }>
    const stepped = await inspect('5/20 * * * *', '2026-10-27T00:06:00Z')
    expect(stepped.next).toBe(Date.parse('2026-10-27T00:25:00Z'))
    const eitherDay = await inspect('0 9 1 * MON', '2026-10-27T09:00:00Z')
    expect(eitherDay.next).toBe(Date.parse('2026-11-01T09:00:00Z'))
    const wildcardDay = await inspect('0 9 */2 * MON', '2026-10-27T09:00:00Z')
    expect(wildcardDay.next).toBe(Date.parse('2026-11-09T09:00:00Z'))
    const legacy = await inspect('*/90 * * * *', '2026-10-27T00:06:00Z')
    expect(legacy).toMatchObject({ valid: false, runnable: true, next: Date.parse('2026-10-27T01:00:00Z') })
    const impossible = await inspect('0 9 30 2 *', '2026-10-27T00:06:00Z')
    expect(impossible).toMatchObject({ valid: false, runnable: false, next: null })
    await expect(call(fixture, 'quirky.automations/create', createParams({ rrule: '*/90 * * * *' })))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('bounds persisted JSON metadata without rejecting the exact byte limit', async () => {
    const fixture = await start()
    const atLimit = { text: 'x'.repeat(64 * 1024 - 11) }
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(64 * 1024)
    const definition = await call(fixture, 'quirky.automations/create', createParams({
      enabled: false, sourceContext: atLimit
    })) as AutomationDefinition
    const oversized = { text: atLimit.text + 'x' }
    await expect(call(fixture, 'quirky.automations/edit', {
      id: definition.id, runContext: oversized
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect((await call(fixture, 'quirky.automations/show', { id: definition.id }) as AutomationDefinition).runContext).toBeNull()
    const run = await call(fixture, 'quirky.automations/run', { id: definition.id }) as AutomationRun
    for (const field of ['launchSettings', 'usage'] as const) {
      await expect(call(fixture, 'quirky.automations/updateRun', {
        runId: run.id, patch: { [field]: oversized }
      })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })

  test('history pages preserve active runs while final retention advances run numbers', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams({ enabled: false })) as AutomationDefinition
    const finalizedIds = new Set<string>()
    for (let number = 0; number < 101; number++) {
      const run = await call(fixture, 'quirky.automations/run', { id: definition.id }) as AutomationRun
      finalizedIds.add(run.id)
      await call(fixture, 'quirky.automations/updateRun', {
        runId: run.id, patch: { status: 'dispatch_failed', error: 'Dispatch refused before launch' }
      })
    }
    const active: AutomationRun[] = []
    for (const status of ['pending', 'dispatching', 'dispatched'] as const) {
      let run = await call(fixture, 'quirky.automations/run', { id: definition.id }) as AutomationRun
      if (status !== 'pending') run = await call(fixture, 'quirky.automations/claim', { runId: run.id }) as AutomationRun
      if (status === 'dispatched') {
        run = await call(fixture, 'quirky.automations/updateRun', {
          runId: run.id, patch: { status, sessionId: 'recorded-structured-session' }
        }) as AutomationRun
      }
      active.push(run)
    }
    const other = await call(fixture, 'quirky.automations/create', createParams({ name: 'Other history', enabled: false })) as AutomationDefinition
    const foreignRun = await call(fixture, 'quirky.automations/run', { id: other.id }) as AutomationRun
    const history: AutomationRun[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await call(fixture, 'quirky.automations/runs', {
        automationId: definition.id, limit: 17, ...(cursor === undefined ? {} : { cursor })
      }) as AutomationRunsPage
      history.push(...page.runs)
      cursor = page.nextCursor ?? undefined
      if (cursor !== undefined) {
        expect(seenCursors.has(cursor)).toBe(false)
        seenCursors.add(cursor)
      }
    } while (cursor !== undefined)
    const retainedIds = new Set(history.map((run) => run.id))
    expect(history).toHaveLength(103)
    expect(retainedIds.size).toBe(103)
    expect(history.filter((run) => finalizedIds.has(run.id))).toHaveLength(100)
    expect(history.filter((run) => active.some((candidate) => candidate.id === run.id))).toEqual(expect.arrayContaining(active))
    expect(retainedIds.has(foreignRun.id)).toBe(false)
    const next = await call(fixture, 'quirky.automations/run', { id: definition.id }) as AutomationRun
    expect(next.runNumber).toBe(105)
    await expect(call(fixture, 'quirky.automations/runs', {
      automationId: definition.id, cursor: 'not-a-cursor'
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('remove cascades run history and subsequent lookups are not-found', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams({ enabled: false })) as AutomationDefinition
    await call(fixture, 'quirky.automations/run', { id: definition.id })
    await call(fixture, 'quirky.automations/remove', { id: definition.id, yes: true })
    expect(await call(fixture, 'quirky.automations/runs', { automationId: definition.id })).toMatchObject({ runs: [], nextCursor: null })
    await expect(call(fixture, 'quirky.automations/show', { id: definition.id })).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(call(fixture, 'quirky.automations/run', { id: definition.id })).rejects.toThrow()
  })
})
