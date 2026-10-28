import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginStore, StoreMigration, StoreValue } from '@quirky/protocol'
import type { AutomationDefinition } from '../types'
import { createAutomationService, type AutomationService, type AutomationServiceContext } from '../service'
import { createAutomationStore, migrations } from '../store'

const fixtures: Array<{ database: Database; service: AutomationService }> = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.dispose()
    fixture.database.close()
  }
})

function makeFixture(initialNow: number) {
  let now = initialNow
  const database = new Database(':memory:')
  const pluginStore: PluginStore = {
    get version() { return migrations.length },
    run(sql: string, ...params: StoreValue[]) {
      const result = database.query(sql).run(...params)
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]) {
      return database.query(sql).get(...params) as T | null
    },
    all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]) {
      return database.query(sql).all(...params) as T[]
    },
    exec(sql: string) { database.exec(sql) },
    transaction<T>(work: () => T) { return database.transaction(work)() }
  }
  let migrated = false
  const context: AutomationServiceContext = {
    pluginId: 'quirky.automations',
    openStore(steps: StoreMigration[]) {
      if (!migrated) {
        for (const step of steps) {
          if (typeof step === 'string') database.exec(step)
          else step(pluginStore)
        }
        migrated = true
      }
      return pluginStore
    },
    emit() { return true },
    error(kind, message) { return Object.assign(new Error(message), { kind }) },
    log() {}
  }
  const service = createAutomationService(context, () => now)
  const fixture = {
    database,
    service,
    store: createAutomationStore(pluginStore),
    setNow(value: number) { now = value }
  }
  fixtures.push(fixture)
  return fixture
}

function definition(id: string, now: number, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
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
    dtstart: now - 60_000,
    enabled: true,
    nextRunAt: now - 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    ...overrides
  }
}

describe('automation scheduler service', () => {
  test('catches up only the latest elapsed occurrence and advances the durable cursor', async () => {
    const t0 = Date.parse('2026-10-27T08:00:00.000Z')
    const fixture = makeFixture(t0)
    const created = await fixture.service.create({
      name: 'Daily', prompt: 'Check', agentId: 'claude', projectId: 'repo', timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: t0
    })
    fixture.setNow(Date.parse('2026-11-01T10:00:00.000Z'))

    await fixture.service.tick()
    const first = fixture.service.runs({ automationId: created.id, limit: 100 })
    const definitionAfter = fixture.service.show({ id: created.id }) as AutomationDefinition
    await fixture.service.tick()

    expect(first.runs).toHaveLength(1)
    expect(first.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'pending', scheduledFor: Date.parse('2026-11-01T09:00:00.000Z') })
    expect(definitionAfter.nextRunAt).toBe(Date.parse('2026-11-02T09:00:00.000Z'))
    expect(fixture.service.runs({ automationId: created.id, limit: 100 }).runs).toHaveLength(1)
  })

  test('accepts the exact grace plus 120-second boundary and skips one millisecond beyond it', async () => {
    const occurrence = Date.parse('2026-10-27T09:00:00.000Z')
    for (const offset of [120_000, 120_001]) {
      const fixture = makeFixture(Date.parse('2026-10-27T08:00:00.000Z'))
      const created = await fixture.service.create({
        name: `Boundary ${offset}`, prompt: 'Check', agentId: 'codex', projectId: `repo-${offset}`,
        timezone: 'UTC', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: occurrence - 60_000,
        missedRunGraceMinutes: 0
      })
      fixture.setNow(occurrence + offset)
      await fixture.service.tick()
      const run = fixture.service.runs({ automationId: created.id, limit: 1 }).runs[0]
      expect(run?.status).toBe(offset === 120_000 ? 'pending' : 'skipped_missed')
    }
  })

  test('paused definitions wait, malformed stored schedules fold without blocking a healthy neighbor', async () => {
    const t0 = Date.parse('2026-10-27T08:00:00.000Z')
    const fixture = makeFixture(t0)
    const paused = await fixture.service.create({
      name: 'Paused', prompt: 'Check', agentId: 'codex', projectId: 'paused-project', timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: t0, enabled: false
    })
    fixture.store.insert(definition('broken-record', t0, { rrule: 'broken', nextRunAt: t0 - 1 }))
    fixture.setNow(Date.parse('2026-10-30T10:00:00.000Z'))

    await fixture.service.tick()
    expect(fixture.service.runs({ automationId: paused.id, limit: 10 }).runs).toEqual([])
    expect(fixture.service.show({ id: 'broken-record' })).toMatchObject({ nextRunAt: t0 - 1 })
    expect(fixture.service.runs({ automationId: 'broken-record', limit: 10 })).toMatchObject({
      runs: [{ status: 'skipped_unavailable', error: expect.any(String) }]
    })

    await fixture.service.edit({ id: paused.id, enabled: true })
    await fixture.service.tick()
    expect(fixture.service.runs({ automationId: paused.id, limit: 10 }).runs).toHaveLength(1)
    expect(fixture.service.runs({ automationId: 'broken-record', limit: 10 }).runs).toHaveLength(1)
  })

  test('concurrent manual requests get distinct durable runs and deletion leaves no orphan history', async () => {
    const now = Date.parse('2026-10-27T08:00:00.000Z')
    const fixture = makeFixture(now)
    const created = await fixture.service.create({
      name: 'Paused', prompt: 'Check', agentId: 'codex', projectId: 'repo', timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', enabled: false
    })
    const [first, second] = await Promise.all([
      fixture.service.run({ id: created.id }),
      fixture.service.run({ id: created.id })
    ])
    expect(first.id).not.toBe(second.id)
    expect([first.runNumber, second.runNumber].sort()).toEqual([1, 2])

    await Promise.allSettled([fixture.service.run({ id: created.id }), fixture.service.remove({ id: created.id })])
    expect(fixture.service.runs({ automationId: created.id, limit: 100 }).runs).toEqual([])
    expect(fixture.service.list({})).toEqual([])
  })

  test('startup immediately evaluates due work and dispose prevents later ticks', async () => {
    const t0 = Date.parse('2026-10-27T08:00:00.000Z')
    const fixture = makeFixture(t0)
    fixture.store.insert(definition('due-on-start', t0, {
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: t0 - 86_400_000,
      nextRunAt: Date.parse('2026-10-27T09:00:00.000Z')
    }))
    fixture.setNow(Date.parse('2026-10-27T09:00:00.000Z'))

    await fixture.service.start()
    expect(fixture.service.runs({ automationId: 'due-on-start', limit: 10 }).runs).toHaveLength(1)
    fixture.service.dispose()
    await fixture.service.tick()
    expect(fixture.service.runs({ automationId: 'due-on-start', limit: 10 }).runs).toHaveLength(1)
  })

  test('definition metadata keeps exact JSON byte bounds and rejects oversized edits', async () => {
    const fixture = makeFixture(Date.parse('2026-10-27T08:00:00.000Z'))
    const atLimit = { text: 'x'.repeat(64 * 1024 - 11) }
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(64 * 1024)
    const created = await fixture.service.create({
      name: 'Core bounds', prompt: 'Check', agentId: 'codex', projectId: 'repo', timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', enabled: false, sourceContext: atLimit
    })
    const oversized = { text: atLimit.text + 'x' }
    await expect(fixture.service.edit({ id: created.id, runContext: oversized })).rejects.toThrow()
  })

})
