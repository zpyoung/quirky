import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { normalize } from 'node:path'
import { RpcError, RpcErrorCode, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import type { AutomationDispatchContext } from '../dispatch-contract'
import type { AutomationDefinition } from '../types'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { addFakeRepo, fakeRegistrations } from '../../quirky.worktree/test/fixtures/fake-git'
import { createAutomationTargetResolver } from '../target'

const fixtures: PluginHarness[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

function definition(projectId: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'automation-target-test',
    name: 'Target test',
    prompt: 'Run the target test.',
    agentId: 'codex',
    projectId,
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
    dtstart: 0,
    enabled: true,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function delegatedContext(
  fixture: PluginHarness,
  transform: (method: string, result: unknown) => unknown = (_method, result) => result
): AutomationDispatchContext {
  return {
    async call(method, params = {}) {
      return transform(method, await fixture.client.callAny(method, params))
    },
    subscribe: () => () => {},
    log: () => {},
    error(kind, message) {
      const code = kind === 'invalid-params'
        ? RpcErrorCode.InvalidParams
        : kind === 'not-found'
          ? RpcErrorCode.NotFound
          : RpcErrorCode.Conflict
      return new RpcError(code, message)
    }
  }
}

async function startFixture() {
  const fixture = await startPluginHarness({ plugins: ['quirky.repo', 'quirky.worktree'], fakeSession: false })
  fixtures.push(fixture)
  if (!fixture.git) throw new Error('expected isolated fake git')
  fakeRegistrations(fixture.git)
  const root = realpathSync(makeTempDir('automation-target-worktrees-'))
  await fixture.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const path = addFakeRepo(fixture.git, `automation-target-${randomUUID()}`)
  const repo = await fixture.client.callAny('quirky.repo/add', { path }) as Repo
  const worktrees = await fixture.client.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
  const primary = worktrees.find((worktree) => worktree.isMain)
  if (!primary) throw new Error('fixture repo did not register its primary workspace')
  const made = await fixture.client.callAny('quirky.worktree/create', { repo: repo.id, name: 'review' }) as WorktreeCreateResult
  return { fixture, repo, primary, workspace: made.worktree }
}

async function addRepo(fixture: PluginHarness, name: string): Promise<Repo> {
  if (!fixture.git) throw new Error('expected isolated fake git')
  const path = addFakeRepo(fixture.git, name)
  return await fixture.client.callAny('quirky.repo/add', { path }) as Repo
}

async function errorOf(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the operation to fail')
}

describe('automation target resolver', () => {
  test('captures ID, name, and path selectors as authoritative existing and new targets', async () => {
    const { fixture, repo, primary } = await startFixture()
    const resolver = createAutomationTargetResolver(delegatedContext(fixture))

    for (const selector of [repo.id, `name:${repo.name}`, `path:${repo.path}/nested`]) {
      const captured = await resolver.capture(definition(selector, {
        workspaceMode: 'existing',
        workspaceId: primary.id,
        runContext: { kind: 'workspace-run', hostId: 'local', projectId: 'forged-project', path: '/forged/path' }
      }))
      expect(captured.projectId).toBe(repo.id)
      expect(captured.workspaceId).toBe(primary.id)
      expect(captured.owner).toEqual({
        kind: 'local',
        repoId: repo.id,
        repoPath: normalize(repo.path),
        workspaceId: primary.id,
        workspacePath: normalize(primary.path),
        workspaceInstanceId: primary.instanceId
      })
      expect(captured.runContext).toEqual({
        kind: 'workspace-run',
        hostId: 'local',
        repoId: repo.id,
        projectId: repo.id,
        path: normalize(primary.path)
      })
    }

    const fresh = await resolver.capture(definition(`path:${repo.path}`, { workspaceMode: 'new_per_run' }))
    expect(fresh).toMatchObject({
      projectId: repo.id,
      workspaceMode: 'new_per_run',
      workspaceId: null,
      owner: {
        kind: 'local', repoId: repo.id, repoPath: normalize(repo.path),
        workspaceId: null, workspacePath: null, workspaceInstanceId: null
      },
      runContext: {
        kind: 'workspace-run', hostId: 'local', repoId: repo.id, projectId: repo.id, path: normalize(repo.path)
      }
    })

    const resolved = await resolver.resolve(fresh)
    expect(resolved).toMatchObject({
      available: true,
      target: { repoId: repo.id, repoPath: normalize(repo.path), cwd: normalize(repo.path), workspaceId: null, workspaceDisplayName: null }
    })
  })

  test('resolves workspace cwd, display name, and precheck repo path from public registry APIs', async () => {
    const { fixture, repo, workspace } = await startFixture()
    await fixture.client.callAny('quirky.worktree/set', { worktree: workspace.id, displayName: 'Automation review' })
    const resolver = createAutomationTargetResolver(delegatedContext(fixture))
    const captured = await resolver.capture(definition(repo.id, { workspaceMode: 'existing', workspaceId: workspace.id }))

    const resolved = await resolver.resolve(captured)
    expect(resolved).toMatchObject({
      available: true,
      target: {
        repoId: repo.id,
        repoPath: normalize(repo.path),
        cwd: normalize(workspace.path),
        workspaceId: workspace.id,
        workspaceDisplayName: 'Automation review'
      }
    })
  })

  test('rejects missing projects and workspaces belonging to a different project', async () => {
    const { fixture, repo } = await startFixture()
    const resolver = createAutomationTargetResolver(delegatedContext(fixture))
    const missing = await errorOf(resolver.capture(definition('name:no-such-project')))
    expect(missing.code === RpcErrorCode.InvalidParams || missing.code === RpcErrorCode.Conflict).toBe(true)

    const otherRepo = await addRepo(fixture, `other-${randomUUID()}`)
    const otherWorkspace = (await fixture.client.callAny('quirky.worktree/list', { repo: otherRepo.id }) as Worktree[])[0]!
    const mismatch = await errorOf(resolver.capture(definition(repo.id, {
      workspaceMode: 'existing',
      workspaceId: otherWorkspace.id
    })))
    expect(mismatch.code).toBe(RpcErrorCode.Conflict)
    expect(mismatch.message).toContain('automation_workspace_project_mismatch')

    const unresolved = await resolver.resolve(definition('name:no-such-project'))
    expect(unresolved).toMatchObject({ available: false, status: 'skipped_unavailable' })
    expect((unresolved as { error: string }).error).toContain('automation_project_unavailable')
  })

  test('refuses remote or malformed host context before local lookup', async () => {
    const { fixture, repo } = await startFixture()
    const calls: string[] = []
    const base = delegatedContext(fixture)
    const resolver = createAutomationTargetResolver({
      ...base,
      async call(method, params) {
        calls.push(method)
        return base.call(method, params)
      }
    })
    for (const runContext of [
      { kind: 'workspace-run', hostId: 'remote:alpha', path: repo.path },
      { kind: 'workspace-run', hostId: 42 },
      { kind: 'remote-workspace', path: repo.path },
      { kind: 'workspace-run', context: { hostId: 'remote:alpha' } }
    ]) {
      const remote = definition(repo.id, { runContext })
      const failure = await errorOf(resolver.capture(remote))
      expect(failure.code).toBe(RpcErrorCode.Conflict)
      expect(failure.message).toContain('automation_remote_target_unsupported')
      expect(await resolver.resolve(remote)).toMatchObject({ available: false, status: 'skipped_unavailable' })
      expect(calls).toEqual([])
    }
  })

  test('keeps target refusal reasons stable for missing and changed captured identities', async () => {
    const { fixture, repo, primary, workspace } = await startFixture()
    const base = delegatedContext(fixture)
    const resolver = createAutomationTargetResolver(base)
    const captured = await resolver.capture(definition(repo.id, { workspaceMode: 'existing', workspaceId: workspace.id }))

    const movedSelector = await resolver.resolve({ ...captured, workspaceId: primary.id })
    expect(movedSelector).toMatchObject({ available: false, status: 'skipped_unavailable' })
    expect((movedSelector as { error: string }).error).toBe('automation_owner_changed:workspace_id')

    const changes: [string, (value: Repo | Worktree) => Repo | Worktree][] = [
      ['quirky.repo/resolve', (value) => ({ ...value, path: `${value.path}-moved` })],
      ['quirky.worktree/resolve', (value) => ({ ...value, path: `${value.path}-moved` })],
      ['quirky.worktree/resolve', (value) => {
        if (!('instanceId' in value)) throw new Error('Expected a workspace identity from the fixture')
        return { ...value, instanceId: `${value.instanceId}-replacement` }
      }]
    ]
    for (const [method, replace] of changes) {
      const driftResolver = createAutomationTargetResolver(delegatedContext(fixture, (called, result) => {
        if (called !== method || !result || typeof result !== 'object') return result
        return replace(result as Repo | Worktree)
      }))
      const first = await driftResolver.resolve(captured)
      const second = await driftResolver.resolve(captured)
      expect(first).toMatchObject({ available: false, status: 'skipped_unavailable' })
      expect((first as { error: string }).error).toBe((second as { error: string }).error)
      expect((first as { error: string }).error).toContain('automation_owner_changed')
    }

    const removingResolver = createAutomationTargetResolver(delegatedContext(fixture, (method, result) => {
      if (method === 'quirky.worktree/resolve' && result && typeof result === 'object') {
        return { ...result, removing: true }
      }
      return result
    }))
    const removing = await removingResolver.resolve(captured)
    expect(removing).toMatchObject({ available: false, status: 'skipped_unavailable' })
    expect((removing as { error: string }).error).toContain('automation_workspace_removing')

    await fixture.client.callAny('quirky.worktree/remove', { worktree: workspace.id, yes: true })
    const missing = await resolver.resolve(captured)
    const missingAgain = await resolver.resolve(captured)
    expect(missing).toMatchObject({ available: false, status: 'skipped_unavailable' })
    expect((missing as { error: string }).error).toBe((missingAgain as { error: string }).error)
    expect((missing as { error: string }).error).toContain('automation_workspace_unavailable')
  })

  test('resolves legacy local rows without mutating them and fences stale expected owners', async () => {
    const { fixture, repo, primary } = await startFixture()
    const legacy = definition(repo.id, { workspaceMode: 'existing', workspaceId: primary.id, owner: null })
    const before = structuredClone(legacy)
    const resolver = createAutomationTargetResolver(delegatedContext(fixture))
    const resolved = await resolver.resolve(legacy)
    expect(resolved).toMatchObject({ available: true, target: { repoId: repo.id, workspaceId: primary.id } })
    expect(legacy).toEqual(before)
    if (!resolved.available) throw new Error('expected the registered local target')

    const captured = await resolver.capture(legacy)
    expect(() => resolver.assertExpectedOwner(captured, captured.owner)).not.toThrow()
    const stale = { ...captured.owner!, workspaceInstanceId: `${captured.owner!.workspaceInstanceId}-old` }
    const failure = (() => {
      try {
        resolver.assertExpectedOwner(captured, stale)
      } catch (error) {
        return error as RpcError
      }
      throw new Error('expected stale owner conflict')
    })()
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toContain('automation_owner_changed')
    expect(() => resolver.assertExpectedOwner(captured, { ...captured.owner!, extra: true })).toThrow(/automation_owner_changed/)
    expect(() => resolver.assertExpectedOwner(captured, undefined)).not.toThrow()
  })
})
