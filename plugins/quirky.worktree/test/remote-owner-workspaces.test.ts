import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { isRecord } from '../src/loop-status'

const { scratch } = isolateGitConfig()
const plugins = ['quirky.cli', 'quirky.mobile', 'quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.git']
const harnesses: PluginHarness[] = []
let previousMobilePort: string | undefined
let previousMobileHost: string | undefined

type Mirror = {
  id: string
  hostId: string
  identity: { hostId: string; generation: string }
  worktree: Worktree
  connected: boolean
  fingerprint: string
}
type Host = { id: string; runtime: { id: string; name: string; endpoint: string; grantId: string }; identity: { hostId: string; generation: string }; connected: boolean; error: string | null }
type World = { local: PluginHarness; remote: PluginHarness; runtimeId: string; host: Host }

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
    fakeSession: false,
    home: makeHomeWithoutAutoHooks(prefix)
  })
  harnesses.push(harness)
  await call(harness.client, 'setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: makeTempDir(`${prefix}-worktrees-`)
  })
  return harness
}

async function world(prefix: string): Promise<World> {
  const local = await start(`${prefix}-local`)
  const remote = await start(`${prefix}-remote`)
  const pair = await call(remote.client, 'quirky.mobile/ownerPair', { name: `${prefix} owner`, confirm: true }) as { offer: string }
  const runtime = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: `${prefix} owner`,
    pairingCode: pair.offer
  }) as { id: string }
  const host = await call(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${runtime.id}`
  }) as Host
  return { local, remote, runtimeId: runtime.id, host }
}

function localWorktreeRow(harness: PluginHarness, id: string): { id: string; path: string | null; instance_id: string } | null {
  const db = new Database(join(harness.h.home, 'plugin-data', 'quirky.worktree', 'store.db'), { readonly: true })
  try {
    return db.query('SELECT id, path, instance_id FROM worktrees WHERE id = ?').get(id) as { id: string; path: string | null; instance_id: string } | null
  } finally {
    db.close()
  }
}
function rebindSavedOwnerGrant(home: string, pinnedId: string, replacementId: string): void {
  const path = join(home, 'paired-runtimes.json')
  const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(decoded) || !Array.isArray(decoded.runtimes)) throw new Error('the isolated owner target store was malformed')
  const targets = decoded.runtimes.filter(isRecord)
  const pinned = targets.find((target) => target.id === pinnedId)
  const replacement = targets.find((target) => target.id === replacementId)
  if (!pinned || !replacement) throw new Error('the isolated owner target store did not contain both saved targets')
  for (const field of ['pairingCode', 'endpoint', 'publicKeyB64', 'pairedDeviceId', 'scope', 'grantId']) {
    const value = replacement[field]
    if (typeof value !== 'string') throw new Error(`the replacement owner target has no ${field}`)
    pinned[field] = value
  }
  const encoded = JSON.stringify(decoded, null, 2)
  if (!encoded) throw new Error('the isolated owner target store could not be serialized')
  writeFileSync(path, encoded)
}


async function createSharedWorkspace(world: World, name: string): Promise<{ repoPath: string; remoteRepo: Repo; localRepo: Repo; worktree: Worktree }> {
  const repoPath = makeRepo(scratch())
  const remoteRepo = await call(world.remote.client, 'quirky.repo/add', { path: repoPath }) as Repo
  const localRepo = await call(world.local.client, 'quirky.repo/add', { path: repoPath }) as Repo
  const created = await call(world.remote.client, 'quirky.worktree/create', { repo: remoteRepo.id, name }) as WorktreeCreateResult
  const localRows = await call(world.local.client, 'quirky.worktree/list', { repo: localRepo.id }) as Worktree[]
  expect(localRows.some((row) => row.id === created.worktree.id)).toBe(true)
  return { repoPath, remoteRepo, localRepo, worktree: created.worktree }
}

async function attach(local: PluginHarness, host: Host, worktree: Worktree): Promise<Mirror> {
  return await call(local.client, 'quirky.worktree/remoteAttach', { host: host.id, worktree: worktree.id }) as Mirror
}

test('owner host registration survives local restart and remote generations or grant changes require explicit replacement', async () => {
  const { local, remote, runtimeId, host } = await world('qw-owner-registry')
  expect(host.connected).toBe(true)
  expect(host.identity.hostId).toBeTruthy()
  expect(host.identity.generation).toBeTruthy()
  expect(host.runtime.id).toBe(runtimeId)

  await local.restart()
  const afterLocalRestart = await call(local.client, 'quirky.worktree/remoteHostStatus', { host: host.id }) as Host
  expect(afterLocalRestart).toMatchObject({ id: host.id, identity: host.identity, connected: true })
  const registered = await call(local.client, 'quirky.worktree/remoteHostList') as { hosts: Host[] }
  expect(registered.hosts).toContainEqual(expect.objectContaining({ id: host.id, identity: host.identity }))

  const replacementPair = await call(remote.client, 'quirky.mobile/ownerPair', { name: 'Changed owner grant', confirm: true }) as { offer: string }
  const replacementRuntime = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: 'Changed owner grant',
    pairingCode: replacementPair.offer
  }) as { id: string }
  await expect(call(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${replacementRuntime.id}`
  })).rejects.toThrow(/replace|generation|grant|identity/i)
  const grantReplaced = await call(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${replacementRuntime.id}`,
    replace: true
  }) as Host
  expect(grantReplaced.id).toBe(host.id)
  expect(grantReplaced.runtime.id).toBe(replacementRuntime.id)
  expect(grantReplaced.runtime.grantId).not.toBe(host.runtime.grantId)

  await remote.restart()
  const afterRemoteRestart = await call(local.client, 'quirky.worktree/remoteHostStatus', { host: host.id }) as Host
  expect(afterRemoteRestart.connected).toBe(false)
  expect(afterRemoteRestart.identity).toEqual(host.identity)
  await expect(call(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${replacementRuntime.id}`
  })).rejects.toThrow(/replace|generation|grant|identity/i)

  const replaced = await call(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${replacementRuntime.id}`,
    replace: true
  }) as Host
  expect(replaced.id).toBe(host.id)
  expect(replaced.identity.hostId).toBe(host.identity.hostId)
  expect(replaced.identity.generation).not.toBe(host.identity.generation)

  const phone = await call(remote.client, 'quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const phoneTarget = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: 'phone only',
    pairingCode: phone.pairingUrl
  }) as { id: string }
  await expect(call(local.client, 'quirky.worktree/remoteHostRegister', { runtime: `runtime:${phoneTarget.id}` })).rejects.toThrow(/owner|phone|scope|runtime/i)
})

test('offline host status preserves the last mirror snapshot but makes it unavailable', async () => {
  const { local, remote, host } = await world('qw-owner-offline')
  const { worktree } = await createSharedWorkspace({ local, remote, runtimeId: '', host }, 'offline-snapshot')
  const mirror = await attach(local, host, worktree)
  const listedBefore = await call(local.client, 'quirky.worktree/remoteList', { host: host.id }) as { workspaces: Mirror[] }
  expect(listedBefore.workspaces.some((row) => row.id === mirror.id && row.connected)).toBe(true)

  await remote.h.daemon.stop()
  remote.h.pty.stop()
  const status = await call(local.client, 'quirky.worktree/remoteHostStatus', { host: host.id }) as Host
  expect(status.connected).toBe(false)
  expect(status.error).toBeTruthy()

  const offline = await call(local.client, 'quirky.worktree/remoteList', { host: host.id }) as { workspaces: Mirror[] }
  expect(offline.workspaces).toContainEqual(expect.objectContaining({ id: mirror.id, connected: false, worktree: expect.objectContaining({ id: worktree.id, instanceId: worktree.instanceId }) }))
})

test('old mirror instances cannot navigate or remove a replacement or mutate a local same-path row', async () => {
  const { local, remote, host } = await world('qw-owner-stale-instance')
  const { repoPath, localRepo, worktree } = await createSharedWorkspace({ local, remote, runtimeId: '', host }, 'reused-path')
  const mirror = await attach(local, host, worktree)
  const shown = await call(local.client, 'quirky.worktree/remoteShow', { workspace: mirror.id }) as Mirror
  expect(shown).toMatchObject({ id: mirror.id, connected: true, worktree: { id: worktree.id, instanceId: worktree.instanceId } })
  const localRowBefore = localWorktreeRow(local, worktree.id)
  expect(localRowBefore).toMatchObject({ id: worktree.id, path: worktree.path, instance_id: worktree.instanceId })

  const ui = await local.connectAs({}, 'ui')
  const state = await call(local.client, 'ui.state') as { windows: Array<{ connId: number }> }
  const connId = state.windows[0]!.connId
  await call(local.client, 'quirky.worktree/remoteNavigate', { workspace: mirror.id, window: connId })
  const window = await call(ui, 'ui.window.state', { connId }) as { layout: { view: { id: string; input: unknown } | null } }
  expect(window.layout.view).toEqual({ id: 'view:quirky.worktree/remote', input: { workspace: mirror.id } })

  await call(remote.client, 'quirky.worktree/remove', { worktree: `id:${worktree.id}`, safeOnly: true, skipArchive: true })
  const recreated = await call(remote.client, 'quirky.worktree/create', { repo: worktree.repoId, name: 'reused-path' }) as WorktreeCreateResult
  expect(recreated.worktree.id).toBe(worktree.id)
  expect(recreated.worktree.instanceId).not.toBe(worktree.instanceId)
  await expect(call(remote.client, 'quirky.worktree/remove', {
    worktree: `id:${worktree.id}`,
    safeOnly: true,
    skipArchive: true,
    expectedInstanceId: worktree.instanceId
  })).rejects.toThrow(/instance|changed|replaced|identity/i)
  await call(local.client, 'quirky.worktree/remoteRefresh', { host: host.id })

  await expect(call(local.client, 'quirky.worktree/remoteNavigate', { workspace: mirror.id, window: connId })).rejects.toThrow(/instance|changed|refresh|stale/i)
  await expect(call(local.client, 'quirky.worktree/remoteRemove', {
    workspace: mirror.id,
    fingerprint: mirror.fingerprint,
    confirmed: true
  })).rejects.toThrow(/instance|changed|refresh|stale/i)
  expect(existsSync(repoPath)).toBe(true)
  expect(localWorktreeRow(local, worktree.id)).toEqual(localRowBefore)
  expect((await call(local.client, 'quirky.repo/show', { repo: localRepo.id }) as { repo: Repo }).repo.path).toBe(repoPath)
})

test('remote cleanup removal requires fresh canonical preview evidence for the same instance', async () => {
  const { local, remote, host } = await world('qw-owner-cleanup')
  const { worktree } = await createSharedWorkspace({ local, remote, runtimeId: '', host }, 'cleanup-instance')
  const archivedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
  await call(remote.client, 'quirky.worktree/archive', { worktree: worktree.id, archivedAt })
  const mirror = await attach(local, host, worktree)
  const preview = await call(local.client, 'quirky.worktree/remoteCleanupPreview', { workspace: mirror.id }) as {
    workspace: string
    instanceId: string
    generatedAt: number
    candidate: { worktreeId: string; fingerprint: string; eligible: boolean } | null
  }
  expect(preview).toMatchObject({ workspace: mirror.id, instanceId: worktree.instanceId })
  expect(preview.candidate).toMatchObject({ worktreeId: worktree.id, eligible: true })

  await call(remote.client, 'quirky.worktree/remove', { worktree: `id:${worktree.id}`, safeOnly: true, skipArchive: true })
  const replacement = await call(remote.client, 'quirky.worktree/create', { repo: worktree.repoId, name: 'cleanup-instance' }) as WorktreeCreateResult
  expect(replacement.worktree.instanceId).not.toBe(worktree.instanceId)
  const replacementArchivedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
  await call(remote.client, 'quirky.worktree/archive', { worktree: replacement.worktree.id, archivedAt: replacementArchivedAt })
  await call(local.client, 'quirky.worktree/remoteRefresh', { host: host.id })
  const replacementMirror = (await call(local.client, 'quirky.worktree/remoteList', { host: host.id }) as { workspaces: Mirror[] })
    .workspaces.find((row) => row.worktree.instanceId === replacement.worktree.instanceId)!
  const replacementPreview = await call(local.client, 'quirky.worktree/remoteCleanupPreview', { workspace: replacementMirror.id }) as {
    candidate: { fingerprint: string; eligible: boolean } | null
  }
  expect(replacementPreview.candidate).toMatchObject({ eligible: true })

  const canonicalCleanup = await call(remote.client, 'quirky.worktree/cleanupRemove', {
    selection: [{
      worktreeId: replacement.worktree.id,
      fingerprint: replacementPreview.candidate!.fingerprint,
      expectedInstanceId: worktree.instanceId
    }],
    confirmed: true
  }) as { results: Array<{ removed: boolean; error?: string }> }
  expect(canonicalCleanup.results[0]).toMatchObject({ removed: false })
  expect(canonicalCleanup.results[0]!.error).toMatch(/instance|changed|replaced|identity/i)
  expect(existsSync(worktree.path)).toBe(true)
  await expect(call(local.client, 'quirky.worktree/remoteCleanupRemove', {
    workspace: mirror.id,
    fingerprint: preview.candidate!.fingerprint,
    confirmed: true
  })).rejects.toThrow(/instance|changed|refresh|stale/i)

  expect(existsSync(worktree.path)).toBe(true)
})

test('remoteCall is restricted to bound worktree changes and real terminal operations', async () => {
  const { local, remote, host } = await world('qw-owner-remote-call')
  const { worktree } = await createSharedWorkspace({ local, remote, runtimeId: '', host }, 'remote-call')
  const mirror = await attach(local, host, worktree)
  const changes = await call(local.client, 'quirky.worktree/remoteCall', { workspace: mirror.id, operation: 'changes' }) as { entries: unknown[] }
  expect(Array.isArray(changes.entries)).toBe(true)
  await expect(call(local.client, 'quirky.worktree/remoteCall', {
    workspace: mirror.id,
    method: 'quirky.worktree/remove',
    params: { worktree: worktree.id }
  })).rejects.toThrow(/operation|unsupported|restricted/i)
  await expect(call(local.client, 'quirky.worktree/remoteCall', {
    workspace: mirror.id,
    operation: 'terminalWrite',
    session: 'not-bound-to-this-worktree',
    data: 'echo unsafe\\n'
  })).rejects.toThrow(/session|bound|worktree/i)

  const created = await call(local.client, 'quirky.worktree/remoteCall', {
    workspace: mirror.id,
    operation: 'terminalCreate',
    title: 'Bound remote shell'
  }) as { id: string; worktreeId: string }
  expect(created.worktreeId).toBe(worktree.id)
  const screen = await call(local.client, 'quirky.worktree/remoteCall', {
    workspace: mirror.id,
    operation: 'terminalRead',
    session: created.id,
    lines: 0
  }) as { lines: string[] }
  expect(Array.isArray(screen.lines)).toBe(true)
  await expect(call(local.client, 'quirky.worktree/remoteCall', {
    workspace: mirror.id,
    operation: 'terminalWrite',
    session: created.id,
    data: 'printf remote-owner-terminal\r'
  })).resolves.toMatchObject({ ok: true })
  await call(remote.client, 'quirky.session/close', { session: created.id })
})

test('confirmed remote removal never closes a live owner session or edits the same-path local row', async () => {
  const { local, remote, host } = await world('qw-owner-safe-remove')
  const { worktree } = await createSharedWorkspace({ local, remote, runtimeId: '', host }, 'safe-remove')
  const mirror = await attach(local, host, worktree)
  const localRowBefore = localWorktreeRow(local, worktree.id)
  const session = await call(remote.client, 'quirky.session/create', {
    worktree: worktree.id,
    agent: 'shell'
  }) as { id: string }

  await expect(call(local.client, 'quirky.worktree/remoteRemove', {
    workspace: mirror.id,
    fingerprint: mirror.fingerprint,
    confirmed: true
  })).rejects.toThrow(/owner|remove|unavailable|rejected/i)
  const liveSessions = await call(remote.client, 'quirky.session/list', { worktree: worktree.id }) as Array<{ id: string }>
  expect(liveSessions.some((row) => row.id === session.id)).toBe(true)
  expect(existsSync(worktree.path)).toBe(true)

  await call(remote.client, 'quirky.session/close', { session: session.id })
  const removed = await call(local.client, 'quirky.worktree/remoteRemove', {
    workspace: mirror.id,
    fingerprint: mirror.fingerprint,
    confirmed: true
  }) as { ok: true; workspace: string }
  expect(removed).toMatchObject({ ok: true, workspace: mirror.id })
  expect(localWorktreeRow(local, worktree.id)).toEqual(localRowBefore)
})

test('host forget refuses attached snapshots and confirmed local detach preserves the remote source', async () => {
  const { local, remote, host } = await world('qw-owner-forget')
  const repoPath = makeRepo(scratch())
  const repo = await call(remote.client, 'quirky.repo/add', { path: repoPath }) as Repo
  const created = await call(remote.client, 'quirky.worktree/create', { repo: repo.id, name: 'forget-detach' }) as WorktreeCreateResult
  const mirror = await attach(local, host, created.worktree)
  expect(localWorktreeRow(local, created.worktree.id)).toBeNull()

  await expect(call(local.client, 'quirky.worktree/remoteHostForget', {
    host: host.id,
    confirmed: true
  })).rejects.toThrow(/attachments|detach/i)
  await expect(call(local.client, 'quirky.worktree/remoteHostForget', {
    host: host.id,
    detach: true,
    confirmed: false
  })).rejects.toThrow(/confirmed/i)

  const forgotten = await call(local.client, 'quirky.worktree/remoteHostForget', {
    host: host.id,
    detach: true,
    confirmed: true
  }) as { ok: true; detached: number }
  expect(forgotten).toEqual({ ok: true, detached: 1 })
  const sourceRows = await call(remote.client, 'quirky.worktree/list') as Worktree[]
  expect(sourceRows.some((row) => row.id === created.worktree.id)).toBe(true)
  const mirrors = await call(local.client, 'quirky.worktree/remoteList') as { workspaces: Mirror[] }
  expect(mirrors.workspaces.some((row) => row.id === mirror.id)).toBe(false)
})

test('a rebound grant for the same owner host is fenced before remote removal', async () => {
  const { local, remote, runtimeId, host } = await world('qw-owner-grant-fence')
  const { worktree } = await createSharedWorkspace({ local, remote, runtimeId, host }, 'grant-fence')
  const mirror = await attach(local, host, worktree)
  const nextOffer = await call(remote.client, 'quirky.mobile/ownerPair', { name: 'Rebound owner grant', confirm: true }) as { offer: string }
  const replacement = await call(local.client, 'quirky.cli/runtimeAdd', {
    name: 'Rebound owner grant',
    pairingCode: nextOffer.offer
  }) as { id: string }
  const reboundIdentity = await call(local.client, 'quirky.cli/runtimeCall', {
    runtime: `runtime:${replacement.id}`,
    method: 'quirky.cli/hostIdentity'
  }) as { runtime: Host['runtime']; result: Host['identity'] }
  expect(reboundIdentity.result).toEqual(host.identity)
  expect(reboundIdentity.runtime.grantId).not.toBe(host.runtime.grantId)

  rebindSavedOwnerGrant(local.h.home, runtimeId, replacement.id)
  await expect(call(local.client, 'quirky.cli/runtimeCall', {
    runtime: `runtime:${runtimeId}`,
    method: 'quirky.worktree/remove',
    params: {
      worktree: `id:${worktree.id}`,
      safeOnly: true,
      skipArchive: true,
      expectedInstanceId: worktree.instanceId,
      yes: true
    },
    expectedHost: host.identity,
    expectedRuntime: {
      id: host.runtime.id,
      endpoint: host.runtime.endpoint,
      grantId: host.runtime.grantId
    }
  })).rejects.toThrow(/runtime|grant|pin|changed/i)
  await expect(call(local.client, 'quirky.worktree/remoteRemove', {
    workspace: mirror.id,
    fingerprint: mirror.fingerprint,
    confirmed: true
  })).rejects.toThrow(/runtime|grant|pin|changed|unavailable/i)
  expect(existsSync(worktree.path)).toBe(true)
  const remoteRows = await call(remote.client, 'quirky.worktree/list') as Worktree[]
  expect(remoteRows.some((row) => row.id === worktree.id && row.instanceId === worktree.instanceId)).toBe(true)
})
