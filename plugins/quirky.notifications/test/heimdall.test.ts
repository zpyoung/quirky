import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { builtinsDir, makeTempHome, waitForAsync } from '../../../packages/daemon/test/helpers'
import { fixtureId, installControlFixture } from '../../quirky.heimdall/test/control-fixture'
import type { WatcherDetail } from '../../quirky.heimdall/src/control-contracts'
import { Rig } from './support'

let rig: Rig
beforeAll(async () => {
  const home = makeTempHome('heimdall-notifications-')
  const builtins = join(home, 'builtins')
  mkdirSync(builtins)
  for (const item of readdirSync(builtinsDir(), { withFileTypes: true })) {
    const pluginDir = join(builtinsDir(), item.name)
    if (item.isDirectory() && existsSync(join(pluginDir, 'quirky-plugin.json'))) symlinkSync(pluginDir, join(builtins, item.name))
  }
  installControlFixture(builtins)
  rig = await Rig.start({ home, builtinPluginsDir: builtins })
})
afterAll(async () => { await rig?.cleanup() })
const detail = (id: string) => rig.client.callAny('quirky.heimdall/detail', { target: { watcherId: id } }) as Promise<WatcherDetail>
async function enroll(workspace: string, worktreeId: string): Promise<string> {
  const result = await rig.client.callAny('quirky.heimdall/enroll', { kind: 'objective', kindPayload: { workspace, worktreeId }, capabilities: { 'fixture.write': 'gated' } }) as { enrollment: { watcherId: string } }
  const id = result.enrollment.watcherId
  await waitForAsync(async () => (await detail(id)).traces.some(trace => trace.exitPath === 'watching'), 5000)
  await rig.client.callAny('quirky.heimdall/fleet', {})
  return id
}
async function configure(workspace: string, id: string, value: Record<string, unknown>) {
  await rig.client.callAny(`${fixtureId}/configure`, { workspace, ...value })
  await rig.client.callAny('quirky.heimdall/reconcile', { watcherId: id })
}

describe('Heimdall transitions use the sole notification policy', () => {
  test('a new exact approval delivers once; folded repeats do not notify again', async () => {
    const wt = await rig.worktree('heimdall-approval')
    const id = await enroll('notification-approval', wt.id)
    await configure('notification-approval', id, { mode: 'approval' })
    const delivered = await waitForAsync(async () => rig.notifies().find(event => event.title === 'Watcher approval requested' && event.worktreeId === wt.id), 5000)
    expect(delivered).toMatchObject({ body: 'fixture-action is waiting for approval', open: { view: 'view:quirky.heimdall/fleet', input: { watcherId: id } } })
    const before = (await detail(id)).traces.at(-1)!.seq
    await rig.client.callAny('quirky.heimdall/reconcile', { watcherId: id })
    await waitForAsync(async () => (await detail(id)).traces.some(trace => trace.seq > before), 5000)
    await rig.client.callAny('quirky.heimdall/fleet', {})
    expect(rig.notifies().filter(event => event.title === 'Watcher approval requested' && event.worktreeId === wt.id)).toEqual([delivered])
  }, 15000)

  test('terminal transition honors the shared enabled switch and emits no native or toast event when disabled', async () => {
    const wt = await rig.worktree('heimdall-disabled')
    const id = await enroll('notification-disabled', wt.id)
    await rig.setting('enabled', false)
    await configure('notification-disabled', id, { terminal: true })
    await waitForAsync(async () => (await detail(id)).enrollment.terminalAtMs !== null, 5000)
    await waitForAsync(async () => rig.decisions().find(event => event.source === 'heimdall' && event.worktreeId === wt.id && event.result === 'disabled'), 5000)
    expect(rig.notifies().filter(event => event.worktreeId === wt.id)).toEqual([])
    await rig.setting('enabled', true)
  }, 15000)

  test('terminal transition delivers the real final reason and opens its detail', async () => {
    const wt = await rig.worktree('heimdall-terminal')
    const id = await enroll('notification-terminal', wt.id)
    await configure('notification-terminal', id, { terminal: true })
    const delivered = await waitForAsync(async () => rig.notifies().find(event => event.title === 'Watcher reached a terminal state' && event.worktreeId === wt.id), 5000)
    expect(delivered).toMatchObject({ body: 'complete: fixture landing bar reached', open: { view: 'view:quirky.heimdall/fleet', input: { watcherId: id } } })
  }, 15000)
})
