import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import type { QuirkyClient } from '@quirky/protocol'

export const fixtureId = 'quirky.heimdall-control-fixture'
export const fixtureMethods = ['authorize', 'read', 'decide', 'execute', 'stop', 'configure']
export const fixtureSource = `
import { mkdirSync, realpathSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const worlds = new Map()
const pendingReads = new Map()
export async function activate(context) {
  const hook = name => '${fixtureId}/' + name
  context.provide('method:' + hook('configure'), p => {
    const world = worlds.get(p.workspace) ?? {}
    worlds.set(p.workspace, { ...world, ...p })
    if (p.releaseRead) { pendingReads.get(p.workspace)?.(); pendingReads.delete(p.workspace) }
    return worlds.get(p.workspace)
  })
  context.provide('method:' + hook('authorize'), async p => {
    const input = p.input ?? p
    const payload = input.kindPayload
    const workspace = payload.workspace ?? 'fixture'
    if (!/^[a-z0-9-]+$/.test(workspace)) throw new Error('invalid workspace')
    let canonical
    let worktreeId = null
    let repoId = null
    if (payload.worktreeId !== undefined && payload.worktreeId !== null) {
      if (typeof payload.worktreeId !== 'string' || payload.worktreeId.length === 0) throw new Error('invalid worktree id')
      if (typeof payload.repoId !== 'string' || payload.repoId.length === 0) throw new Error('worktree repo id is required')
      const worktree = await context.call('quirky.worktree/resolve', { selector: 'id:' + payload.worktreeId })
      if (!worktree || worktree.id !== payload.worktreeId || worktree.repoId !== payload.repoId || typeof worktree.path !== 'string') {
        throw new Error('registered worktree identity does not match enrollment')
      }
      canonical = realpathSync(worktree.path)
      worktreeId = worktree.id
      repoId = worktree.repoId
    } else {
      const path = join(context.dataDir, 'workspaces', workspace)
      mkdirSync(path, { recursive: true })
      canonical = realpathSync(path)
    }
    return { workspaceKey: 'local::' + canonical, workspacePath: canonical, executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: payload,
      worktreeId, repoId }
  })
  context.provide('method:' + hook('read'), async p => {
    const e = p.enrollment ?? p
    const payload = e.kindPayload ?? {}
    const world = worlds.get(payload.workspace) ?? {}
    if (world.blockRead && !world.releaseRead) {
      worlds.set(payload.workspace, { ...world, readStarted: true })
      const gate = Promise.withResolvers()
      pendingReads.set(payload.workspace, gate.resolve)
      await gate.promise
    }
    return { freshness: 'live', contentIdentity: world.identity ?? 'fixture-content', observedAtMs: Date.now(), world: { ...payload, ...world } }
  })
  context.provide('method:' + hook('decide'), p => {
    const world = p.snapshot.world
    if (world.reason) return { action: null, reason: world.reason, detail: world.detail, considered: ['planning', 'implementation'] }
    if (world.mode !== 'approval' && world.mode !== 'worker') return { action: null, reason: 'fixture-idle', considered: ['fixture'] }
    return { action: { kind: world.mode === 'worker' ? 'fixture-worker' : 'fixture-action', capability: 'fixture.write', visibility: 'external', contentIdentity: p.snapshot.contentIdentity,
      evidenceKey: 'fixture-evidence', expectedState: { target: 'fixture-resource', before: null } }, considered: ['fixture-action'] }
  })
  context.provide('method:' + hook('execute'), p => {
    const e = p.enrollment ?? p.context?.enrollment
    if (!e) throw new Error('missing enrollment context')
    if (e.kindPayload.mode === 'worker') {
      if (!e.kindPayload.workerRequest) throw new Error('Fixture worker request missing')
      return { worker: e.kindPayload.workerRequest }
    }
    appendFileSync(join(context.dataDir, 'effects.log'), e.watcherId + '\\n')
    return { effect: 'landed', reason: 'fixture action confirmed' }
  })
  context.provide('method:' + hook('stop'), p => p.snapshot.world.terminal ? { kind: 'terminal', state: 'complete', reason: 'fixture landing bar reached' } : null)
  for (const id of ['objective', 'hosted-review']) await context.call('quirky.heimdall/registerKind', {
    id, displayName: id === 'objective' ? 'Objective watcher' : 'Hosted review', enrollmentPayloadSchema: { type: 'object', additionalProperties: true },
    hooks: { authorize: hook('authorize'), read: hook('read'), decide: hook('decide'), execute: hook('execute'), stop: hook('stop') }
  })
}
`

export function installControlFixture(builtins: string): void {
  writePlugin(builtins, {
    id: fixtureId, name: 'Isolated Heimdall controls fixture', version: '1.0.0', main: 'main.ts', activation: 'startup',
    dependencies: ['quirky.heimdall'], contributes: { method: fixtureMethods.map(id => ({ id, params: { type: 'object', additionalProperties: true }, result: {} })) }
  }, { 'main.ts': fixtureSource })
}

export interface ControlHarness { root: string; h: Harness; client: QuirkyClient; cleanup(): Promise<void> }
export async function startControlHarness(options: { uiDir?: string } = {}): Promise<ControlHarness> {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-control-'))
  const home = join(root, 'home')
  const userHome = join(root, 'user-home')
  const builtins = join(root, 'builtins')
  const plugins = resolve(import.meta.dir, '../..')
  const linked = new Set<string>()
  const environmentKeys = ['HOME', 'QUIRKY_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']
  const saved = new Map(environmentKeys.map(key => [key, process.env[key]]))
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  function link(pluginId: string): void {
    if (linked.has(pluginId)) return
    const dir = join(plugins, pluginId)
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'quirky-plugin.json'), 'utf8'))
    linked.add(pluginId)
    symlinkSync(dir, join(builtins, pluginId))
    if (manifest && typeof manifest === 'object' && 'dependencies' in manifest && Array.isArray(manifest.dependencies)) {
      for (const dependency of manifest.dependencies) {
        if (typeof dependency !== 'string') throw new Error(`Invalid dependency in ${pluginId}`)
        link(dependency)
      }
    }
  }
  let h: Harness | undefined
  try {
    mkdirSync(builtins)
    mkdirSync(userHome, { mode: 0o700 })
    link('quirky.heimdall')
    link('quirky.ask')
    installControlFixture(builtins)
    for (const key of environmentKeys) delete process.env[key]
    process.env.HOME = userHome
    process.env.QUIRKY_HOME = home
    h = await startHarness({ home, builtinPluginsDir: builtins, ...options })
    const running = h
    const client = await running.connect('cli', 'heimdall-control-acceptance')
    return { root, h: running, client, async cleanup() {
      try { await running.cleanup() } finally { restore(); rmSync(root, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try { await h?.cleanup() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Control fixture setup and cleanup failed')
    } finally { restore(); rmSync(root, { recursive: true, force: true }) }
    throw error
  }
}
