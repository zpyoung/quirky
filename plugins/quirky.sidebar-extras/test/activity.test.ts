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

  test('uses maximum activity and departure recency before creation and repository fallbacks', async () => {
    env = await boot()
    const currentEnv = env
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const project = await createGitProject(currentEnv.client)
      const feature = await createWorktree(currentEnv.client, project.repo.id, 'visited')
      const initial = await extras<ActivityProjection>(currentEnv.client, 'projection')
      const initialWorktrees = await call<{ id: string; createdAt: number; lastActivityAt: number }[]>(
        currentEnv.client,
        'quirky.worktree/list'
      )
      const initialRepo = (await call<{ id: string; addedAt: number }[]>(currentEnv.client, 'quirky.repo/list'))
        .find((repo) => repo.id === project.repo.id)!
      const initialFeature = initialWorktrees.find((item) => item.id === feature.id)!
      expect(row(initial, feature.id).activityAt).toBe(Math.max(
        initialFeature.lastActivityAt,
        initialFeature.createdAt,
        initialRepo.addedAt
      ))

      await extras(currentEnv.client, 'activate', { worktree: project.main.id })
      testClock.set(BASE + 10)
      await extras(currentEnv.client, 'activate', { worktree: feature.id })
      testClock.set(BASE + 20)
      await extras(currentEnv.client, 'activate', { worktree: null })
      testClock.set(BASE + 30)
      const session = await call<{ worktreeId: string; lastActivityAt: number }>(
        currentEnv.client,
        'quirky.session/create',
        { worktree: `id:${project.main.id}`, agent: 'shell' }
      )

      const state = await extras<ExtrasState>(currentEnv.client, 'state')
      const worktrees = await call<{ id: string; instanceId: string; repoId: string; createdAt: number; lastActivityAt: number }[]>(
        currentEnv.client,
        'quirky.worktree/list'
      )
      const sessions = await call<{ worktreeId: string; lastActivityAt: number }[]>(currentEnv.client, 'quirky.session/list')
      const repos = await call<{ id: string; addedAt: number }[]>(currentEnv.client, 'quirky.repo/list')
      const projection = await extras<ActivityProjection>(currentEnv.client, 'projection')
      const featureStored = worktrees.find((item) => item.id === feature.id)!
      const mainStored = worktrees.find((item) => item.id === project.main.id)!
      const visitKey = `${feature.id}@${feature.instanceId}`
      expect(row(projection, feature.id).activityAt).toBe(Math.max(
        featureStored.lastActivityAt,
        state.visits[visitKey] ?? 0,
        state.exits[visitKey] ?? 0,
        featureStored.createdAt,
        repos.find((repo) => repo.id === featureStored.repoId)!.addedAt
      ))
      expect(row(projection, feature.id).activityAt).toBe(state.exits[visitKey])
      expect(row(projection, project.main.id).activityAt).toBe(Math.max(
        mainStored.lastActivityAt,
        Math.max(...sessions.filter((item) => item.worktreeId === project.main.id).map((item) => item.lastActivityAt)),
        state.visits[`${project.main.id}@${mainStored.instanceId}`] ?? 0,
        state.exits[`${project.main.id}@${mainStored.instanceId}`] ?? 0,
        mainStored.createdAt,
        repos.find((repo) => repo.id === mainStored.repoId)!.addedAt
      ))
      expect(row(projection, project.main.id).activityAt).toBe(session.lastActivityAt)
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

    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    const fresh = await extras<ActivityProjection>(env.client, 'projection')
    expect(fresh.visibleIds).toContain(feature.id)
    expect(row(fresh, feature.id)).toMatchObject({ live: true, reason: 'live' })

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
