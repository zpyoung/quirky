import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcErrorCode } from '../../../packages/protocol/src'
import { waitFor } from '../../../packages/daemon/test/helpers'
import {
  boot,
  call,
  createGitProject,
  createWorktree,
  extras,
  fakeClock,
  git,
  restart,
  type ExtrasState,
  type TestClock,
  type TestEnvironment
} from './support'

setDefaultTimeout(20_000)

// A past fake epoch means restoring Date.now also expires shared wall-clock deadlines.
const BASE = Date.now() - 60_000

let env: TestEnvironment | null = null
let clock: TestClock | null = null
afterEach(async () => {
  clock?.restore()
  clock = null
  await env?.harness.cleanup()
  env = null
})

const changedEvents = (events: { type: string }[]) => events.filter((event) => event.type === 'quirky.sidebar-extras/changed')

describe('sidebar-extras API', () => {
  test('publishes review preferences as changed only when they change', async () => {
    env = await boot()
    const watcher = await env.harness.connectWithEvents('cli')

    const state = await extras<ExtrasState>(watcher.client, 'state')
    expect(state.client).toBe('desktop')
    expect(state.preferences.hideCompletedReviewWorkspaces).toBe(false)
    expect(state.preferences.hidePassingCheckWorkspaces).toBe(false)
    const projection = await extras(watcher.client, 'projection')
    expect(projection).toMatchObject(state)
    expect(changedEvents(watcher.events)).toHaveLength(0)

    await extras(watcher.client, 'set', { workspaceActivityWindow: 'week' })
    await waitFor(() => (changedEvents(watcher.events).length > 0 ? true : undefined))
    expect(changedEvents(watcher.events)).toHaveLength(1)
    await extras(watcher.client, 'state')
    await extras(watcher.client, 'projection')
    expect(changedEvents(watcher.events)).toHaveLength(1)
    await extras(watcher.client, 'set', { hideCompletedReviewWorkspaces: true })
    await waitFor(() => (changedEvents(watcher.events).length > 1 ? true : undefined))
    const reviewChange = changedEvents(watcher.events).at(-1) as unknown as { data: ExtrasState }
    expect(reviewChange.data.client).toBe('desktop')
    expect(reviewChange.data.preferences).toMatchObject({
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: false
    })
    await extras(watcher.client, 'set', { hideCompletedReviewWorkspaces: true })
    expect(changedEvents(watcher.events)).toHaveLength(2)
  })

  test('serializes activation in arrival order, stamps identity visits and exits, and leaves reads idempotent', async () => {
    env = await boot()
    const currentEnv = env
    const project = await createGitProject(currentEnv.client)
    const feature = await createWorktree(currentEnv.client, project.repo.id, 'feature')
    const testClock = fakeClock(BASE)
    clock = testClock

    await testClock.run(async () => {
      const firstActivation = extras<ExtrasState>(currentEnv.client, 'activate', { worktree: `path:${project.main.path}` })
      const secondActivation = extras<ExtrasState>(currentEnv.client, 'activate', { worktree: `id:${feature.id}` })
      const [first, second] = await Promise.all([firstActivation, secondActivation])
      expect(first.active?.worktreeId).toBe(project.main.id)
      expect(second.active?.worktreeId).toBe(feature.id)

      const mainKey = `${project.main.id}@${first.active!.instanceId}`
      const featureKey = `${feature.id}@${second.active!.instanceId}`
      expect(first.visits).toEqual({ [mainKey]: BASE })
      expect(second.exits[mainKey]).toBe(BASE)
      expect(second.visits).toEqual({ [mainKey]: BASE, [featureKey]: BASE })

      testClock.set(BASE + 1)
      expect(await extras<ExtrasState>(currentEnv.client, 'state')).toEqual(second)
      await extras(currentEnv.client, 'projection')
      const repeated = await extras<ExtrasState>(currentEnv.client, 'activate', { worktree: feature.id })
      expect(repeated.active).toEqual(second.active)
      expect(repeated.visits).toEqual(second.visits)
      expect(repeated.exits).toEqual(second.exits)

      testClock.set(BASE + 2)
      const cleared = await extras<ExtrasState>(currentEnv.client, 'activate', { worktree: null })
      expect(cleared.active).toBeNull()
      expect(cleared.exits[featureKey]).toBe(BASE + 2)
      expect(cleared.visits).toEqual({ [mainKey]: BASE, [featureKey]: BASE })
    })
  })

  test('isolates clients, merges patches, validates before mutation, and restores legacy sleeping preferences', async () => {
    env = await boot()
    const initial = await extras<ExtrasState>(env.client, 'state')
    await expect(
      extras(env.client, 'set', { workspaceActivityWindow: 'month', workspaceActivityCustomDays: 0 })
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(initial)
    await expect(extras(env.client, 'set', { workspaceActivityWindow: 'not-a-window' })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(initial)
    await expect(extras(env.client, 'set', { workspaceActivityCustomDays: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(initial)

    for (const patch of [
      { hideCompletedReviewWorkspaces: 'true' },
      { hideCompletedReviewWorkspaces: null },
      { hidePassingCheckWorkspaces: 1 },
      { hidePassingCheckWorkspaces: 'false' }
    ]) {
      await expect(extras(env.client, 'set', { workspaceActivityWindow: 'month', ...patch })).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams
      })
      expect(await extras<ExtrasState>(env.client, 'state')).toEqual(initial)
    }

    const fromAll = await extras<ExtrasState>(env.client, 'set', { hideSleepingWorkspaces: true })
    expect(fromAll.preferences).toMatchObject({
      workspaceActivityWindow: 'live-only',
      workspaceActivityWindowBeforeLiveOnly: 'all'
    })
    expect((await extras<ExtrasState>(env.client, 'set', { showSleepingWorkspaces: true })).preferences.workspaceActivityWindow).toBe('all')

    const week = await extras<ExtrasState>(env.client, 'set', { workspaceActivityWindow: 'week' })
    expect((await extras<ExtrasState>(env.client, 'set', { workspaceActivityCustomDays: 6 })).preferences).toMatchObject({
      workspaceActivityWindow: 'week',
      workspaceActivityCustomDays: 6
    })
    const liveWeek = await extras<ExtrasState>(env.client, 'set', { hideSleepingWorkspaces: true })
    expect(liveWeek.preferences.workspaceActivityWindowBeforeLiveOnly).toBe('week')
    expect((await extras<ExtrasState>(env.client, 'set', { hideSleepingWorkspaces: false })).preferences.workspaceActivityWindow).toBe('week')
    expect((await extras<ExtrasState>(env.client, 'set', { showSleepingWorkspaces: true })).preferences.workspaceActivityWindow).toBe('week')

    const custom = await extras<ExtrasState>(env.client, 'set', {
      workspaceActivityWindow: 'custom',
      workspaceActivityCustomDays: 3
    })
    const liveCustom = await extras<ExtrasState>(env.client, 'set', { hideSleepingWorkspaces: true })
    expect(liveCustom.preferences.workspaceActivityWindowBeforeLiveOnly).toBe('custom')
    expect((await extras<ExtrasState>(env.client, 'set', { showSleepingWorkspaces: true })).preferences).toMatchObject({
      workspaceActivityWindow: 'custom',
      workspaceActivityCustomDays: 3
    })

    const explicitWins = await extras<ExtrasState>(env.client, 'set', {
      workspaceActivityWindow: 'month',
      hideSleepingWorkspaces: true
    })
    expect(explicitWins.preferences.workspaceActivityWindow).toBe('month')
    expect((await extras<ExtrasState>(env.client, 'set', { showSleepingWorkspaces: true })).preferences.workspaceActivityWindow).toBe('month')

    await extras(env.client, 'set', {
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: false
    })
    const phoneSet = await extras<ExtrasState>(env.client, 'set', {
      client: 'phone',
      workspaceActivityWindow: 'today',
      hideCompletedReviewWorkspaces: false,
      hidePassingCheckWorkspaces: true
    })
    expect(phoneSet.preferences).toMatchObject({
      workspaceActivityWindow: 'today',
      hideCompletedReviewWorkspaces: false,
      hidePassingCheckWorkspaces: true
    })
    expect((await extras<ExtrasState>(env.client, 'state')).preferences).toMatchObject({
      workspaceActivityWindow: 'month',
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: false
    })

    const firstSet = extras<ExtrasState>(env.client, 'set', { workspaceActivityWindow: 'week' })
    const secondSet = extras<ExtrasState>(env.client, 'set', {
      workspaceActivityWindow: 'custom',
      workspaceActivityCustomDays: 4
    })
    const [first, second] = await Promise.all([firstSet, secondSet])
    expect(first.preferences.workspaceActivityWindow).toBe('week')
    expect(second.preferences).toMatchObject({
      workspaceActivityWindow: 'custom',
      workspaceActivityCustomDays: 4,
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: false
    })
    expect((await extras<ExtrasState>(env.client, 'state')).preferences.workspaceActivityWindow).toBe('custom')
    expect(week.preferences.workspaceActivityWindow).toBe('week')
    expect(custom.preferences.workspaceActivityCustomDays).toBe(3)
  })

  test('persists preferences and visits across restart but resets activation and exit stamps', async () => {
    env = await boot()
    const currentEnv = env
    const project = await createGitProject(currentEnv.client)
    const feature = await createWorktree(currentEnv.client, project.repo.id, 'feature')
    const testClock = fakeClock(BASE)
    clock = testClock

    const { before, phoneBefore } = await testClock.run(async () => {
      await extras(currentEnv.client, 'set', {
        workspaceActivityWindow: 'week',
        hideCompletedReviewWorkspaces: true,
        hidePassingCheckWorkspaces: false
      })
      await extras(currentEnv.client, 'set', {
        client: 'phone',
        workspaceActivityWindow: 'custom',
        workspaceActivityCustomDays: 5,
        hideCompletedReviewWorkspaces: false,
        hidePassingCheckWorkspaces: true
      })
      await extras(currentEnv.client, 'activate', { worktree: project.main.id })
      testClock.set(BASE + 1)
      await extras(currentEnv.client, 'activate', { worktree: feature.id })
      const before = await extras<ExtrasState>(currentEnv.client, 'state')
      const phoneBefore = await extras<ExtrasState>(currentEnv.client, 'state', { client: 'phone' })
      expect(before.exits).not.toEqual({})
      expect(before.active?.worktreeId).toBe(feature.id)
      return { before, phoneBefore }
    })

    env = await restart(env)
    const after = await extras<ExtrasState>(env.client, 'state')
    const phoneAfter = await extras<ExtrasState>(env.client, 'state', { client: 'phone' })
    expect(after.preferences).toEqual(before.preferences)
    expect(after.visits).toEqual(before.visits)
    expect(after.exits).toEqual({})
    expect(after.active).toBeNull()
    expect(phoneAfter.preferences).toEqual(phoneBefore.preferences)
  })


  test('hydrates absent and corrupt review flags as disabled for legacy clients', async () => {
    env = await boot()
    await extras(env.client, 'state')
    const store = new Database(join(env.harness.home, 'plugin-data', 'quirky.sidebar-extras', 'store.db'))
    try {
      const insert = store.query('INSERT INTO preferences (client, value) VALUES (?, ?)')
      insert.run('legacy', JSON.stringify({ workspaceActivityWindow: 'week' }))
      insert.run('corrupt', JSON.stringify({
        hideCompletedReviewWorkspaces: 'true',
        hidePassingCheckWorkspaces: null
      }))
    } finally {
      store.close()
    }

    const legacy = await extras<ExtrasState>(env.client, 'state', { client: 'legacy' })
    const corrupt = await extras<ExtrasState>(env.client, 'state', { client: 'corrupt' })
    expect(legacy.preferences.hideCompletedReviewWorkspaces).toBe(false)
    expect(legacy.preferences.hidePassingCheckWorkspaces).toBe(false)
    expect(corrupt.preferences.hideCompletedReviewWorkspaces).toBe(false)
    expect(corrupt.preferences.hidePassingCheckWorkspaces).toBe(false)
  })
  test('does not transfer visits when a canonical worktree is replaced at the same path', async () => {
    env = await boot()
    const currentEnv = env
    const project = await createGitProject(currentEnv.client)
    const feature = await createWorktree(currentEnv.client, project.repo.id, 'replace-me')
    const testClock = fakeClock(BASE)
    clock = testClock
    const oldState = await testClock.run(() =>
      extras<ExtrasState>(currentEnv.client, 'activate', { worktree: feature.id })
    )
    const oldInstanceId = oldState.active!.instanceId
    const oldKey = `${feature.id}@${oldInstanceId}`
    const oldVisit = oldState.visits[oldKey]

    await call(currentEnv.client, 'quirky.worktree/remove', { worktree: feature.id, force: true, yes: true })
    if (!feature.branch) throw new Error('created Git worktree must have a branch')
    git(project.path, 'worktree', 'add', '-q', '-b', feature.branch, feature.path, 'HEAD')
    const worktrees = await call<{ id: string; path: string }[]>(currentEnv.client, 'quirky.worktree/list', { repo: project.repo.id })
    const replacement = worktrees.find((worktree) => worktree.path === feature.path)!
    expect(replacement.id).toBe(feature.id)

    testClock.set(BASE + 1)
    const next = await testClock.run(() =>
      extras<ExtrasState>(currentEnv.client, 'activate', { worktree: replacement.id })
    )
    expect(next.active?.worktreeId).toBe(feature.id)
    expect(next.active?.instanceId).not.toBe(oldInstanceId)
    const newKey = `${feature.id}@${next.active!.instanceId}`
    expect(next.visits[oldKey]).toBe(oldVisit)
    expect(next.visits[newKey]).toBe(BASE + 1)
    expect(next.exits[oldKey]).toBe(BASE + 1)
  })
})
