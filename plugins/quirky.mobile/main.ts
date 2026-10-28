import type { PluginContext } from '@quirky/protocol'
import { MobileService, registerMobileMethods } from './src/daemon/service'
import { registerMobileAgentCatalog } from './src/daemon/agent-catalog'
import { registerMobileSessionTabs } from './src/daemon/session-tabs'

let service: MobileService | undefined
let stopTabs: (() => Promise<void>) | undefined

export async function activate(context: PluginContext): Promise<void> {
  const active = new MobileService(context, {
    ...(process.env.QUIRKY_MOBILE_PORT === undefined ? {} : { portValue: process.env.QUIRKY_MOBILE_PORT }),
    ...(process.env.QUIRKY_MOBILE_HOST === undefined ? {} : { hostValue: process.env.QUIRKY_MOBILE_HOST })
  })
  service = active
  registerMobileMethods(context, active)
  registerMobileAgentCatalog(context)
  stopTabs = await registerMobileSessionTabs(context)
  await active.start()
}

export async function deactivate(): Promise<void> {
  const active = service
  const releaseTabs = stopTabs
  service = undefined
  stopTabs = undefined
  try {
    await releaseTabs?.()
  } finally {
    await active?.stop()
  }
}
