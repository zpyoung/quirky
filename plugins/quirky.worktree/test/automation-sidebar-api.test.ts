import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyClient, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

isolateGitConfig()

type World = { home: string; harness: Harness; client: QuirkyClient }
type SidebarState = { client: string; preferences: { hideAutomationCreated: boolean } }
type SidebarProjection = {
  preferences: { hideAutomationCreated: boolean }
  filterCount: number
  automationHiddenIds: string[]
  visibleIds: string[]
  hiddenIds: string[]
}
let current: World | null = null

afterEach(async () => {
  if (!current) return
  const world = current
  current = null
  try {
    await world.harness.cleanup()
  } finally {
    rmSync(world.home, { recursive: true, force: true })
  }
})

async function start(home: string): Promise<World> {
  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  try {
    const client = await harness.connect('cli', 'automation-sidebar-api')
    return { home, harness, client }
  } catch (error) {
    await harness.cleanup()
    throw error
  }
}

const call = <T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params) as Promise<T>

async function createAttributedWorktree(world: World): Promise<{ repo: Repo; worktree: Worktree; runId: string }> {
  const projectPath = makeRepo(join(world.home, 'projects', 'sidebar-automation'))
  const repo = await call<Repo>(world.client, 'quirky.repo/add', { path: projectPath })
  await call(world.client, 'setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: join(world.home, 'worktrees')
  })
  const definition = await call<{ id: string; name: string }>(world.client, 'quirky.automations/create', {
    name: 'Sidebar audit',
    prompt: 'Review this workspace.',
    agentId: 'codex',
    projectId: repo.id,
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    setupDecision: 'skip',
    reuseSession: false,
    enabled: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
  })
  let run: { id: string; title: string }
  try {
    run = await call<{ id: string; title: string }>(world.client, 'quirky.automations/run', { id: definition.id })
  } catch (error) {
    const history = await call<{ runs: { id: string; title: string }[] }>(world.client, 'quirky.automations/runs', {
      automationId: definition.id, limit: 100
    })
    const persisted = history.runs[0]
    if (!persisted) throw error
    run = persisted
  }
  const worktree = await waitFor(async () => {
    const rows = await call<Worktree[]>(world.client, 'quirky.worktree/list', { repo: repo.id })
    return rows.find((item) => item.automationProvenance?.runId === run.id)
  })
  if (!worktree) throw new Error('the automation run did not persist its worktree attribution')
  expect(worktree.automationProvenance).toMatchObject({
    kind: 'created-by-automation', automationId: definition.id, automationName: definition.name,
    runId: run.id, runTitle: run.title, projectId: repo.id, hostId: 'local'
  })
  return { repo, worktree, runId: run.id }
}

test('hideAutomationCreated persists per client and filters provenance without matching API creators or name prefixes', async () => {
  const home = makeHomeWithoutAutoHooks('qwt-automation-sidebar-api-')
  try {
    current = await start(home)
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
  const world = current
  if (!world) throw new Error('sidebar API test harness did not start')
  const { repo, worktree: attributed } = await createAttributedWorktree(world)
  const ordinary = (await call<WorktreeCreateResult>(world.client, 'quirky.worktree/create', {
    repo: repo.id, name: 'auto-user-created'
  })).worktree
  expect(ordinary.createdBy).toBe('api')
  expect(ordinary.automationProvenance ?? null).toBeNull()

  const initial = await call<SidebarState>(world.client, 'quirky.sidebar-extras/state')
  expect(initial.preferences.hideAutomationCreated).toBe(false)
  await expect(call(world.client, 'quirky.sidebar-extras/set', { hideAutomationCreated: 'true' }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  expect(await call<SidebarState>(world.client, 'quirky.sidebar-extras/state')).toEqual(initial)
  const unfiltered = await call<SidebarProjection>(world.client, 'quirky.sidebar-extras/projection')
  expect(unfiltered.visibleIds).toContain(attributed.id)
  expect(unfiltered.visibleIds).toContain(ordinary.id)

  await call<SidebarState>(world.client, 'quirky.sidebar-extras/set', { hideAutomationCreated: true })
  const hidden = await call<SidebarProjection>(world.client, 'quirky.sidebar-extras/projection')
  expect(hidden.preferences.hideAutomationCreated).toBe(true)
  expect(hidden.filterCount).toBe(1)
  expect(hidden.automationHiddenIds).toEqual([attributed.id])
  expect(hidden.hiddenIds).toContain(attributed.id)
  expect(hidden.visibleIds).toContain(ordinary.id)

  const phone = await call<SidebarState>(world.client, 'quirky.sidebar-extras/set', {
    client: 'phone', hideAutomationCreated: true
  })
  expect(phone.client).toBe('phone')
  expect(phone.preferences.hideAutomationCreated).toBe(true)
  const phoneProjection = await call<SidebarProjection>(world.client, 'quirky.sidebar-extras/projection', { client: 'phone' })
  expect(phoneProjection.filterCount).toBe(1)
  expect(phoneProjection.automationHiddenIds).toEqual([attributed.id])

  for (const client of world.harness.clients) await client.close()
  await world.harness.daemon.stop()
  world.harness.pty.stop()
  current = null
  try {
    current = await start(home)
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
  const restoredWorld = current
  if (!restoredWorld) throw new Error('restarted sidebar API test harness did not start')
  const restored = await call<SidebarState>(restoredWorld.client, 'quirky.sidebar-extras/state')
  const restoredProjection = await call<SidebarProjection>(restoredWorld.client, 'quirky.sidebar-extras/projection')
  expect(restored.preferences.hideAutomationCreated).toBe(true)
  expect(restoredProjection.filterCount).toBe(1)
  expect(restoredProjection.automationHiddenIds).toEqual([attributed.id])
  expect(restoredProjection.visibleIds).toContain(ordinary.id)
  expect(restoredProjection.hiddenIds).toContain(attributed.id)
  const restoredPhone = await call<SidebarState>(restoredWorld.client, 'quirky.sidebar-extras/state', { client: 'phone' })
  const restoredPhoneProjection = await call<SidebarProjection>(restoredWorld.client, 'quirky.sidebar-extras/projection', { client: 'phone' })
  expect(restoredPhone.preferences.hideAutomationCreated).toBe(true)
  expect(restoredPhoneProjection.filterCount).toBe(1)
  expect(restoredPhoneProjection.automationHiddenIds).toEqual([attributed.id])
})
