import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import {
  boot,
  createGitProject,
  createWorktree,
  extras,
  runSidebarCli,
  type ActivityProjection,
  type DirtyResult,
  type ExtrasState,
  type TestEnvironment
} from './support'

setDefaultTimeout(20_000)

let env: TestEnvironment | null = null
afterEach(async () => {
  await env?.harness.cleanup()
  env = null
})

async function jsonCommand(args: string[]) {
  const result = await runSidebarCli(env!, [...args, '--json'])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  return JSON.parse(result.stdout) as unknown
}

describe('sidebar-extras CLI', () => {
  test('reads and changes the same real API state through every declared command', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const feature = await createWorktree(env.client, project.repo.id, 'feature')

    const initial = await jsonCommand(['state'])
    expect(initial).toEqual(await extras<ExtrasState>(env.client, 'state'))

    const changed = await jsonCommand([
      'set',
      '--workspace-activity-window', 'custom',
      '--workspace-activity-custom-days', '3',
      '--always-show-default-branch-workspace=false',
      '--hide-completed-review-workspaces=true',
      '--hide-passing-check-workspaces=false',
      '--hide-automation-created=true'
    ]) as ExtrasState
    expect(changed.preferences).toMatchObject({
      workspaceActivityWindow: 'custom',
      workspaceActivityCustomDays: 3,
      alwaysShowDefaultBranchWorkspace: false,
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: false,
      hideAutomationCreated: true
    })
    expect(changed).toEqual(await extras<ExtrasState>(env.client, 'state'))

    const activated = await jsonCommand(['activate', '--worktree', project.main.id]) as ExtrasState
    expect(activated.active?.worktreeId).toBe(project.main.id)
    expect(activated).toEqual(await extras<ExtrasState>(env.client, 'state'))

    const projection = await jsonCommand(['projection']) as ActivityProjection
    expect(projection.visibleIds).toContain(project.main.id)
    expect(projection.visibleIds).toContain(feature.id)
    expect(projection).toMatchObject(await extras<ActivityProjection>(env.client, 'projection'))

    writeFileSync(join(project.main.path, 'cli-dirty.txt'), 'one panel row\n')
    const dirty = await jsonCommand(['dirty', '--worktree', project.main.id]) as DirtyResult
    expect(dirty).toMatchObject({ worktreeId: project.main.id, count: 1, dirty: true, available: true })
    expect(dirty).toEqual(await extras<DirtyResult>(env.client, 'dirty', { worktree: project.main.id }))
    const noActive = await jsonCommand(['dirty', '--no-active']) as DirtyResult
    expect(noActive).toMatchObject({ worktreeId: null, count: 0, dirty: false, available: true })
    expect(noActive).toEqual(await extras<DirtyResult>(env.client, 'dirty', { worktree: null }))
    const cleared = await jsonCommand(['activate', '--clear']) as ExtrasState
    expect(cleared.active).toBeNull()
    expect(cleared.exits[`${project.main.id}@${project.main.instanceId}`]).toBeGreaterThan(0)
    expect(cleared).toEqual(await extras<ExtrasState>(env.client, 'state'))

  })

  test('rejects invalid declared set values without changing the stored preference', async () => {
    env = await boot()
    const before = await extras<ExtrasState>(env.client, 'state')
    const result = await runSidebarCli(env, [
      'set',
      '--workspace-activity-window', 'month',
      '--workspace-activity-custom-days', '0',
      '--json'
    ])
    expect(result.code).not.toBe(0)
    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(before)
  })
})
