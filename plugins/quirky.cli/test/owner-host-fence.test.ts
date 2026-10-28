import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'

type HostIdentity = { hostId: string; generation: string }
type Started = { home: string; harness: Harness; caller: QuirkyClient }

const harnesses: Harness[] = []
const tempHomes: string[] = []
let oldMobilePort: string | undefined
let oldMobileHost: string | undefined

beforeEach(() => {
  oldMobilePort = process.env.QUIRKY_MOBILE_PORT
  oldMobileHost = process.env.QUIRKY_MOBILE_HOST
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
})

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true })
  removeTempDirs()
  if (oldMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
  else process.env.QUIRKY_MOBILE_PORT = oldMobilePort
  if (oldMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
  else process.env.QUIRKY_MOBILE_HOST = oldMobileHost
})

async function start(options: { home?: string; port?: number } = {}): Promise<Started> {
  const builtins = makeTempDir('quirky-cli-host-fence-builtins-')
  symlinkSync(resolve(import.meta.dir, '..'), join(builtins, 'quirky.cli'))
  symlinkSync(resolve(import.meta.dir, '../../quirky.mobile'), join(builtins, 'quirky.mobile'))
  const harness = await startHarness({ ...options, builtinPluginsDir: builtins })
  harnesses.push(harness)
  return { home: harness.home, harness, caller: await harness.connect('cli') }
}

async function restart(started: Started): Promise<Started> {
  await started.caller.close()
  await started.harness.daemon.stop()
  await started.harness.pty.stop()
  const index = harnesses.indexOf(started.harness)
  if (index !== -1) harnesses.splice(index, 1)
  return start({ home: started.home, port: started.harness.runtime.port })
}

function identity(value: unknown): HostIdentity {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  expect(value).toEqual({ hostId: expect.stringMatching(uuid), generation: expect.stringMatching(uuid) })
  return value as HostIdentity
}

test('host identity keeps its durable UUID and rotates generation after a daemon restart', async () => {
  const home = makeTempHome('quirky-cli-host-identity-home-')
  tempHomes.push(home)
  const firstHost = await start({ home })
  const first = identity(await firstHost.caller.callAny('quirky.cli/hostIdentity', {}))

  const restarted = await restart(firstHost)
  const second = identity(await restarted.caller.callAny('quirky.cli/hostIdentity', {}))

  expect(second.hostId).toBe(first.hostId)
  expect(second.generation).not.toBe(first.generation)
})

test('runtimeCall rejects stale host and saved-runtime pins before mutation and never upgrades phone grants', async () => {
  const local = await start()
  const remoteHome = makeTempHome('quirky-cli-host-fence-remote-')
  tempHomes.push(remoteHome)
  let remote = await start({ home: remoteHome })
  const initialHost = identity(await remote.caller.callAny('quirky.cli/hostIdentity', {}))
  const paired = await remote.caller.callAny('quirky.mobile/ownerPair', {
    name: 'Remote owner', confirm: true, address: '127.0.0.1'
  }) as { offer: string }
  const ownerTarget = await local.caller.callAny('quirky.cli/runtimeAdd', {
    name: 'Fenced owner', pairingCode: paired.offer
  }) as { id: string; endpoint: string; grantId: string }
  const ownerPin = { id: ownerTarget.id, endpoint: ownerTarget.endpoint, grantId: ownerTarget.grantId }

  await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/configure',
    params: { machineName: 'before-restart' },
    expectedHost: initialHost,
    expectedRuntime: ownerPin
  })
  remote = await restart(remote)
  const currentResult = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.cli/hostIdentity',
    params: {},
    expectedRuntime: ownerPin
  }) as { result: unknown }
  const currentHost = identity(currentResult.result)
  expect(currentHost.hostId).toBe(initialHost.hostId)
  expect(currentHost.generation).not.toBe(initialHost.generation)

  const attempts: { fence: { expectedHost: unknown }; code: number }[] = [
    { fence: { expectedHost: initialHost }, code: RpcErrorCode.Conflict },
    { fence: { expectedHost: { hostId: `${currentHost.hostId}-foreign`, generation: currentHost.generation } }, code: RpcErrorCode.Conflict },
    { fence: { expectedHost: { hostId: currentHost.hostId, generation: '' } }, code: RpcErrorCode.InvalidParams },
    { fence: { expectedHost: { hostId: currentHost.hostId, generation: currentHost.generation, extra: true } }, code: RpcErrorCode.InvalidParams }
  ]
  for (const { fence, code } of attempts) {
    await expect(local.caller.callAny('quirky.cli/runtimeCall', {
      runtime: ownerTarget.id,
      method: 'quirky.mobile/configure',
      params: { machineName: 'must-not-be-forwarded' },
      ...fence,
      expectedRuntime: ownerPin
    })).rejects.toMatchObject({ code })
  }

  const afterRejectedCalls = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/state',
    params: {},
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  }) as { result: { machineName: string } }
  expect(afterRejectedCalls.result.machineName).toBe('before-restart')

  const replacementPair = await remote.caller.callAny('quirky.mobile/ownerPair', {
    name: 'Replacement owner', confirm: true, address: '127.0.0.1'
  }) as { offer: string }
  const replacementTarget = await local.caller.callAny('quirky.cli/runtimeAdd', {
    name: 'Replacement grant', pairingCode: replacementPair.offer
  }) as { id: string; endpoint: string; grantId: string }
  const replacementPin = { id: replacementTarget.id, endpoint: replacementTarget.endpoint, grantId: replacementTarget.grantId }
  expect(replacementTarget.id).not.toBe(ownerTarget.id)
  expect(replacementTarget.grantId).not.toBe(ownerTarget.grantId)
  const replacementHost = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: replacementTarget.id,
    method: 'quirky.cli/hostIdentity',
    params: {},
    expectedHost: currentHost,
    expectedRuntime: replacementPin
  }) as { result: unknown }
  expect(identity(replacementHost.result)).toEqual(currentHost)

  await expect(local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: replacementTarget.id,
    method: 'quirky.mobile/configure',
    params: { machineName: 'changed-grant-must-not-be-forwarded' },
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })

  const changedPins = [
    { ...ownerPin, id: `${ownerPin.id}-changed` },
    { ...ownerPin, endpoint: `${ownerPin.endpoint}-changed` },
    { ...ownerPin, grantId: `${ownerPin.grantId}-changed` }
  ]
  for (const expectedRuntime of changedPins) {
    await expect(local.caller.callAny('quirky.cli/runtimeCall', {
      runtime: ownerTarget.id,
      method: 'quirky.mobile/configure',
      params: { machineName: 'changed-runtime-pin-must-not-be-forwarded' },
      expectedHost: currentHost,
      expectedRuntime
    })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  }

  const afterPinRefusals = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/state',
    params: {},
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  }) as { result: { machineName: string } }
  expect(afterPinRefusals.result.machineName).toBe('before-restart')

  for (const expectedRuntime of [
    { id: '', endpoint: ownerPin.endpoint, grantId: ownerPin.grantId },
    { ...ownerPin, id: 1 },
    { ...ownerPin, endpoint: 1 },
    { ...ownerPin, endpoint: '' },
    { ...ownerPin, grantId: 1 },
    { ...ownerPin, grantId: '' },
    { ...ownerPin, extra: true }
  ]) {
    await expect(local.caller.callAny('quirky.cli/runtimeCall', {
      runtime: ownerTarget.id,
      method: 'quirky.mobile/configure',
      params: { machineName: 'malformed-runtime-pin-must-not-be-forwarded' },
      expectedHost: currentHost,
      expectedRuntime
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  }
  const afterMalformedPins = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/state',
    params: {},
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  }) as { result: { machineName: string } }
  expect(afterMalformedPins.result.machineName).toBe('before-restart')


  await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/configure',
    params: { machineName: 'after-restart' },
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  })
  const phonePair = await remote.caller.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const phoneTarget = await local.caller.callAny('quirky.cli/runtimeAdd', {
    name: 'Phone grant', pairingCode: phonePair.pairingUrl
  }) as { id: string }
  await expect(local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: phoneTarget.id,
    method: 'quirky.mobile/configure',
    params: { machineName: 'phone-must-not-be-upgraded' },
    expectedHost: currentHost
  })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })

  const finalState = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: ownerTarget.id,
    method: 'quirky.mobile/state',
    params: {},
    expectedHost: currentHost,
    expectedRuntime: ownerPin
  }) as { result: { machineName: string } }
  expect(finalState.result.machineName).toBe('after-restart')
})
