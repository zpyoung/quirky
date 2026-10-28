import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import {
  boot,
  call,
  createFolderProject,
  createGitProject,
  createWorktree,
  extras,
  fakeClock,
  type ActivityProjection,
  type ExtrasState,
  type TestClock,
  type TestEnvironment
} from './support'

setDefaultTimeout(20_000)

// A past fake epoch means restoring Date.now also expires shared wall-clock deadlines.
const BASE = Date.now() - 60_000
const DAY = 86_400_000
const WEEK = 7 * DAY

let env: TestEnvironment | null = null
let clock: TestClock | null = null
afterEach(async () => {
  clock?.restore()
  clock = null
  await env?.harness.cleanup()
  env = null
})

const row = (projection: ActivityProjection, worktreeId: string) => {
  const found = projection.workspaces.find((workspace) => workspace.worktreeId === worktreeId)
  expect(found).toBeDefined()
  return found!
}

describe('workspace activity projection', () => {
  test('uses an inclusive rolling cutoff, keeps the selected workspace, and clears activity-only counts', async () => {
    env = await boot()
    const currentEnv = env
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const project = await createGitProject(currentEnv.client)
      const old = await createWorktree(currentEnv.client, project.repo.id, 'old')
      const folder = await createFolderProject(currentEnv.client)

      await extras(currentEnv.client, 'activate', { worktree: project.main.id })
      const beforeBoundary = await extras<ActivityProjection>(currentEnv.client, 'projection')
      const oldActivity = row(beforeBoundary, old.id).activityAt
      const folderActivity = row(beforeBoundary, folder.primary.id).activityAt
      testClock.set(Math.max(oldActivity, folderActivity) + 1)
      const boundary = await createWorktree(currentEnv.client, project.repo.id, 'boundary')

      const all = await extras<ActivityProjection>(currentEnv.client, 'projection')
      const boundaryActivity = row(all, boundary.id).activityAt
      expect(oldActivity).toBeGreaterThan(0)
      expect(folderActivity).toBeGreaterThan(0)
      expect(boundaryActivity).toBeGreaterThan(oldActivity)
      expect(boundaryActivity).toBeGreaterThan(folderActivity)
      expect(new Set(all.visibleIds)).toEqual(new Set([project.main.id, old.id, folder.primary.id, boundary.id]))
      expect(all.hiddenIds).toEqual([])
      expect(all.filterCount).toBe(0)

      await extras(currentEnv.client, 'set', { workspaceActivityWindow: 'custom', workspaceActivityCustomDays: 7 })
      testClock.set(boundaryActivity + WEEK)
      const onCutoff = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(onCutoff.visibleIds).toContain(boundary.id)
      expect(onCutoff.hiddenIds).toContain(old.id)
      expect(onCutoff.hiddenIds).toContain(folder.primary.id)
      expect(row(onCutoff, boundary.id)).toMatchObject({ activityAt: boundaryActivity, reason: 'recent' })
      expect(row(onCutoff, project.main.id).reason).toBe('selected')
      expect(onCutoff.hiddenCount).toBe(2)
      expect(onCutoff.filterCount).toBe(1)

      testClock.set(boundaryActivity + WEEK + 1)
      const oneMillisecondPast = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(oneMillisecondPast.visibleIds).toContain(project.main.id)
      expect(oneMillisecondPast.hiddenIds).toContain(old.id)
      expect(oneMillisecondPast.hiddenIds).toContain(folder.primary.id)
      expect(oneMillisecondPast.hiddenIds).toContain(boundary.id)
      expect(row(oneMillisecondPast, project.main.id).reason).toBe('selected')
      expect(row(oneMillisecondPast, old.id).reason).toBe('old')
      expect(row(oneMillisecondPast, folder.primary.id).reason).toBe('old')
      expect(row(oneMillisecondPast, boundary.id).reason).toBe('old')
      expect(oneMillisecondPast.hiddenCount).toBe(3)
      expect(oneMillisecondPast.filterCount).toBe(1)

      await extras(currentEnv.client, 'set', { workspaceActivityWindow: 'all' })
      const cleared = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(cleared.preferences.workspaceActivityWindow).toBe('all')
      expect(cleared.hiddenIds).toEqual([])
      expect(cleared.hiddenCount).toBe(0)
      expect(cleared.filterCount).toBe(0)
    })
  })

  test('keeps workspaces at the inclusive cutoff for every activity window', async () => {
    env = await boot()
    const currentEnv = env
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const project = await createGitProject(currentEnv.client)
      const feature = await createWorktree(currentEnv.client, project.repo.id, 'window-boundary')
      const initial = await extras<ActivityProjection>(currentEnv.client, 'projection')
      const activityAt = row(initial, feature.id).activityAt
      expect(activityAt).toBeGreaterThan(0)

      const windows = [
        { window: 'today', days: 1 },
        { window: 'custom', days: 4 },
        { window: 'week', days: 7 },
        { window: 'month', days: 30 }
      ] as const
      for (const { window, days } of windows) {
        await extras(currentEnv.client, 'set', {
          workspaceActivityWindow: window,
          ...(window === 'custom' ? { workspaceActivityCustomDays: days } : {})
        })
        testClock.set(activityAt + days * DAY)
        const onBoundary = await extras<ActivityProjection>(currentEnv.client, 'projection')
        expect(onBoundary.visibleIds).toContain(feature.id)
        expect(row(onBoundary, feature.id).reason).toBe('recent')

        testClock.set(activityAt + days * DAY + 1)
        const oneMillisecondPast = await extras<ActivityProjection>(currentEnv.client, 'projection')
        expect(oneMillisecondPast.hiddenIds).toContain(feature.id)
        expect(row(oneMillisecondPast, feature.id).reason).toBe('old')
      }
    })
  })
  test('keeps old workspaces hidden when positive visit activity precedes newer fallbacks', async () => {
    env = await boot()
    const currentEnv = env
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const project = await createGitProject(currentEnv.client)
      const visited = await createWorktree(currentEnv.client, project.repo.id, 'visited-before-fallbacks')
      const creationOnly = await createWorktree(currentEnv.client, project.repo.id, 'creation-fallback')
      const repositoryOnly = await createWorktree(currentEnv.client, project.repo.id, 'repository-fallback')

      const activated = await extras<ExtrasState>(currentEnv.client, 'activate', { worktree: visited.id })
      const visitKey = `${visited.id}@${activated.active!.instanceId}`
      testClock.set(BASE + 10)
      const departed = await extras<ExtrasState>(currentEnv.client, 'activate', { worktree: null })
      const visitAt = departed.visits[visitKey]
      const departureAt = departed.exits[visitKey]
      expect(departureAt).toBeGreaterThan(visitAt)

      const repoAddedAt = BASE + 3 * DAY
      const visitedCreatedAt = BASE + 5 * DAY
      const creationOnlyAt = BASE + 6 * DAY
      expect(repoAddedAt).toBeGreaterThan(departureAt)
      expect(visitedCreatedAt).toBeGreaterThan(departureAt)
      const worktreeStore = new Database(join(currentEnv.harness.home, 'plugin-data', 'quirky.worktree', 'store.db'))
      const repoStore = new Database(join(currentEnv.harness.home, 'plugin-data', 'quirky.repo', 'store.db'))
      try {
        worktreeStore.query('UPDATE worktrees SET created_at = ?, last_activity_at = 0 WHERE id = ?')
          .run(visitedCreatedAt, visited.id)
        worktreeStore.query('UPDATE worktrees SET created_at = ?, last_activity_at = 0 WHERE id = ?')
          .run(creationOnlyAt, creationOnly.id)
        worktreeStore.query('UPDATE worktrees SET created_at = 0, last_activity_at = 0 WHERE id = ?')
          .run(repositoryOnly.id)
        repoStore.query('UPDATE repos SET added_at = ? WHERE id = ?').run(repoAddedAt, project.repo.id)
      } finally {
        worktreeStore.close()
        repoStore.close()
      }

      const worktrees = await call<{ id: string; createdAt: number; lastActivityAt: number }[]>(
        currentEnv.client,
        'quirky.worktree/list'
      )
      const repository = (await call<{ id: string; addedAt: number }[]>(currentEnv.client, 'quirky.repo/list'))
        .find((repo) => repo.id === project.repo.id)!
      expect(worktrees.find((worktree) => worktree.id === visited.id)).toMatchObject({
        createdAt: visitedCreatedAt,
        lastActivityAt: 0
      })
      expect(worktrees.find((worktree) => worktree.id === creationOnly.id)).toMatchObject({
        createdAt: creationOnlyAt,
        lastActivityAt: 0
      })
      expect(worktrees.find((worktree) => worktree.id === repositoryOnly.id)).toMatchObject({
        createdAt: 0,
        lastActivityAt: 0
      })
      expect(repository.addedAt).toBe(repoAddedAt)

      await extras(currentEnv.client, 'set', { workspaceActivityWindow: 'today' })
      testClock.set(departureAt + DAY + 1)
      const oldVisited = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(row(oldVisited, visited.id).activityAt).toBe(departureAt)
      expect(oldVisited.hiddenIds).toContain(visited.id)
      expect(row(oldVisited, visited.id).reason).toBe('old')

      testClock.set(repoAddedAt + DAY + 1)
      const oldRepositoryFallback = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(row(oldRepositoryFallback, repositoryOnly.id).activityAt).toBe(repoAddedAt)
      expect(oldRepositoryFallback.hiddenIds).toContain(repositoryOnly.id)
      expect(row(oldRepositoryFallback, repositoryOnly.id).reason).toBe('old')

      testClock.set(creationOnlyAt + DAY + 1)
      const oldCreationFallback = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(row(oldCreationFallback, creationOnly.id).activityAt).toBe(creationOnlyAt)
      expect(oldCreationFallback.hiddenIds).toContain(creationOnly.id)
      expect(row(oldCreationFallback, creationOnly.id).reason).toBe('old')
    })
  })


  test('uses live runtime facts conservatively and keeps folder workspaces outside the sleeping sweep', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const sleeping = await createWorktree(env.client, project.repo.id, 'sleeping')
    const folder = await createFolderProject(env.client)

    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    const liveOnly = await extras<ActivityProjection>(env.client, 'projection')
    expect(liveOnly.visibleIds).toContain(project.main.id)
    expect(liveOnly.visibleIds).toContain(folder.primary.id)
    expect(liveOnly.hiddenIds).toContain(sleeping.id)
    expect(row(liveOnly, project.main.id)).toMatchObject({ live: false, reason: 'main' })
    expect(row(liveOnly, sleeping.id)).toMatchObject({ live: false, reason: 'sleeping' })
    expect(row(liveOnly, sleeping.id).error).toBeUndefined()
    expect(row(liveOnly, folder.primary.id).reason).toBe('folder')
    expect(liveOnly.hiddenCount).toBe(1)

    await extras(env.client, 'set', { alwaysShowDefaultBranchWorkspace: false })
    const withoutMainException = await extras<ActivityProjection>(env.client, 'projection')
    expect(withoutMainException.hiddenIds).toContain(project.main.id)
    expect(withoutMainException.visibleIds).toContain(folder.primary.id)

    env.harness.pty.failRequests('list', 'PTY runtime query unavailable')
    const unavailable = await extras<ActivityProjection>(env.client, 'projection')
    expect(unavailable.visibleIds).toContain(sleeping.id)
    expect(row(unavailable, sleeping.id)).toMatchObject({ live: null, reason: 'unknown', error: expect.any(String) })
    expect(unavailable.visibleIds).toContain(folder.primary.id)
    expect(row(unavailable, folder.primary.id).reason).toBe('folder')
  })
  test('treats a missing optional session-list contribution as absent runtime evidence', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const sleeping = await createWorktree(env.client, project.repo.id, 'session-list-absent')
    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    await call(env.client, 'plugin.disable', { id: 'method:quirky.session/list' })

    const projection = await extras<ActivityProjection>(env.client, 'projection')
    expect(projection.hiddenIds).toContain(sleeping.id)
    expect(row(projection, sleeping.id)).toMatchObject({ live: false, reason: 'sleeping' })
    expect(row(projection, sleeping.id).error).toBeUndefined()
  })

  test('keeps non-main workspaces visible when the enabled session provider fails', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const sleeping = await createWorktree(env.client, project.repo.id, 'session-list-failed')
    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })

    const sessionStore = new Database(join(env.harness.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      sessionStore.query('DROP TABLE sessions').run()
    } finally {
      sessionStore.close()
    }

    const projection = await extras<ActivityProjection>(env.client, 'projection')
    expect(projection.visibleIds).toContain(sleeping.id)
    expect(row(projection, sleeping.id)).toMatchObject({
      live: null,
      reason: 'unknown',
      error: expect.stringContaining('no such table: sessions')
    })
  })

  test('counts only fresh canonical agent evidence when terminal liveness is unavailable', async () => {
    env = await boot({ agentStatus: true })
    const project = await createGitProject(env.client)
    const feature = await createWorktree(env.client, project.repo.id, 'agent-work')
    const session = await call<{ id: string }>(env.client, 'quirky.session/create', {
      worktree: `id:${feature.id}`,
      agent: 'shell'
    })
    env.harness.pty.fact(session.id, { kind: 'program-status', body: 'state=working' })
    const status = await waitForAsync(async () => {
      const rows = await call<{ sessionId: string; state: string; display: string; evidenceAt: number }[]>(
        env!.client,
        'quirky.agent-status/list'
      )
      return rows.find((entry) => entry.sessionId === session.id && entry.display === 'working')
    }, 5_000)
    expect(status).toMatchObject({ state: 'working', display: 'working', evidenceAt: expect.any(Number) })
    env.harness.pty.sessions.delete(session.id)
    env.harness.pty.failRequests('list', 'PTY runtime provider unavailable')

    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    const fresh = await extras<ActivityProjection>(env.client, 'projection')
    expect(fresh.visibleIds).toContain(feature.id)
    expect(row(fresh, feature.id)).toMatchObject({ live: true, reason: 'live' })
    env.harness.pty.failRequests('list', null)

    const statusStore = new Database(join(env.harness.home, 'plugin-data', 'quirky.agent-status', 'store.db'))
    try {
      const stored = statusStore.query('SELECT row FROM rows WHERE session_id = ?').get(session.id) as { row: string } | null
      if (!stored) throw new Error('canonical agent status row was not persisted')
      const agentRow = JSON.parse(stored.row) as { evidenceAt: number }
      agentRow.evidenceAt = Date.now() - 30 * 60_000 - 1
      statusStore.query('UPDATE rows SET row = ? WHERE session_id = ?').run(JSON.stringify(agentRow), session.id)
    } finally {
      statusStore.close()
    }
    const sessionRows = await call<{ id: string; agentStatus?: { display: string } }[]>(env.client, 'quirky.session/list')
    expect(sessionRows.find((entry) => entry.id === session.id)?.agentStatus?.display).toBe('working')
    const staleRows = await call<{ sessionId: string; display: string }[]>(env.client, 'quirky.agent-status/list')
    expect(staleRows.find((entry) => entry.sessionId === session.id)?.display).toBe('unverifiable')
    const stale = await extras<ActivityProjection>(env.client, 'projection')
    expect(stale.hiddenIds).toContain(feature.id)
    expect(row(stale, feature.id)).toMatchObject({ live: false, reason: 'sleeping' })
    env.harness.pty.failRequests('list', 'PTY runtime provider unavailable')
    const unavailable = await extras<ActivityProjection>(env.client, 'projection')
    expect(unavailable.visibleIds).toContain(feature.id)
    expect(row(unavailable, feature.id)).toMatchObject({
      live: null,
      reason: 'unknown',
      error: expect.stringContaining('PTY runtime provider unavailable')
    })
    env.harness.pty.failRequests('list', null)
    const failedStatusStore = new Database(join(env.harness.home, 'plugin-data', 'quirky.agent-status', 'store.db'))
    try {
      failedStatusStore.query('DROP TABLE rows').run()
    } finally {
      failedStatusStore.close()
    }
    const failedAgentProvider = await extras<ActivityProjection>(env.client, 'projection')
    expect(failedAgentProvider.visibleIds).toContain(feature.id)
    expect(row(failedAgentProvider, feature.id)).toMatchObject({
      live: null,
      reason: 'unknown',
      error: expect.stringContaining('no such table: rows')
    })

  })


  test('keeps observed session activity after its public session record is removed', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const before = await extras<ActivityProjection>(env.client, 'projection')
    const initialActivity = row(before, project.main.id).activityAt
    const watcher = await env.harness.connectWithEvents('cli')

    await waitForAsync(async () => (Date.now() > initialActivity ? true : undefined), 5_000)
    const session = await call<{ id: string; lastActivityAt: number }>(watcher.client, 'quirky.session/create', {
      worktree: `id:${project.main.id}`,
      agent: 'shell'
    })
    const observed = await waitForAsync(async () => {
      const projection = await extras<ActivityProjection>(env!.client, 'projection')
      return row(projection, project.main.id).activityAt >= session.lastActivityAt ? projection : undefined
    }, 5_000)
    const observedActivity = row(observed, project.main.id).activityAt
    expect(observedActivity).toBeGreaterThan(initialActivity)

    await call(watcher.client, 'quirky.session/close', { session: session.id })
    const afterRemoval = await extras<ActivityProjection>(env.client, 'projection')
    expect(row(afterRemoval, project.main.id).activityAt).toBeGreaterThanOrEqual(observedActivity)
  })

  test('accepts the largest safe custom window without losing positive activity timestamps', async () => {
    env = await boot()
    const currentEnv = env
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const project = await createGitProject(currentEnv.client)
      const older = await createWorktree(currentEnv.client, project.repo.id, 'older')
      await extras(currentEnv.client, 'set', {
        workspaceActivityWindow: 'custom',
        workspaceActivityCustomDays: Number.MAX_SAFE_INTEGER
      })
      testClock.set(BASE + WEEK + 1)

      const projection = await extras<ActivityProjection>(currentEnv.client, 'projection')
      expect(projection.visibleIds).toContain(project.main.id)
      expect(projection.visibleIds).toContain(older.id)
      expect(projection.hiddenIds).toEqual([])
      expect(projection.hiddenCount).toBe(0)
    })
  })

})
