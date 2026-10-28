import { randomUUID } from 'node:crypto'
import type { OwnerCliPairOffer, OwnerHostIdentity, OwnerRuntimeCallParams, OwnerRuntimeCallResult, PluginContext } from '@quirky/protocol'
import { createMobileRpc, parseOwnerCliOffer, type MobileRpc } from '@quirky/protocol/paired-client'
import {
  addSavedRuntimeTarget,
  commandStatus,
  commandTarget,
  defaultProfileLauncherPath,
  installCommand,
  installProfileLauncher,
  listSavedRuntimeTargets,
  markSavedRuntimeTargetUsed,
  profileLauncherList,
  removeSavedRuntimeTarget,
  resolveSavedRuntimeTarget,
  summarizeSavedRuntimeTarget,
  uninstallCommand,
  uninstallProfileLauncher,
  type ResolvedRuntimeTarget
} from '@quirky/protocol/node'
type Params = Record<string, unknown>
type ExpectedOwnerRuntime = { id: string; endpoint: string; grantId: string }
type RuntimeCallInput = OwnerRuntimeCallParams & { expectedRuntime?: ExpectedOwnerRuntime }

function stringParam(context: PluginContext, params: Params, key: string, optional = false): string | undefined {
  const value = params[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length === 0) throw context.error('invalid-params', `${key} must be a non-empty string`)
  return value
}

function booleanParam(context: PluginContext, params: Params, key: string): boolean {
  const value = params[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw context.error('invalid-params', `${key} must be a boolean`)
  return value
}

function isOwnerHostIdentity(value: unknown): value is OwnerHostIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).length === 2 &&
    Object.hasOwn(candidate, 'hostId') && typeof candidate.hostId === 'string' && candidate.hostId.trim().length > 0 &&
    Object.hasOwn(candidate, 'generation') && typeof candidate.generation === 'string' && candidate.generation.trim().length > 0
}

function expectedHostParam(context: PluginContext, value: unknown): OwnerHostIdentity | undefined {
  if (value === undefined) return undefined
  if (!isOwnerHostIdentity(value)) {
    throw context.error('invalid-params', 'expectedHost must contain exactly non-empty hostId and generation strings')
  }
  return { hostId: value.hostId, generation: value.generation }
}
function isExpectedOwnerRuntime(value: unknown): value is ExpectedOwnerRuntime {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).length === 3 &&
    Object.hasOwn(candidate, 'id') && typeof candidate.id === 'string' && candidate.id.trim().length > 0 &&
    Object.hasOwn(candidate, 'endpoint') && typeof candidate.endpoint === 'string' && candidate.endpoint.trim().length > 0 &&
    Object.hasOwn(candidate, 'grantId') && typeof candidate.grantId === 'string' && candidate.grantId.trim().length > 0
}

function expectedRuntimeParam(context: PluginContext, value: unknown): ExpectedOwnerRuntime | undefined {
  if (value === undefined) return undefined
  if (!isExpectedOwnerRuntime(value)) {
    throw context.error('invalid-params', 'expectedRuntime must contain exactly non-empty id, endpoint, and grantId strings')
  }
  return { id: value.id, endpoint: value.endpoint, grantId: value.grantId }
}


function registerHostIdentity(context: PluginContext): OwnerHostIdentity {
  const store = context.openStore([
    'CREATE TABLE IF NOT EXISTS owner_host_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), host_id TEXT NOT NULL)'
  ])
  store.run('INSERT OR IGNORE INTO owner_host_identity (singleton, host_id) VALUES (1, ?)', randomUUID())
  const row = store.get<{ host_id: unknown }>('SELECT host_id FROM owner_host_identity WHERE singleton = 1')
  if (typeof row?.host_id !== 'string' || row.host_id.trim().length === 0) {
    throw new Error('Stored owner host identity is invalid')
  }
  return { hostId: row.host_id, generation: randomUUID() }
}

function failure(context: PluginContext, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return context.error('not-found', message)
  if (/foreign|ambiguous|permission|unavailable|occupied|could not|failed|host identity|runtime pin/i.test(message)) return context.error('conflict', message)
  return context.error('invalid-params', message)
}

function provide(context: PluginContext, name: string, handler: (params: Params) => unknown): void {
  context.provide(`method:${context.pluginId}/${name}`, (params: Params) => {
    try { return handler(params) } catch (error) { throw failure(context, error) }
  })
}

function provideAsync(context: PluginContext, name: string, handler: (params: Params) => Promise<unknown>): void {
  context.provide(`method:${context.pluginId}/${name}`, async (params: Params) => {
    try { return await handler(params) } catch (error) { throw failure(context, error) }
  })
}

async function callOwnerRuntime(context: PluginContext, params: Params): Promise<OwnerRuntimeCallResult> {
  if (Object.keys(params).some((key) => !['runtime', 'method', 'params', 'expectedHost', 'expectedRuntime'].includes(key))) {
    throw context.error('invalid-params', 'runtimeCall accepts only runtime, method, optional params, expectedHost, and expectedRuntime')
  }
  const expectedHost = expectedHostParam(context, params.expectedHost)
  const expectedRuntime = expectedRuntimeParam(context, params.expectedRuntime)
  const input: RuntimeCallInput = {
    runtime: stringParam(context, params, 'runtime')!,
    method: stringParam(context, params, 'method')!,
    ...(params.params === undefined ? {} : { params: params.params as Record<string, unknown> }),
    ...(expectedHost === undefined ? {} : { expectedHost }),
    ...(expectedRuntime === undefined ? {} : { expectedRuntime })
  }
  if (params.params !== undefined &&
    (params.params === null || typeof params.params !== 'object' || Array.isArray(params.params))) {
    throw context.error('invalid-params', 'params must be an object')
  }
  if (input.method === 'quirky.cli/runtimeCall') {
    throw context.error('invalid-params', 'runtimeCall cannot forward to itself')
  }
  let target: ResolvedRuntimeTarget
  try { target = resolveSavedRuntimeTarget(context.home, input.runtime) } catch {
    throw context.error('not-found', 'Saved owner runtime was not found or is unavailable')
  }
  if (target.scope !== 'owner-cli' || target.grantId === null) {
    throw context.error('invalid-params', 'runtime must select a saved owner-cli target')
  }
  if (input.expectedRuntime !== undefined &&
    (target.id !== input.expectedRuntime.id ||
      target.endpoint !== input.expectedRuntime.endpoint ||
      target.grantId !== input.expectedRuntime.grantId)) {
    throw context.error('conflict', 'Saved owner runtime pin does not match expectedRuntime')
  }
  let offer: OwnerCliPairOffer
  try { offer = parseOwnerCliOffer(target.pairingCode) } catch {
    throw context.error('conflict', 'Saved owner runtime offer is invalid')
  }
  if (offer.endpoint !== target.endpoint || offer.publicKeyB64 !== target.publicKeyB64 ||
    offer.pairedDeviceId !== target.pairedDeviceId || offer.pairedDeviceId !== target.grantId) {
    throw context.error('conflict', 'Saved owner runtime identity does not match its pinned offer')
  }
  let rpc: MobileRpc
  try {
    rpc = await createMobileRpc({ endpoint: target.endpoint, publicKeyB64: target.publicKeyB64, token: offer.deviceToken })
  } catch {
    throw context.error('conflict', 'Owner runtime connection failed')
  }
  try {
    if (input.expectedHost !== undefined) {
      let actualHost: unknown
      try {
        actualHost = await rpc.call('quirky.cli/hostIdentity', {})
      } catch {
        throw context.error('conflict', 'Owner host identity could not be verified')
      }
      if (!isOwnerHostIdentity(actualHost) ||
        actualHost.hostId !== input.expectedHost.hostId ||
        actualHost.generation !== input.expectedHost.generation) {
        throw context.error('conflict', 'Owner host identity does not match expectedHost')
      }
    }
    let result: unknown
    try {
      result = await rpc.call(input.method, input.params ?? {})
    } catch {
      throw context.error('conflict', 'Owner runtime call failed')
    }
    markSavedRuntimeTargetUsed(context.home, target.id)
    return {
      runtime: {
        id: target.id,
        name: target.name,
        endpoint: target.endpoint,
        grantId: target.grantId
      },
      result
    }
  } finally {
    rpc.close()
  }
}

export function activate(context: PluginContext): void {
  const hostIdentity = registerHostIdentity(context)
  provide(context, 'hostIdentity', (params) => {
    if (Object.keys(params).length > 0) throw context.error('invalid-params', 'hostIdentity accepts no parameters')
    return { ...hostIdentity }
  })
  provide(context, 'commandStatus', (params) => {
    const path = stringParam(context, params, 'path', true)
    const profileHome = stringParam(context, params, 'profileHome', true) ?? context.home
    return commandStatus(context.home, { ...(path === undefined ? {} : { path }), profileHome })
  })
  provide(context, 'commandTarget', (params) => {
    const path = stringParam(context, params, 'path', true)
    const target = commandTarget(context.home, path)
    return {
      available: target !== null,
      executablePath: target?.executablePath ?? null,
      entrypointPath: target?.entrypointPath ?? null
    }
  })
  provide(context, 'commandInstall', (params) => {
    const path = stringParam(context, params, 'path', true)
    return installCommand(context.home, {
      ...(path === undefined ? {} : { path }),
      executablePath: stringParam(context, params, 'executablePath')!,
      entrypointPath: stringParam(context, params, 'entrypointPath')!,
      profileHome: stringParam(context, params, 'profileHome', true) ?? context.home,
      replaceForeign: booleanParam(context, params, 'replaceForeign')
    })
  })
  provide(context, 'commandUninstall', (params) => uninstallCommand(
    context.home,
    stringParam(context, params, 'path', true)
  ))
  provideAsync(context, 'commandReveal', async (params) => {
    const path = stringParam(context, params, 'path', true) ?? commandStatus(context.home).path
    const result = await context.call('desktop.item.reveal', { path }) as { requested?: unknown }
    if (result.requested !== true) throw context.error('conflict', 'native shell did not accept the reveal request')
    return { path, requested: true }
  })
  provide(context, 'profileLauncherList', () => ({ launchers: profileLauncherList(context.home) }))
  provide(context, 'profileLauncherInstall', (params) => {
    const name = stringParam(context, params, 'name')!
    const commandPath = commandStatus(context.home).path
    const target = commandTarget(context.home, commandPath)
    const executablePath = stringParam(context, params, 'executablePath', true) ?? target?.executablePath
    const entrypointPath = stringParam(context, params, 'entrypointPath', true) ?? target?.entrypointPath
    if (!executablePath || !entrypointPath) throw context.error('conflict', 'no verified CLI executable and entrypoint are available')
    return installProfileLauncher(context.home, {
      name,
      path: stringParam(context, params, 'path', true) ?? defaultProfileLauncherPath(name, commandPath),
      profileHome: stringParam(context, params, 'profileHome')!,
      executablePath,
      entrypointPath,
      replaceForeign: booleanParam(context, params, 'replaceForeign')
    })
  })
  provide(context, 'profileLauncherRemove', (params) => uninstallProfileLauncher(
    context.home,
    stringParam(context, params, 'path')!
  ))
  provideAsync(context, 'runtimeAdd', async (params) => {
    const pairingCode = stringParam(context, params, 'pairingCode')!
    return addSavedRuntimeTarget(context.home, stringParam(context, params, 'name')!, pairingCode)
  })
  provideAsync(context, 'runtimeCall', (params) => callOwnerRuntime(context, params))
  provide(context, 'runtimeList', () => ({ runtimes: listSavedRuntimeTargets(context.home) }))
  provide(context, 'runtimeShow', (params) => summarizeSavedRuntimeTarget(
    resolveSavedRuntimeTarget(context.home, stringParam(context, params, 'selector')!)
  ))
  provide(context, 'runtimeRemove', (params) => removeSavedRuntimeTarget(
    context.home,
    stringParam(context, params, 'selector')!
  ))
  provide(context, 'runtimeStatus', () => ({ runtimes: listSavedRuntimeTargets(context.home) }))
}
