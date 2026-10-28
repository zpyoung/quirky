import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

const { scratch } = isolateGitConfig()
const plugins = ['quirky.cli', 'quirky.mobile', 'quirky.repo', 'quirky.worktree', 'quirky.terminal', 'quirky.git']
const harnesses: PluginHarness[] = []
let previousMobilePort: string | undefined
let previousMobileHost: string | undefined

beforeEach(() => {
  previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  previousMobileHost = process.env.QUIRKY_MOBILE_HOST
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
})

afterEach(async () => {
  try {
    for (const harness of harnesses.splice(0).reverse()) await harness.cleanup()
  } finally {
    if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
    if (previousMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
    else process.env.QUIRKY_MOBILE_HOST = previousMobileHost
    previousMobilePort = undefined
    previousMobileHost = undefined
  }
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function start(prefix: string): Promise<PluginHarness> {
  const harness = await startPluginHarness({
    realGit: true,
    plugins,
    fakeSession: true,
    home: makeHomeWithoutAutoHooks(prefix)
  })
  harnesses.push(harness)
  await call(harness.client, 'setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: makeTempDir(`${prefix}-worktrees-`)
  })
  return harness
}

test('remote worktree create mutates only the saved owner runtime and refuses unknown or phone targets', async () => {
  const local = await start('qw-remote-create-local-')
  const remote = await start('qw-remote-create-remote-')
  const repoPath = makeRepo(scratch())
  const remoteRepo = await call(remote.client, 'quirky.repo/add', { path: repoPath }) as Repo
  const folderRepo = await call(remote.client, 'quirky.repo/add', {
    path: makeTempDir('qw-remote-folder-repo-'),
    folder: true
  }) as Repo
  const ownerPair = await call(remote.client, 'quirky.mobile/ownerPair', {
    name: 'Remote worktree host',
    confirm: true
  }) as { offer: string }
  const ownerTarget = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: 'Remote worktree host',
    pairingCode: ownerPair.offer
  }) as { id: string; name: string }
  const phonePair = await call(remote.client, 'quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const phoneTarget = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: 'Phone-only target',
    pairingCode: phonePair.pairingUrl
  }) as { id: string }

  const beforeRemote = await call(remote.client, 'quirky.worktree/list') as Worktree[]
  await expect(call(local.client, 'quirky.worktree/createRemote', {
    runtime: 'runtime:missing-owner-target',
    repo: remoteRepo.id,
    name: 'unknown-owner-target'
  })).rejects.toThrow()
  await expect(call(local.client, 'quirky.worktree/createRemote', {
    runtime: `runtime:${phoneTarget.id}`,
    repo: remoteRepo.id,
    name: 'phone-target'
  })).rejects.toThrow()
  await expect(call(local.client, 'quirky.worktree/createRemote', {
    runtime: `runtime:${ownerTarget.id}`,
    repo: folderRepo.id,
    name: 'remote-folder-workspace'
  })).rejects.toThrow()
  expect(await call(remote.client, 'quirky.worktree/list')).toEqual(beforeRemote)
  expect(await call(local.client, 'quirky.worktree/list')).toEqual([])

  const apiResult = await call(local.client, 'quirky.worktree/createRemote', {
    runtime: `runtime:${ownerTarget.id}`,
    repo: remoteRepo.id,
    name: 'remote-api-worktree'
  }) as {
    runtime: { id: string; name: string; grantId: string }
    result: WorktreeCreateResult
  }
  expect(apiResult.runtime).toMatchObject({ id: ownerTarget.id, name: ownerTarget.name })
  expect(apiResult.runtime.grantId).toBeTruthy()
  expect(apiResult.result.worktree).toMatchObject({ name: 'remote-api-worktree', instanceId: expect.any(String) })
  const remoteRows = await call(remote.client, 'quirky.worktree/list') as Worktree[]
  expect(remoteRows.find((row) => row.id === apiResult.result.worktree.id)).toMatchObject({
    id: apiResult.result.worktree.id,
    repoId: remoteRepo.id,
    instanceId: apiResult.result.worktree.instanceId
  })
  expect((await call(local.client, 'quirky.worktree/list') as Worktree[]).some((row) => row.id === apiResult.result.worktree.id)).toBe(false)

  const cli = spawnCli([
    'worktree', 'create', remoteRepo.id, 'remote-cli-worktree',
    '--on-runtime', `runtime:${ownerTarget.id}`, '--json'
  ], { home: local.h.home })
  const [stdout, stderr, code] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited
  ])
  expect(code).toBe(0)
  expect(stderr).toBe('')
  const cliResult = JSON.parse(stdout) as typeof apiResult
  expect(cliResult.runtime).toMatchObject({ id: ownerTarget.id, name: ownerTarget.name })
  expect(cliResult.result.worktree.name).toBe('remote-cli-worktree')
  expect((await call(local.client, 'quirky.worktree/list') as Worktree[])).toHaveLength(0)

  const ui = await local.connectAs({}, 'ui')
  const state = await call(local.client, 'ui.state') as { windows: Array<{ connId: number }> }
  const [window] = state.windows
  await expect(call(local.client, 'quirky.worktree/navigate', {
    worktree: apiResult.result.worktree.id,
    window: window!.connId
  })).rejects.toThrow(/not found|workspace|worktree/i)
  expect((await call(ui, 'ui.window.state', { connId: window!.connId }) as { layout: { view: unknown } }).layout.view).toBeNull()
})
