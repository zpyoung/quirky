import type { PluginContext } from '@quirky/protocol'
import {
  addSavedRuntimeTarget,
  commandStatus,
  commandTarget,
  defaultProfileLauncherPath,
  installCommand,
  installProfileLauncher,
  listSavedRuntimeTargets,
  profileLauncherList,
  removeSavedRuntimeTarget,
  resolveSavedRuntimeTarget,
  summarizeSavedRuntimeTarget,
  uninstallCommand,
  uninstallProfileLauncher
} from '@quirky/protocol/node'

type Params = Record<string, unknown>

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

function failure(context: PluginContext, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return context.error('not-found', message)
  if (/foreign|ambiguous|permission|unavailable|occupied|could not|failed/i.test(message)) return context.error('conflict', message)
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

export function activate(context: PluginContext): void {
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
    // Defer E2EE until an offer is added; launcher-only API calls do not need the transport graph.
    const offer = await import('@quirky/protocol/paired-client').then(({ parseMobileOffer }) => parseMobileOffer(pairingCode))
    return addSavedRuntimeTarget(context.home, stringParam(context, params, 'name')!, pairingCode, {
      endpoint: offer.endpoint,
      pairedDeviceId: offer.pairedDeviceId
    })
  })
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
