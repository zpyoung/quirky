import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type WorktreeCreateResult, type WorkspaceOriginView } from '@quirky/protocol'
import { MobileTestClient } from '../../quirky.mobile/test/support/client'
import { makeOrigin, makeProject } from './fixtures/repos'
import { isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, testCliContext, type PluginHarness } from '../../quirky.repo/test/harness'
import { commands } from '../cli'

isolateGitConfig()

const fixtures: PluginHarness[] = []
const mobileClients: MobileTestClient[] = []
let previousMobilePort: string | undefined
let changedMobilePort = false

type OriginWorld = { fixture: PluginHarness; repoId: string; projectPath: string }

async function start(options: { automation?: boolean; mobile?: boolean } = {}): Promise<OriginWorld> {
  const plugins = ['quirky.cli', 'quirky.repo', 'quirky.worktree']
  if (options.mobile) plugins.push('quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.ask', 'quirky.agent-status', 'quirky.structured', 'quirky.mobile')
  if (options.automation) plugins.push('quirky.ask', 'quirky.agents', 'quirky.checks', 'quirky.structured', 'quirky.session', 'quirky.automations')
  const fixture = await startPluginHarness({
    plugins,
    realGit: true,
    fakeAsk: !options.automation && !options.mobile,
    ...(options.automation || options.mobile ? { fakeSession: false } : {})
  })
  fixtures.push(fixture)
  const projectPath = makeProject(join(fixture.h.home, 'projects', 'origins'), {
    origin: makeOrigin(join(fixture.h.home, 'origin.git'))
  })
  const repo = await fixture.client.callAny('quirky.repo/add', { path: projectPath }) as { id: string }
  await fixture.client.callAny('setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: join(fixture.h.home, 'worktrees')
  })
  return { fixture, repoId: repo.id, projectPath }
}

function enableMobileListener(): void {
  if (!changedMobilePort) {
    previousMobilePort = process.env.QUIRKY_MOBILE_PORT
    changedMobilePort = true
  }
  process.env.QUIRKY_MOBILE_PORT = '0'
}

async function pair(fixture: PluginHarness): Promise<{ deviceId: string; client: MobileTestClient }> {
  const state = await fixture.client.callAny('quirky.mobile/state', {}) as { listener: { port: number | null } }
  if (state.listener.port === null) throw new Error('mobile listener did not start')
  const paired = await fixture.client.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { deviceId: string; pairingUrl: string }
  const code = new URL(paired.pairingUrl).searchParams.get('code')
  if (!code) throw new Error('pairing URL did not contain a code')
  const offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as { publicKeyB64: string; deviceToken: string }
  const client = MobileTestClient.connect(`ws://127.0.0.1:${state.listener.port}`, offer.publicKeyB64, offer.deviceToken)
  mobileClients.push(client)
  await client.authenticated
  return { deviceId: paired.deviceId, client }
}

function originFor(origins: WorkspaceOriginView[], worktreeId: string): WorkspaceOriginView | undefined {
  return origins.find((origin) => origin.worktreeId === worktreeId)
}

afterEach(async () => {
  for (const client of mobileClients.splice(0)) await client.close()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  if (changedMobilePort) {
    if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
  }
  previousMobilePort = undefined
  changedMobilePort = false
})

describe('quirky.worktree/origins public API', () => {
  test('ordinary API creates and forged surface fields are not automation evidence', async () => {
    const { fixture, repoId } = await start()
    const created = await fixture.client.callAny('quirky.worktree/create', {
      repo: repoId,
      name: 'Automation-looking workspace',
      displayName: 'Automation run',
      createdBy: 'window'
    }) as WorktreeCreateResult
    const origins = await fixture.client.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]

    expect(originFor(origins, created.worktree.id)).toEqual({
      worktreeId: created.worktree.id,
      automation: false,
      otherClient: null
    })
    await expect(fixture.client.callAny('quirky.worktree/create', {
      repo: repoId, name: 'forged-device', deviceId: 'paired-device-id'
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(JSON.stringify(origins)).not.toContain('paired-device-id')
  })
  test('authenticated desktop installation origins persist across connections, restart and exact instance replacement', async () => {
    const { fixture, repoId } = await start()
    const firstId = '00000000-0000-4000-8000-000000000001'
    const secondId = '00000000-0000-4000-8000-000000000002'
    const first = await fixture.connectAs({ desktopClientId: firstId }, 'ui')
    const second = await fixture.connectAs({ desktopClientId: secondId }, 'ui')
    expect(await first.callAny('ui.window.self', {})).toMatchObject({ desktopClientId: firstId })

    const firstCreated = await first.callAny('quirky.worktree/create', {
      repo: repoId, name: 'desktop-first'
    }) as WorktreeCreateResult
    const secondCreated = await second.callAny('quirky.worktree/create', {
      repo: repoId, name: 'desktop-second'
    }) as WorktreeCreateResult
    const beforeForgedCreate = (await first.callAny('quirky.worktree/list', { repo: repoId }) as Array<{ id: string }>).map((worktree) => worktree.id)
    await expect(first.callAny('quirky.worktree/create', {
      repo: repoId, name: 'forged-desktop', desktopClientId: secondId
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect((await first.callAny('quirky.worktree/list', { repo: repoId }) as Array<{ id: string }>).map((worktree) => worktree.id)).toEqual(beforeForgedCreate)

    const cliCreated = await fixture.client.callAny('quirky.worktree/create', {
      repo: repoId, name: 'cli-origin'
    }) as WorktreeCreateResult
    const firstView = await first.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    const secondView = await second.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(firstView, firstCreated.worktree.id)?.otherClient).toBe(false)
    expect(originFor(firstView, secondCreated.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondView, firstCreated.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondView, secondCreated.worktree.id)?.otherClient).toBe(false)
    expect(originFor(firstView, cliCreated.worktree.id)?.otherClient).toBeNull()
    const primary = (await fixture.client.callAny('quirky.worktree/list', { repo: repoId }) as Array<{ id: string; isMain: boolean }>).find((row) => row.isMain)!
    expect(originFor(firstView, primary.id)).toEqual({ worktreeId: primary.id, automation: null, otherClient: null })
    const identityless = await fixture.connectAs({}, 'ui')
    const identitylessView = await identityless.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(identitylessView, firstCreated.worktree.id)?.otherClient).toBeNull()
    expect(originFor(identitylessView, secondCreated.worktree.id)?.otherClient).toBeNull()
    expect(JSON.stringify([...firstView, ...secondView, ...identitylessView])).not.toContain(firstId)
    expect(JSON.stringify([...firstView, ...secondView, ...identitylessView])).not.toContain(secondId)

    const previousInstance = await first.callAny('quirky.worktree/create', {
      repo: repoId, name: 'reused-instance-path'
    }) as WorktreeCreateResult
    await fixture.client.callAny('quirky.worktree/remove', {
      worktree: `id:${previousInstance.worktree.id}`, yes: true
    })
    const replacement = await second.callAny('quirky.worktree/create', {
      repo: repoId, name: 'reused-instance-path'
    }) as WorktreeCreateResult
    expect(replacement.worktree.id).toBe(previousInstance.worktree.id)
    expect(replacement.worktree.instanceId).not.toBe(previousInstance.worktree.instanceId)
    const firstAfterReplacement = await first.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    const secondAfterReplacement = await second.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(firstAfterReplacement, replacement.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondAfterReplacement, replacement.worktree.id)?.otherClient).toBe(false)

    await fixture.restart()
    const firstReconnect = await fixture.connectAs({ desktopClientId: firstId }, 'ui')
    const secondReconnect = await fixture.connectAs({ desktopClientId: secondId }, 'ui')
    expect(await firstReconnect.callAny('ui.window.self', {})).toMatchObject({ desktopClientId: firstId })
    const firstAfterRestart = await firstReconnect.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    const secondAfterRestart = await secondReconnect.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(firstAfterRestart, firstCreated.worktree.id)?.otherClient).toBe(false)
    expect(originFor(firstAfterRestart, secondCreated.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondAfterRestart, firstCreated.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondAfterRestart, secondCreated.worktree.id)?.otherClient).toBe(false)
    expect(originFor(firstAfterRestart, replacement.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondAfterRestart, replacement.worktree.id)?.otherClient).toBe(false)
  })

  test('the actual automation producer is distinguished from generic API and its origin persists across restart', async () => {
    const { fixture, repoId } = await start({ automation: true })
    const generic = await fixture.client.callAny('quirky.worktree/create', {
      repo: repoId, name: 'ordinary-api', createdBy: 'api'
    }) as WorktreeCreateResult
    const definition = await fixture.client.callAny('quirky.automations/create', {
      name: 'Origin acceptance',
      prompt: 'Run the origin acceptance check.',
      agentId: 'codex',
      projectId: repoId,
      workspaceMode: 'new_per_run',
      setupDecision: 'skip',
      enabled: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    }) as { id: string; owner: unknown }
    const run = await fixture.client.callAny('quirky.automations/run', {
      id: definition.id, expectedOwner: definition.owner
    }) as { workspaceId: string | null }
    if (typeof run.workspaceId !== 'string') throw new Error('automation did not create a workspace')

    const beforeRestart = await fixture.client.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(beforeRestart, generic.worktree.id)?.automation).toBe(false)
    expect(originFor(beforeRestart, run.workspaceId!)).toEqual({
      worktreeId: run.workspaceId,
      automation: true,
      otherClient: null
    })
    expect(JSON.stringify(beforeRestart)).not.toContain('quirky.automations')

    const desktop = await fixture.connectAs({
      desktopClientId: '00000000-0000-4000-8000-000000000003'
    }, 'ui')
    const desktopView = await desktop.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(desktopView, run.workspaceId!)?.automation).toBe(true)
    expect(originFor(desktopView, run.workspaceId!)?.otherClient).toBeNull()
    await fixture.restart()
    const afterRestart = await fixture.client.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(afterRestart).toEqual(beforeRestart)
  })

  test('historical workspaces remain unknown and the public CLI reports the same views', async () => {
    const { fixture, repoId } = await start()
    const listed = await fixture.client.callAny('quirky.worktree/list', { repo: repoId }) as Array<{ id: string; isMain: boolean; createdBy: string }>
    const primary = listed.find((worktree) => worktree.isMain)!
    expect(primary.createdBy).toBe('external')
    const origins = await fixture.client.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(origins, primary.id)).toEqual({ worktreeId: primary.id, automation: null, otherClient: null })

    const { ctx, lines } = testCliContext(fixture.client, { json: true })
    await commands.origins!({ positionals: [], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!)).toEqual(origins)
  })

  test('paired devices get caller-relative views and recreation at the same path gets a new origin instance', async () => {
    enableMobileListener()
    const { fixture, repoId } = await start({ mobile: true })
    const first = await pair(fixture)
    const second = await pair(fixture)

    const firstWorkspace = (await first.client.call('quirky.worktree/create', {
      repo: repoId, name: 'paired-first'
    })) as WorktreeCreateResult
    const secondWorkspace = (await second.client.call('quirky.worktree/create', {
      repo: repoId, name: 'paired-second'
    })) as WorktreeCreateResult

    const firstView = await first.client.call('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    const secondView = await second.client.call('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(firstView, firstWorkspace.worktree.id)).toEqual({
      worktreeId: firstWorkspace.worktree.id, automation: false, otherClient: false
    })
    expect(originFor(firstView, secondWorkspace.worktree.id)).toEqual({
      worktreeId: secondWorkspace.worktree.id, automation: false, otherClient: true
    })
    expect(originFor(secondView, firstWorkspace.worktree.id)?.otherClient).toBe(true)
    expect(originFor(secondView, secondWorkspace.worktree.id)?.otherClient).toBe(false)
    expect(JSON.stringify([...firstView, ...secondView])).not.toContain(first.deviceId)
    expect(JSON.stringify([...firstView, ...secondView])).not.toContain(second.deviceId)

    const desktop = await fixture.connectAs({
      desktopClientId: '00000000-0000-4000-8000-000000000004'
    }, 'ui')
    const desktopView = await desktop.callAny('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(desktopView, firstWorkspace.worktree.id)?.otherClient).toBeNull()
    expect(originFor(desktopView, secondWorkspace.worktree.id)?.otherClient).toBeNull()
    await expect(first.client.call('quirky.worktree/create', {
      repo: repoId, name: 'forged-mobile', deviceId: second.deviceId
    })).rejects.toMatchObject({ code: RpcErrorCode.Unauthorized })

    const oldInstance = (await first.client.call('quirky.worktree/create', {
      repo: repoId, name: 'same-path'
    })) as WorktreeCreateResult
    await fixture.client.callAny('quirky.worktree/remove', { worktree: `id:${oldInstance.worktree.id}`, yes: true })
    const newInstance = (await second.client.call('quirky.worktree/create', {
      repo: repoId, name: 'same-path'
    })) as WorktreeCreateResult
    expect(newInstance.worktree.id).toBe(oldInstance.worktree.id)
    expect(newInstance.worktree.instanceId).not.toBe(oldInstance.worktree.instanceId)
    const afterRecreate = await first.client.call('quirky.worktree/origins', {}) as WorkspaceOriginView[]
    expect(originFor(afterRecreate, newInstance.worktree.id)).toEqual({
      worktreeId: newInstance.worktree.id, automation: false, otherClient: true
    })
  })
})
