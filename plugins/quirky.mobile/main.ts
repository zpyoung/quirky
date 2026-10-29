import type { ApiDescription, PluginActivationDisposer, PluginContext } from '@quirky/protocol'
import { MobileService, registerMobileMethods } from './src/daemon/service'
import { registerMobileNotifications } from './src/daemon/notifications'
import { registerMobileAgentCatalog } from './src/daemon/agent-catalog'
import { describePairedApi } from './src/daemon/authorization'
import { registerMobileSessionTabs } from './src/daemon/session-tabs'

export async function activate(context: PluginContext): Promise<PluginActivationDisposer> {
  const active = new MobileService(context, {
    ...(process.env.QUIRKY_MOBILE_PORT === undefined ? {} : { portValue: process.env.QUIRKY_MOBILE_PORT }),
    ...(process.env.QUIRKY_MOBILE_HOST === undefined ? {} : { hostValue: process.env.QUIRKY_MOBILE_HOST })
  })
  registerMobileMethods(context, active)
  registerMobileAgentCatalog(context)
  context.provide('method:quirky.mobile/api', async () => describePairedApi(await context.call('api.describe', {}) as ApiDescription))
  const stopTabs = await registerMobileSessionTabs(context)
  const stopNotifications = registerMobileNotifications(context)
  const dispose: PluginActivationDisposer = async () => {
    stopNotifications()
    try {
      await stopTabs()
    } finally {
      await active.stop()
    }
  }
  try {
    await active.start()
  } catch (error) {
    await dispose()
    throw error
  }
  return dispose
}
