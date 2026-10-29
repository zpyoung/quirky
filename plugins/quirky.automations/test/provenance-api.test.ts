import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RpcErrorCode, type QuirkyClient, type Repo, type Worktree, type WorktreeAutomationProvenance, type WorktreeAutomationProvenanceRequest, type WorktreeCreateResult } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage } from '../types'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { useTestGit } from '../../../packages/git/src/testing'
import { failure, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

isolateGitConfig()
setDefaultTimeout(60_000)
const PLUGINS_ROOT = resolve(import.meta.dir, '..', '..')
const fixtures: ProvenanceHarness[] = []
const temporaryHomes: string[] = []

type ProvenanceHarness = {
  readonly home: string
  readonly captureFile: string
  readonly controlFile: string
  readonly h: Harness
  readonly client: QuirkyClient
  restart(): Promise<void>
  cleanup(): Promise<void>
}

type ProjectFixture = ProvenanceHarness & { repo: Repo; repoPath: string; otherRepo(): Promise<Repo> }

function wrapperMain(pluginId: 'quirky.worktree' | 'quirky.automations', captureFile: string, controlFile: string): string {
  const actualMain = pathToFileURL(join(PLUGINS_ROOT, pluginId, 'main.ts')).href
  const methodNotFound = RpcErrorCode.MethodNotFound
  const lines = [
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'`,
    `import { activate as activateReal } from ${JSON.stringify(actualMain)}`,
    `const captureFile = ${JSON.stringify(captureFile)}`,
    `const controlFile = ${JSON.stringify(controlFile)}`,
    `const methodNotFound = ${JSON.stringify(methodNotFound)}`,
    `export function activate(context) {`,
    `  const originalCall = context.call.bind(context)`,
    `  const wrapped = new Proxy(context, {`,
    `    get(target, property) {`,
    `      if (property !== 'call') return Reflect.get(target, property, target)`,
    `      return (method, params) => {`,
    `        if (${JSON.stringify(pluginId)} === 'quirky.worktree' && method === 'quirky.session/create') {`,
    `          return Promise.reject(Object.assign(new Error('setup session disabled in provenance acceptance test'), { code: methodNotFound }))`,
    `        }`,
    `        let nextParams = params`,
    `        if (${JSON.stringify(pluginId)} === 'quirky.automations' && method === 'quirky.worktree/create' && params && params.automationProvenanceRequest) {`,
    `          appendFileSync(captureFile, JSON.stringify(params.automationProvenanceRequest) + '\\n')`,
    `        }`,
    `        if (${JSON.stringify(pluginId)} === 'quirky.automations' && method === 'quirky.structured/create') {`,
    `          return Promise.reject(Object.assign(new Error('provider launch intentionally stopped by provenance acceptance test'), { code: methodNotFound }))`,
    `        }`,
    `        if (${JSON.stringify(pluginId)} === 'quirky.automations' && method === 'quirky.worktree/create') {`,
    `          const control = JSON.parse(readFileSync(controlFile, 'utf8'))`,
    `          if (typeof control.redirectRepo === 'string') {`,
    `            nextParams = { ...params, repo: control.redirectRepo }`,
    `            writeFileSync(controlFile, '{}')`,
    `          }`,
    `        }`,
    `        return originalCall(method, nextParams)`,
    `      }`,
    `    }`,
    `  })`,
    `  return activateReal(wrapped)`,
    `}`
  ]
  return lines.join('\n')
}

function installWrapper(builtinPluginsDir: string, pluginId: 'quirky.worktree' | 'quirky.automations', captureFile: string, controlFile: string): void {
  const sourceDir = join(PLUGINS_ROOT, pluginId)
  const pluginDir = join(builtinPluginsDir, pluginId)
  mkdirSync(pluginDir, { recursive: true })
  for (const name of readdirSync(sourceDir)) {
    if (name === 'main.ts' || name === 'test') continue
    symlinkSync(join(sourceDir, name), join(pluginDir, name))
  }
  writeFileSync(join(pluginDir, 'main.ts'), wrapperMain(pluginId, captureFile, controlFile))
}

async function start(): Promise<ProjectFixture> {
  const home = makeTempHome('qa-automation-provenance-')
  temporaryHomes.push(home)
  const builtinPluginsDir = join(home, 'builtin-plugins')
  const captureFile = join(home, 'provenance-requests.jsonl')
  const controlFile = join(home, 'provenance-control.json')
  mkdirSync(builtinPluginsDir, { recursive: true })
  writeFileSync(captureFile, '')
  writeFileSync(controlFile, '{}')
  for (const pluginId of ['quirky.repo', 'quirky.cli', 'quirky.agents', 'quirky.checks', 'quirky.structured', 'quirky.session', 'quirky.ask']) {
    symlinkSync(join(PLUGINS_ROOT, pluginId), join(builtinPluginsDir, pluginId))
  }
  installWrapper(builtinPluginsDir, 'quirky.worktree', captureFile, controlFile)
  installWrapper(builtinPluginsDir, 'quirky.automations', captureFile, controlFile)

  useTestGit(null)
  let h = await startHarness({ builtinPluginsDir, home })
  let client = await h.connect('cli')
  const fixture: ProvenanceHarness = {
    home,
    captureFile,
    controlFile,
    get h() { return h },
    get client() { return client },
    async restart() {
      for (const connected of h.clients) connected.close()
      await h.daemon.stop()
      h.pty.stop()
      h = await startHarness({ builtinPluginsDir, home })
      client = await h.connect('cli')
    },
    async cleanup() {
      useTestGit(null)
      await h.cleanup()
    }
  }
  fixtures.push(fixture)

  const repoPath = makeRepo(join(home, 'projects', 'automation-project'))
  const repo = await client.callAny('quirky.repo/add', { path: repoPath }) as Repo
  await client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(home, 'worktrees') })
  return {
    home: fixture.home,
    captureFile: fixture.captureFile,
    controlFile: fixture.controlFile,
    get h() { return fixture.h },
    get client() { return fixture.client },
    restart() { return fixture.restart() },
    cleanup() { return fixture.cleanup() },
    repo,
    repoPath,
    async otherRepo() {
      const path = makeRepo(join(home, 'projects', 'other-project'))
      return await client.callAny('quirky.repo/add', { path }) as Repo
    }
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const call = (fixture: ProvenanceHarness, method: string, params: Record<string, unknown> = {}) =>
  fixture.client.callAny(method, params)

function capturedRequests(fixture: ProvenanceHarness): WorktreeAutomationProvenanceRequest[] {
  return readFileSync(fixture.captureFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WorktreeAutomationProvenanceRequest)
}

function setRedirectRepo(fixture: ProvenanceHarness, repoId: string): void {
  writeFileSync(fixture.controlFile, JSON.stringify({ redirectRepo: repoId }))
}

function createDefinition(fixture: ProvenanceHarness, projectId: string, overrides: Record<string, unknown> = {}): Promise<AutomationDefinition> {
  return call(fixture, 'quirky.automations/create', {
    name: 'Snapshot audit',
    prompt: 'Review the project.',
    agentId: 'codex',
    projectId,
    workspaceMode: 'new_per_run',
    workspaceId: null,
    setupDecision: 'skip',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    enabled: false,
    ...overrides
  }) as Promise<AutomationDefinition>
}

async function listProject(fixture: ProvenanceHarness, repoId: string): Promise<Worktree[]> {
  return await call(fixture, 'quirky.worktree/list', { repo: repoId }) as Worktree[]
}

describe('automation provenance public API', () => {
  test('persists trusted snapshots across setup failure, history deletion, restart, and same-path replacement', async () => {
    const fixture = await start()
    const { client, repo } = fixture
    const observer = await fixture.h.connectWithEvents('cli')
    const definition = await createDefinition(fixture, repo.id, { name: 'Snapshot audit' })

    const run = await call(fixture, 'quirky.automations/run', { id: definition.id, expectedOwner: definition.owner }) as AutomationRun
    expect(run.status).toBe('dispatch_failed')
    expect(run.workspaceId).toBeTruthy()
    const created = await call(fixture, 'quirky.worktree/show', { worktree: run.workspaceId }) as Worktree
    const request = capturedRequests(fixture)[0]!
    const snapshot: WorktreeAutomationProvenance = {
      kind: 'created-by-automation',
      automationId: definition.id,
      automationName: definition.name,
      runId: run.id,
      runTitle: run.title,
      projectId: repo.id,
      hostId: 'local'
    }
    expect(request).toMatchObject({ automationId: definition.id, runId: run.id })
    expect(created).toMatchObject({ createdBy: 'api', automationProvenance: snapshot })
    expect(await call(fixture, 'quirky.worktree/list', { repo: repo.id })).toContainEqual(expect.objectContaining({ id: created.id, automationProvenance: snapshot }))
    expect(JSON.stringify(created)).not.toContain(request.dispatchToken)
    expect(JSON.stringify(run)).not.toContain(request.dispatchToken)
    expect(JSON.stringify(observer.events)).not.toContain(request.dispatchToken)
    const renamed = await call(fixture, 'quirky.automations/edit', {
      id: definition.id,
      expectedOwner: definition.owner,
      name: 'Renamed audit'
    }) as AutomationDefinition
    expect(renamed.name).toBe('Renamed audit')
    expect((await call(fixture, 'quirky.worktree/show', { worktree: created.id }) as Worktree).automationProvenance).toEqual(snapshot)

    const ordinary = (await call(fixture, 'quirky.worktree/create', {
      repo: repo.id,
      name: 'ordinary-api-workspace',
      setup: 'skip'
    }) as WorktreeCreateResult).worktree
    expect(ordinary.createdBy).toBe('api')
    expect(ordinary.automationProvenance).toBeUndefined()

    const primary = (await listProject(fixture, repo.id)).find((worktree) => worktree.isMain)!
    const existingDefinition = await createDefinition(fixture, repo.id, {
      name: 'Existing workspace run',
      workspaceMode: 'existing',
      workspaceId: primary.id
    })
    const existingRun = await call(fixture, 'quirky.automations/run', {
      id: existingDefinition.id,
      expectedOwner: existingDefinition.owner
    }) as AutomationRun
    expect(existingRun.workspaceId).toBe(primary.id)
    expect((await call(fixture, 'quirky.worktree/show', { worktree: primary.id }) as Worktree).automationProvenance).toBeUndefined()
    expect(capturedRequests(fixture)).toHaveLength(1)

    await call(fixture, 'quirky.repo/set', {
      repo: repo.id,
      setupPolicy: 'run-by-default',
      setupScript: 'exit 7'
    })
    const failingDefinition = await createDefinition(fixture, repo.id, {
      name: 'Setup failure audit',
      setupDecision: 'run'
    })
    const failedRun = await call(fixture, 'quirky.automations/run', {
      id: failingDefinition.id,
      expectedOwner: failingDefinition.owner
    }) as AutomationRun
    expect(failedRun.status).toBe('dispatch_failed')
    expect(failedRun.error).toContain('Workspace setup exited with 7')
    expect(failedRun.workspaceId).toBeTruthy()
    expect((await call(fixture, 'quirky.worktree/show', { worktree: failedRun.workspaceId }) as Worktree).automationProvenance)
      .toMatchObject({ automationId: failingDefinition.id, runId: failedRun.id, automationName: failingDefinition.name, runTitle: failedRun.title })

    await call(fixture, 'quirky.automations/remove', { id: definition.id, yes: true, expectedOwner: definition.owner })
    expect((await call(fixture, 'quirky.automations/runs', { automationId: definition.id }) as AutomationRunsPage).runs).toEqual([])
    expect((await call(fixture, 'quirky.worktree/show', { worktree: created.id }) as Worktree).automationProvenance).toEqual(snapshot)

    await fixture.restart()
    const afterRestart = await call(fixture, 'quirky.worktree/show', { worktree: created.id }) as Worktree
    expect(afterRestart.automationProvenance).toEqual(snapshot)
    expect(await call(fixture, 'quirky.worktree/list', { repo: repo.id })).toContainEqual(expect.objectContaining({ id: created.id, automationProvenance: snapshot }))

    await call(fixture, 'quirky.worktree/remove', { worktree: created.id, yes: true })
    const replacement = (await call(fixture, 'quirky.worktree/create', {
      repo: repo.id,
      name: created.name,
      setup: 'skip'
    }) as WorktreeCreateResult).worktree
    expect(replacement.id).toBe(created.id)
    expect(replacement.instanceId).not.toBe(created.instanceId)
    expect(replacement.automationProvenance).toBeUndefined()
    expect((await call(fixture, 'quirky.worktree/show', { worktree: replacement.id }) as Worktree).automationProvenance).toBeUndefined()
  })

  test('forged, replayed, and cross-repository capability requests create no workspace', async () => {
    const fixture = await start()
    const otherRepo = await fixture.otherRepo()
    const definition = await createDefinition(fixture, fixture.repo.id)
    const run = await call(fixture, 'quirky.automations/run', { id: definition.id, expectedOwner: definition.owner }) as AutomationRun
    expect(run.workspaceId).toBeTruthy()
    const issued = capturedRequests(fixture)[0]!
    const firstProjectCount = (await listProject(fixture, fixture.repo.id)).length

    const replayed = await failure(call(fixture, 'quirky.worktree/create', {
      repo: fixture.repo.id,
      name: 'replayed-capability',
      setup: 'skip',
      automationProvenanceRequest: issued
    }))
    expect(replayed.code).toBe(RpcErrorCode.Conflict)
    expect((await listProject(fixture, fixture.repo.id)).length).toBe(firstProjectCount)

    const forged = await failure(call(fixture, 'quirky.worktree/create', {
      repo: fixture.repo.id,
      name: 'forged-capability',
      setup: 'skip',
      automationProvenanceRequest: {
        ...issued,
        dispatchToken: 'f'.repeat(36)
      }
    }))
    expect(forged.code).toBe(RpcErrorCode.Conflict)
    expect((await listProject(fixture, fixture.repo.id)).length).toBe(firstProjectCount)

    const crossDefinition = await createDefinition(fixture, fixture.repo.id, { name: 'Cross-repository request' })
    setRedirectRepo(fixture, otherRepo.id)
    const crossRun = await call(fixture, 'quirky.automations/run', {
      id: crossDefinition.id,
      expectedOwner: crossDefinition.owner
    }) as AutomationRun
    expect(crossRun.status).toBe('dispatch_failed')
    expect(crossRun.workspaceId).toBeNull()
    expect((await listProject(fixture, otherRepo.id)).every((worktree) => worktree.isMain)).toBe(true)
    expect((await listProject(fixture, fixture.repo.id)).length).toBe(firstProjectCount)
  })
})
