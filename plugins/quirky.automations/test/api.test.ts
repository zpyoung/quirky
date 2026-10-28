import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage } from '../types'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { makeRepo, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { randomUUID } from 'node:crypto'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createAutomationStore, migrations } from '../store'

isolateGitConfig()
const fixtures: PluginHarness[] = []
const temporaryHomes: string[] = []

type AutomationHarness = PluginHarness & { projectId: string; projectPath: string; workspaceId: string }

async function start(home?: string): Promise<AutomationHarness> {
  const fixture = await startPluginHarness({
    plugins: ['quirky.repo', 'quirky.worktree', 'quirky.ask', 'quirky.agents', 'quirky.checks', 'quirky.structured', 'quirky.session', 'quirky.automations'],
    realGit: true,
    fakeSession: false,
    ...(home === undefined ? {} : { home })
  })
  fixtures.push(fixture)
  const projectPath = makeRepo(join(fixture.h.home, 'projects', 'automation-api'))
  const project = await fixture.client.callAny('quirky.repo/add', { path: projectPath }) as { id: string }
  const worktreesRoot = join(fixture.h.home, 'worktrees')
  await fixture.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })
  const created = await fixture.client.callAny('quirky.worktree/create', {
    repo: project.id, name: 'automation-workspace'
  }) as { worktree: { id: string } }
  return { ...fixture, projectId: project.id, projectPath, workspaceId: created.worktree.id }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const createParams = (projectId: string, overrides: Record<string, unknown> = {}) => ({
  name: 'Weekday audit',
  prompt: 'Review risky changes.',
  agentId: 'codex',
  projectId,
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
    const blankName = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { name: '  ' })) as AutomationDefinition
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { creationKey: 'request-1' })) as AutomationDefinition
    rmSync(fixture.projectPath, { recursive: true, force: true })
    const repeated = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { creationKey: 'request-1', name: 'Must not replace' })) as AutomationDefinition
    const listed = await call(fixture, 'quirky.automations/list') as AutomationDefinition[]
    const shown = await call(fixture, 'quirky.automations/show', { id: created.id }) as AutomationDefinition

    expect(created).toMatchObject({
      name: 'Weekday audit', prompt: 'Review risky changes.', agentId: 'codex', projectId: fixture.projectId,
      timezone: 'America/New_York', enabled: true, workspaceMode: 'new_per_run', workspaceId: null,
      missedRunPolicy: 'run_once_within_grace', missedRunGraceMinutes: 720
    })
    expect(created.owner).toMatchObject({
      kind: 'local', repoId: fixture.projectId, repoPath: fixture.projectPath,
      workspaceId: null, workspacePath: null, workspaceInstanceId: null
    })
    expect(created.nextRunAt).toBeGreaterThan(Date.now() - 1_000)
    expect(blankName.name).toBe('Untitled automation')
    expect(repeated).toEqual(created)
    expect(listed).toEqual([blankName, created])
    expect(shown).toEqual(created)
  })
  test('captures local ownership, exposes target resolution, and preserves capture on unrelated edits', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      runContext: { repoPath: '/spoofed/path', workspacePath: '/spoofed/workspace' }
    })) as AutomationDefinition
    expect(created.owner).toMatchObject({
      kind: 'local', repoId: fixture.projectId, repoPath: fixture.projectPath,
      workspaceId: null, workspacePath: null, workspaceInstanceId: null
    })

    const target = await call(fixture, 'quirky.automations/target', { id: created.id }) as {
      available: boolean
      target?: { owner: AutomationDefinition['owner']; cwd: string }
    }
    expect(target).toMatchObject({ available: true, target: { owner: created.owner, cwd: fixture.projectPath } })

    const renamed = await call(fixture, 'quirky.automations/edit', {
      id: created.id, expectedOwner: created.owner, name: 'Renamed'
    }) as AutomationDefinition
    expect(renamed.owner).toEqual(created.owner)
  })
  test('normalizes project name/path selectors through create and explicit edit recapture', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams('name:automation-api', { enabled: false })) as AutomationDefinition
    expect(created.projectId).toBe(fixture.projectId)
    expect(created.owner?.repoId).toBe(fixture.projectId)

    const moved = await call(fixture, 'quirky.automations/edit', {
      id: created.id, projectId: `path:${fixture.projectPath}`
    }) as AutomationDefinition
    expect(moved.projectId).toBe(fixture.projectId)
    expect(moved.owner?.repoId).toBe(fixture.projectId)
    expect(await call(fixture, 'quirky.automations/target', { id: moved.id })).toMatchObject({
      available: true, target: { owner: moved.owner, cwd: fixture.projectPath }
    })
  })


  test('rejects an unknown project and invalid structured picks before creating a definition', async () => {
    const fixture = await start()
    await expect(call(fixture, 'quirky.automations/create', createParams('not-registered')))
      .rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      launchOverrides: { model: 'gpt-5.5', optionValues: { effort: 'not-a-supported-effort' } }
    }))).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      extraAgentArgs: '--unsafe'
    }))).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await call(fixture, 'quirky.automations/list')).toEqual([])
    const opaque = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      launchOverrides: { model: 'account-scoped-model' }, enabled: false
    })) as AutomationDefinition
    expect(opaque.launchOverrides?.model).toBe('account-scoped-model')
  })

  test('checks expectedOwner before edit, remove and manual run actions', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId)) as AutomationDefinition
    const staleOwner = { ...created.owner!, repoPath: `${fixture.projectPath}-moved` }
    await expect(call(fixture, 'quirky.automations/edit', {
      id: created.id, expectedOwner: staleOwner, name: 'Must not update'
    })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    await expect(call(fixture, 'quirky.automations/run', { id: created.id, expectedOwner: staleOwner }))
      .rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    await expect(call(fixture, 'quirky.automations/remove', { id: created.id, expectedOwner: staleOwner, yes: true }))
      .rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect((await call(fixture, 'quirky.automations/show', { id: created.id }) as AutomationDefinition).name).toBe(created.name)
    expect((await call(fixture, 'quirky.automations/runs', { automationId: created.id }) as AutomationRunsPage).runs).toEqual([])
  })

  test('rejects invalid providers, schedules, zones and unknown fields without creating rows', async () => {
    const fixture = await start()
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { agentId: 'opencode' }))).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { rrule: 'not a schedule' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { timezone: 'Mars/Olympus' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { prompt: '   ' }))).rejects.toThrow()
    await expect(call(fixture, 'quirky.automations/create', { ...createParams(fixture.projectId), nextRunAt: 1 })).rejects.toThrow()
    expect(await call(fixture, 'quirky.automations/list')).toEqual([])
  })

  test('publishes a changed event only after the definition is readable', async () => {
    const fixture = await start()
    const { client: observer } = await fixture.h.connectWithEvents()
    const { promise: changed, resolve } = Promise.withResolvers<QuirkyEvent>()
    const unsubscribe = observer.onEvent((event) => {
      if (event.type === 'quirky.automations/changed') resolve(event)
    })
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId)) as AutomationDefinition
    const event = await changed
    unsubscribe()
    if (!('data' in event)) throw new Error('Automation event is missing its committed mutation data')
    expect(event.data).toMatchObject({ reason: 'definition', automationId: created.id })
    expect(await call(fixture, 'quirky.automations/show', { id: created.id })).toEqual(created)
  })

  test('pause preserves the schedule cursor and still allows a manual run', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { enabled: false, precheck: { command: 'false', timeoutSeconds: 5 } })) as AutomationDefinition
    const edited = await call(fixture, 'quirky.automations/edit', {
      id: created.id, name: '  Renamed  ', prompt: 'A new prompt', enabled: true
    }) as AutomationDefinition
    const paused = await call(fixture, 'quirky.automations/edit', { id: created.id, enabled: false }) as AutomationDefinition
    const rescheduled = await call(fixture, 'quirky.automations/edit', {
      id: created.id, rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=30'
    }) as AutomationDefinition
    rmSync(fixture.projectPath, { recursive: true, force: true })
    const run = await call(fixture, 'quirky.automations/run', { id: created.id }) as AutomationRun

    expect(edited.name).toBe('Renamed')
    expect(edited.nextRunAt).toBe(created.nextRunAt)
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBe(edited.nextRunAt)
    expect(rescheduled.enabled).toBe(false)
    expect(rescheduled.dtstart).toBeGreaterThan(created.dtstart)
    expect(rescheduled.nextRunAt).toBeGreaterThan(Date.now() - 10_000)
    expect(run).toMatchObject({ automationId: created.id, trigger: 'manual', status: 'skipped_unavailable', sessionKind: 'structured' })
    expect(run.title).toBe(`${paused.name} run 1`)
    expect(run.scheduledFor).toBeGreaterThanOrEqual(Date.now() - 10_000)
    expect((await call(fixture, 'quirky.automations/show', { id: created.id }) as AutomationDefinition).nextRunAt).toBe(rescheduled.nextRunAt)
  })
  test('normalizes workspace modes and clears nullable definition fields', async () => {
    const fixture = await start()
    const created = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      workspaceMode: 'existing', workspaceId: fixture.workspaceId, baseBranch: 'ignored', setupDecision: 'run', reuseSession: true,
      runContext: { kind: 'workspace-run', projectId: fixture.projectId, repoPath: '/forged/path' }, sourceContext: { source: 'task' },
      launchOverrides: { model: 'gpt-5-codex', optionValues: { effort: 'high' } }, precheck: { command: 'npm test', timeoutSeconds: 99 }
    })) as AutomationDefinition
    expect(created).toMatchObject({ workspaceMode: 'existing', workspaceId: fixture.workspaceId, baseBranch: null, reuseSession: true })
    expect(created.owner?.workspaceId).toBe(fixture.workspaceId)
    expect(created).not.toHaveProperty('setupDecision')

    const newWorkspace = await call(fixture, 'quirky.automations/edit', {
      id: created.id, workspaceMode: 'new_per_run', workspaceId: 'ignored', reuseSession: true, baseBranch: 'release', setupDecision: 'skip',
      runContext: null, sourceContext: null, launchOverrides: null, precheck: null
    }) as AutomationDefinition
    expect(newWorkspace).toMatchObject({
      workspaceMode: 'new_per_run', workspaceId: null, reuseSession: false, baseBranch: 'release', setupDecision: 'skip',
      sourceContext: null, launchOverrides: null, precheck: null
    })
    expect(newWorkspace.owner?.workspaceId).toBeNull()

    const existingWorkspace = await call(fixture, 'quirky.automations/edit', {
      id: created.id, workspaceMode: 'existing', workspaceId: fixture.workspaceId, baseBranch: 'ignored', setupDecision: 'run'
    }) as AutomationDefinition
    expect(existingWorkspace).toMatchObject({ workspaceMode: 'existing', workspaceId: fixture.workspaceId, baseBranch: null })
    expect(existingWorkspace.owner?.workspaceId).toBe(fixture.workspaceId)
    const switched = await call(fixture, 'quirky.automations/edit', { id: created.id, agentId: 'claude' }) as AutomationDefinition
    expect(switched.launchOverrides).toBeNull()
    expect(switched.owner).toEqual(existingWorkspace.owner)
    expect(existingWorkspace).not.toHaveProperty('setupDecision')
  })

  test('manual dispatch persists truthful refusals and blocks forged terminal updates', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { enabled: false })) as AutomationDefinition
    rmSync(fixture.projectPath, { recursive: true, force: true })
    const first = await call(fixture, 'quirky.automations/run', {
      id: definition.id, expectedOwner: definition.owner
    }) as AutomationRun
    expect(first).toMatchObject({ automationId: definition.id, trigger: 'manual', status: 'skipped_unavailable' })
    expect(await call(fixture, 'quirky.automations/dispatch', { runId: first.id })).toEqual(first)
    await expect(call(fixture, 'quirky.automations/updateRun', {
      runId: first.id, patch: { status: 'completed' }
    })).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound })
    const second = await call(fixture, 'quirky.automations/run', {
      id: definition.id, expectedOwner: definition.owner
    }) as AutomationRun
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('skipped_unavailable')
  })

  test('real CLI create, edit, run and runs flags operate through the API', async () => {
    const fixture = await start()
    const cli = (args: string[]) => runCli(args, { home: fixture.h.home, cwd: fixture.h.home })
    const createReply = await cli([
      'automations', 'create', '--name', 'CLI audit', '--prompt', 'Review changes.', '--provider', 'codex',
      '--project', fixture.projectId, '--trigger', 'daily', '--timezone', 'UTC', '--missed-run-grace-minutes', '0',
      '--model', 'gpt-5-codex', '--effort', 'high', '--disabled', '--json'
    ])
    expect(createReply.code).toBe(0)
    const created = JSON.parse(createReply.stdout) as AutomationDefinition
    expect(created).toMatchObject({
      name: 'CLI audit', agentId: 'codex', projectId: fixture.projectId, enabled: false, missedRunGraceMinutes: 0,
      launchOverrides: { model: 'gpt-5-codex', optionValues: { effort: 'high' } }
    })
    const targetReply = await cli(['automations', 'target', created.id, '--json'])
    expect(targetReply.code).toBe(0)
    expect(JSON.parse(targetReply.stdout)).toMatchObject({
      available: true, target: { owner: created.owner, cwd: fixture.projectPath }
    })

    const editReply = await cli([
      'automations', 'edit', created.id, '--name', 'CLI audit edited', '--enabled',
      '--expected-owner', JSON.stringify(created.owner), '--model', 'inherit', '--effort', 'inherit', '--json'
    ])
    expect(editReply.code).toBe(0)
    const edited = JSON.parse(editReply.stdout) as AutomationDefinition
    expect(edited).toMatchObject({ id: created.id, name: 'CLI audit edited', enabled: true, launchOverrides: null })
    expect(edited.nextRunAt).toBe(created.nextRunAt)

    rmSync(fixture.projectPath, { recursive: true, force: true })
    const runReply = await cli(['automations', 'run', created.id, '--json'])
    expect(runReply.code).toBe(0)
    const queued = JSON.parse(runReply.stdout) as AutomationRun
    expect(queued).toMatchObject({ automationId: created.id, trigger: 'manual', status: 'skipped_unavailable' })
    const dispatchReply = await cli(['automations', 'dispatch', '--run-id', queued.id, '--json'])
    expect(dispatchReply.code).toBe(0)
    expect(JSON.parse(dispatchReply.stdout)).toEqual(queued)

    const runsReply = await cli(['automations', 'runs', created.id, '--limit', '1', '--json'])
    expect(runsReply.code).toBe(0)
    const history = JSON.parse(runsReply.stdout) as AutomationRunsPage
    expect(history.runs.map((run) => run.id)).toContain(queued.id)
    expect(await call(fixture, 'quirky.automations/show', { id: created.id })).toMatchObject({ name: edited.name, nextRunAt: edited.nextRunAt })
  })

  test('public tick catches up the latest due occurrence and isolates a malformed neighbor', async () => {
    const home = makeTempHome('qa-automation-tick-')
    temporaryHomes.push(home)
    const fixture = await start(home)
    const seedBase = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { enabled: false })) as AutomationDefinition
    const seedNow = Date.now()
    const latest = latestNineUtc(seedNow)
    const healthyId = randomUUID()
    const brokenId = randomUUID()
    const brokenCursor = seedNow - 7 * DAY_MS
    seedDefinitions(home, [
      storedDefinition(healthyId, seedNow, {
        projectId: fixture.projectId, owner: seedBase.owner, runContext: seedBase.runContext,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: latest - 10 * DAY_MS,
        nextRunAt: latest - 7 * DAY_MS, missedRunGraceMinutes: 2880,
        precheck: { command: 'false', timeoutSeconds: 5 }
      }),
      storedDefinition(brokenId, seedNow, {
        projectId: fixture.projectId, owner: seedBase.owner, runContext: seedBase.runContext,
        rrule: 'malformed stored schedule', dtstart: seedNow - 10 * DAY_MS, nextRunAt: brokenCursor
      })
    ])
    await call(fixture, 'quirky.automations/edit', { id: healthyId, enabled: true })
    await call(fixture, 'quirky.automations/edit', { id: brokenId, enabled: true })

    const tick = await call(fixture, 'quirky.automations/tick') as { now: number; evaluated: number }
    const scheduledFor = latestNineUtc(tick.now)
    expect(tick.evaluated).toBe(2)
    const healthyRuns = await call(fixture, 'quirky.automations/runs', { automationId: healthyId, limit: 100 }) as AutomationRunsPage
    expect(healthyRuns.runs).toHaveLength(1)
    expect(healthyRuns.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'skipped_precheck', scheduledFor })
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
    await expect(call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { rrule: '*/90 * * * *' })))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('bounds persisted JSON metadata without rejecting the exact byte limit', async () => {
    const fixture = await start()
    const atLimit = { text: 'x'.repeat(64 * 1024 - 11) }
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(64 * 1024)
    const definition = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, {
      enabled: false, sourceContext: atLimit
    })) as AutomationDefinition
    const oversized = { text: atLimit.text + 'x' }
    await expect(call(fixture, 'quirky.automations/edit', {
      id: definition.id, runContext: oversized
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect((await call(fixture, 'quirky.automations/show', { id: definition.id }) as AutomationDefinition).runContext).toEqual(definition.runContext)
  })

  test('history pages expose truthful final refusals with stable cursors', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { enabled: false })) as AutomationDefinition
    rmSync(fixture.projectPath, { recursive: true, force: true })
    const created: AutomationRun[] = []
    for (let index = 0; index < 3; index++) {
      created.push(await call(fixture, 'quirky.automations/run', {
        id: definition.id, expectedOwner: definition.owner
      }) as AutomationRun)
    }
    expect(new Set(created.map((run) => run.id)).size).toBe(3)
    expect(created.every((run) => run.status === 'skipped_unavailable')).toBe(true)

    const first = await call(fixture, 'quirky.automations/runs', { automationId: definition.id, limit: 2 }) as AutomationRunsPage
    expect(first.runs).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await call(fixture, 'quirky.automations/runs', {
      automationId: definition.id, limit: 2, cursor: first.nextCursor!
    }) as AutomationRunsPage
    expect([...first.runs, ...second.runs].map((run) => run.id).sort()).toEqual(created.map((run) => run.id).sort())
    expect(second.nextCursor).toBeNull()
    await expect(call(fixture, 'quirky.automations/runs', {
      automationId: definition.id, cursor: 'not-a-cursor'
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('remove cascades run history and subsequent lookups are not-found', async () => {
    const fixture = await start()
    const definition = await call(fixture, 'quirky.automations/create', createParams(fixture.projectId, { enabled: false })) as AutomationDefinition
    rmSync(fixture.projectPath, { recursive: true, force: true })
    await call(fixture, 'quirky.automations/run', { id: definition.id })
    await call(fixture, 'quirky.automations/remove', { id: definition.id, yes: true })
    expect(await call(fixture, 'quirky.automations/runs', { automationId: definition.id })).toMatchObject({ runs: [], nextCursor: null })
    await expect(call(fixture, 'quirky.automations/show', { id: definition.id })).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(call(fixture, 'quirky.automations/run', { id: definition.id })).rejects.toThrow()
  })
})
