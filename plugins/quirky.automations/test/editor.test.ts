import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { RpcErrorCode, type PluginContext, type PluginErrorKind } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { createAutomationService, type AutomationServiceContext } from '../service'
import type { AutomationOwner, AutomationTargetResolution, AutomationTargetResolver } from '../dispatch-contract'
import { createAutomationStore, migrations } from '../store'
import type { AutomationUiEnv, AutomationUiState } from '../src/ui-contracts'
import { editorMethods } from '../src/editor/methods'

const fixtures: { cleanup(): void }[] = []
const temporaryHomes: string[] = []
const pluginErrorCodes: Record<PluginErrorKind, number> = {
  'invalid-params': RpcErrorCode.InvalidParams,
  'not-found': RpcErrorCode.NotFound,
  conflict: RpcErrorCode.Conflict
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

type FixtureOptions = { unreadableHooks?: boolean }

function makeFixture(options: FixtureOptions = {}) {
  const home = makeTempHome()
  temporaryHomes.push(home)
  const opened = openPluginStore({ home, pluginId: 'quirky.automations', migrations, isActive: () => true })
  const serviceContext: AutomationServiceContext = {
    pluginId: 'quirky.automations',
    openStore: () => opened.store,
    emit: () => true,
    error: (_kind, message) => new Error(message),
    log: () => {}
  }
  const repo = {
    id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', displayName: null,
    groupId: null, addedAt: 1
  }
  const secondRepo = {
    id: 'repo-2', name: 'docs', path: '/work/docs', kind: 'git', displayName: null,
    groupId: null, addedAt: 2
  }
  const worktrees = [
    { id: 'wt-active', repoId: 'repo-1', path: '/work/quirky', name: 'main', isMain: true, instanceId: 'instance-1', kind: 'git', head: 'commit-1', branch: 'main' },
    { id: 'wt-other', repoId: 'repo-1', path: '/work/quirky-feature', name: 'feature', isMain: false, instanceId: 'instance-2', kind: 'git', head: 'commit-2', branch: 'feature' },
    { id: 'wt-docs', repoId: 'repo-2', path: '/work/docs', name: 'docs-main', isMain: true, instanceId: 'instance-3', kind: 'git', head: 'commit-3', branch: 'main' }
  ]
  const hooksFailure: Error | null = options.unreadableHooks ? new Error('hooks file cannot be read') : null
  let trustCalls = 0
  let expectedOwnerSeen: unknown
  const hooks = {
    file: 'quirky.yaml',
    setup: { text: 'bun test', source: 'local', badge: 'Local', shared: null },
    archive: null, agentStartup: null, sharedDirectories: [], warnings: []
  }
  const settings = {
    defaultBase: 'main', worktreeLocation: null, setupPolicy: 'run-by-default', agentStartup: null,
    commandSource: null, setupScript: 'bun test', archiveScript: ''
  }
  const agents = [
    { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: false },
    { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true }
  ]
  const optionsCatalog = {
    agent: 'codex', label: 'Codex', supported: true,
    models: [{ id: 'gpt-5', label: 'GPT-5', description: null, options: [
      { id: 'reasoning', label: 'Reasoning', type: 'select', choices: [{ value: 'high', label: 'High' }] },
      { id: 'notify', label: 'Notify', type: 'boolean', choices: null }
    ] }],
    unlisted: 'refuse', unlistedOptions: [], structured: true, extraArgs: { supported: false, rules: [] }
  }
  const targetResolver: AutomationTargetResolver = {
    async capture(definition) {
      const project = [repo, secondRepo].find((item) => item.id === definition.projectId)
      if (!project) throw serviceContext.error('invalid-params', 'The project is unavailable in the test target registry.')
      const workspace = definition.workspaceMode === 'existing'
        ? worktrees.find((item) => item.id === definition.workspaceId && item.repoId === project.id)
        : undefined
      if (definition.workspaceMode === 'existing' && !workspace) {
        throw serviceContext.error('invalid-params', 'The workspace is unavailable in the test target registry.')
      }
      const owner: AutomationOwner = {
        kind: 'local',
        repoId: project.id,
        repoPath: project.path,
        workspaceId: workspace?.id ?? null,
        workspacePath: workspace?.path ?? null,
        workspaceInstanceId: workspace?.instanceId ?? null
      }
      return {
        ...definition,
        projectId: project.id,
        workspaceId: workspace?.id ?? null,
        runContext: {
          kind: 'workspace-run', hostId: 'local', repoId: project.id, projectId: project.id,
          path: workspace?.path ?? project.path
        },
        owner
      }
    },
    async resolve(definition): Promise<AutomationTargetResolution> {
      const owner = definition.owner
      if (!owner) return { available: false, status: 'skipped_unavailable', error: 'The automation has no captured owner.' }
      const project = [repo, secondRepo].find((item) => item.id === owner.repoId && item.path === owner.repoPath)
      if (!project) return { available: false, status: 'skipped_unavailable', error: 'The project is unavailable.' }
      const workspace = owner.workspaceId === null
        ? null
        : worktrees.find((item) => item.id === owner.workspaceId && item.repoId === owner.repoId)
      if (owner.workspaceId !== null && (!workspace || workspace.path !== owner.workspacePath || workspace.instanceId !== owner.workspaceInstanceId)) {
        return { available: false, status: 'skipped_unavailable', error: 'The workspace owner changed.' }
      }
      return {
        available: true,
        target: {
          repoId: project.id,
          repoPath: project.path,
          cwd: workspace?.path ?? project.path,
          workspaceId: workspace?.id ?? null,
          workspaceDisplayName: workspace?.name ?? null,
          owner
        }
      }
    },
    assertExpectedOwner(definition, expectedOwner) {
      if (expectedOwner === undefined) return
      expectedOwnerSeen = expectedOwner
      if (JSON.stringify(expectedOwner) !== JSON.stringify(definition.owner)) {
        throw serviceContext.error('conflict', 'automation_owner_changed: expected owner does not match the saved owner.')
      }
  }
  }
  const service = createAutomationService(serviceContext, Date.now, { targets: targetResolver })
  const context = {
    pluginId: 'quirky.automations',
    call: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === 'quirky.repo/list') return [repo, secondRepo]
      if (method === 'quirky.worktree/list') return params.repo ? worktrees.filter((item) => item.repoId === params.repo) : worktrees
      if (method === 'quirky.repo/show') return { repo: params.repo === 'repo-2' ? secondRepo : repo, settings, hooks }
      if (method === 'quirky.repo/hooks') {
        if (hooksFailure) throw hooksFailure
        return hooks
      }
      if (method === 'quirky.repo/trustHooks') {
        trustCalls += 1
        return { repo, settings, hooks }
      }
      if (method === 'quirky.agents/list') return { defaultAgent: 'codex', agents }
      if (method === 'quirky.agents/options') return { ...optionsCatalog, agent: params.agent }
      if (method === 'quirky.git/branches') return { refs: [{ name: 'main', kind: 'local' }, { name: 'release/next', kind: 'local' }], current: 'main' }
      if (method === 'quirky.automations/target') {
        return targetResolver.resolve(service.show({ id: params.id }))
      }
      throw new Error(`Unexpected public dependency call ${method}`)
    },
    error: (kind: PluginErrorKind, message: string) => Object.assign(new Error(message), { code: pluginErrorCodes[kind] }),
    log: () => {}
  } as unknown as PluginContext
  const state: AutomationUiState = {
    revision: 0,
    navigation: {
      page: 'list', automationId: null, runId: null, tab: 'overview', query: '', host: 'all',
      status: 'all', lastRun: 'all', agent: '', sort: 'name', direction: 'asc', runQuery: '', runStatus: 'all'
    },
    editor: null
  }
  const env: AutomationUiEnv = {
    context,
    service,
    read: () => state,
    update: (change) => {
      change(state)
      state.revision += 1
      return state
    },
    navigate: async (patch) => {
      state.navigation = { ...state.navigation, ...patch }
      state.revision += 1
      return state
    }
  }
  const methods = editorMethods(env)
  const invoke = (name: string, params: Record<string, unknown> = {}) => {
    const method = methods[name]
    if (!method) throw new Error(`Missing editor method ${name}`)
    return method(params, { role: 'cli', cwd: '/work/quirky/src', worktreeId: 'wt-active' })
  }
  return {
    env, service, methods, invoke, state, store: opened.store, worktrees,
    get trustCalls() { return trustCalls },
    get expectedOwnerSeen() { return expectedOwnerSeen },
    cleanup() { service.dispose(); opened.close() }
  }
}

function fixture(options?: FixtureOptions) {
  const result = makeFixture(options)
  fixtures.push(result)
  return result
}

describe('automation editor methods', () => {
  test('loads public catalogs and creates with the active workspace', async () => {
    const f = fixture()
    const data = await f.invoke('editorData') as { hosts: unknown[]; projects: { id: string }[]; workspaces: { id: string }[]; agents: { id: string }[]; errors: string[] }
    expect(data).toMatchObject({
      hosts: [{ id: 'local', available: true }],
      projects: [{ id: 'repo-1' }, { id: 'repo-2' }],
      workspaces: [{ id: 'wt-active' }, { id: 'wt-other' }, { id: 'wt-docs' }],
      agents: [{ id: 'claude' }, { id: 'codex', isDefault: true }], errors: []
    })

    await f.invoke('openEditor')
    expect(f.state.editor?.draft).toMatchObject({
      projectId: 'repo-1', workspaceMode: 'existing', workspaceId: 'wt-active'
    })
    await f.invoke('patchDraft', { patch: { prompt: 'Run the scheduled review.' } })
    const saved = await f.invoke('saveEditor') as { enabled: boolean; projectId: string; workspaceId: string }
    expect(saved).toMatchObject({ enabled: true, projectId: 'repo-1', workspaceId: 'wt-active' })
  })
  test('reuses the creation key for overlapping pending saves', async () => {
    const f = fixture()
    await f.invoke('openEditor', {})
    await f.invoke('patchDraft', { patch: { prompt: 'Run the scheduled review.' } })
    const key = f.state.editor?.creationKey
    if (!key) throw new Error('The open editor must retain a creation key')
    const [first, second] = await Promise.all([
      f.invoke('saveEditor', {}),
      f.invoke('saveEditor', {})
    ]) as [{ id: string; creationKey: string }, { id: string; creationKey: string }]
    expect(first.id).toBe(second.id)
    expect(first.creationKey).toBe(key)
    expect(second.creationKey).toBe(key)
    expect(f.service.list({})).toHaveLength(1)
  })

  test('applies all templates without changing the selected target', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { launchOverrides: { model: 'gpt-5' } } })
    const templates = [
      { id: 'repo-health-weekday', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', grace: 720 },
      { id: 'release-prep-weekly', rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0', grace: 1440 },
      { id: 'recurring-review-daily', rrule: 'FREQ=DAILY;BYHOUR=16;BYMINUTE=30', grace: 180 },
      { id: 'maintenance-hourly', rrule: 'FREQ=HOURLY;BYMINUTE=15', grace: 30 }
    ]
    for (const template of templates) {
      await f.invoke('patchDraft', { patch: {}, template: template.id })
      expect(f.state.editor?.draft).toMatchObject({
        projectId: 'repo-1', workspaceId: 'wt-active', launchOverrides: null,
        rrule: template.rrule, missedRunGraceMinutes: template.grace
      })
      expect(f.state.editor?.draft.prompt.trim().length).toBeGreaterThan(0)
    }
  })

  test('enforces agent and workspace/session draft coupling', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { launchOverrides: { model: 'gpt-5' } } })
    await f.invoke('patchDraft', { patch: { agentId: 'claude' } })
    expect(f.state.editor?.draft.launchOverrides).toBeNull()

    await f.invoke('patchDraft', { patch: { workspaceMode: 'new_per_run', baseBranch: 'release/next' } })
    expect(f.state.editor?.draft).toMatchObject({ workspaceMode: 'new_per_run', workspaceId: null, reuseSession: false })
    await f.invoke('patchDraft', { patch: { reuseSession: true } })
    expect(f.state.editor?.draft).toMatchObject({ workspaceMode: 'existing', workspaceId: 'wt-active', baseBranch: null, reuseSession: true })
    await f.invoke('patchDraft', { patch: { projectId: 'repo-2' } })
    expect(f.state.editor?.draft).toMatchObject({ projectId: 'repo-2', workspaceId: 'wt-docs', reuseSession: true })
  })
  test('retains opaque Claude model IDs for native launch validation', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { agentId: 'claude' } })
    await f.invoke('patchDraft', { patch: { launchOverrides: { model: 'claude-opus-20240229' } } })
    expect(f.state.editor?.draft.launchOverrides).toEqual({ model: 'claude-opus-20240229' })
  })


  test('retains an invalid cron draft after save validation fails', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { rrule: '0 0 31 2 *', prompt: 'Run the scheduled review.' } })
    await expect(f.invoke('saveEditor')).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(f.state.editor?.draft.rrule).toBe('0 0 31 2 *')
    expect(f.service.list({})).toEqual([])
  })

  test('retains a blank prompt after save validation fails', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { prompt: '  ' } })
    await expect(f.invoke('saveEditor')).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(f.state.editor?.draft.prompt).toBe('  ')
    expect(f.service.list({})).toEqual([])
  })

  test('refuses a workspace removed after the editor opened and keeps the draft', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { prompt: 'Run the scheduled review.' } })
    f.worktrees.splice(0, 1)
    await expect(f.invoke('saveEditor')).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(f.state.editor?.draft.workspaceId).toBe('wt-active')
    expect(f.service.list({})).toEqual([])
  })

  test('name-only edit preserves schedule anchor and sends the captured owner fence', async () => {
    const f = fixture()
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { prompt: 'Run the scheduled review.' } })
    const created = await f.invoke('saveEditor') as { id: string; dtstart: number }
    const owner = {
      kind: 'local', repoId: 'repo-1', repoPath: '/work/quirky', workspaceId: 'wt-active',
      workspacePath: '/work/quirky', workspaceInstanceId: 'instance-1'
    } as const
    createAutomationStore(f.store).update(created.id, { owner })
    await f.invoke('openEditor', { id: created.id })
    expect(f.state.editor?.original?.dtstart).toBe(created.dtstart)
    expect(f.state.editor?.original?.owner).toEqual(owner)
    await f.invoke('patchDraft', { patch: { name: 'Renamed' } })
    const updated = await f.invoke('saveEditor') as { id: string; name: string; dtstart: number }
    expect(updated).toMatchObject({ id: created.id, name: 'Renamed', dtstart: created.dtstart })
    expect(f.expectedOwnerSeen).toEqual(owner)
    const editorData = await f.invoke('editorData') as { errors: string[] }
    expect(editorData.errors).toEqual([])
  })
  test('rejects a name edit after the captured local owner changes', async () => {
    const f = fixture()
    await f.invoke('openEditor', {})
    await f.invoke('patchDraft', { patch: { prompt: 'Run the scheduled review.' } })
    const created = await f.invoke('saveEditor', {}) as { id: string; name: string; dtstart: number }
    const owner = {
      kind: 'local', repoId: 'repo-1', repoPath: '/work/quirky', workspaceId: 'wt-active',
      workspacePath: '/work/quirky', workspaceInstanceId: 'instance-1'
    } as const
    const store = createAutomationStore(f.store)
    store.update(created.id, { owner })
    await f.invoke('openEditor', { id: created.id })
    await f.invoke('patchDraft', { patch: { name: 'Stale edit' } })
    store.update(created.id, { owner: { ...owner, workspaceInstanceId: 'instance-replaced' } })

    await expect(f.invoke('saveEditor', {})).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect(f.state.editor?.draft.name).toBe('Stale edit')
    expect(f.service.show({ id: created.id }).name).toBe(created.name)
  })


  test('skips setup if hooks cannot be inspected, even when consent was requested', async () => {
    const f = fixture({ unreadableHooks: true })
    await f.invoke('openEditor')
    await f.invoke('patchDraft', { patch: { workspaceMode: 'new_per_run', setupDecision: 'run', prompt: 'Run the scheduled review.' } })
    const saved = await f.invoke('saveEditor', { trustSetup: true }) as { setupDecision?: string }
    expect(saved.setupDecision).toBe('skip')
    expect(f.trustCalls).toBe(0)
  })
})
