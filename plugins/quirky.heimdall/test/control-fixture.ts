import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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
  context.provide('method:' + hook('authorize'), p => {
    const input = p.input ?? p
    const payload = input.kindPayload
    const workspace = payload.workspace ?? 'fixture'
    if (!/^[a-z0-9-]+$/.test(workspace)) throw new Error('invalid workspace')
    const path = join(context.dataDir, 'workspaces', workspace)
    mkdirSync(path, { recursive: true })
    const canonical = realpathSync(path)
    return { workspaceKey: 'local::' + canonical, workspacePath: canonical, executionHostId: 'local', schedulerOwner: 'local', kindPayload: payload,
      worktreeId: payload.worktreeId ?? null, repoId: payload.repoId ?? null }
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
    if (world.mode !== 'approval') return { action: null, reason: 'fixture-idle', considered: ['fixture'] }
    return { action: { kind: 'fixture-action', capability: 'fixture.write', visibility: 'external', contentIdentity: p.snapshot.contentIdentity,
      evidenceKey: 'fixture-evidence', expectedState: { target: 'fixture-resource', before: null } }, considered: ['fixture-action'] }
  })
  context.provide('method:' + hook('execute'), p => {
    const e = p.enrollment ?? p.context?.enrollment
    if (!e) throw new Error('missing enrollment context')
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
  const builtins = join(root, 'builtins')
  mkdirSync(builtins)
  symlinkSync(resolve(import.meta.dir, '..'), join(builtins, 'quirky.heimdall'))
  symlinkSync(resolve(import.meta.dir, '../../quirky.ask'), join(builtins, 'quirky.ask'))
  installControlFixture(builtins)
  let h: Harness
  try { h = await startHarness({ home: join(root, 'home'), builtinPluginsDir: builtins, ...options }) }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
  const client = await h.connect('cli', 'heimdall-control-acceptance')
  return { root, h, client, async cleanup() { try { await h.cleanup() } finally { rmSync(root, { recursive: true, force: true }) } } }
}
